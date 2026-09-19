---
name: opencode-channel-db
description: Use when opencode chats/sessions look missing after a channel switch, or when merging dev and prod SQLite data. Covers channel DB resolution, dev-to-prod merge, and folder-scoped session visibility.
---

# Opencode channel DB

## Rule

One `OPENCODE_CHANNEL` means one SQLite file. The app never unions channel DBs at runtime, so cross-channel chats only appear after a one-time merge plus opening the owning folder.

## Procedure

1. Identify the active DB before touching data.
   - Resolution lives in `packages/core/src/database/database.ts:path()`: `Flag.OPENCODE_DB` (`packages/core/src/flag/flag.ts`) wins, else `prod/beta/latest` use `opencode.db`, any other `InstallationChannel` (`packages/core/src/installation/version.ts`) uses `opencode-<channel>.db` under `Global.Path.data` (`~/.local/share/opencode`).
   - Compare inventories first:
     `sqlite3 ~/.local/share/opencode/opencode.db "select count(*) from session;"`
     `sqlite3 ~/.local/share/opencode/opencode-dev.db "select count(*) from session;"`
   - Find truly missing rows by PK, not by totals (same session id can exist in both with divergent edits):
     `sqlite3 ~/.local/share/opencode/opencode.db "ATTACH DATABASE '$HOME/.local/share/opencode/opencode-dev.db' AS src; SELECT count(*) FROM src.session s WHERE NOT EXISTS (SELECT 1 FROM main.session m WHERE m.id = s.id);"`
2. Merge dev into prod with the checked-in executable (idempotent, re-runnable).
   - Run altogether: `./script/merge-dev-to-prod.sh` (quit opencode first; `--force` only for a live-WAL diagnostic run).
   - The script checkpoints WAL, writes timestamped backups (`opencode.db.bak-*`), copies in FK order (`project`, `project_directory`, `permission`, `workspace`, `session`, `message`, `part`, `todo`, `session_input`, `session_message`, `session_context_epoch`, `session_share`, `event_sequence`, `event`) with `INSERT OR IGNORE`, repairs `event_sequence.seq` to `MAX(event.seq)` per aggregate, bumps `session.time_updated` where dev is newer, then runs `PRAGMA foreign_key_check`.
3. Make merged chats visible by opening their folders.
   - Until the folders are added, chats are not being shown within them: `Session.list` in `packages/opencode/src/session/session.ts` delegates to `listByProject`, which always constrains on `session.project_id = ctx.project.id` plus optional `directory`/`path`/`workspace_id`. Unfiltered listing exists only via `Session.listGlobal` with an explicit `directory` filter.
   - After merging, open/add each owning worktree directory in opencode so its `project` resolves and its sessions pass the filter. Verify per directory with `session.list({ directory })` or the global list filtered by that directory.

## Pitfalls

- Treat "no changes" as a result, not a failure: identical PKs across channels mean the merge is already complete, since `INSERT OR IGNORE` skips existing ids.
- Never merge while opencode is writing: a live WAL drifts `message`/`part`/`event` counts between the before/after report, so quit the app before the real run.
- Compare by PK per table, never by `count(*)`: `todo` keys on `(session_id, position)`, `session_context_epoch` and `session_share` on `session_id`, `event_sequence` on `aggregate_id`; only the id-keyed tables compare on `id`.
- Leave divergent `event` leftovers alone: same-aggregate histories can collide on the `(aggregate_id, seq)` unique index, so the survivors stay ignored and chats are unaffected.
- Preserve `event_sequence.owner_id` on repair: update `seq` in place instead of `INSERT OR REPLACE`, which would null the owner.
