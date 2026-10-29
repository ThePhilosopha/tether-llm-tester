# Model Comparison Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax. Intended implementer: Luna 6. Do not start until Shane explicitly approves implementation.

**Goal:** Extend the existing LLM Tester with two-model comparisons that establish whether alternative models are sufficiently reliable for copywriting, layout concepts and technical work.

**Architecture:** Add a Compare tab to the existing vanilla interface and comparison routes to the existing loopback Node server. Reuse provider profiles, authentication boundaries and streaming conventions. Persist versioned cases and comparison records separately from credentials.

**Tech Stack:** Existing JavaScript ES modules, Node built-in APIs, HTML/CSS and node:test. No new runtime dependencies.

**Spec:** The self-contained Specification Snapshot below is authoritative for this plan. Existing debugger context: docs/superpowers/specs/2026-09-11-llm-api-debugger-design.md. The new comparison requirements override that document's exclusion of benchmarking.

## Global Constraints

- Workspace: /Users/Shane/Z-Projects/LLM Tester.
- This is an extension of the same app, server and provider configuration.
- Preserve Chat, Models and Ollama behaviour.
- Keep loopback binding, same-origin mutation checks, session token checks and strict CSP.
- Do not commit, push, install software, modify live credentials or initiate paid benchmarks without explicit authorisation.
- Use disposable state and mock providers for automated checks.
- Preserve unrelated changes, including the existing untracked .claude directory.
- Present implementation diffs for approval under Shane's file-change rule. Plan approval alone does not waive that rule.
- No automatic retries, fallback models, generated-code execution or returned-tool execution.
- Missing metrics remain null/unknown, never zero.
- Never describe a mocked provider test as verified live integration.
- No subagents are required for implementation.
- Delete this plan only after all agreed deliverables and verification are complete. Shane has requested that cleanup. Retain it if work is partial or blocked.

## Specification Snapshot

### Required scope

- Add Compare alongside the current Chat, Models and Ollama tabs.
- Select two models independently, including two from the same provider.
- Support Ollama Cloud, OpenCode Go and OpenRouter.
- Reuse existing provider profiles; distinguish local Ollama from Cloud.
- Provide one shared system prompt, user prompt, temperature, top-P,
  output-token limit, stream setting and timeout.
- Apply the same output instructions and assertions to both sides.
- Dispatch both sides concurrently and render them independently.
- Save cases, immutable run inputs, outputs, failures and assessments.
- Support copywriting, layout-concept and technical test categories.
- Support repeated cases, blind scoring and category reports.
- Allow a premium model as either side; identify baseline explicitly.
- Report usable-result rate, constraint failures, quality, latency,
  usage and cost with transparent evidence limits.

### Deliberate scope boundaries

- Technical answers receive assertions, human review and optional
  user-attached external test evidence.
- Automatic compilation/execution in a sandbox is a separate follow-on.
  Never label unexecuted code as execution-verified.
- Layout means content hierarchy and conceptual flow, not generated
  graphics or browser-rendered design evaluation.
- AI judging, model-specific optimisation mode, autonomous scheduling
  and CLI/CI integration are separate follow-ons.
- These boundaries limit the earlier proposed broad framework to a
  coherent first extension without dropping the three test categories.

### Provider rules

- Refresh official documentation at implementation time before fixing
  provider endpoints or parameter mappings.
- Ollama Cloud currently documents https://ollama.com/v1 and
  https://ollama.com/api/tags.
- OpenRouter uses its models catalogue and Chat Completions interface.
  Set provider.require_parameters=true for strict runs.
- OpenRouter route pinning is explicit; disable fallbacks when pinned.
- Go currently publishes different protocols by model and discovery at
  https://opencode.ai/inference/go/v1/models.
- Support chat-completions, responses, anthropic-messages and
  google-generate-content through explicit protocol selection.
- Do not infer protocol from a model name. Prefer catalogue metadata;
  otherwise require a saved, visible model mapping.
- Go requests identify LLM Tester and use a stable x-opencode-session
  per logical conversation. Never impersonate another client.
- Go's coding-oriented usage guidance needs clarification for general
  copy/layout benchmarks. Mark those Go combinations unavailable until
  current documentation or provider clarification supports that use.
