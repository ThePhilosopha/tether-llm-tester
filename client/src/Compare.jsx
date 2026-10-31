import { useEffect, useMemo, useState } from 'react';
import api from './api.js';

const COMPARABLE = new Set(['ollama-cloud', 'opencode-go', 'openrouter']);

function percent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'unknown';
}

export default function Compare({ providers }) {
  const comparable = providers.filter(provider => COMPARABLE.has(provider.presetId));
  const [catalogue, setCatalogue] = useState([]);
  const [cases, setCases] = useState([]);
  const [selectedCases, setSelectedCases] = useState(new Set());
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [settings, setSettings] = useState({ temperature: 0.7, topP: 1, maxOutputTokens: 2048, timeoutMs: 120000, stream: true });
  const [repetitions, setRepetitions] = useState(1);
  const [baselineSide, setBaselineSide] = useState('');
  const [preflight, setPreflight] = useState(null);
  const [run, setRun] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('');
  const [history, setHistory] = useState([]);

  async function loadCatalogue() {
    const results = await Promise.all(comparable.map(async provider => {
      try {
        const result = await api.comparisonModels(provider.id);
        return (result.models || []).map(model => ({ ...model, providerName: provider.name }));
      } catch { return []; }
    }));
    setCatalogue(results.flat());
  }

  async function loadHistory() {
    try { setHistory((await api.listComparisons()).runs || []); } catch { /* history is secondary */ }
  }

  useEffect(() => {
    loadCatalogue();
    api.cases().then(result => {
      const items = result.cases || [];
      setCases(items);
      setSelectedCases(new Set(items.filter(item => !item.holdout).map(item => `${item.id}@${item.version}`)));
    }).catch(err => setError(err.message));
    loadHistory();
  }, []);

  const leftModel = catalogue.find(model => key(model) === left);
  const rightModel = catalogue.find(model => key(model) === right);

  function key(model) { return `${model.providerId}|${model.modelId}`; }

  function currentInput() {
    if (!leftModel || !rightModel) throw new Error('Choose one model on each side.');
    const chosen = cases.filter(item => selectedCases.has(`${item.id}@${item.version}`));
    if (!chosen.length) throw new Error('Select at least one case.');
    return {
      caseVersions: chosen,
      left: leftModel,
      right: rightModel,
      baselineSide: baselineSide || null,
      settings,
      repetitions,
      exploratoryConfirmed: true
    };
  }

  async function checkPreflight() {
    setError(null); setStatus('Checking compatibility…');
    try {
      const result = await api.preflight(currentInput());
      setPreflight(result);
      setStatus(`${result.pairs} paired cases · ${result.requestCount} model requests · parameter equivalence ${result.parameterEquivalence}.`);
    } catch (err) {
      setPreflight(null); setStatus(''); setError(err.message);
    }
  }

  async function startRun() {
    setError(null); setStatus('Starting the batch…');
    try {
      const result = await api.startComparison({
        input: currentInput(),
        submissionId: crypto.randomUUID()
      });
      setRun(result);
      setPreflight(null);
      setStatus('Batch queued.');
      await loadHistory();
    } catch (err) { setStatus(''); setError(err.message); }
  }

  useEffect(() => {
    if (!run?.id) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const record = await api.comparison(run.id);
        if (cancelled) return;
        setRun(record);
        if (!['queued', 'running'].includes(record.status)) {
          const result = await api.comparisonReport(record.id);
          if (!cancelled) setReport(result);
          loadHistory();
          return;
        }
      } catch (err) { if (!cancelled) setError(err.message); return; }
      setTimeout(poll, 1500);
    };
    poll();
    return () => { cancelled = true; };
  }, [run?.id]);

  const grouped = useMemo(() => (report?.groups || []).map(group => ({
    key: group.key,
    category: group.category,
    title: group.caseTitle,
    left: group.sides?.left,
    right: group.sides?.right,
    latency: group.latency,
    quality: group.quality
  })), [report]);

  const toggleCase = id => {
    setSelectedCases(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setPreflight(null);
  };

  return (
    <div className="stack">
      <div>
        <div className="canvas-head">
          <h1>Compare</h1>
          <span className="scope">Paired model evaluation</span>
        </div>
        <p className="canvas-sub">
          Both sides receive the same case and the same settings. Model identity stays hidden until every
          response has been reviewed, so the judgement is made on the output alone.
        </p>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: 'var(--color-bad)' }}>
          <header><h2>Request failed</h2></header>
          <p style={{ color: 'var(--color-bad)' }}>{error}</p>
        </div>
      )}

      <section className="panel">
        <header><h2>Model pair</h2><span className="meta">{comparable.length} comparable providers</span></header>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="field">
            <span>Left model</span>
            <select className="input" value={left} onChange={event => { setLeft(event.target.value); setPreflight(null); }}>
              <option value="">Choose a model</option>
              {catalogue.filter(model => model.available).map(model => (
                <option key={key(model)} value={key(model)}>{model.providerName} / {model.modelId}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Right model</span>
            <select className="input" value={right} onChange={event => { setRight(event.target.value); setPreflight(null); }}>
              <option value="">Choose a model</option>
              {catalogue.filter(model => model.available).map(model => (
                <option key={key(model)} value={key(model)}>{model.providerName} / {model.modelId}</option>
              ))}
            </select>
          </label>
        </div>
        {catalogue.length === 0 && (
          <p className="mt-3" style={{ color: 'var(--color-ink-soft)', fontSize: 'var(--fs-small)' }}>
            No comparable models discovered. Add an Ollama Cloud, OpenRouter or OpenCode Go provider with a key.
          </p>
        )}
      </section>

      <section className="panel">
        <header><h2>Shared settings</h2><span className="meta">one parameter set for both sides</span></header>
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {[
            ['temperature', 'Temperature', 0, 2, 0.1],
            ['topP', 'Top-P', 0.01, 1, 0.01],
            ['maxOutputTokens', 'Max output tokens', 1, undefined, 1],
            ['timeoutMs', 'Timeout (ms)', 1000, undefined, 1000],
            ['repetitions', 'Repetitions', 1, 20, 1]
          ].map(([key, label, min, max, step]) => (
            <label key={key} className="field">
              <span>{label}</span>
              <input className="input" type="number" min={min} max={max} step={step}
                value={settings[key] ?? repetitions}
                onChange={event => {
                  const value = Number(event.target.value);
                  if (key === 'repetitions') setRepetitions(value);
                  else setSettings({ ...settings, [key]: value });
                }} />
            </label>
          ))}
          <label className="field">
            <span>Baseline side</span>
            <select className="input" value={baselineSide} onChange={event => setBaselineSide(event.target.value)}>
              <option value="">Not specified</option>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </label>
        </div>
      </section>

      <section className="panel">
        <header>
          <h2>Test cases</h2>
          <span className="meta">{selectedCases.size} selected of {cases.length}</span>
        </header>
        {cases.length === 0 ? (
          <div className="empty">No cases are saved yet. Create one from the Skills workspace.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Case</th><th>Category</th><th>Version</th><th>Holdout</th><th>Use</th></tr>
              </thead>
              <tbody>
                {cases.map(item => {
                  const id = `${item.id}@${item.version}`;
                  return (
                    <tr key={id}>
                      <td>{item.title}</td>
                      <td>{item.category}</td>
                      <td className="n">{item.version}</td>
                      <td>{item.holdout ? 'yes' : 'no'}</td>
                      <td>
                        <input type="checkbox" checked={selectedCases.has(id)} onChange={() => toggleCase(id)}
                          aria-label={`Use ${item.title}`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="btn" onClick={checkPreflight}>Check compatibility</button>
          <button type="button" className="btn primary" onClick={startRun} disabled={!preflight}>Run both models</button>
          <span style={{ color: 'var(--color-ink-soft)', fontSize: 'var(--fs-small)' }}>{status}</span>
        </div>
      </section>

      {run && (
        <section className="panel">
          <header>
            <h2>Batch</h2>
            <span className="meta">{run.status} · {run.attempts?.length || 0} attempts</span>
          </header>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Side</th><th>Case</th><th>Status</th><th className="n">Output chars</th><th className="n">Latency</th><th>Reason</th></tr>
              </thead>
              <tbody>
                {(run.attempts || []).map(attempt => (
                  <tr key={attempt.id}>
                    <td>{attempt.side === 'left' ? 'Left' : 'Right'}</td>
                    <td className="mono">{attempt.caseId}@{attempt.caseVersion}</td>
                    <td><span className={`pill ${attempt.status === 'complete' ? 'pos' : attempt.status === 'error' ? 'neg' : ''}`}>{attempt.status}</span></td>
                    <td className="n">{(attempt.output || '').length}</td>
                    <td className="n">{attempt.metrics?.totalMs ? `${Math.round(attempt.metrics.totalMs)} ms` : '—'}</td>
                    <td className="truncate">{attempt.error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {grouped.length > 0 && (
        <section className="panel">
          <header><h2>Evidence</h2><span className="meta">{grouped.length} groups</span></header>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Case</th><th className="n">Left completion</th><th className="n">Right completion</th><th className="n">Median latency</th><th className="n">Quality</th></tr>
              </thead>
              <tbody>
                {grouped.map(group => (
                  <tr key={group.key}>
                    <td>{group.title || group.category}</td>
                    <td className="n">{percent(group.left?.operationalSuccessRate)}</td>
                    <td className="n">{percent(group.right?.operationalSuccessRate)}</td>
                    <td className="n">{group.latency ? `${Math.round(group.latency.medianMs)} ms` : '—'}</td>
                    <td className="n">{group.quality ? `${group.quality.median}/4` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel">
        <header><h2>Recent runs</h2><span className="meta">{history.length} rows</span></header>
        {history.length === 0 ? (
          <div className="empty">No comparison runs yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Run</th><th>Category</th><th className="n">Cases</th><th className="n">Attempts</th><th>Status</th><th>Started</th></tr>
              </thead>
              <tbody>
                {history.map(item => (
                  <tr key={item.id}>
                    <td className="mono">{item.id.slice(0, 8)}</td>
                    <td>{item.category}</td>
                    <td className="n">{item.caseCount}</td>
                    <td className="n">{item.attempts}</td>
                    <td><span className={`pill ${item.status === 'complete' ? 'pos' : ''}`}>{item.status}</span></td>
                    <td className="truncate">{new Date(item.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
