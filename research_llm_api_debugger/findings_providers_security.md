# Findings: Named Providers & Local Security

Research for the OpenAI-compatible API debugger. Every factual claim carries an exact quote, source URL/title, and a confidence score. Unverified or account-specific values are explicitly marked as **UNVERIFIED / CONFIGURABLE PRESET** and must not be treated as fixed facts. Research date: 2026-09-11.

---

## 1. Ollama

| Aspect | Finding |
|---|---|
| OpenAI-compatible base URL | `http://localhost:11434/v1/` (trailing slash shown in official example) |
| Auth header | No real auth — `api_key: 'ollama'` is "required but ignored"; any string accepted ("Accepted but not validated") |
| GET /models | Yes — `curl http://localhost:11434/v1/models`, plus `client.models.list()`; also `/v1/models/{model}` |
| Tool metadata | No per-model capability metadata in `/v1/models`; tools are a request feature, not model metadata (`owned_by` = username; `created` = last modified) |
| Image metadata | Not exposed per-model; image input is a request feature (base64 only; no image URL support) |
| Reasoning metadata | Not exposed in `/v1/models`; `/v1/responses` (v0.13.3+, non-stateful) documents "Reasoning summaries (thinking models)" |

Quotes:
- "Ollama provides experimental compatibility with parts of the OpenAI API" and `client = OpenAI(base_url='http://localhost:11434/v1/', api_key='ollama' # required but ignored)` — Ollama OpenAI Compatibility docs, https://ollama.readthedocs.io/en/openai/, confidence 0.95.
- "/v1/models Notes: `created` corresponds to when the model was last modified; `owned_by` corresponds to the ollama username, defaulting to `"library"`" — same, 0.9.
- "/v1/responses — Added in Ollama v0.13.3 — ✅ Streaming ✅ Tool calling ✅ Reasoning summaries (thinking models) ❌ Stateful requests" — same, 0.9.

## 2. 9Router (decolua/9router)

| Aspect | Finding |
|---|---|
| OpenAI-compatible base URL | `http://localhost:20128/v1` (dashboard at `http://localhost:20128`) |
| Auth header | `Authorization: Bearer your-api-key` (dashboard-issued key) — optional by default: `REQUIRE_API_KEY` env var defaults `false` |
| GET /models | Yes — `GET http://localhost:20128/v1/models` → "Returns all models + combos in OpenAI format"; aggregates static models plus live catalogs |
| Tool metadata | No per-model capability metadata in the OpenAI-format model list; router translates formats (OpenAI↔Claude) |
| Image metadata | No capability metadata documented; router proxies multi-modal requests |
| Reasoning metadata | No per-model metadata in `/v1/models`; `THINKING_CONFIG` (extended/effort) exists in code (DeepWiki, secondary) |

Quotes:
- "Endpoint: http://localhost:20128/v1 — API Key: [copy from dashboard]" — 9Router README, https://github.com/decolua/9router/blob/master/README.md, 0.7.
- "List Models — `GET http://localhost:20128/v1/models Authorization: Bearer your-api-key` → Returns all models + combos in OpenAI format" — 9Router README, 0.7.
- "`REQUIRE_API_KEY` `false` — Enforce Bearer API key on `/v1/*` routes (recommended for internet-exposed deploys)" — 9Router README env table, 0.6.
- "The `/v1/models` endpoint aggregates static models from `PROVIDER_MODELS` with live catalogs fetched via `LIVE_MODEL_RESOLVERS`" — DeepWiki API Reference, https://deepwiki.com/decolua/9router/9-api-reference, 0.5 (secondary).
- "`extended` | `auto`,`on`,`off` | Claude-style thinking `budget_tokens`; `effort` | `auto`,`none`,`low`,`medium`,`high` | OpenAI-style `reasoning_effort`" — DeepWiki Provider Configuration, https://deepwiki.com/decolua/9router/5.1-provider-configuration, 0.5 (secondary).

## 3. Poolside