- Do not silently route an unavailable combination elsewhere.
- Sources:
  https://docs.ollama.com/api/openai-compatibility
  https://docs.ollama.com/cloud
  https://opencode.ai/docs/go/
  https://openrouter.ai/docs/guides/routing/provider-selection

### Fairness and defaults

- Shared defaults: temperature 0.7, topP 1, maxOutputTokens 2048,
  stream true, timeoutMs 120000, repetitions 1.
- These are UI defaults, not scientifically optimal settings.
- Strict mode blocks unsupported required controls.
- Unknown support requires explicit exploratory confirmation and marks
  the run parameter-equivalence-unverified.
- Never omit a requested control silently.
- Reject a pair where token-cap semantics cannot be mapped comparably.
- Equal numeric controls do not establish identical sampling behaviour.
- Freeze prompts, constraints, mappings and settings before dispatch.
- Runtime configuration changes affect future runs only.
- Repetitions range 1–20; run one pair at a time, two sides concurrently.
- A batch contains at most 200 pairs. Show request count before starting.
- Browser refresh must not dispatch requests again.

### Evaluation rules

- Categories: copy, layout, code.
- Assertions: json-valid, array-length, word-count, includes, excludes.
- JSON paths are arrays of literal object keys, not executable expressions.
- Word count is trimmed whitespace-separated text; document that rule.
- Rubric scores are integers 0–4: unusable, major rework, substantial
  editing, minor editing, ready for use.
- Copy rubric: clarity 25%, audience/voice 25%, specificity 20%,
  persuasion 20%, distinctiveness 10%.
- Layout rubric: hierarchy 25%, flow 25%, audience fit 20%,
  assumption handling 15%, accessibility 15%.
- Code rubric: diagnosis 40%, solution reasoning 40%, maintainability 20%.
  Track executable correctness separately as unverified/pass/fail with
  evidence provenance; passing prose checks cannot verify execution.
- Acceptable result: complete response, all hard assertions pass,
  human accept=true, and no recorded critical failure.
- Missing human review means pending, not failure or success.
- Show operational success separately from reviewed acceptability.
- Human scores use recorded reasons; blind sides are randomly assigned
  once per pair and remain stable after reload.
- Reports show first-attempt outcomes. Reruns are separate linked runs.
- Replacement verdict is a recorded human judgement with rationale:
  replacement-supported, useful-with-review, not-supported,
  insufficient-evidence.
- Do not automatically certify replacement from a sample count.
- Never pool results across changed cases, settings or routes.

## File Structure

Modify:
- server.mjs: wire comparison routes inside the existing trust boundary;
  serve the explicit new /compare.js asset.
- lib/state.mjs: add Ollama Cloud preset and optional comparison model
  mappings while preserving old profiles and state version 1.
- public/index.html: Compare tab/panel and Cloud provider option.
- public/app.js: initialise Compare and notify it after provider changes.
- public/styles.css: comparison layout using existing design tokens.

Create:
- lib/comparison/contract.mjs: validation and immutable run snapshots.
- lib/comparison/providers.mjs: discovery, protocol mapping, streaming
  normalisation and comparison-only credential handling.
- lib/comparison/store.mjs: atomic case/run persistence and recovery.
- lib/comparison/runner.mjs: pair/batch lifecycle and cancellation.
- lib/comparison/evaluate.mjs: assertions, rubrics and report arithmetic.
- lib/comparison/routes.mjs: comparison HTTP routes.
- public/compare.js: comparison UI, case editor, review and reports.
- test/helpers/comparison-provider.mjs: local mock upstream.
- test/comparison-contract.test.mjs
- test/comparison-providers.test.mjs
- test/comparison-store.test.mjs
- test/comparison-runner.test.mjs
- test/comparison-evaluate.test.mjs
- test/comparison-api.test.mjs
- docs/model-comparison.md: durable usage, limitations and verification.

Do not extract or refactor unrelated debugger code.

## Shared Interfaces

Use JSDoc typedefs in contract.mjs; no TypeScript build.

