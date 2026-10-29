import { discoverModels, executeModel } from './providers.mjs';
import { PROTOCOLS, isLoopbackHost, validateCaseVersion, validateRunInput } from './contract.mjs';
import { buildReport, RUBRICS } from './evaluate.mjs';
import { idempotencyValue } from './runner.mjs';
import { redactSecrets } from '../util.mjs';

const TERMINAL = new Set(['complete', 'partial', 'cancelled', 'error', 'interrupted']);
const VERDICTS = new Set([
  'replacement-supported', 'useful-with-review', 'not-supported', 'insufficient-evidence'
]);

function send(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(value));
}

function upstreamAllowed(provider, allowRemoteHttp) {
  const url = new URL(provider.baseUrl);
  if (url.username || url.password || url.hash) throw new Error('Provider URL contains unsupported credentials or fragments.');
  return url.protocol === 'https:' ||
    (url.protocol === 'http:' && isLoopbackHost(url.hostname)) ||
    allowRemoteHttp;
}

function validateDiscoveredEndpoint(provider, model) {
  const endpoint = new URL(model.endpoint);
  const base = new URL(provider.baseUrl);
  if (endpoint.origin !== base.origin) throw new Error(`Model ${model.modelId} endpoint does not match its provider.`);
  if (endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && isLoopbackHost(endpoint.hostname))) {
    throw new Error(`Model ${model.modelId} endpoint must use HTTPS or loopback HTTP.`);
  }
}

async function discover(provider, context) {
  if (!upstreamAllowed(provider, context.state.security?.allowRemoteHttp === true)) {
    throw new Error('Remote HTTP is disabled. Use HTTPS or enable it explicitly.');
  }
  const models = await discoverModels(provider, { fetchImpl: context.fetchImpl });
  for (const model of models) if (model.endpoint) validateDiscoveredEndpoint(provider, model);
  return models;
}

async function catalogueFor(input, context) {
  const ids = [...new Set([input?.left?.providerId, input?.right?.providerId].filter(Boolean))];
  const providers = ids.map(id => context.providerFor(id));
  if (providers.some(provider => !provider)) throw new Error('Selected provider is unavailable.');
  const models = (await Promise.all(providers.map(provider => discover(provider, context)))).flat();
  return { models, providers };
}

function setSseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
}

function eventLine(res, event) {
  if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
}

function assessmentValue(value, testCase) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Assessment is required.');
  if (typeof value.reviewed !== 'boolean' || typeof value.criticalFailure !== 'boolean' ||
      (value.accepted !== null && typeof value.accepted !== 'boolean')) {
    throw new Error('Assessment review, acceptance and critical-failure fields are required.');
  }
  if (!value.scores || typeof value.scores !== 'object' || Array.isArray(value.scores)) {
    throw new Error('Rubric scores must be an object.');
  }
  const rubric = testCase.rubric && Object.keys(testCase.rubric).length
    ? testCase.rubric
    : RUBRICS[testCase.category];
  if (Object.keys(value.scores).some(key => !Object.hasOwn(rubric, key))) {
    throw new Error('Assessment contains a score outside this case rubric.');
  }
  for (const score of Object.values(value.scores)) {
    if (!Number.isInteger(score) || score < 0 || score > 4) throw new Error('Rubric scores must be integers from 0 to 4.');
  }
  if (value.reviewed && Object.keys(rubric).some(key => !Object.hasOwn(value.scores, key))) {
    throw new Error('A reviewed assessment must score every rubric dimension.');
  }
  if (!value.reviewed && value.accepted !== null) throw new Error('An unreviewed assessment must remain pending.');
  const executionStatus = value.execution?.status || 'unverified';
  if (!['unverified', 'pass', 'fail'].includes(executionStatus)) throw new Error('Execution evidence must be unverified, pass or fail.');
  const evidence = value.execution?.evidence;
  if (evidence != null && (typeof evidence !== 'object' || Array.isArray(evidence))) {
    throw new Error('Execution evidence must include a structured provenance record.');
  }
  if (executionStatus !== 'unverified' &&
      (typeof evidence?.source !== 'string' || !evidence.source.trim() ||
       typeof evidence?.date !== 'string' || !Number.isFinite(Date.parse(evidence.date)) ||
       typeof evidence?.notes !== 'string' || !evidence.notes.trim())) {
    throw new Error('Pass or fail status requires a dated, user-supplied source and notes.');
  }
  return {
    reviewed: value.reviewed,
    accepted: value.accepted,
    criticalFailure: value.criticalFailure,
    scores: structuredClone(value.scores),
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 4000) : '',
    execution: { status: executionStatus, evidence: evidence ? {
      source: evidence.source.slice(0, 500), date: evidence.date,
      notes: evidence.notes.slice(0, 4000),
      provenance: 'user-supplied'
    } : null },
    reviewedAt: new Date().toISOString()
  };
}

