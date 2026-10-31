# Standalone macOS app bundle plan

Package the LLM Tester as a double-clickable `.app` that runs without `npm start`.
Pake supplies the window; the Node server ships inside the bundle as a Node SEA binary;
a shell launcher starts the server, waits for the port, then execs the Pake binary.

## Spec

`docs/superpowers/specs/2026-09-11-llm-api-debugger-desktop-packaging-design.md` describes the
Pake-only packaging. That design is incomplete: it requires the local service to be running.
This plan supersedes its runtime model while keeping its visual direction and artifact names.

Evidence already gathered (controller, before this plan):
- `postject` must receive `--macho-segment-name NODE_SEA`, else the binary segfaults in
  `node::sea::FindSingleExecutableResource`.
- SEA runs its entry as CommonJS; an ESM server needs a `.cjs` bootstrap that awaits
  `import('file://…/server.mjs')`.
- The injected binary must be re-signed (`codesign --sign -`).
- A SEA binary of this server serves `/`, `/assets/*` and `/api/state` at 200 from a
  staged `client/dist`.
- The shipped DMG bakes `{"url":"http://127.0.0.1:8787"}` into the Tauri binary.

## Global Constraints

- No new runtime dependency in `package.json`. `postject` and the client build are invoked via `npx`/scripts.
- The server keeps binding `127.0.0.1` only. The CSP string, the session-token check and the
  same-origin mutation rule must not change.
- State, comparisons, skills and the MCP audit stay in `~/Library/Application Support/LLM Tester/`,
  shared with `npm start`.
- Local models are never used for testing, verification or demos.
- Signing is ad-hoc (`codesign --sign -`). Developer ID/notarisation is out of scope.
- The webview loads `http://127.0.0.1:8787`, so the packaged app stays same-origin.

## Tasks

### Task 1: Env-driven resources and readiness in server.mjs

Add to `server.mjs`:
- `clientDir` default resolves from `process.env.LLM_TESTER_RESOURCES` when set, at
  `join(resources, 'client', 'dist')`, otherwise the current `join(root, 'client', 'dist')`.
- `start(port)` accepts `0` and env `LLM_TESTER_PORT` when the argument is omitted.
- When the server is started as the main module, print exactly one line `READY <port>` to stdout
  after `listen` resolves, then the existing listening message.

Acceptance:
- `LLM_TESTER_RESOURCES=/tmp/x LLM_TESTER_PORT=0 node server.mjs` binds a random port and prints `READY <port>`.
- `npm test` stays green (115 tests).
- No change to CSP, `trusted()`, or any route.

### Task 2: bin/bootstrap.cjs and the SEA build script

Files:
- `bin/bootstrap.cjs`: resolve resources from `process.env.LLM_TESTER_RESOURCES` falling back to
  `join(__dirname)`, dynamic-import `file://<resources>/server.mjs`, call `createApp({ clientDir })`
  with the default state path, `start(Number(process.env.LLM_TESTER_PORT) || 8787)`.
- `scripts/build-sea.mjs`: write a temporary sea-config JSON with `main: bin/bootstrap.cjs`,
  `output`, and `disableExperimentalSEAWarning: true`; run
  `node --experimental-sea-config`; copy `process.execPath` to `build/server`; `codesign --remove-signature`;
  run `npx --yes postject <out> NODE_SEA_BLOB <blob> --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA`;
  `codesign --sign - <out>`.

Acceptance:
- `node scripts/build-sea.mjs` produces `build/server`.
- Running it with `LLM_TESTER_RESOURCES=. LLM_TESTER_PORT=8799` serves `/` and `/api/state` at 200.
- The script exits non-zero and prints the command output when any step fails.

### Task 3: scripts/build-app.mjs producing the .app and DMG

Sequence:
1. `npm --prefix client run build`.
2. Build the SEA binary via `scripts/build-sea.mjs`.
3. If `build/pake/LLM Tester.app` is absent, run `npx --yes pake-cli@3.17.8 "http://127.0.0.1:8787" --name "LLM Tester" --identifier local.llm-tester --icon assets/llm-api-debugger-icon.icns --width 1280 --height 900 --dark-mode --enable-find --json` and move the produced app into `build/pake/`.
4. Inside a copy of the Pake app: rename `Contents/MacOS/<original executable>` to `window`, write a
   POSIX `sh` launcher at the original executable path that resolves `Contents/Resources`, starts
   `server`, polls `http://127.0.0.1:8787/api/state` until 200 or 20s, then `exec`s `window`; on timeout
   shows an `osascript` alert and exits 1. Copy `build/server`, `client/dist` and a copy of the source
   `server.mjs` + `lib/` into `Contents/Resources/`.
5. `codesign --force --deep --sign -` the app, then `hdiutil create` a compressed DMG into `build/`.

Acceptance:
- `node scripts/build-app.mjs` produces `build/LLM Tester.app` and `build/LLM Tester.dmg`.
- `mdls -name kMDItemCFBundleIdentifier` reports `local.llm-tester`.
- Each step prints what it ran and fails loudly.
