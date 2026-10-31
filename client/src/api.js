const apiToken = () => document.querySelector('meta[name="session-token"]')?.content || '';

async function request(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, {
    method,
    signal,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      'x-session-token': apiToken()
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = new Error(data.error || `Request failed (${response.status})`);
    if (data.authorizeUrl) failure.authorizeUrl = data.authorizeUrl;
    if (data.oauth) failure.oauth = data.oauth;
    throw failure;
  }
  return data;
}

export const api = {
  state: () => request('/api/state'),
  setRemoteHttp: (allowRemoteHttp) => request('/api/state', { method: 'PUT', body: { security: { allowRemoteHttp } } }),
  createProvider: (provider) => request('/api/providers', { method: 'POST', body: provider }),
  updateProvider: (id, provider) => request(`/api/providers/${encodeURIComponent(id)}`, { method: 'PUT', body: provider }),
  deleteProvider: (id) => request(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testProvider: (id) => request(`/api/providers/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} }),
  models: (providerId) => request(`/api/providers/${encodeURIComponent(providerId)}/models`),
  inspect: (providerId, modelId) =>
    request(`/api/providers/${encodeURIComponent(providerId)}/model-inspection?modelId=${encodeURIComponent(modelId)}`),

  chat: (payload, signal) => request('/api/chat', { method: 'POST', body: payload, signal }),
  cancelChat: (traceId) => request(`/api/chat/${traceId}/cancel`, { method: 'POST', body: {} }),

  ollamaStatus: () => request('/api/ollama/status'),
  ollamaModels: () => request('/api/ollama/models'),
  ollamaRunning: () => request('/api/ollama/running'),
  ollamaPull: (name) => request('/api/ollama/models/pull', { method: 'POST', body: { name } }),
  ollamaDelete: (name) => request('/api/ollama/models', { method: 'DELETE', body: { name, confirmed: true } }),
  ollamaStop: (name) => request('/api/ollama/models/stop', { method: 'POST', body: { name, confirmed: true } }),
  ollamaStart: () => request('/api/ollama/process/start', { method: 'POST', body: { confirmed: true } }),
  ollamaSettings: (settings) => request('/api/ollama/settings', { method: 'PUT', body: { settings } }),

  comparisonModels: (providerId) => request(`/api/comparison/models?providerId=${encodeURIComponent(providerId)}`),
  saveMapping: (body) => request('/api/comparison/model-mapping', { method: 'POST', body }),
  preflight: (input) => request('/api/comparisons/preflight', { method: 'POST', body: { input } }),
  startComparison: (body) => request('/api/comparisons', { method: 'POST', body }),
  listComparisons: () => request('/api/comparisons'),
  comparison: (id) => request(`/api/comparisons/${encodeURIComponent(id)}`),
  comparisonReport: (id) => request(`/api/comparisons/${encodeURIComponent(id)}/report`),
  cancelComparison: (id, side = 'both') => request(`/api/comparisons/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { side } }),
  assess: (id, body) => request(`/api/comparisons/${encodeURIComponent(id)}/assessment`, { method: 'POST', body }),
  assessPair: (id, body) => request(`/api/comparisons/${encodeURIComponent(id)}/pair-assessment`, { method: 'POST', body }),
  verdict: (id, body) => request(`/api/comparisons/${encodeURIComponent(id)}/verdict`, { method: 'POST', body }),
  cases: () => request('/api/comparison/cases'),
  saveCase: (body) => request('/api/comparison/cases', { method: 'POST', body }),

  skills: () => request('/api/skills'),
  importableSkills: () => request('/api/skills/import'),
  importSkill: (body) => request('/api/skills/import', { method: 'POST', body }),
  skill: (slug) => request(`/api/skills/${encodeURIComponent(slug)}`),
  saveSkill: (slug, source) => request(`/api/skills/${encodeURIComponent(slug)}`, { method: 'PUT', body: { source } }),
  explainSkill: (slug, body) => request(`/api/skills/${encodeURIComponent(slug)}/explain`, { method: 'POST', body }),
  runSkill: (slug, body) => request(`/api/skills/${encodeURIComponent(slug)}/run`, { method: 'POST', body }),

  mcpServers: () => request('/api/mcp/servers'),
  addMcpServer: (body) => request('/api/mcp/servers', { method: 'POST', body }),
  deleteMcpServer: (id) => request(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  connectMcpServer: (id) => request(`/api/mcp/servers/${encodeURIComponent(id)}/connect`, { method: 'POST', body: {} }),
  mcpTools: (id) => request(`/api/mcp/servers/${encodeURIComponent(id)}/tools`),
  callMcpTool: (id, name, args) => request(`/api/mcp/servers/${encodeURIComponent(id)}/tools/${encodeURIComponent(name)}/call`, { method: 'POST', body: { arguments: args } }),
  authorizeMcpServer: (id) => request(`/api/mcp/servers/${encodeURIComponent(id)}/authorize`, { method: 'POST', body: {} }),
  mcpAudit: () => request('/api/mcp/audit')
};

export async function streamNdjson(url, options, onEvent) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-session-token': apiToken(), ...(options?.headers || {}) },
    body: options?.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

export default api;
