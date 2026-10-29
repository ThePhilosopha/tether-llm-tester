export const PROTOCOLS = new Set([
  'chat-completions',
  'responses',
  'anthropic-messages',
  'google-generate-content'
]);

export function isLoopbackHost(hostname) {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
}

const CATEGORIES = new Set(['copy', 'layout', 'code']);
const PARAMETERS = ['temperature', 'topP', 'maxOutputTokens'];
const ASSERTION_TYPES = new Set(['json-valid', 'array-length', 'word-count', 'includes', 'excludes']);
const ASSERTION_SEVERITIES = new Set(['critical', 'major', 'minor']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!object(value) && !Array.isArray(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function canonicalModel(selection, catalogue, side) {
  if (!object(selection)) throw new Error(`${side} model is required.`);
  const model = catalogue.find(item =>
    item.providerId === selection.providerId &&
    item.modelId === selection.modelId
  );
  if (!model) throw new Error(`${side} model is unavailable.`);
  if (!PROTOCOLS.has(model.protocol)) {
    throw new Error(`${side} model protocol is unsupported.`);
  }
  let endpoint;
  try { endpoint = new URL(model.endpoint); }
  catch { throw new Error(`${side} model endpoint is invalid.`); }
  if (endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && isLoopbackHost(endpoint.hostname))) {
    throw new Error(`${side} model endpoint must use HTTPS or loopback HTTP.`);
  }
  const parameters = {};
  for (const name of PARAMETERS) {
    const support = model.capabilities?.parameters?.[name] || 'unknown';
    if (!['supported', 'unsupported', 'unknown'].includes(support)) {
      throw new Error(`${side} has invalid ${name} capability metadata.`);
    }
    parameters[name] = support;
  }
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    protocol: model.protocol,
    endpoint: endpoint.toString(),
    capabilities: { parameters },
    capabilitySource: model.capabilitySource || 'unknown',
    capabilityCheckedAt: model.capabilityCheckedAt || null,
    route: typeof model.route === 'string' ? model.route : null,
    pricing: object(model.pricing) ? structuredClone(model.pricing) : null,
    pricingObservedAt: typeof model.pricingObservedAt === 'string' ? model.pricingObservedAt : null,
    pricingSource: typeof model.pricingSource === 'string' ? model.pricingSource : null
  };
}

export function validateCaseVersion(value) {
  if (!object(value)) throw new Error('Test case must be an object.');
  const id = requiredString(value.id, 'Case ID');
  const title = requiredString(value.title, 'Case title');
  const prompt = requiredString(value.prompt, 'Prompt');
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    throw new Error('Case version must be a positive integer.');
  }
  if (!CATEGORIES.has(value.category)) throw new Error('Invalid test category.');
  if (value.system !== undefined && typeof value.system !== 'string') {
    throw new Error('System instructions must be text.');
  }
  const assertions = validateAssertions(value.assertions);
  if (value.rubric !== undefined && !object(value.rubric)) {
    throw new Error('Rubric must be an object.');
  }
  return {
    id, version: value.version, category: value.category, title,
    system: value.system || '', prompt,
    assertions,
    rubric: structuredClone(value.rubric || {}),
    holdout: value.holdout === true
  };
}

export function validateAssertions(value) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Assertions must be an array of at most 100 rules.');
  return value.map(assertion => {
    if (!object(assertion) || !ASSERTION_TYPES.has(assertion.type)) throw new Error('Assertion type is unsupported.');
    const severity = assertion.severity || 'major';
    if (!ASSERTION_SEVERITIES.has(severity)) throw new Error('Assertion severity must be critical, major or minor.');
    if (assertion.type === 'array-length') {
      if (!Array.isArray(assertion.path) || assertion.path.length > 20 ||
          assertion.path.some(key => typeof key !== 'string' || !key || key.length > 256) ||
          !Number.isSafeInteger(assertion.value) || assertion.value < 0) {
        throw new Error('Array-length assertions require literal object keys and a non-negative length.');
      }
      return { type: assertion.type, path: [...assertion.path], value: assertion.value, severity };
    }
    if (assertion.type === 'word-count') {
      if (!Number.isSafeInteger(assertion.min) || !Number.isSafeInteger(assertion.max) ||
          assertion.min < 0 || assertion.max < assertion.min) {
        throw new Error('Word-count assertions require inclusive non-negative minimum and maximum values.');
      }
      return { type: assertion.type, min: assertion.min, max: assertion.max, severity };
    }
    if (assertion.type === 'includes' || assertion.type === 'excludes') {
      if (typeof assertion.value !== 'string' || !assertion.value || assertion.value.length > 1000) {
        throw new Error(`${assertion.type} assertions require non-empty text of at most 1000 characters.`);
      }
      return { type: assertion.type, value: assertion.value, severity };
    }
    return { type: assertion.type, severity };
  });
}

