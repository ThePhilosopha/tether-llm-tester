# OpenAI Chat Completions API — Compatibility Research Findings

Researched 2026-09-11 via `query_current_docs` (Context7 index of developers.openai.com API reference) and official OpenAI sources (developers.openai.com, github.com/openai). Web content treated as untrusted; claims are marked with source and confidence. Unknown/account-specific details are flagged.

---

## 1. POST /v1/chat/completions

**Endpoint:** `https://api.openai.com/v1/chat/completions`

> "Creates a model response for the given chat conversation. This endpoint supports standard text messages, tool calling, and multimodal inputs."
> — Source: "POST /v1/chat/completions", https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create | Confidence: High

**Required body fields:** `model` (string, required), `messages` (array, required). Documented optional fields include `tools`, `tool_choice`, `audio` (requires `format` + `voice`), `frequency_penalty`, `logit_bias`, `logprobs`, `max_completion_tokens`, `metadata` (up to 16 key-value pairs), `modalities`, `service_tier` ("auto", "default", "flex", "scale", "priority", "fast"), `stop` (up to 4 sequences), `store`, `stream`, `stream_options` (with `include_obfuscation` and `include_usage`), `temperature` (0–2), `top_p`, `parallel_tool_calls` (documented in SDK types), `user`.

> "**max_tokens** (number) - Optional - Deprecated. Use `max_completion_tokens` instead."
> — Source: "Chat Completions Parameters", https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create | Confidence: High

**Non-streaming response shape (200):** `{ id, object: "chat.completion", created, model, choices: [{ index, message: { role, content, tool_calls? }, logprobs, finish_reason }], usage }`.

> Response example shows `"finish_reason": "tool_calls"` with `message.content: null` and `message.tool_calls[0] = { id: "call_abc123", type: "function", function: { name, arguments: "<JSON string>" } }`; usage includes `completion_tokens_details: { reasoning_tokens, accepted_prediction_tokens, rejected_prediction_tokens }`.
> — Source: "Create chat completion with tool calling", https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create | Confidence: High

**Note:** The current reference renders newer model names (`gpt-5.4`) in examples; `gpt-3.5-turbo`-era examples remain in parameter docs. Model naming is account/availability-dependent — treat specific model IDs as configurable presets, not fixed facts. [INFERENCE]

---

## 2. GET /v1/models

**Endpoint:** `https://api.openai.com/v1/models` — `GET` with `Authorization: Bearer $OPENAI_API_KEY`.

**Response shape (200):** `{ "object": "list", "data": [ { "id", "object": "model", "created": <unix ts>, "owned_by", "shutdown_date" } ] }`.

> "Lists the currently available models, and provides basic information about each one such as the owner and availability." Response example:
> ```json
> { "object": "list", "data": [ { "id": "model-id-0", "object": "model", "created": 1686935002, "owned_by": "organization-owner", "shutdown_date": null } ] }
> ```
> — Source: "List models", https://developers.openai.com/api/reference/resources/models/methods/list | Confidence: High

**Single-model variant:** `GET /models/{model}` returns `{ id, object: "model", created, owned_by, shutdown_date }` where `shutdown_date` is "The date when the model will shut down, or null if not announced" — a useful compatibility signal for debuggers that lets clients detect model retirement dates from the API itself.

> — Source: "Retrieve model", https://developers.openai.com/api/reference/resources/models/methods/retrieve | Confidence: High

---

## 3. Authorization header

> "Standard format for providing API credentials in the Authorization header: `Authorization: Bearer OPENAI_API_KEY_OR_ACCESS_TOKEN`"
> — Source: "Authenticate with Bearer Token", https://developers.openai.com/api/reference/overview | Confidence: High

All curl examples (chat completions, models list, streaming) send `Content-Type: application/json` plus `Authorization: Bearer $OPENAI_API_KEY`. OpenAI-compatible providers (Ollama, OpenRouter, etc.) accept this same scheme — that is the compatibility contract a debugger must rely on. [INFERENCE from research plan] Account-specific: OpenAI API keys begin with `sk-`; bearer tokens are also accepted. Key format specifics are account/org-dependent and should not be validated client-side beyond non-empty.

---

## 4. Streaming — SSE framing and the `[DONE]` sentinel

