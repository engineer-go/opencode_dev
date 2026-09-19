#!/bin/bash
# Merge opencode-dev.db (dev channel) into opencode.db (prod channel) so a
# prod-mimicking build sees all chats. Safe to re-run: uses INSERT OR IGNORE.
set -euo pipefail

DATA="$HOME/.local/share/opencode"
PROD="$DATA/opencode.db"
DEV="$DATA/opencode-dev.db"
TS="$(date +%Y%m%d-%H%M%S)"

if [ ! -f "$PROD" ]; then echo "missing prod DB: $PROD"; exit 1; fi
if [ ! -f "$DEV" ]; then echo "missing dev DB: $DEV"; exit 1; fi

echo "== quit opencode first if running (WAL must be quiet) =="
if pgrep -x opencode >/dev/null 2>&1 || pgrep -xf "opencode serve" >/dev/null 2>&1; then
  if [ "${1:-}" != "--force" ]; then
    echo "ABORT: opencode is running. Quit it first (or re-run with --force); live WAL writes skew counts."
    exit 2
  fi
  echo "WARNING: opencode running + --force: counts may drift from live writes."
fi

echo "== checkpoint WAL =="
sqlite3 "$PROD" "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 "$DEV" "PRAGMA wal_checkpoint(TRUNCATE);"

echo "== backup =="
cp "$PROD" "$PROD.bak-$TS"
cp "$DEV" "$DEV.bak-$TS"
echo "backups: $PROD.bak-$TS / $DEV.bak-$TS"

dev_only() {
  # $1 = table, $2 = anti-join condition on s (src) / m (main)
  sqlite3 "$PROD" "ATTACH DATABASE '$DEV' AS src; SELECT count(*) FROM src.\"$1\" s WHERE NOT EXISTS (SELECT 1 FROM main.\"$1\" m WHERE $2);"
}

report_dev_only() {
  printf "%-22s %s\n" "project" "$(dev_only project 'm.id = s.id')"
  printf "%-22s %s\n" "session" "$(dev_only session 'm.id = s.id')"
  printf "%-22s %s\n" "message" "$(dev_only message 'm.id = s.id')"
  printf "%-22s %s\n" "part" "$(dev_only part 'm.id = s.id')"
  printf "%-22s %s\n" "todo" "$(dev_only todo 'm.session_id = s.session_id AND m.position = s.position')"
  printf "%-22s %s\n" "session_input" "$(dev_only session_input 'm.id = s.id')"
  printf "%-22s %s\n" "session_message" "$(dev_only session_message 'm.id = s.id')"
  printf "%-22s %s\n" "session_context_epoch" "$(dev_only session_context_epoch 'm.session_id = s.session_id')"
  printf "%-22s %s\n" "session_share" "$(dev_only session_share 'm.session_id = s.session_id')"
  printf "%-22s %s\n" "event" "$(dev_only event 'm.id = s.id')"
}

echo "== dev-only rows BEFORE (by PK) =="
report_dev_only

echo "== merge dev -> prod (INSERT OR IGNORE, FK order) =="
sqlite3 "$PROD" <<SQL
PRAGMA foreign_keys=OFF;
ATTACH DATABASE '$DEV' AS src;
INSERT OR IGNORE INTO project SELECT * FROM src.project;
INSERT OR IGNORE INTO project_directory SELECT * FROM src.project_directory;
INSERT OR IGNORE INTO permission SELECT * FROM src.permission;
INSERT OR IGNORE INTO workspace SELECT * FROM src.workspace;
INSERT OR IGNORE INTO session SELECT * FROM src.session;
INSERT OR IGNORE INTO message SELECT * FROM src.message;
INSERT OR IGNORE INTO part SELECT * FROM src.part;
INSERT OR IGNORE INTO todo SELECT * FROM src.todo;
INSERT OR IGNORE INTO session_input SELECT * FROM src.session_input;
INSERT OR IGNORE INTO session_message SELECT * FROM src.session_message;
INSERT OR IGNORE INTO session_context_epoch SELECT * FROM src.session_context_epoch;
INSERT OR IGNORE INTO session_share SELECT * FROM src.session_share;
INSERT OR IGNORE INTO event_sequence SELECT * FROM src.event_sequence;
INSERT OR IGNORE INTO event SELECT * FROM src.event;
-- repair event_sequence: keep max seq per aggregate, preserve owner_id
UPDATE event_sequence SET seq = (
  SELECT MAX(e.seq) FROM event e WHERE e.aggregate_id = event_sequence.aggregate_id
) WHERE EXISTS (
  SELECT 1 FROM event e WHERE e.aggregate_id = event_sequence.aggregate_id AND e.seq > event_sequence.seq
);
-- surface merged sessions: bump time_updated where dev is newer
UPDATE session SET time_updated = (
  SELECT s.time_updated FROM src.session s WHERE s.id = session.id
) WHERE EXISTS (
  SELECT 1 FROM src.session s WHERE s.id = session.id AND s.time_updated > session.time_updated
);
DETACH src;
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
SQL

echo "== checkpoint after =="
sqlite3 "$PROD" "PRAGMA wal_checkpoint(TRUNCATE);"

echo "== dev-only rows AFTER (chat tables should be 0) =="
report_dev_only
echo "(note: event histories can diverge on (aggregate_id,seq); colliding seqs stay ignored)"

echo "== counts prod now =="
for t in project session message part event; do
  printf "%-10s %s\n" "$t" "$(sqlite3 "$PROD" "SELECT count(*) FROM \"$t\";")"
done

echo "done. restart opencode."