export async function handleComparisonRoute(req, res, context) {
  const { pathname, searchParams } = new URL(req.url, context.origin(req));
  const method = req.method;
  if (pathname === '/api/comparison/models' && method === 'GET') {
    const providerId = searchParams.get('providerId');
    const provider = context.providerFor(providerId);
    if (!provider) return send(res, 404, { error: 'Provider not found.' }), true;
    return send(res, 200, { models: await discover(provider, context) }), true;
  }
  if (pathname === '/api/comparison/model-mapping' && method === 'POST') {
    const body = await context.readBody(req);
    const provider = context.providerFor(body.providerId);
    if (!provider) return send(res, 404, { error: 'Provider not found.' }), true;
    if (typeof body.modelId !== 'string' || !body.modelId.trim() || body.modelId.length > 240 ||
        !PROTOCOLS.has(body.protocol)) throw new Error('A model ID and supported protocol are required.');
    if (body.route != null && (provider.presetId !== 'openrouter' ||
        typeof body.route !== 'string' || !body.route.trim() || body.route.length > 200 || /[\r\n]/.test(body.route))) {
      throw new Error('An OpenRouter route must be a provider name of at most 200 characters.');
    }
    provider.comparisonModels ||= {};
    provider.comparisonModels[body.modelId] = {
      ...provider.comparisonModels[body.modelId], protocol: body.protocol,
      ...(Object.hasOwn(body, 'route') ? { route: body.route?.trim() || null } : {})
    };
    await context.persist();
    return send(res, 200, { modelId: body.modelId, protocol: body.protocol }), true;
  }
  if (pathname === '/api/comparisons/preflight' && method === 'POST') {
    const body = await context.readBody(req);
    const { models, providers } = await catalogueFor(body.input, context);
    const input = validateRunInput(body.input, models);
    if (input.caseVersions.some(testCase => providers.some(provider =>
      provider.presetId === 'opencode-go' && testCase.category !== 'code'
    ))) {
      throw new Error('OpenCode Go is available for coding cases only until the provider documents broader benchmark use.');
    }
    const pairs = input.caseVersions.length * input.repetitions;
    return send(res, 200, {
      input,
      pairs,
      requestCount: pairs * 2,
      parameterEquivalence: input.exploratoryConfirmed ? 'unverified' : 'supported',
      warnings: input.exploratoryConfirmed ? ['At least one selected parameter has unknown provider support.'] : []
    }), true;
  }
  if (pathname === '/api/comparisons' && method === 'POST') {
    const body = await context.readBody(req);
    if (typeof body.submissionId !== 'string' || !body.submissionId.trim() || body.submissionId.length > 128) {
      throw new Error('A valid comparison submission ID is required.');
    }
    const duplicate = (await context.store.listRuns()).find(run => run.submissionId === body.submissionId);
    if (duplicate) {
      if (idempotencyValue(duplicate.input) !== idempotencyValue(body.input) ||
          (duplicate.rerunOf || null) !== (body.rerunOf || null)) {
        return send(res, 409, { error: 'Submission ID was already used for different input.' }), true;
      }
      return send(res, 200, { id: duplicate.id, duplicate: true }), true;
    }
    if (body.rerunOf != null && typeof body.rerunOf !== 'string') throw new Error('Rerun source must be a comparison ID.');
    if (body.rerunOf && !await context.store.getRun(body.rerunOf)) {
      return send(res, 404, { error: 'Rerun source comparison not found.' }), true;
    }
    const { models, providers } = await catalogueFor(body.input, context);
    const input = validateRunInput(body.input, models);
    if (input.caseVersions.some(testCase => providers.some(provider =>
      provider.presetId === 'opencode-go' && testCase.category !== 'code'
    ))) throw new Error('OpenCode Go is available for coding cases only.');
    const result = await context.runner.start(input, body.submissionId, { rerunOf: body.rerunOf || null });
    return send(res, result.duplicate ? 200 : 201, result), true;
  }
  if (pathname === '/api/comparisons' && method === 'GET') {
    const runs = await context.store.listRuns();
    return send(res, 200, { runs: runs.map(run => ({
      id: run.id, createdAt: run.createdAt, status: run.status,
      category: run.input.caseVersions.length === 1 ? run.input.caseVersions[0].category : 'mixed',
      caseCount: run.input.caseVersions.length,
      repetitions: run.input.repetitions,
      attempts: run.attempts.length,
      verdict: run.verdict,
      rerunOf: run.rerunOf || null
    })) }), true;
  }
  if (pathname === '/api/comparison/cases' && method === 'GET') {
    return send(res, 200, { cases: await context.store.listCases() }), true;
  }
  if (pathname === '/api/comparison/cases' && method === 'POST') {
    const body = await context.readBody(req);
    const item = await context.store.saveCase(validateCaseVersion(body));
    return send(res, 201, { caseVersion: item }), true;
  }

  const reportMatch = pathname.match(/^\/api\/comparisons\/([0-9a-f-]+)\/report$/i);
  if (reportMatch && method === 'GET') {
    const run = await context.runner.get(reportMatch[1]);
    if (!run) return send(res, 404, { error: 'Comparison not found.' }), true;
    const report = buildReport([run]);
    return send(res, 200, {
      ...report, runId: run.id, status: run.status,
      input: run.input, attempts: redactSecrets(run.attempts),
      pairAssessments: run.pairAssessments || {}, verdict: run.verdict,
      rerunOf: run.rerunOf || null
    }), true;
  }

  const eventsMatch = pathname.match(/^\/api\/comparisons\/([0-9a-f-]+)\/events$/i);
  if (eventsMatch && method === 'GET') {
    const id = eventsMatch[1];
    let buffering = true;
    let pending = [];
    const unsubscribe = context.runner.subscribe(id, event => {
      if (buffering) pending.push(event);
      else eventLine(res, event);
      if (event.type === 'terminal' && !event.attemptId && TERMINAL.has(event.data?.status)) res.end();
    });
    const run = await context.runner.get(id);
    if (!run) {
      unsubscribe();
      return send(res, 404, { error: 'Comparison not found.' }), true;
    }
    setSseHeaders(res);
    eventLine(res, { runId: id, type: 'snapshot', data: run });
    buffering = false;
    const terminalDuringSnapshot = pending.some(event => event.type === 'terminal' && !event.attemptId && TERMINAL.has(event.data?.status));
    for (const event of pending) if (event.type !== 'snapshot') eventLine(res, event);
    pending = [];
    if (TERMINAL.has(run.status) || terminalDuringSnapshot) res.end();
    res.on('close', unsubscribe);
    return true;
  }

  const cancelMatch = pathname.match(/^\/api\/comparisons\/([0-9a-f-]+)\/cancel$/i);
  if (cancelMatch && method === 'POST') {
    const body = await context.readBody(req);
    const cancelled = await context.runner.cancel(cancelMatch[1], body.side || 'both');
    return send(res, cancelled ? 200 : 404, { cancelled }), true;
  }

  const assessmentMatch = pathname.match(/^\/api\/comparisons\/([0-9a-f-]+)\/assessment$/i);
  if (assessmentMatch && method === 'POST') {
    const body = await context.readBody(req);
    const run = await context.runner.get(assessmentMatch[1]);
    if (!run) return send(res, 404, { error: 'Comparison not found.' }), true;
    if (!TERMINAL.has(run.status)) return send(res, 409, { error: 'Review is available after the whole batch finishes.' }), true;
    const attempt = run.attempts.find(item => item.id === body.attemptId);
    if (!attempt) return send(res, 404, { error: 'Attempt not found.' }), true;
    const testCase = run.input.caseVersions.find(item => item.id === attempt.caseId && item.version === attempt.caseVersion);
    if (!testCase) return send(res, 409, { error: 'The saved case version for this attempt is missing.' }), true;
    const assessment = assessmentValue(body.assessment, testCase);
    await context.store.updateRun(run.id, saved => {
      saved.attempts.find(item => item.id === attempt.id).assessment = assessment;
    });
    return send(res, 200, { assessment }), true;
  }

  const pairAssessmentMatch = pathname.match(/^\/api\/comparisons\/([0-9a-f-]+)\/pair-assessment$/i);
  if (pairAssessmentMatch && method === 'POST') {
    const body = await context.readBody(req);
    if (!['A', 'B', 'tie', 'neither'].includes(body.choice) ||
        typeof body.reason !== 'string' || !body.reason.trim()) {
      throw new Error('Choose A, B, tie or neither and provide a reason.');
    }
    const run = await context.runner.get(pairAssessmentMatch[1]);
    if (!run) return send(res, 404, { error: 'Comparison not found.' }), true;
    if (!TERMINAL.has(run.status)) return send(res, 409, { error: 'Review is available after the whole batch finishes.' }), true;
    if (!run.attempts.some(item => item.pairId === body.pairId)) return send(res, 404, { error: 'Comparison pair not found.' }), true;
    const pairAssessment = { choice: body.choice, reason: body.reason.slice(0, 4000), recordedAt: new Date().toISOString() };
    await context.store.updateRun(run.id, saved => {
      saved.pairAssessments ||= {};
      saved.pairAssessments[body.pairId] = pairAssessment;
    });
    return send(res, 200, { pairAssessment }), true;
  }

  const verdictMatch = pathname.match(/^\/api\/comparisons\/([0-9a-f-]+)\/verdict$/i);
  if (verdictMatch && method === 'POST') {
    const body = await context.readBody(req);
    if (!VERDICTS.has(body.verdict) || typeof body.rationale !== 'string' || !body.rationale.trim()) {
      throw new Error('Choose a supported verdict and provide its rationale.');
    }
    const run = await context.runner.get(verdictMatch[1]);
    if (!run) return send(res, 404, { error: 'Comparison not found.' }), true;
    if (!TERMINAL.has(run.status)) return send(res, 409, { error: 'Review is available after the whole batch finishes.' }), true;
    const verdict = {
      value: body.verdict,
      rationale: body.rationale.slice(0, 4000),
      evidenceCount: Number.isSafeInteger(body.evidenceCount) && body.evidenceCount >= 0 ? body.evidenceCount : 0,
      recordedAt: new Date().toISOString()
    };
    await context.store.updateRun(run.id, saved => { saved.verdict = verdict; });
    return send(res, 200, { verdict }), true;
  }

  const detailMatch = pathname.match(/^\/api\/comparisons\/([0-9a-f-]+)$/i);
  if (detailMatch && method === 'GET') {
    const run = await context.runner.get(detailMatch[1]);
    return run ? (send(res, 200, run), true) : (send(res, 404, { error: 'Comparison not found.' }), true);
  }
  return false;
}

export function comparisonExecutor(fetchImpl) {
  return options => executeModel({ ...options, fetchImpl });
}
