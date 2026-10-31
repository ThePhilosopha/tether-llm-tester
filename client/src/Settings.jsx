import { useEffect, useState } from 'react';
import api from './api.js';

export default function Settings({ state, onStateChange }) {
  const [allowRemoteHttp, setAllowRemoteHttp] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(null);
  const [providers, setProviders] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ presetId: 'custom', name: '', baseUrl: '', auth: 'bearer', apiKey: '', headers: '{}' });

  useEffect(() => {
    setAllowRemoteHttp(Boolean(state?.security?.allowRemoteHttp));
    setProviders(state?.providers || []);
  }, [state]);

  function startEdit(provider) {
    setEditing(provider);
    setForm({
      presetId: provider.presetId || 'custom',
      name: provider.name,
      baseUrl: provider.baseUrl,
      auth: provider.auth || 'bearer',
      apiKey: '',
      headers: JSON.stringify(provider.headers || {}, null, 2)
    });
  }

  async function saveProvider(event) {
    event.preventDefault();
    setError(null);
    let headers;
    try { headers = JSON.parse(form.headers || '{}'); }
    catch { setError('Extra headers must be a JSON object.'); return; }
    const payload = { ...form, headers };
    try {
      if (editing) await api.updateProvider(editing.id, payload);
      else await api.createProvider(payload);
      setEditing(null);
      setNotice('Provider saved.');
      onStateChange?.();
    } catch (err) { setError(err.message); }
  }

  async function toggleRemoteHttp() {
    setError(null);
    try {
      await api.setRemoteHttp(!allowRemoteHttp);
      setAllowRemoteHttp(!allowRemoteHttp);
      setNotice(`Remote HTTP ${!allowRemoteHttp ? 'enabled' : 'disabled'}.`);
      onStateChange?.();
    } catch (err) { setError(err.message); }
  }

  async function remove(provider) {
    if (!confirm(`Delete ${provider.name}? This removes its locally stored key.`)) return;
    setError(null);
    try {
      await api.deleteProvider(provider.id);
      setNotice(`${provider.name} deleted.`);
      onStateChange?.();
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="stack">
      <div>
        <div className="canvas-head">
          <h1>Settings</h1>
          <span className="scope">Providers, security and stored data</span>
        </div>
        <p className="canvas-sub">
          Everything the app stores stays on this machine. Credentials live in the state file beside the
          provider definitions, readable only by your account.
        </p>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: 'var(--color-bad)' }}>
          <header><h2>Request failed</h2></header>
          <p style={{ color: 'var(--color-bad)' }}>{error}</p>
        </div>
      )}
      {notice && !error && (
        <div className="panel"><header><h2>Last action</h2></header>
          <p style={{ color: 'var(--color-ink-soft)' }}>{notice}</p></div>
      )}

      <section className="panel">
        <header><h2>Providers</h2><span className="meta">{providers.length} configured</span></header>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Preset</th><th>Base URL</th><th>Key</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {providers.map(provider => (
                <tr key={provider.id}>
                  <td>{provider.name}</td>
                  <td>{provider.presetId}</td>
                  <td className="mono truncate">{provider.baseUrl}</td>
                  <td>{provider.hasApiKey ? 'stored' : 'none'}</td>
                  <td>
                    <div className="flex gap-2">
                      <button type="button" className="btn ghost" onClick={() => startEdit(provider)}>Edit</button>
                      <button type="button" className="btn ghost" style={{ color: 'var(--color-bad)' }}
                        onClick={() => remove(provider)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="btn mt-4" onClick={() => { setEditing(null); setForm({ presetId: 'custom', name: '', baseUrl: '', auth: 'bearer', apiKey: '', headers: '{}' }); }}>
          Add provider
        </button>
      </section>

      {editing !== null || form.name || form.baseUrl ? (
        <section className="panel">
          <header>
            <h2>{editing ? `Edit ${editing.name}` : 'Add provider'}</h2>
            <span className="meta">credentials are stored locally</span>
          </header>
          <form className="stack" style={{ gap: 12 }} onSubmit={saveProvider}>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="field">
                <span>Preset</span>
                <select className="input" value={form.presetId} onChange={event => setForm({ ...form, presetId: event.target.value })}>
                  {['ollama', 'ollama-cloud', '9router', 'openrouter', 'opencode-zen', 'opencode-go', 'clinepass', 'poolside', 'custom'].map(id => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Name</span>
                <input className="input" required maxLength={80} value={form.name}
                  onChange={event => setForm({ ...form, name: event.target.value })} />
              </label>
            </div>
            <label className="field">
              <span>Base URL</span>
              <input className="input" required value={form.baseUrl}
                onChange={event => setForm({ ...form, baseUrl: event.target.value })} />
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="field">
                <span>Authentication</span>
                <select className="input" value={form.auth} onChange={event => setForm({ ...form, auth: event.target.value })}>
                  <option value="bearer">Bearer token</option>
                  <option value="none">None</option>
                </select>
              </label>
              <label className="field">
                <span>API key</span>
                <input className="input" type="password" autoComplete="off" placeholder="Stored locally. Leave blank to keep the existing key."
                  value={form.apiKey} onChange={event => setForm({ ...form, apiKey: event.target.value })} />
              </label>
            </div>
            <label className="field">
              <span>Extra headers (JSON)</span>
              <textarea className="input mono" rows={3} value={form.headers}
                onChange={event => setForm({ ...form, headers: event.target.value })} style={{ fontSize: 'var(--fs-small)' }} />
            </label>
            <div className="flex gap-2">
              <button type="submit" className="btn primary">Save provider</button>
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="panel">
        <header><h2>Security</h2><span className="meta">network boundary</span></header>
        <div className="flex flex-wrap items-center gap-3">
          <input type="checkbox" className="switch" id="remote-http" checked={allowRemoteHttp}
            onChange={toggleRemoteHttp} />
          <label htmlFor="remote-http" style={{ fontWeight: 500 }}>Allow remote HTTP</label>
          <span style={{ color: 'var(--color-ink-soft)', fontSize: 'var(--fs-small)' }}>
            {allowRemoteHttp
              ? 'Plain HTTP upstreams are allowed. Traffic and credentials may be visible on your network.'
              : 'Only HTTPS and loopback addresses are reachable.'}
          </span>
        </div>
      </section>

      <section className="panel">
        <header><h2>Stored data</h2><span className="meta">on this machine</span></header>
        <div className="table-wrap">
          <table>
            <thead><tr><th>What</th><th>Where</th><th>Holds</th></tr></thead>
            <tbody>
              <tr>
                <td>State file</td>
                <td className="mono truncate">~/Library/Application Support/Tether LLM Tester/state.json</td>
                <td>Provider definitions, credentials, the remote HTTP flag</td>
              </tr>
              <tr>
                <td>Comparisons</td>
                <td className="mono truncate">~/Library/Application Support/Tether LLM Tester/comparisons/</td>
                <td>Versioned cases and every comparison run</td>
              </tr>
              <tr>
                <td>Skills</td>
                <td className="mono truncate">~/Library/Application Support/Tether LLM Tester/skills/</td>
                <td>Imported skill files you have edited</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
