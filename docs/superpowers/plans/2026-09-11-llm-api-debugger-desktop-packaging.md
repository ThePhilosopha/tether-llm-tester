# Desktop packaging plan

1. Create a terminal-inspired SVG icon and convert it into a macOS `.icns` bundle with native `sips` and `iconutil`.
2. Invoke the installed Pake CLI against the local debugger URL with the explicit icon, name, and `dist/` output directory.
3. Start the existing local Node service, launch the generated app, and inspect its rendered interface.

No new runtime dependencies or backend changes are required: Pake wraps the local UI while `server.mjs` remains the credential-owning backend.
