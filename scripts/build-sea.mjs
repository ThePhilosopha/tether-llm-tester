import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');
const out = join(build, 'server');
const blob = join(build, 'sea-prep.blob');
const config = join(build, 'sea-config.json');

function run(label, command, args, { allowFailure = false } = {}) {
  console.log(label);
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error && !allowFailure) fail(label, result.error.message);
  if (result.status !== 0 && !allowFailure) fail(label, `${result.stdout || ''}${result.stderr || ''}`.trim() || `exit ${result.status}`);
  return result;
}

function fail(label, detail) {
  console.error(`\n${label} failed\n${detail}`);
  process.exit(1);
}

mkdirSync(build, { recursive: true });
writeFileSync(config, JSON.stringify({
  main: join(root, 'bin', 'bootstrap.cjs'),
  output: blob,
  disableExperimentalSEAWarning: true
}, null, 2));

run('Generating SEA blob', process.execPath, ['--experimental-sea-config', config]);
console.log('Copying node binary');
copyFileSync(process.execPath, out);
run('Removing signature', 'codesign', ['--remove-signature', out], { allowFailure: true });
run('Injecting SEA blob', 'npx', ['--yes', 'postject', out, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '--macho-segment-name', 'NODE_SEA']);
run('Signing binary', 'codesign', ['--sign', '-', out]);

console.log(`Built ${out}`);
