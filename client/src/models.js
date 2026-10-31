// Shared rules for picking a model to test with. Shane's standing instruction
// is that local models are never used for testing, verification or demos, so
// the exclusion lives here once instead of in each screen.

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isLocalProvider(provider) {
  if (!provider) return false;
  if (provider.presetId === 'ollama') return true;
  try { return LOCAL_HOSTS.has(new URL(provider.baseUrl).hostname); }
  catch { return false; }
}

export function remoteProviders(providers = []) {
  return providers.filter(provider => !isLocalProvider(provider));
}

export function modelKey(model) {
  return `${model.providerId}|${model.modelId}`;
}

export function modelLabel(model, providers = []) {
  const provider = providers.find(item => item.id === model.providerId);
  return `${provider?.name || model.providerId} / ${model.modelId}`;
}
