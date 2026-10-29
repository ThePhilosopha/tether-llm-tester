const PROVIDERS = new Set(['ollama-cloud', 'opencode-go', 'openrouter']);
const PROTOCOLS = ['chat-completions', 'responses', 'anthropic-messages', 'google-generate-content'];
const RUBRIC_DEFAULTS = {
  copy: { clarity: 25, audienceVoice: 25, specificity: 20, persuasion: 20, distinctiveness: 10 },
  layout: { hierarchy: 25, flow: 25, audienceFit: 20, assumptionHandling: 15, accessibility: 15 },
  code: { diagnosis: 40, solutionReasoning: 40, maintainability: 20 }
};
const $ = selector => document.querySelector(selector);
const text = (tag, value, className) => {
  const node = document.createElement(tag);
  node.textContent = value ?? '';
  if (className) node.className = className;
  return node;
};
const keyOf = model => `${encodeURIComponent(model.providerId)}|${encodeURIComponent(model.modelId)}`;
const parseKey = key => {
  const [providerId, modelId] = key.split('|');
  return { providerId: decodeURIComponent(providerId), modelId: decodeURIComponent(modelId) };
};

const EXAMPLES = [
  {
    category: 'copy', title: 'Three distinct product variations', system: 'Return only valid JSON with a variations array. Make each variation distinct and keep each between 20 and 30 words.',
    prompt: 'Write exactly three launch-email openings for a reusable insulated coffee cup aimed at commuters. Use a clear benefit, a concrete detail and a natural, non-hype voice. Return {"variations":["...","...","..."]}.',
    assertions: [
      { type: 'json-valid', severity: 'critical' },
      { type: 'array-length', path: ['variations'], value: 3, severity: 'critical' },
      { type: 'word-count', min: 60, max: 110, severity: 'major' }
    ], rubric: {}, holdout: false
  },
  {
    category: 'layout', title: 'Landing page content flow', system: 'State assumptions explicitly. Do not write finished marketing copy.',
    prompt: 'Plan the content hierarchy and visitor flow for a landing page for a neighbourhood bicycle repair studio. Include section order, the primary CTA and where trust evidence belongs. Name accessibility considerations and state any assumptions.',
    assertions: [
      { type: 'includes', value: 'CTA', severity: 'major' },
      { type: 'includes', value: 'assumption', severity: 'minor' }
    ], rubric: {}, holdout: false
  },
  {
    category: 'code', title: 'Find an off-by-one defect', system: 'Explain the defect, give a minimal repair and list boundary cases. Do not claim you executed tests.',
    prompt: 'Review this JavaScript function:\n\nfunction firstAvailable(items) {\n  for (let i = 0; i <= items.length; i++) {\n    if (!items[i].taken) return items[i];\n  }\n  return null;\n}\n\nIdentify the exact logic defect, explain the failing boundary case, propose a repair and name useful tests.',
    assertions: [], rubric: {}, holdout: false
  }
];

