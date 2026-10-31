import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertResult, buildRequest, describeTool, headersFor, initialize, listTools, McpError, parseEventStream, pickMessage
} from '../lib/mcp/transport.mjs';

test('parses a server-sent event stream into JSON-RPC messages', () => {
  const stream = [
    'event: message',
    'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0","id":2,"result":{"second":true}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');
  const messages = parseEventStream(stream);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, 1);
  assert.equal(messages[1].result.second, true);
});

test('a JSON body and an event stream both resolve to the same message', () => {
  const asJson = { body: { jsonrpc: '2.0', id: 7, result: { value: 1 } }, raw: '' };
  const asStream = { body: null, raw: 'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"value":1}}\n\n' };
  assert.equal(pickMessage(asJson, 7).result.value, 1);
  assert.equal(pickMessage(asStream, 7).result.value, 1);
});

test('an HTTP failure raises with the status and the response headers', () => {
  const result = { ok: false, status: 401, raw: '', body: null, headers: { 'www-authenticate': 'Bearer resource_metadata="https://example.test/meta"' } };
  assert.throws(() => assertResult(result, 1, 'initialize'), (error) => {
    assert.ok(error instanceof McpError);
    assert.equal(error.status, 401);
    assert.equal(error.headers['www-authenticate'].includes('resource_metadata'), true);
    return true;
  });
});

test('a JSON-RPC error is reported with its code', () => {
  const result = { ok: true, status: 200, raw: '', body: { jsonrpc: '2.0', id: 1, error: { message: 'Unknown tool', code: -32601 } }, headers: {} };
  assert.throws(() => assertResult(result, 1, 'tools/call nope'), /Unknown tool/);
});

test('the request body carries the JSON-RPC envelope', () => {
  const payload = buildRequest('tools/list', {}, 2);
  assert.deepEqual(payload, { jsonrpc: '2.0', method: 'tools/list', id: 2, params: {} });
  const notification = buildRequest('notifications/initialized');
  assert.equal(notification.id, undefined);
});

test('the session id and the token ride on the request headers', () => {
  const headers = headersFor({ headers: { 'x-trace': 'abc' } }, { sessionId: 'sid-1', token: 'secret-token' });
  assert.equal(headers['mcp-session-id'], 'sid-1');
  assert.equal(headers.authorization, 'Bearer secret-token');
  assert.equal(headers['x-trace'], 'abc');
});

test('initialize then tools/list reads the streamed replies', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    if (init.body.includes('initialize')) {
      return new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"Fake"}}}\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sid-9' }
      });
    }
    return new Response('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search","description":"Find things","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}]}}\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' }
    });
  };
  const server = { url: 'https://fake.test/mcp' };
  const negotiated = await initialize(server, { fetchImpl });
  assert.equal(negotiated.serverInfo.name, 'Fake');
  assert.equal(negotiated.sessionId, 'sid-9');
  const listed = await listTools(server, { fetchImpl, sessionId: negotiated.sessionId });
  assert.equal(listed.tools.length, 1);
  assert.equal(listed.tools[0].name, 'search');
  assert.equal(calls[1].method, 'notifications/initialized');
  assert.equal(calls[2].method, 'tools/list');
});

test('the parameter list comes from the tool input schema', () => {
  const parameters = describeTool({
    name: 'search',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }
  });
  assert.deepEqual(parameters.map(item => item.name), ['query', 'limit']);
  assert.equal(parameters[0].required, true);
  assert.equal(parameters[1].required, false);
});
