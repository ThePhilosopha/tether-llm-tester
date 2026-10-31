import { useEffect, useState } from 'react';
import api from './api.js';

export default function Audit() {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.listComparisons()
      .then(data => { if (!cancelled) setRuns(data.runs || []); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="stack">
      <div>
        <div className="canvas-head">
          <h1>Audit trail</h1>
          <span className="scope">Every comparison run on this machine</span>
        </div>
        <p className="canvas-sub">
          Runs are stored locally. A run keeps the exact model pair, settings, case versions and the
          human review that followed it.
        </p>
      </div>

      <div className="kpis">
        <div className="kpi">
          <p className="kpi-label">Runs</p>
          <p className="kpi-value">{loading ? '—' : runs.length}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Complete</p>
          <p className="kpi-value">{runs.filter(run => run.status === 'complete').length}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Reviewed</p>
          <p className="kpi-value">{runs.filter(run => run.verdict).length}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Attempts</p>
          <p className="kpi-value">{runs.reduce((sum, run) => sum + (run.attempts || 0), 0)}</p>
        </div>
      </div>

      <section className="panel">
        <header><h2>Comparison runs</h2><span className="meta">{loading ? 'Loading' : `${runs.length} rows`}</span></header>
        {error && <div className="empty" style={{ borderStyle: 'solid', color: 'var(--color-bad)' }}>{error}</div>}
        {!error && loading && <div className="skeleton" style={{ height: 120 }} />}
        {!error && !loading && runs.length === 0 && (
          <div className="empty">No comparison runs yet. Start one from the Compare workspace.</div>
        )}
        {!error && !loading && runs.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Category</th>
                  <th className="n">Cases</th>
                  <th className="n">Repetitions</th>
                  <th className="n">Attempts</th>
                  <th>Status</th>
                  <th>Verdict</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(run => (
                  <tr key={run.id}>
                    <td><span className="mono">{run.id.slice(0, 8)}</span></td>
                    <td>{run.category}</td>
                    <td className="n">{run.caseCount}</td>
                    <td className="n">{run.repetitions}</td>
                    <td className="n">{run.attempts}</td>
                    <td><span className={`pill ${run.status === 'complete' ? 'pos' : run.status === 'error' ? 'neg' : ''}`}>{run.status}</span></td>
                    <td>{run.verdict?.value || '—'}</td>
                    <td className="truncate">{new Date(run.createdAt).toLocaleString()}</td>
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