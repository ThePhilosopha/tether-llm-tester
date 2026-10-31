import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { defaultStatePath, loadState, publicState, saveState, validateProvider, isLoopbackUrl } from './lib/state.mjs';
import { forwardSse } from './lib/sse.mjs';
import { appendPath, redactSecrets } from './lib/util.mjs';
import { runOllama, validateModelName, validateSettings, macosEnvCommands } from './lib/ollama.mjs';
import { createComparisonStore } from './lib/comparison/store.mjs';
import { createComparisonRunner } from './lib/comparison/runner.mjs';
import { comparisonExecutor, handleComparisonRoute } from './lib/comparison/routes.mjs';
import { inspectModel } from './lib/llm/modelfile.mjs';
import { parseParameters, describeProvenance, applyThinking } from './lib/llm/parameters.mjs';
import { createSkillStore } from './lib/skills/store.mjs';
import { handleSkillRoute } from './lib/skills/routes.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const JSON_LIMIT = 8 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'";
const CLIENT_DIR = join(root, 'client', 'dist');

function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function error(res, status, message) { json(res, status, { error: message }); }
function requestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > JSON_LIMIT) { reject(new Error('Request body is too large.')); req.destroy(); } else body += chunk; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Request body must be JSON.')); } });
    req.on('error', reject);
  });
}
function allowedUpstream(url, allowRemoteHttp) { return url.protocol === 'https:' || isLoopbackUrl(url.toString()) || allowRemoteHttp; }
function providerHeaders(provider) {
  const headers = { accept: 'application/json', ...provider.headers };
  if (provider.auth === 'bearer' && provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  return headers;
}
function extractModels(data, provider) {
  return (data?.data || data?.models || []).map(item => ({
    id: item.id || item.name || item.model,
    ownedBy: item.owned_by || item.details?.family || '',
    context: item.context_length || item.context_window || null,
    capabilities: { tools: 'unknown', vision: 'unknown', reasoning: 'unknown' },
    source: 'live'
  })).filter(model => model.id);
}

export function createApp({ statePath, comparisonDir, fetchImpl = fetch, clientDir = CLIENT_DIR } = {}) {
  let state;
  let token = randomBytes(32).toString('base64url');
  const traces = new Map();
  let managedOllama = null;
  let comparisonStore = null;
  let comparisonRunner = null;
  let skillStore = null;

  async function persist() { await saveState(state, statePath); }
  function origin(req) { return `http://127.0.0.1:${server.address()?.port}`; }
  function trusted(req, mutate = false) {
    const expected = new URL(origin(req));
    const host = req.headers.host;
    if (host !== expected.host) return false;
    if (!mutate) return true;
    return req.headers.origin === expected.origin && req.headers['x-session-token'] === token;
  }
  function route(req) { return new URL(req.url, origin(req)); }
  function providerFor(id) { return state.providers.find(provider => provider.id === id); }
  async function upstream(provider, path, init = {}) {
    const url = new URL(appendPath(provider.baseUrl, path));
    if (!allowedUpstream(url, state.security.allowRemoteHttp)) throw new Error('Remote HTTP is disabled. Use HTTPS or enable it explicitly.');
    return fetch(url, { redirect: 'manual', ...init, headers: { ...providerHeaders(provider), ...init.headers } });
  }
  async function ollama(path, init = {}) {
    const base = state.ollama.apiBaseUrl.replace(/\/$/, '');
    const url = new URL(appendPath(base, path));
    if (!isLoopbackUrl(url.toString())) throw new Error('Ollama endpoint must be loopback-only.');
    return fetch(url, { redirect: 'manual', ...init, headers: { accept: 'application/json', ...init.headers } });
  }
  async function proxyOllama(res, path, init) {
    const response = await ollama(path, init);
    const text = await response.text();
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(text);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = route(req), path = url.pathname, mutate = !['GET', 'HEAD'].includes(req.method);
      if (!trusted(req, mutate)) return error(res, 403, 'This local server only accepts same-origin requests on 127.0.0.1 with the active session token.');
      if (comparisonRunner && await handleComparisonRoute(req, res, {
        state, store: comparisonStore, runner: comparisonRunner,
        providerFor, readBody: requestBody, fetchImpl,
        persist,
        origin: request => origin(request)
      })) return;
      if (skillStore && await handleSkillRoute(req, res, {
        state, skillStore, providerFor, readBody: requestBody, fetchImpl,
        origin: request => origin(request)
      })) return;
      if (path === '/' && req.method === 'GET') {
        const html = await readFile(join(clientDir, 'index.html'), 'utf8');
        res.writeHead(200, { 'content-type': MIME['.html'], 'content-security-policy': CSP, 'cache-control': 'no-store' });
        return res.end(html.replace('<!-- SESSION_TOKEN -->', `<meta name="session-token" content="${token}">`));
      }
      if (req.method === 'GET' && /^\/assets\/[\w.-]+\.[a-z0-9]+$/.test(path)) {
        const file = join(clientDir, path.slice(1));
        const ext = path.slice(path.lastIndexOf('.'));
        res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(await readFile(file));
      }
      if (path === '/api/state' && req.method === 'GET') return json(res, 200, publicState(state));
      if (path === '/api/state' && req.method === 'PUT') {
        const body = await requestBody(req); state.security.allowRemoteHttp = Boolean(body.security?.allowRemoteHttp); await persist(); return json(res, 200, publicState(state));
      }
      if (path === '/api/providers' && req.method === 'POST') {
        const body = await requestBody(req); const provider = validateProvider(body); state.providers.push(provider); await persist(); return json(res, 201, { ...provider, apiKey: undefined, hasApiKey: Boolean(provider.apiKey) });
      }
      const providerMatch = path.match(/^\/api\/providers\/([^/]+)(?:\/(test|models))?$/);
      if (providerMatch) {
        const provider = providerFor(decodeURIComponent(providerMatch[1])); if (!provider) return error(res, 404, 'Provider not found.');
        const action = providerMatch[2];
        if (!action && req.method === 'PUT') {
          const body = await requestBody(req); const updated = validateProvider(body, provider); Object.assign(provider, updated); await persist();
          const { apiKey, ...safe } = provider; return json(res, 200, { ...safe, hasApiKey: Boolean(apiKey) });
        }
        if (!action && req.method === 'DELETE') { state.providers = state.providers.filter(item => item.id !== provider.id); await persist(); return json(res, 200, { ok: true }); }
        if (action === 'test' && req.method === 'POST') {
          const response = await upstream(provider, 'models'); const text = await response.text(); provider.lastCheck = { at: new Date().toISOString(), ok: response.ok, status: response.status }; await persist(); return json(res, response.ok ? 200 : 502, { ok: response.ok, status: response.status, body: text.slice(0, 2000) });
        }
        if (action === 'models' && req.method === 'GET') {
          const response = await upstream(provider, 'models'); const data = await response.json().catch(() => ({})); if (!response.ok) return json(res, 502, { error: `Upstream returned ${response.status}`, detail: data }); provider.models = extractModels(data, provider); await persist(); return json(res, 200, { data: provider.models });
        }
      }
      if (path === '/api/chat' && req.method === 'POST') {
        const body = await requestBody(req), provider = providerFor(body.providerId); if (!provider) return error(res, 404, 'Provider not found.');
        if (!body.request || typeof body.request !== 'object') return error(res, 400, 'A chat request object is required.');
        const controller = new AbortController(), traceId = randomBytes(12).toString('hex'); traces.set(traceId, controller);
        const { parsed, rejected } = parseParameters(body.parameters);
        for (const [name, value] of Object.entries(parsed)) {
          if (name in body.request) continue;
          const wire = name === 'maxOutputTokens' ? 'max_tokens' : name === 'topP' ? 'top_p' : name === 'topK' ? 'top_k'
            : name === 'frequencyPenalty' ? 'frequency_penalty' : name === 'presencePenalty' ? 'presence_penalty'
            : name === 'responseFormat' ? 'response_format' : name;
          body.request[wire] = value;
        }
        applyThinking(body.request, 'chat-completions', body.thinking);
        const provenance = describeProvenance(parsed, body.thinking, rejected);
        const headers = { 'content-type': 'application/json', ...providerHeaders(provider) };
        const response = await upstream(provider, 'chat/completions', { method: 'POST', headers, body: JSON.stringify(body.request), signal: controller.signal });
        const requestTrace = { type: 'request', traceId, url: appendPath(provider.baseUrl, 'chat/completions'), headers: redactSecrets(headers), body: body.request, provenance };
        if (!body.request.stream) {
          const raw = await response.text(); traces.delete(traceId); return json(res, response.ok ? 200 : 502, { ...requestTrace, response: { status: response.status, headers: Object.fromEntries(response.headers), raw, body: (() => { try { return JSON.parse(raw); } catch { return null; } })() } });
        }
        res.writeHead(response.ok ? 200 : 502, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-trace-id': traceId });
        const send = event => res.write(`${JSON.stringify(event)}\n`); send(requestTrace);
        if (!response.ok || !response.body) { send({ type: 'error', status: response.status, message: await response.text() }); traces.delete(traceId); return res.end(); }
        try { await forwardSse(response, send); }
        catch (failure) { if (failure.name !== 'AbortError') send({ type: 'error', message: failure.message }); }
        traces.delete(traceId); return res.end();
      }
      const cancel = path.match(/^\/api\/chat\/([a-f0-9]+)\/cancel$/);
      if (cancel && req.method === 'POST') { const trace = traces.get(cancel[1]); if (trace) trace.abort(); return json(res, 200, { cancelled: Boolean(trace) }); }
      if (path === '/api/ollama/status' && req.method === 'GET') return proxyOllama(res, 'api/version');
      if (path === '/api/ollama/models' && req.method === 'GET') return proxyOllama(res, 'api/tags');
      if (path === '/api/ollama/running' && req.method === 'GET') return proxyOllama(res, 'api/ps');
      const inspectMatch = path.match(/^\/api\/providers\/([^/]+)\/model-inspection$/);
      if (inspectMatch && req.method === 'GET') {
        const provider = providerFor(decodeURIComponent(inspectMatch[1]));
        if (!provider) return error(res, 404, 'Provider not found.');
        const modelId = url.searchParams.get('modelId');
        if (!modelId) return error(res, 400, 'A model ID is required.');
        return json(res, 200, await inspectModel(provider, modelId, { fetchImpl }));
      }
      if (path === '/api/ollama/models/pull' && req.method === 'POST') { const { name } = await requestBody(req); validateModelName(name); return proxyOllama(res, 'api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, stream: false }) }); }
      if (path === '/api/ollama/models' && req.method === 'DELETE') { const { name, confirmed } = await requestBody(req); validateModelName(name); if (confirmed !== true) return error(res, 400, 'Deleting a model requires explicit confirmation.'); return proxyOllama(res, 'api/delete', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }); }
      if (path === '/api/ollama/models/stop' && req.method === 'POST') { const { name, confirmed } = await requestBody(req); validateModelName(name); if (confirmed !== true) return error(res, 400, 'Stopping a model requires explicit confirmation.'); await ollama('api/version'); return json(res, 200, await runOllama(['stop', name])); }
      if (path === '/api/ollama/process/start' && req.method === 'POST') { const { confirmed } = await requestBody(req); if (confirmed !== true) return error(res, 400, 'Starting Ollama requires explicit confirmation.'); if (!managedOllama) managedOllama = spawn('ollama', ['serve'], { shell: false, stdio: 'ignore', env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' } }); return json(res, 200, { managed: true }); }
      if (path === '/api/ollama/settings' && req.method === 'PUT') { const { settings } = await requestBody(req); state.ollama.settings = validateSettings(settings); await persist(); return json(res, 200, publicState(state).ollama); }
      if (path === '/api/ollama/settings/apply-macos' && req.method === 'POST') { const { confirmed } = await requestBody(req); if (confirmed !== true) return error(res, 400, 'Applying macOS settings requires explicit confirmation.'); if (process.platform !== 'darwin') return error(res, 400, 'macOS settings are unavailable on this platform.'); for (const args of macosEnvCommands(state.ollama.settings)) await new Promise((resolve, reject) => { const child = spawn('launchctl', args, { shell: false }); child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`launchctl exited with ${code}`))); }); return json(res, 200, { applied: true, restartRequired: true }); }
      return error(res, 404, 'Route not found.');
    } catch (caught) {
      if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
      return error(res, 400, caught.name === 'AbortError' ? 'Request cancelled.' : caught.message);
    }
  });
  return {
    async start(port = 8787) {
      state = await loadState(statePath);
      const rootPath = comparisonDir || join(dirname(statePath || defaultStatePath), 'comparisons');
      comparisonStore = await createComparisonStore(rootPath);
      await comparisonStore.recoverInterrupted();
      skillStore = await createSkillStore(join(dirname(rootPath), 'skills'));
      comparisonRunner = createComparisonRunner({
        store: comparisonStore,
        resolveProvider: async id => {
          const provider = providerFor(id);
          if (!provider) throw new Error('Selected provider was removed.');
          return { ...provider, allowRemoteHttp: state.security.allowRemoteHttp === true };
        },
        executeModel: comparisonExecutor(fetchImpl)
      });
      await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
      return server.address();
    },
    async close() {
      await comparisonRunner?.close();
      managedOllama?.kill();
      await new Promise(resolve => server.close(resolve));
    },
    get token() { return token; },
    get state() { return state; }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp(); const address = await app.start(); console.log(`LLM API Debugger listening on http://127.0.0.1:${address.port}`);
  process.on('SIGINT', async () => { await app.close(); process.exit(0); });
}
