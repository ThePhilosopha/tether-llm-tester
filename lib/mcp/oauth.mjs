// OAuth 2.1 for MCP servers, in the shape the MCP authorisation spec asks
// for: the server challenges with WWW-Authenticate, the client reads the
// protected-resource metadata, registers itself dynamically, runs PKCE, and
// the browser is sent to the authorisation endpoint. Tokens stay local and
// are never written to the audit log.

import { createHash, randomBytes } from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function parseChallenge(header) {
  if (!header || typeof header !== 'string') return null;
  const bearer = header.match(/^\s*Bearer\s+(.*)$/i);
  if (!bearer) return null;
  const params = {};
  const pattern = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"|([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*([^,\s]+)/g;
  let match;
  while ((match = pattern.exec(bearer[1]))) {
    params[match[1] || match[3]] = match[2] ?? match[4] ?? '';
  }
  if (!params.resource_metadata) return null;
  return {
    realm: params.realm || '',
    scope: params.scope || '',
    resourceMetadataUrl: params.resource_metadata,
    resource: params.resource || ''
  };
}

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

export function isLoopbackRedirect(uri) {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  } catch { return false; }
}

export function redirectUri(port) {
  return `http://127.0.0.1:${port}/api/mcp/oauth/callback`;
}

export async function fetchProtectedResource(challenge, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const response = await fetchImpl(challenge.resourceMetadataUrl, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`Protected resource metadata returned HTTP ${response.status}.`);
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object') throw new Error('Protected resource metadata was not JSON.');
  return {
    resource: data.resource || challenge.resource || '',
    authorizationServers: Array.isArray(data.authorization_servers) ? data.authorization_servers : [],
    scopesSupported: Array.isArray(data.scopes_supported) ? data.scopes_supported : [],
    resourceName: data.resource_name || ''
  };
}

export async function fetchAuthorizationServerMetadata(serverUrl, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const base = new URL(serverUrl);
  const candidates = [
    new URL('/.well-known/oauth-authorization-server', base).toString(),
    new URL('/.well-known/openid-configuration', base).toString(),
    new URL('/.well-known/oauth-protected-resource', base).toString()
  ];
  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(candidate, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) continue;
      const data = await response.json().catch(() => null);
      if (!data || typeof data !== 'object') continue;
      if (data.authorization_endpoint) return { ...data, metadataUrl: candidate };
    } catch { /* try the next well-known path */ }
  }
  throw new Error(`No OAuth authorization server metadata was found at ${serverUrl}.`);
}

export async function registerClient({ authorizationServer, clientName = 'LLM Tester', redirectUri, fetchImpl = fetch, timeoutMs = 20000 }) {
  const metadata = await fetchAuthorizationServerMetadata(authorizationServer, { fetchImpl, timeoutMs });
  if (!metadata.registration_endpoint) {
    throw new Error('That authorization server does not publish a dynamic client registration endpoint.');
  }
  const body = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  };
  if (metadata.scopes_supported?.length) body.scope = metadata.scopes_supported.join(' ');
  const response = await fetchImpl(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.client_id) {
    throw new Error(`Dynamic client registration failed with HTTP ${response.status}.`);
  }
  return { clientId: data.client_id, clientSecret: data.client_secret || null, metadata };
}

export function authorizationUrl({ metadata, clientId, redirectUri, state, codeChallenge, scope, resource }) {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  if (scope) url.searchParams.set('scope', scope);
  if (resource) url.searchParams.set('resource', resource);
  return url.toString();
}

export async function exchangeCode({ metadata, clientId, clientSecret, code, redirectUri, codeVerifier, resource, fetchImpl = fetch, timeoutMs = 20000 }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier
  });
  if (resource) body.set('resource', resource);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  const response = await fetchImpl(metadata.token_endpoint, {
    method: 'POST', headers, body: body.toString(), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    throw new Error(`Token exchange failed with HTTP ${response.status}.`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: Number.isFinite(data.expires_in) ? data.expires_in : null,
    tokenType: data.token_type || 'Bearer',
    scope: data.scope || ''
  };
}

export async function refreshToken({ metadata, clientId, clientSecret, refreshToken, resource, fetchImpl = fetch, timeoutMs = 20000 }) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId
  });
  if (resource) body.set('resource', resource);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  const response = await fetchImpl(metadata.token_endpoint, {
    method: 'POST', headers, body: body.toString(), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) throw new Error(`Token refresh failed with HTTP ${response.status}.`);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: Number.isFinite(data.expires_in) ? data.expires_in : null,
    tokenType: data.token_type || 'Bearer'
  };
}
