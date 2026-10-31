import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { startMockProvider } from './helpers/comparison-provider.mjs';
import { RUBRICS } from '../lib/comparison/evaluate.mjs';

let app, mock, base, providerId;
const directory = await mkdtemp(join(tmpdir(), 'llm-comparison-api-'));

before(async () => {
  mock = await startMockProvider();
  app = createApp({
    statePath: join(directory, 'state.json'),
    comparisonDir: join(directory, 'comparisons'),
    fetchImpl: globalThis.fetch
  });
  const address = await app.start(0);
  base = `http://127.0.0.1:${address.port}`;
  const provider = await sameOrigin('/api/providers', {
    method: 'POST',
    body: JSON.stringify({ presetId: 'openrouter', name: 'Mock', baseUrl: mock.url, auth: 'bearer', apiKey: 'test-comparison-secret', headers: {} })
  }).then(response => response.json());
  providerId = provider.id;
});

after(async () => {
  await app?.close();
  await mock?.close();
});

function sameOrigin(path, options = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: {
      origin: base,
      'x-session-token': app.token,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
}

function caseVersion(id = 'copy-case', version = 1) {
  return {
    id, version, category: 'copy', title: 'Three short variations', system: '',
    prompt: 'Write three short variations.',
    assertions: [{ type: 'array-length', path: ['variations'], value: 3, severity: 'major' }],
    rubric: {}, holdout: false
  };
}

async function prepareInput() {
  const discovered = await fetch(`${base}/api/comparison/models?providerId=${encodeURIComponent(providerId)}`).then(response => response.json());
  assert.equal(discovered.models.length, 3);
  const model = id => discovered.models.find(item => item.modelId === id);
  const input = {
    caseVersions: [caseVersion()],
    left: model('side-a'), right: model('side-b'), baselineSide: null,
    settings: { temperature: 0.7, topP: 1, maxOutputTokens: 64, stream: true, timeoutMs: 2000 },
    repetitions: 1, exploratoryConfirmed: false
  };
  return sameOrigin('/api/comparisons/preflight', {
    method: 'POST', body: JSON.stringify({ input })
  }).then(async response => {
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  });
}

async function waitForRun(id, terminal = true) {
  for (let i = 0; i < 200; i++) {
    const response = await fetch(`${base}/api/comparisons/${id}`);
    if (response.ok) {
      const run = await response.json();
      if (!terminal || !['queued', 'running'].includes(run.status)) return run;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('comparison did not reach a terminal status');
}

async function waitForRequests(count) {
  for (let i = 0; i < 200 && mock.requests.length < count; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(mock.requests.length >= count, `expected ${count} upstream requests`);
}

test('comparison API enforces the existing local mutation token', async () => {
  const response = await fetch(`${base}/api/comparisons/preflight`, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(response.status, 403);
});

test('serves the React client shell with the session token and a self-only CSP', async () => {
  const page = await fetch(base);
  const html = await page.text();
  assert.match(html, /<div id="root">/);
  assert.match(html, /<meta name="session-token" content="[\w-]+">/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /font-src 'self'/);
  const script = html.match(/src="(\/assets\/index[-\w]*\.js)"/);
  assert.ok(script, 'the built client script is referenced');
  const module = await fetch(`${base}${script[1]}`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /javascript/);
  const stylesheet = html.match(/href="(\/assets\/index[-\w]*\.css)"/);
  assert.ok(stylesheet, 'the built client stylesheet is referenced');
  const css = await fetch(`${base}${stylesheet[1]}`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('saves an explicit protocol mapping for a Go model without inferring from its name', async () => {
  const provider = await sameOrigin('/api/providers', {
    method: 'POST',
    body: JSON.stringify({ presetId: 'opencode-go', name: 'Go mock', baseUrl: mock.url, auth: 'none', headers: {} })
  }).then(response => response.json());
  const before = await fetch(`${base}/api/comparison/models?providerId=${encodeURIComponent(provider.id)}`).then(response => response.json());
  const candidate = before.models.find(model => model.modelId === 'side-a');
  assert.equal(candidate.protocol, null);
  assert.equal(candidate.mappingRequired, true);
  const saved = await sameOrigin('/api/comparison/model-mapping', {
    method: 'POST', body: JSON.stringify({ providerId: provider.id, modelId: 'side-a', protocol: 'chat-completions' })
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const after = await fetch(`${base}/api/comparison/models?providerId=${encodeURIComponent(provider.id)}`).then(response => response.json());
  const mapped = after.models.find(model => model.modelId === 'side-a');
  assert.equal(mapped.protocol, 'chat-completions');
  assert.equal(mapped.available, true);
});

test('saves cases, preflights, runs, reconnects, assesses and reports a comparison', async () => {
  const saved = await sameOrigin('/api/comparison/cases', {
    method: 'POST', body: JSON.stringify(caseVersion())
  });
  assert.equal(saved.status, 201, await saved.clone().text());
  assert.equal((await fetch(`${base}/api/comparison/cases`).then(response => response.json())).cases.length, 1);

  const preflight = await prepareInput();
  assert.equal(preflight.requestCount, 2);
  assert.equal(preflight.pairs, 1);
  const body = JSON.stringify({ input: preflight.input, submissionId: 'api-run-1' });
  const created = await sameOrigin('/api/comparisons', { method: 'POST', body }).then(response => response.json());
  const duplicate = await sameOrigin('/api/comparisons', { method: 'POST', body }).then(response => response.json());
  assert.equal(duplicate.id, created.id);
  await waitForRequests(2);
  assert.deepEqual(mock.requests.slice(0, 2).map(item => item.body.model).sort(), ['side-a', 'side-b']);
  assert.ok(mock.requests.slice(0, 2).every(item => item.body.temperature === 0.7 && item.body.top_p === 1));
  mock.release();

  const run = await waitForRun(created.id);
  assert.equal(run.status, 'complete');
  assert.deepEqual(run.attempts.map(attempt => attempt.output).sort(), ['reply:side-a', 'reply:side-b']);
  assert.ok(run.attempts.every(attempt => !JSON.stringify(attempt).includes('Bearer secret')));
  const persistedBlindLabels = structuredClone(run.blindAssignments);
  assert.deepEqual(Object.values(persistedBlindLabels)[0] && Object.keys(Object.values(persistedBlindLabels)[0]).sort(), ['A', 'B']);
  const reopened = createApp({
    statePath: join(directory, 'state.json'),
    comparisonDir: join(directory, 'comparisons'),
    fetchImpl: globalThis.fetch
  });
  const reopenedAddress = await reopened.start(0);
  const reopenedRun = await fetch(`http://127.0.0.1:${reopenedAddress.port}/api/comparisons/${created.id}`).then(response => response.json());
  assert.deepEqual(reopenedRun.blindAssignments, persistedBlindLabels);
  await reopened.close();

  const events = await fetch(`${base}/api/comparisons/${created.id}/events`).then(response => response.text());
  const snapshot = events.trim().split('\n').map(JSON.parse)[0];
  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.data.id, created.id);

  for (const attempt of run.attempts) {
    const assessed = await sameOrigin(`/api/comparisons/${created.id}/assessment`, {
      method: 'POST', body: JSON.stringify({
        attemptId: attempt.id,
        assessment: {
          reviewed: true, accepted: true, criticalFailure: false,
          scores: { clarity: 4, audienceVoice: 4, specificity: 4, persuasion: 4, distinctiveness: 4 },
          reason: 'Ready.'
        }
      })
    });
    assert.equal(assessed.status, 200, await assessed.clone().text());
  }
  const verdict = await sameOrigin(`/api/comparisons/${created.id}/verdict`, {
    method: 'POST', body: JSON.stringify({ verdict: 'useful-with-review', rationale: 'Small reviewed sample.', evidenceCount: 2 })
  });
  assert.equal(verdict.status, 200, await verdict.clone().text());
  const report = await fetch(`${base}/api/comparisons/${created.id}/report`).then(response => response.json());
  assert.equal(report.runId, created.id);
  assert.equal(report.verdict.value, 'useful-with-review');
  assert.ok(!JSON.stringify(report).includes('test-comparison-secret'));

  const pairId = run.attempts[0].pairId;
  const pairAssessment = await sameOrigin(`/api/comparisons/${created.id}/pair-assessment`, {
    method: 'POST', body: JSON.stringify({ pairId, choice: 'A', reason: 'More specific and usable.' })
  });
  assert.equal(pairAssessment.status, 200, await pairAssessment.clone().text());
  const judgedReport = await fetch(`${base}/api/comparisons/${created.id}/report`).then(response => response.json());
  assert.equal(judgedReport.pairAssessments[pairId].choice, 'A');
  assert.equal(judgedReport.categories.copy.paired.humanPreference.A, 1);

  const edited = await sameOrigin('/api/comparison/cases', {
    method: 'POST', body: JSON.stringify(caseVersion('copy-case', 2))
  });
  assert.equal(edited.status, 201, await edited.clone().text());
  assert.equal((await fetch(`${base}/api/comparisons/${created.id}`).then(response => response.json())).input.caseVersions[0].version, 1);

  const requestCount = mock.requests.length;
  const rerunBody = JSON.stringify({ input: run.input, submissionId: 'api-run-2', rerunOf: created.id });
  const rerun = await sameOrigin('/api/comparisons', { method: 'POST', body: rerunBody }).then(response => response.json());
  assert.notEqual(rerun.id, created.id);
  assert.equal((await sameOrigin('/api/comparisons', { method: 'POST', body: rerunBody }).then(response => response.json())).id, rerun.id);
  await waitForRequests(requestCount + 2);
  const rerunRecord = await waitForRun(rerun.id);
  assert.equal(rerunRecord.rerunOf, created.id);
});

test('cancellation preserves completed request count and does not replay after refresh', async () => {
  mock.hold();
  const requestCount = mock.requests.length;
  const preflight = await prepareInput();
  const created = await sameOrigin('/api/comparisons', {
    method: 'POST', body: JSON.stringify({ input: preflight.input, submissionId: 'api-cancel-1' })
  }).then(response => response.json());
  await waitForRequests(requestCount + 2);
  const cancel = await sameOrigin(`/api/comparisons/${created.id}/cancel`, {
    method: 'POST', body: JSON.stringify({ side: 'both' })
  });
  assert.equal(cancel.status, 200);
  const run = await waitForRun(created.id);
  assert.equal(run.status, 'cancelled');
  const again = await sameOrigin('/api/comparisons', {
    method: 'POST', body: JSON.stringify({ input: preflight.input, submissionId: 'api-cancel-1' })
  }).then(response => response.json());
  assert.equal(again.id, created.id);
  assert.equal(mock.requests.length, requestCount + 2);
  mock.release();
});

test('live events retain both responses and only close at the batch terminal', async () => {
  mock.hold();
  const requestCount = mock.requests.length;
  const preflight = await prepareInput();
  const created = await sameOrigin('/api/comparisons', {
    method: 'POST', body: JSON.stringify({ input: preflight.input, submissionId: 'live-events' })
  }).then(response => response.json());
  await waitForRequests(requestCount + 2);
  const response = await fetch(`${base}/api/comparisons/${created.id}/events`);
  const lines = response.text();
  mock.release();
  const events = (await lines).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event => event.type === 'terminal' && event.attemptId).length, 2);
  assert.ok(events.at(-1).type === 'terminal' && !events.at(-1).attemptId);
});

test('rejects reviews during an active batch instead of losing them to progress writes', async () => {
  mock.hold();
  const count = mock.requests.length;
  const preflight = await prepareInput();
  const { id } = await sameOrigin('/api/comparisons', {
    method: 'POST', body: JSON.stringify({ input: preflight.input, submissionId: 'active-review' })
  }).then(response => response.json());
  await waitForRequests(count + 2);
  try {
    const run = await waitForRun(id, false);
    const assessment = await sameOrigin(`/api/comparisons/${id}/assessment`, {
      method: 'POST', body: JSON.stringify({ attemptId: run.attempts[0].id, assessment: {
        reviewed: true, accepted: true, criticalFailure: false, reason: 'Premature',
        scores: { clarity: 4, audienceVoice: 4, specificity: 4, persuasion: 4, distinctiveness: 4 }
      } })
    });
    assert.equal(assessment.status, 409);
    const verdict = await sameOrigin(`/api/comparisons/${id}/verdict`, {
      method: 'POST', body: JSON.stringify({ verdict: 'useful-with-review', rationale: 'Premature' })
    });
    assert.equal(verdict.status, 409);
  } finally { mock.release(); await waitForRun(id); }
});

test('all-category repeated workflow retains reviews, blind assignment and reports after restart', async () => {
  const cases = [];
  for (const category of ['copy', 'layout', 'code']) {
    const value = {
      ...caseVersion(`workflow-${category}`), category, title: `${category} workflow`,
      assertions: [{ type: 'includes', value: 'reply:', severity: 'major' }]
    };
    const saved = await sameOrigin('/api/comparison/cases', {
      method: 'POST', body: JSON.stringify(value)
    });
    assert.equal(saved.status, 201);
    cases.push((await saved.json()).caseVersion);
  }
  const template = (await prepareInput()).input;
  const preflight = await sameOrigin('/api/comparisons/preflight', {
    method: 'POST', body: JSON.stringify({ input: { ...template, caseVersions: cases, repetitions: 2 } })
  }).then(response => response.json());
  assert.equal(preflight.requestCount, 12);
  const { id } = await sameOrigin('/api/comparisons', {
    method: 'POST', body: JSON.stringify({ input: preflight.input, submissionId: 'all-category-workflow' })
  }).then(response => response.json());
  const record = await waitForRun(id);
  assert.equal(record.attempts.length, 12);
  assert.equal(record.status, 'complete');
  await Promise.all(record.attempts.map(async attempt => {
    const category = cases.find(item => item.id === attempt.caseId).category;
    const response = await sameOrigin(`/api/comparisons/${id}/assessment`, {
      method: 'POST', body: JSON.stringify({ attemptId: attempt.id, assessment: {
        reviewed: true, accepted: true, criticalFailure: false,
        reason: 'Fixture meets its required constraint.',
        scores: Object.fromEntries(Object.keys(RUBRICS[category]).map(key => [key, 4])),
        execution: category === 'code' ? {
          status: 'pass', evidence: { source: 'User test harness', date: '2026-10-21', notes: '<img src=x onerror=alert(1)> remains inert evidence text.' }
        } : { status: 'unverified', evidence: null }
      } })
    });
    assert.equal(response.status, 200, await response.clone().text());
  }));
  const before = await fetch(`${base}/api/comparisons/${id}/report`).then(response => response.json());
  assert.equal(before.groups.length, 3);
  assert.ok(before.groups.every(group => group.sides.left.acceptableCount === 2 && group.sides.right.acceptableCount === 2));
  const requestCount = mock.requests.length;
  await app.close();
  app = createApp({ statePath: join(directory, 'state.json'), comparisonDir: join(directory, 'comparisons') });
  const address = await app.start(0);
  base = `http://127.0.0.1:${address.port}`;
  const after = await fetch(`${base}/api/comparisons/${id}/report`).then(response => response.json());
  assert.deepEqual(after.groups, before.groups);
  assert.deepEqual(after.attempts, before.attempts);
  const restored = await fetch(`${base}/api/comparisons/${id}`).then(response => response.json());
  assert.deepEqual(restored.blindAssignments, record.blindAssignments);
  assert.equal(mock.requests.length, requestCount);
  assert.doesNotMatch(JSON.stringify(after), /test-comparison-secret/);
});

test('saves an explicit OpenRouter route without discarding existing model metadata', async () => {
  const provider = await sameOrigin('/api/providers', {
    method: 'POST', body: JSON.stringify({ presetId: 'openrouter', name: 'Route fixture', baseUrl: mock.url, auth: 'none', headers: {},
      comparisonModels: { 'side-a': { protocol: 'chat-completions', capabilitySource: 'fixture' } } })
  }).then(response => response.json());
  const saved = await sameOrigin('/api/comparison/model-mapping', {
    method: 'POST', body: JSON.stringify({ providerId: provider.id, modelId: 'side-a', protocol: 'chat-completions', route: 'provider-one' })
  });
  assert.equal(saved.status, 200);
  const discovered = await fetch(`${base}/api/comparison/models?providerId=${provider.id}`).then(response => response.json());
  assert.equal(discovered.models.find(item => item.modelId === 'side-a').route, 'provider-one');
  const state = await fetch(`${base}/api/state`).then(response => response.json());
  assert.equal(state.providers.find(item => item.id === provider.id).comparisonModels['side-a'].capabilitySource, 'fixture');
});
