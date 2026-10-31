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

test('reports that a non-Ollama provider publishes no internals', async () => {
  const result = await inspectModel({ ...provider('openrouter'), name: 'OpenRouter' }, 'anthropic/claude-sonnet-4.5');
  assert.equal(result.source, 'none');
  assert.equal(publishesInternals(provider('openrouter')), false);
  assert.match(result.gaps[0], /does not publish a Modelfile/);
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
