// MCP server registry, discovery, tool execution and the audit log.
//
// Routes:
//   GET    /api/mcp/servers
//   POST   /api/mcp/servers
//   DELETE /api/mcp/servers/:id
//   POST   /api/mcp/servers/:id/connect
//   GET    /api/mcp/servers/:id/tools
//   POST   /api/mcp/servers/:id/tools/:name/call
//   GET    /api/mcp/servers/:id/authorize
//   GET    /api/mcp/oauth/callback
//   GET    /api/mcp/audit

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redactSecrets } from '../util.mjs';
import { callTool, describeTool, initialize, listTools } from './transport.mjs';
import {
  authorizationUrl, exchangeCode, fetchProtectedResource, parseChallenge, pkcePair, redirectUri, registerClient
} from './oauth.mjs';

const MAX_AUDIT_ENTRIES = 200;
const MAX_AUDIT_BYTES = 4 * 1024 * 1024;

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function validateServer(value, existing = {}) {
  if (!value || typeof value !== 'object') throw new Error('An MCP server must be an object.');
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 80) throw new Error('An MCP server name is required and must be 80 characters or fewer.');
  const raw = typeof value.url === 'string' ? value.url.trim() : '';
  if (!raw) throw new Error('An MCP server URL is required.');
  let url;
  try { url = new URL(raw); } catch { throw new Error('The MCP server URL must be a valid URL.'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('The MCP server URL must use HTTP or HTTPS.');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('A remote MCP server must use HTTPS.');
  }
  const headers = value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers) ? value.headers : {};
  for (const [key, header] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof header !== 'string') {
      throw new Error('MCP server headers must be valid HTTP header pairs.');
    }
  }
  return {
    id: existing.id || value.id || randomUUID(),
    name,
    url: raw,
    headers,
    auth: existing.auth || 'none',
    toolCount: existing.toolCount || 0,
    lastCheckedAt: existing.lastCheckedAt || null,
    lastError: existing.lastError || null,
    oauth: existing.oauth || null,
    createdAt: existing.createdAt || new Date().toISOString()
  };
}

export async function createMcpAuditStore(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let entries = [];
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (Array.isArray(data?.entries)) entries = data.entries;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read the MCP audit log: ${error.message}`);
  }

  async function persist() {
    let text = `${JSON.stringify({ entries }, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_AUDIT_BYTES) {
      text = `${JSON.stringify({ entries: entries.slice(0, 20) }, null, 2)}\n`;
    }
    await writeFile(path, text, { mode: 0o600 });
  }

  return {
    async list() { return entries.slice(); },
    async record(entry) {
      entries.unshift(entry);
      if (entries.length > MAX_AUDIT_ENTRIES) entries = entries.slice(0, MAX_AUDIT_ENTRIES);
      await persist();
      return entry;
    }
  };
}

// A server that needs OAuth keeps its state until the browser comes back.
export function createMcpAuthStore() {
  const pending = new Map();
  return {
    set(key, value) { pending.set(key, value); },
    take(key) { const value = pending.get(key); pending.delete(key); return value || null; },
    get(key) { return pending.get(key) || null; },
    has(key) { return pending.has(key); }
  };
}

function publicServer(server) {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    auth: server.auth,
    toolCount: server.toolCount || 0,
    lastCheckedAt: server.lastCheckedAt || null,
    lastError: server.lastError || null,
    oauth: server.oauth
      ? {
        status: server.oauth.status,
        authorizationServer: server.oauth.authorizationServer || null,
        resource: server.oauth.resource || null,
        scopesSupported: server.oauth.scopesSupported || [],
        resourceName: server.oauth.resourceName || '',
        registered: Boolean(server.oauth.clientId),
        hasToken: Boolean(server.oauth.accessToken)
      }
      : null
  };
}

async function discover(server, context) {
  const token = server.oauth?.accessToken || null;
  const negotiated = await initialize(server, { fetchImpl: context.fetchImpl, token });
  const listed = await listTools(server, {
    fetchImpl: context.fetchImpl,
    sessionId: negotiated.sessionId,
    token
  });
  return { negotiated, tools: listed.tools };
}

