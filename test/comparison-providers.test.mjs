import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRequest,
  discoverModels,
  executeModel
} from '../lib/comparison/providers.mjs';

const provider = {
  presetId: 'custom',
  baseUrl: 'https://mock.example/v1',
  auth: 'bearer',
  apiKey: 'secret',
  headers: {}
};
const settings = {
  temperature: 0.7,
  topP: 0.9,
  maxOutputTokens: 200,
  stream: false,
  timeoutMs: 30000
};
const testCase = {
  system: 'Be accurate.',
  prompt: 'Write three options.'
};
const model = (protocol, endpoint) => ({
  providerId: 'mock', modelId: 'model-a', protocol,
  endpoint: endpoint || 'https://mock.example/v1/chat/completions',
  capabilities: { parameters: {} }
});

test('maps shared controls and prompts to Chat Completions', () => {
  const request = buildRequest(provider, model('chat-completions'), testCase, settings, 'session-1');
  assert.equal(request.url, 'https://mock.example/v1/chat/completions');
  assert.deepEqual(request.body.messages, [
    { role: 'system', content: 'Be accurate.' },
    { role: 'user', content: 'Write three options.' }
  ]);
  assert.equal(request.body.top_p, settings.topP);
  assert.equal(request.body.max_tokens, settings.maxOutputTokens);
});

test('maps the same controls to Responses, Anthropic and Google protocols', () => {
  const responses = buildRequest(provider, model('responses', 'https://mock.example/v1/responses'), testCase, settings, 's');
  assert.equal(responses.body.instructions, testCase.system);
  assert.equal(responses.body.max_output_tokens, settings.maxOutputTokens);
  const anthropic = buildRequest(provider, model('anthropic-messages', 'https://mock.example/v1/messages'), testCase, settings, 's');
  assert.equal(anthropic.body.max_tokens, settings.maxOutputTokens);
  assert.equal(anthropic.body.system, testCase.system);
  const google = buildRequest(provider, model('google-generate-content', 'https://mock.example/v1/models/gemini:generateContent'), testCase, settings, 's');
  assert.equal(google.body.generationConfig.topP, settings.topP);
  assert.equal(google.body.generationConfig.maxOutputTokens, settings.maxOutputTokens);
  assert.match(google.url, /:generateContent$/);
  const googleStream = buildRequest(provider, model('google-generate-content', 'https://mock.example/v1/models/gemini:generateContent'), testCase, { ...settings, stream: true }, 's');
  assert.equal(googleStream.url, 'https://mock.example/v1/models/gemini:streamGenerateContent?alt=sse');
  const googleQuery = buildRequest(provider, model('google-generate-content', 'https://mock.example/v1/models/gemini:generateContent?key=kept&region=us'), testCase, { ...settings, stream: true }, 's');
  assert.equal(googleQuery.url, 'https://mock.example/v1/models/gemini:streamGenerateContent?key=kept&region=us&alt=sse');
});

function sseResponse(frames, { splitAt } = {}) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(frames.join(''));
  return new Response(new ReadableStream({
    start(controller) {
      if (splitAt) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
      } else controller.enqueue(bytes);
      controller.close();
    }
  }), { headers: { 'content-type': 'text/event-stream' } });
}

const jsonResponse = value => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' }
});

const streamed = (protocol, frames, emit = () => {}) => executeModel({
  provider,
  model: model(protocol, protocol === 'google-generate-content'
    ? 'https://mock.example/v1/models/gemini:generateContent'
    : protocol === 'responses' ? 'https://mock.example/v1/responses'
      : protocol === 'anthropic-messages' ? 'https://mock.example/v1/messages'
        : 'https://mock.example/v1/chat/completions'),
  testCase,
  settings: { ...settings, stream: true },
  sessionId: 's',
  fetchImpl: async () => sseResponse(frames),
  emit
});

