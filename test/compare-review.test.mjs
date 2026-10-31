import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allReviewed, blindLabel, buildAssessment, isTerminal, pairFinished, pairReviewed,
  rubricFor, validateAssessment, validatePairAssessment, validateVerdict
} from '../client/src/compareReview.js';

const rubric = { clarity: 25, audienceVoice: 25, specificity: 20, persuasion: 20, distinctiveness: 10 };

test('blind labels follow the pair assignment rather than the side', () => {
  const assignments = { 'pair-1': { A: 'right', B: 'left' } };
  assert.equal(blindLabel(assignments, { pairId: 'pair-1', side: 'right' }), 'A');
  assert.equal(blindLabel(assignments, { pairId: 'pair-1', side: 'left' }), 'B');
  assert.equal(blindLabel({}, { pairId: 'pair-1', side: 'left' }), 'A');
});

test('identity stays hidden until every response in the batch is reviewed', () => {
  const attempts = [
    { id: 'a1', pairId: 'p1', side: 'left', status: 'complete', assessment: { reviewed: true } },
    { id: 'a2', pairId: 'p1', side: 'right', status: 'complete', assessment: { reviewed: true } },
    { id: 'a3', pairId: 'p2', side: 'left', status: 'complete', assessment: null }
  ];
  assert.equal(allReviewed(attempts), false);
  assert.equal(pairReviewed(attempts.slice(0, 2)), true);
  assert.equal(pairReviewed(attempts), false);
  attempts[2].assessment = { reviewed: true };
  assert.equal(allReviewed(attempts), true);
  assert.equal(allReviewed([]), false);
});

test('a pair is only finished when both attempts reached a terminal status', () => {
  assert.equal(pairFinished([{ status: 'complete' }, { status: 'complete' }]), true);
  assert.equal(pairFinished([{ status: 'complete' }, { status: 'running' }]), false);
  assert.equal(pairFinished([{ status: 'complete' }]), false);
  assert.equal(isTerminal('interrupted'), true);
  assert.equal(isTerminal('running'), false);
});

test('the rubric falls back to the category default when the saved case has none', () => {
  assert.deepEqual(Object.keys(rubricFor({ category: 'copy', rubric: {} })), Object.keys(rubric));
  assert.deepEqual(Object.keys(rubricFor({ category: 'code', rubric: {} })), ['diagnosis', 'solutionReasoning', 'maintainability']);
  assert.deepEqual(rubricFor({ category: 'copy', rubric: { tone: 100 } }), { tone: 100 });
});

test('a reviewed assessment needs every rubric score and a reason', () => {
  const draft = buildAssessment({
    decision: 'accept', scores: { clarity: 4 }, criticalFailure: false, reason: '', execution: { status: 'unverified' }
  });
  const complaint = validateAssessment(draft, rubric);
  assert.match(complaint, /Score every rubric dimension/);
  const scored = buildAssessment({
    decision: 'accept', scores: { ...rubric, clarity: 4 }, criticalFailure: false, reason: 'Ready.', execution: { status: 'unverified' }
  });
  assert.equal(validateAssessment(scored, rubric), null);
});

test('a pending assessment stays pending and needs no score or reason', () => {
  const draft = buildAssessment({ decision: 'pending', scores: {}, criticalFailure: false, reason: '', execution: { status: 'unverified' } });
  assert.equal(draft.reviewed, false);
  assert.equal(draft.accepted, null);
  assert.equal(validateAssessment(draft, rubric), null);
});

test('execution evidence needs a source, a date and notes when it claims pass or fail', () => {
  const draft = buildAssessment({
    decision: 'reject', scores: { ...rubric, clarity: 4 }, criticalFailure: true, reason: 'Wrong.',
    execution: { status: 'fail', source: '', date: '', notes: '' }
  });
  assert.match(validateAssessment(draft, rubric), /test source/);
  const complete = buildAssessment({
    decision: 'reject', scores: { ...rubric, clarity: 4 }, criticalFailure: true, reason: 'Wrong.',
    execution: { status: 'fail', source: 'npm test', date: '2026-10-31', notes: 'Fails on the boundary case.' }
  });
  assert.equal(validateAssessment(complete, rubric), null);
});

test('pair preference and verdict both require a supported choice and a reason', () => {
  assert.match(validatePairAssessment('', 'why'), /Choose A, B, tie or neither/);
  assert.match(validatePairAssessment('A', '  '), /reason/);
  assert.equal(validatePairAssessment('tie', 'Same quality.'), null);
  assert.match(validateVerdict('maybe', 'why'), /supported verdict/);
  assert.match(validateVerdict('useful-with-review', ''), /rationale/);
  assert.equal(validateVerdict('insufficient-evidence', 'Two cases only.'), null);
});
