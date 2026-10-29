# Technical Specification: Lightweight OpenAI-Compatible API Debugger

**Status:** Draft for review  
**Scope:** Personal, local-only developer tool  
**Target for this plan:** macOS, with portable application code and macOS-specific Ollama settings integration  
**Implementation:** Not started

## Executive summary

Build this as a local Node.js application with a plain HTML, CSS, and JavaScript interface. A small backend bound only to `127.0.0.1` serves the UI, owns API keys, reads and writes one JSON state file, calls configured providers, and starts allowlisted Ollama CLI commands. This process boundary solves the two problems that rule out a browser-only page: browsers cannot write an arbitrary local JSON file, and they cannot invoke `ollama`. It also avoids provider CORS differences and keeps outbound authentication under one auditable code path.

The first usable path is short: select a provider, enter a key and Base URL, fetch models, choose a model, send a prompt, and inspect the exact serialized request body and raw application-level response. Streaming requests preserve every Server-Sent Events frame in arrival order while a separate parser builds the readable answer. Tool definitions, image input, and reasoning effort remain explicit request controls; the app never executes a returned tool call.

Provider presets supply verified URLs and editable defaults. Capability values use `yes`, `no`, or `unknown` and show their source because the standard `GET /v1/models` response does not define tool, image, or reasoning metadata [2]. OpenRouter and Ollama expose useful extra metadata; other providers need preset knowledge or user overrides.

The main unresolved product issue is API-key storage. A JSON file with mode `0600` meets the literal requirement and a reasonable personal-machine threat model, but it does not encrypt secrets against malware, same-user processes, or backups. The specification keeps this simple and states the boundary rather than claiming stronger protection. A later Keychain mode can store only credential references in JSON.

## Introduction: scope and assumptions

### In scope

- Provider presets for Ollama, 9Router, Poolside, OpenRouter, OpenCode Go, OpenCode Zen, and ClinePass.
- Custom OpenAI-compatible provider profiles.
- `GET /models` discovery and `POST /chat/completions` requests relative to each provider's configured Base URL.
- Non-streaming and streaming chat completions.
- Exact outbound JSON text, response status and headers, raw response text, parsed chunks, timing, and errors.
- Model search, sorting, grouping, capability display, and per-model overrides.
- Tool schema submission, image input, and reasoning controls where supported.
- Local JSON persistence.
- Ollama discovery, model management, loaded-model inspection, and allowlisted CLI/process controls.

### Out of scope for the first implementation

- OpenAI Responses API, Anthropic Messages API, text completions, embeddings, audio, and image generation.
- Automatic tool execution or a plugin runtime.
- User accounts, remote access, collaboration, cloud sync, telemetry, or analytics.
- TCP packet capture, TLS decryption, or an HTTP debugging proxy.
- A packaged desktop installer. The first release runs with `node server.mjs` and opens a local URL.
- Automatic benchmarking or side-by-side concurrent provider comparisons. Users can switch providers and compare captured exchanges manually.

### Definition of “raw”

“Raw request” means the exact UTF-8 JSON string passed to the upstream HTTP client after the app has applied UI controls. “Raw response” means the application-level response body after HTTP transfer/content decoding. For a stream, it means the ordered SSE text frames, including comments, blank-line boundaries, and the non-JSON `[DONE]` sentinel. It does not mean TCP packets, HTTP/2 frames, or encrypted TLS bytes. This boundary fills a wording gap in “raw data packets.”

### Protocol baseline

The baseline is OpenAI Chat Completions because the named compatibility target is `POST /v1/chat/completions`. OpenAI still documents text, tool, and multimodal support on this endpoint [1]. The OpenAI preset maps a token cap to `max_completion_tokens`, which replaces deprecated `max_tokens` for OpenAI [1]. Other profiles define their own token-limit field; Ollama currently maps it to `max_tokens`. OpenAI may favor newer APIs for its own products, but adding Responses API support now would reduce compatibility and expand scope.

## Main Analysis

The following sections translate the researched protocol and provider constraints into the smallest architecture, state model, UI, and control surface that satisfy the requested workflow.

## 2. Architecture decision

### Recommended: local Node.js server plus vanilla web UI

Use the current Node.js LTS and built-in APIs:

- `node:http` for the loopback server.
- Global `fetch`, `ReadableStream`, `TextDecoder`, and `AbortController` for upstream calls and streaming.
- `node:fs/promises` for atomic JSON state writes.
- `node:child_process.spawn` for allowlisted Ollama commands.
- Plain HTML, CSS, and ES modules. No React, Electron, database, ORM, state library, router, Monaco editor, or CSS framework.
- `node:test` only for parser and state-write checks that defend real behavior.

Likely project files:

```text
package.json
server.mjs
public/index.html
public/app.js
public/styles.css
test/core.test.mjs
```

Keep provider presets and normalization functions in `server.mjs` until that file becomes hard to navigate. Do not introduce provider classes. Profiles are data; the request path is shared.

### Component map

```text
Browser at http://127.0.0.1:8787
  ├─ Provider / model / request controls
  ├─ Conversation output
  └─ Developer View
          │ same-origin local API, per-session token
          ▼
Node process bound to 127.0.0.1
  ├─ State store ── ~/Library/Application Support/LLM Tester/state.json
  ├─ Provider proxy ── selected Base URL only
  ├─ Stream recorder / parser
  └─ Ollama controller
       ├─ HTTP ── http://127.0.0.1:11434
       └─ argv spawn ── ollama / launchctl allowlists
```

