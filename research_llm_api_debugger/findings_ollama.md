# Findings: Ollama API & CLI behavior (for local macOS app)

Research date: 2026-09-11. Sources: official Ollama docs (`ollama/ollama` GitHub: `docs/api.md`, `docs/api/streaming.mdx`, `docs/api/openai-compatibility.mdx`, `docs/cli.mdx`, `docs/faq.mdx`, `envconfig/config.go`) via Context7 (`/ollama/ollama`), plus live probes against the local server (v0.34.0 at `127.0.0.1:11434`, installed at `/usr/local/bin/ollama`, macOS 24.6.0). Claims verified by direct observation are marked **[LIVE]**; all other claims are quoted from official sources.

## 1. Default host/port & base URLs

- Server binds `127.0.0.1:11434` by default. **[LIVE]** `GET http://127.0.0.1:11434/api/version` -> `{"version":"0.34.0"}`.
- Docs: "The default local base URL and the cloud-hosted base URL for Ollama services. `http://localhost:11434/api` ... `https://ollama.com/api`" (docs/api/introduction.mdx).
- `OLLAMA_HOST` env var: "IP Address for the ollama server (default 127.0.0.1:11434)" (envconfig/config.go; confirmed on installed binary via `ollama serve --help`).
- FAQ: "Ollama binds 127.0.0.1 port 11434 by default." Override with `OLLAMA_HOST`.
- Models stored at `~/.ollama/models` on macOS (FAQ). **[LIVE]** local `~/.ollama/` contains `config.json` (0600), `id_ed25519`/`id_ed25519.pub`, `history`, `cache/`; `~/.ollama/server.json` currently absent.

## 2. Native REST API endpoints

Base: `http://127.0.0.1:11434/api` (default). All from docs/api.md unless noted.

- **GET /api/tags** — list local models. `curl http://localhost:11434/api/tags` -> `{"models":[{name, model, modified_at, size, digest, details:{parent_model, format, family, families, parameter_size, quantization_level}}]}`. **[LIVE]** (this machine returns a cloud entry `deepseek-v4-pro:cloud` with extra `remote_model`/`remote_host` fields, so the schema extends for cloud models).
- **POST /api/show** — model info. Request `{"model":"llava"}`, optional `"verbose": true`. Response: `modelfile`, `parameters`, `template`, `details`, `model_info`, `capabilities` (e.g. `["completion","vision"]`). Docs: "Show information about a model including details, modelfile, template, parameters, license, and system prompt"; "verbose (boolean) - Optional - If set to true, returns full data for verbose response fields".
- **POST /api/pull** — download model. `curl http://localhost:11434/api/pull -d '{"model":"llama3.2"}'`. Streams NDJSON status updates: `{"status":"pulling manifest"}` -> `{"status":"pulling digestname","digest":...,"total":...,"completed":...}` -> `{"status":"verifying sha256 digest"}` -> `{"status":"writing manifest"}` -> `{"status":"removing any unused layers"}` -> `{"status":"success"}`.
- **DELETE /api/delete** — remove model. `curl -X DELETE http://localhost:11434/api/delete -d '{"model":"llama3:13b"}'` (JSON body, not URL path).
- **GET /api/ps** — models loaded in memory. Response `{"models":[{name, model, size, digest, details, expires_at, size_vram}]}`. **[LIVE]** (returns `{"models":[]}` here; the cloud model is not resident).
- Related: `POST /api/chat` (chat; streaming default; supports `tools`, `format`, `options`) and `POST /api/generate` (completion). Both accept `"stream": false` for a single JSON response; both support `keep_alive` (duration like `"10m"`, seconds, negative = pin in memory, `0` = unload immediately) and model preloading via empty body `{"model":"mistral"}` (FAQ).
- Anthropic-compat `/v1/messages` also served on `http://localhost:11434` (docs/api/anthropic-compatibility.mdx).

## 3. OpenAI-compatible endpoints

