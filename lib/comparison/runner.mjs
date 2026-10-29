import { randomInt, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildRequest, executeModel } from './providers.mjs';
import { freezeRunInput } from './contract.mjs';
import { evaluateAssertions } from './evaluate.mjs';
import { appendText, redactSecrets } from '../util.mjs';

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const SAFE_RESPONSE_HEADERS = new Set([
  'content-type', 'retry-after', 'server-timing', 'x-request-id', 'openai-processing-ms'
]);

function responseHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) =>
    SAFE_RESPONSE_HEADERS.has(key.toLowerCase())
  ));
}

export function idempotencyValue(input) {
  const stable = structuredClone(input);
  for (const side of ['left', 'right']) {
    if (stable[side]) {
      delete stable[side].capabilityCheckedAt;
      delete stable[side].pricingObservedAt;
      delete stable[side].pricingSource;
      delete stable[side].pricing;
    }
  }
  delete stable.pricing;
  return JSON.stringify(stable);
}

export function createComparisonRunner({
  store,
  resolveProvider,
  executeModel: execute = executeModel,
  clock = () => performance.now(),
  timeoutMs
}) {
  if (!store || typeof resolveProvider !== 'function') {
    throw new Error('Comparison runner requires a store and provider resolver.');
  }
  const jobs = new Map();
  const listeners = new Map();
  const activeControllers = new Map();
  let activeRunId = null;
  let starts = Promise.resolve();

  function publish(job, event) {
    const message = { runId: job.record.id, ...event };
    for (const listener of listeners.get(job.record.id) || []) {
      try { listener(message); } catch {}
    }
  }

  function persist(job) {
    const snapshot = structuredClone(job.record);
    job.write = job.write.catch(() => {}).then(() => store.saveRun(snapshot));
    return job.write;
  }

  function schedulePersist(job) {
    if (job.persistTimer) return;
    job.persistTimer = setTimeout(() => {
      job.persistTimer = null;
      persist(job).catch(error => { job.persistError = error; });
    }, 250);
  }

  async function flush(job) {
    if (job.persistTimer) {
      clearTimeout(job.persistTimer);
      job.persistTimer = null;
    }
    await persist(job);
  }

  function start(input, submissionId, options = {}) {
    const operation = starts.then(() => startSerial(input, submissionId, options));
    starts = operation.catch(() => {});
    return operation;
  }

  async function startSerial(input, submissionId, { rerunOf = null } = {}) {
    if (typeof submissionId !== 'string' || !submissionId.trim() || submissionId.length > 128) {
      throw new Error('A valid comparison submission ID is required.');
    }
    const frozenInput = freezeRunInput(input);
    const existing = (await store.listRuns()).find(run => run.submissionId === submissionId);
    if (existing) {
      if (idempotencyValue(existing.input) !== idempotencyValue(frozenInput) ||
          (existing.rerunOf || null) !== rerunOf) {
        throw new Error('Submission ID was already used for different input.');
      }
      return { id: existing.id, duplicate: true };
    }
    if (activeRunId) throw new Error('Another comparison batch is already running.');

    const id = randomUUID();
    const attempts = [];
    const pairs = [];
    for (const testCase of frozenInput.caseVersions) {
      for (let repetition = 1; repetition <= frozenInput.repetitions; repetition++) {
        const pairId = randomUUID();
        const pair = { pairId, testCase, repetition, attempts: [] };
        for (const side of ['left', 'right']) {
          const attempt = {
            id: randomUUID(), pairId, side, caseId: testCase.id,
            caseVersion: testCase.version, repetition, status: 'queued',
            output: '', reasoning: '', toolCalls: [], raw: '', rawTruncated: false,
            metrics: {}, usage: null, actualRoute: null, error: null, assertions: null, assessment: null
          };
          attempts.push(attempt);
          pair.attempts.push(attempt);
        }
        pairs.push(pair);
      }
    }
    const blindAssignments = Object.fromEntries(pairs.map(pair => [
      pair.pairId,
      randomInt(0, 2) === 0 ? { A: 'left', B: 'right' } : { A: 'right', B: 'left' }
    ]));
    const record = {
      schemaVersion: 1, id, createdAt: new Date().toISOString(), input: frozenInput,
      status: 'queued', attempts, blindAssignments, pairAssessments: {}, verdict: null,
      submissionId, rerunOf
    };
    const job = {
      record, pairs, cancelledSides: new Set(), write: Promise.resolve(),
      persistTimer: null, persistError: null, done: null
    };
    await store.saveRun(record);
    jobs.set(id, job);
    activeRunId = id;
    publish(job, { type: 'snapshot', data: structuredClone(record) });
    job.done = runBatch(job).catch(async error => {
      job.record.status = 'error';
      job.record.error = `Could not persist comparison progress: ${error.message}`;
      job.record.finishedAt = new Date().toISOString();
      for (const attempt of job.record.attempts) {
        activeControllers.get(attempt.id)?.abort();
        if (['queued', 'running'].includes(attempt.status)) attempt.status = 'interrupted';
      }
      try { await flush(job); }
      catch (failure) { job.persistError = failure; }
      publish(job, { type: 'terminal', data: structuredClone(job.record) });
    }).finally(() => {
      if (activeRunId === id) activeRunId = null;
    });
    return { id, duplicate: false };
  }

  async function runSide(job, pair, attempt, modelRef) {
    if (job.cancelledSides.has(attempt.side)) {
      attempt.status = 'cancelled';
      attempt.finishedAt = new Date().toISOString();
      return;
    }
    const controller = new AbortController();
    const started = clock();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs ?? job.record.input.settings.timeoutMs);
    activeControllers.set(attempt.id, controller);
    attempt.status = 'running';
    attempt.startedAt = new Date().toISOString();
    attempt.metrics.dispatchAt = started;
    try {
      const provider = await resolveProvider(modelRef.providerId);
      const request = buildRequest(provider, modelRef, pair.testCase, job.record.input.settings, pair.pairId);
      attempt.request = {
        url: request.url, method: request.method,
        headers: redactSecrets(request.headers), body: request.body
      };
      publish(job, { type: 'request', pairId: pair.pairId, attemptId: attempt.id, side: attempt.side, data: attempt.request });
      schedulePersist(job);

      let abortListener;
      const aborted = new Promise((_, reject) => {
        abortListener = () => reject(Object.assign(
          new Error(timedOut ? 'Model request timed out.' : 'Model request cancelled.'),
          { name: timedOut ? 'TimeoutError' : 'AbortError' }
        ));
        controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      const result = await Promise.race([execute({
        provider, model: modelRef, testCase: pair.testCase,
        settings: job.record.input.settings, sessionId: pair.pairId,
        signal: controller.signal,
        emit: event => {
          const elapsed = Math.max(0, clock() - started);
          if (event.type === 'response') {
            attempt.responseStatus = event.status;
            attempt.responseHeaders = responseHeaders(event.headers);
            attempt.metrics.firstResponseMs ??= elapsed;
            publish(job, { type: 'response', pairId: pair.pairId, attemptId: attempt.id, side: attempt.side, data: { status: event.status, headers: attempt.responseHeaders } });
          } else if (event.type === 'delta') {
            attempt.metrics.firstContentMs ??= elapsed;
            const next = appendText(attempt.output, event.text || '', MAX_TEXT_BYTES);
            attempt.output = next.value;
            attempt.outputTruncated ||= next.truncated;
            publish(job, { type: 'delta', pairId: pair.pairId, attemptId: attempt.id, side: attempt.side, data: { text: event.text || '' } });
          } else if (event.type === 'reasoning') {
            attempt.reasoning += event.text || '';
          } else if (event.type === 'raw') {
            const next = appendText(attempt.raw, event.data || '', 1024 * 1024);
            attempt.raw = next.value;
            attempt.rawTruncated ||= next.truncated;
            publish(job, { type: 'raw', pairId: pair.pairId, attemptId: attempt.id, side: attempt.side, data: { text: event.data || '' } });
          }
          schedulePersist(job);
        }
      }), aborted]);
      controller.signal.removeEventListener('abort', abortListener);
      if (controller.signal.aborted) throw Object.assign(new Error('Model request cancelled.'), { name: 'AbortError' });
      if (typeof result.text === 'string') {
        const next = appendText('', result.text, MAX_TEXT_BYTES);
        attempt.output = next.value;
        attempt.outputTruncated ||= next.truncated;
        attempt.metrics.firstContentMs ??= Math.max(0, clock() - started);
      }
      attempt.reasoning = result.reasoning || attempt.reasoning;
      attempt.toolCalls = result.toolCalls || [];
      if (result.raw != null) {
        const next = appendText('', result.raw, 1024 * 1024);
        attempt.raw = next.value;
        attempt.rawTruncated ||= next.truncated;
      }
      attempt.rawTruncated ||= result.rawTruncated === true;
      attempt.finishReason = result.finishReason || null;
      attempt.usage = result.usage || null;
      attempt.actualRoute = result.actualRoute || null;
      if (!attempt.outputTruncated) {
        attempt.assertions = evaluateAssertions(attempt.output, pair.testCase.assertions);
        attempt.criticalFailure = attempt.assertions.some(rule => rule.severity === 'critical' && !rule.passed);
      } else {
        attempt.assertions = null;
        attempt.evaluationStatus = 'truncated';
      }
      attempt.status = 'complete';
      attempt.metrics.totalMs = Math.max(0, clock() - started);
    } catch (error) {
      attempt.status = timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'error';
      attempt.error = error.message;
      attempt.metrics.totalMs = Math.max(0, clock() - started);
    } finally {
      clearTimeout(timer);
      activeControllers.delete(attempt.id);
      attempt.finishedAt = new Date().toISOString();
      await flush(job);
      publish(job, { type: 'terminal', pairId: pair.pairId, attemptId: attempt.id, side: attempt.side, data: structuredClone(attempt) });
    }
  }

  async function runBatch(job) {
    job.record.status = 'running';
    await flush(job);
    for (const pair of job.pairs) {
      if (job.cancelledSides.has('both')) {
        for (const attempt of pair.attempts) {
          attempt.status = 'cancelled';
          attempt.finishedAt = new Date().toISOString();
        }
        continue;
      }
      const outcomes = await Promise.allSettled(pair.attempts.map(attempt => runSide(
        job, pair, attempt, job.record.input[attempt.side]
      )));
      const failed = outcomes.find(outcome => outcome.status === 'rejected');
      if (failed) throw failed.reason;
      const [left, right] = pair.attempts;
      const dispatchSkewMs = Number.isFinite(left.metrics.dispatchAt) && Number.isFinite(right.metrics.dispatchAt)
        ? Math.abs(left.metrics.dispatchAt - right.metrics.dispatchAt)
        : null;
      left.metrics.dispatchSkewMs = dispatchSkewMs;
      right.metrics.dispatchSkewMs = dispatchSkewMs;
      if (job.persistError) {
        throw job.persistError;
      }
    }
    const statuses = job.record.attempts.map(attempt => attempt.status);
    const completed = statuses.filter(status => status === 'complete').length;
    job.record.status = completed === statuses.length
      ? 'complete'
      : completed > 0
        ? 'partial'
        : statuses.every(status => status === 'cancelled' || status === 'interrupted')
          ? 'cancelled'
          : 'error';
    job.record.finishedAt = new Date().toISOString();
    await flush(job);
    publish(job, { type: 'terminal', data: structuredClone(job.record) });
  }

  async function get(id) {
    const job = jobs.get(id);
    if (job && (job.persistError || ['queued', 'running'].includes(job.record.status))) return structuredClone(job.record);
    return store.getRun(id);
  }

  function subscribe(id, listener) {
    if (typeof listener !== 'function') throw new Error('Comparison listener must be a function.');
    const set = listeners.get(id) || new Set();
    set.add(listener);
    listeners.set(id, set);
    const job = jobs.get(id);
    if (job) listener({ runId: id, type: 'snapshot', data: structuredClone(job.record) });
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(id);
    };
  }

  async function cancel(id, side = 'both') {
    const job = jobs.get(id);
    if (!job || job.record.status !== 'running') return false;
    if (!['left', 'right', 'both'].includes(side)) throw new Error('Cancel side must be left, right or both.');
    if (side === 'both') job.cancelledSides.add('both');
    else job.cancelledSides.add(side);
    for (const pair of job.pairs) {
      for (const attempt of pair.attempts) {
        if (attempt.status === 'queued' && (side === 'both' || attempt.side === side)) {
          attempt.status = 'cancelled';
          attempt.finishedAt = new Date().toISOString();
        }
      }
    }
    for (const attempt of job.record.attempts) {
      if (side === 'both' || attempt.side === side) activeControllers.get(attempt.id)?.abort();
    }
    await flush(job);
    return true;
  }

  async function close() {
    await starts;
    for (const [id, job] of jobs) {
      try { await cancel(id, 'both'); }
      catch (error) { job.persistError = error; }
    }
    await Promise.all([...jobs.values()].map(job => job.done).filter(Boolean));
  }

  return { start, get, subscribe, cancel, close };
}
