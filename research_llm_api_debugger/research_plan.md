# Research Plan: Lightweight OpenAI-Compatible API Debugger

## Main question

What is the smallest local architecture that can safely store provider configuration, exercise OpenAI-compatible chat and model APIs, expose exact request and streaming response data, and control a local Ollama installation on macOS?

## Subtopics

1. **OpenAI-compatible request lifecycle**
   - Current `/v1/chat/completions` request, non-streaming response, streaming SSE chunks, tool calls, image inputs, and reasoning controls.
   - Compatibility differences that require pass-through request editing rather than one universal typed schema.

2. **Ollama local controls**
   - Current local host/port, OpenAI-compatible routes, native model-management routes, CLI commands, streaming format, and which settings require process environment or restart.
   - macOS-specific boundaries for launching and configuring Ollama without shell injection.

3. **Named providers and local security**
   - Official base URLs, authentication headers, model-list behavior, and documented capability metadata for Ollama, 9Router, Poolside, OpenRouter, OpenCode Go, OpenCode Zen, and Clinepass.
   - Safe local JSON persistence, file permissions, browser-origin risks, and a minimal process boundary that prevents keys from reaching unintended hosts.

## Synthesis

Cross-check provider claims against official documentation where available. Mark unverified or account-specific URLs as configurable presets rather than fixed facts. Convert findings into a technical specification, wireframe, local state schema, endpoint matrix, risk register, and dependency-ordered implementation roadmap. No application code will be written.