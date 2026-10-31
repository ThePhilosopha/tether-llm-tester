// Pure helpers for the Compare blind review flow. Kept free of React so the
// Node test suite can exercise the blinding rules directly.
// The category rubrics mirror lib/comparison/evaluate.mjs RUBRICS: the server
// falls back to them when a saved case carries no rubric of its own.

export const CATEGORY_RUBRICS = Object.freeze({
  copy: Object.freeze({ clarity: 25, audienceVoice: 25, specificity: 20, persuasion: 20, distinctiveness: 10 }),
  layout: Object.freeze({ hierarchy: 25, flow: 25, audienceFit: 20, assumptionHandling: 15, accessibility: 15 }),
  code: Object.freeze({ diagnosis: 40, solutionReasoning: 40, maintainability: 20 })
});

export const TERMINAL_STATUSES = Object.freeze(['complete', 'partial', 'cancelled', 'error', 'interrupted']);

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

export function blindLabel(assignments, attempt) {
  const labels = assignments?.[attempt.pairId] || { A: 'left', B: 'right' };
  return labels.A === attempt.side ? 'A' : 'B';
}

export function rubricFor(testCase) {
  if (testCase?.rubric && Object.keys(testCase.rubric).length) return testCase.rubric;
  return CATEGORY_RUBRICS[testCase?.category] || {};
}

export function isReviewed(attempt) {
  return attempt?.assessment?.reviewed === true;
}

export function pairReviewed(attempts) {
  const pairs = new Map();
  for (const attempt of attempts || []) {
    const list = pairs.get(attempt.pairId) || [];
    list.push(attempt);
    pairs.set(attempt.pairId, list);
  }
  if (!pairs.size) return false;
  return [...pairs.values()].every(pair =>
    ['left', 'right'].every(side => pair.find(item => item.side === side && isReviewed(item))));
}

export function allReviewed(attempts = []) {
  return attempts.length > 0 && attempts.every(isReviewed);
}

export function pairFinished(attempts) {
  return attempts.length === 2 && attempts.every(attempt => isTerminal(attempt.status));
}

export function dimensionLabel(dimension) {
  return dimension.replace(/[A-Z]/g, char => ` ${char.toLowerCase()}`);
}

export function missingScores(rubric, scores) {
  return Object.keys(rubric).filter(key => !Number.isInteger(scores[key]));
}

export function buildAssessment({ decision, scores, criticalFailure, reason, execution }) {
  const reviewed = decision !== 'pending';
  const status = execution?.status || 'unverified';
  return {
    reviewed,
    accepted: reviewed ? decision === 'accept' : null,
    criticalFailure: criticalFailure === true,
    scores: { ...scores },
    reason: (reason || '').trim(),
    execution: {
      status,
      evidence: status === 'unverified' ? null : {
        source: (execution?.source || '').trim(),
        date: execution?.date || '',
        notes: (execution?.notes || '').trim()
      }
    }
  };
}

export function validateAssessment(draft, rubric) {
  if (!draft.reviewed) return null;
  const missing = missingScores(rubric, draft.scores);
  if (missing.length) return `Score every rubric dimension before recording a decision. Missing: ${missing.join(', ')}.`;
  if (!draft.reason) return 'Add a reason before recording a decision.';
  if (draft.execution.status !== 'unverified') {
    if (!draft.execution.evidence.source) return 'Name the test source for the execution evidence.';
    if (!draft.execution.evidence.date) return 'Give the date of the execution evidence.';
    if (!draft.execution.evidence.notes) return 'Add notes for the execution evidence.';
  }
  return null;
}

export function validatePairAssessment(choice, reason) {
  if (!['A', 'B', 'tie', 'neither'].includes(choice)) return 'Choose A, B, tie or neither.';
  if (!(reason || '').trim()) return 'Add a reason for the preference.';
  return null;
}

export function validateVerdict(verdict, rationale) {
  if (!['replacement-supported', 'useful-with-review', 'not-supported', 'insufficient-evidence'].includes(verdict)) {
    return 'Choose a supported verdict.';
  }
  if (!(rationale || '').trim()) return 'Add a rationale for the replacement judgement.';
  return null;
}
