import { validateAssertions } from './contract.mjs';

export const RUBRICS = Object.freeze({
  copy: Object.freeze({ clarity: 25, audienceVoice: 25, specificity: 20, persuasion: 20, distinctiveness: 10 }),
  layout: Object.freeze({ hierarchy: 25, flow: 25, audienceFit: 20, assumptionHandling: 15, accessibility: 15 }),
  code: Object.freeze({ diagnosis: 40, solutionReasoning: 40, maintainability: 20 })
});

function getPath(value, path) {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

export function evaluateAssertions(text, assertions) {
  const rules = validateAssertions(assertions);
  let parsed;
  let parsedDone = false;
  const parse = () => {
    if (!parsedDone) {
      parsedDone = true;
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    }
    return parsed;
  };
  return rules.map(rule => {
    let passed = false;
    let actual = null;
    let expected = null;
    switch (rule.type) {
      case 'json-valid':
        expected = 'valid JSON';
        parse();
        passed = parsed !== undefined;
        actual = passed ? 'valid JSON' : 'invalid JSON';
        break;
      case 'array-length': {
        const value = parse() !== undefined ? getPath(parsed, rule.path) : undefined;
        expected = rule.value;
        actual = Array.isArray(value) ? value.length : null;
        passed = actual === rule.value;
        break;
      }
      case 'word-count': {
        actual = text.trim() ? text.trim().split(/\s+/u).length : 0;
        expected = { min: rule.min, max: rule.max };
        passed = actual >= rule.min && actual <= rule.max;
        break;
      }
      case 'includes':
        expected = rule.value;
        actual = text.includes(rule.value);
        passed = actual;
        break;
      case 'excludes':
        expected = rule.value;
        actual = text.includes(rule.value);
        passed = !actual;
        break;
    }
    return {
      type: rule.type, severity: rule.severity, passed,
      expected, actual,
      message: passed ? 'Passed.' : `${rule.type} assertion failed.`
    };
  });
}

export function scoreRubric(scores, rubric) {
  if (!scores || typeof scores !== 'object' || Array.isArray(scores) ||
      !rubric || typeof rubric !== 'object' || Array.isArray(rubric)) return null;
  const dimensions = Object.entries(rubric);
  if (!dimensions.length) return null;
  let totalWeight = 0;
  let weighted = 0;
  for (const [dimension, weight] of dimensions) {
    const score = scores[dimension];
    if (!Number.isFinite(weight) || weight <= 0 ||
        !Number.isInteger(score) || score < 0 || score > 4) return null;
    totalWeight += weight;
    weighted += score * weight;
  }
  return Math.round((weighted / totalWeight) * 100) / 100;
}

function modelIdentity(model) {
  return [model?.providerId || null, model?.modelId || null, model?.protocol || null,
    model?.endpoint || null, model?.route || null];
}

function pairModel(run, attempt, side) {
  const selected = run.input?.[side];
  const route = run.attempts?.find(item => item.pairId === attempt.pairId && item.side === side)?.actualRoute;
  return route ? { ...selected, route } : selected;
}

function groupIdentity(run, item, attempt) {
  return JSON.stringify({
    category: item?.category || 'unknown',
    caseId: item?.id || null,
    caseVersion: item?.version || null,
    settings: run.input?.settings || null,
    left: modelIdentity(pairModel(run, attempt, 'left')),
    right: modelIdentity(pairModel(run, attempt, 'right')),
    baselineSide: run.input?.baselineSide || null,
    exploratoryConfirmed: run.input?.exploratoryConfirmed === true
  });
}

function accepted(attempt, testCase) {
  const assessment = attempt.assessment;
  if (!assessment || assessment.reviewed !== true || typeof assessment.accepted !== 'boolean') return null;
  if (assessment.accepted !== true || assessment.criticalFailure === true) return false;
  if (attempt.status !== 'complete' || !attempt.output?.trim() || attempt.outputTruncated) return false;
  if (['length', 'max_tokens', 'max_output_tokens', 'incomplete', 'failed', 'content_filter', 'safety']
    .includes(attempt.finishReason?.toLowerCase())) return false;
  const rules = testCase?.assertions || [];
  if (rules.length && !Array.isArray(attempt.assertions)) return false;
  return !(attempt.assertions || []).some(result => result.passed !== true);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(percentileValue * sorted.length) - 1];
}