| Aspect | Finding |
|---|---|
| OpenAI-compatible base URL | Platform: `https://inference.poolside.ai/v1`; self-managed: `<api-domain>/openai/v1`; also via OpenRouter |
| Auth header | `Authorization: Bearer <api-key>` (Platform / deployment admin / OpenRouter key) |
| GET /models | Yes — `GET https://inference.poolside.ai/v1/models` → `object:"list"`, `data[].{id, created, owned_by}` (owned_by `"system"`) |
| Tool metadata | Tool calling documented (`tools` array, `tool_calls` response) — request feature, not catalog metadata |
| Image metadata | NOT supported: all models "Text-to-text" / "does not support vision inputs" (release notes) |
| Reasoning metadata | Documented per-request: `chat_template_kwargs.enable_thinking` (off/max), OpenRouter-style `reasoning` object, `reasoning_content` must be preserved in follow-ups; no per-model flags in GET /models |

Quotes:
- "OpenAI-compatible API — Send chat completion requests, list available models, stream responses, and use tool calling with Poolside models. Base path: `/openai/v1`" — Poolside API overview, https://docs.poolside.ai/api/overview, 0.95.
- "curl --request GET --url https://inference.poolside.ai/v1/models ... `"data": [{"id": "poolside/laguna-s-2.1", "created": 1751637312, "owned_by": "system", "object": "model"}], "object": "list"`" — OpenAI-compatible API examples, https://docs.poolside.ai/api/openai-api-examples, 0.9.
- "Laguna S 2.1 ... Modality: Text-to-text ... Laguna S 2.1 is text-to-text and does not support vision inputs." — model release notes, https://docs.poolside.ai/release-notes/models, 0.9 (same for XS 2.1, M.1, XS.2).
- "Turn off thinking... set `chat_template_kwargs.enable_thinking` to `false`" / "preserve `reasoning_content` from assistant responses" — https://docs.poolside.ai/api/openai-api-examples, 0.85.

## 4. OpenRouter

| Aspect | Finding |
|---|---|
| OpenAI-compatible base URL | `https://openrouter.ai/api/v1` (endpoint `/api/v1/chat/completions`) |
| Auth header | `Authorization: Bearer <OPENROUTER_API_KEY>`; optional `HTTP-Referer`, `X-OpenRouter-Title` (`X-Title` back-compat), `X-OpenRouter-Categories` |
| GET /models | Yes — "list every available slug programmatically via the `GET /api/v1/models` endpoint"; models carry name/pricing/supported-parameters metadata |
| Tool metadata | Yes — models page filterable by `supported_parameters=tools` |
| Image metadata | Yes — schema includes `ImageContentPart { type:'image_url', image_url:{ url, detail } }`; per-model support varies |
| Reasoning metadata | Yes — `completion_tokens_details.reasoning_tokens` in usage; docs reference model reasoning/effort metadata |

Quotes:
- "baseURL: 'https://openrouter.ai/api/v1', apiKey: '<OPENROUTER_API_KEY>' ... defaultHeaders: 'HTTP-Referer' ... 'X-OpenRouter-Title'" — API Reference, https://openrouter.ai/docs/api_reference/overview, 0.95.
- "or list every available slug programmatically via the `GET /api/v1/models` endpoint." — Quickstart, https://openrouter.ai/docs/quickstart, 0.9.
- "See models supporting tool calling: openrouter.ai/models?supported_parameters=tools" — API Reference, 0.85.
- "`HTTP-Referer` ... is required for app attribution" — App Attribution, https://openrouter.ai/docs/app-attribution, 0.9 (attribution headers optional for API function; 2024 community claim of content stripping without them = unverified legacy anecdote).

## 5. OpenCode Zen

| Aspect | Finding |
|---|---|
| OpenAI-compatible base URL | Protocol-split: `https://opencode.ai/zen/v1/responses` (OpenAI), `/zen/v1/messages` (Anthropic), `/zen/v1/chat/completions` (open models). Base host `https://opencode.ai/zen/v1` |
| Auth header | Key from opencode.ai/auth via `/connect`; exact header not documented — **INFERRED** `Authorization: Bearer <key>` (SDK-driven); UNVERIFIED preset |
| GET /models | Yes — "fetch the full list of available models and their metadata from: https://opencode.ai/zen/v1/models" |
| Tool metadata | Not enumerated on page; "/v1/models" is the documented metadata source |
| Image metadata | "DeepSeek V4 Flash Vision Exp" cataloged; image-token billing note |
| Reasoning metadata | Not enumerated; models metadata endpoint is the documented source |

Quotes:
- "You can fetch the full list of available models and their metadata from: https://opencode.ai/zen/v1/models" — https://opencode.ai/docs/zen/, 0.9.
- "The model id in your OpenCode config uses the format `opencode/`. For example, for GPT 5.5, you would use `opencode/gpt-5.5`" — same, 0.9.
- "DeepSeek V4 Flash Vision Exp: Images are converted into tokens based on their dimensions and billed as input tokens alongside text tokens." — same, 0.85.

