#!/usr/bin/env bash
#
# T-822 shadow teardown — kill any leftover driver pids, assert ZERO real-state
# drift (owner credential + live DB unchanged, no new user dirs, real ~/.claude/
# projects count unchanged — the minimal-config design writes transcripts only to
# temp), then delete the temp tree. Idempotent; --quiet for the pre-run slate.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/_env.sh"

QUIET=""; [ "${1:-}" = "--quiet" ] && QUIET=1
log() { [ -n "$QUIET" ] || printf '[t822-down] %s\n' "$*"; }

# kill any pidfiles a criterion left (background injectors / live turns).
if [ -d "$SHADOW_RUN" ]; then
  for f in "$SHADOW_RUN"/*.pid; do
    [ -e "$f" ] || continue
    pid="$(cat "$f" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$f"
  done
fi

if [ -z "$QUIET" ] && [ -f "$SHADOW_RUN/pre-fingerprint.env" ]; then
  # shellcheck source=/dev/null
  source "$SHADOW_RUN/pre-fingerprint.env"
  now_creds="$(sha256sum "$REAL_CLAUDE_CREDS" 2>/dev/null | awk '{print $1}')"
  now_db="$(sha256sum "$REAL_LIVE_DB" 2>/dev/null | awk '{print $1}')"
  now_users="$(ls -1 "$REAL_NASSAJ_USERS" 2>/dev/null | sort | tr '\n' ',')"
  now_realproj="$(find "$REAL_OWNER_CLAUDE/projects" -name '*.jsonl' 2>/dev/null | wc -l)"
  [ "$now_creds" = "$creds_sha" ] && log "OK: owner credential UNCHANGED" || log "WARN: owner credential CHANGED"
  [ "$now_db" = "$live_db_sha" ] && log "OK: live DB UNCHANGED" || log "WARN: live DB CHANGED"
  [ "$now_users" = "$users_list" ] && log "OK: ~/.nassaj-users listing UNCHANGED" || log "NOTE: user listing changed"
  [ "$now_realproj" = "$real_projects_count" ] && log "OK: real ~/.claude/projects UNCHANGED (transcripts stayed in temp)" || log "WARN: real projects changed ($real_projects_count → $now_realproj)"
fi

rm -rf "$SHADOW_ROOT"
log "removed $SHADOW_ROOT — teardown complete"
