import { useEffect, useState } from 'react';
import {
  buildAssessment, dimensionLabel, rubricFor, validateAssessment, validatePairAssessment, validateVerdict
} from './compareReview.js';

function modelLabel(run, providers, side) {
  const model = run?.input?.[side];
  if (!model) return side;
  const provider = providers.find(item => item.id === model.providerId);
  return `${provider?.name || model.providerId} / ${model.modelId}`;
}

export function PairCard({ pair, run, providers, onSaveAssessment, onSavePair }) {
  const revealed = pair.revealed;
  return (
    <article className="panel">
      <header>
        <h2>{(pair.testCase?.category || 'case').toUpperCase()} · {pair.testCase?.title || pair.attempts[0]?.caseId}</h2>
        <span className="meta">Repetition {pair.attempts[0]?.repetition || 1} · {pair.pairId.slice(0, 8)}</span>
      </header>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {pair.order.map(attempt => {
          const label = pair.assignment.A === attempt.side ? 'A' : 'B';
          return (
            <section key={attempt.id} className="flex min-w-0 flex-col">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">{revealed ? modelLabel(run, providers, attempt.side) : `Response ${label}`}</h3>
                <span className={`pill ${attempt.status === 'complete' ? 'pos' : attempt.status === 'error' ? 'neg' : ''}`}>{attempt.status}</span>
              </div>
              <pre className="mono mt-2 h-56 overflow-auto whitespace-pre-wrap rounded bg-raised p-3 text-xs">
                {attempt.output || (isRunning(attempt.status) ? 'Waiting for response…' : 'No output.')}
              </pre>
              {revealed ? (
                <p className="mt-2 min-h-16 break-words text-xs text-ink-soft">
                  HTTP {attempt.responseStatus ?? 'unknown'} · Finish {attempt.finishReason || 'unknown'} · Total{' '}
                  {attempt.metrics?.totalMs ?? 'unknown'} ms · Usage{' '}
                  {attempt.usage ? JSON.stringify(attempt.usage) : 'unknown'}
                </p>
              ) : (
                <p className="mt-2 min-h-16 text-xs text-ink-soft">
                  Model identity, provider errors, request details, timing and pricing stay hidden until both
                  responses are reviewed.
                </p>
              )}
              {attempt.error && <p className="mt-2 text-xs text-bad">{revealed ? attempt.error : 'Failure details are hidden until both responses are reviewed.'}</p>}
              {pair.finished ? (
                <div className="flex-1">
                  <ReviewForm attempt={attempt} testCase={pair.testCase} onSave={onSaveAssessment} />
                </div>
              ) : (
                <p className="mt-3 text-xs text-ink-soft">Blind review opens after the whole batch finishes.</p>
              )}
            </section>
          );
        })}
      </div>
      {pair.finished && pair.pairReviewed && (
        <PairPreference pairId={pair.pairId} saved={run.pairAssessments?.[pair.pairId]} onSave={onSavePair} />
      )}
    </article>
  );
}

function isRunning(status) {
  return status === 'running' || status === 'queued';
}


function ScoreSelect({ dimension, value, onChange }) {
  return (
    <label className="field">
      <span>{dimensionLabel(dimension)}</span>
      <select className="input" value={value} onChange={event => onChange(event.target.value)}>
        <option value="">Not scored</option>
        {[0, 1, 2, 3, 4].map(score => <option key={score} value={score}>{score}</option>)}
      </select>
    </label>
  );
}

export function ReviewForm({ attempt, testCase, onSave }) {
  const rubric = rubricFor(testCase);
  const saved = attempt.assessment || {};
  const [decision, setDecision] = useState(saved.reviewed ? (saved.accepted ? 'accept' : 'reject') : 'pending');
  const [scores, setScores] = useState(saved.scores || {});
  const [criticalFailure, setCriticalFailure] = useState(saved.criticalFailure === true);
  const [reason, setReason] = useState(saved.reason || '');
  const [execution, setExecution] = useState({
    status: saved.execution?.status || 'unverified',
    source: saved.execution?.evidence?.source || '',
    date: saved.execution?.evidence?.date || '',
    notes: saved.execution?.evidence?.notes || ''
  });
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = attempt.assessment || {};
    setDecision(next.reviewed ? (next.accepted ? 'accept' : 'reject') : 'pending');
    setScores(next.scores || {});
    setCriticalFailure(next.criticalFailure === true);
    setReason(next.reason || '');
    setExecution({
      status: next.execution?.status || 'unverified',
      source: next.execution?.evidence?.source || '',
      date: next.execution?.evidence?.date || '',
      notes: next.execution?.evidence?.notes || ''
    });
  }, [attempt.id, attempt.assessment]);

  async function submit(event) {
    event.preventDefault();
    const draft = buildAssessment({ decision, scores, criticalFailure, reason, execution });
    const complaint = validateAssessment(draft, rubric);
    if (complaint) return setProblem(complaint);
    setProblem('');
    setSaving(true);
    try {
      await onSave({ attemptId: attempt.id, assessment: draft });
    } catch (err) {
      setProblem(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="mt-4 grid gap-3 border-t border-rule pt-3" onSubmit={submit}>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="field">
          <span>Decision</span>
          <select className="input" value={decision} onChange={event => setDecision(event.target.value)}>
            <option value="pending">Pending review</option>
            <option value="accept">Accept</option>
            <option value="reject">Reject</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <input type="checkbox" checked={criticalFailure} onChange={event => setCriticalFailure(event.target.checked)} />
          Record a critical failure
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Object.keys(rubric).map(dimension => (
          <ScoreSelect key={dimension} dimension={dimension} value={scores[dimension] ?? ''}
            onChange={value => setScores({ ...scores, [dimension]: value === '' ? undefined : Number(value) })} />
        ))}
      </div>
      <label className="field">
        <span>Reason for this decision</span>
        <textarea className="input" rows={3} value={reason} onChange={event => setReason(event.target.value)} />
      </label>
      {testCase?.category === 'code' && (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="field">
            <span>Execution evidence (external, user supplied)</span>
            <select className="input" value={execution.status} onChange={event => setExecution({ ...execution, status: event.target.value })}>
              <option value="unverified">Not execution-verified</option>
              <option value="pass">External test passed</option>
              <option value="fail">External test failed</option>
            </select>
          </label>
          <label className="field">
            <span>Test source or tool</span>
            <input className="input" value={execution.source} onChange={event => setExecution({ ...execution, source: event.target.value })} />
          </label>
          <label className="field">
            <span>Test date</span>
            <input className="input" type="date" value={execution.date} onChange={event => setExecution({ ...execution, date: event.target.value })} />
          </label>
          <label className="field">
            <span>Evidence notes</span>
            <textarea className="input" rows={2} value={execution.notes} onChange={event => setExecution({ ...execution, notes: event.target.value })} />
          </label>
        </div>
      )}
      {problem && <p className="text-bad">{problem}</p>}
      <div>
        <button type="submit" className="btn" disabled={saving}>{saving ? 'Saving…' : 'Save blind review'}</button>
      </div>
    </form>
  );
}

