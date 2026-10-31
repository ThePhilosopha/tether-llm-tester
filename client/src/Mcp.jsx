import { useEffect, useState } from 'react';
import api from './api.js';

export default function Mcp() {
  const [servers, setServers] = useState([]);
  const [selected, setSelected] = useState(null);
  const [tools, setTools] = useState([]);
  const [calls, setCalls] = useState([]);
  const [arguments_, setArguments_] = useState('{}');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [unavailable, setUnavailable] = useState(false);

  async function load() {
    setError(null);
    try {
      const result = await fetch('/api/mcp/servers', { headers: { 'x-session-token': document.querySelector('meta[name="session-token"]')?.content || '' } });
      if (result.status === 404) { setUnavailable(true); setServers([]); return; }
      if (!result.ok) throw new Error(`Request failed (${result.status})`);
      setServers((await result.json()).servers || []);
      setUnavailable(false);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function openServer(server) {
    setSelected(server);
    setResult(null);
    try {
      const response = await fetch(`/api/mcp/servers/${encodeURIComponent(server.id)}/tools`, {
        headers: { 'x-session-token': document.querySelector('meta[name="session-token"]')?.content || '' }
      });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      setTools((await response.json()).tools || []);
    } catch (err) { setError(err.message); }
  }

  async function callTool(tool) {
    setError(null);
    setResult(null);
    let parsed;
    try { parsed = JSON.parse(arguments_ || '{}'); }
    catch { setError('Tool arguments must be valid JSON.'); return; }
    try {
      const response = await fetch(`/api/mcp/servers/${encodeURIComponent(selected.id)}/tools/${encodeURIComponent(tool.name)}/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': document.querySelector('meta[name="session-token"]')?.content || '' },
        body: JSON.stringify({ arguments: parsed })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      setResult(data);
      setCalls(previous => [...previous, { server: selected.name, tool: tool.name, durationMs: data.durationMs, ok: true }]);
    } catch (err) {
      setError(err.message);
      setCalls(previous => [...previous, { server: selected.name, tool: tool.name, durationMs: null, ok: false }]);
    }
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

      {unavailable && (
        <section className="panel">
          <header><h2>Server routes are not built yet</h2><span className="meta">MCP auditing</span></header>
          <p style={{ color: 'var(--color-ink-soft)', maxWidth: '72ch' }}>
            This workspace is laid out and waiting on the backend. The Node server has no MCP routes yet, so
            there is nothing to list, call or log. Once the server exposes registry, discovery and call
            endpoints, the same screens read them without change.
          </p>
          <p className="mt-3" style={{ color: 'var(--color-ink-faint)', fontSize: 'var(--fs-small)' }}>
            Expected by this screen: GET /api/mcp/servers, GET /api/mcp/servers/:id/tools and
            POST /api/mcp/servers/:id/tools/:name/call.
          </p>
        </section>
      )}

      <section className="panel">
        <header><h2>Connected servers</h2><span className="meta">{servers.length} registered</span></header>
        {servers.length === 0 ? (
          <div className="empty">
            No remote MCP servers are registered. Add one with its URL, and OAuth details appear here once
            the server routes exist.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Server</th><th>URL</th><th>Auth</th><th className="n">Tools</th><th>Last check</th><th>Open</th></tr>
              </thead>
              <tbody>
                {servers.map(server => (
                  <tr key={server.id}>
                    <td>{server.name}</td>
                    <td className="mono truncate">{server.url}</td>
                    <td><span className="pill">{server.auth || 'none'}</span></td>
                    <td className="n">{server.toolCount ?? 0}</td>
                    <td className="truncate">{server.lastCheckedAt ? new Date(server.lastCheckedAt).toLocaleString() : '—'}</td>
                    <td>
                      <button type="button" className="btn ghost" onClick={() => openServer(server)}>Open</button>
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
          <header><h2>{selected.name}</h2><span className="meta">{tools.length} tools</span></header>
          {tools.length === 0 ? (
            <div className="empty">No tools were discovered on this server.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Tool</th><th>Description</th><th>Call</th></tr></thead>
                <tbody>
                  {tools.map(tool => (
                    <tr key={tool.name}>
                      <td className="mono">{tool.name}</td>
                      <td className="truncate">{tool.description || '—'}</td>
                      <td>
                        <button type="button" className="btn ghost" onClick={() => callTool(tool)}>Call</button>
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
        <header><h2>Call log</h2><span className="meta">{calls.length} entries</span></header>
        {calls.length === 0 ? (
          <div className="empty">No tool calls have been made from this workspace yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Server</th><th>Tool</th><th className="n">Latency</th><th>Outcome</th></tr></thead>
              <tbody>
                {calls.map((call, index) => (
                  <tr key={index}>
                    <td>{call.server}</td>
                    <td className="mono">{call.tool}</td>
                    <td className="n">{call.durationMs} ms</td>
                    <td><span className={`pill ${call.ok ? 'pos' : 'neg'}`}>{call.ok ? 'ok' : 'failed'}</span></td>
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
