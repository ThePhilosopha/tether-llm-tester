import { useEffect, useState } from 'react';
import api from './api.js';

export default function Models({ providers, providerId }) {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [inspected, setInspected] = useState(null);

  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.models(providerId)
      .then(result => { if (!cancelled) setModels(result.data || []); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [providerId]);

  const provider = providers.find(item => item.id === providerId);

  async function inspect(modelId) {
    setError(null);
    try {
      setInspected(await api.inspect(providerId, modelId));
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="stack">
      <div>
        <div className="canvas-head">
          <h1>Model inventory</h1>
          <span className="scope">{provider?.name || 'No provider'}</span>
        </div>
        <p className="canvas-sub">
          Live discovery for {provider?.baseUrl || 'the selected provider'}. Capability values stay explicit
          when the provider does not publish them.
        </p>
      </div>

      <div className="kpis">
        <div className="kpi">
          <p className="kpi-label">Models</p>
          <p className="kpi-value">{loading ? '—' : models.length}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">With tool support</p>
          <p className="kpi-value">{models.filter(m => m.capabilities?.tools === 'yes').length}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">With reasoning</p>
          <p className="kpi-value">{models.filter(m => m.capabilities?.reasoning === 'yes').length}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Context published</p>
          <p className="kpi-value">{models.filter(m => m.context).length}</p>
        </div>
      </div>

      <section className="panel">
        <header>
          <h2>Discovered models</h2>
          <span className="meta">{loading ? 'Loading' : `${models.length} rows`}</span>
        </header>
        {error && <div className="empty" style={{ borderStyle: 'solid', color: 'var(--color-bad)' }}>{error}</div>}
        {!error && loading && (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 20, width: `${70 - i * 8}%` }} />)}
          </div>
        )}
        {!error && !loading && models.length === 0 && (
          <div className="empty">No models discovered for this provider.</div>
        )}
        {!error && !loading && models.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Owner</th>
                  <th className="n">Context</th>
                  <th>Tools</th>
                  <th>Vision</th>
                  <th>Reasoning</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {models.map(model => (
                  <tr key={model.id}>
                    <td><span className="mono">{model.id}</span></td>
                    <td className="truncate">{model.ownedBy || '—'}</td>
                    <td className="n">{model.context ?? '—'}</td>
                    <td>{model.capabilities?.tools ?? 'unknown'}</td>
                    <td>{model.capabilities?.vision ?? 'unknown'}</td>
                    <td>{model.capabilities?.reasoning ?? 'unknown'}</td>
                    <td>
                      <button type="button" className="btn ghost" onClick={() => inspect(model.id)}>Inspect</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {inspected && (
        <section className="panel">
          <header>
            <h2>{inspected.modelId}</h2>
            <span className="meta">{inspected.source === 'none' ? 'No native metadata' : 'Ollama native API'}</span>
          </header>
          {inspected.gaps?.length > 0 && (
            <ul className="m-0 mb-4 pl-5 text-ink-soft" style={{ fontSize: 'var(--fs-small)' }}>
              {inspected.gaps.map(gap => <li key={gap}>{gap}</li>)}
            </ul>
          )}
          {inspected.fields?.thinking && (
            <p className="mb-2 text-ink-soft" style={{ fontSize: 'var(--fs-small)' }}>
              Thinking effort: {inspected.fields.thinking.values.join(', ')} · default {inspected.fields.thinking.default || 'none'}
            </p>
          )}
          {inspected.fields?.capabilities?.length > 0 && (
            <p className="mb-4 text-ink-soft" style={{ fontSize: 'var(--fs-small)' }}>
              Capabilities: {inspected.fields.capabilities.join(', ')}
            </p>
          )}
          {inspected.fields?.modelfile && (
            <details>
              <summary className="text-ink-soft" style={{ fontSize: 'var(--fs-small)' }}>Modelfile</summary>
              <pre className="mono mt-2 max-h-72 overflow-auto rounded-md p-3 text-ink-soft" style={{ fontSize: 'var(--fs-small)', background: 'var(--color-raised)' }}>
                {inspected.fields.modelfile}
              </pre>
            </details>
          )}
        </section>
      )}
    </div>
  );
}