export function validateRunInput(value, modelCatalogue) {
  if (!object(value) || !Array.isArray(modelCatalogue)) {
    throw new Error('Comparison input and model catalogue are required.');
  }
  if (!Array.isArray(value.caseVersions) || value.caseVersions.length === 0) {
    throw new Error('Select at least one test case.');
  }
  const cases = value.caseVersions.map(validateCaseVersion);
  const identities = cases.map(item => `${item.id}@${item.version}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error('A case version can only appear once in a comparison.');
  }
  if (!Number.isInteger(value.repetitions) ||
      value.repetitions < 1 || value.repetitions > 20) {
    throw new Error('Repetitions must be an integer from 1 to 20.');
  }
  if (cases.length * value.repetitions > 200) {
    throw new Error('A comparison cannot contain more than 200 pairs.');
  }
  if (!object(value.settings)) throw new Error('Shared settings are required.');
  const settings = {
    temperature: value.settings.temperature,
    topP: value.settings.topP,
    maxOutputTokens: value.settings.maxOutputTokens,
    stream: value.settings.stream,
    timeoutMs: value.settings.timeoutMs
  };
  if (!Number.isFinite(settings.temperature) ||
      settings.temperature < 0 || settings.temperature > 2) {
    throw new Error('Temperature must be from 0 to 2.');
  }
  if (!Number.isFinite(settings.topP) ||
      settings.topP <= 0 || settings.topP > 1) {
    throw new Error('Top-P must be greater than 0 and at most 1.');
  }
  if (!Number.isSafeInteger(settings.maxOutputTokens) ||
      settings.maxOutputTokens < 1) {
    throw new Error('Maximum output tokens must be a positive integer.');
  }
  if (typeof settings.stream !== 'boolean') {
    throw new Error('Stream must be true or false.');
  }
  if (!Number.isSafeInteger(settings.timeoutMs) ||
      settings.timeoutMs < 1000 || settings.timeoutMs > 600000) {
    throw new Error('Timeout must be from 1000 to 600000 milliseconds.');
  }
  if (![null, 'left', 'right'].includes(value.baselineSide)) {
    throw new Error('Baseline side must be left, right or null.');
  }
  const left = canonicalModel(value.left, modelCatalogue, 'Left');
  const right = canonicalModel(value.right, modelCatalogue, 'Right');
  const unknown = [left, right].some(model =>
    PARAMETERS.some(name => model.capabilities.parameters[name] === 'unknown')
  );
  if (unknown && value.exploratoryConfirmed !== true) {
    throw new Error('Unknown parameter support requires exploratory confirmation.');
  }
  for (const model of [left, right]) {
    for (const name of PARAMETERS) {
      if (model.capabilities.parameters[name] === 'unsupported') {
        throw new Error(`${name} is unsupported by ${model.modelId}.`);
      }
    }
  }
  return {
    caseVersions: cases,
    left,
    right,
    baselineSide: value.baselineSide,
    settings,
    repetitions: value.repetitions,
    exploratoryConfirmed: value.exploratoryConfirmed === true,
    pricing: {
      left: { value: left.pricing, observedAt: left.pricingObservedAt, source: left.pricingSource },
      right: { value: right.pricing, observedAt: right.pricingObservedAt, source: right.pricingSource }
    }
  };
}

export function freezeRunInput(value) {
  return deepFreeze(structuredClone(value));
}
