# Changelog

## 0.4.0

- Fix (complete): deleted sessions no longer reappear in the workspace sidebar, in any client. Root cause beyond 0.3.0's live-session case: client sidebars render rows from an in-memory list store that only prunes on `host/session-removed` (live disposals only) or a fresh `session.list` baseline — forgetting a deleted cold session's archive id broadcast `archived-sessions-changed` and resurrected the stale row in every connected client
- Delete / purge / purge-all now always keep the archive-set entry during runtime (`keptHidden`); a ghost id without a list row renders nothing in the official UI, so keeping it is free. Ghosts are reconciled once at Host restart (plugin mount), when every client rebuilds from a fresh baseline and un-archiving can resurrect nothing
- `/list` no longer reconciles ghosts during runtime (that broadcast was itself a resurrection trigger for long-lived clients)
- The acting client now pulls a fresh `session.list` baseline after deletes and restores (`sessions.refresh()`, capability-detected), pruning its own stale rows immediately

## 0.3.0

- Fix: deleting an archived session that is still attached in memory ("打开中") no longer makes it reappear in the workspace sidebar — the Host serves live sessions from memory regardless of disk state, so the archive-set entry is now deliberately kept (`keptHidden`) to hold the session hidden; the leftover id is reconciled automatically once the session is no longer live (e.g. after a Host restart)
- The same live-aware keep-hidden rule now applies to trash purge / purge-all and to the `/list` ghost reconcile (which no longer strips archive entries belonging to live sessions)
- Delete responses carry `keptHidden`; the UI notice explains when a deleted session stays hidden until restart
- UI: batch "删除所选" now uses the same two-step arm-and-confirm as single delete and trash purge (auto-disarms on selection change / tab switch); delete buttons carry explanatory tooltips; the Archived tab shows a contextual hint when live sessions are present

## 0.2.3

- Reconcile historical `archivedSessionIds` ghosts on `/list`: ids present in `workspace.json` but missing from the on-disk session inventory are removed best-effort

## 0.2.2

- Clear `workspace.json` `global.archivedSessionIds` ghosts after delete / purge so official archive counts do not keep deleted sessions (best-effort when the registry state machine is available)

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
