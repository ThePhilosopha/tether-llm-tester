import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReport, evaluateAssertions, scoreRubric } from '../lib/comparison/evaluate.mjs';

test('checks JSON array length through literal object keys', () => {
  const rule = [{ type: 'array-length', path: ['variations'], value: 3, severity: 'critical' }];
  assert.equal(evaluateAssertions('{"variations":["a","b","c"]}', rule)[0].passed, true);
  assert.equal(evaluateAssertions('{"variations":["a","b"]}', rule)[0].passed, false);
});

test('counts trimmed whitespace-separated words at inclusive bounds', () => {
  const rule = [{ type: 'word-count', min: 60, max: 80, severity: 'major' }];
  for (const n of [60, 80]) assert.equal(evaluateAssertions(Array(n).fill('word').join(' '), rule)[0].passed, true);
  for (const n of [59, 81]) assert.equal(evaluateAssertions(Array(n).fill('word').join(' '), rule)[0].passed, false);
});

test('fails JSON assertions for invalid JSON and never evaluates user paths', () => {
  assert.equal(evaluateAssertions('{bad}', [{ type: 'json-valid', severity: 'critical' }])[0].passed, false);
  assert.throws(() => evaluateAssertions('{}', [{ type: 'array-length', path: 'globalThis.process.exit()', value: 0 }]), /literal object keys/);
});

function run({ caseVersion = 1, settings = {}, route = 'route-a', attempts = [] } = {}) {
  return {
    id: `run-${caseVersion}-${route}-${attempts.length}`,
    createdAt: '2026-10-20T00:00:00.000Z',
    input: {
      caseVersions: [{ id: 'case', version: caseVersion, category: 'copy', title: 'Copy' }],
      left: { providerId: 'p', modelId: 'left', protocol: 'chat-completions', route },
      right: { providerId: 'p', modelId: 'right', protocol: 'chat-completions', route: 'route-b' },
      settings: { temperature: 0.7, topP: 1, maxOutputTokens: 100, stream: true, timeoutMs: 120000, ...settings },
      repetitions: 1, pricing: null
    },
    status: 'complete', attempts: attempts.map(item => ({ ...item, caseVersion })), verdict: null
  };
}

function attempt(id, { accepted, reviewed = accepted !== undefined, criticalFailure = false, output = 'usable', quality = 3 } = {}) {
  return {
    id, side: id.startsWith('l') ? 'left' : 'right', pairId: 'pair', caseId: 'case', caseVersion: 1,
    status: 'complete', output, outputTruncated: false,
    assertions: [{ type: 'json-valid', passed: true, severity: 'critical' }],
    assessment: reviewed ? { reviewed: true, accepted, criticalFailure, scores: { clarity: quality }, reason: '' } : null,
    metrics: { totalMs: 100 }, usage: null
  };
}

test('keeps missing human review pending and separates review coverage from acceptable rate', () => {
  const report = buildReport([run({ attempts: [
    attempt('left-1', { accepted: true, quality: 4 }),
    attempt('right-1', { accepted: false, quality: 1 }),
    attempt('left-2', { reviewed: false })
  ] })]);
  const category = report.categories.copy;
  assert.equal(category.reviewedAcceptanceRate, 0.5);
  assert.equal(category.reviewCoverage, 2 / 3);
  assert.equal(category.conservativeAcceptableRate, 1 / 3);
  assert.equal(category.acceptableCount, 1);
  assert.equal(category.pendingCount, 1);
});

test('leaves missing usage and unpriced cost as null', () => {
  const report = buildReport([run({ attempts: [attempt('left-1'), attempt('right-1')] })]);
  assert.equal(report.categories.copy.usage, null);
  assert.equal(report.categories.copy.estimatedCost, null);
  assert.equal(report.categories.copy.costPerAcceptableResult, null);
});

test('splits reports when case version, settings or provider route changes', () => {
  const base = run({ attempts: [attempt('left-1')] });
  const changedCase = run({ caseVersion: 2, attempts: [attempt('left-2')] });
  const changedSettings = run({ settings: { temperature: 0.4 }, attempts: [attempt('left-3')] });
  const changedRoute = run({ route: 'route-c', attempts: [attempt('left-4')] });
  const report = buildReport([base, changedCase, changedSettings, changedRoute]);
  assert.equal(report.groups.length, 4);
  assert.equal(Object.keys(report.categories.copy.groups).length, 4);
  assert.equal(report.categories.copy.groupCount, 4);
  assert.equal(Object.hasOwn(report.categories.copy, 'operationalSuccessRate'), false);
});

