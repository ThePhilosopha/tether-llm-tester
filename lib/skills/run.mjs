import { buildRequest, executeModel } from '../comparison/providers.mjs';
import { parseSkill } from './parse.mjs';
import { redactSecrets } from '../util.mjs';

const MAX_OUTPUT = 4 * 1024 * 1024;
const SKILL_BUDGET = 24 * 1024;

function skillPrompt(source, task) {
  return [
    'You are being audited. Follow the skill below to answer the task.',
    'Reply with the answer only. Do not describe the skill itself.',
    '',
    '<skill>',
    source.slice(0, SKILL_BUDGET),
    source.length > SKILL_BUDGET ? '\n[skill truncated for this request]' : '',
    '</skill>',
    '',
    `<task>${task}</task>`
  ].join('\n');
}

export async function runSkillAcrossModels({
  source, task, models, settings, resolveProvider,
  execute = executeModel, clock = () => Date.now()
}) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('Skill text is required.');
  if (typeof task !== 'string' || !task.trim()) throw new Error('A task prompt is required.');
  if (!Array.isArray(models) || models.length === 0) throw new Error('Choose at least one model.');
  if (models.length > 8) throw new Error('A skill run supports at most eight models.');
  if (typeof resolveProvider !== 'function') throw new Error('A provider resolver is required.');

  const parsed = parseSkill(source, { slug: 'run' });
  const prompt = skillPrompt(source, task);
  const testCase = { id: 'skill-run', version: 1, category: 'code', title: 'Skill run', system: '', prompt, assertions: [], rubric: {}, holdout: false };
  const results = [];

  for (const [index, model] of models.entries()) {
    const startedAt = clock();
    const attempt = {
      index, providerId: model.providerId, modelId: model.modelId, protocol: model.protocol,
      startedAt: new Date().toISOString(), status: 'running',
      output: '', reasoning: '', usage: null, error: null, durationMs: null, audit: null,
      skillTruncated: source.length > SKILL_BUDGET
    };
    try {
      const provider = await resolveProvider(model.providerId);
      const sessionId = `skill-${index}`;
      const request = buildRequest(provider, model, testCase, settings, sessionId);
      const result = await execute({ provider, model, testCase, settings, sessionId, emit: () => {} });
      attempt.output = String(result.text || '').slice(0, MAX_OUTPUT);
      attempt.reasoning = String(result.reasoning || '').slice(0, MAX_OUTPUT);
      attempt.usage = result.usage || null;
      attempt.finishReason = result.finishReason || null;
      attempt.status = 'complete';
      attempt.audit = {
        request: { url: request.url, method: request.method, headers: redactSecrets(request.headers), body: request.body },
        response: { finishReason: result.finishReason || null, usage: result.usage || null, rawChars: String(result.raw || '').length },
        latencyMs: clock() - startedAt
      };
    } catch (error) {
      attempt.status = 'error';
      attempt.error = error.message;
    }
    attempt.durationMs = clock() - startedAt;
    results.push(attempt);
  }
  return { task, prompt, skill: { name: parsed.name, counts: parsed.counts }, results };
}
