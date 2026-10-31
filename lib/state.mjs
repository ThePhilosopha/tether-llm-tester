import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const PRESETS = {
  ollama: { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', auth: 'none', capability: 'yes' },
  'ollama-cloud': { name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', auth: 'bearer', capability: 'unknown' },
  '9router': { name: '9Router', baseUrl: 'http://127.0.0.1:20128/v1', auth: 'bearer', capability: 'unknown' },
  poolside: { name: 'Poolside', baseUrl: 'https://inference.poolside.ai/v1', auth: 'bearer', capability: 'unknown' },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', auth: 'bearer', capability: 'unknown' },
  'opencode-zen': { name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', auth: 'bearer', capability: 'unknown' },
  'opencode-go': { name: 'OpenCode Go', baseUrl: 'https://opencode.ai/inference/go/v1', auth: 'bearer', capability: 'unknown' },
  clinepass: { name: 'ClinePass', baseUrl: 'https://api.cline.bot/api/v1', auth: 'bearer', capability: 'unknown' },
  custom: { name: 'Custom', baseUrl: 'https://', auth: 'bearer', capability: 'unknown' }
};

export const defaultStatePath = join(homedir(), 'Library', 'Application Support', 'LLM Tester', 'state.json');

export function defaultState() {
  return {
    version: 1,
    security: { allowRemoteHttp: false },
    providers: [makeProvider('ollama')],
    mcpServers: [],
    ollama: { apiBaseUrl: 'http://127.0.0.1:11434', settings: {} }
  };
}

export function makeProvider(presetId = 'custom', values = {}) {
  const preset = PRESETS[presetId] || PRESETS.custom;
  return {
    id: values.id || randomUUID(), presetId,
    name: values.name || preset.name,
    baseUrl: values.baseUrl || preset.baseUrl,
    auth: values.auth || preset.auth,
    apiKey: values.apiKey || '',
    headers: values.headers && typeof values.headers === 'object' ? values.headers : {},
    models: Array.isArray(values.models) ? values.models : [],
    comparisonModels: values.comparisonModels && typeof values.comparisonModels === 'object' && !Array.isArray(values.comparisonModels) ? values.comparisonModels : {},
    lastCheck: values.lastCheck || null
  };
}

export function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  } catch { return false; }
}

export function validateProvider(value, existing = {}) {
  if (!value || typeof value !== 'object') throw new Error('Provider must be an object.');
  const presetId = PRESETS[value.presetId] ? value.presetId : 'custom';
  const provider = makeProvider(presetId, { ...existing, ...value, id: existing.id || value.id });
  if (!provider.name.trim() || provider.name.length > 80) throw new Error('Provider name is required and must be 80 characters or fewer.');
  let url;
  try { url = new URL(provider.baseUrl); } catch { throw new Error('Provider base URL must be a valid URL.'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Provider URL must use HTTP or HTTPS.');
  provider.baseUrl = provider.baseUrl.replace(/\/$/, '');
  for (const [key, header] of Object.entries(provider.headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof header !== 'string') throw new Error('Provider headers must be valid HTTP header pairs.');
  }
  return provider;
}

export function publicState(state) {
  return {
    ...state,
    providers: state.providers.map(({ apiKey, ...provider }) => ({ ...provider, hasApiKey: Boolean(apiKey) })),
    mcpServers: (state.mcpServers || []).map(server => ({
      ...server,
      oauth: server.oauth
        ? { ...server.oauth, accessToken: undefined, refreshToken: undefined, clientSecret: undefined, hasToken: Boolean(server.oauth.accessToken) }
        : null
    }))
  };
}

export async function loadState(path = defaultStatePath) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (state?.version === 1 && Array.isArray(state.providers)) {
      if (!Array.isArray(state.mcpServers)) state.mcpServers = [];
      return state;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read state file: ${error.message}`);
  }
  const state = defaultState();
  await saveState(state, path);
  return state;
}

export async function saveState(state, path = defaultStatePath) {
  const folder = dirname(path);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}
