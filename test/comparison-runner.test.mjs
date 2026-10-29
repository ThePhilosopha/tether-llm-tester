import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createComparisonStore } from '../lib/comparison/store.mjs';
import { createComparisonRunner } from '../lib/comparison/runner.mjs';

const settings = { temperature: 0.7, topP: 1, maxOutputTokens: 64, stream: true, timeoutMs: 1000 };
const model = id => ({ providerId: 'fake', modelId: id, protocol: 'chat-completions', endpoint: 'https://fake.invalid/v1/chat/completions', capabilities: { parameters: { temperature: 'supported', topP: 'supported', maxOutputTokens: 'supported' } } });
const caseVersion = (id = 'case-1') => ({ id, version: 1, category: 'copy', title: id, system: '', prompt: 'Say hi', assertions: [], rubric: {}, holdout: false });
const input = (cases = [caseVersion()], repetitions = 1) => ({ caseVersions: cases, left: model('a'), right: model('b'), baselineSide: null, settings, repetitions, exploratoryConfirmed: false });
const pause = () => new Promise(resolve => setImmediate(resolve));
async function waitUntil(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition did not become true');
}
async function waitFor(store, id) {
  for (let i = 0; i < 200; i++) {
    const run = await store.getRun(id);
    if (!['queued', 'running'].includes(run?.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('comparison did not finish');
}

async function fixture(executeModel, { timeoutMs } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'llm-comparison-run-'));
  const store = await createComparisonStore(root);
  const runner = createComparisonRunner({
    store,
    resolveProvider: async id => ({ id, baseUrl: 'https://fake.invalid/v1', auth: 'none', headers: {} }),
    executeModel,
    timeoutMs
  });
    return { store, runner };
}

test('dispatches both sides before either response completes', async () => {
  const started = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { runner, store } = await fixture(async ({ model }) => {
    started.push(model.modelId);
    await gate;
    return { text: model.modelId, raw: '', rawTruncated: false, usage: null };
  });
  const { id } = await runner.start(input(), 'submission-1');
  await waitUntil(() => started.length >= 2);
  assert.deepEqual(new Set(started), new Set(['a', 'b']));
  release();
  await waitFor(store, id);
});

test('keeps a failed side from erasing the successful result', async () => {
  const { runner, store } = await fixture(async ({ model }) => {
    if (model.modelId === 'a') throw new Error('provider unavailable');
    return { text: 'usable answer', raw: 'frame', rawTruncated: false, usage: null };
  });
  const { id } = await runner.start(input(), 'failure-1');
  await waitFor(store, id);
  const run = await store.getRun(id);
  assert.equal(run.attempts.find(item => item.side === 'left').status, 'error');
  assert.equal(run.attempts.find(item => item.side === 'right').output, 'usable answer');
});

test('deduplicates submissions and rejects a reused key for different inputs', async () => {
  let calls = 0;
  const { runner, store } = await fixture(async () => {
    calls++;
    return { text: 'done', raw: '', rawTruncated: false, usage: null };
  });
  const first = await runner.start(input(), 'same-key');
  const duplicate = await runner.start(input(), 'same-key');
  assert.equal(duplicate.id, first.id);
  await assert.rejects(runner.start(input([caseVersion('other')]), 'same-key'), /different input/);
  await waitFor(store, first.id);
  assert.equal(calls, 2);
});

test('keeps repetitions sequential while dispatching each pair concurrently', async () => {
  const active = new Set(), maxActive = { value: 0 }, calls = [];
  const { runner, store } = await fixture(async ({ model }) => {
    const key = `${model.modelId}`;
    active.add(key); maxActive.value = Math.max(maxActive.value, active.size); calls.push(key);
    await pause(); active.delete(key);
    return { text: key, raw: '', rawTruncated: false, usage: null };
  });
  const { id } = await runner.start(input([caseVersion()], 3), 'repeat-1');
  await waitFor(store, id);
  assert.equal(calls.length, 6);
  assert.equal(maxActive.value, 2);
});

test('persists partial output when a side is cancelled', async () => {
  const started = new Map();
  const { runner, store } = await fixture(({ model, signal, emit }) => new Promise(resolve => {
    started.set(model.modelId, resolve);
    if (model.modelId === 'a') emit({ type: 'delta', text: 'partial-a' });
    signal.addEventListener('abort', () => resolve({
      text: `partial-${model.modelId}`, raw: '', rawTruncated: false, usage: null
    }), { once: true });
  }));
  const { id } = await runner.start(input(), 'cancel-1');
  await waitUntil(() => started.size >= 2);
  await runner.cancel(id, 'left');
  started.get('b')({ text: 'right answer', raw: '', rawTruncated: false, usage: null });
  await waitFor(store, id);
  const run = await store.getRun(id);
  assert.equal(run.attempts.find(item => item.side === 'left').status, 'cancelled');
  assert.equal(run.attempts.find(item => item.side === 'left').output, 'partial-a');
  assert.equal(run.attempts.find(item => item.side === 'right').output, 'right answer');
});

test('freezes prompts and shared settings before dispatch', async () => {
  const observed = [];
  const { runner, store } = await fixture(async ({ settings, testCase }) => {
    observed.push({ temperature: settings.temperature, prompt: testCase.prompt });
    return { text: 'done', raw: '', rawTruncated: false, usage: null };
  });
  const source = input();
  const { id } = await runner.start(source, 'frozen-1');
  source.settings.temperature = 1.9;
  source.caseVersions[0].prompt = 'changed after submission';
  await waitFor(store, id);
  assert.deepEqual(observed, [
    { temperature: 0.7, prompt: 'Say hi' },
    { temperature: 0.7, prompt: 'Say hi' }
  ]);
});

test('stopping both sides cancels active and queued pairs', async () => {
  const started = [];
  const { runner, store } = await fixture(({ model, signal }) => new Promise(resolve => {
    started.push(model.modelId);
    signal.addEventListener('abort', () => resolve({ text: '', raw: '', rawTruncated: false }), { once: true });
  }));
  const { id } = await runner.start(input([caseVersion('first'), caseVersion('second')]), 'cancel-both-1');
  await waitUntil(() => started.length === 2);
  await runner.cancel(id, 'both');
  const run = await waitFor(store, id);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.attempts.filter(attempt => attempt.status === 'cancelled').length, 4);
});

