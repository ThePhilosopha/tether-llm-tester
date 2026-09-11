# LLM API Debugger implementation plan

> **Owner:** implementation session  
> **Source:** `docs/superpowers/specs/2026-09-11-llm-api-debugger-design.md`  
> **Status:** in progress

## Goal

Deliver a local-only, dependency-free Node application that safely configures OpenAI-compatible providers, sends and inspects chat requests (including SSE), discovers models, and manages Ollama through a tightly allowlisted local surface.

## Architecture

- `server.mjs` owns HTTP routing, same-origin/session protections, static delivery, trace cancellation, and provider request proxying.
- `lib/state.mjs` owns defaults, preset definitions, validation, secret-safe client views, and atomic `0600` persistence in the platform application-data directory.
- `lib/sse.mjs` buffers SSE through `TextDecoder`, preserves raw frames up to a cap, and extracts text/reasoning/tool fragments without ever executing tools.
- `lib/ollama.mjs` maps native Ollama HTTP endpoints and a small `execFile`-style CLI allowlist; destructive/system-changing operations require an explicit confirmation field.
- `public/` is a plain accessible developer UI. It talks only to the local server, holds the per-session token in memory, and never persists API keys outside the server state file.
- `test/app.test.mjs` exercises state behavior, host/origin/token boundaries, model discovery, redirect refusal, SSE forwarding, and Ollama model-name validation against localhost fakes.

## Execution

1. Create the minimal project scaffold, state model, and testable server factory.
2. Implement local-only request validation and atomic state persistence before provider calls.
3. Add preset-driven provider CRUD, model discovery, OpenAI-compatible chat forwarding, cancellation, raw traces, and streamed SSE events.
4. Add Ollama native API proxying and allowlisted process/settings controls with confirmation gates.
5. Build the responsive dark developer interface: provider navigation, request composer, response/developer panes, model inventory, and Ollama controls.
6. Run focused automated tests; run the server locally and exercise the rendered application in Chromium.

## Verification

- `npm test` validates protocol and security behavior without contacting external providers.
- A local browser session confirms the application loads, navigates, and exposes the expected request, model, and Ollama workflows.
- No cloud credential or external provider request is needed for verification.

## Deliberate limits

- State-file secrets are local plaintext in a `0700` directory and `0600` file, visibly disclosed in-app; a Keychain integration belongs in a future change.
- Provider support is OpenAI-compatible by contract, with documented per-preset behavior and editable base URL/headers rather than provider-specific SDKs.