Setting `"stream": true` returns a `text/event-stream` response; each event is `data: <JSON chunk>` lines separated by blank lines (`\n\n`); the stream ends with a literal `data: [DONE]` line that is **not JSON**.

**Official streaming chunk example:**
> ```json
> {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-4o-mini", "system_fingerprint": "fp_44709d6fcb", "choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}]}
> {"id":"chatcmpl-123", ..., "choices":[{"index":0,"delta":{"content":"Hello"},...}]}
> ....
> {"id":"chatcmpl-123", ..., "choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}]}
> ```
> — Source: "Chat Completion Chunk Structure", https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events | Confidence: High

**Chunk fields (official):** `id`, `object` (always `chat.completion.chunk`), `created`, `model`, `system_fingerprint`, `choices[]` with `delta { content: string|null, tool_calls: array, role }`, `finish_reason` (one of `"stop"`, `"length"`, `"tool_calls"`, `"content_filter"`, `"function_call"`), `logprobs`, and optional `usage` "present only in the final chunk when `include_usage` is enabled".

> "Token usage statistics are optional and only provided when stream_options is configured to include usage. When enabled, usage data is returned in the final chunk of the stream. If a stream is interrupted or cancelled, the final usage chunk may not be delivered."
> — Source: "Streaming Events > Usage", https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events | Confidence: High

**Official client confirmation of the `[DONE]` sentinel** (openai-node `Stream.fromSSEResponse`): the SSE decoder joins `data:` fields with `\n`, and the iterator checks `if (sse.data.startsWith('[DONE]')) { done = true; continue; }`.
> — Source: openai/openai-node/src/streaming.ts, https://github.com/openai/openai-node/blob/fa88266e2cd231fa78c2e12006e488472332a694/src/streaming.ts | Confidence: High

**Wire-format caveats for a debugger (secondary sources, high practical value):**
- Events are split on blank lines; `data:` lines within one event are concatenated with newline per SSE spec — a client must buffer across TCP chunks and normalize `\r\n` before splitting.
- The final line `data: [DONE]` must be checked as a literal string *before* `JSON.parse`, or parsing throws.
- A single delta can carry a token fragment, one token, or several tokens — never assume one-token-per-chunk.
- Browsers' `EventSource` cannot be used (GET-only, cannot set `Authorization` header); `fetch` + streaming reader is the standard path.
> — Source: "How LLM Response Streaming Works" https://packet.ai/blog/streaming-llm-responses and "Streaming LLM Responses with Server-Sent Events" https://api.avemujica.moe/blog/streaming-llm-responses-sse | Confidence: Medium (non-official analysis corroborated by the official SSE chunk shape and openai-node decoder)

**Responses API distinction:** `/v1/responses` streaming uses named semantic events (`response.created`, `response.output_text.delta`, `response.completed`, ...) instead of delta chunks + `[DONE]` — a parser built for one needs adjusting for the other. (Chat Completions streams remain the industry-compatible convention.) [Secondary-source corroboration: packet.ai, ave mujica blog, openmodel.ai docs. INFERENCE.]

---

## 5. Tool calls — request, non-streaming response, streamed argument fragments

**Request shape (official):**
> ```json
> { "model": "gpt-5.4", "messages": [{"role":"user","content":"What is the weather like in Boston today?"}],
>   "tools": [ { "type": "function", "function": { "name": "get_current_weather", "description": "...", "parameters": { "type": "object", "properties": {...}, "required": ["location"] } } } ],
>   "tool_choice": "auto" }
> ```
> `tool_choice` "Controls tool calling behavior (none, auto, required, or specific tool)".
> — Source: "Chat Completions Body Parameters" / "Create chat completion with tool calling", https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create | Confidence: High

**Strict mode:** "When using function tools, you can enable strict schema adherence by setting the strict parameter to true. This ensures the model follows the exact schema defined in the parameters field, though it limits the model to a subset of JSON Schema."
> — Source: "Chat Completion > Tools > Function Tools", same URL | Confidence: High

**Streamed tool-call fragments:** `chat.completion.chunk` `delta.tool_calls` is an array of objects; official field list confirms `delta.tool_calls` ("The tool calls generated by the model"). Official SDK types define `ChoiceDeltaToolCall` with `index` (int, required), `id`, `type`, `function { name, arguments }`, and OpenAI's own agents SDK accumulates them per-index:

