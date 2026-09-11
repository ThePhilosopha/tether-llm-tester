# LLM API Debugger desktop packaging design

## Objective

Package the existing local browser workbench as a macOS `.app` using Pake, with a custom Dock icon.

## Chosen visual direction

**Terminal inspired.** The icon is a dark rounded square with a minimal blue terminal prompt and output cursor. It remains legible at Dock sizes and aligns with the debugger's restrained dark interface.

## Runtime model

Pake is a webview wrapper, not a Node server bundler. The packaged app opens the existing local service at `http://127.0.0.1:8787`; the service must be running with `npm start`. This is intentional so all request proxying, key storage, origin validation, and Ollama controls remain in the already-reviewed Node backend.

## Artifact

- Source icon: `assets/llm-api-debugger-icon.svg`
- macOS icon bundle: `assets/llm-api-debugger-icon.icns`
- Packaged application: `dist/LLM API Debugger.app`
- Pake command: `pake http://127.0.0.1:8787 --name "LLM API Debugger" --icon ./assets/llm-api-debugger-icon.icns --output ./dist`

## Verification

Launch the local service, open the packaged app, and verify that the Chat, Models, and Ollama tabs load under the custom application name and icon.
