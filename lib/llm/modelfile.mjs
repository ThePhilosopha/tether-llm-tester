const NATIVE_PRESETS = new Set(['ollama', 'ollama-cloud']);

export function nativeOrigin(baseUrl) {
  return new URL(baseUrl).origin;
}

export function publishesInternals(provider) {
  return NATIVE_PRESETS.has(provider?.presetId);
}

function evidence(present) {
  return present ? 'published' : 'not-published';
}

export async function inspectModel(provider, modelId, { fetchImpl = fetch } = {}) {
  if (typeof modelId !== 'string' || !modelId) throw new Error('A model ID is required.');
  const result = {
    providerId: provider.id, modelId, source: 'ollama-native', capturedAt: new Date().toISOString(),
    fields: {}, gaps: []
  };
  if (!publishesInternals(provider)) {
    result.source = 'none';
    result.gaps = [
      `${provider.name} does not publish a Modelfile.`,
      'Model internals are only available from providers that serve the native Ollama API.'
    ];
    return result;
  }
  const headers = { accept: 'application/json', 'content-type': 'application/json', ...(provider.headers || {}) };
  if (provider.auth === 'bearer' && provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const response = await fetchImpl(`${nativeOrigin(provider.baseUrl)}/api/show`, {
    method: 'POST', headers, body: JSON.stringify({ model: modelId }), redirect: 'manual'
  });
  if (!response.ok) {
    result.source = 'none';
    result.gaps = [`${provider.name} returned HTTP ${response.status} for model details.`];
    return result;
  }
  const data = await response.json();
  result.fields = {
    modelfile: typeof data.modelfile === 'string' ? data.modelfile : null,
    template: typeof data.template === 'string' ? data.template : null,
    system: typeof data.system === 'string' ? data.system : null,
    parameters: typeof data.parameters === 'string' ? data.parameters : null,
    license: typeof data.license === 'string' ? data.license : null,
    details: data.details || null,
    modelInfo: data.model_info || null,
    capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
    thinking: data.thinking && Array.isArray(data.thinking.values)
      ? { values: data.thinking.values, default: data.thinking.default || null }
      : null
  };
  result.evidence = {
    modelfile: evidence(result.fields.modelfile),
    template: evidence(result.fields.template),
    parameters: evidence(result.fields.parameters),
    capabilities: evidence(result.fields.capabilities.length > 0),
    thinking: evidence(Boolean(result.fields.thinking))
  };
  if (!result.fields.modelfile) result.gaps.push('The provider serves metadata without a Modelfile.');
  if (!result.fields.parameters) result.gaps.push('The provider does not report the model parameters block.');
  return result;
}
