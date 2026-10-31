import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { parseSseFrame } from '../lib/sse.mjs';
import { validateModelName } from '../lib/ollama.mjs';

let upstream, app, base, upstreamBase, statePath;
before(async () => {
  upstream = createServer((req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fake-1', owned_by: 'test' }] }));
    if (req.url === '/v1/chat/completions') {
      let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
        const request = JSON.parse(body); assert.equal(req.headers.authorization, 'Bearer secret');
        if (!request.stream) return res.end(JSON.stringify({ choices: [{ message: { content: 'plain reply' } }] }));
        if (request.model === 'slow') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
          setTimeout(() => { if (!res.destroyed) res.end('data: [DONE]\n\n'); }, 5000);
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"hello ","tool_calls":[{"index":0,"function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}\n\n');
        res.end('data: {"choices":[{"delta":{"content":"world","tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"stop"}],"usage":{"total_tokens":3}}\n\ndata: [DONE]\n\n');
      }); return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1`;
  const dir = await mkdtemp(join(tmpdir(), 'tether-llm-tester-')); statePath = join(dir, 'state.json');
  app = createApp({ statePath }); const address = await app.start(0); base = `http://127.0.0.1:${address.port}`;
});
after(async () => { await app.close(); await new Promise(resolve => upstream.close(resolve)); });
const sameOrigin = (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { origin: base, 'x-session-token': app.token, 'content-type': 'application/json', ...(options.headers || {}) } });

test('state is private on disk and public state masks keys', async () => {
  const state = await fetch(`${base}/api/state`).then(response => response.json());
  assert.equal(state.providers[0].apiKey, undefined); assert.equal(state.providers[0].hasApiKey, false);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

test('provider lifecycle discovers models and rejects cross-origin mutations', async () => {
  const forbidden = await fetch(`${base}/api/providers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(forbidden.status, 403);
  const provider = await sameOrigin('/api/providers', { method: 'POST', body: JSON.stringify({ presetId:'custom', name:'Fake', baseUrl:upstreamBase, auth:'bearer', apiKey:'secret', headers:{} }) }).then(response => response.json());
  const models = await fetch(`${base}/api/providers/${provider.id}/models`).then(response => response.json());
  assert.deepEqual(models.data.map(model => model.id), ['fake-1']);
});

test('chat proxy masks secrets and preserves streaming frames', async () => {
  const provider = app.state.providers.find(item => item.name === 'Fake');
  const payload = { providerId:provider.id, request:{model:'fake-1',messages:[{role:'user',content:'hi'}],stream:true,stream_options:{include_usage:true}} };
  const streamed = await sameOrigin('/api/chat', { method:'POST', body:JSON.stringify(payload) });
  const events = (await streamed.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].headers.authorization, '••••••••');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'hello world');
  assert.match(events.filter(event => event.type === 'raw').map(event => event.data).join(''), /\[DONE\]/);
  const plain = await sameOrigin('/api/chat', { method:'POST', body:JSON.stringify({ providerId:provider.id, request:{model:'fake-1',messages:[],stream:false} }) }).then(response => response.json());
  assert.equal(plain.response.body.choices[0].message.content, 'plain reply');
  assert.equal(parseSseFrame('data: [DONE]'), null); assert.throws(() => validateModelName('bad model'), /Model names/);
});
test('cancelling a live chat stream ends that request without killing the server', async () => {
  const provider = app.state.providers.find(item => item.name === 'Fake');
  const streamed = await sameOrigin('/api/chat', { method: 'POST', body: JSON.stringify({ providerId: provider.id, request: { model: 'slow', messages: [{ role: 'user', content: 'hi' }], stream: true } }) });
  const reader = streamed.body.getReader();
  await reader.read();
  const cancel = await sameOrigin(`/api/chat/${streamed.headers.get('x-trace-id')}/cancel`, { method: 'POST', body: '{}' });
  assert.equal(cancel.status, 200);
  // A crashed handler leaves this body open forever, so probe the server instead of draining.
  const alive = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(3000) });
  assert.equal(alive.status, 200);
  await reader.cancel().catch(() => {});
});

test('Ollama command boundaries reject unsafe model names before command execution', async () => {
  const response = await sameOrigin('/api/ollama/models/stop', { method: 'POST', body: JSON.stringify({ name: 'bad model', confirmed: true }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Model names/);
});
