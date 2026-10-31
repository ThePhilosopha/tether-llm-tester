import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { skillSlug } from './store.mjs';

const MAX_BYTES = 256 * 1024;

export async function importSkillFromDirectory(directory, name) {
  const slug = skillSlug(name);
  const source = await readFile(join(directory, slug, 'SKILL.md'), 'utf8');
  const extras = [];
  try {
    for (const entry of await readdir(join(directory, slug, 'references'))) {
      extras.push(`references/${entry}`);
    }
  } catch { /* no references directory */ }
  return { slug, source, extras };
}

export async function readSkillText(path) {
  const source = await readFile(path, 'utf8');
  if (Buffer.byteLength(source) > MAX_BYTES) throw new Error('Skill text must stay under 256 KiB for auditing.');
  return source;
}
