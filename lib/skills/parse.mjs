const FILE_REFERENCE = /`([^`\n]+\.(?:md|py|sh|js|mjs|json|ya?ml|txt))`|\[[^\]]+\]\((?!https?:)([^)]+\.(?:md|py|sh|js|mjs|json|ya?ml|txt))\)/g;
const TOOL_REFERENCE = /`((?:[a-z0-9_-]+\s){0,3}[a-z0-9_-]+(?:\s+[^`\n]{0,60})?)`/gi;
const CONDITIONAL = /\b(if|when|unless|otherwise|must|never|do not|don't|only if|required)\b/i;

function scalar(text) {
  const value = text.trim();
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { attributes: {}, body: source, bodyOffset: 0, present: false };
  const attributes = {};
  const lines = match[1].split(/\r?\n/);
  let key = null;
  for (const line of lines) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (pair) {
      key = pair[1];
      const rest = pair[2].trim();
      attributes[key] = rest === '>' || rest === '|' ? '' : scalar(rest);
      if (rest === '>' || rest === '|') attributes[key] = '';
      continue;
    }
    if (key && /^\s+/.test(line)) {
      const addition = line.trim();
      attributes[key] = attributes[key] ? `${attributes[key]} ${addition}` : addition;
    }
  }
  return { attributes, body: source.slice(match[0].length), bodyOffset: match[0].split(/\r?\n/).length - 1, present: true };
}

export function parseSkill(source, { slug = '' } = {}) {
  if (typeof source !== 'string') throw new Error('Skill source must be text.');
  const { attributes, body, bodyOffset, present } = parseFrontmatter(source);
  const lines = body.split(/\r?\n/);
  const steps = [];
  const branches = [];
  const referencedFiles = new Set();
  const tools = new Set();
  const unmapped = [];
  let currentHeading = null;

  lines.forEach((line, index) => {
    const lineNumber = index + 1 + bodyOffset;
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      currentHeading = heading[2].trim();
      return;
    }
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const text = numbered ? numbered[2] : bullet ? bullet[1] : null;
    if (text) {
      const entry = {
        kind: numbered ? 'step' : 'bullet',
        order: numbered ? Number(numbered[1]) : null,
        text: text.trim(),
        section: currentHeading,
        line: lineNumber,
        conditional: CONDITIONAL.test(text)
      };
      steps.push(entry);
      if (entry.conditional) {
        branches.push({ text: entry.text, section: entry.section, line: lineNumber, keyword: (text.match(CONDITIONAL) || [])[1]?.toLowerCase() || null });
      }
    }
  });

  for (const match of body.matchAll(FILE_REFERENCE)) {
    const value = (match[1] || match[2] || '').trim();
    if (value) referencedFiles.add(value);
  }
  for (const match of body.matchAll(TOOL_REFERENCE)) {
    const value = match[1].trim();
    if (/^[a-z0-9_-]+(\s|$)/i.test(value) && !referencedFiles.has(value) && !value.includes('.') && value.split(/\s+/).length <= 4) {
      tools.add(value);
    }
  }
  const allowed = attributes['allowed-tools'];
  if (typeof allowed === 'string' && allowed.trim()) {
    for (const item of allowed.split(/[,\s]+/)) if (item.trim()) tools.add(item.trim());
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed)) continue;
    if (/^\s*(\d+[.)]|[-*+])\s/.test(line)) continue;
    if (trimmed.length < 12) continue;
    unmapped.push({ text: trimmed.slice(0, 400) });
  }

  return {
    slug,
    name: attributes.name || slug || 'Untitled skill',
    description: attributes.description || '',
    attributes,
    frontmatterPresent: present,
    heading: lines.find(line => /^#\s+/.test(line))?.replace(/^#\s+/, '').trim() || '',
    steps,
    branches,
    referencedFiles: [...referencedFiles],
    tools: [...tools],
    unmapped,
    counts: {
      lines: source.split(/\r?\n/).length,
      steps: steps.filter(step => step.kind === 'step').length,
      bullets: steps.filter(step => step.kind === 'bullet').length,
      branches: branches.length,
      files: referencedFiles.size,
      tools: tools.size,
      unmapped: unmapped.length
    }
  };
}

function plain(text) {
  return text.replace(/`/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

export function explainMechanically(parsed) {
  const sentences = [];
  sentences.push(`"${parsed.name}" is a reusable instruction set${parsed.description ? ` for ${plain(parsed.description).replace(/\.$/, '')}` : ''}.`);
  const numbered = parsed.steps.filter(step => step.kind === 'step');
  if (numbered.length) {
    sentences.push(`It works through ${numbered.length} ordered step${numbered.length === 1 ? '' : 's'}.`);
    for (const step of numbered.slice(0, 12)) {
      const sentence = plain(step.text);
      sentences.push(`Step ${step.order ?? '·'}: ${sentence.length > 220 ? `${sentence.slice(0, 217)}…` : sentence}`);
    }
    if (numbered.length > 12) sentences.push(`It lists ${numbered.length - 12} further steps.`);
  } else if (parsed.steps.length) {
    sentences.push(`It gives ${parsed.steps.length} guidance point${parsed.steps.length === 1 ? '' : 's'}.`);
    for (const step of parsed.steps.slice(0, 10)) sentences.push(`• ${plain(step.text).slice(0, 200)}`);
  } else {
    sentences.push('It contains prose instructions without an explicit step list.');
  }
  if (parsed.branches.length) {
    sentences.push(`It makes ${parsed.branches.length} conditional decision${parsed.branches.length === 1 ? '' : 's'}, for example: "${plain(parsed.branches[0].text).slice(0, 180)}".`);
  }
  if (parsed.referencedFiles.length) {
    sentences.push(`It may read ${parsed.referencedFiles.length} supporting file${parsed.referencedFiles.length === 1 ? '' : 's'}: ${parsed.referencedFiles.slice(0, 6).join(', ')}.`);
  }
  if (parsed.tools.length) {
    sentences.push(`It refers to ${parsed.tools.length} tool or command${parsed.tools.length === 1 ? '' : 's'}.`);
  }
  if (parsed.unmapped.length) {
    sentences.push(`${parsed.unmapped.length} further prose passage${parsed.unmapped.length === 1 ? '' : 's'} sit outside the step list and are shown unclassified rather than guessed at.`);
  }
  return sentences;
}

export function buildDiagram(parsed) {
  const nodes = [{ id: 'input', kind: 'input', label: 'You ask for help', lines: [] }];
  const edges = [];
  let previous = 'input';
  const ordered = parsed.steps.filter(step => step.kind === 'step');
  const points = ordered.length ? ordered : parsed.steps;
  points.slice(0, 14).forEach((step, index) => {
    const id = `step-${index + 1}`;
    nodes.push({
      id,
      kind: step.conditional ? 'decision' : 'step',
      label: plain(step.text).slice(0, 120),
      order: step.order,
      section: step.section,
      line: step.line
    });
    edges.push({ from: previous, to: id });
    previous = id;
  });
  nodes.push({ id: 'output', kind: 'output', label: 'The skill answers you', lines: [] });
  edges.push({ from: previous, to: 'output' });
  const attachments = parsed.referencedFiles.slice(0, 8).map((file, index) => ({ id: `file-${index + 1}`, label: file }));
  return { nodes, edges, attachments };
}
