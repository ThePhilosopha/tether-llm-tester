import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { inspectModel, publishesInternals } from '../lib/llm/modelfile.mjs';
import { parseParameters, applyThinking, thinkingValues, describeProvenance } from '../lib/llm/parameters.mjs';

const provider = (presetId = 'ollama') => ({
  id: 'p1', name: 'Local Ollama', presetId, baseUrl: 'http://127.0.0.1:11434/v1', auth: 'none', headers: {}
});

test('reads the Modelfile and thinking values from the native Ollama API', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      assert.equal(req.url, '/api/show');
      assert.equal(JSON.parse(body).model, 'qwen3.5:2b');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        modelfile: 'FROM qwen3\nPARAMETER temperature 0.7', parameters: 'temperature 0.7',
        capabilities: ['completion', 'thinking'], thinking: { values: ['low', 'high', 'max'], default: 'max' },
        details: { family: 'qwen3' }
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = { ...provider(), baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  const result = await inspectModel(local, 'qwen3.5:2b');
  assert.equal(result.source, 'ollama-native');
  assert.match(result.fields.modelfile, /PARAMETER temperature/);
  assert.deepEqual(result.fields.thinking.values, ['low', 'high', 'max']);
  assert.equal(result.evidence.modelfile, 'published');
  assert.equal(result.gaps.length, 0);
  server.close();
});

test('states the gap instead of inventing a Modelfile for cloud models', async () => {
  const server = createServer((_request, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ capabilities: ['completion'], details: { family: 'gpt-oss' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cloud = { ...provider('ollama-cloud'), name: 'Ollama Cloud', baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  const result = await inspectModel(cloud, 'gpt-oss:120b');
  assert.equal(result.fields.modelfile, null);
  assert.equal(result.evidence.modelfile, 'not-published');
  assert.ok(result.gaps.some(gap => /without a Modelfile/.test(gap)));
  server.close();
});

test('reports that a non-Ollama provider publishes no Modelfile', async () => {
  const result = await inspectModel({
    ...provider('openrouter'), name: 'OpenRouter', baseUrl: 'http://127.0.0.1:1/v1'
  }, 'anthropic/claude-sonnet-4.5');
  assert.equal(result.source, 'provider-catalogue');
  assert.equal(publishesInternals(provider('openrouter')), false);
  assert.match(result.gaps[0], /does not publish a Modelfile/);
  assert.equal(result.catalogue.entry, null);
});

test('reads supported parameters and the catalogue entry for a non-Ollama model', async () => {
  let seenAuth = null;
  const server = createServer((req, res) => {
    seenAuth = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: [{
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5',
        owned_by: 'anthropic',
        context_length: 200000,
        supported_parameters: ['temperature', 'top_p', 'max_tokens', 'tools'],
        architecture: { input_modalities: ['text', 'image'] },
        pricing: { prompt: '0.000003', completion: '0.000015' }
      }]
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const remote = {
      ...provider('openrouter'), name: 'OpenRouter', apiKey: 'secret', auth: 'bearer',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`
    };
    const result = await inspectModel(remote, 'anthropic/claude-sonnet-4.5');
    assert.equal(seenAuth, 'Bearer secret');
    assert.equal(result.source, 'provider-catalogue');
    assert.deepEqual(result.catalogue.supportedParameters, ['temperature', 'top_p', 'max_tokens', 'tools']);
    assert.equal(result.catalogue.entry.name, 'Claude Sonnet 4.5');
    assert.equal(result.catalogue.entry.ownedBy, 'anthropic');
    assert.equal(result.catalogue.context, 200000);
    assert.deepEqual(result.catalogue.modalities, ['text', 'image']);
    assert.equal(result.catalogue.source, 'provider-catalogue');
    assert.match(result.gaps[1], /catalogue declares/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a catalogue entry with a capabilities block is read as declared parameters', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: [{
        id: 'nvidia/minimaxai/minimax-m2.7',
        owned_by: 'nvidia',
        context_length: 200000,
        max_completion_tokens: 131072,
        capabilities: { tools: true, reasoning: true, vision: false, contextWindow: 200000 },
        supported_parameters: undefined
      }]
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const remote = {
      ...provider('9router'), name: '9Router',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`
    };
    const result = await inspectModel(remote, 'nvidia/minimaxai/minimax-m2.7');
    assert.deepEqual(result.catalogue.supportedParameters, []);
    assert.equal(result.catalogue.declaredCapabilities.tools, true);
    assert.equal(result.catalogue.declaredCapabilities.vision, false);
    assert.equal(result.catalogue.maxOutput, 131072);
    assert.equal(result.catalogue.source, 'provider-catalogue');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a model missing from the catalogue reports that gap instead of inventing fields', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'other-model', supported_parameters: ['temperature'] }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const remote = {
    ...provider('openrouter'), name: 'OpenRouter',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`
  };
  const result = await inspectModel(remote, 'missing-model');
  assert.equal(result.catalogue.entry, null);
  assert.match(result.gaps[1], /does not list missing-model/);
  server.close();
});

test('a catalogue endpoint failure is reported, not hidden', async () => {
  const server = createServer((_req, res) => { res.writeHead(500).end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const remote = {
    ...provider('openrouter'), name: 'OpenRouter',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`
  };
  const result = await inspectModel(remote, 'anything');
  assert.equal(result.catalogue.entry, null);
  assert.match(result.catalogue.error, /HTTP 500/);
  server.close();
});

test('keeps unknown parameters out of the request and records why', () => {
  const { parsed, rejected } = parseParameters({
    temperature: '0.4', topK: '40', seed: '7', topP: '5', stop: 'a\nb', fantasy: '1'
  });
  assert.deepEqual(parsed, { temperature: 0.4, topK: 40, seed: 7, stop: ['a', 'b'] });
  assert.deepEqual(rejected.map(item => item.name).sort(), ['fantasy', 'topP']);
  const provenance = describeProvenance(parsed, 'max', rejected);
  assert.equal(provenance.temperature.source, 'form');
  assert.equal(provenance.topP.source, 'rejected');
  assert.equal(provenance.thinking.wire, 'reasoning_effort');
});

test('maps thinking effort onto each protocol wire shape', () => {
  const chat = {}; assert.equal(applyThinking(chat, 'chat-completions', 'max'), 'reasoning_effort');
  assert.equal(chat.reasoning_effort, 'max');
  const responses = {}; applyThinking(responses, 'responses', 'low');
  assert.deepEqual(responses.reasoning, { effort: 'low' });
  const google = {}; applyThinking(google, 'google-generate-content', 'high');
  assert.deepEqual(google.generationConfig.thinkingConfig, { thinkingLevel: 'high' });
  assert.equal(applyThinking({}, 'chat-completions', ''), null);
  assert.deepEqual(thinkingValues({ thinking: { values: ['low', 'max'], default: 'max' } }), ['low', 'max']);
  assert.deepEqual(thinkingValues(null), ['low', 'medium', 'high']);
});
