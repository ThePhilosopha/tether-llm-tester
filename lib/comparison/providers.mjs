import { parseSseFrame } from '../sse.mjs';
import { appendPath, utf8Prefix } from '../util.mjs';
import { PROTOCOLS, isLoopbackHost } from './contract.mjs';

const MAX_RAW = 1024 * 1024;

function providerOrigin(provider) {
  return new URL(provider.baseUrl).origin;
}

function checkEndpoint(provider, model) {
  let url;
  try { url = new URL(model.endpoint); }
  catch { throw new Error('Model endpoint is invalid.'); }
  if (url.origin !== providerOrigin(provider)) {
    throw new Error('Model endpoint does not match configured provider.');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('Model endpoint contains unsupported URL fields.');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && provider.allowRemoteHttp !== true) {
    throw new Error('Remote HTTP is disabled. Use HTTPS or enable it explicitly.');
  }
  return url;
}

function commonHeaders(provider, sessionId) {
  const headers = { accept: 'application/json', ...(provider.headers || {}) };
  if (provider.auth === 'bearer' && provider.apiKey) {
    headers.authorization = `Bearer ${provider.apiKey}`;
  }
  if (provider.presetId === 'opencode-go') {
    headers['user-agent'] = 'LLM-Tester/1.0';
    headers['x-opencode-session'] = sessionId;
  }
  return headers;
}

function messages(testCase) {
  return [
    ...(testCase.system ? [{ role: 'system', content: testCase.system }] : []),
    { role: 'user', content: testCase.prompt }
  ];
}

export function buildRequest(provider, model, testCase, settings, sessionId) {
  if (!PROTOCOLS.has(model.protocol)) throw new Error('Unsupported model protocol.');
  const endpoint = checkEndpoint(provider, model);
  let body;
  switch (model.protocol) {
    case 'chat-completions':
      body = {
        model: model.modelId,
        messages: messages(testCase),
        temperature: settings.temperature,
        top_p: settings.topP,
        max_tokens: settings.maxOutputTokens,
        stream: settings.stream
      };
      break;
    case 'responses':
      body = {
        model: model.modelId,
        instructions: testCase.system || undefined,
        input: testCase.prompt,
        temperature: settings.temperature,
        top_p: settings.topP,
        max_output_tokens: settings.maxOutputTokens,
        stream: settings.stream
      };
      break;
    case 'anthropic-messages':
      body = {
        model: model.modelId,
        system: testCase.system || undefined,
        messages: [{ role: 'user', content: testCase.prompt }],
        temperature: settings.temperature,
        top_p: settings.topP,
        max_tokens: settings.maxOutputTokens,
        stream: settings.stream
      };
      break;
    case 'google-generate-content':
      body = {
        contents: [{ role: 'user', parts: [{ text: testCase.prompt }] }],
        systemInstruction: testCase.system ? { parts: [{ text: testCase.system }] } : undefined,
        generationConfig: {
          temperature: settings.temperature,
          topP: settings.topP,
          maxOutputTokens: settings.maxOutputTokens
        }
      };
      break;
  }
  if (model.protocol === 'chat-completions' && provider.presetId === 'openrouter') {
    body.provider = {
      require_parameters: true,
      allow_fallbacks: false,
      ...(model.route ? { order: [model.route] } : {})
    };
  }
  let url = endpoint;
  if (model.protocol === 'google-generate-content' && settings.stream) {
    url.pathname = url.pathname.replace(/:generateContent$/, ':streamGenerateContent');
    url.searchParams.set('alt', 'sse');
  }
  const headers = commonHeaders(provider, sessionId);
  headers['content-type'] = 'application/json';
  if (provider.presetId === 'opencode-go') headers['x-opencode-session'] = sessionId;
  return { url: url.toString(), method: 'POST', headers, body };
}

function support(names, ...requested) {
  if (!Array.isArray(names)) return 'unknown';
  return requested.some(name => names.includes(name)) ? 'supported' : 'unsupported';
}

