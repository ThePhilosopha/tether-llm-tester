import Ico from './Ico.jsx';
import icon from './assets/icon.svg';
import { chatNav, sideNav, bottomNav } from './nav.js';

const GROUPS = [
  { label: '', items: chatNav },
  { label: 'Saved', items: sideNav }
];

export default function Rail({ active, onSelect, providers, providerId, onProviderPick, connection }) {
  const current = providers.find(item => item.id === providerId);
  return (
    <aside className="rail">
      <div className="switcher">
        <img className="mark" src={icon} alt="" width="32" height="32" />
        <label className="who">
          <span className="sr-only">Active provider</span>
          <select
            aria-label="Active provider"
            value={current?.id || ''}
            onChange={event => onProviderPick?.(event.target.value)}
            style={{ width: '100%', border: 0, background: 'transparent', color: 'inherit', font: 'inherit', padding: 0 }}
          >
            {providers.length === 0 && <option value="">No provider</option>}
            {providers.map(provider => (
              <option key={provider.id} value={provider.id}>{provider.name}</option>
            ))}
          </select>
          <span>{current?.baseUrl || 'Add a provider to start'}</span>
        </label>
        <Ico name="chip" className="size-3.5 text-ink-faint" />
      </div>

      <nav aria-label="Workspaces" className="flex w-full flex-col gap-0">
        {GROUPS.map(group => (
          <div key={group.label || 'main'} className={group.label ? 'saved-group' : 'main-group'}>
            {group.label && <p className="group-label">{group.label}</p>}
            <ul className="flex flex-col gap-0.5" role="list">
              {group.items.map(item => (
                <li key={item.key}>
                  <button
                    type="button"
                    className="nav-item"
                    aria-current={active === item.key ? 'page' : undefined}
                    onClick={() => onSelect(item.key)}
                  >
                    <Ico name={item.icon} />
                    <span className="truncate">{item.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="bottom">
        <div className="sep" />
        <p className="status">
          <span className={`dot ${connection.ready ? '' : 'off'}`} aria-hidden />
          <span className="truncate">{connection.label}</span>
        </p>
        <ul className="flex flex-col gap-0.5" role="list">
          {bottomNav.map(item => (
            <li key={item.key}>
              <button type="button" className="nav-item" onClick={() => onSelect(item.key)}>
                <Ico name={item.icon} /><span className="truncate">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}