## 6. OpenCode Go

| Aspect | Finding |
|---|---|
| OpenAI-compatible base URL | `https://opencode.ai/zen/go/v1` with per-model paths: `/v1/chat/completions` (open models), `/v1/responses` (Grok/GPT/Spark), `/v1/messages` (MiniMax/Qwen) |
| Auth header | Key from opencode.ai/auth; exact header not documented — **INFERRED** `Authorization: Bearer <key>` (SDK-driven); UNVERIFIED preset |
| GET /models | Yes — "fetch the full list of available models and their metadata from: https://opencode.ai/zen/go/v1/models" |
| Tool metadata | Not enumerated; docs specify client behavior: custom User-Agent + `x-opencode-session` header |
| Image metadata | "DeepSeek V4 Flash Vision Exp" in Go plan, same image-token billing note; training/retention table published |
| Reasoning metadata | Not enumerated on page; `/v1/models` metadata endpoint is the documented source |

Quotes:
- "You can fetch the full list of available models and their metadata from: https://opencode.ai/zen/go/v1/models" — https://opencode.ai/docs/go/, 0.9.
- "Send a stable session ID in `x-opencode-session` for each conversation so we can optimize routing and prompt caching." — same, 0.85.
- "DeepSeek V4 Flash Vision Exp: Images are converted into tokens based on their dimensions and billed as input tokens alongside text tokens." — same, 0.8.

## 7. Cline / Clinepass

| Aspect | Finding |
|---|---|
| OpenAI-compatible base URL | `https://api.cline.bot/api/v1` (ClinePass shares this; example: `https://api.cline.bot/api/v1/chat/completions`) |
| Auth header | `Authorization: Bearer <key>` — "Every request to the Cline API requires authentication via a Bearer token in the `Authorization` header"; keys at app.cline.bot Settings > API Keys; optional `HTTP-Referer`/`X-Title`/`X-Task-ID` |
| GET /models | Per-model capability catalog documented (`supportsReasoning`, `supportsImages`); public list endpoint not in API docs — SDK fetches `${apiBaseUrl}/api/v1/ai/cline/recommended-models` (source) — UNVERIFIED |
| Tool metadata | Tool calling documented (OpenAI function format); catalog flags per model |
| Image metadata | Yes — base64 `image_url` documented; `supportsImages` catalog flag |
| Reasoning metadata | Yes — `delta.reasoning` streaming, separate reasoning token counts, `supportsReasoning` flag |

Quotes:
- "curl -X POST https://api.cline.bot/api/v1/chat/completions -H "Authorization: Bearer $CLINE_API_KEY" ... -d '{ "model": "cline-pass/qwen3.7-max", ... }'" — ClinePass docs, https://docs.cline.bot/getting-started/clinepass, 0.9.
- "Every request to the Cline API requires authentication via a Bearer token in the `Authorization` header." — https://docs.cline.bot/api/authentication, 0.95; OpenAI SDK `base_url="https://api.cline.bot/api/v1"` same source, 0.9.
- "ClinePass is a separate provider in Cline... $9.99/month"; model IDs `cline-pass/glm-5.2`, `cline-pass/kimi-k3`, ... — https://docs.cline.bot/getting-started/clinepass, 0.9.
- "Reasoning content appears in `delta.reasoning` during streaming... Check the model's `supportsReasoning` capability in the model catalog." — https://docs.cline.bot/api/chat-completions, https://docs.cline.bot/api/models, 0.85.
- "Not all models support images. Check the model's `supportsImages` capability before sending image content." — https://docs.cline.bot/api/models, 0.8.

## 8. Safe local JSON secret storage on macOS

Primary source: Apple Developer Documentation (Security / Keychain Services).

Recommendation: DO NOT persist API keys in plaintext JSON on disk. Store secrets in the macOS Keychain (`kSecClassGenericPassword` items); keep non-secret provider metadata (base URLs, model ids, header templates) in JSON referenced by stable identifiers. `security` CLI or SecItem* calls are the sanctioned interface.