function usageFields(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount;
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  return { prompt, completion };
}

function priceFor(model) {
  if (!model?.pricing || !model.pricingObservedAt || !model.pricingSource) return null;
  const prompt = Number(model.pricing.prompt);
  const completion = Number(model.pricing.completion);
  if (!Number.isFinite(prompt) || prompt < 0 || !Number.isFinite(completion) || completion < 0) return null;
  return { prompt, completion, observedAt: model.pricingObservedAt, source: model.pricingSource };
}

function summariseAttempts(rows, key) {
  const attempts = rows.map(row => row.attempt);
  const caseByAttempt = new Map(rows.map(row => [row.attempt, row.testCase]));
  const reviewed = attempts.filter(attempt => attempt.assessment?.reviewed === true);
  const acceptable = attempts.filter(attempt => accepted(attempt, caseByAttempt.get(attempt)) === true);
  const pending = attempts.filter(attempt => accepted(attempt, caseByAttempt.get(attempt)) === null);
  const completed = attempts.filter(attempt => attempt.status === 'complete');
  const failuresByType = {};
  for (const attempt of attempts) {
    if (attempt.status !== 'complete') failuresByType[attempt.status] = (failuresByType[attempt.status] || 0) + 1;
    for (const result of attempt.assertions || []) {
      if (!result.passed) failuresByType[`assertion:${result.type}`] = (failuresByType[`assertion:${result.type}`] || 0) + 1;
    }
  }
  const quality = [];
  for (const row of rows) {
    const dimensions = row.testCase?.rubric && Object.keys(row.testCase.rubric).length
      ? row.testCase.rubric
      : RUBRICS[row.testCase?.category];
    const value = scoreRubric(row.attempt.assessment?.scores, dimensions);
    if (value !== null) quality.push(value);
  }
  const latency = attempts.map(attempt => attempt.metrics?.totalMs)
    .filter(value => Number.isFinite(value) && value >= 0);
  const usageSamples = [];
  const costSamples = [];
  let completeCostCoverage = true;
  for (const row of rows) {
    const usage = usageFields(row.attempt.usage);
    const model = row.run.input?.[row.attempt.side];
    if (row.attempt.usage) usageSamples.push({ providerId: model?.providerId, modelId: model?.modelId, usage: row.attempt.usage });
    const price = priceFor(model);
    if (!usage || !price) {
      completeCostCoverage = false;
      continue;
    }
    costSamples.push({ amount: usage.prompt * price.prompt + usage.completion * price.completion, source: price.source, observedAt: price.observedAt });
  }
  const pairScores = new Map();
  for (const row of rows) {
    const dimensions = row.testCase?.rubric && Object.keys(row.testCase.rubric).length
      ? row.testCase.rubric
      : RUBRICS[row.testCase?.category];
    const qualityScore = scoreRubric(row.attempt.assessment?.scores, dimensions);
    if (qualityScore === null) continue;
    const pair = pairScores.get(row.attempt.pairId) || {};
    pair[row.attempt.side] = qualityScore;
    pairScores.set(row.attempt.pairId, pair);
  }
  const paired = { wins: 0, ties: 0, losses: 0, n: 0 };
  for (const pair of pairScores.values()) {
    if (!Number.isFinite(pair.left) || !Number.isFinite(pair.right)) continue;
    paired.n++;
    if (pair.left > pair.right) paired.wins++;
    else if (pair.left < pair.right) paired.losses++;
    else paired.ties++;
  }
  const pairJudgements = new Map();
  for (const row of rows) {
    const key = `${row.run.id}:${row.attempt.pairId}`;
    const judgement = row.run.pairAssessments?.[row.attempt.pairId];
    if (judgement && !pairJudgements.has(key)) {
      pairJudgements.set(key, {
        choice: judgement.choice,
        assignment: row.run.blindAssignments?.[row.attempt.pairId]
      });
    }
  }
  const humanPreference = { A: 0, B: 0, left: 0, right: 0, tie: 0, neither: 0, n: 0 };
  for (const { choice, assignment } of pairJudgements.values()) {
    if (Object.hasOwn(humanPreference, choice)) {
      humanPreference[choice]++;
      if (choice === 'A' || choice === 'B') {
        const side = assignment?.[choice];
        if (side === 'left' || side === 'right') humanPreference[side]++;
      }
      humanPreference.n++;
    }
  }
  const cost = completeCostCoverage && costSamples.length === rows.length
    ? costSamples.reduce((sum, item) => sum + item.amount, 0)
    : null;
  return {
    key,
    attempts: attempts.length,
    operationalSuccessRate: attempts.length ? completed.length / attempts.length : null,
    reviewedAcceptanceRate: reviewed.length ? acceptable.length / reviewed.length : null,
    reviewCoverage: attempts.length ? reviewed.length / attempts.length : null,
    conservativeAcceptableRate: attempts.length ? acceptable.length / attempts.length : null,
    acceptableCount: acceptable.length,
    pendingCount: pending.length,
    failuresByType,
    quality: quality.length ? { n: quality.length, median: median(quality), min: Math.min(...quality), max: Math.max(...quality) } : null,
    paired: { ...paired, humanPreference },
    latency: latency.length ? {
      n: latency.length, medianMs: median(latency), minMs: Math.min(...latency), maxMs: Math.max(...latency),
      p95Ms: latency.length >= 20 ? percentile(latency, 0.95) : null
    } : null,
    usage: usageSamples.length ? { n: usageSamples.length, samples: usageSamples } : null,
    estimatedCost: cost === null ? null : {
      amountUsd: cost,
      label: 'estimated',
      pricesObservedAt: [...new Set(costSamples.map(item => item.observedAt))],
      sources: [...new Set(costSamples.map(item => item.source))]
    },
    costPerAcceptableResult: cost !== null && acceptable.length ? cost / acceptable.length : null,
    subscriptionAllocation: rows.some(row => row.run.input?.left?.providerId === 'opencode-go' || row.run.input?.right?.providerId === 'opencode-go')
      ? 'Not inferred from API usage; subscription allocation is separate.'
      : null
  };
}

