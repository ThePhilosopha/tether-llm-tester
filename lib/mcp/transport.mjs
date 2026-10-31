// JSON-RPC 2.0 over HTTP for MCP servers. Streamable HTTP is the transport:
// one POST per request, the reply comes back either as JSON or as a single
// server-sent event. The session id the server hands back on initialize is
// echoed on every later request.

const PROTOCOL_VERSION = '2025-06-18';

export class McpError extends Error {
  constructor(message, { status = null, code = null, data = null, headers = null } = {}) {
    super(message);
    this.name = 'McpError';
    this.status = status;
    this.code = code;
    this.data = data;
    this.headers = headers;
  }
}

export function parseEventStream(text) {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try { messages.push(JSON.parse(data)); } catch { /* a partial frame is not a message */ }
  }
  return messages;
}

export function parseJsonBody(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export function buildRequest(method, params, id) {
  const payload = { jsonrpc: '2.0', method };
  if (id !== undefined && id !== null) payload.id = id;
  if (params !== undefined) payload.params = params;
  return payload;
}

export function headersFor(server, { sessionId = null, token = null, extra = {} } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(server.headers || {}),
    ...extra
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export async function rpcRequest(server, { method, params, id, sessionId = null, token = null, fetchImpl = fetch, timeoutMs = 60000 }) {
  const payload = buildRequest(method, params, id);
  const started = Date.now();
  const response = await fetchImpl(server.url, {
    method: 'POST',
    headers: headersFor(server, { sessionId, token }),
    body: JSON.stringify(payload),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  const durationMs = Date.now() - started;
  return {
    ok: response.ok,
    status: response.status,
    durationMs,
    request: payload,
    headers: Object.fromEntries(response.headers),
    raw: text,
    body: parseJsonBody(text)
  };
}

// The server may answer with a JSON body or with an event stream. Pick the
// first frame that carries the id we asked for, or the first frame at all.
export function pickMessage(result, id) {
  const candidates = [];
  if (result.body && typeof result.body === 'object') candidates.push(result.body);
  for (const message of parseEventStream(result.raw)) candidates.push(message);
  if (!candidates.length) return null;
  if (id === undefined || id === null) return candidates[0];
  return candidates.find(message => message.id === id) || candidates[0];
}

export function assertResult(result, id, label) {
  const message = pickMessage(result, id);
  if (!result.ok) {
    throw new McpError(`${label} returned HTTP ${result.status}.`, {
      status: result.status,
      headers: result.headers,
      data: result.raw.slice(0, 2000)
    });
  }
  if (!message) {
    throw new McpError(`${label} returned no JSON-RPC message.`, { status: result.status, headers: result.headers, data: result.raw.slice(0, 2000) });
  }
  if (message.error) {
    throw new McpError(`${label} failed: ${message.error.message || 'unknown error'}.`, {
      status: result.status, headers: result.headers, code: message.error.code, data: message.error.data ?? null
    });
  }
  return message.result ?? null;
}

export async function initialize(server, { fetchImpl = fetch, token = null, timeoutMs = 60000 } = {}) {
  const id = 1;
  const result = await rpcRequest(server, {
    method: 'initialize',
    id,
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'LLM Tester', version: '1.0.0' }
    },
    token,
    fetchImpl,
    timeoutMs
  });
  const negotiated = assertResult(result, id, 'initialize');
  const sessionId = result.headers['mcp-session-id'] || null;
  if (sessionId) {
    await rpcRequest(server, {
      method: 'notifications/initialized',
      sessionId,
      token,
      fetchImpl,
      timeoutMs
    });
  }
  return { serverInfo: negotiated?.serverInfo || null, capabilities: negotiated?.capabilities || {}, sessionId, result };
}

export async function listTools(server, { fetchImpl = fetch, sessionId = null, token = null, timeoutMs = 60000 } = {}) {
  const id = 2;
  const result = await rpcRequest(server, {
    method: 'tools/list', id, params: {}, sessionId, token, fetchImpl, timeoutMs
  });
  const negotiated = assertResult(result, id, 'tools/list');
  const tools = Array.isArray(negotiated?.tools) ? negotiated.tools : [];
  return {
    tools: tools.map(tool => ({
      name: String(tool.name || ''),
      title: tool.title ? String(tool.title) : '',
      description: tool.description ? String(tool.description).slice(0, 2000) : '',
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : null
    })).filter(tool => tool.name),
    raw: result
  };
}

export async function callTool(server, { name, args = {}, fetchImpl = fetch, sessionId = null, token = null, timeoutMs = 120000 }) {
  const id = 3;
  const result = await rpcRequest(server, {
    method: 'tools/call', id, params: { name, arguments: args }, sessionId, token, fetchImpl, timeoutMs
  });
  const negotiated = assertResult(result, id, `tools/call ${name}`);
  return { result: negotiated, raw: result };
}

export function describeTool(tool) {
  const properties = tool.inputSchema?.properties || {};
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
  return Object.keys(properties).map(key => ({
    name: key,
    type: properties[key]?.type || 'any',
    required: required.includes(key),
    description: String(properties[key]?.description || '').slice(0, 300)
  }));
}