function protocolFrom(raw, configured) {
  const explicit = configured?.protocol || raw.protocol || raw.api_protocol || raw.apiProtocol;
  if (PROTOCOLS.has(explicit)) return explicit;
  const endpoint = configured?.endpoint || raw.endpoint || raw.api_endpoint || raw.apiEndpoint;
  if (typeof endpoint !== 'string') return null;
  if (/\/chat\/completions(?:\?|$)/.test(endpoint)) return 'chat-completions';
  if (/\/responses(?:\?|$)/.test(endpoint)) return 'responses';
  if (/\/messages(?:\?|$)/.test(endpoint)) return 'anthropic-messages';
  if (/\/models\/[^/]+:generateContent(?:\?|$)/.test(endpoint)) return 'google-generate-content';
  return null;
}

function endpointFor(provider, modelId, protocol, configured, raw) {
  if (configured?.endpoint || raw.endpoint || raw.api_endpoint || raw.apiEndpoint) {
    return new URL(configured?.endpoint || raw.endpoint || raw.api_endpoint || raw.apiEndpoint, provider.baseUrl).toString();
  }
  const base = provider.baseUrl;
  if (protocol === 'chat-completions') return appendPath(base, 'chat/completions');
  if (protocol === 'responses') return appendPath(base, 'responses');
  if (protocol === 'anthropic-messages') return appendPath(base, 'messages');
  if (protocol === 'google-generate-content') {
    const id = encodeURIComponent(modelId);
    const prefix = appendPath(base, `models/${id}`);
    return `${prefix}:generateContent`;
  }
  return null;
}

function normaliseModel(provider, raw) {
  const modelId = raw?.id || raw?.name || raw?.model;
  if (typeof modelId !== 'string' || !modelId) return null;
  const configured = provider.comparisonModels?.[modelId];
  let protocol = provider.presetId === 'openrouter'
    ? 'chat-completions'
    : provider.presetId === 'ollama-cloud'
      ? 'chat-completions'
      : protocolFrom(raw, configured);
  if (configured?.protocol) protocol = configured.protocol;
  const parameters = raw.supported_parameters || raw.supportedParameters;
  const capabilities = {
    parameters: {
      temperature: support(parameters, 'temperature'),
      topP: support(parameters, 'top_p', 'topP'),
      maxOutputTokens: support(parameters, 'max_tokens', 'max_output_tokens', 'maxOutputTokens')
    }
  };
  for (const [key, value] of Object.entries(configured?.capabilities?.parameters || {})) {
    if (['temperature', 'topP', 'maxOutputTokens'].includes(key) &&
        ['supported', 'unsupported', 'unknown'].includes(value)) capabilities.parameters[key] = value;
  }
  const endpoint = endpointFor(provider, modelId, protocol, configured, raw);
  const checkedAt = new Date().toISOString();
  return {
    providerId: provider.id,
    modelId,
    name: raw.name || raw.id || modelId,
    protocol,
    endpoint,
    context: raw.context_length || raw.context_window || null,
    pricing: raw.pricing || null,
    capabilities,
    capabilitySource: parameters ? 'provider-catalogue' : 'unknown',
    capabilityCheckedAt: checkedAt,
    pricingObservedAt: raw.pricing ? checkedAt : null,
    pricingSource: raw.pricing ? 'provider-catalogue' : null,
    route: configured?.route || null,
    available: Boolean(protocol && endpoint),
    mappingRequired: !protocol || !endpoint
  };
}

export async function discoverModels(provider, { fetchImpl = fetch, signal } = {}) {
  const cloud = provider.presetId === 'ollama-cloud';
  const url = cloud
    ? `${new URL(provider.baseUrl).origin}/api/tags`
    : appendPath(provider.baseUrl, 'models');
  const headers = { accept: 'application/json', ...(provider.headers || {}) };
  if (provider.auth === 'bearer' && provider.apiKey) {
    headers.authorization = `Bearer ${provider.apiKey}`;
  }
  if (provider.presetId === 'opencode-go') headers['user-agent'] = 'LLM-Tester/1.0';
  const response = await fetchImpl(url, { headers, redirect: 'manual', signal });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2000);
    throw new Error(`Model discovery failed (HTTP ${response.status}): ${detail}`);
  }
  const data = await response.json();
  const models = cloud ? (data.models || []) : (data.data || data.models || []);
  return models.map(raw => normaliseModel(provider, raw)).filter(Boolean);
}

