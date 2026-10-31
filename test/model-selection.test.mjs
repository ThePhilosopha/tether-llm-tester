import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocalProvider, modelKey, modelLabel, remoteProviders } from '../client/src/models.js';

const provider = (overrides = {}) => ({
  id: 'p1', name: 'Provider', presetId: 'custom', baseUrl: 'https://api.example.test/v1', ...overrides
});

test('local providers are excluded from the testable set', () => {
  assert.equal(isLocalProvider(provider({ presetId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' })), true);
  assert.equal(isLocalProvider(provider({ presetId: 'custom', baseUrl: 'http://localhost:8080/v1' })), true);
  assert.equal(isLocalProvider(provider({ presetId: 'custom', baseUrl: 'http://[::1]:8080/v1' })), true);
  assert.equal(isLocalProvider(provider({ presetId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' })), false);
  assert.equal(isLocalProvider(null), false);
  assert.equal(isLocalProvider(provider({ baseUrl: 'not a url' })), false);
});

test('the remote set keeps every non-local provider and drops the local one', () => {
  const providers = [
    provider({ id: 'local', presetId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }),
    provider({ id: 'cloud', presetId: 'ollama-cloud', baseUrl: 'https://ollama.com/v1' }),
    provider({ id: 'router', presetId: '9router', baseUrl: 'https://router.example.test/v1' })
  ];
  assert.deepEqual(remoteProviders(providers).map(item => item.id), ['cloud', 'router']);
  assert.deepEqual(remoteProviders([]), []);
});

test('a model key is stable and a label names the provider', () => {
  const model = { providerId: 'cloud', modelId: 'minimax-m3' };
  assert.equal(modelKey(model), 'cloud|minimax-m3');
  assert.equal(modelLabel(model, [provider({ id: 'cloud', name: 'Ollama Cloud' })]), 'Ollama Cloud / minimax-m3');
  assert.equal(modelLabel(model, []), 'cloud / minimax-m3');
});
