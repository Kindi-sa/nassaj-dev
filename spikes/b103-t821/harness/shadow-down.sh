#!/usr/bin/env bash
#
# T-821 shadow harness teardown — kill the shadow server + supervisor (by pidfile),
# stop EVERY wf-*.service (zero orphan units), assert zero real-state drift
# (owner credential + live DB unchanged), then delete the temp tree. Idempotent;
# `--quiet` suppresses the (verbose) drift report for the pre-run clean slate.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/_env.sh"

QUIET=""; [ "${1:-}" = "--quiet" ] && QUIET=1
log() { [ -n "$QUIET" ] || printf '[shadow-down] %s\n' "$*"; }

kill_pidfile() { # <pidfile>
  local f="$1"
  [ -f "$f" ] || return 0
  local pid; pid="$(cat "$f" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$f"
}

# Also sweep any extra supervisor pids the crash-safety criterion spawned.
if [ -d "$SHADOW_RUN" ]; then
  for f in "$SHADOW_RUN"/supervisor*.pid "$SHADOW_RUN"/server.pid; do
    [ -e "$f" ] && kill_pidfile "$f"
  done
fi

kill_all_wf_units
log "stopped shadow processes + all wf-*.service units"

# zero-touch drift report (only when not the pre-run clean slate).
if [ -z "$QUIET" ] && [ -f "$SHADOW_RUN/pre-fingerprint.env" ]; then
  # shellcheck source=/dev/null
  source "$SHADOW_RUN/pre-fingerprint.env"
  now_creds_sha="$(sha256sum "$REAL_CLAUDE_CREDS" 2>/dev/null | awk '{print $1}')"
  now_db_sha="$(sha256sum "$REAL_LIVE_DB" 2>/dev/null | awk '{print $1}')"
  now_users="$(ls -1 "$REAL_NASSAJ_USERS" 2>/dev/null | sort | tr '\n' ',')"
  [ "$now_creds_sha" = "$creds_sha" ] && log "OK: owner credential UNCHANGED" \
    || log "WARN: owner credential CHANGED ($creds_sha → $now_creds_sha)"
  [ "$now_db_sha" = "$live_db_sha" ] && log "OK: live DB UNCHANGED" \
    || log "WARN: live DB CHANGED"
  [ "$now_users" = "$nassaj_users_list" ] && log "OK: ~/.nassaj-users listing UNCHANGED (no new user dirs)" \
    || log "NOTE: ~/.nassaj-users listing changed ($nassaj_users_list → $now_users)"
  log "NOTE: temp-cwd transcripts under $REAL_SHARED_PROJECTS are the documented soak leftover"
fi

rm -rf "$SHADOW_ROOT"
log "removed $SHADOW_ROOT — teardown complete"