Docs: docs/api/openai-compatibility.mdx. Base URL `http://localhost:11434/v1`. API key: "`api_key='ollama', # required but ignored`".

- **POST /v1/chat/completions** — chat completions incl. multimodal (base64 image in `image_url`; **remote image URLs NOT supported**). Supported fields: `model`, `messages` (text / array content parts / base64 images), `frequency_penalty`, `presence_penalty`, `response_format`, `seed`, `stop`, `stream`, `stream_options.include_usage`, `temperature`, `top_p`, `max_tokens`, `tools`, `reasoning_effort` (`high|medium|low|max|none`), `reasoning.effort`. **Not supported**: `tool_choice`, `logit_bias`, `user`, `n`, `logprobs`, remote image URLs. Non-streaming response: `choices[].message.{role,content}` + `finish_reason` (docs show `"finish_reason":"stop"`; live observed `"finish_reason":"length"` when cut off).
- **POST /v1/completions** — legacy; fields incl. `prompt` (string only), `suffix`; same exclusions.
- **GET /v1/models** — list. `created` = last modified; `owned_by` = ollama username defaulting to `"library"`. **[LIVE]** HTTP 200.
- **GET /v1/models/{model}** — single model.
- **POST /v1/embeddings** — `model`, `input` (string or array of strings), `encoding format`, `dimensions`.
- **POST /v1/responses** — OpenAI Responses API; "Added in Ollama v0.13.3". Non-stateful only (no `previous_response_id`/`conversation`); fields: `model`, `input`, `instructions`, `tools`, `stream`, `temperature`, `top_p`, `max_output_tokens`. Supports streaming (SSE), tools, reasoning summaries.

## 4. Streaming format (verified live)

- **Native** (`/api/generate`, `/api/chat`, `/api/pull`): newline-delimited JSON, `Content-Type: application/x-ndjson` (docs/api/streaming.mdx; server/routes.go sets that header for chat and generate streams). Default streaming; `"stream": false` returns single `application/json`.
  - `/api/generate` chunks: `{"model","created_at","response":"<partial>","done":false}`; final chunk adds `"done":true,"done_reason":"stop"` and timing stats (`total_duration`, `load_duration`, `prompt_eval_count`, `prompt_eval_duration`, `eval_count`, `eval_duration`).
  - `/api/chat` chunks: `{"model","created_at","message":{"role":"assistant","content":"<partial>","images":null},"done":false}`; final chunk `message.content:""` with `done:true` + stats. Thinking models may interleave `message.thinking` partials before `message.content` (docs/capabilities/streaming.mdx, capabilities/thinking.mdx).
  - server/routes.go `streamResponse` stops the stream cleanly on client disconnect/write failure.
- **OpenAI-compatible** (`/v1/chat/completions` with `"stream": true`; also `/v1/responses`): **SSE** — each event `data: {json}` then blank line; final event `data: [DONE]`. **[LIVE]** captured chunks from `deepseek-v4-pro:cloud`:
  - `data: {"id":"chatcmpl-902","object":"chat.completion.chunk","created":...,"model":"deepseek-v4-pro","system_fingerprint":"fp_ollama","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning":"..."},"finish_reason":null}]}`
  - `data: {"id":"chatcmpl-902",...,"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}`
  - `data: [DONE]`
  - Reasoning models emit `delta.reasoning` in early chunks **[LIVE]**.
- Debugger implication: both dialects are line-oriented; for "exact request/stream data" display, preserve raw lines (NDJSON lines vs `data:` SSE lines).

## 5. CLI commands (macOS app / subprocess perspective)

Verified against installed v0.34.0 (`ollama --help`) and docs/cli.mdx. Commands: `serve` (alias `start`), `create`, `show`, `run`, `stop`, `pull`, `push`, `signin`, `signout`, `list` (alias `ls`), `ps`, `cp`, `rm`, `launch`, `help`. Flags: `--help`, `--nowordwrap`, `--verbose`, `-v/--version`.