test('normalises plain responses from all four protocols', async () => {
  const fixtures = [
    ['chat-completions', {
      choices: [{ message: { content: 'chat', reasoning_content: 'because', tool_calls: [{ id: 't1' }] }, finish_reason: 'stop' }],
      usage: { total_tokens: 3 }
    }, { text: 'chat', reasoning: 'because', finishReason: 'stop', usage: { total_tokens: 3 }, toolCalls: [{ id: 't1' }] }],
    ['responses', {
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'because' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'response' }] },
        { type: 'function_call', call_id: 't2', name: 'lookup', arguments: '{}', type: 'function_call' }
      ], usage: { total_tokens: 4 }, status: 'completed'
    }, { text: 'response', reasoning: 'because', finishReason: 'completed', usage: { total_tokens: 4 }, toolCalls: [{ type: 'function_call', call_id: 't2', name: 'lookup', arguments: '{}' }] }],
    ['anthropic-messages', {
      type: 'message',
      content: [{ type: 'thinking', thinking: 'because' }, { type: 'text', text: 'anthropic' }, { type: 'tool_use', id: 't3', name: 'lookup', input: {} }],
      stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 }
    }, { text: 'anthropic', reasoning: 'because', finishReason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 }, toolCalls: [{ type: 'tool_use', id: 't3', name: 'lookup', input: {} }] }],
    ['google-generate-content', {
      candidates: [{ content: { parts: [{ text: 'because', thought: true }, { text: 'google' }, { functionCall: { name: 'lookup', args: {} } }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 }
    }, { text: 'google', reasoning: 'because', finishReason: 'STOP', usage: { totalTokenCount: 5 }, toolCalls: [{ name: 'lookup', args: {} }] }]
  ];
  for (const [protocol, payload, expected] of fixtures) {
    const result = await executeModel({
      provider,
      model: model(protocol, protocol === 'google-generate-content'
        ? 'https://mock.example/v1/models/gemini:generateContent'
        : protocol === 'responses' ? 'https://mock.example/v1/responses'
          : protocol === 'anthropic-messages' ? 'https://mock.example/v1/messages'
            : 'https://mock.example/v1/chat/completions'),
      testCase, settings, sessionId: 's', fetchImpl: async () => jsonResponse(payload)
    });
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, result[key]])), expected, protocol);
  }
});

test('normalises streamed deltas, usage, reasoning and tool calls for all protocols', async () => {
  const cases = [
    ['chat-completions', [
      'data: {"choices":[{"delta":{"content":"café","reasoning_content":"why","tool_calls":[{"id":"t1"}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":2}}\n\n', 'data: [DONE]\n\n'
    ], { text: 'café', reasoning: 'why', finishReason: 'stop', usage: { total_tokens: 2 }, toolCalls: [{ id: 't1' }] }],
    ['responses', [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"first "}\n\n',
      'event: response.output_text.delta\ndata: {"delta":"answer"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"why"}]},{"type":"message","content":[{"type":"output_text","text":"first answer"}]},{"type":"function_call","call_id":"t2","name":"lookup","arguments":"{}"}],"usage":{"total_tokens":4}}}\n\n'
    ], { text: 'first answer', reasoning: 'why', finishReason: 'completed', usage: { total_tokens: 4 }, toolCalls: [{ type: 'function_call', call_id: 't2', name: 'lookup', arguments: '{}' }] }],
    ['anthropic-messages', [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"why"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"anthropic"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"t3","name":"lookup","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Cape Town\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":3}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ], { text: 'anthropic', reasoning: 'why', finishReason: 'end_turn', usage: { input_tokens: 7, output_tokens: 5 }, toolCalls: [{ type: 'tool_use', id: 't3', name: 'lookup', input: { city: 'Cape Town' } }] }],
    ['google-generate-content', [
      'data: {"candidates":[{"content":{"parts":[{"text":"why","thought":true},{"text":"google"},{"functionCall":{"name":"lookup","args":{}}}]}}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":6}}\n\n'
    ], { text: 'google', reasoning: 'why', finishReason: 'STOP', usage: { totalTokenCount: 6 }, toolCalls: [{ name: 'lookup', args: {} }] }]
  ];
  for (const [protocol, frames, expected] of cases) {
    const result = await streamed(protocol, frames);
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, result[key]])), expected, protocol);
  }
  const utf8 = await streamed('chat-completions', [
    'data: {"choices":[{"delta":{"content":"café"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'
  ], undefined);
  assert.equal(utf8.text, 'café');
  const utf8Frame = 'data: {"choices":[{"delta":{"content":"café"}}]}\n\n' +
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n\n';
  const splitIndex = utf8Frame.indexOf('é') === -1 ? 0 : new TextEncoder().encode(utf8Frame.slice(0, utf8Frame.indexOf('é'))).length + 1;
  const splitResult = await executeModel({
    provider, model: model('chat-completions'), testCase,
    settings: { ...settings, stream: true }, sessionId: 's',
    fetchImpl: async () => sseResponse([utf8Frame], { splitAt: splitIndex })
  });
  assert.equal(splitResult.text, 'café');
});

test('fails streams without a protocol terminal event and preserves emitted partial deltas', async () => {
  const events = [];
  await assert.rejects(streamed('chat-completions', [
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
  ], event => events.push(event)), /ended before completion/);
  assert.ok(events.some(event => event.type === 'delta' && event.text === 'partial'));
  await assert.rejects(streamed('responses', [
    'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n'
  ]), /incomplete/i);
  await assert.rejects(streamed('anthropic-messages', [
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n'
  ]), /busy/);
  await assert.rejects(streamed('google-generate-content', [
    'data: {broken}\n\n'
  ]), /malformed/);
});

