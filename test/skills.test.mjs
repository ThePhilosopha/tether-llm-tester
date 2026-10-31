import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkill, explainMechanically, buildDiagram, parseFrontmatter } from '../lib/skills/parse.mjs';
import { createSkillStore, skillSlug } from '../lib/skills/store.mjs';

const SAMPLE = `---
name: release-notes
description: Turn a commit list into release notes.
allowed-tools: bash git
---

# Release notes

1. Read the commit list.
2. If a commit is a fix, group it under Fixes.
3. Otherwise group it under Changes.
4. Check \`references/template.md\` before writing.

Use a friendly tone and never invent a contributor name.

- Keep entries under 90 characters.
`;

test('extracts steps, decisions, files and tools from a skill', () => {
  const parsed = parseSkill(SAMPLE, { slug: 'release-notes' });
  assert.equal(parsed.name, 'release-notes');
  assert.equal(parsed.counts.steps, 4);
  assert.equal(parsed.counts.branches, 2);
  assert.deepEqual(parsed.referencedFiles, ['references/template.md']);
  assert.ok(parsed.steps.some(step => step.conditional && /If a commit is a fix/.test(step.text)));
  assert.ok(parsed.unmapped.length >= 1);
  assert.equal(parsed.frontmatterPresent, true);
});

test('survives a skill with no frontmatter and no numbered steps', () => {
  const parsed = parseSkill('# Plain\n\nJust prose about doing a thing carefully and consistently.\n', { slug: 'plain' });
  assert.equal(parsed.frontmatterPresent, false);
  assert.equal(parsed.counts.steps, 0);
  assert.equal(parsed.name, 'plain');
  assert.ok(explainMechanically(parsed).length >= 2);
});

test('parses folded and quoted frontmatter values', () => {
  const { attributes } = parseFrontmatter('---\nname: "quoted-name"\ndescription: >\n  First line\n  second line\n---\nbody\n');
  assert.equal(attributes.name, 'quoted-name');
  assert.match(attributes.description, /First line second line/);
});

test('explains in plain English and builds a connected diagram', () => {
  const parsed = parseSkill(SAMPLE, { slug: 'release-notes' });
  const sentences = explainMechanically(parsed);
  assert.match(sentences[0], /reusable instruction set/);
  assert.ok(sentences.some(line => /Step 1:/.test(line)));
  assert.ok(sentences.some(line => /conditional decision/.test(line)));
  const diagram = buildDiagram(parsed);
  assert.equal(diagram.nodes[0].kind, 'input');
  assert.equal(diagram.nodes.at(-1).kind, 'output');
  assert.ok(diagram.nodes.some(node => node.kind === 'decision'));
  assert.equal(diagram.edges.length, diagram.nodes.length - 1);
});

test('stores skills atomically and rejects unsafe slugs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillstore-'));
  const store = await createSkillStore(root);
  await store.save('release-notes', SAMPLE);
  const loaded = await store.get('release-notes');
  assert.match(loaded.source, /release-notes/);
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.get('missing'), null);
  assert.throws(() => skillSlug('../../etc/passwd'), /letters, numbers/);
  assert.throws(() => skillSlug(''), /letters, numbers/);
  await store.save('release-notes', `${SAMPLE}\nmore\n`);
  assert.match((await store.get('release-notes')).source, /more/);
});