- `ollama run <model> ["prompt"]` — REPL or one-shot; multiline via `"""`; multimodal image path in prompt; embeddings via `ollama run <embed-model> "text"`; also accepts piped stdin (`echo "Hello world" | ollama run nomic-embed-text`). **[LIVE]** stdin-driven `ollama run deepseek-v4-pro:cloud` ran (spinner on stderr).
- `ollama pull <model>` / `ollama rm <model>` / `ollama cp <src> <dst>`; `ollama ls` / `ollama ps` (ps: NAME, ID, SIZE, PROCESSOR e.g. `100% GPU`, UNTIL; docs/context-length.mdx shows context column); `ollama stop <model>` (unload); `ollama serve` (start server; `--help` lists env vars); `ollama create -f Modelfile` (custom models — also the documented way to change context size for OpenAI-compat calls: `FROM <model>` + `PARAMETER num_ctx`); `ollama show <model>`; `ollama signin`/`signout` (ollama.com account, needed for private/cloud models); `ollama launch` (integration launcher: OpenCode, Claude Code, Codex, VS Code, Droid).
- **TTY requirement**: cmd/cmd.go: "model selection requires an interactive terminal; use --model to run in headless mode" (for `ollama launch`/interactive selectors). `ollama run` works headless via stdin/argument.
- **CLI is a thin HTTP client**: CLI commands call the API via `api.ClientFromEnvironment()` and honor `OLLAMA_HOST` (cmd/cmd.go). **[LIVE]** `OLLAMA_HOST=http://127.0.0.1:9999 ollama ls` -> `Error: timed out waiting for server to start` — the CLI *attempts to auto-start the local server* when none responds, instead of failing fast. Implication: for a mac app, drive the HTTP API directly for reads/streams; use CLI subprocesses only when intentionally managing the server or for operations the API lacks.

## 6. Environment-based settings (server config)

Full list from installed `ollama serve --help` + envconfig/config.go. These are read **at server startup** (see section 7):

| Variable | Meaning / default |
|---|---|
| `OLLAMA_HOST` | listen address (default `127.0.0.1:11434`) |
| `OLLAMA_CONTEXT_LENGTH` | default context (4k/32k/256k by VRAM) |
| `OLLAMA_KEEP_ALIVE` | memory retention (default `"5m"`) |
| `OLLAMA_MAX_LOADED_MODELS` | max loaded models per GPU (default 3 x GPUs, 3 CPU) |
| `OLLAMA_NUM_PARALLEL` | parallel requests per model (default 1) |
| `OLLAMA_MAX_QUEUE` | queued requests cap (default 512; exceeding -> HTTP 503) |
| `OLLAMA_MAX_TRANSFER_STREAMS` | safetensors transfer streams (default 4) |
| `OLLAMA_MODELS` | models dir (macOS: `~/.ollama/models`) |
| `OLLAMA_ORIGINS` | CORS origins (default `127.0.0.1`,`0.0.0.0`; extension origins `chrome-extension://*` etc. must be added explicitly) |
| `OLLAMA_NO_CLOUD` | disable cloud models/web search (also `~/.ollama/server.json` -> `{"disable_ollama_cloud": true}`) |
| `OLLAMA_NOPRUNE`, `OLLAMA_DEBUG`, `OLLAMA_DEBUG_LOG_REQUESTS`, `OLLAMA_FLASH_ATTENTION`, `OLLAMA_KV_CACHE_TYPE` (f16/q8_0/q4_0), `OLLAMA_GPU_OVERHEAD`, `OLLAMA_IGPU_ENABLE`, `OLLAMA_LLM_LIBRARY`, `OLLAMA_SCHED_SPREAD`, `OLLAMA_LOAD_TIMEOUT`, `OLLAMA_GO_TEMPLATE`, `OLLAMA_NOHISTORY`, `OLLAMA_EDITOR`, `OLLAMA_REMOTES` (default `ollama.com`), `LLAMA_ARG_FIT`, `LLAMA_ARG_FIT_TARGET` | advanced/GPU tuning |
| `HTTPS_PROXY` / `NO_PROXY` | pull proxy; FAQ warns **not** to set `HTTP_PROXY` (pulls are HTTPS-only; it can break client connections) |
| `OLLAMA_API_KEY` | auth for ollama.com cloud API (docs/cloud.mdx) |