### Request flow

1. The UI loads sanitized state. The server omits stored API-key values and returns `hasApiKey: true|false`.
2. A key entered in the browser travels once over loopback to the local server. The UI replaces it with a masked state after save.
3. The server resolves the active profile, validates the final URL, applies headers, serializes the final request once, and records that exact string.
4. The server sends the request with automatic redirects disabled. It never forwards credentials to a redirect target.
5. The server returns an incremental NDJSON event stream to the UI. Events carry request metadata, upstream response metadata, raw text, parsed chunks, completion, or error.
6. The UI appends raw text without rewriting it and separately updates the readable answer.

### Alternatives considered

| Approach | Benefits | Costs | Decision |
|---|---|---|---|
| Local Node.js + vanilla UI | Small source tree, fast startup, built-in streaming and process APIs, easy custom endpoints | Runs in a browser tab; plaintext file security unless Keychain support is added | **Use this** |
| Tauri 2 + web UI | Small packaged desktop binary, stronger native boundary, straightforward future Keychain integration | Rust toolchain, WebView packaging, plugins, platform build work | Revisit only when a desktop installer or Keychain storage becomes necessary |
| Electron | Mature desktop APIs and packaging | Heavy runtime and startup cost for a five-screen personal tool | Reject |
| Browser-only static page | Almost no backend | Cannot meet local JSON or Ollama CLI requirements; provider CORS varies; keys remain in browser storage | Reject |

## 3. Local state file

### Location and write rules

Use:

```text
~/Library/Application Support/LLM Tester/state.json
```

Create the directory with mode `0700` and the file with mode `0600`. Write a temporary file in the same directory, flush it, then rename it over the previous file. Keep one `.bak` copy only after a successful parse of the existing file. Never place state beneath `public/`, expose a file-serving route for it, print it to logs, or include it in an error response.

A process crash during save must leave either the previous valid file or the new valid file. On malformed JSON, keep the file untouched, show its path and parse error, and offer a user-triggered reset. Do not silently discard it.

### Proposed schema

```json
{
  "schemaVersion": 1,
  "activeProviderId": "openrouter",
  "providers": [
    {
      "id": "openrouter",
      "kind": "preset",
      "name": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "<secret stored literally in v1>",
      "auth": {
        "type": "bearer",
        "header": "Authorization",
        "prefix": "Bearer "
      },
      "paths": {
        "models": "/models",
        "chatCompletions": "/chat/completions"
      },
      "requestMapping": {
        "tokenLimit": "max_completion_tokens"
      },
      "headers": {},
      "modelOverrides": {
        "example/model": {
          "tools": "yes",
          "images": "unknown",
          "reasoning": {
            "support": "unknown",
            "parameter": null,
            "values": []
          }
        }
      },
      "lastCheck": {
        "state": "untested",
        "checkedAt": null,
        "httpStatus": null,
        "message": "Not tested"
      }
    }
  ],
  "modelCache": {
    "openrouter": {
      "fetchedAt": null,
      "raw": null,
      "models": []
    }
  },
  "request": {
    "model": "",
    "messages": [
      { "role": "user", "content": "" }
    ],
    "stream": true,
    "includeUsage": true,
    "temperature": null,
    "tokenLimit": null,
    "reasoningEffort": "off",
    "toolsEnabled": false,
    "toolsJson": "[]"
  },
  "ui": {
    "developerViewOpen": true,
    "developerTab": "response",
    "modelSort": "name-asc",
    "modelGroup": "provider",
    "modelSearch": "",
    "capabilityFilters": []
  },
  "ollama": {
    "apiBaseUrl": "http://127.0.0.1:11434",
    "binaryPath": "ollama",
    "managedProcess": false,
    "environment": {
      "OLLAMA_HOST": "127.0.0.1:11434",
      "OLLAMA_KEEP_ALIVE": "5m"
    }
  },
  "security": {
    "allowRemoteHttp": false
  }
}
```

### Schema rules

- `schemaVersion` is mandatory. Reject newer versions with a readable error; migrate older versions in one function when a version 2 exists.
- Provider IDs are stable lowercase slugs. Presets remain editable, and “Restore defaults” changes URL/path/header defaults without deleting the key.
- `baseUrl` identifies the OpenAI API root. The app appends the configured paths. It must not guess whether `/v1` belongs in a user URL.
- `auth.type` supports `none`, `bearer`, and `header`. A custom header profile covers providers that do not use Bearer authentication.
- Capability values are tri-state: `yes`, `no`, or `unknown`. Omission means `unknown`, never `no`.
- Do not persist raw request/response history in version 1. The current request draft persists; completed exchanges live in memory and disappear when the app closes. This limits accidental secret and prompt retention.

### Security assessment

Mode `0600` prevents other ordinary local users from reading the file. Binding the server to `127.0.0.1`, checking `Host` and `Origin`, requiring a random per-process token on mutation routes, and serving a restrictive Content Security Policy protect the local HTTP boundary. Localhost services still need these checks because DNS rebinding and permissive CORS have enabled attacks on local developer tools [22].

Plaintext JSON does not protect keys from malware running as the same user, privileged users, disk backups, or anyone with the unlocked account. Apple Keychain provides encrypted storage for generic passwords [21]. If that threat matters, add a storage mode that replaces `apiKey` with `credentialRef` and stores the secret in Keychain. Do not build custom encryption or place an encryption key next to ciphertext in the same JSON file.

## 4. Provider presets