function textFrom(payload, protocol, eventName) {
  const event = eventName || payload?.type || '';
  if (protocol === 'chat-completions') {
    const choice = payload?.choices?.[0];
    return {
      text: choice?.delta?.content || choice?.message?.content || '',
      reasoning: choice?.delta?.reasoning_content || choice?.delta?.reasoning || choice?.message?.reasoning_content || choice?.message?.reasoning || '',
      finishReason: choice?.finish_reason || null,
      usage: payload?.usage || null,
      toolCalls: choice?.delta?.tool_calls || choice?.message?.tool_calls || []
    };
  }
  if (protocol === 'responses') {
    if (event === 'response.output_text.delta') return { text: payload.delta || '' };
    if (event === 'response.completed') {
      const response = payload.response || payload;
      return responseOutput(response);
    }
    if (payload?.output || payload?.response?.output) return responseOutput(payload.response || payload);
    return {};
  }
  if (protocol === 'anthropic-messages') {
    const content = payload.content || payload.message?.content || [];
    const text = event === 'content_block_delta' && payload.delta?.type === 'text_delta'
      ? payload.delta.text || ''
      : (event === 'message' || payload.type === 'message') ? content.filter(item => item.type === 'text').map(item => item.text).join('') : '';
    return {
      text,
      reasoning: event === 'content_block_delta' && payload.delta?.type === 'thinking_delta'
        ? payload.delta.thinking || ''
        : content.filter(item => item.type === 'thinking').map(item => item.thinking || '').join(''),
      finishReason: payload.delta?.stop_reason || payload.stop_reason || null,
      usage: payload.usage || payload.message?.usage || null,
      toolCalls: event === 'content_block_start' && payload.content_block?.type === 'tool_use'
        ? [payload.content_block] : content.filter(item => item.type === 'tool_use'),
      toolIndex: payload.index,
      toolInputDelta: event === 'content_block_delta' && payload.delta?.type === 'input_json_delta'
        ? payload.delta.partial_json || '' : undefined,
      toolInputFinal: event === 'content_block_stop'
    };
  }
  const candidate = payload?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  return {
    text: parts.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join(''),
    reasoning: parts.filter(part => typeof part.text === 'string' && part.thought).map(part => part.text).join(''),
    finishReason: candidate?.finishReason || null,
    usage: payload?.usageMetadata || null,
    toolCalls: parts.flatMap(part => part.functionCall ? [part.functionCall] : [])
  };
}

function responseOutput(response) {
  const output = response.output || [];
  return {
    text: output.flatMap(item => item.content || [])
      .filter(item => item.type === 'output_text').map(item => item.text || '').join(''),
    reasoning: output.filter(item => item.type === 'reasoning')
      .flatMap(item => item.summary || item.content || [])
      .filter(item => item.type === 'summary_text' || item.type === 'reasoning_text')
      .map(item => item.text || '').join(''),
    toolCalls: output.filter(item => item.type === 'function_call'),
    usage: response.usage || null,
    finishReason: response.status === 'incomplete' ? 'incomplete' : response.status === 'failed' ? 'failed' : 'completed'
  };
}

function ssePayload(frame) {
  const lines = frame.replace(/\r/g, '').split('\n');
  const eventName = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || '';
  const parsed = parseSseFrame(frame);
  if (parsed?.malformed) throw new Error('Provider returned malformed SSE JSON.');
  return { eventName, payload: parsed, done: lines.some(line => line.startsWith('data:') && line.slice(5).trim() === '[DONE]') };
}

function providerFailure(payload) {
  const response = payload?.response || payload;
  if (payload?.error || ['error', 'response.error', 'response.failed'].includes(payload?.type)) {
    return payload.error?.message || response?.error?.message || payload.message || 'Provider response failed.';
  }
  if (['failed', 'incomplete'].includes(response?.status) || payload?.type === 'response.incomplete') {
    return response.error?.message || `Provider response ${response.status || 'incomplete'}.`;
  }
  return null;
}

