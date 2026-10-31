import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authorizationUrl, exchangeCode, fetchProtectedResource, isLoopbackRedirect, parseChallenge, pkcePair, registerClient
} from '../lib/mcp/oauth.mjs';

test('reads the resource metadata out of a WWW-Authenticate challenge', () => {
  const challenge = parseChallenge('Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", scope="default"');
  assert.equal(challenge.realm, 'OAuth');
  assert.equal(challenge.resourceMetadataUrl, 'https://mcp.notion.com/.well-known/oauth-protected-resource/mcp');
  assert.equal(challenge.scope, 'default');
});

test('a challenge without resource metadata is not an OAuth challenge', () => {
  assert.equal(parseChallenge('Bearer realm="OAuth"'), null);
  assert.equal(parseChallenge('Basic realm="x"'), null);
  assert.equal(parseChallenge(null), null);
});

test('the protected resource metadata names the authorisation server and the scopes', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    resource: 'https://mcp.notion.com/mcp',
    authorization_servers: ['https://mcp.notion.com'],
    scopes_supported: ['default'],
    resource_name: 'Notion MCP (Beta)'
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const resource = await fetchProtectedResource({ resourceMetadataUrl: 'https://mcp.notion.com/meta' }, { fetchImpl });
  assert.equal(resource.authorizationServers[0], 'https://mcp.notion.com');
  assert.deepEqual(resource.scopesSupported, ['default']);
  assert.equal(resource.resourceName, 'Notion MCP (Beta)');
});

test('the PKCE pair is a SHA-256 challenge over a fresh verifier', () => {
  const pair = pkcePair();
  assert.equal(pair.method, 'S256');
  assert.ok(pair.verifier.length >= 43);
  assert.ok(!pair.challenge.includes('+') && !pair.challenge.includes('/'));
  assert.notEqual(pkcePair().verifier, pair.verifier);
});

test('only a loopback redirect is allowed for the local callback', () => {
  assert.equal(isLoopbackRedirect('http://127.0.0.1:8787/api/mcp/oauth/callback'), true);
  assert.equal(isLoopbackRedirect('http://localhost:8787/cb'), true);
  assert.equal(isLoopbackRedirect('https://127.0.0.1/cb'), false);
  assert.equal(isLoopbackRedirect('https://evil.test/cb'), false);
  assert.equal(isLoopbackRedirect('not a url'), false);
});

test('dynamic client registration posts the redirect and grant types', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    if (url.includes('oauth-authorization-server')) {
      return new Response(JSON.stringify({
        authorization_endpoint: 'https://auth.test/authorize',
        token_endpoint: 'https://auth.test/token',
        registration_endpoint: 'https://auth.test/register',
        scopes_supported: ['default']
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    seen = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ client_id: 'client-123', client_secret: 'shh' }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const registration = await registerClient({
    authorizationServer: 'https://auth.test',
    redirectUri: 'http://127.0.0.1:8787/api/mcp/oauth/callback',
    fetchImpl
  });
  assert.equal(registration.clientId, 'client-123');
  assert.equal(seen.url, 'https://auth.test/register');
  assert.deepEqual(seen.body.redirect_uris, ['http://127.0.0.1:8787/api/mcp/oauth/callback']);
  assert.equal(seen.body.response_types[0], 'code');
});

test('the authorisation URL carries the PKCE challenge and the state', () => {
  const url = new URL(authorizationUrl({
    metadata: { authorization_endpoint: 'https://auth.test/authorize' },
    clientId: 'client-123',
    redirectUri: 'http://127.0.0.1:8787/api/mcp/oauth/callback',
    state: 'state-1',
    codeChallenge: 'challenge-1',
    scope: 'default',
    resource: 'https://mcp.notion.com/mcp'
  }));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-1');
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.equal(url.searchParams.get('resource'), 'https://mcp.notion.com/mcp');
});

test('the token exchange posts the code and the verifier', async () => {
  let seen = null;
  const fetchImpl = async (_url, init) => {
    seen = new URLSearchParams(init.body);
    return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const token = await exchangeCode({
    metadata: { token_endpoint: 'https://auth.test/token' },
    clientId: 'client-123', code: 'code-1',
    redirectUri: 'http://127.0.0.1:8787/api/mcp/oauth/callback',
    codeVerifier: 'verifier-1', resource: 'https://mcp.notion.com/mcp', fetchImpl
  });
  assert.equal(token.accessToken, 'at-1');
  assert.equal(token.refreshToken, 'rt-1');
  assert.equal(seen.get('grant_type'), 'authorization_code');
  assert.equal(seen.get('code_verifier'), 'verifier-1');
});
