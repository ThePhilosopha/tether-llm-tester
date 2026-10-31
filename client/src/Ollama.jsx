import { useEffect, useState } from 'react';
import api from './api.js';
import Ico from './Ico.jsx';

export default function Ollama() {
  const [status, setStatus] = useState(null);
  const [installed, setInstalled] = useState([]);
  const [running, setRunning] = useState([]);
  const [pullName, setPullName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  async function refresh() {
    setError(null);
    try {
      const [version, models, loaded] = await Promise.all([
        api.ollamaStatus(), api.ollamaModels(), api.ollamaRunning()
      ]);
      setStatus(version);
      setInstalled(models.models || []);
      setRunning(loaded.models || []);
    } catch (err) { setError(err.message); }
  }

  useEffect(() => { refresh(); }, []);

  async function act(work, message) {
    setError(null); setBusy(true);
    try { await work(); setNotice(message); await refresh(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const totalBytes = installed.reduce((sum, model) => sum + (model.size || 0), 0);

  return (
    <div className="stack">
      <div>
        <div className="canvas-head">
          <h1>Ollama</h1>
          <span className="scope">Local model control plane</span>
        </div>
        <p className="canvas-sub">
          The native API is used for reads. Pull, delete and stop are confirmed before they run, and no
          command passes through a shell.
        </p>
      </div>

      <div className="kpis">
        <div className="kpi">
          <p className="kpi-label">Server version</p>
          <p className="kpi-value mono">{status?.version || (error ? 'unreachable' : '—')}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Installed models</p>
          <p className="kpi-value">{installed.length}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Running now</p>
          <p className="kpi-value">{running.length}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Installed size</p>
          <p className="kpi-value">{totalBytes ? `${(totalBytes / 1e9).toFixed(1)}<small>GB</small>` : '—'}</p>
        </div>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: 'var(--color-bad)' }}>
          <header><h2>Request failed</h2><span className="meta">the local server</span></header>
          <p style={{ color: 'var(--color-bad)' }}>{error}</p>
        </div>
      )}
      {notice && !error && (
        <div className="panel">
          <header><h2>Last action</h2></header>
          <p style={{ color: 'var(--color-ink-soft)' }}>{notice}</p>
        </div>
      )}

      <section className="panel">
        <header>
          <h2>Installed models</h2>
          <span className="meta">{installed.length} rows</span>
        </header>
        {installed.length === 0 ? (
          <div className="empty">No models are installed on the local server.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Family</th>
                  <th className="n">Size</th>
                  <th className="n">Parameters</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {installed.map(model => (
                  <tr key={model.name}>
                    <td><span className="mono">{model.name}</span></td>
                    <td className="truncate">{model.details?.family || '—'}</td>
                    <td className="n">{model.size ? `${(model.size / 1e9).toFixed(2)} GB` : '—'}</td>
                    <td className="n">{model.details?.parameter_size || '—'}</td>
                    <td>
                      <button type="button" className="btn ghost" style={{ color: 'var(--color-bad)' }}
                        disabled={busy}
                        onClick={() => {
                          if (!confirm(`Delete ${model.name} and its local files?`)) return;
                          act(() => api.ollamaDelete(model.name), `Delete requested for ${model.name}.`);
                        }}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <header>
          <h2>Running models</h2>
          <span className="meta">{running.length} loaded</span>
        </header>
        {running.length === 0 ? (
          <div className="empty">Nothing is loaded on the local server right now.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Model</th><th className="n">Size on disk</th><th className="n">Vram</th><th>Action</th></tr>
              </thead>
              <tbody>
                {running.map(model => (
                  <tr key={model.name}>
                    <td><span className="mono">{model.name}</span></td>
                    <td className="n">{model.size ? `${(model.size / 1e9).toFixed(2)} GB` : '—'}</td>
                    <td className="n">{model.size_vram ? `${(model.size_vram / 1e9).toFixed(2)} GB` : '—'}</td>
                    <td>
                      <button type="button" className="btn ghost" disabled={busy}
                        onClick={() => {
                          if (!confirm(`Stop the loaded model ${model.name}?`)) return;
                          act(() => api.ollamaStop(model.name), `Stop requested for ${model.name}.`);
                        }}>
                        Stop
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <header><h2>Pull a model</h2><span className="meta">downloads model files</span></header>
        <div className="flex flex-wrap items-end gap-3">
          <label className="field" style={{ flex: '1 1 260px' }}>
            <span>Model name</span>
            <input className="input" value={pullName} placeholder="qwen3.5:2b"
              onChange={event => setPullName(event.target.value)} />
          </label>
          <button type="button" className="btn primary" disabled={busy || !pullName.trim()}
            onClick={() => {
              if (!confirm(`Pull ${pullName.trim()}? This downloads model files.`)) return;
              act(() => api.ollamaPull(pullName.trim()), `Pull requested for ${pullName.trim()}.`);
            }}>
            <Ico name="server" /> Pull model
          </button>
          <button type="button" className="btn" disabled={busy}
            onClick={() => {
              if (!confirm('Start a managed local Ollama server on 127.0.0.1:11434?')) return;
              act(() => api.ollamaStart(), 'Managed Ollama server requested.');
            }}>
            Start managed server
          </button>
        </div>
      </section>
    </div>
  );
}