ModelRef = {providerId, modelId, protocol, endpoint, capabilities,
            capabilitySource, capabilityCheckedAt, route}
Protocol = chat-completions | responses | anthropic-messages |
           google-generate-content
Capability = supported | unsupported | unknown
Settings = {temperature, topP, maxOutputTokens, stream, timeoutMs}
CaseVersion = {id, version, category, title, system, prompt, assertions,
               rubric, holdout}
RunInput = {caseVersions, left, right, baselineSide, settings,
            repetitions, exploratoryConfirmed, pricing}
Side = left | right
AttemptStatus = queued | running | complete | error | timeout |
                cancelled | interrupted
Attempt = {id, pairId, side, caseId, caseVersion, repetition, status,
           request, output, reasoning, toolCalls, raw, rawTruncated,
           finishReason, metrics, usage, error, assertions, assessment}
RunRecord = {schemaVersion:1, id, createdAt, input, status, attempts,
             blindAssignments, verdict}
Event = {runId, pairId, attemptId, side, type, data}
Event.type = snapshot | request | response | raw | delta | terminal

Persist no credential values or unredacted authentication headers.
Use provider IDs to resolve credentials server-side.
Keep tokens and provider-specific usage fields separate.
Store actual route if reported; otherwise actualRoute=null.

## Review Focus

1. Unsupported or unknown controls must never become a silently
   different request. Covered by Tasks 1–2.
2. One failed/hanging side must not block evidence from the other.
   Covered by Task 4.
3. Refresh, crash or repeated submission must not duplicate paid work.
   Covered by Tasks 3–5.
4. Partial output, missing usage and unreviewed results must not become
   apparent successes or zero-cost results. Covered by Tasks 4 and 7.
5. Provider output and saved records must not execute content, expose
   credentials or escape the data directory. Covered by Tasks 3, 5–6.

## Task 1: Validate and freeze comparable requests

**Files:** contract.mjs; comparison-contract.test.mjs.
**Consumes:** Shared Interfaces.
**Produces:**
- validateRunInput(value, modelCatalogue) -> RunInput
- freezeRunInput(value) -> deeply frozen RunInput copy
- validateCaseVersion(value) -> CaseVersion

- [ ] Write tests named shared-settings, unsupported-control,
  unknown-requires-confirmation, independent-snapshot, invalid-bounds.
  Assert both sides reference one settings snapshot; unsupported topP
  throws; unknown requires confirmation; mutating input changes nothing
  in the snapshot; NaN, Infinity, blank prompts, repetitions=0 and
  maxOutputTokens=0 throw.
- [ ] Run node --test test/comparison-contract.test.mjs.
  Confirm failure comes from the missing implementation.
- [ ] Implement the three signatures. Validate temperature 0–2,
  topP >0 and <=1, positive integer token cap, timeout 1000–600000 ms,
  unique case/version identities, and maximum 200 planned pairs.
  Apply tighter documented model limits too.
- [ ] Run the same command; expect all tests pass.
- [ ] Inspect the task diff and request approval before applying it.

## Task 2: Discover models and normalise provider protocols

**Files:** providers.mjs; lib/state.mjs; test helper;
comparison-providers.test.mjs.
**Consumes:** validated ModelRef, Settings and CaseVersion.
**Produces:**
- discoverModels(provider, {fetchImpl, signal}) -> Promise<ModelRef[]>
- buildRequest(provider, model, caseVersion, settings, sessionId)
  -> {url, method, headers, body}
- executeModel({provider, model, caseVersion, settings, sessionId,
  signal, emit, fetchImpl}) -> Promise<normalised result>

- [ ] Create startMockProvider() in the test helper. Return
  {url, requests, release, close}; retain incoming requests and support
  delaying responses until release(). Use ephemeral loopback ports.
- [ ] Write fixtures/tests for all four protocols, streamed and plain.
  Assert identical prompt content and requested sampling values after
  translation; correct authentication/paths; split UTF-8 and SSE frames
  decode correctly; usage-only events survive; malformed terminal
  streams fail; unknown protocol blocks; secrets never enter traces.