test('scores rubric dimensions using the stated weighted 0 to 4 scale', () => {
  const rubric = { clarity: 25, audienceVoice: 25, specificity: 20, persuasion: 20, distinctiveness: 10 };
  assert.equal(scoreRubric({ clarity: 4, audienceVoice: 2, specificity: 3, persuasion: 0, distinctiveness: 1 }, rubric), 2.2);
  assert.equal(scoreRubric({ clarity: 4 }, rubric), null);
});

test('estimates cost only from complete usage and timestamped provider prices', () => {
  const priced = run({ attempts: [
    { ...attempt('left-1'), usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { ...attempt('right-1'), usage: { prompt_tokens: 10, completion_tokens: 5 } }
  ] });
  priced.input.left.pricing = { prompt: '0.1', completion: '0.2' };
  priced.input.left.pricingObservedAt = '2026-10-20T00:00:00.000Z';
  priced.input.left.pricingSource = 'provider-catalogue';
  priced.input.right.pricing = { prompt: '0.3', completion: '0.4' };
  priced.input.right.pricingObservedAt = '2026-10-20T00:00:00.000Z';
  priced.input.right.pricingSource = 'provider-catalogue';
  assert.equal(buildReport([priced]).categories.copy.estimatedCost.amountUsd, 7);
  delete priced.input.right.pricingObservedAt;
  assert.equal(buildReport([priced]).categories.copy.estimatedCost, null);
});

test('reports p95 latency only after twenty observations', () => {
  const attempts = Array.from({ length: 20 }, (_, index) => ({
    ...attempt(`left-${index}`), pairId: `pair-${index}`, metrics: { totalMs: index + 1 }
  }));
  const report = buildReport([run({ attempts })]);
  assert.equal(report.categories.copy.latency.n, 20);
  assert.equal(report.categories.copy.latency.p95Ms, 19);
});

test('maps randomized blind preferences back to the actual model sides and keeps the baseline', () => {
  const record = run({ attempts: [attempt('left-1', { quality: 4 }), attempt('right-1', { quality: 2 })] });
  record.input.baselineSide = 'left';
  record.blindAssignments = { pair: { A: 'right', B: 'left' } };
  record.pairAssessments = { pair: { choice: 'A', reason: 'More useful.' } };
  const group = buildReport([record]).groups[0];
  assert.equal(group.caseTitle, 'Copy');
  assert.equal(group.baselineSide, 'left');
  assert.equal(group.paired.humanPreference.A, 1);
  assert.equal(group.paired.humanPreference.right, 1);
});

test('separates baseline and candidate reliability instead of hiding failures in a pooled rate', () => {
  const left = attempt('left-1', { accepted: true, quality: 4 });
  const right = { ...attempt('right-1', { accepted: false, quality: 0 }), status: 'error' };
  const group = buildReport([run({ attempts: [left, right] })]).groups[0];
  assert.equal(group.sides.left.operationalSuccessRate, 1);
  assert.equal(group.sides.right.operationalSuccessRate, 0);
  assert.equal(group.sides.left.reviewedAcceptanceRate, 1);
  assert.equal(group.sides.right.reviewedAcceptanceRate, 0);
  assert.equal(group.sides.left.attempts, 1);
  assert.equal(group.sides.right.estimatedCost, null);
});

test('a failed required major constraint prevents human acceptance counting as usable', () => {
  const item = attempt('left-1', { accepted: true });
  item.assertions = [{ type: 'array-length', severity: 'major', passed: false }];
  const record = run({ attempts: [item] });
  record.input.caseVersions[0].assertions = [{ type: 'array-length', path: ['variations'], value: 3, severity: 'major' }];
  assert.equal(buildReport([record]).groups[0].acceptableCount, 0);
});

test('reports split when the provider reports a different actual serving route', () => {
  const first = run({ attempts: [attempt('left-1'), attempt('right-1')] });
  const second = structuredClone(first);
  second.id = 'different-actual-route';
  first.attempts[0].actualRoute = 'provider-one';
  second.attempts[0].actualRoute = 'provider-two';
  const report = buildReport([first, second]);
  assert.equal(report.groups.length, 2);
  assert.equal(report.groups[0].modelPair.left[4], 'provider-one');
  assert.equal(report.groups[1].modelPair.left[4], 'provider-two');
});

test('a token-limited response remains incomplete for acceptability', () => {
  const value = { ...attempt('left-1', { accepted: true }), finishReason: 'length' };
  assert.equal(buildReport([run({ attempts: [value] })]).groups[0].acceptableCount, 0);
});
