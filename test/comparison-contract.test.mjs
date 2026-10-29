import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freezeRunInput, validateCaseVersion, validateRunInput } from '../lib/comparison/contract.mjs';

const DEFAULT_SETTINGS = Object.freeze({
  temperature: 0.7, topP: 1, maxOutputTokens: 2048, stream: true, timeoutMs: 120000
});

const supported = {
  temperature: 'supported',
  topP: 'supported',
  maxOutputTokens: 'supported'
};

function model(modelId, parameters = supported) {
  return {
    providerId: 'mock',
    modelId,
    protocol: 'chat-completions',
    endpoint: 'https://mock.example/v1',
    capabilities: { parameters },
    capabilitySource: 'fixture'
  };
}

const catalogue = [model('a'), model('b')];
const caseVersion = {
  id: 'copy-1', version: 1, category: 'copy',
  title: 'Three variations', system: '',
  prompt: 'Write exactly three variations.',
  assertions: [{ type: 'array-length', path: ['variations'], value: 3 }],
  rubric: {}, holdout: false
};

function input(overrides = {}) {
  return {
    caseVersions: [caseVersion],
    left: { providerId: 'mock', modelId: 'a' },
    right: { providerId: 'mock', modelId: 'b' },
    baselineSide: null,
    settings: { ...DEFAULT_SETTINGS },
    repetitions: 1,
    exploratoryConfirmed: false,
    ...overrides
  };
}

test('uses one validated shared parameter set for both sides', () => {
  const run = validateRunInput(input(), catalogue);
  assert.deepEqual(run.settings, DEFAULT_SETTINGS);
  assert.equal(run.left.capabilities.parameters.topP, 'supported');
  assert.equal(run.right.capabilities.parameters.topP, 'supported');
});

test('rejects a parameter unsupported by either selected model', () => {
  const models = [model('a'), model('b', { ...supported, topP: 'unsupported' })];
  assert.throws(() => validateRunInput(input(), models), /topP is unsupported/);
});

test('requires explicit confirmation when parameter support is unknown', () => {
  const models = [model('a'), model('b', { ...supported, topP: 'unknown' })];
  assert.throws(() => validateRunInput(input(), models), /exploratory confirmation/);
  assert.equal(
    validateRunInput(input({ exploratoryConfirmed: true }), models)
      .exploratoryConfirmed,
    true
  );
});

test('freezes a defensive snapshot without freezing the source', () => {
  const source = input();
  const snapshot = freezeRunInput(source);
  assert.notEqual(snapshot, source);
  assert.ok(Object.isFrozen(snapshot.settings));
  assert.ok(Object.isFrozen(snapshot.caseVersions[0].assertions[0]));
  assert.equal(Object.isFrozen(source.settings), false);
});

test('validates bounds, model membership, category and required prompt', () => {
  assert.throws(() => validateRunInput(input({
    settings: { ...DEFAULT_SETTINGS, temperature: NaN }
  }), catalogue), /Temperature/);
  assert.throws(() => validateRunInput(input({
    settings: { ...DEFAULT_SETTINGS, topP: Infinity }
  }), catalogue), /Top-P/);
  assert.throws(() => validateRunInput(input({ repetitions: 0 }), catalogue), /Repetitions/);
  assert.throws(() => validateRunInput(input({
    left: { providerId: 'mock', modelId: 'missing' }
  }), catalogue), /unavailable/);
  assert.throws(() => validateCaseVersion({ ...caseVersion, category: 'other' }), /category/);
  assert.throws(() => validateCaseVersion({ ...caseVersion, prompt: ' ' }), /Prompt/);
  assert.throws(() => validateRunInput(input({
    caseVersions: Array.from({ length: 11 }, (_, i) =>
      ({ ...caseVersion, id: `case-${i}` })),
    repetitions: 19
  }), catalogue), /200 pairs/);
});