> `_accumulate_tool_call_delta`: keyed by `tool_call_delta.index`; `if tool_call_delta.id: buffered_call.call_id = ...`; `if tool_call_delta.function.name: buffered_call.name = ...`; `if tool_call_delta.function.arguments: buffered_call.arguments += tool_call_delta.function.arguments` and errors if the stream ends without an id or name.
> — Source: openai/openai-agents-python `src/agents/models/chatcmpl_stream_handler.py`, https://github.com/openai/openai-agents-python/blob/cdde4d65/src/agents/models/chatcmpl_stream_handler.py | Confidence: High (official first-party implementation)

**Compatibility facts a debugger must handle (from first-party SDK + secondary corroboration):**
- Tool-call argument fragments arrive across multiple chunks; `arguments` is a JSON **string** that must be **concatenated by `index`**, then `JSON.parse`d only after the fragments for that index are complete (finish_reason `"tool_calls"` or a new index). Parsing too early throws `JSONDecodeError` or executes with partial args.
- The `id` and `function.name` typically arrive on the first fragment for an index; later fragments may carry only `arguments` deltas; `delta.function.arguments` can be `None`/absent and needs a null check.
- Reconstructed calls are replayed to the model on the next turn as an assistant message with `role: "assistant"`, `content`, and `tool_calls`, followed by `role: "tool"` messages with `tool_call_id`.
- Legacy `function_call` (top-level on messages) "is deprecated and has been replaced by tool calls", and model "may occasionally hallucinate parameters" — validate arguments before execution.
> — Sources: openai-agents-python stream handler (above); "ChatCompletionAssistantMessageParam > function_call" https://developers.openai.com/api/reference/resources/chat; theneuralbase.com streaming-tool-calls course (medium confidence, corroborates accumulation pattern) | Confidence: High for official items, Medium for community corroboration

---

## 6. Image / multimodal content

**Chat Completions user message content parts:** "User messages can contain various content types including text, images, audio, and files. Image inputs support different detail levels such as auto, low, or high, while audio inputs accept base64 encoded data in wav or mp3 formats. File inputs can be provided via file IDs or base64 encoded data."
> — Source: "Completions > User Messages", https://developers.openai.com/api/reference/resources/chat/subresources/completions | Confidence: High

**Image part (official)** — `ChatCompletionContentPartImage`: "Image inputs can be provided via URL or base64 encoded data. Users can specify the detail level as auto, low, or high."

**Multimodal message shape (official Python SDK example, same `content` array shape used by Chat Completions):**
> ```python
> "content": [
>     {"type": "text", "text": prompt},
>     {"type": "image_url", "image_url": f"{img_url}"},                    # URL form
>     {"type": "image_url", "image_url": f"data:image/png;base64,{b64_image}"},  # data URI form
> ]
> ```
> — Source: "Process images with Vision API", https://developers.openai.com/api/reference/python | Confidence: High

**Compatibility warning:** the Responses API uses a different part vocabulary (`input_text` / `input_image`) — the Chat Completions shape is `{"type": "text", "text"}` and `{"type": "image_url", "image_url": "<url or data:...;base64,...>"}` with optional `detail`. Providers' multimodal support varies; a universal-schema debugger must pass these content arrays through verbatim. [INFERENCE; part names are from official docs]

---

## 7. Reasoning effort controls

- **Chat Completions parameter:** `reasoning_effort` — top-level string, model-dependent allowed values. Official reference (fine-tuning/sampling params): "Reasoning effort settings allow users to constrain the reasoning process for supported models. Available levels range from minimal to max, where reducing effort can improve response speed and decrease token usage."
  — Source: https://developers.openai.com/api/reference/resources/fine_tuning | Confidence: High
- Historically documented values: `low | medium | high` (o1-era), extended to `none | minimal | low | medium | high | xhigh | max` for later models. Not every model accepts every value; defaults are model-dependent (e.g., o1/o3/o4-mini default `medium`; later GPT-5.x models vary, some default `none`).
  — Sources: reasoning guide + first-party SDK type `ReasoningEffort` ("Currently supported values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`... Not all reasoning models support every value"), https://github.com/openai/openai-python/blob/f16fbbd2/src/openai/types/shared/reasoning.py | Confidence: High