Presets seed editable data. They do not bypass live validation.

| Provider | Base URL | Authentication | Models route | Capability source | Confidence / limitation |
|---|---|---|---|---|---|
| Ollama | `http://127.0.0.1:11434/v1` | None; SDKs may require a dummy value | `/models` | Native `/api/show` plus override | Verified [8] |
| 9Router | `http://127.0.0.1:20128/v1` | Bearer, optional in default local setup | `/models` | Unknown unless router metadata or override exists | README-verified; key enforcement is configurable [11] |
| Poolside | `https://inference.poolside.ai/v1` | Bearer | `/models` | Preset plus provider response | Platform URL verified; self-managed deployments use an account URL [12][13] |
| OpenRouter | `https://openrouter.ai/api/v1` | Bearer; optional attribution headers | `/models` | Explicit `supported_parameters` and modality fields when present | Verified catalog; normalize only returned fields [14][15] |
| OpenCode Zen | `https://opencode.ai/zen/v1` | Bearer is inferred and remains editable | `/models` | Provider metadata plus override | The service splits models across Chat Completions, Responses, and Messages protocols [16] |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | Bearer is inferred and remains editable | `/models` | Provider metadata plus override | Same protocol split; some models cannot use this app's first-version chat route [17] |
| ClinePass | `https://api.cline.bot/api/v1` | Bearer | `/models` | Returned catalog if available, otherwise preset/override | Chat route is documented; confirm `/models` with a live subscribed account [18][19][20] |

Poolside documents text-only models, tool calling, and provider-specific thinking controls, but its standard model list does not expose all of those flags [12][13]. OpenRouter's model catalog supports filters and fields for supported parameters and input modalities [15]. Ollama's OpenAI model list is sparse, while native `POST /api/show` returns a capabilities array [7][8]. The app should preserve each raw model record before normalization.

### Provider gaps filled by this specification

- **OpenCode protocol split:** Version 1 marks non-Chat-Completions models as incompatible instead of sending a request that is expected to fail. A future protocol adapter may add Responses and Messages.
- **ClinePass model discovery:** Keep `/models` editable and show a clear “model listing unsupported or account-gated” state if it returns 404. Manual model entry remains available.
- **9Router authentication:** The preset includes an optional Bearer field because key enforcement is configurable. The app does not probe without the saved key or claim that authentication is disabled.
- **Provider drift:** Every URL, path, and header remains editable. Presets are conveniences, not immutable code branches.

## 5. Model fetching, normalization, sorting, and categories

### Upstream call

For a profile with Base URL `B` and model path `P`:

```http
GET {B}{P}
Accept: application/json
Authorization: Bearer <key>   # only when configured
```

The OpenAI shape is `{ "object": "list", "data": [...] }`, with standard model records centered on `id`, `created`, and `owned_by` [2]. The fetcher accepts that shape and Ollama-native `{ "models": [...] }` only for the Ollama control screen. Any other shape appears in Developer View and produces “unsupported model response shape,” not an empty list.

Disable automatic redirects. Require HTTPS for non-loopback hosts. Permit HTTP only for loopback addresses unless `allowRemoteHttp` is explicitly enabled. Preserve the raw response, status, and headers for debugging.

### Normalized model record

```json
{
  "id": "vendor/model-name",
  "name": "vendor/model-name",
  "providerId": "openrouter",
  "owner": "vendor",
  "created": 1750000000,
  "contextLength": null,
  "inputModalities": ["text"],
  "tools": "unknown",
  "images": "no",
  "reasoning": {
    "support": "unknown",
    "parameter": null,
    "values": []
  },
  "protocol": "chat-completions",
  "source": {
    "tools": "live-metadata",
    "images": "preset",
    "reasoning": "unknown"
  },
  "rawIndex": 4
}
```

Capability precedence is:

1. User model override.
2. Explicit live provider metadata.
3. Documented provider/model preset.
4. `unknown`.

Do not infer tool, image, or reasoning support from a model name. Family grouping may use the portion before `/`, `:`, or the first hyphen as a display convenience, but the UI labels it “inferred.”

### Model UI behavior

- Search by model ID or owner.
- Sort by name, owner/provider, creation time, context length, or fetched order. Null values sort last.
- Group by provider, owner, inferred family, or capability.
- Filter by Tools, Images, Reasoning, and Chat Completions compatibility.
- Show `Yes`, `No`, or `Unknown` with both icon and text; color alone never carries status.
- Let the user enter a model ID manually even when model fetch fails.
- Cache the last successful raw and normalized list with `fetchedAt`. A failed refresh keeps the old list visibly marked stale.

For Ollama, load `/api/tags` first and call `/api/show` only when the user opens or selects a model. This avoids an N+1 request burst while still exposing local capabilities.

## 6. Request builder and capability controls

### Core request

The form builds this minimum body:

```json
{
  "model": "selected-model",
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "stream": true
}
```

Only include optional parameters when the user sets them. Never inject a default temperature, token limit, tool choice, or reasoning value because provider defaults differ.

### Tool calling

The Tools toggle has three states at the model level:

- **Supported:** Enable the control.
- **Unsupported:** Disable it and show the capability source.
- **Unknown:** Allow opt-in with a warning.

When enabled, show a JSON editor for an OpenAI `tools` array and a `tool_choice` selector. Validate JSON locally before send. Remove both fields when Tools is off. Ollama supports `tools` but does not document `tool_choice`; hide `tool_choice` for that preset [8]. Returned tool calls appear as data. The app concatenates streamed `function.arguments` fragments by choice index and tool-call index but never invokes the function.

