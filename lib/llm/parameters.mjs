const THINKING_WIRE = {
  'chat-completions': 'reasoning_effort',
  'responses': 'reasoning.effort',
  'anthropic-messages': 'thinking',
  'google-generate-content': 'generationConfig.thinkingConfig.thinkingLevel'
};

export const PARAMETERS = Object.freeze({
  temperature: { wire: 'temperature', type: 'number', min: 0, max: 2, evidence: 'documented' },
  topP: { wire: 'top_p', type: 'number', min: 0, max: 1, evidence: 'documented' },
  topK: { wire: 'top_k', type: 'integer', min: 0, evidence: 'observed' },
  maxOutputTokens: { wire: 'max_tokens', type: 'integer', min: 1, evidence: 'documented' },
  stop: { wire: 'stop', type: 'string-list', evidence: 'documented' },
  seed: { wire: 'seed', type: 'integer', evidence: 'observed' },
  frequencyPenalty: { wire: 'frequency_penalty', type: 'number', min: -2, max: 2, evidence: 'documented' },
  presencePenalty: { wire: 'presence_penalty', type: 'number', min: -2, max: 2, evidence: 'documented' },
  responseFormat: { wire: 'response_format', type: 'json', evidence: 'documented' },
  thinking: { wire: null, type: 'enum', evidence: 'observed' }
});

const DEFAULTS = ['low', 'medium', 'high'];

export function thinkingValues(discovery) {
  return discovery?.thinking?.values?.length ? [...discovery.thinking.values] : DEFAULTS;
}

export function thinkingDefault(discovery) {
  return discovery?.thinking?.default || '';
}

export function thinkingWireName(protocol) {
  return THINKING_WIRE[protocol] || null;
}

export function applyThinking(body, protocol, setting) {
  if (!setting) return null;
  if (protocol === 'chat-completions') {
    body.reasoning_effort = setting;
    return 'reasoning_effort';
  }
  if (protocol === 'responses') {
    body.reasoning = { ...(body.reasoning || {}), effort: setting };
    return 'reasoning.effort';
  }
  if (protocol === 'anthropic-messages') {
    body.thinking = { type: 'enabled', effort: setting };
    return 'thinking.effort';
  }
  if (protocol === 'google-generate-content') {
    body.generationConfig = { ...(body.generationConfig || {}), thinkingConfig: { thinkingLevel: setting } };
    return 'generationConfig.thinkingConfig.thinkingLevel';
  }
  return null;
}

const NUMERIC = new Set(['temperature', 'topP', 'topK', 'maxOutputTokens', 'seed', 'frequencyPenalty', 'presencePenalty']);

export function parseParameters(values = {}) {
  const parsed = {};
  const rejected = [];
  for (const [name, value] of Object.entries(values)) {
    const spec = PARAMETERS[name];
    if (!spec) { rejected.push({ name, reason: 'Unknown parameter.' }); continue; }
    if (value === '' || value == null) continue;
    if (NUMERIC.has(name)) {
      const number = Number(value);
      if (!Number.isFinite(number)) { rejected.push({ name, reason: 'Not a number.' }); continue; }
      if (spec.type === 'integer' && !Number.isInteger(number)) { rejected.push({ name, reason: 'Not an integer.' }); continue; }
      if (spec.min != null && number < spec.min) { rejected.push({ name, reason: `Below ${spec.min}.` }); continue; }
      if (spec.max != null && number > spec.max) { rejected.push({ name, reason: `Above ${spec.max}.` }); continue; }
      parsed[name] = number;
    } else if (name === 'stop') {
      const list = Array.isArray(value) ? value : String(value).split('\n').map(item => item.trim()).filter(Boolean);
      if (list.length) parsed.stop = list;
    } else {
      parsed[name] = value;
    }
  }
  return { parsed, rejected };
}

export function describeProvenance(parsed, thinking, rejected) {
  const provenance = {};
  for (const [name, value] of Object.entries(parsed)) {
    provenance[name] = { value, source: 'form', wire: PARAMETERS[name]?.wire || name, evidence: PARAMETERS[name]?.evidence || 'unknown' };
  }
  if (thinking) {
    provenance.thinking = {
      value: thinking, source: 'form', wire: thinkingWireName('chat-completions'), evidence: 'observed'
    };
  }
  for (const item of rejected) provenance[item.name] = { source: 'rejected', reason: item.reason };
  return provenance;
}