- [ ] Run node --test test/comparison-providers.test.mjs; expect red.
- [ ] Implement discovery and the three interfaces with built-in fetch.
  Preserve raw upstream errors. Disable redirects. Respect the existing
  remote-HTTP setting and validate protocol-selected URLs.
  Normalise response text, reasoning, tools, finish reasons and usage
  without inventing missing values. Do not execute tools.
- [ ] Add ollama-cloud preset with empty credentials. Preserve existing
  saved URLs, keys and local Ollama settings. Add optional per-model
  comparison mappings; reject arbitrary executable mapping expressions.
- [ ] Run provider tests plus node --test test/app.test.mjs; expect pass.
- [ ] Review protocol translations against current official docs and
  present the focused diff before applying it.

## Task 3: Persist cases and comparison records

**Files:** store.mjs; comparison-store.test.mjs.
**Consumes:** CaseVersion and RunRecord.
**Produces:** createComparisonStore(root) ->
  {saveCase, listCases, saveRun, getRun, listRuns, recoverInterrupted}.
All methods are async. saveRun serialises writes per run ID.

- [ ] Write atomic-roundtrip, concurrent-writes, private-permissions,
  traversal-rejected, malformed-preserved and interrupted-not-replayed.
  Assert restart preserves inputs/assessments; paths containing ../
  fail; corrupt records remain untouched and are reported; running
  attempts recover as interrupted without any provider calls.
- [ ] Run node --test test/comparison-store.test.mjs; expect red.
- [ ] Implement atomic temp-file/rename writes with directory mode 0700
  and file mode 0600. Default root is comparisons/ beside state.json;
  custom test state uses its own sibling directory.
  Use UUID file names validated independently of user titles.
- [ ] Keep at most 100 run records and 100 MiB total. Do not silently
  delete older records: reject new work with a readable storage-full
  message. Cap stored raw data per attempt at 1 MiB UTF-8 and expose
  truncation. Never truncate and then score an apparently complete answer.
- [ ] Run store tests; expect pass. Review the diff before applying.

## Task 4: Execute pairs and repeated suites

**Files:** runner.mjs; comparison-runner.test.mjs.
**Consumes:** Tasks 1–3.
**Produces:** createComparisonRunner({store, resolveProvider,
  executeModel, clock}) ->
  {start(input, submissionId), get(id), subscribe(id, listener),
   cancel(id, side), close()}.
start returns Promise<{id}> after the initial record is durable.
subscribe returns an unsubscribe function.

- [ ] Write starts-both-before-response using one held mock provider
  and two model IDs. Assert requests.length===2 before release().
- [ ] Write independent-failure, timeout, stop-one, stop-both,
  duplicate-submission, settings-frozen and sequential-pairs tests.
  Assert failing left preserves right; duplicate submissionId starts
  no extra calls; cancelled attempts retain partial evidence;
  subsequent pairs never overlap; timeout terminates the stalled side.
- [ ] Run node --test test/comparison-runner.test.mjs; expect red.
- [ ] Implement independent AbortControllers and concurrent side calls.
  Use performance.now() for durations; record dispatch skew,
  first-response time, first-answer-content time and total time.
  Persist attempt terminal states before emitting terminal events.
- [ ] Keep one active batch; return busy for another. Cancel both also
  cancels queued pairs. Disconnecting a subscriber does not rerun or
  cancel the batch. close() aborts, persists and awaits cleanup.
- [ ] Run runner tests; expect pass. Review the diff before applying.

## Task 5: Expose routes inside the existing app

**Files:** routes.mjs; server.mjs; comparison-api.test.mjs.
**Consumes:** runner, store, contract and provider interfaces.
**Produces:** handleComparisonRoute(req,res,context) -> Promise<boolean>.
Return false for unhandled paths; server retains its existing fallback.

- [ ] Write API tests for preflight, create, events, reconnect,
  cancellation, case save, assessment save and report retrieval.
  Assert unauthorised mutations return 403 and duplicate submissions
  return the existing run ID. Reconnect begins with a current snapshot.