### Images / multimodal

Use an Attach Image button. Read the file in the browser and create an OpenAI content part with a base64 data URL. Show filename, MIME type, and encoded size before send. Do not upload the file anywhere except the selected Base URL. Ollama's compatibility layer accepts base64 image data but not remote image URLs [8]. Poolside's current documented models are text-only [12]. Unknown capability allows a user-forced attempt because this is a debugger.

### Reasoning effort

The UI shows Off plus only the values mapped for the selected model/profile. The normalized capability specifies the outbound parameter:

| Mapping | UI behavior | Payload example |
|---|---|---|
| `reasoning_effort` | Off removes field; allowed levels insert a string | `"reasoning_effort": "high"` |
| Profile-defined path | Insert a nested or custom value only after provider documentation or live metadata confirms the mapping | No default mapping |
| `chat_template_kwargs.enable_thinking` | Poolside exposes Provider default / Off | `"chat_template_kwargs": { "enable_thinking": false }` |
| Unknown | Disable normal control; Expert JSON may set a field | No automatic field |

OpenAI documents `reasoning_effort` for reasoning models [5]. Ollama documents `none`, `low`, `medium`, `high`, and `max` on its compatibility route [8]. Do not display a universal list and assume every provider accepts it.

### Expert JSON

An optional Expert tab starts with the request generated by the form. After the user edits that JSON, Send uses it as the source of truth. “Reset from form” discards expert edits and regenerates the object; the app does not maintain two-way synchronization. This escape hatch covers provider extensions without creating a settings control for every possible field.

## 7. Developer View and streaming

### Layout and data

Developer View contains:

1. **Summary:** trace ID, provider, final URL, method, start/end time, duration, HTTP status, content type, and completion state.
2. **Request:** exact raw JSON string, pretty JSON, and request headers. Mask `Authorization` by default with a deliberate Reveal control.
3. **Response:** raw body/event frames, pretty JSON when parseable, parsed stream chunks, and response headers.
4. **Errors:** transport error, HTTP error body, JSON/SSE parse warnings, cancellation reason, and stack-free user message.

Use `<pre>` and `<textarea>` with copy buttons. Do not add a code-editor dependency.

### Internal streaming protocol

`POST /api/chat` returns `application/x-ndjson`. Each line is one local event:

```json
{"type":"request","traceId":"...","url":"...","method":"POST","headers":{},"rawBody":"{...}"}
{"type":"response","status":200,"headers":{"content-type":"text/event-stream"}}
{"type":"raw","text":"data: {\"id\":\"...\"}\n\n"}
{"type":"chunk","json":{"id":"...","choices":[]}}
{"type":"done","sentinelSeen":true,"usage":null,"durationMs":1234}
```

The `raw` event contains the upstream text exactly as decoded; JSON escaping belongs only to the local NDJSON envelope. The UI unescapes it before display.

### Streaming parser requirements

- Feed `TextDecoder` with `{stream: true}` so split UTF-8 code points survive network chunks.
- Buffer partial text across reads. Normalize parsing for `\r\n` and `\n`, while preserving the original raw text separately.
- Split SSE events on blank lines, join multiple `data:` lines with newline, ignore comments for JSON parsing, and retain them in the raw view.
- Treat `data: [DONE]` as a sentinel, not JSON. OpenAI's official Node client performs this check before parsing [4].
- Append `delta.content` to readable output. Accumulate `delta.reasoning` or Ollama-native `message.thinking`, when present, in a separate collapsible Reasoning trace.
- Accumulate tool-call name and argument fragments by choice and tool index.
- When “Include usage” is enabled for a streaming request, send `stream_options.include_usage: true` and capture usage when present. OpenAI may send it only in the final chunk, and an interrupted stream may omit it [3].
- Support cancellation with one `AbortController`; mark the trace cancelled without rewriting captured data.
- If the upstream declares JSON rather than SSE despite `stream: true`, capture and parse it as one non-streaming response.
- Keep capture in memory and cap Developer View raw data at 10 MiB per exchange. Continue draining the provider stream after the cap, render the answer, and show “raw capture truncated.”

## 8. Validation and status indicators

### Connection test

“Test connection” performs the configured `GET /models` call. Interpret results without collapsing every failure into “bad key”:

| Result | Status | Meaning |
|---|---|---|
| 2xx with supported model shape | Green: Connected | Endpoint, auth, and model route work |
| 2xx with unknown shape | Amber: Reachable, incompatible model response | Key may work; parser needs configuration |
| 401 or 403 | Red: Authentication rejected | Key or account permissions failed |
| 404 | Amber: Route not found | Base URL or models path is wrong/unsupported; key status is unknown |
| 429 | Amber: Authenticated or reachable, rate limited | Do not label the key invalid |
| 5xx | Red: Provider error | Provider received the request but failed |
| DNS/TLS/connect timeout | Red: Unreachable | Network, certificate, or Base URL failure |
| Cancelled | Gray: Cancelled | No functional conclusion |

Every icon has text, a timestamp, and the last HTTP status/error. A stale status remains visible but muted after the URL, key, auth, or path changes.

A provider that lacks model listing can only be fully validated by sending a chat request. The UI should not do that automatically because it may cost money. The user can press Send with a manually entered model.

## 9. Ollama integration

### Correct local endpoints

