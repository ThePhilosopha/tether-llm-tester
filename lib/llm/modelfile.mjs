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

// Non-Ollama providers publish a catalogue entry instead of a Modelfile. Read
// it from the models endpoint and keep the fields that describe the model.
export async function readCatalogue(provider, modelId, { fetchImpl = fetch } = {}) {
  const empty = { entry: null, supportedParameters: [], modalities: null, context: null, pricing: null, source: 'none', capturedAt: new Date().toISOString() };
  const headers = { accept: 'application/json', ...(provider.headers || {}) };
  if (provider.auth === 'bearer' && provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const url = new URL('models', `${provider.baseUrl.replace(/\/$/, '')}/`).toString();
  let response;
  try {
    response = await fetchImpl(url, { headers, redirect: 'manual' });
  } catch (error) {
    return { ...empty, error: error.message };
  }
  if (!response.ok) return { ...empty, error: `The models endpoint returned HTTP ${response.status}.` };
  const data = await response.json().catch(() => null);
  const rows = data?.data || data?.models || [];
  const entry = Array.isArray(rows)
    ? rows.find(item => (item?.id || item?.name || item?.model) === modelId)
    : null;
  if (!entry) return empty;
  const supported = entry.supported_parameters || entry.supportedParameters || null;
  const declared = entry.capabilities && typeof entry.capabilities === 'object' && !Array.isArray(entry.capabilities)
    ? entry.capabilities
    : null;
  return {
    entry: {
      id: entry.id || entry.name || modelId,
      name: entry.name || entry.id || modelId,
      description: typeof entry.description === 'string' ? entry.description.slice(0, 2000) : null,
      architecture: entry.architecture || entry.details?.family || null,
      ownedBy: entry.owned_by || null,
      created: entry.created ?? null
    },
    supportedParameters: Array.isArray(supported) ? supported.map(String) : [],
    declaredCapabilities: declared
      ? Object.fromEntries(Object.entries(declared).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)))
      : null,
    modalities: entry.architecture?.input_modalities || entry.modality || null,
    context: entry.context_length || entry.context_window || null,
    maxOutput: entry.max_completion_tokens || entry.max_output_tokens || null,
    pricing: entry.pricing || null,
    source: Array.isArray(supported) || declared ? 'provider-catalogue' : 'partial-catalogue',
    capturedAt: new Date().toISOString()
  };
}

export async function inspectModel(provider, modelId, { fetchImpl = fetch } = {}) {
  if (typeof modelId !== 'string' || !modelId) throw new Error('A model ID is required.');
  const result = {
    providerId: provider.id, modelId, source: 'ollama-native', capturedAt: new Date().toISOString(),
    fields: {}, gaps: []
  };
  if (!publishesInternals(provider)) {
    result.source = 'provider-catalogue';
    result.catalogue = await readCatalogue(provider, modelId, { fetchImpl });
    result.gaps = [
      `${provider.name} does not publish a Modelfile.`,
      result.catalogue.entry
        ? 'This is what the provider catalogue declares for the model; a Modelfile equivalent is not published.'
        : `The provider catalogue does not list ${modelId}, so no parameter metadata is available.`
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
