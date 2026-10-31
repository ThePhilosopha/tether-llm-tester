import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

let upstream, app, base, upstreamBase;
const requests = [];

before(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      requests.push({ url: req.url, body });
      if (req.url === '/mcp' && body.includes('"initialize"')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-1' });
        return res.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"Fake MCP","version":"1.0"}}}\n\n');
      }
      if (req.url === '/mcp' && body.includes('"tools/list"')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search","description":"Find things","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}]}}\n\n');
      }
      if (req.url === '/mcp' && body.includes('"tools/call"')) {
        if (!body.includes('"name":"search"')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          return res.end('event: message\ndata: {"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"Unknown tool"}}\n\n');
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end('event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"found it"}]}}\n\n');
      }
      if (req.url === '/secure/mcp') {
        res.writeHead(401, { 'www-authenticate': 'Bearer realm="OAuth", resource_metadata="http://127.0.0.1/meta", scope="default"' });
        return res.end();
      }
      res.writeHead(404).end();
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), 'llm-mcp-'));
  app = createApp({ statePath: join(dir, 'state.json') });
  const address = await app.start(0);
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app.close();
  await new Promise(resolve => upstream.close(resolve));
});

const sameOrigin = (path, options = {}) => fetch(`${base}${path}`, {
  ...options,
  headers: { origin: base, 'x-session-token': app.token, 'content-type': 'application/json', ...(options.headers || {}) }
});

async function register(name, url) {
  const response = await sameOrigin('/api/mcp/servers', { method: 'POST', body: JSON.stringify({ name, url }) });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).server;
}

test('registers, discovers, calls and audits an MCP server', async () => {
  const server = await register('Fake', `${upstreamBase}/mcp`);
  const listed = await sameOrigin(`/api/mcp/servers/${server.id}/tools`);
  assert.equal(listed.status, 200);
  const { tools } = await listed.json();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'search');
  assert.deepEqual(tools[0].parameters.map(item => item.name), ['query']);

  const called = await sameOrigin(`/api/mcp/servers/${server.id}/tools/search/call`, {
    method: 'POST', body: JSON.stringify({ arguments: { query: 'hooks' } })
  });
  assert.equal(called.status, 200);
  const outcome = await called.json();
  assert.ok(Number.isFinite(outcome.durationMs));
  assert.equal(outcome.response.content[0].text, 'found it');

  const audit = await sameOrigin('/api/mcp/audit');
  const { entries } = await audit.json();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tool, 'search');
  assert.equal(entries[0].ok, true);
  assert.ok(entries[0].durationMs >= 0);
  assert.deepEqual(entries[0].request.params.arguments, { query: 'hooks' });
});

test('a failed tool call is still recorded in the audit log', async () => {
  const server = await register('Fake', `${upstreamBase}/mcp`);
  const failed = await sameOrigin(`/api/mcp/servers/${server.id}/tools/missing/call`, {
    method: 'POST', body: JSON.stringify({ arguments: {} })
  });
  assert.equal(failed.status, 502);
  const audit = await sameOrigin('/api/mcp/audit');
  const { entries } = await audit.json();
  assert.equal(entries[0].ok, false);
  assert.equal(entries[0].tool, 'missing');
});

test('an OAuth challenge is recorded and reported as needing authorisation', async () => {
  const server = await register('Secure', `${upstreamBase}/secure/mcp`);
  const response = await sameOrigin(`/api/mcp/servers/${server.id}/connect`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.match(body.error, /OAuth/);
  assert.ok(body.authorizeUrl.endsWith('/authorize'));
  const list = await sameOrigin('/api/mcp/servers');
  const { servers } = await list.json();
  const stored = servers.find(item => item.id === server.id);
  assert.equal(stored.oauth.status, 'challenge');
  assert.equal(stored.oauth.hasToken, false);
});

test('the registry rejects a plain HTTP URL for a remote host and unknown tools', async () => {
  const rejected = await sameOrigin('/api/mcp/servers', { method: 'POST', body: JSON.stringify({ name: 'Plain', url: 'http://example.test/mcp' }) });
  assert.equal(rejected.status, 400);
  const missing = await sameOrigin('/api/mcp/servers/does-not-exist/tools');
  assert.equal(missing.status, 404);
});

test('a removed server disappears from the registry', async () => {
  const server = await register('Temporary', `${upstreamBase}/mcp`);
  const removed = await sameOrigin(`/api/mcp/servers/${server.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const list = await sameOrigin('/api/mcp/servers');
  const { servers } = await list.json();
  assert.equal(servers.some(item => item.id === server.id), false);
});

test('MCP mutations need the same-origin session token', async () => {
  const response = await fetch(`${base}/api/mcp/servers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ name: 'No token', url: `${upstreamBase}/mcp` })
  });
  assert.equal(response.status, 403);
  const crossOrigin = await fetch(`${base}/api/mcp/servers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.test', 'x-session-token': app.token },
    body: JSON.stringify({ name: 'Cross origin', url: `${upstreamBase}/mcp` })
  });
  assert.equal(crossOrigin.status, 403);
});