Ollama binds to `127.0.0.1:11434` by default [6]. Use its OpenAI-compatible root `http://127.0.0.1:11434/v1` for chat and model compatibility [8]. Use the native root `http://127.0.0.1:11434/api` for management:

| Method | Endpoint | UI use |
|---|---|---|
| `GET` | `/api/version` | Service health and installed version |
| `GET` | `/api/tags` | Installed model list and size/details |
| `POST` | `/api/show` with `{model, verbose?}` | Selected model metadata and capabilities |
| `POST` | `/api/pull` with `{model, stream:true}` | Pull model; display streamed NDJSON progress |
| `DELETE` | `/api/delete` with `{model}` | Delete model after explicit confirmation |
| `GET` | `/api/ps` | Models loaded into memory, VRAM, expiry |

These routes are documented in Ollama's API reference [7]. Model pull uses NDJSON, not SSE, so it needs a separate line parser.

### CLI allowlist

Expose buttons, not a free-form shell:

```text
ollama --version
ollama serve
ollama ls
ollama show <validated-model>
ollama pull <validated-model>
ollama stop <validated-model>
ollama rm <validated-model>
ollama ps
```

Spawn the executable with an argument array and `shell: false`. Validate model names and pass them as one argument. Stream stdout and stderr separately. Resolve the configured binary once and show the resolved path. Never accept arbitrary command text, flags, redirections, pipes, environment names, or executable paths from a browser request without matching the saved allowlist.

Prefer native HTTP routes for list/show/pull/delete/ps because they provide structured output. Before any diagnostic CLI command, probe `/api/version`; if the service is down, do not run commands such as `ollama ls` that may auto-start it with settings outside this app. Keep CLI actions for explicit diagnostics, `serve`, and the user's requirement to exercise Ollama CLI behavior.

### Settings boundary

Ollama does not provide a generic REST or CLI “set settings” operation. Server settings are environment variables read at startup. On macOS, the Ollama docs direct users to `launchctl setenv OLLAMA_HOST ...` and then restart the Ollama application [9]. This is the main requirement gap.

Version 1 supports two modes:

