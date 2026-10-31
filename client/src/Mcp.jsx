import { useEffect, useState } from 'react';
import api from './api.js';

function authLabel(server) {
  if (server.oauth?.status === 'authorised') return 'oauth';
  if (server.oauth) return 'oauth pending';
  return server.auth || 'none';
}

export default function Mcp() {
  const [servers, setServers] = useState([]);
  const [selected, setSelected] = useState(null);
  const [tools, setTools] = useState([]);
  const [arguments_, setArguments_] = useState('{}');
  const [result, setResult] = useState(null);
  const [audit, setAudit] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState({ name: '', url: '' });
  const [busy, setBusy] = useState('');

  async function load() {
    setError(null);
    try {
      const [list, log] = await Promise.all([api.mcpServers(), api.mcpAudit()]);
      setServers(list.servers || []);
      setAudit(log.entries || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function addServer(event) {
    event.preventDefault();
    setError(null);
    setNotice('');
    try {
      await api.addMcpServer({ name: draft.name.trim(), url: draft.url.trim() });
      setDraft({ name: '', url: '' });
      setNotice('Registered the MCP server.');
      await load();
    } catch (err) { setError(err.message); }
  }

  async function removeServer(server) {
    setError(null);
    try {
      await api.deleteMcpServer(server.id);
      if (selected?.id === server.id) { setSelected(null); setTools([]); }
      setNotice(`Removed ${server.name}.`);
      await load();
    } catch (err) { setError(err.message); }
  }

  async function connect(server) {
    setError(null);
    setNotice('');
    setBusy(server.id);
    try {
      const result = await api.connectMcpServer(server.id);
      setSelected(result.server);
      setTools(result.tools || []);
      setNotice(`Connected to ${result.server.name}. ${(result.tools || []).length} tools discovered.`);
      await load();
    } catch (err) {
      if (err.authorizeUrl) {
        setNotice('That server needs OAuth authorisation. Opening the authorisation page now.');
        try {
          const started = await api.authorizeMcpServer(err.serverId || server.id);
          window.open(started.authorizationUrl, '_blank', 'noopener');
        } catch (failure) { setError(failure.message); }
      } else {
        setError(err.message);
      }
      await load();
    } finally { setBusy(''); }
  }

  async function openServer(server) {
    setSelected(server);
    setResult(null);
    setError(null);
    try {
      const listed = await api.mcpTools(server.id);
      setTools(listed.tools || []);
    } catch (err) { setError(err.message); }
  }

  async function callTool(tool) {
    setError(null);
    setResult(null);
    let parsed;
    try { parsed = JSON.parse(arguments_ || '{}'); }
    catch { setError('Tool arguments must be valid JSON.'); return; }
    setBusy(tool.name);
    try {
      const data = await api.callMcpTool(selected.id, tool.name, parsed);
      setResult(data);
      setNotice(`Called ${tool.name} in ${data.durationMs} ms.`);
      await load();
    } catch (err) {
      setError(err.message);
      await load();
    } finally { setBusy(''); }
  }

  return (
    <div className="stack">
      <div>
        <div className="canvas-head">
          <h1>MCP</h1>
          <span className="scope">Remote HTTP servers</span>
        </div>
        <p className="canvas-sub">
          Every tool call is recorded with the raw JSON-RPC request, the raw response and the measured
          latency, so a remote server can be checked without guessing what it did.
        </p>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: 'var(--color-bad)' }}>
          <header><h2>Request failed</h2></header>
          <p style={{ color: 'var(--color-bad)' }}>{error}</p>
        </div>
      )}

      {notice && (
        <div className="panel">
          <header><h2>Latest</h2></header>
          <p className="text-sm text-ink-soft">{notice}</p>
        </div>
      )}

      <section className="panel">
        <header><h2>Register a server</h2><span className="meta">streamable HTTP</span></header>
        <form className="grid gap-3 md:grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto] md:items-end" onSubmit={addServer}>
          <label className="field">
            <span>Name</span>
            <input className="input" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}
              placeholder="Context7" required />
          </label>
          <label className="field">
            <span>Server URL</span>
            <input className="input" value={draft.url} onChange={event => setDraft({ ...draft, url: event.target.value })}
              placeholder="https://mcp.context7.com/mcp" required />
          </label>
          <button type="submit" className="btn">Register</button>
        </form>
      </section>

      <section className="panel">
        <header><h2>Connected servers</h2><span className="meta">{servers.length} registered</span></header>
        {servers.length === 0 ? (
          <div className="empty">
            No remote MCP servers are registered. Add one above with its URL. Servers that need OAuth show
            a pending badge until the browser authorisation completes.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Server</th><th>URL</th><th>Auth</th><th className="n">Tools</th><th>Last check</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {servers.map(server => (
                  <tr key={server.id}>
                    <td>{server.name}</td>
                    <td className="mono truncate">{server.url}</td>
                    <td><span className={`pill ${server.oauth?.status === 'authorised' ? 'pos' : server.oauth ? 'warn' : ''}`}>{authLabel(server)}</span></td>
                    <td className="n">{server.toolCount ?? 0}</td>
                    <td className="truncate">{server.lastCheckedAt ? new Date(server.lastCheckedAt).toLocaleString() : '—'}</td>
                    <td>
                      <div className="flex gap-2">
                        <button type="button" className="btn ghost" disabled={busy === server.id}
                          onClick={() => connect(server)}>Connect</button>
                        <button type="button" className="btn ghost" onClick={() => openServer(server)}>Open</button>
                        <button type="button" className="btn ghost" onClick={() => removeServer(server)}>Remove</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && (
        <section className="panel">
          <header>
            <h2>{selected.name}</h2>
            <span className="meta">{tools.length} tools</span>
          </header>
          {tools.length === 0 ? (
            <div className="empty">No tools were discovered on this server.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Tool</th><th>Description</th><th>Parameters</th><th>Call</th></tr></thead>
                <tbody>
                  {tools.map(tool => (
                    <tr key={tool.name}>
                      <td className="mono">{tool.name}</td>
                      <td className="truncate">{tool.description || '—'}</td>
                      <td className="truncate">
                        {(tool.parameters || []).map(parameter => `${parameter.name}${parameter.required ? '*' : ''}`).join(', ') || '—'}
                      </td>
                      <td>
                        <button type="button" className="btn ghost" disabled={busy === tool.name}
                          onClick={() => callTool(tool)}>Call</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <label className="field mt-4">
            <span>Tool arguments (JSON)</span>
            <textarea className="input mono" rows={4} value={arguments_}
              onChange={event => setArguments_(event.target.value)} style={{ fontSize: 'var(--fs-small)' }} />
          </label>
        </section>
      )}

      {result && (
        <section className="panel">
          <header><h2>Last call</h2><span className="meta">{result.durationMs} ms</span></header>
          <pre className="mono overflow-auto rounded-md p-3" style={{ background: 'var(--color-raised)', fontSize: 'var(--fs-small)' }}>
            {JSON.stringify(result.response ?? result, null, 2)}
          </pre>
        </section>
      )}

      <section className="panel">
        <header><h2>Audit log</h2><span className="meta">{audit.length} entries</span></header>
        {audit.length === 0 ? (
          <div className="empty">No tool calls have been recorded yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Server</th><th>Tool</th><th className="n">Latency</th><th>Outcome</th></tr></thead>
              <tbody>
                {audit.map(entry => (
                  <tr key={entry.id}>
                    <td className="truncate">{new Date(entry.at).toLocaleString()}</td>
                    <td>{entry.serverName}</td>
                    <td className="mono">{entry.tool}</td>
                    <td className="n">{entry.durationMs} ms</td>
                    <td><span className={`pill ${entry.ok ? 'pos' : 'neg'}`}>{entry.ok ? 'ok' : 'failed'}</span></td>
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
