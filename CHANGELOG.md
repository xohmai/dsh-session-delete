# Changelog

## 0.6.0

- Fix (#5): deleting a session now cascades. Subagent sessions are durable independent persisted entries (their headers carry a validated `parentSession` SessionId), and deleting a parent used to leave them behind as unreachable orphans on disk — not in the trash, not in `audit.log`, invisible in the UI. `deleteSession()` now builds a parent→children index from the persisted headers and BFS-collects the whole descendant tree (sub-subagents included), running each child through the same archive → locate → rename → meta.json → audit pipeline as the root. Child `meta.json` records `cascadeOf` (the root id that dragged it in) plus its own `parentSession`/`origin`
- Cascade safety: running descendants are skipped (reported in the response as `cascade.skippedRunning` and in the notice, not silently orphaned-and-forgotten); a failing child is recorded in `cascade.failed` without rolling back the rest; the root itself still hard-rejects with 409 RUNNING. `POST /delete` accepts `cascade: false` to fall back to the old delete-exactly-this-id behavior; the default is on
- Cascade restore: restoring a trash entry also restores every entry whose `cascadeOf` points at it, so restoring the main session brings its subagent sessions back in one step (restoring a child alone keeps working; old entries without `cascadeOf` behave exactly as before)
- Audit (#5): every cascaded child gets its own `delete` audit line carrying `cascadeOf`, plus a `delete-cascade` summary line (root / deleted ids / skipped-running ids) and a matching `restore-cascade` line; `purge-all` now logs the ids of every purged entry instead of a bare count
- Orphan cleanup path for pre-0.6.0 leftovers: `/list` and `/list-stream` rows now carry `parentSession`, `subagents` (transitive descendant count) and `orphan` (parent no longer on disk). The All-sessions tab shows a 子会话 ×N badge on parents (delete cascades into them) and an 孤儿 tag + `孤儿 (N)` filter button so leftover orphans from earlier deletes can be selected and removed in two clicks. The plugin deliberately never auto-deletes anything at startup
- Titles for the root and all doomed children are resolved in one batched `readTitleSnapshots` call before the cascade loop starts (per-session calls re-scan the whole persistence listing — the quadratic trap 0.5.0 fixed for /list would have come back for 200-child cascades)
- `GET /preview` now returns `descendants` (all transitive child ids) so callers can warn before deleting; `/delete` responses carry `cascade: { deleted, skippedRunning, failed }`; trash listings expose `origin`/`cascadeOf`, and subagent rows in the trash tab are tagged 子代理

## 0.5.1

- Fix (PR #4): deleting a session now broadcasts `api-session/removed` to every connected client, so sidebar rows are pruned immediately everywhere — previously only the acting client refreshed its list, leaving stale rows in other clients that failed with `session/not-found` when opened. Verified end-to-end against DSH source before merging: the event is whitelisted in `dsh-api-remotes`' forwarded-event registry (cordis emits from plugin contexts reach it the same way `plugin-market/changed` does), and the client's `handleSessionRemoved` is no-op-safe for cold, non-resident sessions while still recording the store removal. Double emission when the host later disposes a live session is idempotent
- Fix (PR #4): restoring from trash broadcasts `api-session/added` with a minimal summary so the row reappears in connected clients without waiting for a baseline refresh; the summary now carries `formatStatus: "current"` like the host's own `summaryFor` (follow-up to the PR)
- Prefer the public `workspaceRegistry.unarchiveSession()` on current DSH (same serial queue and persistence as `archiveSession`); the internal state-machine path stays as the legacy fallback (≤0.1.1-rc.x) and capability detection is unchanged
- Tests: emit assertions for the delete/restore broadcasts; the smoke stub now encodes session-directory names the same way the core does, fixing the Windows-only mkdir failures the PR author reported (raw `:` from IM ids is not a legal directory name on NTFS)
- Known edge (core semantics, not a bug): official clients treat `origin === "subagent"` rows as durable — `api-session/removed` only marks them not-running; such rows disappear on the client's next list refresh

## 0.5.0

- New: streaming session list with real progress. A new `GET /api/session-delete/list-stream` route emits NDJSON — a `meta` line first (total count, workspaces, unarchive capability) so the total is known immediately, then one line per session as soon as it is computed, then `done`. The client switches to this route and shows a live "已加载 N / M 个会话" counter instead of a bare wait; rows render once, sorted by `mtimeMs` (same order as before, no reshuffle flicker). The old one-shot `/list` route stays for compatibility and tests
- UI: first-load transitions are now centered horizontally and vertically in the scroll area (spinner + label + live counter); the trash tab gets the same centered spinner without a counter (its endpoint is millisecond-fast). Reloads with existing data stay silent (old list remains usable, ↻ spins)
- Perf (critical): titles no longer decompress session logs one-by-one. Two compounding costs were removed — `readTitleSnapshots` re-scans the whole persistence listing on every call, so per-session calls were quadratic (520 sessions: 60s+ and still incomplete), and every session paid a full zstd decompress. Titles now resolve in one batched pass: cold sessions hit the `sessionProjectionCache` `title` row first (zero I/O, same source the sidebar's `session.list` serves and prewarms; identity-witnessed so it can never cross sessions; seeded headers follow the official predecessor probe), and only actual misses go through one batched `readTitleSnapshots` call (its internal concurrency pool decompresses in parallel). Live sessions keep reading in-memory titles. Measured on 520 sessions / 401 MB of logs: the stat+readdir pass is ~50 ms, versus 60s+ before
- Perf: record computation runs as three phases (parallel stat precheck → batched title resolve → 16-way row pool); mtime-keyed record cache hits skip title resolution and dir sizing entirely, so repeat loads are stat-only
- Fix (perf): `locate()` returns the *current-generation* log path (e.g. `session.v3.jsonl.zstd`), which does not exist for not-yet-migrated old-format sessions (v0 keeps the plain `session.jsonl.zstd` name) — the mtime record cache could never warm for them and every reload recomputed everything (measured 8s steady on 520 sessions). The precheck now falls back to scanning the session directory for the highest-generation log actually present
- UI: switching tabs no longer refetches on every entry — data loads once when absent and is kept in sync by the post-action refreshes (delete/restore/purge already reload); the ↻ button remains for a manual refresh
- Diagnostics: the `done` line of `/list-stream` now carries per-phase timings (`inventoryMs`/`prepMs`/`titleMs`/`rowMs`) and title-source counts (recordCache/snapshot/predecessor/batched), which pinpointed both regressions above
- Fix (IM channels, #3): sessions from IM channels (`dsh-im-connect`, ids like `im:weixin_…@im.wechat` containing `:`/`@`/`_`/`.`) could neither be deleted, restored, nor unarchived. Two layers: the id whitelist rejected them with 400 before any logic ran, and — once widened — the raw id embedded in the trash entry name made `mkdir` fail with ENOENT on Windows (`:` is a reserved character). Per the core contract (`SessionId` is an *unvalidated* branded string that "MUST be encoded before use in a path"), the whitelist now only guards against injection (`[A-Za-z0-9._:@~-]{8,200}`, still no `/`/`\`/whitespace) and entry names escape the id through the same `~XXXX` scheme the core's own `encodeSegment` uses (verbatim-aligned; `:`→`~003A`, `@`→`~0040`). `ENTRY_RE` is tightened to exactly the escape output charset (contains `~`, never `:`/`@` — entry names become real directories), restore/purge keep taking ids from `meta.json` (never reverse-parsing entry names), and ids whose escaped entry would overflow the entry whitelist are rejected *before* any mutation, preserving the invariant that every trashed entry stays restorable. Full IM-id pipeline covered by tests: preview → delete → trash → restore → purge

## 0.4.1

- Fix (compat): DSH 0.1.5 changed `sessionPersistence.list()` to return `{ header, revision, sizeBytes }` snapshots instead of bare header arrays; the wrapper flowed into `locate()` and crashed every `/api/session-delete/list` and `/trash` request with "Cannot read properties of undefined (reading 'length')" (inside `encodeSegment(undefined)`). Both call sites now unwrap snapshots via a compat helper (`item.header ?? item`, same unwrap the official session-query uses), so both the new and the legacy (≤0.1.1-rc.x) shapes work
- Dev: `react`/`react-dom` 18.3.1 as devDependencies — DSH 0.1.5 no longer ships react in its node_modules, so the render smoke tests resolve it from the plugin's own dev install
- Tests: smoke stub now models the 0.1.5+ snapshot shape by default; a dedicated test keeps the legacy bare-header shape covered

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