macOS specific (docs/faq.mdx): "If Ollama is run as a macOS application, environment variables should be set using `launchctl`: `launchctl setenv OLLAMA_HOST "0.0.0.0:11434"` ... Restart Ollama application." **[LIVE]** `launchctl getenv OLLAMA_HOST` returns empty -> server running on defaults.

## 7. Which controls require restarting Ollama

- **Server env vars require a full restart.** macOS (FAQ): set via `launchctl setenv`, then "Restart Ollama application" (Linux: `systemctl daemon-reload` + `systemctl restart ollama`). Covers `OLLAMA_HOST`, `OLLAMA_MODELS`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_NO_CLOUD`, `OLLAMA_ORIGINS`, context-length, concurrency tunables, etc. — read once at startup.
- `disable_ollama_cloud` in `~/.ollama/server.json`: FAQ — "Restart Ollama after changing configuration."
- **No restart needed:** per-request controls — `keep_alive` overrides `OLLAMA_KEEP_ALIVE` (FAQ); `num_ctx` via request `options` or `/set parameter` in `ollama run`; model load/unload (`ollama stop`, `keep_alive: 0`); model add/remove (`ollama pull`/`rm`, `/api/pull`, `/api/delete`) take effect immediately; OpenAI-compat per-request params.
- macOS app updates: FAQ — auto-downloaded; apply via menubar "Restart to update".

## 8. Safe subprocess invocation without a shell

- **Use argv-array spawn (execve semantics), never a shell string.** `ollama` parses args itself via cobra (cmd/cmd.go); model names are validated (`model.ParseName`, `name.IsValid()`). Passing user-controlled model names/paths as individual argv elements eliminates shell metacharacter injection. Never `sh -c "ollama run $USER_INPUT"`.
- **Model-name trust boundary**: model names encode the remote registry host — validate against the documented `library/model[:tag]` shape before pull/run/rm.
- `ollama run` headless: pass full prompt as argument or via stdin; interactive features (REPL, `/set`, `"""` editing) and `ollama launch` need a TTY. Progress/spinners go to `os.Stderr` (cmd/cmd.go `progress.NewProgress(os.Stderr)`); model output on stdout.
- **Auto-start behavior**: CLI starts the server if unreachable ("timed out waiting for server to start" **[LIVE]**). Deterministic app pattern: (a) pre-flight `GET /api/version` on the host; (b) use HTTP for management/streaming; (c) only spawn `ollama serve`/subprocesses when managing the server itself, passing an explicit env and argv.
- Per-invocation env works: `OLLAMA_HOST=http://127.0.0.1:9999 ollama ls` honored the override and failed connecting **[LIVE]** — pass an explicit `env` to child processes so launchctl/app-level vars don't leak in.

## 9. Gaps / unknowns

- `server.json` documented but absent locally; `config.json` (0600) exists but schema undocumented in public docs — install/account-specific.
- Error/status shapes for /api/* exercised live only for: /api/version, /api/tags, /api/ps, /v1/models, /v1/chat/completions stream. 404/503 shapes not live-tested; docs show `{"error":"..."}` style.
- `/v1/completions` legacy endpoint not live-tested (no plain completion model loaded).
- Cloud auth (`OLLAMA_API_KEY`, `ollama signin`): mechanism documented, credentials unverified.
- `delta.reasoning` shape observed only on one cloud model; local thinking models may use `message.thinking` naming (native API).