export function PairPreference({ pairId, saved, onSave }) {
  const [choice, setChoice] = useState(saved?.choice || '');
  const [reason, setReason] = useState(saved?.reason || '');
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setChoice(saved?.choice || '');
    setReason(saved?.reason || '');
  }, [pairId, saved?.choice, saved?.reason]);

  async function submit(event) {
    event.preventDefault();
    const complaint = validatePairAssessment(choice, reason);
    if (complaint) return setProblem(complaint);
    setProblem('');
    setSaving(true);
    try {
      await onSave({ pairId, choice, reason: reason.trim() });
    } catch (err) {
      setProblem(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="mt-4 grid gap-3 border-t border-rule pt-3 md:grid-cols-[180px_minmax(0,1fr)_auto] md:items-end" onSubmit={submit}>
      <label className="field">
        <span>Blind pair preference</span>
        <select className="input" value={choice} onChange={event => setChoice(event.target.value)}>
          <option value="">Choose A, B, tie or neither</option>
          {['A', 'B', 'tie', 'neither'].map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Reason</span>
        <textarea className="input" rows={2} value={reason} onChange={event => setReason(event.target.value)} />
      </label>
      <div className="grid gap-2">
        <button type="submit" className="btn" disabled={saving}>{saving ? 'Saving…' : saved ? 'Update preference' : 'Save preference'}</button>
        {problem && <p className="text-bad">{problem}</p>}
      </div>
    </form>
  );
}

export function VerdictForm({ run, onSave }) {
  const saved = run.verdict || {};
  const [verdict, setVerdict] = useState(saved.value || '');
  const [evidenceCount, setEvidenceCount] = useState(saved.evidenceCount ?? 0);
  const [rationale, setRationale] = useState(saved.rationale || '');
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setVerdict(run.verdict?.value || '');
    setEvidenceCount(run.verdict?.evidenceCount ?? 0);
    setRationale(run.verdict?.rationale || '');
  }, [run.id, run.verdict?.value, run.verdict?.evidenceCount, run.verdict?.rationale]);

  async function submit(event) {
    event.preventDefault();
    const complaint = validateVerdict(verdict, rationale);
    if (complaint) return setProblem(complaint);
    setProblem('');
    setSaving(true);
    try {
      await onSave({ verdict, rationale: rationale.trim(), evidenceCount: Number(evidenceCount) || 0 });
    } catch (err) {
      setProblem(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="grid gap-3" onSubmit={submit}>
      <div className="grid gap-3 md:grid-cols-[minmax(0,320px)_140px]">
        <label className="field">
          <span>Replacement verdict</span>
          <select className="input" value={verdict} onChange={event => setVerdict(event.target.value)}>
            <option value="">Choose a verdict</option>
            <option value="replacement-supported">Replacement supported</option>
            <option value="useful-with-review">Useful with review</option>
            <option value="not-supported">Not supported</option>
            <option value="insufficient-evidence">Insufficient evidence</option>
          </select>
        </label>
        <label className="field">
          <span>Evidence count</span>
          <input className="input" type="number" min={0} value={evidenceCount} onChange={event => setEvidenceCount(event.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Rationale</span>
        <textarea className="input" rows={3} value={rationale} onChange={event => setRationale(event.target.value)} />
      </label>
      {problem && <p className="text-bad">{problem}</p>}
      <div>
        <button type="submit" className="btn primary" disabled={saving}>{saving ? 'Saving…' : 'Save verdict'}</button>
      </div>
    </form>
  );
}