1. **Managed process:** The user closes the Ollama desktop service, enables “Manage Ollama process,” edits an allowlisted subset (`OLLAMA_MODELS`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_CONTEXT_LENGTH`, `OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_MAX_QUEUE`, `OLLAMA_NO_CLOUD`, `OLLAMA_ORIGINS`), and starts `ollama serve`. Version 1 fixes `OLLAMA_HOST` to `127.0.0.1:11434`; it cannot expose Ollama to the LAN. The backend passes those values in the child process environment. Changes apply on Restart Managed Ollama.
2. **Existing macOS app:** The UI shows current desired values and an “Apply with launchctl” action. The backend invokes only `launchctl setenv <allowlisted-name> <validated-value>`. It then shows “Restart Ollama to apply.” It does not automate quitting the desktop app.

Do not claim an environment change took effect until a restart and health check succeed. Windows service and Linux systemd behavior remain outside this macOS plan.

### Local backend routes for Ollama UI

| Method | Local route | Action |
|---|---|---|
| `GET` | `/api/ollama/status` | Probe `/api/version`; report managed child state |
| `GET` | `/api/ollama/models` | Proxy `/api/tags` |
| `POST` | `/api/ollama/models/pull` | Proxy and stream `/api/pull` NDJSON |
| `DELETE` | `/api/ollama/models` | Confirmed proxy to `/api/delete` |
| `GET` | `/api/ollama/running` | Proxy `/api/ps` |
| `POST` | `/api/ollama/models/stop` | Run allowlisted `ollama stop <model>` |
| `POST` | `/api/ollama/process/start` | Spawn managed `ollama serve` |
| `PUT` | `/api/ollama/settings` | Validate and save allowlisted env values |
| `POST` | `/api/ollama/settings/apply-macos` | Run allowlisted `launchctl setenv`; require UI confirmation |

## 10. UI layout map

Use one desktop-first page that remains usable at tablet width.

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ LLM API Debugger      Provider [OpenRouter ▼]   ● Connected   [Settings]│
├───────────────────┬──────────────────────────────────────────────────────┤
│ PROVIDERS         │ REQUEST                                              │
│ ● Ollama          │ Model [search/select..........................] [↻]  │
│ ○ 9Router         │ System [.........................................]  │
│ ○ Poolside        │ User   [.........................................]  │
│ ○ OpenRouter      │ [Attach image]  Tools [off]  Reasoning [off ▼]      │
│ ○ OpenCode Go     │ Temperature [ ]  Token limit [ ]                      │
│ ○ OpenCode Zen    │ [Send] [Stop]  Stream [✓]  Include usage [✓]         │
│ ○ ClinePass       ├──────────────────────────────────────────────────────┤
│ + Custom          │ RESPONSE                                             │
│                   │ readable assistant text / tool-call cards            │
│ [Edit profile]    │                                                      │
│ Base URL [...]    ├──────────────────────────────────────────────────────┤
│ API Key [••••]    │ DEVELOPER VIEW [Summary] [Request] [Response] [Raw] │
│ [Test connection] │ status, headers, exact JSON, SSE frames, errors      │
├───────────────────┴──────────────────────────────────────────────────────┤
│ Tabs: Chat | Models | Ollama                                             │
└──────────────────────────────────────────────────────────────────────────┘
```

### Screen behavior

- **Chat:** Main workflow above. Keep provider fields collapsible after successful setup.
- **Models:** Search/filter/sort table. Selecting a row returns to Chat. A details drawer shows normalized fields, source badges, raw provider JSON, and manual capability overrides.
- **Ollama:** Service status, installed models, pull input/progress, loaded models, stop/delete actions, managed-process controls, and settings/restart notice.
- **Profile editor:** Name, Base URL, key, auth type/header/prefix, paths, and extra headers. Custom provider creation duplicates only the schema, never another provider's key.

Status uses icon, text, and color. All controls have labels, keyboard focus styles, and readable error text. The page ships no remote scripts, fonts, images, analytics, or CDN assets. A CSP should allow only same-origin scripts/styles/connections and `data:` images needed for local previews.

## 11. Local application API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/state` | Return sanitized state; omit key values |
| `PUT` | `/api/state` | Validate and atomically save state changes |
| `POST` | `/api/providers` | Add a custom profile |
| `DELETE` | `/api/providers/:id` | Delete a custom profile after confirmation |
| `POST` | `/api/providers/:id/test` | Execute model-list connection test |
| `GET` | `/api/providers/:id/models` | Fetch, capture, normalize, and cache models |
| `POST` | `/api/chat` | Send chat request and return NDJSON lifecycle events |
| `POST` | `/api/chat/:traceId/cancel` | Abort the active upstream request |
| Ollama routes | See section 9 | Local model/process/settings controls |

The server listens at and opens only `http://127.0.0.1:8787`. It accepts Host `127.0.0.1:8787` and Origin `http://127.0.0.1:8787`; it rejects `localhost` aliases. The startup server injects a random token into a meta element in the root HTML, and every mutating route requires that value in `X-Session-Token`. Browser mutation requests without Origin are rejected; read-only GET/HEAD requests without Origin still require the exact Host. The server limits JSON body size and never enables wildcard CORS. Provider calls set `redirect: "manual"`. Remote Base URLs require HTTPS; loopback HTTP remains allowed.

## 12. Error handling

- Return one stable local error shape: `{code, message, details?, traceId?}`. Keep provider bodies in Developer View without replacing them with generic text.
- Distinguish URL validation, DNS, TLS, timeout, cancellation, HTTP, JSON parse, SSE parse, state parse, file write, command spawn, and command exit errors.
- Timeouts are user-configurable per profile only after a real need appears. Start with a 30-second connect/first-response timeout and no total timeout while tokens arrive. Model pulls have no total timeout.
- Never retry chat requests automatically because retries may charge twice or duplicate side effects. A user may press Send again.
- A malformed stream chunk creates a parse warning and remains in Raw. Continue unless framing is no longer recoverable.
- Never erase the visible response when a later stream error occurs.

## 13. Implementation roadmap

Each milestone leaves one working vertical path. Do not start implementation until this specification is approved.

### Milestone 1: Local shell and safe state

**Work**
- Create the five-file Node/vanilla skeleton.
- Bind to `127.0.0.1:8787`, serve static assets, add CSP, exact Host/Origin checks, and per-session mutation token.
- Implement schema validation, sanitized reads, atomic writes, modes `0700`/`0600`, and preset seeding.

**Acceptance**
- A provider key saves to the required file but never appears in `GET /api/state`, logs, or static assets.
- Killing the process during a simulated save leaves a parseable old or new state file.
- Requests with a foreign Origin or Host cannot read or mutate state.

### Milestone 2: First end-to-end provider request

**Work**
- Add OpenRouter and Ollama presets first.
- Implement connection test, manual model ID, non-streaming chat, status semantics, and Developer View request/response capture.
- Capture the final serialized body at the outbound boundary.

**Acceptance**
- The user can enter a key, send a prompt, and compare exact outbound JSON with the provider response.
- A 401, 404, 429, 5xx, and transport failure show distinct states and preserve raw error bodies.
- A redirect never receives the Authorization header.

### Milestone 3: Provider profiles and model catalog

**Work**
- Add remaining presets and custom-provider CRUD.
- Implement OpenAI model normalization, cached/stale behavior, sorting, grouping, filters, manual model entry, and capability overrides.
- Add OpenRouter live metadata and lazy Ollama `/api/show` enrichment.

**Acceptance**
- All named presets load with the URLs and caveats in section 4.
- Unknown model response shapes remain visible and do not masquerade as an empty list.
- Manual override beats live metadata, live metadata beats preset, and omission remains Unknown.

### Milestone 4: Streaming lifecycle

**Work**
- Implement upstream SSE recording/parsing and local NDJSON events.
- Add cancellation, content rendering, usage capture, parse warnings, raw cap, and streamed tool-call argument assembly.

**Acceptance**
- A stream split at every possible byte boundary still reconstructs UTF-8, SSE frames, content, and tool arguments.
- `[DONE]` appears in Raw and never reaches `JSON.parse`.
- Cancellation leaves received raw data and readable text visible.

### Milestone 5: Capability controls

**Work**
- Add validated tools JSON and provider-aware `tool_choice`.
- Add base64 image parts with size/type preview.
- Add reasoning mapping and Expert JSON source-of-truth mode.

**Acceptance**
- Turning a feature off removes its request fields.
- Each reasoning selection produces exactly the documented provider field, or the UI labels the mapping Unknown.
- An attached image is sent only to the active Base URL.
- Tool calls display but never execute.

### Milestone 6: Ollama control screen

**Work**
- Add native version/tags/show/pull/delete/ps routes and streamed pull progress.
- Add CLI allowlist, managed `ollama serve`, stop/restart, saved env, and macOS `launchctl setenv` action.
- Require point-of-action confirmation for delete, process restart, and launchctl changes.

**Acceptance**
- The screen confirms service version and installed/running models against port 11434.
- Pull progress streams without freezing the UI; delete and stop target only the selected model.
- Shell metacharacters remain one rejected model argument and cannot become a command.
- Settings show “pending restart” until restart plus `/api/version` health succeeds.

### Milestone 7: Final hardening and release check

**Work**
- Exercise every preset with available credentials; record account-gated failures as preset notes.
- Verify state recovery, request-size limits, no third-party assets, credential redaction, keyboard use, and screen-reader status text.
- Add a short run command and state-file/security warning to the user-facing help panel.

**Acceptance**
- The success path works from a clean state: save profile, test, fetch models, select model, send streamed prompt, inspect exact request/raw response, restart, and reload state.
- Network inspection shows outbound traffic only to the selected Base URL, except user-triggered Ollama loopback calls.
- No implementation dependency or feature remains that does not support an acceptance criterion in this document.

## 14. Verification plan

### Automated checks worth keeping

Use `node:test` for only the logic where a plausible regression is easy:

1. SSE parser with CRLF/LF, split UTF-8, multi-line data, malformed JSON, `[DONE]`, usage, and fragmented tool arguments.
2. State atomic-write/recovery and sanitized read behavior.
3. URL/header security: remote HTTP rejection, loopback allowance, redirect rejection, and auth not returned to the browser.
4. Capability precedence and tri-state normalization.
5. Ollama command allowlist and argument validation.

### Manual protocol checks

- OpenAI-compatible provider: `GET /models`, non-stream chat, stream chat, 401, 429 if reproducible, malformed custom URL, and cancellation.
- Tools: one schema returns a tool call; verify argument fragments and no execution.
- Image: one supported model receives a small image; inspect exact data URL payload.
- Reasoning: inspect outbound field for each supported mapping.
- Ollama: compare `/api/tags` with `ollama ls`, pull a small model, inspect `/api/show`, observe `/api/ps`, stop it, and remove only a disposable test model.
- Persistence: restart the app; provider/profile/UI draft reload; API key stays masked but works.

### Security checks

- Confirm state directory/file permissions with the platform API, not a UI label.
- Confirm the state path cannot be fetched over HTTP.
- Confirm `GET /api/state` and errors never include key values.
- Load a page from another origin and verify Origin/Host/session checks block local API calls.
- Configure a redirecting endpoint and verify the app neither follows it nor forwards credentials.
- Inspect page source and network requests for remote assets or telemetry.

## Synthesis

The shared Chat Completions path should stay generic. Provider differences belong in editable profile data, capability metadata, and four small reasoning mappings rather than separate client implementations. Ollama is the one justified exception: its local management API and process controls do not exist in the OpenAI-compatible surface.

## 15. Risks, gaps, and decisions for review

| Issue | Impact | Plan |
|---|---|---|
| Plaintext keys in JSON | Same-user malware and backups can read them | Accept for personal v1 with `0600` and explicit warning; add Keychain references if the threat model changes |
| “Raw packets” could mean network capture | Application cannot show TLS/TCP bytes without becoming a proxy | Define raw as exact application payload and SSE frames |
| OpenCode Zen/Go mix protocols | Some listed models cannot use Chat Completions | Mark protocol per model; version 1 tests only Chat-Completions models |
| ClinePass `/models` may be account-gated or undocumented | Fetch can fail despite valid chat credentials | Editable path, raw error, manual model entry, live-account verification task |
| Standard `/models` lacks capabilities | False capability claims would mislead tests | Tri-state values, source badges, manual override, provider-specific enrichment |
| Ollama has no generic settings API/CLI command | “Modify settings” requires process env and restart | Managed `ollama serve` env plus allowlisted macOS `launchctl`; show pending restart |
| Local web services face DNS-rebinding/CORS attacks | A malicious page could target provider keys or CLI actions | Loopback bind, exact Host/Origin, session token, no wildcard CORS, strict CSP [22] |
| Automatic chat retry can duplicate charges | A transient error may cause two billable requests | No automatic retries |
| Provider redirects can leak credentials | Auth could reach a different host | Disable redirects |
| Large raw streams can exhaust memory | Developer View may become unresponsive | 10 MiB capture cap with continued response rendering |

### Assumptions filled

- Target OS is macOS for the Ollama settings section. The core Node app remains portable, but Windows/Linux service controls need a separate reviewed plan.
- This is one local user on one machine. No multi-user access or remote binding exists.
- The app stores one current request draft and no completed history.
- Comparison means quick provider/model switching and inspectable traces, not a benchmark runner.
- Tool support means submitting definitions and inspecting returned calls, not running arbitrary code.
- Provider Base URL is the API root to which configured relative paths are appended.

## Recommendations

Approve the Node.js local-host approach and the plaintext-JSON threat boundary if this tool will remain personal and local. Build Milestones 1 and 2 first. They prove the key promise with the least code and expose any provider-path mismatch before model categorization or Ollama controls add surface area.

Do not add a desktop wrapper, Keychain integration, Responses API, automatic tool execution, request history, or benchmark mode until personal usage shows a concrete need.

## Limitations

Provider documentation and account behavior can diverge. OpenCode and ClinePass have authentication or model-list details that require a live subscribed account to confirm. This plan records those values as editable and avoids presenting inferred data as fixed truth.

The research verified protocol documentation, not every paid endpoint with real credentials. The local Ollama research found current API behavior and macOS restart requirements, but Windows and Linux were intentionally excluded. Capability labels remain only as accurate as provider metadata, curated preset facts, and user overrides.

## Bibliography

[1] OpenAI. “Create chat completion.” OpenAI API Reference. https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create (retrieved 2026-09-11).

[2] OpenAI. “List models.” OpenAI API Reference. https://developers.openai.com/api/reference/resources/models/methods/list (retrieved 2026-09-11).

[3] OpenAI. “Chat completion streaming events.” OpenAI API Reference. https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events (retrieved 2026-09-11).

[4] OpenAI. “openai-node streaming implementation.” GitHub. https://github.com/openai/openai-node/blob/master/src/streaming.ts (retrieved 2026-09-11).

[5] OpenAI. “Reasoning.” OpenAI API Guides. https://developers.openai.com/api/docs/guides/reasoning (retrieved 2026-09-11).

[6] Ollama. “API introduction.” GitHub. https://github.com/ollama/ollama/blob/main/docs/api/introduction.mdx (retrieved 2026-09-11).

[7] Ollama. “API reference.” GitHub. https://github.com/ollama/ollama/blob/main/docs/api.md (retrieved 2026-09-11).

[8] Ollama. “OpenAI compatibility.” GitHub. https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx (retrieved 2026-09-11).

[9] Ollama. “FAQ: configuring environment variables.” GitHub. https://github.com/ollama/ollama/blob/main/docs/faq.mdx (retrieved 2026-09-11).

[10] Ollama. “CLI reference.” GitHub. https://github.com/ollama/ollama/blob/main/docs/cli.mdx (retrieved 2026-09-11).

[11] decolua. “9Router README and API reference.” GitHub. https://github.com/decolua/9router/blob/master/README.md (retrieved 2026-09-11).

[12] Poolside. “API overview.” Poolside Documentation. https://docs.poolside.ai/api/overview (retrieved 2026-09-11).

[13] Poolside. “OpenAI-compatible API examples.” Poolside Documentation. https://docs.poolside.ai/api/openai-api-examples (retrieved 2026-09-11).

[14] OpenRouter. “API overview.” OpenRouter Documentation. https://openrouter.ai/docs/api-reference/overview (retrieved 2026-09-11).

[15] OpenRouter. “List all models and their properties.” OpenRouter Documentation. https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties (retrieved 2026-09-11).

[16] OpenCode. “Zen.” OpenCode Documentation. https://opencode.ai/docs/zen/ (retrieved 2026-09-11).

[17] OpenCode. “Go.” OpenCode Documentation. https://opencode.ai/docs/go/ (retrieved 2026-09-11).

[18] Cline. “ClinePass.” Cline Documentation. https://docs.cline.bot/getting-started/clinepass (retrieved 2026-09-11).

[19] Cline. “API authentication.” Cline Documentation. https://docs.cline.bot/api/authentication (retrieved 2026-09-11).

[20] Cline. “Models and capabilities.” Cline Documentation. https://docs.cline.bot/api/models (retrieved 2026-09-11).

[21] Apple. “Using the Keychain to manage user secrets.” Apple Developer Documentation. https://developer.apple.com/documentation/security/using-the-keychain-to-manage-user-secrets (retrieved 2026-09-11).

[22] GitHub Security Lab. “Localhost dangers: CORS and DNS rebinding.” GitHub Blog. https://github.blog/security/application-security/localhost-dangers-cors-and-dns-rebinding/ (retrieved 2026-09-11).

## Methodology appendix

Research used current official API documentation, official repositories, and provider documentation. OpenAI and Ollama references were also checked through the Context7 documentation index. Three parallel research passes covered the OpenAI protocol, Ollama controls, and provider/security details. Claims from secondary sources were not used as fixed preset facts when official documentation was absent.

The initial outline changed in three places after research. First, Ollama settings became a separate process-management concern because Ollama exposes model management APIs but no generic settings API. Second, capability values became tri-state because standard OpenAI model records lack capability fields. Third, OpenCode Go and Zen gained protocol compatibility flags because their catalogs include models routed through Responses and Anthropic Messages endpoints, outside the requested Chat Completions baseline.

[1]: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
[2]: https://developers.openai.com/api/reference/resources/models/methods/list
[3]: https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events
[4]: https://github.com/openai/openai-node/blob/master/src/streaming.ts
[5]: https://developers.openai.com/api/docs/guides/reasoning
[6]: https://github.com/ollama/ollama/blob/main/docs/api/introduction.mdx
[7]: https://github.com/ollama/ollama/blob/main/docs/api.md
[8]: https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx
[9]: https://github.com/ollama/ollama/blob/main/docs/faq.mdx
[10]: https://github.com/ollama/ollama/blob/main/docs/cli.mdx
[11]: https://github.com/decolua/9router/blob/master/README.md
[12]: https://docs.poolside.ai/api/overview
[13]: https://docs.poolside.ai/api/openai-api-examples
[14]: https://openrouter.ai/docs/api-reference/overview
[15]: https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
[16]: https://opencode.ai/docs/zen/
[17]: https://opencode.ai/docs/go/
[18]: https://docs.cline.bot/getting-started/clinepass
[19]: https://docs.cline.bot/api/authentication
[20]: https://docs.cline.bot/api/models
[21]: https://developer.apple.com/documentation/security/using-the-keychain-to-manage-user-secrets
[22]: https://github.blog/security/application-security/localhost-dangers-cors-and-dns-rebinding/
