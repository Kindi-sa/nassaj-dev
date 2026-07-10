#!/usr/bin/env bash
#
# B-103 / T-819 consumer spike — flock(2) single-owner gate for the permanent supervisor
# (§ب-2 boot step, criterion 7). Acquires a NON-BLOCKING flock on supervisor.lock via fd 9,
# then `exec node supervisor.mjs` so the node process INHERITS fd 9 and holds the lock for its
# whole life. The kernel releases the lock on ANY death — including `kill -9` — so a restart
# re-acquires cleanly with no stale lock (this is what makes criterion 6 sound).
#
# A second concurrent instance fails flock -n, prints one quiet line, and exits 0 (criterion 7).
#
# Usage: supervisor-run.sh <lockFile> -- <args passed to lib/supervisor.mjs...>
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPERVISOR="$HERE/../lib/supervisor.mjs"

LOCK="${1:?lockFile required}"; shift
[ "${1:-}" = "--" ] && shift

exec 9>"$LOCK"
# SUPERVISOR_LOCK_WAIT=0 (default) ⇒ pure non-blocking (criterion 7: concurrent ⇒ quiet exit).
# A restarting supervisor may set a small wait to tolerate a lock the kernel is still clearing
# after the previous owner's kill -9 (criterion 6).
if ! flock -w "${SUPERVISOR_LOCK_WAIT:-0}" 9; then
  echo "supervisor[$$]: supervisor.lock held by another instance — exiting quietly"
  exit 0
fi
echo "supervisor[$$]: flock acquired"
exec node "$SUPERVISOR" "$@"
