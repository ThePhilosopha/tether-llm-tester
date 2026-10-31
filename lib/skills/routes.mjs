import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseSkill, explainMechanically, buildDiagram } from './parse.mjs';
import { skillSlug } from './store.mjs';
import { importSkillFromDirectory } from './import.mjs';
import { runSkillAcrossModels } from './run.mjs';
import { discoverModels } from '../comparison/providers.mjs';

const SKILL_ROOTS = [
  join(homedir(), '.claude', 'skills'),
  join(homedir(), '.omp', 'agent', 'skills')
];

export const DEFAULT_SKILL_MODEL = 'deepseek-v4.1-flash:cloud';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isLocalProvider(provider) {
  if (!provider) return false;
  if (provider.presetId === 'ollama') return true;
  try { return LOCAL_HOSTS.has(new URL(provider.baseUrl).hostname); }
  catch { return false; }
}

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function explainWithModel(provider, model, source, fetchImpl, timeoutMs = 180000) {
  const prompt = [
    'Explain the following agent skill to a non-technical reader.',
    'Return JSON: {"summary": "one sentence", "steps": ["plain English step", ...], "cautions": ["risk or limitation", ...]}.',
    'Describe what the skill actually does. Do not invent capabilities.',
    '',
    source.slice(0, 24 * 1024)
  ].join('\n');
  const body = {
    model: model.modelId, messages: [{ role: 'user', content: prompt }],
    temperature: 0.2, max_tokens: 900, stream: false
  };
  if (model.protocol === 'chat-completions') body.response_format = { type: 'json_object' };
  const url = new URL('chat/completions', `${provider.baseUrl.replace(/\/$/, '')}/`).toString();
  const headers = { 'content-type': 'application/json', accept: 'application/json', ...(provider.headers || {}) };
  if (provider.auth === 'bearer' && provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  return fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    .then(async response => {
      const text = await response.text();
      if (!response.ok) throw new Error(`Explanation request failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
      const payload = JSON.parse(text);
      const message = payload?.choices?.[0]?.message || {};
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      const rawReasoning = typeof message.reasoning === 'string' ? message.reasoning.trim() : '';
      if (!content) {
        throw new Error(rawReasoning
          ? `${model.modelId} spent its whole budget on reasoning and returned no answer. Try a model that answers directly.`
          : `${model.modelId} returned an empty answer.`);
      }
      const parsed = (() => { try { return JSON.parse(content); } catch { return null; } })();
      return {
        modelId: model.modelId, providerId: provider.id, generatedAt: new Date().toISOString(),
        summary: parsed?.summary || content.split(/\n{2,}/)[0].slice(0, 400),
        steps: Array.isArray(parsed?.steps) ? parsed.steps.slice(0, 40).map(String) : [],
        cautions: Array.isArray(parsed?.cautions) ? parsed.cautions.slice(0, 20).map(String) : [],
        structured: Boolean(parsed),
        raw: content.slice(0, 4000)
      };
    });
}

export async function handleSkillRoute(req, res, context) {
  const { pathname } = new URL(req.url, context.origin(req));
  const method = req.method;

  if (pathname === '/api/skills' && method === 'GET') {
    const stored = await context.skillStore.list();
    return send(res, 200, {
      skills: stored.map(item => ({ slug: item.slug, updatedAt: item.updatedAt, ...parseSkill(item.source, { slug: item.slug }) })),
      roots: SKILL_ROOTS
    }), true;
  }

  if (pathname === '/api/skills/import' && method === 'GET') {
    const found = [];
    for (const root of SKILL_ROOTS) {
      for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) found.push({ slug: entry.name, root });
      }
    }
    return send(res, 200, { available: found.sort((a, b) => a.slug.localeCompare(b.slug)) }), true;
  }

  if (pathname === '/api/skills/import' && method === 'POST') {
    const body = await context.readBody(req);
    const slug = skillSlug(body.slug);
    const roots = body.root ? SKILL_ROOTS.filter(candidate => candidate === body.root) : SKILL_ROOTS;
    if (!roots.length) throw new Error('That skill source folder is not allowed.');
    let source = null;
    for (const root of roots) {
      if (!(await readdir(root).catch(() => [])).includes(slug)) continue;
      source = { root, ...(await importSkillFromDirectory(root, slug)) };
      break;
    }
    if (!source) throw new Error('Skill not found in the allowed folders.');
    await context.skillStore.save(slug, source.source);
    return send(res, 201, { slug, root: source.root, extras: source.extras, source: source.source }), true;
  }

  const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
  if (skillMatch && method === 'GET') {
    const slug = decodeURIComponent(skillMatch[1]);
    const stored = await context.skillStore.get(slug);
    if (!stored) return send(res, 404, { error: 'Skill not found in the app store.' }), true;
    const parsed = parseSkill(stored.source, { slug });
    return send(res, 200, {
      slug, source: stored.source, parsed,
      plainEnglish: { mechanical: explainMechanically(parsed) },
      diagram: buildDiagram(parsed)
    }), true;
  }

  if (skillMatch && method === 'PUT') {
    const body = await context.readBody(req);
    const saved = await context.skillStore.save(decodeURIComponent(skillMatch[1]), body.source);
    const parsed = parseSkill(body.source, { slug: saved.slug });
    return send(res, 200, {
      ...saved, parsed,
      plainEnglish: { mechanical: explainMechanically(parsed) },
      diagram: buildDiagram(parsed)
    }), true;
  }

  const explainMatch = pathname.match(/^\/api\/skills\/([^/]+)\/explain$/);
  if (explainMatch && method === 'POST') {
    const body = await context.readBody(req);
    const stored = await context.skillStore.get(decodeURIComponent(explainMatch[1]));
    if (!stored) return send(res, 404, { error: 'Skill not found in the app store.' }), true;
    const provider = context.providerFor(body.providerId);
    if (!provider) return send(res, 404, { error: 'Provider not found.' }), true;
    if (isLocalProvider(provider)) throw new Error('Local models cannot be used here. Choose a remote provider.');
    const modelId = body.modelId || DEFAULT_SKILL_MODEL;
    const explanation = await explainWithModel(provider, { providerId: provider.id, modelId, protocol: 'chat-completions' }, stored.source, context.fetchImpl);
    return send(res, 200, { explanation }), true;
  }

  const runMatch = pathname.match(/^\/api\/skills\/([^/]+)\/run$/);
  if (runMatch && method === 'POST') {
    const body = await context.readBody(req);
    const stored = await context.skillStore.get(decodeURIComponent(runMatch[1]));
    if (!stored) return send(res, 404, { error: 'Skill not found in the app store.' }), true;
    const requested = Array.isArray(body.models) ? body.models : [];
    const catalogue = new Map();
    const models = [];
    for (const entry of requested) {
      const provider = context.providerFor(entry?.providerId);
      if (!provider) throw new Error('Selected provider was unavailable.');
      if (isLocalProvider(provider)) throw new Error('Local models cannot be used here. Choose a remote provider.');
      if (!catalogue.has(provider.id)) {
        catalogue.set(provider.id, await discoverModels(provider, { fetchImpl: context.fetchImpl }));
      }
      const resolved = catalogue.get(provider.id).find(model => model.modelId === entry.modelId);
      if (!resolved) throw new Error(`Model ${entry.modelId} is not available from ${provider.name}.`);
      if (!resolved.available) throw new Error(`Model ${entry.modelId} needs a protocol mapping before it can be tested.`);
      models.push(resolved);
    }
    const settings = {
      temperature: 0.7, topP: 1, maxOutputTokens: 1024, stream: true, timeoutMs: 120000,
      ...(body.settings || {})
    };
    const report = await runSkillAcrossModels({
      source: stored.source, task: body.task, models, settings,
      resolveProvider: async id => {
        const provider = context.providerFor(id);
        if (!provider) throw new Error('Selected provider was removed.');
        return { ...provider, allowRemoteHttp: context.state.security.allowRemoteHttp === true };
      }
    });
    return send(res, 200, report), true;
  }

  return false;
}