function jsonResult(payload, protocol) {
  const failure = providerFailure(payload);
  if (failure) throw new Error(failure);
  const normalised = textFrom(payload, protocol, '');
  return {
    text: normalised.text || '',
    reasoning: normalised.reasoning || '',
    toolCalls: normalised.toolCalls || [],
    finishReason: normalised.finishReason || null,
    usage: normalised.usage || null,
    actualRoute: typeof payload?.provider === 'string' && payload.provider.trim() ? payload.provider : null
  };
}

export async function executeModel({
  provider, model, testCase, settings, sessionId, signal,
  emit = () => {}, fetchImpl = fetch
}) {
  const request = buildRequest(provider, model, testCase, settings, sessionId);
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
    redirect: 'manual',
    signal
  });
  emit({ type: 'response', status: response.status, headers: Object.fromEntries(response.headers) });
  if (!response.ok || response.status >= 300) {
    const detail = (await response.text()).slice(0, 2000);
    throw new Error(`Provider returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  if (!settings.stream) return { ...jsonResult(await response.json(), model.protocol), raw: null, rawTruncated: false };
  if (!response.body) throw new Error('Provider returned no response body.');

  const decoder = new TextDecoder();
  let buffer = '', raw = '', rawBytes = 0, rawTruncated = false;
  const result = { text: '', reasoning: '', toolCalls: [], finishReason: null, usage: null, actualRoute: null };
  const anthropicToolInputs = new Map();
  let completed = false;
  const consume = frame => {
    if (!frame.trim()) return;
    const { eventName, payload, done } = ssePayload(frame);
    if (done && model.protocol === 'chat-completions') { completed = true; return; }
    if (!payload) return;
    const event = eventName || payload.type || '';
    const failure = providerFailure(payload);
    if (failure || event === 'error') throw new Error(failure || payload.message || 'Provider stream failed.');
    const delta = textFrom(payload, model.protocol, eventName);
    if (typeof payload.provider === 'string' && payload.provider.trim()) result.actualRoute = payload.provider;
    const isResponsesFinal = model.protocol === 'responses' && event === 'response.completed';
    if (delta.text) {
      if (isResponsesFinal) result.text = delta.text;
      else { result.text += delta.text; emit({ type: 'delta', text: delta.text }); }
    }
    if (delta.reasoning) { result.reasoning += delta.reasoning; emit({ type: 'reasoning', text: delta.reasoning }); }
    if (delta.toolCalls?.length) {
      const start = result.toolCalls.length;
      result.toolCalls.push(...delta.toolCalls);
      if (model.protocol === 'anthropic-messages' && delta.toolIndex !== undefined) {
        anthropicToolInputs.set(delta.toolIndex, { position: start, json: '' });
      }
    }
    if (model.protocol === 'anthropic-messages' && delta.toolInputDelta !== undefined) {
      const tool = anthropicToolInputs.get(delta.toolIndex);
      if (tool) tool.json += delta.toolInputDelta;
    }
    if (model.protocol === 'anthropic-messages' && delta.toolInputFinal) {
      const tool = anthropicToolInputs.get(delta.toolIndex);
      if (tool && tool.json) {
        try { result.toolCalls[tool.position] = { ...result.toolCalls[tool.position], input: JSON.parse(tool.json) }; }
        catch { throw new Error('Provider returned malformed Anthropic tool input JSON.'); }
      }
    }
    if (delta.finishReason) result.finishReason = delta.finishReason;
    if (delta.usage) result.usage = { ...(result.usage || {}), ...delta.usage };
    if (model.protocol === 'responses' && event === 'response.completed') completed = true;
    if (model.protocol === 'anthropic-messages' && event === 'message_stop') completed = true;
    if (model.protocol === 'google-generate-content' && delta.finishReason) completed = true;
  };
  for await (const bytes of response.body) {
    const text = decoder.decode(bytes, { stream: true });
    const remaining = MAX_RAW - rawBytes;
    const captured = utf8Prefix(text, Math.max(0, remaining));
    raw += captured;
    rawBytes += Buffer.byteLength(captured);
    rawTruncated ||= Buffer.byteLength(text) > Buffer.byteLength(captured);
    emit({ type: 'raw', data: text });
    buffer += text;
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match) break;
      consume(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  if (!completed) throw new Error('Provider stream ended before completion.');
  return { ...result, raw, rawTruncated };
}