- The current reasoning guide frames `reasoning.effort` as a Responses-API object (`reasoning: {"effort": "low"}`); Chat Completions still accepts the flat `reasoning_effort` string. "Reasoning models work better with the Responses API. While the Chat Completions API is still supported, you'll get improved model intelligence and performance by using Responses."
  — Source: "Reasoning models", https://developers.openai.com/api/docs/guides/reasoning | Confidence: High
- Reasoning tokens count as output tokens (`usage.completion_tokens_details.reasoning_tokens` / `output_tokens_details.reasoning_tokens`), occupy context, and Chat Completions discards reasoning items between turns (Responses preserves them via `previous_response_id` or encrypted content).
  — Source: reasoning guide + ml4devs comparison (medium) | Confidence: High (official guide) / Medium (secondary analysis)

---

## 8. Migration / deprecation cautions

1. **Chat Completions is NOT deprecated.** "OpenAI has committed to continue supporting Chat Completions indefinitely — it remains the industry-standard surface that other providers emulate... Chat Completions is not on any sunset schedule."
   — Sources: dreaming.press analysis citing OpenAI deprecations page (medium confidence secondary); consistent with reasoning guide statement above (official, high) | Confidence: Medium–High
2. **Assistants API sunsets 2026-08-26.** "On August 26th, 2025, we notified developers using the Assistants API of its deprecation and removal from the API one year later, on August 26, 2026." Replacement: "Responses API and Conversations API".
   — Source: "2025-08-20: Assistants API", https://developers.openai.com/api/docs/deprecations (official) | Confidence: High
3. **Model retirements are frequent and dated.** Official deprecations page lists concrete shutdown dates, e.g. `o1-mini` → 2025-10-27, `o1-preview` → 2025-07-28; `gpt-5.2-chat-latest`/`gpt-5.3-chat-latest` → 2026-08-10; `gpt-3.5-turbo-instruct`, `babbage-002`, `davinci-002`, `gpt-3.5-turbo-1106` → 2026-09-28; `gpt-5-chat-latest` → 2026-07-23; plus `o1`/`o3`/`o4-mini` snapshots → 2026-10-23 (per modelparams + deprecations page). The models-list API returns `shutdown_date` per model, which a debugger can surface.
   — Source: https://developers.openai.com/api/docs/deprecations | Confidence: High (dates subject to change; always check the live page)
4. **Parameter-level deprecations:** `max_tokens` deprecated in favor of `max_completion_tokens`; legacy `function_call` deprecated in favor of `tools`/`tool_calls`; `stop`, `temperature`, `top_p`, `presence_penalty`, `frequency_penalty` not supported by some reasoning models (o1-era models ignore them; official completions reference notes `stop` "Not supported with reasoning models `o3` and `o4-mini`"). SDKs validate unknown parameters, so a raw-JSON pass-through debugger must NOT strip or type-check these client-side — providers vary.
   — Sources: chat completions params page; completions params page; SDK error reports (community) | Confidence: High (official) / Medium (community)

**Debugger design implication (synthesis):** because required fields are few (`model`, `messages`), error bodies can be JSON or plain text, streaming has two different vocabularies (Chat Completions vs Responses), image parts differ per API, and per-model parameter support varies — the tool should forward the request body largely verbatim (with only provider base-URL/auth/endpoint normalization) rather than enforce one universal typed schema. [INFERENCE from synthesized evidence]

---

## Gaps / unverified

- Exact current model catalog and per-model `reasoning_effort` value sets are account/date-dependent; verify against `GET /v1/models` and the live deprecations page at runtime.
- `stream_options.include_obfuscation` semantics are documented only by name in the reference; behavior details unverified.
- `service_tier`, `store`, `parallel_tool_calls`, `verbosity`, `modalities`, `audio`, `prediction` parameter behaviors are partially documented; exact acceptance varies by model/account.
- Whether specific non-OpenAI providers implement `[DONE]`, `include_usage` final chunks, or `reasoning_effort` identically is provider-specific — treat as configurable presets, not fixed facts.
- `o1`/`o3` shutdown dates (2026-10-23) come from community-maintained modelparams.dev and the official deprecations page excerpt; re-verify against the live official page before relying on them.