- [ ] Run node --test test/comparison-api.test.mjs; expect red.
- [ ] Add these routes after the existing trusted() check:
  GET /api/comparison/models?providerId=...
  POST /api/comparisons/preflight -> compatibility and request count
  POST /api/comparisons -> {input,submissionId} -> {id}
  GET /api/comparisons -> run summaries
  GET /api/comparisons/:id -> current saved record
  GET /api/comparisons/:id/events -> NDJSON snapshot then live events
  POST /api/comparisons/:id/cancel -> {side:left|right|both}
  GET /api/comparison/cases
  POST /api/comparison/cases -> validated CaseVersion
  POST /api/comparisons/:id/assessment -> attemptId and assessment
  POST /api/comparisons/:id/verdict -> verdict and rationale
  GET /api/comparisons/:id/report
- [ ] Add optional comparisonDir to createApp for test isolation.
  Initialise/recover store on start and close runner on shutdown.
  Keep the current /api/chat contract unchanged.
- [ ] Explicitly allow /compare.js in the static asset list.
  Do not replace that allowlist with arbitrary filesystem serving.
- [ ] Run API tests and test/app.test.mjs; expect pass.
  Review the diff before applying.

## Task 6: Add the side-by-side Compare workspace

**Files:** public/compare.js; index.html; app.js; styles.css.
**Consumes:** Task 5 routes.
**Produces:** initCompare({api, getProviders, notify}) ->
  {providersChanged()} exported from compare.js.

- [ ] Add an API integration assertion that the app serves the Compare
  panel and /compare.js under the existing CSP.
- [ ] Run comparison-api.test.mjs; expect the new assertion to fail.
- [ ] Add Compare as a fourth tab. Initialise its module from app.js;
  notify providersChanged() after provider creation/edit/deletion.
  Reuse the existing provider editor and add its Cloud preset option.
- [ ] Implement independent model selectors, protocol/mapping display,
  shared settings, system/prompt fields, output constraints, category,
  repetitions, premium-baseline side, preflight and Run both.
  Block invalid selections and unavailable provider/category combinations.
- [ ] Show both response panels with independent status, stop control,
  timings, finish reason, usage and expandable request/raw details.
  Decode NDJSON across arbitrary chunk boundaries.
- [ ] Render provider text with textContent, never innerHTML.
  Batch stream rendering with requestAnimationFrame. Retain run ID in
  the URL fragment so reload restores/subscribes without resubmitting.
- [ ] Verify 1280px side-by-side and 390px stacked layouts, keyboard
  access, visible labels, non-colour-only statuses and readable errors.
- [ ] Run API integration tests; expect pass. Browser-check parallel
  streaming, one-side failure and refresh using the mock provider.
  Review the diff before applying.

## Task 7: Add assertions, scoring and reports

**Files:** evaluate.mjs; comparison-evaluate.test.mjs;
routes.mjs; public/compare.js.
**Consumes:** saved runs and completed attempts.
**Produces:**
- evaluateAssertions(text, assertions) -> result[]
- scoreRubric(scores, rubric) -> number|null
- buildReport(runRecords) -> category-grouped report

- [ ] Write tests with these exact expectations:
  array-length at ["variations"] accepts three entries and rejects two;
  word-count accepts 60 and 80, rejects 59 and 81;
  invalid JSON fails json-valid;
  missing human review gives null acceptability;
  one acceptable, one failed, one pending => reviewed acceptance 1/2,
  review coverage 2/3, conservative acceptable/all-attempts 1/3;
  missing usage/cost stays null;
  changing case version/settings/route splits report groups.
- [ ] Run node --test test/comparison-evaluate.test.mjs; expect red.
- [ ] Implement literal-key path traversal without eval, code generation
  or user regex. Store each assertion result and severity.
  Keep critical failure separate from weighted quality.
- [ ] Report operational success, reviewed acceptance, review coverage,
  failures by type, quality median/range, paired wins/ties/losses,
  observed latency distribution and reported token usage.
  Show p95 only for at least 20 observations and always show n.
- [ ] Calculate estimated cost only with explicit timestamped prices
  and complete applicable usage. Label it estimated. Track subscription
  allocation separately; never call subscription use automatically free.
- [ ] Add cost-per-acceptable-result and optional review minutes.
  Verdict remains a human judgement with rationale and evidence count.
  Display “API model comparison, not the full ChatGPT/Claude product”.
