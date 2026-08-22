# Changelog

## 0.2.1

- Accept bare-UUID and `<id>-session-<uuid>` session ids in the host ID whitelist so continuable / configured subagent sessions can be previewed, deleted, and restored (thanks @xi146)
- Make `test/render.mjs` resolve `react` / `react-dom` from the local DSH install instead of a hard-coded Linux global path

## 0.2.0

- Online unarchive: restore from the Archived tab returns the session to the sidebar immediately; trash restore also unarchives automatically
- Older DSH builds without the registry state machine fall back to the offline `tools/unhide.mjs` guidance
- Trash entries show session titles (captured into `meta.json` on delete) with multi-select batch restore / purge
- Stronger selection styling and unified `.sd-check` checkbox size across group headers and rows
- Security and quality: trash entry path traversal guards, audit-log protection, 400 for malformed JSON, per-domain UI loading states

## 0.1.0

- Settings-page session manager with Archived / All / Trash tabs
- Soft-delete into `~/.dsh/trash/sessions/` with restore and purge
- Running-session guard and CSRF header on mutating routes
- `tools/unhide.mjs` to remove restored ids from the archive set while DSH is stopped
