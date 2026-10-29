# Model comparison

Compare two model APIs against the same saved cases, prompts and generation settings. Each case can be repeated, both sides run concurrently for each pair, and you can review responses blind after the batch ends. The tool records operational results separately from human acceptability and keeps each case version, model route and settings visible in the report.

This compares **model APIs**, not the full ChatGPT or Claude products. It does not execute generated code, run returned tools, render or judge generated graphics, or use an AI judge. A successful API response and passing prose assertions do not establish that code runs correctly.

## Provider setup

Open **Models**, add a provider profile, and enter its endpoint and API key in the provider editor. Credentials are resolved by provider ID on the server and are not included in saved comparison records or exported reports. Do not place secrets in prompts, case text or external evidence.

Comparison discovery currently supports Ollama Cloud, OpenCode Go and OpenRouter. Ollama Cloud is the hosted service at `https://ollama.com/v1`; configure its Cloud profile and credentials separately from local Ollama. Local Ollama remains available through the app's existing **Ollama** tab, but is not selectable in Compare. The comparison implementation does not send local Ollama requests.

- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) and [Ollama Cloud](https://docs.ollama.com/cloud)
- [OpenCode Go](https://opencode.ai/docs/go/) and its [model catalogue](https://opencode.ai/inference/go/v1/models)
- [OpenRouter provider selection](https://openrouter.ai/docs/guides/routing/provider-selection)

These are first-party references recorded by the implementation plan; this guide does not claim that their live contents or service availability were checked during this documentation pass.

For models whose protocol cannot be identified from catalogue metadata, select the model and save a visible protocol mapping in Compare. Supported protocol choices are Chat Completions, Responses, Anthropic Messages and Google Generate Content. A saved manual mapping establishes only the protocol; parameter support remains unknown unless provider catalogue metadata documents it. Unknown parameter support requires checking **Exploratory run** in preflight, and the run is labelled parameter-equivalence-unverified. Strict preflight blocks controls declared unsupported.

For OpenRouter, enter a documented provider route and press **Save route** to pin it. Leave the field blank and save to restore automatic routing. Pinned requests disable fallbacks. Provider-reported serving routes are stored when supplied and split report groups; unreported routes remain unknown.

OpenCode Go is restricted to **code** cases. The app does not enable Go for copy or layout comparisons. Go requests identify LLM Tester and use a stable session ID for each logical pair. Do not use another product's identity or session.

## Create and run a comparison

Choose a left and right model independently. They may use the same provider. Select one or more saved cases, choose which side is the premium baseline if applicable, and use the shared settings. **Use 5 repetitions** selects the reliability preset without starting requests:

| Setting | Default |
| --- | ---: |
| Temperature | 0.7 |
| Top-P | 1 |
| Maximum output tokens | 2048 |
| Streaming | On |
| Timeout | 120 seconds |
| Repetitions | 1 |

These are convenient defaults, not scientifically optimal settings. Both sides receive the same case system instructions, user prompt, assertions and shared settings. Providers use different request protocols and may implement sampling controls differently. Equal numeric values do not guarantee equivalent sampling. Requested controls are never silently omitted: a known-unsupported control blocks the pair, and unknown support requires explicit exploratory confirmation. A preflight summary shows the number of pairs and model requests before starting; the maximum is 20 repetitions and 200 pairs, or 400 model requests.

Cases are versioned. Editing a case creates a new version, so prior runs retain their original prompt and assertions. The seeded examples cover copy, layout concepts and code diagnosis. A holdout case is excluded from the initial default selection; select it explicitly when you want to run it. Editing a holdout clears the holdout designation on its new version. Keep holdouts for evaluation after tuning rather than repeatedly using them to tune prompts.

Press **Preflight**, review its compatibility and request-count summary, then **Run both**. Each pair starts its two requests concurrently; pairs in a repeated or multi-case batch run sequentially. A side can be stopped independently. **Stop both** also cancels queued pairs. A failed or timed-out side retains its evidence while the other side can complete. Refreshing or reopening the run uses its saved ID and does not dispatch requests again. The run history and reload link let you return to saved inputs, outputs and reviews. **Run again** creates a separate linked run and requires a fresh preflight.

## Assertions and human review

The available assertions are valid JSON, array length at a literal object-key path, word count, includes and excludes. Word count trims the response and counts whitespace-separated tokens. Assertion severity (critical, major or minor) is diagnostic in the displayed results; **every failed assertion is treated as required for acceptability**, regardless of severity. A failed assertion cannot be offset by a high rubric score.

Blind A/B labels are assigned once per pair and remain stable after reload. The app withholds model identity, provider errors, request details, timing and price during blind scoring. After the **whole batch reaches a terminal state**, review each response using its category rubric and record accept, reject, a reason, and any critical failure. You can also record a pair preference (A, B, tie or neither) with a reason. Identity and operational details become visible after review.

Rubric scores are integers from 0 to 4: 0 unusable, 1 major rework, 2 substantial editing, 3 minor editing, and 4 ready for use. Weighted dimensions are:

- **Copy:** clarity 25%, audience and voice 25%, specificity 20%, persuasion 20%, distinctiveness 10%.
- **Layout concept:** hierarchy 25%, flow 25%, audience fit 20%, assumption handling 15%, accessibility 15%.
- **Code:** diagnosis 40%, solution reasoning 40%, maintainability 20%.

For code cases, executable correctness is a separate unverified/pass/fail field. Any pass or fail evidence is user-supplied external evidence with source/tool, date and notes. The app does not run tests or validate that evidence. A code response remains execution-unverified unless a human records external evidence.

A report treats a result as acceptable only when the response is complete and non-empty, every assertion passes, a human explicitly accepts it, and no critical failure is recorded. Until that review exists, the result is **pending**, not success or failure. Operational completion rates are therefore separate from reviewed acceptance, review coverage and the conservative acceptable/all-attempts rate. The replacement verdict is always a human decision with rationale and evidence count: replacement-supported, useful-with-review, not-supported or insufficient-evidence. A sample size alone never certifies a replacement.

## Read the report and export

Reports are grouped by case version, category, settings, model pair, route and baseline. Changed cases, settings or routes are not pooled. Review the sample count (`n`) beside quality and latency summaries. Latency p95 is shown only when at least 20 observations are available. Missing usage, price or other measurements remain unknown rather than zero.

Provider-reported token usage is shown separately from cost. API cost is an estimate only when complete applicable usage and explicit timestamped model prices are available; the report identifies price observation times and sources. Subscription allocation is separate from API usage and is not inferred as zero or free. The report notes that Go subscription allocation is not inferred, but this version has no subscription-allocation input or calculation.

The JSON export has a preview and a sensitive-content reminder. It contains redacted request metadata; provider authentication secrets and unredacted authentication headers are excluded. Prompts, model responses, raw provider evidence, assertion text, review reasons and code evidence can contain confidential or otherwise sensitive content. Review the preview and handle the downloaded file accordingly. Raw provider response data is capped at 1 MiB per attempt and marked truncated. Truncated answer text is not scored as a complete answer.

## Storage and verification boundary

Comparison cases and run records are stored separately from credentials in a private local comparison directory. The implementation creates directories with mode `0700` and files with mode `0600` where the operating system supports those permissions. Storage is limited to 100 runs and 100 MiB total. When a limit is reached, new work is rejected with a storage-full message; old records are not automatically deleted. Interrupted in-progress attempts are recovered as interrupted and are not replayed automatically. Export a report before any manual storage cleanup you choose to perform.

Automated provider fixtures exercise requests against mock upstreams; they do not verify live provider accounts, credentials, billing or service behavior. On 21 October 2026, `npm test` passed 65 checks, including concurrent-review durability, serving-route separation, token-limit acceptability, explicit route mapping, all four protocols in streamed and plain fixtures, concurrent submission deduplication, terminal-event durability, live event delivery, active-review protection, per-model reliability, required constraints and the all-category repeated-run/review/restart/report workflow. Original debugger checks also pass. No live provider benchmark or paid request was made.

The browser acceptance pass used disposable local providers and state. It verified independent side completion, refresh/reconnection with no additional model calls, all-category blind reviews, model-specific reports, JSON export preview/download, and a 390px stacked layout without horizontal overflow. Fixture scores establish the workflow only; they say nothing about real model quality.

The next separate extension, if wanted, is OpenUI integration. OpenUI is not implemented by this comparison feature.