test('rejects failed, incomplete and error envelopes in plain JSON responses', async () => {
  const responses = [
    { type: 'response.failed', response: { status: 'failed', error: { message: 'generation failed' } } },
    { type: 'response.incomplete', response: { status: 'incomplete' } },
    { type: 'error', error: { message: 'request rejected' } },
    { status: 'failed', error: { message: 'provider failed' } },
    { status: 'incomplete' }
  ];
  for (const payload of responses) {
    await assert.rejects(executeModel({
      provider, model: model('responses', 'https://mock.example/v1/responses'),
      testCase, settings, sessionId: 's', fetchImpl: async () => jsonResponse(payload)
    }), /failed|incomplete|generation failed|request rejected|provider failed/i);
  }
  await assert.rejects(executeModel({
    provider, model: model('responses', 'https://mock.example/v1/responses'),
    testCase, settings, sessionId: 's', fetchImpl: async () => new Response('{broken json')
  }), SyntaxError);
});

test('reports only non-empty provider-reported actual routes for JSON and streams', async () => {
  const json = await executeModel({
    provider, model: model('chat-completions'), testCase, settings, sessionId: 's',
    fetchImpl: async () => jsonResponse({
      provider: 'chosen-route', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }]
    })
  });
  assert.equal(json.actualRoute, 'chosen-route');

  const blank = await executeModel({
    provider, model: model('chat-completions'), testCase, settings, sessionId: 's',
    fetchImpl: async () => jsonResponse({ provider: '  ', choices: [{ message: { content: 'ok' } }] })
  });
  assert.equal(blank.actualRoute, null);

  const frames = [
    'data: {"provider":"chosen-stream-route","choices":[{"delta":{"content":"ok"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ];
  const result = await streamed('chat-completions', frames);
  assert.equal(result.actualRoute, 'chosen-stream-route');
});

test('does not place credentials in the saved request body or visible headers', () => {
  const request = buildRequest(provider, model('chat-completions'), testCase, settings, 's');
  assert.equal(request.headers.authorization, 'Bearer secret');
  assert.doesNotMatch(JSON.stringify({ url: request.url, body: request.body }), /secret/);
});

test('discovers OpenRouter parameter support and leaves unknowns unknown', async () => {
  const result = await discoverModels({
    ...provider, presetId: 'openrouter', baseUrl: 'https://mock.example/api/v1'
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ data: [{
      id: 'vendor/model', context_length: 32000,
      supported_parameters: ['temperature'],
      pricing: { prompt: '0.000001', completion: '0.000002' }
    }] }))
  });
  assert.equal(result[0].protocol, 'chat-completions');
  assert.equal(result[0].capabilities.parameters.topP, 'unsupported');
  assert.equal(result[0].capabilities.parameters.temperature, 'supported');
  assert.equal(result[0].capabilities.parameters.maxOutputTokens, 'unsupported');
  assert.equal(result[0].capabilitySource, 'provider-catalogue');
});

test('discovers Ollama Cloud models without claiming parameter support', async () => {
  const result = await discoverModels({
    ...provider, presetId: 'ollama-cloud', baseUrl: 'https://mock.example/v1'
  }, {
    fetchImpl: async url => {
      assert.equal(String(url), 'https://mock.example/api/tags');
      return new Response(JSON.stringify({ models: [{ name: 'gemma:cloud' }] }));
    }
  });
  assert.equal(result[0].modelId, 'gemma:cloud');
  assert.equal(result[0].capabilities.parameters.topP, 'unknown');
});

test('decodes streamed deltas even when SSE frames are split across reads', async () => {
  const encoder = new TextEncoder();
  const source = new ReadableStream({
    start(controller) {
      const frame = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":2}}\n\n' +
        'data: [DONE]\n\n';
      controller.enqueue(encoder.encode(frame.slice(0, 19)));
      controller.enqueue(encoder.encode(frame.slice(19)));
      controller.close();
    }
  });
  const events = [];
  const result = await executeModel({
    provider,
    model: model('chat-completions'),
    testCase,
    settings: { ...settings, stream: true },
    sessionId: 'session-1',
    fetchImpl: async () => new Response(source, {
      headers: { 'content-type': 'text/event-stream' }
    }),
    emit: event => events.push(event)
  });
  assert.equal(result.text, 'hello');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.total_tokens, 2);
  assert.ok(events.some(event => event.type === 'raw'));
  assert.ok(events.some(event => event.type === 'delta' && event.text === 'hello'));
});

test('rejects unknown protocols and redirects, and keeps provider errors readable', async () => {
  assert.throws(() => buildRequest(provider, model('made-up'), testCase, settings, 's'), /Unsupported model protocol/);
  await assert.rejects(executeModel({
    provider, model: model('chat-completions', 'https://evil.example/chat'),
    testCase, settings, sessionId: 's'
  }), /does not match configured provider/);
  await assert.rejects(executeModel({
    provider, model: model('chat-completions'), testCase, settings, sessionId: 's',
    fetchImpl: async () => new Response('invalid key', { status: 401 })
  }), /HTTP 401.*invalid key/);
});
