# Security notes

- All mutating HTTP routes require the custom header `x-dsh-plugin: session-delete` and bind to the local DSH web server (no CORS preflight answers).
- Session ids and trash entry names are validated against strict allowlists before any filesystem operation.
- Running sessions are refused (`409 RUNNING`); delete archives first, then moves data under `~/.dsh/trash/sessions/`.
- `tools/unhide.mjs` edits `storages/workspace.json` and must only be run while DSH is stopped.
- Please report security issues privately via GitHub Security Advisories on this repository.
