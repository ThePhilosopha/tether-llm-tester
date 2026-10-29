import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createComparisonStore } from '../lib/comparison/store.mjs';

const caseRecord = (overrides = {}) => ({
  id: 'case/../safe', version: 1, category: 'copy', title: 'Case',
  system: '', prompt: 'Write copy.', assertions: [], rubric: {}, holdout: false,
  ...overrides
});

const runRecord = (overrides = {}) => ({
  schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(),
  input: {}, status: 'running', attempts: [], blindAssignments: {}, verdict: null,
  ...overrides
});

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'llm-comparison-'));
  const store = await createComparisonStore(root, options);
  return { root, store };
}

test('persists versioned cases and run records across a store restart', async () => {
  const { root, store } = await fixture();
  await store.saveCase(caseRecord());
  const run = runRecord({ status: 'complete' });
  await store.saveRun(run);
  const reopened = await createComparisonStore(root);
  assert.equal((await reopened.listCases())[0].id, 'case/../safe');
  assert.deepEqual(await reopened.getRun(run.id), run);
});

test('keeps data private and does not derive paths from user case IDs', async () => {
  const { root, store } = await fixture();
  await store.saveCase(caseRecord());
  const files = await readdir(join(root, 'cases'));
  assert.equal(files.length, 1);
  assert.doesNotMatch(files[0], /\.\./);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, 'cases', files[0]))).mode & 0o777, 0o600);
});

test('requires immutable case versions to increase one step at a time', async () => {
  const { store } = await fixture();
  await store.saveCase(caseRecord());
  await assert.rejects(store.saveCase(caseRecord({ title: 'Changed same version' })), /immutable/);
  await assert.rejects(store.saveCase(caseRecord({ version: 3 })), /next version/);
  assert.equal((await store.saveCase(caseRecord({ version: 2, title: 'Revised' }))).version, 2);
  assert.equal((await store.listCases())[0].title, 'Revised');
});

test('preserves corrupt records and reports a readable error', async () => {
  const { root, store } = await fixture();
  const file = join(root, 'runs', `${randomUUID()}.json`);
  await store.ready;
  await writeFile(file, '{broken', { mode: 0o600 });
  await assert.rejects(store.listRuns(), /Could not read comparison record/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('marks unfinished work interrupted without replaying it', async () => {
  const { root, store } = await fixture();
  const run = runRecord({ attempts: [
    { id: 'a', status: 'running' }, { id: 'b', status: 'queued' },
    { id: 'c', status: 'complete' }
  ] });
  await store.saveRun(run);
  const reopened = await createComparisonStore(root);
  const changed = await reopened.recoverInterrupted();
  assert.equal(changed, 1);
  assert.deepEqual((await reopened.getRun(run.id)).attempts.map(item => item.status), [
    'interrupted', 'interrupted', 'complete'
  ]);
});

test('caps raw evidence and rejects new records at storage limits', async () => {
  const { store } = await fixture({ maxRawBytes: 8, maxRuns: 1, maxBytes: 4096 });
  const run = runRecord({ status: 'complete', attempts: [{ id: 'a', status: 'complete', raw: 'a much longer raw response' }] });
  await store.saveRun(run);
  const saved = await store.getRun(run.id);
  assert.ok(Buffer.byteLength(saved.attempts[0].raw) <= 8);
  assert.equal(saved.attempts[0].rawTruncated, true);
  await assert.rejects(store.saveRun(runRecord()), /run limit/);
});

test('truncates raw evidence on a UTF-8 boundary without changing saved text', async () => {
  const { store } = await fixture({ maxRawBytes: 2 });
  const run = runRecord({ attempts: [{ id: 'a', status: 'complete', raw: 'aéz' }] });
  await store.saveRun(run);
  const saved = await store.getRun(run.id);
  assert.equal(saved.attempts[0].raw, 'a');
  assert.equal(Buffer.byteLength(saved.attempts[0].raw), 1);
  assert.equal(saved.attempts[0].rawTruncated, true);
});

test('serialises concurrent updates to the same run ID', async () => {
  const { store } = await fixture();
  const run = runRecord();
  await Promise.all([
    store.saveRun({ ...run, status: 'running' }),
    store.saveRun({ ...run, status: 'complete' })
  ]);
  assert.equal((await store.getRun(run.id)).status, 'complete');
});


test('rejects conflicting concurrent saves of the same case version', async () => {
  const { root, store } = await fixture();
  await store.saveCase(caseRecord());
  const edits = [
    caseRecord({ version: 2, prompt: 'First edit.' }),
    caseRecord({ version: 2, prompt: 'Conflicting edit.' })
  ];
  const outcomes = await Promise.allSettled(edits.map(item => store.saveCase(item)));
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.match(outcomes[1].reason.message, /immutable/);
  const reopened = await createComparisonStore(root);
  assert.deepEqual((await reopened.listCases())[0], edits[0]);
  assert.deepEqual(await store.saveCase(edits[0]), edits[0]);
  assert.equal((await store.saveCase(caseRecord({ version: 3 }))).version, 3);
});

test('recovers unfinished batch status when every attempt is terminal', async () => {
  const { root, store } = await fixture();
  for (const status of ['queued', 'running']) {
    const run = runRecord({ status, attempts: [
      { id: 'a', status: 'complete', output: 'Preserved answer.' },
      { id: 'b', status: 'error', error: 'Preserved failure.' }
    ] });
    await store.saveRun(run);
    const reopened = await createComparisonStore(root);
    assert.equal(await reopened.recoverInterrupted(), 1);
    const saved = await reopened.getRun(run.id);
    assert.equal(saved.status, 'interrupted');
    assert.deepEqual(saved.attempts, run.attempts);
    assert.equal(await reopened.recoverInterrupted(), 0);
  }
});
