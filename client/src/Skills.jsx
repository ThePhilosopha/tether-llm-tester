import { useEffect, useMemo, useState } from 'react';
import api from './api.js';
import { modelKey, modelLabel, remoteProviders } from './models.js';

function Diagram({ diagram, onPick }) {
  if (!diagram?.nodes?.length) return <div className="empty">No diagram is available for this skill.</div>;
  const width = 340;
  const height = 58;
  const gap = 26;
  const total = diagram.nodes.length * (height + gap);
  const positions = new Map(diagram.nodes.map((node, index) => [node.id, index * (height + gap) + 8]));
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${total}`} width="100%" role="img" aria-label="Skill flow diagram" style={{ maxWidth: 340 }}>
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="#4a5160" />
          </marker>
        </defs>
        {diagram.edges.map(edge => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (from == null || to == null) return null;
          return <line key={`${edge.from}-${edge.to}`} x1={width / 2} y1={from + height} x2={width / 2} y2={to}
            stroke="#4a5160" strokeWidth="2" markerEnd="url(#arrow)" />;
        })}
        {diagram.nodes.map(node => {
          const y = positions.get(node.id);
          const isDecision = node.kind === 'decision';
          const isEnd = node.kind === 'input' || node.kind === 'output';
          return (
            <g key={node.id} onClick={() => node.line && onPick?.(node.line)} style={{ cursor: node.line ? 'pointer' : 'default' }}>
              {isDecision ? (
                <polygon points={`${width / 2},${y} ${width - 10},${y + height / 2} ${width / 2},${y + height} 10,${y + height / 2}`}
                  fill="#2b2513" stroke="#8a7a3a" strokeWidth="1.5" />
              ) : (
                <rect x={isEnd ? 60 : 20} y={y} width={isEnd ? width - 120 : width - 40} height={height}
                  rx={isEnd ? height / 2 : 8} fill="#1b1f27" stroke="#3a4250" strokeWidth="1.5" />
              )}
              <title>{node.label}</title>
              <text x={width / 2} y={y + height / 2 + 4} textAnchor="middle" fill="#dfe4ec" fontSize="11">
                {node.label.length > 44 ? `${node.label.slice(0, 41)}…` : node.label}
              </text>
            </g>
          );
        })}
      </svg>
      {diagram.attachments?.length > 0 && (
        <>
          <p className="mt-2" style={{ color: 'var(--color-ink-soft)', fontSize: 'var(--fs-small)' }}>Referenced files</p>
          <ul className="ml-4" style={{ color: 'var(--color-ink-soft)', fontSize: 'var(--fs-small)' }}>
            {diagram.attachments.map(item => <li key={item.id} className="mono">{item.label}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

export default function Skills({ providers }) {
  const [skills, setSkills] = useState([]);
  const [available, setAvailable] = useState([]);
  const [detail, setDetail] = useState(null);
  const [source, setSource] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [explanation, setExplanation] = useState(null);
  const [task, setTask] = useState('');
  const [results, setResults] = useState(null);
  const [models, setModels] = useState([]);
  const [selectedModels, setSelectedModels] = useState(new Set());
  const [explainModel, setExplainModel] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);

  async function load() {
    try {
      const [list, importable] = await Promise.all([api.skills(), api.importableSkills()]);
      setSkills(list.skills || []);
      const known = new Set((list.skills || []).map(skill => skill.slug));
      setAvailable((importable.available || []).filter(item => !known.has(item.slug)));
    } catch (err) { setError(err.message); }
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadingModels(true);
    Promise.all(remoteProviders(providers).map(async provider => {
      try {
        const result = await api.comparisonModels(provider.id);
        return (result.models || []).filter(model => model.available)
          .map(model => ({ ...model, providerName: provider.name }));
      } catch { return []; }
    })).then(found => {
      if (cancelled) return;
      const flat = found.flat();
      setModels(flat);
      setSelectedModels(previous => {
        const kept = new Set([...previous].filter(key => flat.some(model => modelKey(model) === key)));
        if (kept.size) return kept;
        return new Set(flat.slice(0, 3).map(modelKey));
      });
      setExplainModel(previous => previous || (flat[0] ? modelKey(flat[0]) : ''));
    }).finally(() => { if (!cancelled) setLoadingModels(false); });
    return () => { cancelled = true; };
  }, [providers]);

  const chosenModels = useMemo(
    () => models.filter(model => selectedModels.has(modelKey(model))),
    [models, selectedModels]
  );
  const explainTarget = models.find(model => modelKey(model) === explainModel) || null;

  function toggleModel(key) {
    setSelectedModels(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function open(slug) {
    setError(null); setNotice(''); setExplanation(null); setResults(null);
    try {
      const result = await api.skill(slug);
      setDetail(result);
      setSource(result.source);
    } catch (err) { setError(err.message); }
  }

  async function importSkill(entry) {
    try {
      await api.importSkill({ root: entry.root, slug: entry.slug });
      setNotice(`Imported ${entry.slug}.`);
      await load();
      await open(entry.slug);
    } catch (err) { setError(err.message); }
  }

  async function save() {
    try {
      const result = await api.saveSkill(detail.slug, source);
      setDetail({ ...detail, ...result });
      setNotice(`Saved at ${new Date(result.savedAt).toLocaleTimeString()}.`);
      await load();
    } catch (err) { setError(err.message); }
  }

  async function explain() {
    if (!explainTarget) { setError('Choose a remote model to explain the skill.'); return; }
    setNotice('Asking the model for a plain English explanation…');
    try {
      const result = await api.explainSkill(detail.slug, {
        providerId: explainTarget.providerId, modelId: explainTarget.modelId
      });
      setExplanation(result.explanation);
      setNotice('');
    } catch (err) { setError(err.message); setNotice(''); }
  }

  async function run() {
    if (!task.trim()) { setError('Describe a task for the skill to perform.'); return; }
    if (!chosenModels.length) { setError('Choose at least one remote model. Local models are excluded.'); return; }
    setNotice(`Running ${chosenModels.length} model${chosenModels.length === 1 ? '' : 's'}…`);
    try {
      const report = await api.runSkill(detail.slug, {
        task,
        models: chosenModels.map(model => ({ providerId: model.providerId, modelId: model.modelId })),
        settings: { maxOutputTokens: 600, stream: false }
      });
      setResults(report);
      setNotice(`Finished ${report.results.length} run${report.results.length === 1 ? '' : 's'}.`);
    } catch (err) { setError(err.message); setNotice(''); }
  }

  return (
    <div className="stack">
      <div>
        <div className="canvas-head">
          <h1>Skills</h1>
          <span className="scope">Audit and cross-model testing</span>
        </div>
        <p className="canvas-sub">
          A skill is a set of instructions for a model. The audit reads the file, shows the steps in plain
          English and maps the flow, then runs the same skill against remote models to compare the output.
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
        <header><h2>Installed skills</h2><span className="meta">{skills.length} in the app store</span></header>
        {skills.length === 0 ? (
          <div className="empty">No skills in the app store yet. Import one from the list below.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Skill</th><th>Description</th><th className="n">Steps</th><th className="n">Decisions</th><th className="n">Files</th><th>Open</th></tr>
              </thead>
              <tbody>
                {skills.map(skill => (
                  <tr key={skill.slug}>
                    <td><span className="mono">{skill.name || skill.slug}</span></td>
                    <td className="truncate">{skill.description || '—'}</td>
                    <td className="n">{skill.counts?.steps ?? 0}</td>
                    <td className="n">{skill.counts?.branches ?? 0}</td>
                    <td className="n">{skill.counts?.files ?? 0}</td>
                    <td>
                      <button type="button" className="btn ghost" onClick={() => open(skill.slug)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {available.length > 0 && (
        <section className="panel">
          <header><h2>Available to import</h2><span className="meta">{available.length} found</span></header>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Skill</th><th>Source folder</th><th>Action</th></tr></thead>
              <tbody>
                {available.slice(0, 20).map(entry => (
                  <tr key={`${entry.root}|${entry.slug}`}>
                    <td className="mono">{entry.slug}</td>
                    <td className="truncate">{entry.root}</td>
                    <td>
                      <button type="button" className="btn ghost" onClick={() => importSkill(entry)}>Import</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {detail && (
        <>
          <section className="panel">
            <header>
              <h2>{detail.parsed.name}</h2>
              <span className="meta">{detail.parsed.counts.lines} lines · {detail.parsed.frontmatterPresent ? 'frontmatter present' : 'no frontmatter'}</span>
            </header>
            <div className="kpis">
              {[
                ['Steps', detail.parsed.counts.steps],
                ['Guidance points', detail.parsed.counts.bullets],
                ['Decisions', detail.parsed.counts.branches],
                ['Files', detail.parsed.counts.files],
                ['Tools', detail.parsed.counts.tools],
                ['Unclassified', detail.parsed.counts.unmapped]
              ].map(([label, value]) => (
                <div className="kpi" key={label}>
                  <p className="kpi-label">{label}</p>
                  <p className="kpi-value">{value}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <header><h2>What this skill does</h2><span className="meta">read from the file</span></header>
            <ol className="ml-5" style={{ lineHeight: 1.7 }}>
              {detail.plainEnglish.mechanical.map((line, index) => <li key={index}>{line}</li>)}
            </ol>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="field" style={{ minWidth: 260 }}>
                <span>Explain with</span>
                <select className="input" value={explainModel} onChange={event => setExplainModel(event.target.value)}>
                  {models.length === 0 && <option value="">No remote models available</option>}
                  {models.map(model => (
                    <option key={modelKey(model)} value={modelKey(model)}>{modelLabel(model, providers)}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn" onClick={explain} disabled={!explainTarget}>Explain in plain English</button>
              <span style={{ color: 'var(--color-ink-soft)', fontSize: 'var(--fs-small)' }}>
                {loadingModels ? 'Discovering remote models…' : `${models.length} remote model${models.length === 1 ? '' : 's'} available. Local models are excluded.`}
              </span>
            </div>
            {explanation && (
              <div className="mt-4 rounded-md p-4" style={{ background: 'var(--color-raised)' }}>
                <p>{explanation.summary}</p>
                {explanation.steps.length > 0 && (
                  <ol className="ml-5 mt-2" style={{ lineHeight: 1.7 }}>
                    {explanation.steps.map((step, index) => <li key={index}>{step}</li>)}
                  </ol>
                )}
                {explanation.cautions.length > 0 && (
                  <>
                    <p className="mt-3" style={{ fontWeight: 600 }}>Cautions</p>
                    <ul className="ml-5" style={{ color: 'var(--color-warn)' }}>
                      {explanation.cautions.map((caution, index) => <li key={index}>{caution}</li>)}
                    </ul>
                  </>
                )}
                <p className="mt-3" style={{ color: 'var(--color-ink-soft)', fontSize: 'var(--fs-small)' }}>
                  Written by {explanation.modelId} at {new Date(explanation.generatedAt).toLocaleTimeString()}. Model
                  wording can drift from the skill text; the list above is read from the file.
                </p>
              </div>
            )}
          </section>

          <section className="panel">
            <header><h2>Step-by-step diagram</h2><span className="meta">click a node to jump to its line</span></header>
            <Diagram diagram={detail.diagram} onPick={line => {
              const textarea = document.getElementById('skills-source');
              if (!textarea) return;
              const lines = source.split('\n');
              const start = lines.slice(0, Math.max(0, line - 1)).join('\n').length;
              textarea.focus();
              textarea.setSelectionRange(start, start + (lines[line - 1]?.length || 0));
            }} />
          </section>

          <section className="panel">
            <header><h2>Skill source</h2><span className="meta">editable</span></header>
            <textarea id="skills-source" className="input mono" rows={18} value={source}
              onChange={event => setSource(event.target.value)} style={{ fontSize: 'var(--fs-small)', lineHeight: 1.6 }} />
            <div className="mt-3 flex items-center gap-3">
              <button type="button" className="btn primary" onClick={save}>Save edits</button>
            </div>
          </section>

          <section className="panel">
            <header><h2>Test across models</h2><span className="meta">the same skill, the same task</span></header>
            <label className="field">
              <span>Task prompt</span>
              <textarea className="input" rows={3} value={task} placeholder="A task this skill should help with"
                onChange={event => setTask(event.target.value)} />
            </label>
            <fieldset className="mt-3 border-0 p-0">
              <legend className="mb-2 text-ink-soft" style={{ fontSize: 'var(--fs-small)' }}>
                Models to run ({chosenModels.length} of {models.length} selected)
              </legend>
              {models.length === 0 ? (
                <p className="text-ink-soft" style={{ fontSize: 'var(--fs-small)' }}>
                  No remote models are available. Local models are excluded.
                </p>
              ) : (
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {models.map(model => {
                    const key = modelKey(model);
                    return (
                      <label key={key} className="flex items-center gap-2 text-ink-soft" style={{ fontSize: 'var(--fs-small)' }}>
                        <input type="checkbox" checked={selectedModels.has(key)} onChange={() => toggleModel(key)} />
                        <span className="truncate">{modelLabel(model, providers)}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </fieldset>
            <div className="mt-3 flex items-center gap-3">
              <button type="button" className="btn primary" onClick={run} disabled={!chosenModels.length}>
                Run across {chosenModels.length || 'no'} model{chosenModels.length === 1 ? '' : 's'}
              </button>
            </div>
            {results && (
              <div className="mt-4 table-wrap">
                <table>
                  <thead>
                    <tr><th>Model</th><th>Status</th><th className="n">Duration</th><th>Output</th></tr>
                  </thead>
                  <tbody>
                    {results.results.map(result => (
                      <tr key={result.index}>
                        <td className="mono">{result.modelId}</td>
                        <td><span className={`pill ${result.status === 'complete' ? 'pos' : 'neg'}`}>{result.status}</span></td>
                        <td className="n">{result.durationMs} ms</td>
                        <td className="truncate" style={{ maxWidth: '46ch' }}>{result.error || result.output || '(no output)'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