export function initCompare({ api, getProviders, notify = () => {} }) {
  let providers = [];
  let catalogue = [];
  let cases = [];
  let selectedCaseKeys = new Set();
  let preflight = null;
  let run = null;
  let runController = null;
  let renderQueued = false;
  let visited = false;
  let restoredRunId = null;
  let rerunOf = null;
  let reportLoadedId = null;
  let exportContent = '';
  let submissionId = null;
  let starting = false;
  let preflightRevision = 0;
  let runRevision = 0;

  function invalidatePreflight() {
    preflight = null;
    submissionId = null;
    rerunOf = null;
    return ++preflightRevision;
  }

  function selectedModel(side) {
    const value = $(`#${side}-model`).value;
    return catalogue.find(model => keyOf(model) === value) || null;
  }

  function selectedCases() {
    return cases.filter(item => selectedCaseKeys.has(`${item.id}@${item.version}`));
  }

  function modelProviders() {
    return providers.filter(provider => PROVIDERS.has(provider.presetId));
  }

  function renderModelOptions() {
    const old = Object.fromEntries(['left', 'right'].map(side => [side, $(`#${side}-model`).value]));
    for (const side of ['left', 'right']) {
      const select = $(`#${side}-model`);
      const groups = modelProviders().map(provider => {
        const items = catalogue.filter(model => model.providerId === provider.id);
        const group = document.createElement('optgroup');
        group.label = provider.name;
        for (const model of items) {
          const option = new Option(`${model.name || model.modelId}${model.mappingRequired ? ' · protocol mapping required' : ''}${model.available ? '' : ' · unavailable'}`, keyOf(model));
          group.append(option);
        }
        return group;
      });
      select.replaceChildren(new Option('Choose a model', ''), ...groups);
      if (catalogue.some(model => keyOf(model) === old[side])) select.value = old[side];
      renderCapability(side, true);
    }
    updateRunAvailability();
  }

  function renderCapability(side, resetRoute = false) {
    const model = selectedModel(side);
    const provider = providers.find(item => item.id === model?.providerId);
    $(`#${side}-route-control`).hidden = provider?.presetId !== 'openrouter' || !model;
    const routeField = $(`#${side}-route`);
    const modelKey = model ? keyOf(model) : '';
    if (resetRoute || routeField.dataset.model !== modelKey) {
      routeField.value = model?.route || '';
      routeField.dataset.model = modelKey;
    }
    const mapping = $(`#${side}-mapping`);
    mapping.hidden = !model?.mappingRequired;
    if (model?.mappingRequired) {
      const provider = providers.find(item => item.id === model.providerId);
      $(`#${side}-protocol`).value = provider?.comparisonModels?.[model.modelId]?.protocol || '';
    }
    const label = $(`#${side}-capabilities`);
    if (!model) {
      label.textContent = 'Select a model to inspect its control support.';
      return;
    }
    const params = model.capabilities?.parameters || {};
    label.textContent = `${model.protocol || 'Protocol unknown'} · Temperature ${params.temperature || 'unknown'} · Top-P ${params.topP || 'unknown'} · Output tokens ${params.maxOutputTokens || 'unknown'}${model.available ? '' : ' · unavailable until mapped'}`;
  }

  function renderCases() {
    const root = $('#compare-cases');
    const hadChoices = Boolean(root.querySelector('input[type="checkbox"]'));
    const selected = new Set(selectedCaseKeys);
    for (const input of root.querySelectorAll('input:checked')) selected.add(input.value);
    const chooseDefaults = !hadChoices && selected.size === 0;
    const filter = $('#compare-category-filter').value;
    root.replaceChildren();
    if (!cases.length) {
      root.append(text('span', 'No saved cases. Refresh to add examples.', 'empty'));
      return;
    }
    for (const item of cases) {
      if (filter !== 'all' && item.category !== filter) continue;
      const row = document.createElement('div');
      row.className = 'case-choice-row';
      const label = document.createElement('label');
      label.className = 'case-choice';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = `${item.id}@${item.version}`;
      input.checked = selected.has(input.value) || (chooseDefaults && !item.holdout);
      const copy = document.createElement('span');
      copy.className = 'case-choice-copy';
      copy.append(text('span', `${item.category.toUpperCase()} · v${item.version}`, 'case-kind'));
      copy.append(text('span', item.title, 'case-title'));
      if (item.holdout) copy.append(text('span', 'Holdout case', 'case-holdout'));
      label.append(input, copy);
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'text-button'; edit.textContent = 'Edit';
      edit.addEventListener('click', () => populateCaseEditor(item));
      input.addEventListener('change', () => {
        if (input.checked) selectedCaseKeys.add(input.value);
        else selectedCaseKeys.delete(input.value);
        invalidatePreflight();
        updateRunAvailability();
      });
      row.append(label, edit);
      root.append(row);
    }
    selectedCaseKeys = selected;
    updateRunAvailability();
  }

  function populateCaseEditor(item = null) {
    $('#case-id').value = item?.id || '';
    $('#case-category').value = item?.category || 'copy';
    $('#case-title').value = item?.title || '';
    $('#case-system').value = item?.system || '';
    $('#case-prompt').value = item?.prompt || '';
    $('#case-assertions').value = JSON.stringify(item?.assertions || [], null, 2);
    // A changed case version is no longer a holdout until the user marks the new version.
    $('#case-holdout').checked = false;
    $('#compare-case-editor').open = true;
    $('#case-title').focus();
  }

  async function saveCase(event) {
    event.preventDefault();
    try {
      const id = $('#case-id').value || `case-${crypto.randomUUID()}`;
      const prior = cases.find(item => item.id === id);
      let assertions;
      try { assertions = JSON.parse($('#case-assertions').value || '[]'); }
      catch { throw new Error('Assertions must be valid JSON.'); }
      if (!Array.isArray(assertions)) throw new Error('Assertions must be a JSON array.');
      const saved = await api('/api/comparison/cases', {
        method: 'POST', body: JSON.stringify({
          id, version: prior ? prior.version + 1 : 1,
          category: $('#case-category').value,
          title: $('#case-title').value,
          system: $('#case-system').value,
          prompt: $('#case-prompt').value,
          assertions, rubric: {}, holdout: $('#case-holdout').checked
        })
      });
      if (prior) selectedCaseKeys.delete(`${id}@${prior.version}`);
      selectedCaseKeys.add(`${id}@${saved.caseVersion.version}`);
      cases = (await api('/api/comparison/cases')).cases || [];
      if ($('#compare-category-filter').value !== 'all' && $('#compare-category-filter').value !== saved.caseVersion.category) {
        $('#compare-category-filter').value = saved.caseVersion.category;
      }
      renderCases();
      const checkbox = [...$('#compare-cases').querySelectorAll('input')].find(input => input.value === `${id}@${saved.caseVersion.version}`);
      if (checkbox) checkbox.checked = true;
      $('#compare-case-editor').open = false;
      invalidatePreflight();
      $('#compare-status').textContent = `Saved ${saved.caseVersion.title} as version ${saved.caseVersion.version}. Previous run snapshots remain unchanged.`;
      updateRunAvailability();
    } catch (error) { notify(error.message); }
  }

  async function loadCases() {
    const result = await api('/api/comparison/cases');
    cases = result.cases || [];
    if (!cases.length) {
      for (const [index, example] of EXAMPLES.entries()) {
        await api('/api/comparison/cases', {
          method: 'POST',
          body: JSON.stringify({ ...example, id: `example-${example.category}`, version: 1 })
        });
      }
      cases = (await api('/api/comparison/cases')).cases || [];
    }
    renderCases();
  }

  async function providersChanged() {
    providers = getProviders();
    if (!visited) return;
    await discoverAll();
  }

  async function discoverAll() {
    invalidatePreflight();
    const availableProviders = modelProviders();
    const results = await Promise.all(availableProviders.map(async provider => {
      try {
        const response = await api(`/api/comparison/models?providerId=${encodeURIComponent(provider.id)}`);
        return response.models || [];
      } catch (error) {
        notify(`${provider.name}: ${error.message}`);
        return [];
      }
    }));
    catalogue = results.flat().map(model => ({
      ...model,
      providerName: providers.find(provider => provider.id === model.providerId)?.name || 'Provider'
    }));
    renderModelOptions();
  }

  function currentInput() {
    const left = selectedModel('left');
    const right = selectedModel('right');
    const testCases = selectedCases();
    if (!left || !right) throw new Error('Choose one model on each side.');
    if (!left.available || !right.available) throw new Error('Save a documented protocol mapping for each unavailable model first.');
    if (!testCases.length) throw new Error('Select at least one test case.');
    for (const model of [left, right]) {
      const provider = providers.find(item => item.id === model.providerId);
      if (provider?.presetId === 'opencode-go' && testCases.some(item => item.category !== 'code')) {
        throw new Error('OpenCode Go can only be compared on coding cases.');
      }
    }
    return {
      caseVersions: testCases,
      left, right,
      baselineSide: $('#compare-baseline').value || null,
      settings: {
        temperature: Number($('#compare-temperature').value),
        topP: Number($('#compare-top-p').value),
        maxOutputTokens: Number($('#compare-max-tokens').value),
        stream: $('#compare-stream').checked,
        timeoutMs: Number($('#compare-timeout').value)
      },
      repetitions: Number($('#compare-repetitions').value),
      exploratoryConfirmed: $('#compare-exploratory').checked
    };
  }

  function updateRunAvailability() {
    const chosenCases = selectedCases();
    const goUnsupported = ['left', 'right'].some(side => {
      const model = selectedModel(side);
      const provider = providers.find(item => item.id === model?.providerId);
      return provider?.presetId === 'opencode-go' && chosenCases.some(item => item.category !== 'code');
    });
    const selectionOkay = selectedModel('left')?.available && selectedModel('right')?.available && chosenCases.length > 0 && !goUnsupported;
    if (goUnsupported) $('#compare-status').textContent = 'OpenCode Go is available for coding cases only.';
    $('#compare-preflight').disabled = !selectionOkay || Boolean(run && ['queued', 'running'].includes(run.status));
    $('#compare-run').disabled = !preflight || Boolean(run && ['queued', 'running'].includes(run.status));
  }

  async function checkPreflight() {
    const revision = invalidatePreflight();
    try {
      $('#compare-status').textContent = 'Checking model compatibility…';
      $('#compare-run').disabled = true;
      const input = currentInput();
      const result = await api('/api/comparisons/preflight', { method: 'POST', body: JSON.stringify({ input }) });
      if (revision !== preflightRevision) return;
      preflight = result;
      $('#compare-status').textContent = `${preflight.pairs} paired case${preflight.pairs === 1 ? '' : 's'} · ${preflight.requestCount} model requests · parameter equivalence ${preflight.parameterEquivalence}. ${preflight.warnings.join(' ')}`;
      updateRunAvailability();
    } catch (error) {
      if (revision !== preflightRevision) return;
      invalidatePreflight();
      $('#compare-status').textContent = error.message;
      notify(error.message);
      updateRunAvailability();
    }
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderRun();
    });
  }

  function setRunLocation(id) {
    const url = new URL(location.href);
    url.hash = `comparison=${encodeURIComponent(id)}`;
    history.replaceState(null, '', url);
  }

  function labelFor(side) {
    const model = run?.input?.[side];
    const provider = providers.find(item => item.id === model?.providerId);
    return model ? `${provider?.name || model.providerId} / ${model.modelId}` : side;
  }

  async function runBoth(event) {
    event.preventDefault();
    if (!preflight || starting) return;
    starting = true;
    try {
      $('#compare-run').disabled = true;
      $('#compare-run-status').textContent = 'Starting both models…';
      const result = await api('/api/comparisons', {
        method: 'POST',
        body: JSON.stringify({ input: preflight.input, submissionId: submissionId ||= crypto.randomUUID(), rerunOf })
      });
      submissionId = null;
      invalidatePreflight();
      rerunOf = null;
      reportLoadedId = null;
      setRunLocation(result.id);
      await restoreRun(result.id);
    } catch (error) {
      $('#compare-run-status').textContent = `Could not start: ${error.message}`;
      notify(error.message);
      updateRunAvailability();
    } finally { starting = false; }
  }

  async function runAgain() {
    if (!run?.id) return;
    const sourceId = run.id;
    const input = structuredClone(run.input);
    const revision = invalidatePreflight();
    updateRunAvailability();
    try {
      const result = await api('/api/comparisons/preflight', {
        method: 'POST', body: JSON.stringify({ input })
      });
      if (revision !== preflightRevision) return;
      preflight = result;
      rerunOf = sourceId;
      $('#compare-status').textContent = `Rerun preflight ready · ${preflight.requestCount} requests. Original run ${sourceId.slice(0, 8)} remains unchanged.`;
      updateRunAvailability();
    } catch (error) {
      if (revision !== preflightRevision) return;
      invalidatePreflight();
      $('#compare-status').textContent = error.message;
      notify(error.message);
    }
  }

  async function stopSide(side) {
    if (!run?.id) return;
    try { await api(`/api/comparisons/${run.id}/cancel`, { method: 'POST', body: JSON.stringify({ side }) }); }
    catch (error) { notify(error.message); }
  }

  function blindLabel(attempt, side) {
    const labels = run?.blindAssignments?.[attempt.pairId] || { A: 'left', B: 'right' };
    return labels.A === side ? 'A' : 'B';
  }

  async function saveAssessment(attempt, testCase, form) {
    const decision = form.querySelector('[name="decision"]').value;
    const scores = Object.fromEntries([...form.querySelectorAll('[data-dimension]')]
      .filter(input => input.value !== '')
      .map(input => [input.dataset.dimension, Number(input.value)]));
    const reviewed = decision !== 'pending';
    const reason = form.querySelector('[name="reason"]').value.trim();
    if (reviewed && (!reason || Object.keys(scores).length !== form.querySelectorAll('[data-dimension]').length)) {
      return notify('Complete every rubric score and add a reason before recording a decision.');
    }
    const executionStatus = form.querySelector('[name="execution-status"]')?.value || 'unverified';
    const execution = {
      status: executionStatus,
      evidence: executionStatus === 'unverified' ? null : {
        source: form.querySelector('[name="execution-source"]').value.trim(),
        date: form.querySelector('[name="execution-date"]').value,
        notes: form.querySelector('[name="execution-notes"]').value.trim()
      }
    };
    try {
      await api(`/api/comparisons/${run.id}/assessment`, {
        method: 'POST', body: JSON.stringify({
          attemptId: attempt.id,
          assessment: {
            reviewed, accepted: decision === 'pending' ? null : decision === 'accept',
            criticalFailure: form.querySelector('[name="critical-failure"]').checked,
            scores, reason, execution
          }
        })
      });
      run = await api(`/api/comparisons/${run.id}`);
      reportLoadedId = null;
      scheduleRender();
      refreshHistory();
      notify(`Saved blind review for response ${blindLabel(attempt, attempt.side)}.`);
    } catch (error) { notify(error.message); }
  }

  async function savePairAssessment(pairId, form) {
    try {
      await api(`/api/comparisons/${run.id}/pair-assessment`, {
        method: 'POST', body: JSON.stringify({
          pairId,
          choice: form.querySelector('[name="pair-choice"]').value,
          reason: form.querySelector('[name="pair-reason"]').value.trim()
        })
      });
      run = await api(`/api/comparisons/${run.id}`);
      reportLoadedId = null;
      scheduleRender();
      refreshHistory();
      notify('Saved the blind A/B preference.');
    } catch (error) { notify(error.message); }
  }

  function reviewCard(attempt, testCase) {
    const details = document.createElement('details');
    details.className = 'review-card';
    details.append(text('summary', `Blind human review · Response ${blindLabel(attempt, attempt.side)}`));
    const form = document.createElement('form');
    form.addEventListener('submit', event => { event.preventDefault(); saveAssessment(attempt, testCase, form); });
    const decisionLabel = text('label', 'Decision');
    const decision = document.createElement('select'); decision.name = 'decision';
    for (const [value, label] of [['pending', 'Pending review'], ['accept', 'Accept'], ['reject', 'Reject']]) decision.add(new Option(label, value));
    if (attempt.assessment?.reviewed) decision.value = attempt.assessment.accepted ? 'accept' : 'reject';
    decisionLabel.append(decision); form.append(decisionLabel);

    const rubric = testCase.rubric && Object.keys(testCase.rubric).length
      ? testCase.rubric
      : RUBRIC_DEFAULTS[testCase.category] || {};
    const scores = document.createElement('div'); scores.className = 'review-grid';
    for (const dimension of Object.keys(rubric)) {
      const label = text('label', dimension.replace(/[A-Z]/g, char => ` ${char.toLowerCase()}`));
      const select = document.createElement('select'); select.dataset.dimension = dimension;
      select.add(new Option('Not scored', ''));
      for (let value = 0; value <= 4; value++) select.add(new Option(String(value), String(value)));
      const saved = attempt.assessment?.scores?.[dimension];
      if (Number.isInteger(saved)) select.value = String(saved);
      label.append(select); scores.append(label);
    }
    form.append(scores);
    const criticalLabel = document.createElement('label'); criticalLabel.className = 'toggle-label';
    const critical = document.createElement('input'); critical.type = 'checkbox'; critical.name = 'critical-failure';
    critical.checked = attempt.assessment?.criticalFailure === true;
    criticalLabel.append(critical, text('span', 'Record a critical failure'));
    form.append(criticalLabel);
    const reasonLabel = text('label', 'Reason for this decision');
    const reason = document.createElement('textarea'); reason.name = 'reason'; reason.rows = 3;
    reason.value = attempt.assessment?.reason || '';
    reasonLabel.append(reason); form.append(reasonLabel);

    if (testCase.category === 'code') {
      const executionLabel = text('label', 'Execution evidence (external, user supplied)');
      const execution = document.createElement('select'); execution.name = 'execution-status';
      for (const [value, label] of [['unverified', 'Not execution-verified'], ['pass', 'External test passed'], ['fail', 'External test failed']]) execution.add(new Option(label, value));
      execution.value = attempt.assessment?.execution?.status || 'unverified';
      executionLabel.append(execution); form.append(executionLabel);
      const evidence = attempt.assessment?.execution?.evidence || {};
      for (const [name, labelText, current] of [
        ['execution-source', 'Test source or tool', evidence.source || ''],
        ['execution-date', 'Test date', evidence.date || ''],
        ['execution-notes', 'Evidence notes', evidence.notes || '']
      ]) {
        const label = text('label', labelText);
        const input = name === 'execution-notes' ? document.createElement('textarea') : document.createElement('input');
        input.name = name;
        if (name === 'execution-date') input.type = 'date';
        input.value = current;
        label.append(input); form.append(label);
      }
    }
    const submit = document.createElement('button'); submit.className = 'button subtle'; submit.type = 'submit'; submit.textContent = 'Save blind review';
    form.append(submit); details.append(form);
    return details;
  }

  function sidePane(attempt, side, testCase, revealIdentity) {
    const pane = document.createElement('section');
    pane.className = 'comparison-side';
    const head = document.createElement('div');
    head.className = 'comparison-side-heading';
    const stateLabel = text('span', attempt.status, `attempt-status state-${attempt.status}`);
    const blind = blindLabel(attempt, side);
    head.append(text('h4', revealIdentity ? labelFor(side) : `Response ${blind}`), stateLabel);
    const stop = document.createElement('button');
    stop.type = 'button'; stop.className = 'button subtle'; stop.textContent = `Stop response ${blind}`;
    stop.disabled = !['queued', 'running'].includes(attempt.status);
    stop.addEventListener('click', () => stopSide(side));
    head.append(stop);
    pane.append(head);
    const output = text('pre', attempt.output || (attempt.status === 'running' ? 'Waiting for response…' : 'No output.'), 'comparison-output');
    pane.append(output);
    if (revealIdentity) {
      const meta = [
        `HTTP: ${attempt.responseStatus ?? 'unknown'}`,
        `Finish: ${attempt.finishReason || 'unknown'}`,
        `First response: ${attempt.metrics?.firstResponseMs ?? 'unknown'} ms`,
        `First content: ${attempt.metrics?.firstContentMs ?? 'unknown'} ms`,
        `Total: ${attempt.metrics?.totalMs ?? 'unknown'} ms`,
        `Usage: ${attempt.usage ? JSON.stringify(attempt.usage) : 'unknown'}`,
        `Cost: ${attempt.usage && run.input[side].pricingObservedAt ? 'estimated from saved provider pricing' : 'unknown'}`
      ].join(' · ');
      pane.append(text('p', meta, 'attempt-meta'));
    } else {
      pane.append(text('p', 'Model identity, provider errors, request details, timing and pricing are hidden until both responses are reviewed.', 'attempt-meta'));
    }
    if (Array.isArray(attempt.assertions) && attempt.assertions.length) {
      const checks = document.createElement('ul'); checks.className = 'assertion-results';
      for (const result of attempt.assertions) checks.append(text('li', `${result.passed ? 'Passed' : 'Failed'} · ${result.severity} · ${result.type}${result.message ? ` · ${result.message}` : ''}`, result.passed ? 'assertion-pass' : 'assertion-fail'));
      pane.append(checks);
    }
    if (attempt.error && revealIdentity) pane.append(text('p', attempt.error, 'attempt-error'));
    else if (attempt.error) pane.append(text('p', 'Failure details are hidden until both responses are reviewed.', 'attempt-meta'));
    const details = document.createElement('details');
    details.className = 'developer';
    details.hidden = !revealIdentity;
    details.append(text('summary', 'Request and raw provider evidence'));
    details.append(text('h5', 'Redacted request'));
    details.append(text('pre', JSON.stringify(attempt.request || {}, null, 2)));
    details.append(text('h5', `Raw response${attempt.rawTruncated ? ' · truncated at 1 MiB' : ''}`));
    details.append(text('pre', attempt.raw || 'No raw response.'));
    pane.append(details);
    if (testCase && !['queued', 'running'].includes(run.status) && ['complete', 'error', 'timeout', 'cancelled', 'interrupted'].includes(attempt.status)) {
      pane.append(reviewCard(attempt, testCase));
    } else if (testCase) {
      pane.append(text('p', 'Blind review opens after the whole batch finishes.', 'attempt-meta'));
    }
    return pane;
  }

  function percent(value) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'unknown';
  }

  function modelLabel(identity) {
    if (!Array.isArray(identity)) return 'Unknown model';
    const [providerId, modelId, , , route] = identity;
    const provider = providers.find(item => item.id === providerId);
    return `${provider?.name || providerId || 'Provider'} / ${modelId || 'model'}${route ? ` · ${route}` : ''}`;
  }

  function renderReport(report) {
    const root = $('#compare-report');
    root.hidden = false;
    if (!report.groups.length) {
      root.replaceChildren(text('p', 'No result metrics are available yet.', 'empty'));
      return;
    }
    const content = [text('h3', 'Evidence summary'), text('p', 'API model comparison, not the full ChatGPT or Claude product. Results are separated by case version, settings and route.', 'report-note')];
    for (const group of report.groups) {
      const card = document.createElement('article');
      card.className = 'report-group';
      card.append(text('h4', `${group.category.toUpperCase()} · ${group.caseTitle || group.caseId}@v${group.caseVersion}`));
      card.append(text('p', `${modelLabel(group.modelPair.left)}  ↔  ${modelLabel(group.modelPair.right)}`, 'report-models'));
      card.append(text('p', `Premium baseline: ${group.baselineSide ? modelLabel(group.modelPair[group.baselineSide]) : 'not specified'}`));
      for (const side of ['left', 'right']) {
        const summary = group.sides[side];
        card.append(text('h5', `${side === 'left' ? 'Left' : 'Right'} model · ${modelLabel(group.modelPair[side])}`));
        card.append(text('p', `${summary.attempts} attempts · completion ${percent(summary.operationalSuccessRate)} · reviewed acceptance ${percent(summary.reviewedAcceptanceRate)} · review coverage ${percent(summary.reviewCoverage)} · acceptable/all ${percent(summary.conservativeAcceptableRate)}`));
        card.append(text('p', `Accepted ${summary.acceptableCount} · pending ${summary.pendingCount} · quality ${summary.quality ? `${summary.quality.median}/4 (n=${summary.quality.n})` : 'unknown'} · median latency ${summary.latency ? `${summary.latency.medianMs} ms (n=${summary.latency.n})` : 'unknown'} · estimated API cost ${summary.estimatedCost ? `$${summary.estimatedCost.amountUsd.toFixed(6)}` : 'unknown'}`));
      }
      card.append(text('p', `Operational completion ${percent(group.operationalSuccessRate)} · ${group.attempts} attempts`));
      card.append(text('p', `Reviewed acceptance ${percent(group.reviewedAcceptanceRate)} · review coverage ${percent(group.reviewCoverage)} · conservative acceptable/all ${percent(group.conservativeAcceptableRate)}`));
      card.append(text('p', `Accepted ${group.acceptableCount} · pending ${group.pendingCount} · failures ${Object.entries(group.failuresByType).map(([name, count]) => `${name}: ${count}`).join(', ') || 'none recorded'}`));
      card.append(text('p', group.quality ? `Quality median ${group.quality.median}/4 (n=${group.quality.n}; range ${group.quality.min}–${group.quality.max})` : 'Quality score: unknown until rubric reviews are recorded.'));
      card.append(text('p', `Paired rubric outcomes: left ${group.paired.wins} wins · ${group.paired.ties} ties · right ${group.paired.losses} wins (n=${group.paired.n}); blind preference mapped to left ${group.paired.humanPreference.left}, right ${group.paired.humanPreference.right}, tie ${group.paired.humanPreference.tie}, neither ${group.paired.humanPreference.neither} (n=${group.paired.humanPreference.n})`));
      card.append(text('p', group.latency
        ? `Observed latency: n=${group.latency.n}, median ${group.latency.medianMs} ms${group.latency.p95Ms === null ? ' · p95 withheld until n≥20' : ` · p95 ${group.latency.p95Ms} ms`}`
        : 'Observed latency: unknown.'));
      const usages = group.usage?.samples || [];
      card.append(text('p', usages.length
        ? `Provider-reported usage (${group.usage.n} samples): ${usages.map(sample => `${sample.providerId}/${sample.modelId} ${JSON.stringify(sample.usage)}`).join(' · ')}`
        : 'Provider-reported usage: unknown.'));
      card.append(text('p', group.estimatedCost
        ? `Estimated API cost: $${group.estimatedCost.amountUsd.toFixed(6)} USD · prices observed ${group.estimatedCost.pricesObservedAt.join(', ')}`
        : 'Estimated API cost: unknown; usage and timestamped prices must both be available.'));
      card.append(text('p', group.costPerAcceptableResult === null
        ? 'Estimated cost per acceptable result: unknown.'
        : `Estimated API cost per acceptable result: $${group.costPerAcceptableResult.toFixed(6)} USD.`));
      if (group.subscriptionAllocation) card.append(text('p', group.subscriptionAllocation, 'report-note'));
      content.push(card);
    }
    root.replaceChildren(...content);
  }

  async function refreshReport() {
    if (!run?.id) return;
    const id = run.id;
    reportLoadedId = id;
    try {
      const report = await api(`/api/comparisons/${encodeURIComponent(id)}/report`);
      if (run?.id === id) renderReport(report);
    } catch (error) {
      if (run?.id === id) $('#compare-report').replaceChildren(text('p', `Report unavailable: ${error.message}`, 'attempt-error'));
    }
  }

  function pairJudgement(pairId) {
    const saved = run.pairAssessments?.[pairId];
    const form = document.createElement('form');
    form.className = 'pair-judgement';
    form.addEventListener('submit', event => { event.preventDefault(); savePairAssessment(pairId, form); });
    const choiceLabel = text('label', 'Blind pair preference');
    const choice = document.createElement('select');
    choice.name = 'pair-choice'; choice.required = true;
    choice.add(new Option('Choose A, B, tie or neither', ''));
    for (const value of ['A', 'B', 'tie', 'neither']) choice.add(new Option(value, value));
    choice.value = saved?.choice || '';
    choiceLabel.append(choice);
    const reasonLabel = text('label', 'Reason');
    const reason = document.createElement('textarea'); reason.name = 'pair-reason'; reason.required = true;
    reason.rows = 2; reason.value = saved?.reason || '';
    reasonLabel.append(reason);
    const submit = document.createElement('button');
    submit.className = 'button subtle'; submit.type = 'submit'; submit.textContent = saved ? 'Update preference' : 'Save preference';
    form.append(choiceLabel, reasonLabel, submit);
    return form;
  }

  function renderRun() {
    const root = $('#compare-results');
    if (!run) {
      root.replaceChildren(text('p', 'Run a comparison to see paired responses here.', 'empty'));
      $('#compare-run-again').hidden = true;
      $('#compare-export').hidden = true;
      $('#compare-verdict').hidden = true;
      $('#compare-report').hidden = true;
      return;
    }
    const pairs = new Map();
    for (const attempt of run.attempts || []) {
      const pair = pairs.get(attempt.pairId) || [];
      pair.push(attempt);
      pairs.set(attempt.pairId, pair);
    }
    const cards = [];
    const terminal = new Set(['complete', 'error', 'timeout', 'cancelled', 'interrupted']);
    for (const [pairId, attempts] of pairs) {
      const item = run.input.caseVersions.find(testCase => testCase.id === attempts[0]?.caseId && testCase.version === attempts[0]?.caseVersion);
      const bothReviewed = ['left', 'right'].every(side => attempts.find(value => value.side === side)?.assessment?.reviewed === true);
      const pairFinished = attempts.length === 2 && attempts.every(attempt => terminal.has(attempt.status));
      const group = document.createElement('article');
      group.className = 'pair-card';
      const heading = document.createElement('div'); heading.className = 'pair-heading';
      heading.append(text('h3', `${item?.category?.toUpperCase() || 'CASE'} · ${item?.title || attempts[0]?.caseId}`));
      heading.append(text('span', `Repetition ${attempts[0]?.repetition || 1} · ${pairId.slice(0, 8)}`, 'status'));
      const columns = document.createElement('div'); columns.className = 'comparison-columns';
      const assignment = run.blindAssignments?.[pairId] || { A: 'left', B: 'right' };
      for (const side of [assignment.A, assignment.B]) {
        const attempt = attempts.find(value => value.side === side);
        if (attempt) columns.append(sidePane(attempt, side, item, bothReviewed));
      }
      group.append(heading, columns);
      if (pairFinished && bothReviewed) group.append(pairJudgement(pairId));
      cards.push(group);
    }
    root.replaceChildren(...cards);
    $('#compare-run-status').textContent = `${run.status}${run.finishedAt ? ` · ${new Date(run.finishedAt).toLocaleString()}` : ''}`;
    $('#compare-stop-all').hidden = !['queued', 'running'].includes(run.status);
    $('#compare-run-again').hidden = ['queued', 'running'].includes(run.status);
    $('#compare-export').hidden = false;
    $('#compare-verdict').hidden = ['queued', 'running'].includes(run.status);
    if (run.verdict) {
      $('#verdict-value').value = run.verdict.value;
      $('#verdict-evidence').value = String(run.verdict.evidenceCount ?? 0);
      $('#verdict-rationale').value = run.verdict.rationale || '';
    }
    const allReviewed = run.attempts.length > 0 && run.attempts.every(attempt => attempt.assessment?.reviewed === true);
    if (!allReviewed) {
      reportLoadedId = null;
      $('#compare-report').hidden = false;
      $('#compare-report').replaceChildren(text('p', 'Report metrics and model identity stay hidden until every response has blind review.', 'report-note'));
    } else if (reportLoadedId !== run.id) {
      refreshReport();
    }
    updateRunAvailability();
  }

  function applyEvent(event) {
    if (event.runId !== restoredRunId) return;
    if (event.type === 'snapshot') {
      run = event.data;
      scheduleRender();
      return;
    }
    if (event.type === 'delta') {
      const attempt = run?.attempts.find(item => item.id === event.attemptId);
      if (attempt) attempt.output = (attempt.output || '') + (event.data?.text || '');
    } else if (event.type === 'request') {
      const attempt = run?.attempts.find(item => item.id === event.attemptId);
      if (attempt) { attempt.status = 'running'; attempt.request = event.data; }
    } else if (event.type === 'raw') {
      const attempt = run?.attempts.find(item => item.id === event.attemptId);
      if (attempt) attempt.raw = (attempt.raw || '') + (event.data?.text || '');
    } else if (event.type === 'response') {
      const attempt = run?.attempts.find(item => item.id === event.attemptId);
      if (attempt) { attempt.responseStatus = event.data?.status; attempt.responseHeaders = event.data?.headers; }
    } else if (event.type === 'terminal') {
      if (!event.attemptId) {
        if (Array.isArray(event.data?.attempts)) run = event.data;
        else if (event.data?.status && run) run.status = event.data.status;
      }
      refreshHistory();
    }
    const attempt = run?.attempts.find(item => item.id === event.attemptId);
    if (event.type === 'terminal' && attempt) Object.assign(attempt, event.data);
    scheduleRender();
  }

  async function followRun(id, revision) {
    if (runController) runController.abort();
    runController = new AbortController();
    const response = await fetch(`/api/comparisons/${encodeURIComponent(id)}/events`, {
      signal: runController.signal,
      headers: { 'x-session-token': document.querySelector('meta[name="session-token"]').content }
    });
    if (!response.ok || !response.body) throw new Error('Could not reconnect to the comparison.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (revision !== runRevision) return;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) applyEvent(JSON.parse(line));
      }
    }
    const finalLine = buffer.trim();
    if (finalLine && revision === runRevision) applyEvent(JSON.parse(finalLine));
  }

  async function restoreRun(id) {
    if (restoredRunId === id) return;
    restoredRunId = id;
    const revision = ++runRevision;
    runController?.abort();
    runController = null;
    try {
      const loaded = await api(`/api/comparisons/${encodeURIComponent(id)}`);
      if (revision !== runRevision) return;
      run = loaded;
      scheduleRender();
      if (['queued', 'running'].includes(run.status)) await followRun(id, revision);
    } catch (error) {
      if (revision !== runRevision || error.name === 'AbortError') return;
      restoredRunId = null;
      $('#compare-run-status').textContent = `Could not load run: ${error.message}`;
      notify(error.message);
    }
  }

  async function refreshHistory() {
    try {
      const result = await api('/api/comparisons');
      const root = $('#compare-history');
      root.replaceChildren();
      if (!result.runs?.length) return root.append(text('p', 'No saved comparisons yet.', 'empty'));
      for (const item of result.runs) {
        const row = document.createElement('div'); row.className = 'history-row';
        const info = text('span', `${item.category} · ${item.status} · ${item.caseCount} cases · ${item.repetitions} repetition${item.repetitions === 1 ? '' : 's'}${item.rerunOf ? ` · rerun of ${item.rerunOf.slice(0, 8)}` : ''}`);
        const open = document.createElement('button'); open.className = 'text-button'; open.type = 'button'; open.textContent = new Date(item.createdAt).toLocaleString();
        open.addEventListener('click', () => { setRunLocation(item.id); restoreRun(item.id); });
        row.append(info, open); root.append(row);
      }
    } catch (error) { notify(error.message); }
  }

  async function saveMapping(side) {
    const model = selectedModel(side);
    const protocol = $(`#${side}-protocol`).value || model?.protocol;
    if (!model || !PROTOCOLS.includes(protocol)) return notify('Choose a documented protocol mapping.');
    const provider = providers.find(item => item.id === model.providerId);
    try {
      await api('/api/comparison/model-mapping', {
        method: 'POST', body: JSON.stringify({ providerId: model.providerId, modelId: model.modelId, protocol,
          ...(provider?.presetId === 'openrouter' ? { route: $(`#${side}-route`).value.trim() || null } : {}) })
      });
      invalidatePreflight();
      notify('Model mapping saved. Run preflight again before starting.');
      await discoverAll();
    } catch (error) { notify(error.message); }
  }

  async function saveVerdict() {
    if (!run?.id) return;
    const rationale = $('#verdict-rationale').value.trim();
    if (!rationale) return notify('Add a rationale for the replacement judgement.');
    try {
      await api(`/api/comparisons/${run.id}/verdict`, {
        method: 'POST', body: JSON.stringify({
          verdict: $('#verdict-value').value,
          rationale,
          evidenceCount: Number($('#verdict-evidence').value)
        })
      });
      run = await api(`/api/comparisons/${run.id}`);
      scheduleRender();
      refreshHistory();
      notify('Saved the human replacement judgement.');
    } catch (error) { notify(error.message); }
  }

  async function previewExport() {
    if (!run?.id) return;
    try {
      const report = await api(`/api/comparisons/${encodeURIComponent(run.id)}/report`);
      exportContent = JSON.stringify(report, null, 2);
      $('#compare-export-preview').textContent = exportContent;
      $('#compare-export-dialog').showModal();
    } catch (error) { notify(error.message); }
  }

  function downloadExport(event) {
    event.preventDefault();
    if (!exportContent || !run?.id) return;
    const url = URL.createObjectURL(new Blob([exportContent], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `llm-comparison-${run.id}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    $('#compare-export-dialog').close();
  }

  $('#compare-form').addEventListener('input', () => {
    invalidatePreflight();
    $('#compare-status').textContent = 'Settings changed. Run preflight again before starting.';
    updateRunAvailability();
  });
  $('#compare-form').addEventListener('change', () => {
    invalidatePreflight();
    updateRunAvailability();
    for (const side of ['left', 'right']) renderCapability(side);
  });
  $('#left-model').addEventListener('change', () => renderCapability('left'));
  $('#right-model').addEventListener('change', () => renderCapability('right'));
  $('#compare-preflight').addEventListener('click', checkPreflight);
  $('#compare-run').addEventListener('click', runBoth);
  $('#compare-stop-all').addEventListener('click', () => stopSide('both'));
  $('#compare-five-repetitions').addEventListener('click', () => {
    $('#compare-repetitions').value = '5';
    $('#compare-repetitions').dispatchEvent(new Event('input', { bubbles: true }));
  });
  $('#compare-category-filter').addEventListener('change', renderCases);
  $('#new-case').addEventListener('click', () => populateCaseEditor());
  $('#case-editor-form').addEventListener('submit', saveCase);
  $('#compare-run-again').addEventListener('click', runAgain);
  $('#compare-export').addEventListener('click', previewExport);
  $('#download-comparison').addEventListener('click', downloadExport);
  $('#save-verdict').addEventListener('click', saveVerdict);
  $('#compare-refresh').addEventListener('click', async () => {
    await Promise.all([discoverAll(), loadCases(), refreshHistory()]);
  });
  $('#compare-history-refresh').addEventListener('click', refreshHistory);
  document.querySelectorAll('[data-save-mapping]').forEach(button => button.addEventListener('click', () => saveMapping(button.dataset.saveMapping)));
  window.addEventListener('hashchange', () => {
    const match = location.hash.match(/^#comparison=([^&]+)/);
    if (match) restoreRun(decodeURIComponent(match[1]));
  });

  async function opened() {
    if (!visited) {
      visited = true;
      providers = getProviders();
      await Promise.all([loadCases(), discoverAll(), refreshHistory()]);
    } else {
      await Promise.all([discoverAll(), loadCases(), refreshHistory()]);
    }
    const match = location.hash.match(/^#comparison=([^&]+)/);
    if (match) await restoreRun(decodeURIComponent(match[1]));
  }

  loadCases().catch(error => notify(error.message));
  return { providersChanged, opened };
}
