import { useEffect, useState } from 'react';
import Rail from './Rail.jsx';
import Chat from './Chat.jsx';
import Models from './Models.jsx';
import Audit from './Audit.jsx';
import Ollama from './Ollama.jsx';
import Compare from './Compare.jsx';
import Skills from './Skills.jsx';
import Mcp from './Mcp.jsx';
import Settings from './Settings.jsx';
import api from './api.js';
import Ico from './Ico.jsx';

export default function App() {
  const [active, setActive] = useState('chat');
  const [state, setState] = useState(null);
  const [providerId, setProviderId] = useState(null);
  const [error, setError] = useState(null);

  async function reload() {
    try {
      const data = await api.state();
      setState(data);
      setProviderId(previous => data.providers.some(item => item.id === previous) ? previous : (data.providers[0]?.id || null));
      setError(null);
    } catch (err) { setError(err.message); }
  }

  useEffect(() => { reload(); }, []);

  const providers = state?.providers || [];
  const connection = {
    ready: Boolean(state),
    label: state ? 'Local server ready' : error ? 'Connection failed' : 'Connecting…'
  };

  return (
    <div className="app">
      <Rail
        active={active}
        onSelect={setActive}
        providers={providers}
        providerId={providerId}
        onProviderPick={setProviderId}
        connection={connection}
      />
      <div className="flex min-w-0 flex-col">
        <header className="topbar">
          <div className="search">
            <Ico name="pin" className="size-4 text-ink-faint" />
            <input placeholder="Quick search" aria-label="Quick search" />
          </div>
          <span className="spacer" />
          <button type="button" className="btn primary">
            <Ico name="sparkles" /><span>New chat request</span>
          </button>
          <button type="button" className="icon-btn" aria-label="Settings" onClick={() => setActive('settings')}>
            <Ico name="cog" />
          </button>
        </header>

        <main className="canvas">
          {active === 'chat' && <Chat providers={providers} providerId={providerId} />}
          {active === 'models' && <Models providers={providers} providerId={providerId} />}
          {active === 'ollama' && <Ollama />}
          {active === 'compare' && <Compare providers={providers} />}
          {active === 'skills' && <Skills providers={providers} />}
          {active === 'mcp' && <Mcp />}
          {active === 'settings' && <Settings state={state} onStateChange={reload} />}
          {active === 'audit' && <Audit />}
        </main>
      </div>
    </div>
  );
}