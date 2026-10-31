import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');
const pakeDir = join(build, 'pake');
const appName = 'LLM Tester.app';
const app = join(build, appName);
const dmg = join(build, 'LLM Tester.dmg');

function run(label, command, args, options = {}) {
  console.log(`${label}: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error) fail(label, result.error.message);
  if (result.status !== 0) fail(label, `${result.stdout || ''}${result.stderr || ''}`.trim() || `exit ${result.status}`);
  return result;
}

function fail(label, detail) {
  console.error(`\n${label} failed\n${detail}`);
  process.exit(1);
}

function plist(appPath, key) {
  return run(`Reading ${key}`, '/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(appPath, 'Contents', 'Info.plist')])
    .stdout.trim();
}

function buildClient() {
  run('Building client', 'npm', ['--prefix', 'client', 'run', 'build']);
  console.log('Built client/dist');
}

function buildServer() {
  run('Building server binary', process.execPath, ['scripts/build-sea.mjs']);
  console.log(`Built ${join('build', 'server')}`);
}

// Searches the fresh pake-cli output only: the staged cache and the mount point are
// previous runs' artifacts, and matching them would adopt a stale bundle.
function findProduced(name) {
  const skip = [pakeDir, join(build, 'pake-mnt')].map(path => path + '/');
  const hits = [];
  for (const entry of readdirSync(build, { recursive: true })) {
    const full = join(build, entry);
    if (skip.some(prefix => full.startsWith(prefix))) continue;
    if (entry.split('/').pop() === name) hits.push(full);
  }
  return hits.sort((a, b) => a.split('/').length - b.split('/').length)[0];
}

// pake-cli 3.17.8 defaults to a DMG on macOS even without --install, so the .app
// usually arrives inside that image. Extract it, then keep both under build/pake.
// The copy lands in a temp dir and is renamed into place, so an interrupted run never
// leaves a half-copied app that the reuse check would accept.
function extractApp(dmgPath) {
  const mount = join(build, 'pake-mnt');
  const staging = join(pakeDir, '.tmp');
  mkdirSync(mount, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  run('Mounting Pake DMG', 'hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mount]);
  try {
    cpSync(join(mount, appName), join(staging, appName), { recursive: true, verbatimSymlinks: true });
  } finally {
    run('Unmounting Pake DMG', 'hdiutil', ['detach', mount, '-force']);
    rmSync(mount, { recursive: true, force: true });
  }
  renameSync(join(staging, appName), join(pakeDir, appName));
  rmSync(staging, { recursive: true, force: true });
  console.log(`Extracted ${appName} from ${dmgPath}`);
}

function buildPake() {
  const cached = join(pakeDir, appName);
  if (existsSync(cached)) {
    console.log(`Reusing ${cached}`);
    return;
  }
  mkdirSync(pakeDir, { recursive: true });
  const cachedDmg = join(pakeDir, 'LLM Tester.dmg');
  if (existsSync(cachedDmg)) {
    console.log(`Reusing ${cachedDmg}`);
  } else {
    // Delete last run's outputs so the search below can only find pake-cli's product.
    rmSync(app, { recursive: true, force: true });
    rmSync(dmg, { force: true });
    run('Building Pake window', 'npx', ['--yes', 'pake-cli@3.17.8', 'http://127.0.0.1:8787',
      '--name', 'LLM Tester', '--identifier', 'local.llm-tester',
      '--icon', join(root, 'assets', 'llm-api-debugger-icon.icns'),
      '--width', '1280', '--height', '900', '--dark-mode', '--enable-find', '--json'], { cwd: build });
    for (const name of [appName, 'LLM Tester.dmg']) {
      const produced = findProduced(name);
      if (produced) {
        renameSync(produced, join(pakeDir, name));
        console.log(`Staged ${produced} -> ${join(pakeDir, name)}`);
      }
    }
  }
  if (!existsSync(cached)) {
    if (!existsSync(cachedDmg)) fail('Building Pake window', `pake-cli produced neither ${appName} nor LLM Tester.dmg under ${build}`);
    extractApp(cachedDmg);
  }
}

function writeLauncher(target, executable) {
  // The launcher waits for the window instead of exec'ing it: `exec` would replace this
  // process, so the EXIT trap could never kill the bundled server and quitting the app
  // would orphan a server on port 8787.
  //
  // The readiness probe alone cannot tell whose server answered: if something else owns
  // 8787 the probe passes against that foreign server. `kill -0` on our child is not
  // enough either — a booting child is still alive at probe time and only dies later with
  // EADDRINUSE. So a successful probe must also find our own pid as the port's listener.
  //
  // A `kill -9` of this launcher leaves the bundled server running. Its command path still
  // identifies it as this bundle's server, so start_server() may kill that stale instance
  // and bind again instead of alerting. Identity is matched on command path, never on pid.
  const launcher = `#!/bin/sh
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
export LLM_TESTER_RESOURCES="$RES"
export LLM_TESTER_PORT=8787
SERVER_PID=
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
trap 'kill "$SERVER_PID" 2>/dev/null; exit 1' INT TERM
ALLOW_TAKEOVER=1

# Starts our own server and waits until 8787 answers from it.
# 0: our server owns the port. 1: a foreign process owns it (alerted).
# 2: our server never became ready (alerted). 4: a previous instance of this bundle was
# killed together with the window it still backed; call again to start a fresh pair.
start_server() {
  "$RES/server" &
  SERVER_PID=$!
  i=0
  while [ "$i" -lt 40 ]; do
    if curl -sf --connect-timeout 1 --max-time 2 -o /dev/null http://127.0.0.1:8787/api/state; then
      OWNER=$(/usr/sbin/lsof -nP -t -iTCP:8787 -sTCP:LISTEN 2>/dev/null | head -1)
      [ "$OWNER" = "$SERVER_PID" ] && return 0
      if [ "$ALLOW_TAKEOVER" = 1 ] && [ -n "$OWNER" ] && [ "$(/bin/ps -o comm= -p "$OWNER" 2>/dev/null)" = "$RES/server" ]; then
        kill "$OWNER" 2>/dev/null
        # That server still backs a window from the previous session. Both are stale once
        # the port changes hands, so replace the pair instead of leaving a dead UI behind.
        for pid in $(/usr/bin/pgrep -f "$RES/window"); do kill "$pid" 2>/dev/null; done
        kill "$SERVER_PID" 2>/dev/null
        wait "$SERVER_PID" 2>/dev/null
        n=0
        while [ "$n" -lt 10 ]; do
          [ -z "$(/usr/sbin/lsof -nP -t -iTCP:8787 -sTCP:LISTEN 2>/dev/null)" ] && break
          n=$((n + 1))
          sleep 0.5
        done
        ALLOW_TAKEOVER=0
        return 4
      fi
      # A listener that is already shutting down keeps its socket entry for a moment after
      # its process exits. Only a live process is a real conflict.
      if /bin/ps -p "$OWNER" >/dev/null 2>&1; then
        osascript -e 'display alert "LLM Tester" message "Port 8787 is already in use. Quit the other copy and try again."' >/dev/null 2>&1
        return 1
      fi
    fi
    i=$((i + 1))
    sleep 0.5
  done
  osascript -e 'display alert "LLM Tester" message "The local server did not start on port 8787."' >/dev/null 2>&1
  return 2
}

while :; do
  start_server
  STATUS=$?
  [ "$STATUS" -eq 4 ] || break
done
[ "$STATUS" -eq 0 ] || exit 1
"$RES/window"
exit $?
`;
  writeFileSync(target, launcher);
  chmodSync(target, 0o755);
  console.log(`Wrote launcher ${target} -> ${executable}`);
}

function assembleApp() {
  rmSync(app, { recursive: true, force: true });
  cpSync(join(pakeDir, appName), app, { recursive: true, verbatimSymlinks: true });

  const executable = plist(app, 'CFBundleExecutable');
  const binDir = join(app, 'Contents', 'MacOS');
  const resources = join(app, 'Contents', 'Resources');
  renameSync(join(binDir, executable), join(resources, 'window'));
  writeLauncher(join(binDir, executable), 'window');

  const server = join(resources, 'server');
  cpSync(join(build, 'server'), server);
  chmodSync(server, 0o755);
  cpSync(join(root, 'client', 'dist'), join(resources, 'client', 'dist'), { recursive: true });
  cpSync(join(root, 'server.mjs'), join(resources, 'server.mjs'));
  cpSync(join(root, 'lib'), join(resources, 'lib'), { recursive: true });
  console.log(`Assembled ${app} (executable ${join('Contents', 'MacOS', executable)})`);
}

function signApp() {
  run('Signing app', 'codesign', ['--force', '--deep', '--sign', '-', app]);
  console.log(`Signed ${app}`);
}

function createDmg() {
  rmSync(dmg, { force: true });
  run('Creating DMG', 'hdiutil', ['create', '-volname', 'LLM Tester', '-srcfolder', app,
    '-ov', '-format', 'UDZO', dmg]);
  console.log(`Created ${dmg}`);
}

mkdirSync(build, { recursive: true });
buildClient();
buildServer();
buildPake();
assembleApp();
signApp();
createDmg();
console.log(`\nDone: ${app} and ${dmg}`);
