import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const SLUG = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

export function skillSlug(value) {
  const slug = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!SLUG.test(slug)) throw new Error('A skill needs a name using letters, numbers, dots, dashes or underscores.');
  return slug;
}

export async function createSkillStore(root) {
  if (typeof root !== 'string' || !root) throw new Error('Skill storage root is required.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const queues = new Map();

  async function atomicWrite(path, text) {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    try { await rename(temp, path); }
    catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error; }
  }

  function pathFor(slug) {
    return join(root, skillSlug(slug), 'SKILL.md');
  }

  async function list() {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const text = await readFile(join(root, entry.name, 'SKILL.md'), 'utf8');
        skills.push({ slug: entry.name, source: text, updatedAt: (await stat(join(root, entry.name, 'SKILL.md'))).mtime.toISOString() });
      } catch { /* not a skill directory */ }
    }
    return skills.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async function get(slug) {
    try { return { slug: skillSlug(slug), source: await readFile(pathFor(slug), 'utf8') }; }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function save(slug, source) {
    const key = skillSlug(slug);
    if (typeof source !== 'string' || !source.trim()) throw new Error('Skill text is required.');
    if (source.length > 512 * 1024) throw new Error('Skill text must stay under 512 KiB.');
    const operation = (queues.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(join(root, key), { recursive: true, mode: 0o700 });
      await atomicWrite(pathFor(key), source);
      return { slug: key, savedAt: new Date().toISOString() };
    });
    queues.set(key, operation);
    const clear = () => { if (queues.get(key) === operation) queues.delete(key); };
    operation.then(clear, clear);
    return operation;
  }

  return { list, get, save };
}