export async function handleMcpRoute(req, res, context) {
  const { pathname, searchParams } = new URL(req.url, context.origin(req));
  const method = req.method;

  if (pathname === '/api/mcp/servers' && method === 'GET') {
    return send(res, 200, { servers: context.servers.map(publicServer) }), true;
  }

  if (pathname === '/api/mcp/servers' && method === 'POST') {
    const body = await context.readBody(req);
    const server = validateServer(body);
    context.servers.push(server);
    await context.persist();
    return send(res, 201, { server: publicServer(server) }), true;
  }

  if (pathname === '/api/mcp/audit' && method === 'GET') {
    return send(res, 200, { entries: await context.audit.list() }), true;
  }

  const serverMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)$/);
  if (serverMatch && method === 'DELETE') {
    const id = decodeURIComponent(serverMatch[1]);
    const index = context.servers.findIndex(item => item.id === id);
    if (index < 0) return send(res, 404, { error: 'MCP server not found.' }), true;
    context.servers.splice(index, 1);
    await context.persist();
    return send(res, 200, { ok: true }), true;
  }

  const connectMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/connect$/);
  if (connectMatch && method === 'POST') {
    const id = decodeURIComponent(connectMatch[1]);
    const server = context.servers.find(item => item.id === id);
    if (!server) return send(res, 404, { error: 'MCP server not found.' }), true;
    try {
      const { negotiated, tools } = await discover(server, context);
      server.toolCount = tools.length;
      server.lastCheckedAt = new Date().toISOString();
      server.lastError = null;
      server.serverInfo = negotiated.serverInfo || null;
      server.capabilities = negotiated.capabilities || {};
      await context.persist();
      return send(res, 200, {
        server: publicServer(server),
        serverInfo: negotiated.serverInfo || null,
        tools: tools.map(tool => ({ ...tool, parameters: describeTool(tool) }))
      }), true;
    } catch (caught) {
      server.lastCheckedAt = new Date().toISOString();
      server.lastError = caught.message;
      await context.persist();
      if (caught.status === 401) {
        const challenge = parseChallenge(caught.headers?.['www-authenticate'] || '');
        if (challenge) {
          const resource = await fetchProtectedResource(challenge, { fetchImpl: context.fetchImpl }).catch(() => null);
          server.auth = 'oauth';
          server.oauth = {
            status: 'challenge',
            resourceMetadataUrl: challenge.resourceMetadataUrl,
            resource: resource?.resource || challenge.resource || '',
            authorizationServer: resource?.authorizationServers?.[0] || '',
            scopesSupported: resource?.scopesSupported || [],
            resourceName: resource?.resourceName || ''
          };
          await context.persist();
          return send(res, 401, {
            error: 'That MCP server needs OAuth authorisation.',
            oauth: publicServer(server).oauth,
            serverId: server.id,
            authorizeUrl: `/api/mcp/servers/${encodeURIComponent(server.id)}/authorize`
          }), true;
        }
      }
      return send(res, 502, { error: caught.message }), true;
    }
  }

  const toolsMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/tools$/);
  if (toolsMatch && method === 'GET') {
    const server = context.servers.find(item => item.id === decodeURIComponent(toolsMatch[1]));
    if (!server) return send(res, 404, { error: 'MCP server not found.' }), true;
    try {
      const { negotiated, tools } = await discover(server, context);
      server.toolCount = tools.length;
      server.lastCheckedAt = new Date().toISOString();
      server.lastError = null;
      server.serverInfo = negotiated.serverInfo || null;
      await context.persist();
      return send(res, 200, { tools: tools.map(tool => ({ ...tool, parameters: describeTool(tool) })) }), true;
    } catch (caught) {
      server.lastCheckedAt = new Date().toISOString();
      server.lastError = caught.message;
      await context.persist();
      return send(res, 502, { error: caught.message }), true;
    }
  }

  const callMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/tools\/([^/]+)\/call$/);
  if (callMatch && method === 'POST') {
    const server = context.servers.find(item => item.id === decodeURIComponent(callMatch[1]));
    if (!server) return send(res, 404, { error: 'MCP server not found.' }), true;
    const name = decodeURIComponent(callMatch[2]);
    const body = await context.readBody(req);
    const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
      ? body.arguments
      : {};
    const started = Date.now();
    try {
      const negotiated = await initialize(server, { fetchImpl: context.fetchImpl, token: server.oauth?.accessToken || null });
      const outcome = await callTool(server, {
        name,
        args,
        fetchImpl: context.fetchImpl,
        sessionId: negotiated.sessionId,
        token: server.oauth?.accessToken || null
      });
      const durationMs = Date.now() - started;
      const entry = await context.audit.record({
        id: randomUUID(),
        at: new Date().toISOString(),
        serverId: server.id,
        serverName: server.name,
        tool: name,
        ok: true,
        durationMs,
        request: { method: 'tools/call', params: { name, arguments: args } },
        response: redactSecrets(outcome.result),
        raw: outcome.raw.raw.slice(0, 20000),
        status: outcome.raw.status
      });
      return send(res, 200, { durationMs, response: outcome.result, auditId: entry.id }), true;
    } catch (caught) {
      const durationMs = Date.now() - started;
      await context.audit.record({
        id: randomUUID(),
        at: new Date().toISOString(),
        serverId: server.id,
        serverName: server.name,
        tool: name,
        ok: false,
        durationMs,
        request: { method: 'tools/call', params: { name, arguments: args } },
        error: caught.message,
        status: caught.status ?? null,
        code: caught.code ?? null
      });
      return send(res, 502, { error: caught.message, durationMs }), true;
    }
  }

  const authorizeMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/authorize$/);
  if (authorizeMatch && method === 'POST') {
    const server = context.servers.find(item => item.id === decodeURIComponent(authorizeMatch[1]));
    if (!server) return send(res, 404, { error: 'MCP server not found.' }), true;
    if (!server.oauth?.authorizationServer) {
      return send(res, 409, { error: 'That MCP server has not issued an OAuth challenge yet. Connect it first.' }), true;
    }
    const redirect = redirectUri(context.port);
    const registration = await registerClient({
      authorizationServer: server.oauth.authorizationServer,
      redirectUri: redirect,
      fetchImpl: context.fetchImpl
    });
    const pair = pkcePair();
    const state = randomUUID();
    server.oauth.status = 'awaiting-authorization';
    server.oauth.clientId = registration.clientId;
    server.oauth.clientSecret = registration.clientSecret;
    server.oauth.metadata = registration.metadata;
    server.oauth.scopesSupported = registration.metadata.scopes_supported || server.oauth.scopesSupported;
    await context.persist();
    context.auth.set(state, {
      serverId: server.id,
      codeVerifier: pair.verifier,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      metadata: registration.metadata,
      redirectUri: redirect,
      resource: server.oauth.resource || server.url
    });
    const url = authorizationUrl({
      metadata: registration.metadata,
      clientId: registration.clientId,
      redirectUri: redirect,
      state,
      codeChallenge: pair.challenge,
      scope: (server.oauth.scopesSupported || []).join(' '),
      resource: server.oauth.resource || server.url
    });
    return send(res, 200, { authorizationUrl: url, state, serverId: server.id }), true;
  }

  if (pathname === '/api/mcp/oauth/callback' && method === 'GET') {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const oauthError = searchParams.get('error');
    const pending = state ? context.auth.take(state) : null;
    if (oauthError) return send(res, 400, { error: `The authorisation server refused the request: ${oauthError}.` }), true;
    if (!code || !pending) return send(res, 400, { error: 'The authorisation callback was incomplete or has expired.' }), true;
    const server = context.servers.find(item => item.id === pending.serverId);
    if (!server) return send(res, 404, { error: 'MCP server not found.' }), true;
    const token = await exchangeCode({
      metadata: pending.metadata,
      clientId: pending.clientId,
      clientSecret: pending.clientSecret,
      code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier,
      resource: pending.resource,
      fetchImpl: context.fetchImpl
    });
    server.oauth.status = 'authorised';
    server.oauth.accessToken = token.accessToken;
    server.oauth.refreshToken = token.refreshToken;
    server.oauth.expiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
    server.oauth.scope = token.scope;
    await context.persist();
    return send(res, 200, { ok: true, serverId: server.id, server: publicServer(server) }), true;
  }

  return false;
}
