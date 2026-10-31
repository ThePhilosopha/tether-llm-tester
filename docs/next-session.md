# Tether LLM Tester — next session

## Goal

Complete the Tether LLM Tester and Skill Auditor so every acceptance criterion in the original brief is met and
verifiable: LLM transparency, MCP auditing, and skill auditing with cross-model execution, all exposed
through the React client that now ships in `client/`.

## State at handover

- `1ffc1a0` — React client replaces the vanilla frontend. Server serves `client/dist` with the session
  token injected. Eight workspaces built and reading live endpoints. 78 tests green.
- Compare blind review now works in React: per-response rubric review, pair preference and the
  replacement verdict. The blind rule holds: model identity, timing, usage and provider errors stay
  hidden until every response in the batch carries a review. `client/src/compareReview.js` holds the
  pure rules, `client/src/CompareReview.jsx` the forms, `test/compare-review.test.mjs` the checks.
- Recent runs can be reopened from the Compare screen, so an existing run reaches its review forms.
- `.table-wrap` now scrolls horizontally. Before that the class had no CSS and every table screen
  overflowed at 390px.
- `inspect.mjs --app`: 0 FAIL at 1440, 768 and 390. `lint.mjs --app`: 0 FAIL.
- The project icon is `client/src/assets/icon.svg`, used in the rail switcher and as the favicon.
- Run with `npm start` (builds the client first, then serves on 127.0.0.1:8787). `npm run dev` for the
  Vite dev server, `npm run build:watch` to rebuild on change.
- Provider keys drift. At handover the Ollama Cloud key was rejected with HTTP 401 on chat, and most
  9Router models were retired. Working routes were `openrouter/cohere/north-mini-code:free`,
  `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` and `ollamacloud/kimi-k2.6`, each saved with an
  explicit `chat-completions` mapping through `POST /api/comparison/model-mapping`.

## What is done

| Area | State |
|---|---|
| LLM transparency | Modelfile inspector, parameter registry with wire names, thinking mapping, request provenance. Live. |
| Chat | Streaming, full parameter panel, reasoning and developer disclosures. Live. |
| Models | Discovery table, capability columns, Modelfile panel. Non-Ollama models show the provider catalogue entry and its declared parameters. Live. |
| Ollama | Version, installed and running models, pull, delete, stop, start. Live. |
| Compare | Model pair, shared settings, case selection, preflight, batch table, blind review, pair preference, verdict, evidence, run history. Live. |
| Skills | Import, plain-English steps, flow diagram, editable source, explanation with a chosen remote model, cross-model run with a model picker. Live. |
| Audit | Run list and evidence from `/api/comparisons`. Live. |
| Settings | Provider CRUD, remote HTTP toggle, data locations. Live. |
| MCP | Registry, OAuth (DCR + PKCE), `initialize`/`tools/list`, `tools/call` with measured latency, persisted audit log. Live. |

## What is not done

No acceptance criterion from the original brief is outstanding. Two design decisions stay open by
choice, both noted under the constraints:

1. **Credentials in the OS keychain.** `state.json` at mode 0600 holds provider keys and MCP OAuth
   tokens. Moving them to the keychain is desirable, not required by the brief.
2. **MCP token refresh.** An expired OAuth access token currently needs a fresh authorisation. The
   refresh helper exists in `lib/mcp/oauth.mjs` but nothing calls it.

## Constraints that must hold

- **Never use local models** for testing, verification or demos. Local Ollama is excluded from skill runs
  and model explanations already; keep it that way.
- The app stays local-first and single-user. No accounts, no telemetry, no outbound traffic except to the
  provider you configured.
- The CSP stays self-only. Any new asset must be bundled and served from `/assets`.
- Credentials stay in `state.json` at mode 0600. Moving them to the OS keychain is open, not done.
- The visual system is the dealt `data-terminal` sheet with the product's lime on the selection line and
  the single primary. Do not introduce a second accent, gradients, glows or glass.
- `client/` is a Vite app. Run `npm --prefix client run build` before serving; `npm start` does it.

## Verification to run before calling any of it done

- `npm test` for the Node suite.
- `node ~/.agents/skills/design-taste-frontend/scripts/lint.mjs --app client/src` and
  `inspect.mjs --app http://127.0.0.1:8787/` for the UI gate.
- A live streamed chat, a live comparison with a reviewed pair, and a live skill run against a remote
  model. All three were working at handover; re-verify after any change.
- Read the screenshots the inspector lists at 1440, 768 and 390 before judging the result.

## Reference

- `docs/model-comparison.md` for the Compare design.
- `docs/superpowers/specs/2026-09-11-llm-api-debugger-design.md` for the original app design.
- `.taste-skill/direction.json` for the dealt app style (seed 1786379727).
