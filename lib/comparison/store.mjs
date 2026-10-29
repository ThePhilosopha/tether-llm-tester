import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateCaseVersion } from './contract.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function caseHash(id) {
  return createHash('sha256').update(id).digest('hex');
}

function checkedId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Comparison ID must be a UUID.');
  return id;
}

async function listJson(directory) {
  const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  const items = [];
  for (const name of files) {
    try { items.push(JSON.parse(await readFile(join(directory, name), 'utf8'))); }
    catch (error) { throw new Error(`Could not read comparison record ${name}: ${error.message}`); }
  }
  return items;
}

async function atomicWrite(path, text) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
  await chmod(temp, 0o600);
  try {
    await rename(temp, path);
    await chmod(path, 0o600);
  } catch (error) {
    await import('node:fs/promises').then(fs => fs.rm(temp, { force: true })).catch(() => {});
    throw error;
  }
}

function capRaw(run, maxRawBytes) {
  for (const attempt of run.attempts || []) {
    if (typeof attempt.raw !== 'string') continue;
    const bytes = Buffer.from(attempt.raw);
    if (bytes.length <= maxRawBytes) continue;
    let end = maxRawBytes;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (end > 0) {
      try {
        attempt.raw = decoder.decode(bytes.subarray(0, end));
        break;
      } catch {
        end--;
      }
    }
    if (end === 0) attempt.raw = '';
    attempt.rawTruncated = true;
  }
}

export async function createComparisonStore(root, {
  maxRuns = 100,
  maxBytes = 100 * 1024 * 1024,
  maxRawBytes = 1024 * 1024
} = {}) {
  if (typeof root !== 'string' || !root) throw new Error('Comparison storage root is required.');
  if (![maxRuns, maxBytes, maxRawBytes].every(Number.isSafeInteger) ||
      maxRuns < 1 || maxBytes < 1 || maxRawBytes < 1) {
    throw new Error('Comparison storage limits must be positive integers.');
  }
  const casesDir = join(root, 'cases');
  const runsDir = join(root, 'runs');
  await mkdir(casesDir, { recursive: true, mode: 0o700 });
  await mkdir(runsDir, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(casesDir, 0o700);
  await chmod(runsDir, 0o700);
  const queues = new Map();
  const updates = new Map();
  const caseQueues = new Map();

  async function allBytes() {
    let bytes = 0;
    for (const directory of [casesDir, runsDir]) {
      for (const name of await readdir(directory)) {
        if (name.endsWith('.json')) bytes += (await stat(join(directory, name))).size;
      }
    }
    return bytes;
  }

  async function saveCase(value) {
    const item = validateCaseVersion(value);
    const operation = (caseQueues.get(item.id) || Promise.resolve())
      .catch(() => {}).then(() => saveCaseSerial(item));
    caseQueues.set(item.id, operation);
    const clear = () => {
      if (caseQueues.get(item.id) === operation) caseQueues.delete(item.id);
    };
    operation.then(clear, clear);
    return operation;
  }

  async function saveCaseSerial(item) {
    const prefix = caseHash(item.id);
    const versions = (await readdir(casesDir))
      .filter(name => name.startsWith(`${prefix}.v`) && name.endsWith('.json'));
    let latest = null;
    for (const name of versions) {
      const existing = JSON.parse(await readFile(join(casesDir, name), 'utf8'));
      if (!latest || existing.version > latest.version) latest = existing;
      if (existing.version === item.version) {
        if (JSON.stringify(existing) === JSON.stringify(item)) return existing;
        throw new Error('Case versions are immutable; save edits as a new version.');
      }
    }
    if (latest && item.version !== latest.version + 1) {
      throw new Error(`Case edits must use the next version (${latest.version + 1}).`);
    }
    const path = join(casesDir, `${prefix}.v${item.version}.json`);
    const text = `${JSON.stringify(item, null, 2)}\n`;
    if (await allBytes() + Buffer.byteLength(text) > maxBytes) {
      throw new Error('Comparison storage is full. Remove old records before saving.');
    }
    await atomicWrite(path, text);
    return item;
  }

  async function listCases() {
    const cases = await listJson(casesDir);
    const latest = new Map();
    for (const item of cases) {
      if (!latest.has(item.id) || latest.get(item.id).version < item.version) latest.set(item.id, item);
    }
    return [...latest.values()].sort((a, b) => a.title.localeCompare(b.title));
  }

  async function saveRun(value) {
    const run = structuredClone(value);
    checkedId(run?.id);
    if (run.schemaVersion !== 1 || !Array.isArray(run.attempts)) {
      throw new Error('Comparison record has an unsupported schema.');
    }
    capRaw(run, maxRawBytes);
    const text = `${JSON.stringify(run, null, 2)}\n`;
    const path = join(runsDir, `${run.id}.json`);
    const operation = (queues.get(run.id) || Promise.resolve()).catch(() => {}).then(async () => {
      const names = (await readdir(runsDir)).filter(name => name.endsWith('.json'));
      const previous = names.includes(`${run.id}.json`)
        ? (await stat(path)).size
        : 0;
      if (!previous && names.length >= maxRuns) {
        throw new Error('Comparison run limit reached. Remove old records before starting another run.');
      }
      if (await allBytes() - previous + Buffer.byteLength(text) > maxBytes) {
        throw new Error('Comparison storage is full. Remove old records before saving.');
      }
      await atomicWrite(path, text);
      return run;
    });
    queues.set(run.id, operation);
    operation.then(
      () => { if (queues.get(run.id) === operation) queues.delete(run.id); },
      () => { if (queues.get(run.id) === operation) queues.delete(run.id); }
    );
    return operation;
  }

  async function getRun(id) {
    checkedId(id);
    try { return JSON.parse(await readFile(join(runsDir, `${id}.json`), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`Could not read comparison record ${id}: ${error.message}`);
    }
  }

  function updateRun(id, update) {
    checkedId(id);
    const operation = (updates.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      const record = await getRun(id);
      if (!record) throw new Error('Comparison not found.');
      await update(record);
      return saveRun(record);
    });
    updates.set(id, operation);
    const clear = () => { if (updates.get(id) === operation) updates.delete(id); };
    operation.then(clear, clear);
    return operation;
  }

  async function listRuns() {
    return (await listJson(runsDir)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function recoverInterrupted() {
    let changed = 0;
    for (const run of await listRuns()) {
      let dirty = ['queued', 'running'].includes(run.status);
      for (const attempt of run.attempts || []) {
        if (attempt.status === 'queued' || attempt.status === 'running') {
          attempt.status = 'interrupted';
          dirty = true;
        }
      }
      if (dirty) {
        run.status = 'interrupted';
        await saveRun(run);
        changed++;
      }
    }
    return changed;
  }

  return { saveCase, listCases, saveRun, updateRun, getRun, listRuns, recoverInterrupted };
}
