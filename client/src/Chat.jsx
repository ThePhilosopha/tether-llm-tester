import { useEffect, useState } from 'react';
import api, { streamNdjson } from './api.js';
import Ico from './Ico.jsx';

const PARAM_FIELDS = [
  ['topP', 'Top-P', '0.9'],
  ['topK', 'Top-K', '40'],
  ['seed', 'Seed', '42'],
  ['frequencyPenalty', 'Frequency penalty', '0'],
  ['presencePenalty', 'Presence penalty', '0'],
  ['maxOutputTokens', 'Max output tokens', '512']
];

function serialise(values) {
  const parsed = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === '' || value == null) continue;
    const number = Number(value);
    parsed[key] = Number.isFinite(number) && value.trim() !== '' ? number : value;
  }
  return parsed;
}

export default function Chat({ providers, providerId }) {
  const [modelId, setModelId] = useState('');
  const [models, setModels] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [system, setSystem] = useState('');
  const [thinking, setThinking] = useState('low');
  const [params, setParams] = useState(() => Object.fromEntries(PARAM_FIELDS.map(([key, , dflt]) => [key, dflt])));
  const [stream, setStream] = useState('');
  const [status, setStatus] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!providerId) { setModels([]); return; }
    let cancelled = false;
    api.models(providerId)
      .then(result => { if (!cancelled) setModels(result.data || []); })
      .catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
  }, [providerId]);

  async function send(event) {
    event.preventDefault();
    if (!prompt.trim()) return;
    const started = Date.now();
    setStatus('Sending…');
    setError(null);
    setStream('');
    setElapsed(0);
    const timer = setInterval(() => setElapsed(((Date.now() - started) / 1000).toFixed(1)), 100);
    try {
      const body = {
        providerId,
        request: {
          model: modelId || 'deepseek-v4.1-flash:cloud',
          messages: [{ role: 'user', content: prompt }],
          stream: true
        },
        parameters: { temperature: 0.7, ...serialise(params) },
        thinking
      };
      await streamNdjson('/api/chat', { method: 'POST', body }, event => {
        if (event.type === 'delta') setStream(prev => prev + (event.text || ''));
        if (event.type === 'error') throw new Error(event.message);
      });
      setStatus('Complete');
    } catch (err) {
      setStatus(err.message === 'Request cancelled.' ? 'Cancelled' : 'Error');
      setError(err.message);
    } finally {
      clearInterval(timer);
      setElapsed(((Date.now() - started) / 1000).toFixed(1));
    }
  }

  return (
    <div className="stack">
      <div>
        <div className="canvas-head">
          <h1>Chat</h1>
          <span className="scope">Request and response capture</span>
        </div>
        <p className="canvas-sub">
          Every request goes through the local proxy, so the exact body, the masked headers and the raw
          upstream response stay available for inspection.
        </p>
      </div>
      <div className="grid min-h-0 grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,460px)_minmax(0,1fr)]">
      <form onSubmit={send} className="panel flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-ink-soft" style={{ fontSize: "var(--fs-small)" }}>Model</span>
          <select value={modelId} onChange={e => setModelId(e.target.value)} className="input">
            <option value="">deepseek-v4.1-flash:cloud</option>
            {models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-ink-soft" style={{ fontSize: "var(--fs-small)" }}>System instructions</span>
          <textarea rows={2} value={system} onChange={e => setSystem(e.target.value)}
           className="input" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-ink-soft" style={{ fontSize: "var(--fs-small)" }}>Message</span>
          <textarea rows={5} required value={prompt} onChange={e => setPrompt(e.target.value)}
           className="input min-h-32" />
        </label>
        <fieldset className="rounded-md p-3" style={{  background: "var(--color-raised)"  }}>
          <legend className="px-1 text-xs font-semibold text-ink-soft">Parameters</legend>
          <div className="grid grid-cols-2 gap-2">
            {PARAM_FIELDS.map(([key, label]) => (
              <label key={key} className="flex flex-col gap-1">
                <span className="text-ink-soft" style={{ fontSize: "var(--fs-small)" }}>{label}</span>
                <input name={key} value={params[key]} onChange={e => setParams({ ...params, [key]: e.target.value })}
                 className="input" style={{ padding: "5px 8px", fontSize: "var(--fs-small)" }} />
              </label>
            ))}
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-ink-soft" style={{ fontSize: "var(--fs-small)" }}>Thinking effort</span>
              <select value={thinking} onChange={e => setThinking(e.target.value)} className="input" style={{ padding: "5px 8px", fontSize: "var(--fs-small)" }}>
                <option value="">Provider default</option>
                <option value="low">low</option>
                <option value="high">high</option>
                <option value="max">max</option>
              </select>
            </label>
          </div>
        </fieldset>
        <div className="flex items-center gap-2">
          <button type="submit" className="btn primary">
            Send request
          </button>
          <span className="text-xs text-ink-faint">Streamed through the audited proxy.</span>
        </div>
      </form>

      <section className="panel flex min-h-0 flex-col" aria-live="polite">
        <header className="flex items-center gap-2 border-b border-edge px-4 py-3">
          <h2 className="text-sm font-semibold">Response</h2>
          <span className="pill">{status}</span>
          {elapsed > 0 && <span className="text-[11px] text-ink-faint">{elapsed}s</span>}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
          {error ? <p className="text-bad">{error}</p> : stream ? <p className="whitespace-pre-wrap">{stream}</p> : <p className="text-ink-faint">Send a request to inspect the response.</p>}
        </div>
        <details className="border-t px-4 py-2 text-ink-soft" style={{ borderColor: "var(--color-rule)", fontSize: "var(--fs-small)" }}>
          <summary>Reasoning trace</summary>
        </details>
        <details className="border-t px-4 py-2 text-ink-soft" style={{ borderColor: "var(--color-rule)", fontSize: "var(--fs-small)" }}>
          <summary>Developer view</summary>
        </details>
      </section>
      </div>
    </div>
  );
}