import { initCompare } from './compare.js';

const token = document.querySelector('meta[name="session-token"]').content;
const state = { data: null, providerId: null, tab: 'chat', controller: null, raw: '', text: '', reasoning: '', toolCalls: new Map(), expertDirty: false };
const $ = selector => document.querySelector(selector);
const api = async (path, options = {}) => {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', 'x-session-token': token, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
};
const toast = message => { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 3600); };
const comparison = initCompare({ api, getProviders: () => state.data?.providers || [], notify: toast });
const selected = () => state.data.providers.find(provider => provider.id === state.providerId);
const modelCapability = value => value === 'yes' ? 'Yes' : value === 'no' ? 'No' : 'Unknown';

function renderProviders() {
  const current = selected(); $('#provider-name').textContent = current?.name || 'No provider';
  $('#provider-list').replaceChildren(...state.data.providers.map(provider => {
    const button = document.createElement('button'); button.className = `provider-item ${provider.id === state.providerId ? 'active' : ''}`;
    button.innerHTML = `<span class="provider-dot"></span><span><strong>${escapeHtml(provider.name)}</strong><small>${escapeHtml(provider.baseUrl)}</small></span>`;
    button.onclick = () => { state.providerId = provider.id; render(); }; return button;
  }));
  $('#delete-provider').disabled = state.data.providers.length <= 1;
  $('#remote-http').textContent = `Remote HTTP: ${state.data.security.allowRemoteHttp ? 'on' : 'off'}`;
}
function renderModels() {
  const provider = selected(); const models = provider?.models || [];
  $('#model').replaceChildren(new Option('Select a discovered model', ''), ...models.map(item => new Option(item.id, item.id)));
  const body = $('#models-table');
  body.replaceChildren(...(models.length ? models.map(item => {
    const row = document.createElement('tr'); const caps = item.capabilities || {};
    row.innerHTML = `<td><code>${escapeHtml(item.id)}</code></td><td>${escapeHtml(item.ownedBy || '—')}</td><td>${item.context || '—'}</td><td>${modelCapability(caps.tools)}</td><td>${modelCapability(caps.vision)}</td><td>${modelCapability(caps.reasoning)}</td>`; return row;
  }) : [Object.assign(document.createElement('tr'), { innerHTML: '<td colspan="6" class="empty">No models loaded. Refresh to query this provider.</td>' })]));
}
function render() { renderProviders(); renderModels(); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])); }
function formRequest() {
  const model = $('#manual-model').value.trim() || $('#model').value;
  if (!model) throw new Error('Select or enter a model.');
  const request = { model, messages: [] };
  if ($('#system').value.trim()) request.messages.push({ role: 'system', content: $('#system').value.trim() });
  const message = $('#message').value.trim(); if (!message) throw new Error('Message is required.');
  request.messages.push({ role: 'user', content: state.imageData ? [{ type: 'text', text: message }, { type: 'image_url', image_url: { url: state.imageData } }] : message });
  const temperature = $('#temperature').value; if (temperature !== '') request.temperature = Number(temperature);
  const maxTokens = $('#max-tokens').value; if (maxTokens) request.max_tokens = Number(maxTokens);
  request.stream = $('#stream').checked;
  if (request.stream && $('#include-usage').checked) request.stream_options = { include_usage: true };
  if ($('#reasoning').value) request.reasoning_effort = $('#reasoning').value;
  if ($('#tools-enabled').checked) { try { request.tools = JSON.parse($('#tools').value || '[]'); } catch { throw new Error('Tool definitions must be valid JSON.'); } if (!Array.isArray(request.tools)) throw new Error('Tools must be a JSON array.'); }
  return request;
}
function currentRequest() {
  if (!$('#expert-wrap').hidden && state.expertDirty) { try { const value = JSON.parse($('#expert').value); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw new Error('Expert request must be a JSON object.'); } }
  return formRequest();
}
function resetResponse() { state.raw = ''; state.text = ''; state.reasoning = ''; state.toolCalls.clear(); $('#response-content').textContent = ''; $('#response-content').classList.remove('empty'); $('#raw-trace').textContent = ''; $('#request-trace').textContent = ''; $('#reasoning-wrap').hidden = true; $('#tool-calls').hidden = true; }
function renderResponse() { $('#response-content').textContent = state.text || 'No text delta received.'; $('#raw-trace').textContent = state.raw || 'No raw response yet.'; if (state.reasoning) { $('#reasoning-wrap').hidden = false; $('#reasoning-content').textContent = state.reasoning; } if (state.toolCalls.size) { $('#tool-calls').hidden = false; $('#tool-calls pre').textContent = JSON.stringify([...state.toolCalls.values()], null, 2); } }
function consumeDelta(event) { state.text += event.text || ''; state.reasoning += event.reasoning || ''; for (const call of event.toolCalls || []) { const previous = state.toolCalls.get(call.index) || { index: call.index, id: '', name: '', arguments: '' }; state.toolCalls.set(call.index, { ...previous, id: call.id || previous.id, name: call.name || previous.name, arguments: previous.arguments + call.arguments }); } renderResponse(); }
async function sendRequest(event) {
  event.preventDefault(); const provider = selected(); if (!provider) return;
  try {
    const request = currentRequest(); resetResponse(); $('#response-status').textContent = 'Sending…'; $('#send').disabled = true; $('#stop').disabled = false;
    if (!request.stream) { const result = await api('/api/chat', { method: 'POST', body: JSON.stringify({ providerId: provider.id, request }) }); $('#request-trace').textContent = JSON.stringify({ url: result.url, headers: result.headers, body: result.body }, null, 2); state.raw = result.response.raw; state.text = result.response.body?.choices?.[0]?.message?.content || result.response.raw; $('#response-status').textContent = `HTTP ${result.response.status}`; renderResponse(); return; }
    state.controller = new AbortController(); const response = await fetch('/api/chat', { method: 'POST', signal: state.controller.signal, headers: { 'content-type': 'application/json', 'x-session-token': token }, body: JSON.stringify({ providerId: provider.id, request }) });
    if (!response.ok || !response.body) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Stream failed.'); }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue; const entry = JSON.parse(line); if (entry.type === 'request') { state.traceId = entry.traceId; $('#request-trace').textContent = JSON.stringify({ url: entry.url, headers: entry.headers, body: entry.body }, null, 2); } else if (entry.type === 'raw') state.raw += entry.data; else if (entry.type === 'delta') consumeDelta(entry); else if (entry.type === 'error') throw new Error(entry.message); } }
    $('#response-status').textContent = 'Complete'; renderResponse();
  } catch (error) { $('#response-status').textContent = `Error: ${error.message}`; toast(error.message); }
  finally { state.controller = null; $('#send').disabled = false; $('#stop').disabled = true; }
}
async function refreshModels() { try { const result = await api(`/api/providers/${encodeURIComponent(state.providerId)}/models`); selected().models = result.data; renderModels(); toast(`Loaded ${result.data.length} models.`); } catch (error) { toast(error.message); } }
function showProvider(provider = null) {
  const dialog = $('#provider-dialog'); const preset = $('#preset');
  const presets = { ollama:'Ollama', 'ollama-cloud':'Ollama Cloud', '9router':'9Router', poolside:'Poolside', openrouter:'OpenRouter', 'opencode-zen':'OpenCode Zen', 'opencode-go':'OpenCode Go', clinepass:'ClinePass', custom:'Custom' };
  preset.replaceChildren(...Object.entries(presets).map(([id, name]) => new Option(name, id)));
  $('#provider-form').dataset.id = provider?.id || ''; preset.value = provider?.presetId || 'custom'; $('#provider-form-name').value = provider?.name || ''; $('#provider-base-url').value = provider?.baseUrl || ''; $('#provider-auth').value = provider?.auth || 'bearer'; $('#provider-key').value = ''; $('#provider-headers').value = provider ? JSON.stringify(provider.headers || {}, null, 2) : '{}'; dialog.showModal();
}
$('#provider-form').addEventListener('submit', async event => { event.preventDefault(); try { let headers; try { headers = JSON.parse($('#provider-headers').value || '{}'); } catch { throw new Error('Extra headers must be a JSON object.'); } const payload = { presetId: $('#preset').value, name: $('#provider-form-name').value, baseUrl: $('#provider-base-url').value, auth: $('#provider-auth').value, apiKey: $('#provider-key').value, headers }; const existing = $('#provider-form').dataset.id; const result = existing ? await api(`/api/providers/${existing}`, { method:'PUT', body: JSON.stringify(payload) }) : await api('/api/providers', { method:'POST', body: JSON.stringify(payload) }); if (existing) Object.assign(selected(), result); else { state.data.providers.push(result); state.providerId = result.id; } $('#provider-dialog').close(); render(); comparison.providersChanged(); toast('Provider saved.'); } catch (error) { toast(error.message); } });
$('#provider-dialog').addEventListener('click', event => { if (event.target.value === 'cancel') { event.preventDefault(); $('#provider-dialog').close(); } });
$('#preset').addEventListener('change', () => { const urls = {ollama:'http://127.0.0.1:11434/v1','ollama-cloud':'https://ollama.com/v1','9router':'http://127.0.0.1:20128/v1',poolside:'https://inference.poolside.ai/v1',openrouter:'https://openrouter.ai/api/v1','opencode-zen':'https://opencode.ai/zen/v1','opencode-go':'https://opencode.ai/inference/go/v1',clinepass:'https://api.cline.bot/api/v1'}; if (urls[$('#preset').value]) $('#provider-base-url').value = urls[$('#preset').value]; });
$('#add-provider').onclick = () => showProvider(); $('#provider-list').ondblclick = () => showProvider(selected());
$('#delete-provider').onclick = async () => { const provider = selected(); if (!provider || !confirm(`Delete provider “${provider.name}”? This removes its locally stored key.`)) return; try { await api(`/api/providers/${provider.id}`, { method:'DELETE' }); state.data.providers = state.data.providers.filter(item => item.id !== provider.id); state.providerId = state.data.providers[0]?.id; render(); comparison.providersChanged(); } catch (error) { toast(error.message); } };
$('#test-provider').onclick = async () => { try { const result = await api(`/api/providers/${state.providerId}/test`, { method:'POST', body:'{}' }); toast(`Connection successful (HTTP ${result.status}).`); } catch (error) { toast(error.message); } };
$('#refresh-models').onclick = refreshModels; $('#request-form').onsubmit = sendRequest;
$('#stop').onclick = async () => { state.controller?.abort(); if (state.traceId) await api(`/api/chat/${state.traceId}/cancel`, { method:'POST', body:'{}' }).catch(() => {}); $('#response-status').textContent = 'Cancelled'; };
$('#tools-enabled').onchange = event => { $('#tools-wrap').hidden = !event.target.checked; };
$('#toggle-expert').onclick = () => { const wrap = $('#expert-wrap'); wrap.hidden = !wrap.hidden; if (!wrap.hidden) { state.expertDirty = false; $('#expert').value = JSON.stringify(formRequest(), null, 2); $('#reset-expert').hidden = false; } else $('#reset-expert').hidden = true; };
$('#expert').oninput = () => { state.expertDirty = true; }; $('#reset-expert').onclick = () => { state.expertDirty = false; $('#expert').value = JSON.stringify(formRequest(), null, 2); };
$('#image').onchange = event => { const file = event.target.files[0]; if (!file) { state.imageData = ''; return; } if (file.size > 5 * 1024 * 1024) { toast('Images must be 5 MiB or smaller.'); event.target.value = ''; return; } const preview = $('#image-preview'); preview.src = URL.createObjectURL(file); preview.hidden = false; const reader = new FileReader(); reader.onload = () => { state.imageData = reader.result; }; reader.readAsDataURL(file); };
$('#remote-http').onclick = async () => { const enabled = !state.data.security.allowRemoteHttp; if (enabled && !confirm('Allow remote HTTP? Traffic and credentials may be visible to your network.')) return; try { const next = await api('/api/state', { method:'PUT', body: JSON.stringify({ security:{ allowRemoteHttp: enabled } }) }); state.data = next; render(); } catch (error) { toast(error.message); } };
const tabs = [...document.querySelectorAll('[role="tab"]')];
function activateTab(tab) { tabs.forEach(item => item.setAttribute('aria-selected', item === tab)); document.querySelectorAll('.tab-panel').forEach(panel => panel.hidden = panel.id !== `${tab.dataset.tab}-panel`); if (tab.dataset.tab === 'compare') comparison.opened(); }
tabs.forEach(tab => tab.onclick = () => activateTab(tab));
document.querySelector('[role="tablist"]').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const selectedIndex = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (selectedIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[index].focus();
  activateTab(tabs[index]);
});
async function ollama(path, options) { return api(`/api/ollama/${path}`, options); }
async function refreshOllama() {
  try {
    const [status, models, running] = await Promise.all([ollama('status'), ollama('models'), ollama('running')]);
    $('#ollama-status').textContent = JSON.stringify(status, null, 2);
    const renderActions = (target, items, action, prompt, endpoint) => {
      const box = $(target); box.replaceChildren();
      if (!items.length) { box.textContent = action === 'Delete' ? 'No installed models.' : 'No running models.'; return; }
      for (const item of items) { const row = document.createElement('div'); row.className = 'model-row'; const name = document.createElement('code'); name.textContent = item.name; const button = document.createElement('button'); button.className = 'button danger subtle'; button.textContent = action; button.onclick = async () => { if (!confirm(prompt(item.name))) return; try { await ollama(endpoint, { method: action === 'Delete' ? 'DELETE' : 'POST', body: JSON.stringify({ name:item.name, confirmed:true }) }); toast(action + ' requested for ' + item.name + '.'); refreshOllama(); } catch (error) { toast(error.message); } }; row.append(name, button); box.append(row); }
    };
    renderActions('#ollama-models', models.models || [], 'Delete', name => 'Delete model “' + name + '” and its local files?', 'models');
    renderActions('#ollama-running', running.models || [], 'Stop', name => 'Stop loaded model “' + name + '”?', 'models/stop');
  } catch (error) { toast(error.message); }
}
$('#refresh-ollama').onclick = refreshOllama; $('#start-ollama').onclick = async () => { if (!confirm('Start a managed local Ollama server on 127.0.0.1:11434?')) return; try { await ollama('process/start', { method:'POST', body:JSON.stringify({confirmed:true}) }); toast('Managed Ollama server requested.'); } catch (error) { toast(error.message); } };
$('#pull-form').onsubmit = async event => { event.preventDefault(); const name = $('#pull-name').value.trim(); if (!confirm(`Pull “${name}” from Ollama? This downloads model files.`)) return; try { await ollama('models/pull', { method:'POST', body:JSON.stringify({name}) }); toast(`Pulled ${name}.`); refreshOllama(); } catch (error) { toast(error.message); } };
$('#settings-form').onsubmit = async event => { event.preventDefault(); const value = $('#ollama-parallel').value.trim(); try { const result = await ollama('settings', { method:'PUT', body:JSON.stringify({settings:value ? { OLLAMA_NUM_PARALLEL:value } : {}}) }); state.data.ollama = result; toast('Settings saved.'); } catch (error) { toast(error.message); } };
$('#apply-settings').onclick = async () => { if (!confirm('Apply saved Ollama settings via launchctl? Ollama is not restarted automatically.')) return; try { await ollama('settings/apply-macos', {method:'POST',body:JSON.stringify({confirmed:true})}); toast('Settings applied. Restart Ollama manually.'); } catch (error) { toast(error.message); } };
(async () => { try { state.data = await api('/api/state', { headers: { 'x-session-token': undefined } }); state.providerId = state.data.providers[0]?.id; $('#connection').innerHTML = '<span></span> Local server ready'; render(); comparison.providersChanged(); } catch (error) { $('#connection').textContent = `Unavailable: ${error.message}`; toast(error.message); } })();