test('times out a stalled side without blocking its pair', async () => {
  const { runner, store } = await fixture(async ({ model, signal }) => {
    if (model.modelId === 'a') return new Promise(resolve => signal.addEventListener('abort', () => resolve({ text: '', raw: '', rawTruncated: false }), { once: true }));
    return { text: 'fast', raw: '', rawTruncated: false, usage: null };
  }, { timeoutMs: 20 });
  const { id } = await runner.start(input(), 'timeout-1');
  await waitFor(store, id);
  const run = await store.getRun(id);
  assert.equal(run.attempts.find(item => item.side === 'left').status, 'timeout');
  assert.equal(run.attempts.find(item => item.side === 'right').output, 'fast');
});

test('serialises simultaneous duplicate and distinct starts before dispatch', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { runner, store } = await fixture(async () => {
    calls++;
    await gate;
    return { text: 'done' };
  });
  try {
    const results = await Promise.allSettled([
      runner.start(input(), 'concurrent-key'),
      runner.start(input(), 'concurrent-key'),
      runner.start(input(), 'different-key')
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'fulfilled');
    assert.equal(results[0].value.id, results[1].value.id);
    assert.equal(results[2].status, 'rejected');
    assert.match(results[2].reason.message, /already running/);
    await waitUntil(() => calls >= 2);
    assert.equal(calls, 2);
    assert.equal((await store.listRuns()).length, 1);
  } finally { release(); await runner.close(); }
});

test('publishes side completion only after its terminal evidence is durable', async () => {
  const { runner, store } = await fixture(async () => ({ text: 'durable answer' }));
  const persisted = new Map();
  const save = store.saveRun;
  store.saveRun = async record => {
    await new Promise(resolve => setTimeout(resolve, 5));
    const saved = await save(record);
    persisted.set(record.id, saved);
    return saved;
  };
  const { id } = await runner.start(input(), 'durable-terminal');
  const observed = [];
  runner.subscribe(id, event => {
    if (event.type === 'terminal' && event.attemptId) {
      observed.push(persisted.get(id)?.attempts.find(item => item.id === event.attemptId)?.status);
    }
  });
  await waitUntil(() => observed.length === 2);
  await runner.close();
  assert.equal(observed.length, 2);
  assert.ok(observed.every(status => ['complete', 'cancelled'].includes(status)));
});

test('surfaces persistence failures without an unhandled batch rejection', async () => {
  const { runner, store } = await fixture(async () => ({ text: 'answer' }));
  const save = store.saveRun;
  let writes = 0;
  store.saveRun = async value => {
    if (++writes > 1) throw new Error('disk full');
    return save(value);
  };
  const { id } = await runner.start(input(), 'disk-failure');
  await runner.close();
  const record = await runner.get(id);
  assert.equal(record.status, 'error');
  assert.match(record.error, /persist.*disk full/i);
});

test('reconciles streamed partial text with the final provider output before assessment', async () => {
  const { runner, store } = await fixture(async ({ emit }) => {
    emit({ type: 'delta', text: 'partial' });
    return { text: 'complete authoritative answer' };
  });
  const { id } = await runner.start(input(), 'final-output');
  const record = await waitFor(store, id);
  assert.ok(record.attempts.every(attempt => attempt.output === 'complete authoritative answer'));
});
