# LLM Tester — next session

## Goal

Complete the LLM Tester and Skill Auditor so every acceptance criterion in the original brief is met and
verifiable: LLM transparency, MCP auditing, and skill auditing with cross-model execution, all exposed
through the React client that now ships in `client/`.

## State at handover

- `1ffc1a0` — React client replaces the vanilla frontend. Server serves `client/dist` with the session
  token injected. Eight workspaces built and reading live endpoints. 78 tests green.
- `inspect.mjs --app`: 0 FAIL at 1440, 768 and 390. `lint.mjs --app`: 0 FAIL.
- The project icon is `client/src/assets/icon.svg`, used in the rail switcher and as the favicon.
- Run with `npm start` (builds the client first, then serves on 127.0.0.1:8787). `npm run dev` for the
  Vite dev server, `npm run build:watch` to rebuild on change.

## What is done

| Area | State |
|---|---|
| LLM transparency | Modelfile inspector, parameter registry with wire names, thinking mapping, request provenance. Live. |
| Chat | Streaming, full parameter panel, reasoning and developer disclosures. Live. |
| Models | Discovery table, capability columns, Modelfile panel. Live. |
| Ollama | Version, installed and running models, pull, delete, stop, start. Live. |
| Compare | Model pair, shared settings, case selection, preflight, batch table, evidence, run history. Live. |
| Skills | Import, plain-English steps, flow diagram, editable source, model explanation, cross-model run. Live. |
| Audit | Run list and evidence from `/api/comparisons`. Live. |
| Settings | Provider CRUD, remote HTTP toggle, data locations. Live. |
| MCP | Screen laid out, no backend. Empty state names the three endpoints it expects. |

## What is not done

1. **Compare blind review in React.** The backend endpoints work and the Audit screen reads them, but the
   React screen has no review form, pair preference form or verdict form. Port the three React screens
   that `public/compare.js` used to provide: `POST /api/comparisons/:id/assessment`,
   `POST /api/comparisons/:id/pair-assessment`, `POST /api/comparisons/:id/verdict`. The blind labelling
   rule matters: model identity stays hidden until every response in the batch is reviewed.
2. **MCP backend.** No routes exist. Needed: a server registry, `initialize` plus `tools/list` discovery
   over HTTP, OAuth with dynamic client registration and PKCE, `tools/call` execution, and an audit log
   with measured latency. Context7 needs no key and works today; Canva, Notion and second-brain all
   return a standard `WWW-Authenticate: Bearer resource_metadata=...` challenge. See
   `docs/superpowers/specs/2026-10-31-llm-mcp-skill-auditor-design.md` if it exists, otherwise the
   acceptance criteria in the original brief.
3. **Skill cross-model run uses a fixed model list.** The Skills screen sends every remote model it can
   discover rather than letting the user choose. Add a model picker, and make sure local models stay
   excluded: Shane's standing instruction is that local models are never used for testing or demos.
4. **Model detail panel for non-Ollama providers.** The inspector states the gap honestly but does not
   surface OpenRouter's `supported_parameters` or a Modelfile equivalent.

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