export function buildReport(runRecords) {
  if (!Array.isArray(runRecords)) throw new Error('Report input must be an array of comparison runs.');
  const grouped = new Map();
  for (const run of runRecords) {
    const cases = run.input?.caseVersions || [];
    for (const attempt of run.attempts || []) {
      const testCase = cases.find(item => item.id === attempt.caseId && item.version === attempt.caseVersion);
      const key = groupIdentity(run, testCase, attempt);
      const row = { run, attempt, testCase };
      const rows = grouped.get(key) || [];
      rows.push(row);
      grouped.set(key, rows);
    }
  }
  const groups = [...grouped.entries()].map(([key, rows]) => ({
    ...summariseAttempts(rows, key),
    sides: Object.fromEntries(['left', 'right'].map(side => [
      side, summariseAttempts(rows.filter(row => row.attempt.side === side), key)
    ])),
    category: rows[0].testCase?.category || 'unknown',
    caseId: rows[0].testCase?.id || null,
    caseVersion: rows[0].testCase?.version || null,
    caseTitle: rows[0].testCase?.title || null,
    modelPair: Object.fromEntries(['left', 'right'].map(side => [
      side, modelIdentity(pairModel(rows[0].run, rows[0].attempt, side))
    ])),
    settings: rows[0].run.input?.settings || null,
    baselineSide: rows[0].run.input?.baselineSide || null
  }));
  const categories = {};
  for (const category of ['copy', 'layout', 'code', 'unknown']) {
    const categoryGroups = groups.filter(group => group.category === category);
    if (!categoryGroups.length) continue;
    const summary = categoryGroups.length === 1 ? categoryGroups[0] : null;
    categories[category] = {
      ...(summary || {}),
      groupCount: categoryGroups.length,
      groups: Object.fromEntries(categoryGroups.map(group => [group.key, group]))
    };
  }
  return { generatedAt: new Date().toISOString(), groups, categories };
}