Quotes:
- "Keychain services helps solve this problem by providing easy access to encrypted storage... keychain services handles data encryption and storage... in a keychain, which is an encrypted database stored on disk. Later, authorized processes use keychain services to find the item and decrypt its data." — https://developer.apple.com/documentation/security/using-the-keychain-to-manage-user-secrets and https://developer.apple.com/documentation/security/keychain-items, 0.95.
- "`SecItemAdd(_:_:)` Adds one or more items to a keychain; `SecItemCopyMatching(_:_:)` Returns one or more keychain items that match a search query; `SecItemUpdate(_:_:)`; `SecItemDelete(_:)`" — https://developer.apple.com/documentation/security/keychain-items, 0.95.
- "Keychain services also offers the related `kSecClassGenericPassword` item class... When you don't need these extra attributes, use a generic password instead." — Adding a password to the keychain, https://developer.apple.com/documentation/security/adding-a-password-to-the-keychain, 0.9.
- "`SecAccessControlCreateWithFlags(_:_:_:_:)` Creates a new access control object with the specified protection type and flags." — https://developer.apple.com/documentation/security/keychain-items, 0.9.
- keychain-access-groups entitlement controls app sharing — same, 0.85.

## 9. Local web-app origin & security risks

Primary sources: GitHub Security Lab blog, WICG Local Network Access spec.

1. Keys must never reach the browser: backend holds keys (Keychain) and performs outbound calls; browser talks to local HTTP API. Cline docs forbid: "Do not: ... Embed keys in client-side code (browsers, mobile apps)" — https://docs.cline.bot/api/authentication, 0.9.
2. "When publishing software that holds security critical information or takes privileged actions, we strongly encourage developers to write code that checks that the origin header matches the host or an allowlist." — GitHub Security Lab, https://github.blog/security/application-security/localhost-dangers-cors-and-dns-rebinding/, 0.9.
3. "Never assume a service is safe just because it's 'only running locally.' Always enforce strong, password-based authentication—even for internal services... Validate the `Host` header." — GitHub Security Lab DNS rebinding post, https://github.blog/security/application-security/dns-rebinding-attacks-explained-the-lookup-is-coming-from-inside-the-house/, 0.85.
4. DNS rebinding: "DNS rebinding doesn't work for HTTPS services" and "the authentication cookies for `somesite.com` won't be accepted by the locally deployed web application." — same post, 0.85.
5. CORS misconfiguration: unsafe `allow_origins=["*"]` + `allow_credentials=True` reflects origin → "any website can send arbitrary requests to any endpoint" of a local instance; Cognita case escalated to local RCE via file write + uvicorn --reload — GitHub Security Lab, 0.9.
6. WICG Local Network Access: loopback/local requests gated behind `loopback-network`/`local-network` permissions; "The permissions are restricted to secure contexts. On non-secure contexts, all requests will fail."; known bypass (0.0.0.0 on Linux/macOS) — https://wicg.github.io/local-network-access/, 0.8; GitHub blog, 0.8.
7. 9Router default-auth footgun: `REQUIRE_API_KEY` defaults `false`; dashboard `INITIAL_PASSWORD` defaults `123456` — treat local API as trust boundary — README env table, 0.6.
8. Minimal process boundary [INFERENCE, synthesized from 1–7]: web UI → local HTTP API bound to 127.0.0.1 only → backend makes provider calls with Keychain-held keys; exact-origin allowlist; bearer secret for the local API; Host-header validation; no secrets in served JS.

---

## Gap register (unverified / account-specific / unknown)

- OpenCode Zen & Go: exact auth header not documented (SDK examples); `Authorization: Bearer` inferred. Base URLs are per-protocol paths; use `/v1/chat/completions` only for listed open models.
- 9Router: dashboard key format/semantics account-specific; `REQUIRE_API_KEY` off by default; `GET /v1/models` verified via README, not live probe.
- Cline/Clinepass: public `GET /v1/models` not documented; internal catalog path `api.cline.bot/api/v1/ai/cline/recommended-models` (from cline source) possibly account-gated.
- Poolside: `https://inference.poolside.ai/v1` documented platform URL; `<api-domain>` account-specific; no per-model tool/vision/reasoning flags in GET /models.
- Ollama: host/port configurable (default 11434); docs-based, not live-probed.
- Community report (Gerard Beckerleg blog, 2024) that OpenRouter strips content without HTTP-Referer for non-localhost keys contradicts current official docs; legacy/unverified.
- No live endpoint probing (curl GET /v1/models) performed; all findings documentation-based.