- [ ] Run evaluation and API tests; expect pass.
  Review the diff before applying.

## Task 8: Make cases, blind review and evidence reusable

**Files:** public/compare.js; contract.mjs; evaluate.mjs;
comparison-api.test.mjs; comparison-evaluate.test.mjs.
**Consumes:** case storage, assessment routes and reports.
**Produces:** in-app authoring, review, replay and export.

- [ ] Write tests that changing a saved case creates version+1 without
  changing old runs; a saved blind assignment survives restart; HTML
  in evidence remains inert; exports contain no authentication secrets.
- [ ] Run API and evaluation tests; expect the new checks to fail.
- [ ] Add case creation/editing, category filters and holdout labels.
  Seed one editable example per category:
  copy: three distinct variations with word-count and count constraints;
  layout: section order, CTA flow and explicit assumptions;
  code: supplied bug, diagnosis, proposed repair and edge cases.
  Do not seed examples into a user's existing custom cases repeatedly.
- [ ] Add multi-case selection with shared settings and preflight count.
  Default one repetition; offer five as an explicit reliability preset.
  Holdout cases are excluded from tuning selections unless selected
  explicitly; editing them invalidates their prior holdout designation.
- [ ] Add stable blind A/B assignment, hidden model/price/timing labels
  during scoring, rubric fields, accept/reject, critical failures,
  tie/neither choice, reasons and subsequent identity reveal.
- [ ] Add optional external code-test evidence with source, date and
  notes. Label it user-supplied; do not treat attachments as app execution.
- [ ] Add “Run again” that creates a new linked run and requires preflight.
  Add JSON report export with preview and sensitive-content reminder.
  Export redacted request metadata; never silently modify source evidence.
- [ ] Run relevant tests and browser-check save/reload/review/export.
  Review the diff before applying.

## Task 9: Verify the complete extension and document it

**Files:** test/comparison-api.test.mjs; docs/model-comparison.md.
**Consumes:** completed Tasks 1–8.
**Produces:** verified integrated workflow and durable usage instructions.

- [ ] Add a full mocked workflow: save each category case, select two
  models, run repeated pairs, collect independent outcomes, score,
  restart, reload and retrieve the same report.
- [ ] Run npm test. Expect all original and new tests to pass.
  If original tests fail, identify whether the change caused it.
- [ ] Review the final diff for credential exposure, unapproved files,
  protocol mismatches, silent parameter omission and scope expansion.
- [ ] Browser-check Chat, Models and Ollama regressions plus Compare
  keyboard/mobile operation. Record checks actually performed.
- [ ] Write docs/model-comparison.md covering use, comparison limits,
  provider setup, Go restrictions, coding evidence provenance, costs,
  persistence and report interpretation. Do not duplicate this plan.
- [ ] Live provider smoke tests require Shane's authorisation and
  configured access. Report each provider separately as mocked,
  live-verified or unavailable. Never infer live success from fixtures.
- [ ] Present outcome, checks, limitations and any remaining acceptance
  work. Do not claim full completion while required checks are missing.

## Task 10: Remove this temporary plan

**Files:** this plan only.
**Consumes:** successful completion and final verification evidence.
**Produces:** no temporary implementation plan left in the repository.

- [ ] Confirm every agreed task and acceptance check is complete.
  Keep the plan if provider access, required verification or implementation
  remains blocked. List the exact unfinished items instead.
- [ ] Ensure durable usage and verification information exists in
  docs/model-comparison.md and the final handoff.
- [ ] Delete only this plan, as requested by Shane.
- [ ] Verify the plan is absent and inspect git status to ensure no
  unrelated file was removed. Do not commit or push.

## Self-Review Before Saving

- Scope: existing app extension; all original core requirements mapped
  to Tasks 1–8. Automatic execution and AI judging explicitly deferred.
- Interfaces: runner, store, provider and route signatures agree.
- Review focus: each of the five risks has a named test owner.
- Approval: no implementation, live benchmark or Git write authorised
  by creating this plan.
- Handoff: Luna 6 uses native sequential execution after approval.
  Recheck current files before applying any proposed implementation diff.
