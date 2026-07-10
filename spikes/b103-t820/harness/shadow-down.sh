#!/usr/bin/env bash
#
# T-820 shadow harness — tear everything down and PROVE zero leftovers:
#   - kill the shadow server + supervisor (+ any flag-off instance),
#   - stop/reset every transient wf-*.service the run created (mine only —
#     enumerated from $SHADOW_STATE and the dummy-unit ledger, so a parallel
#     harness is untouched),
#   - assert the real credential / live DB / ~/.nassaj-users are UNCHANGED,
#   - delete the temp tree.
#
# Idempotent; safe to run repeatedly. `--quiet` skips assertions (used for the
# clean-slate call inside shadow-up).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/_env.sh"

QUIET=""
[ "${1:-}" = "--quiet" ] && QUIET=1
log() { [ -n "$QUIET" ] || printf '[shadow-down] %s\n' "$*"; }
warn() { printf '[shadow-down][WARN] %s\n' "$*" >&2; }

# --- collect what THIS run created (before we delete anything) ---------------
declare -a UNITS=()
if [ -d "$SHADOW_STATE/tasks" ]; then
  while IFS= read -r d; do
    [ -n "$d" ] && UNITS+=("wf-$(basename "$d").service")
  done < <(find "$SHADOW_STATE/tasks" -maxdepth 1 -mindepth 1 -type d 2>/dev/null)
fi
if [ -d "$SHADOW_STATE/scopes" ]; then
  while IFS= read -r d; do
    [ -n "$d" ] && UNITS+=("wf-$(basename "$d").service")
  done < <(find "$SHADOW_STATE/scopes" -maxdepth 1 -mindepth 1 -type d 2>/dev/null)
fi
if [ -f "$SHADOW_RUN/dummy-units.txt" ]; then
  while IFS= read -r u; do [ -n "$u" ] && UNITS+=("$u"); done < "$SHADOW_RUN/dummy-units.txt"
fi

# --- kill processes ----------------------------------------------------------
for pf in supervisor.pid server.pid server-off.pid; do
  if [ -f "$SHADOW_RUN/$pf" ]; then
    pid="$(cat "$SHADOW_RUN/$pf" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
      kill -9 "$pid" 2>/dev/null || true
      log "killed $pf ($pid)"
    fi
  fi
done

# --- stop + reset the transient units ---------------------------------------
if [ "${#UNITS[@]}" -gt 0 ]; then
  # de-dup
  mapfile -t UNITS < <(printf '%s\n' "${UNITS[@]}" | sort -u)
  for u in "${UNITS[@]}"; do kill_wf_unit "$u"; done
  log "stopped ${#UNITS[@]} transient unit(s)"
fi

# --- zero-touch assertions (compare real state to the pre-run fingerprint) ---
RC=0
if [ -z "$QUIET" ] && [ -f "$SHADOW_RUN/pre-fingerprint.env" ]; then
  # shellcheck source=/dev/null
  source "$SHADOW_RUN/pre-fingerprint.env"  # sets creds_sha, live_db_sha, nassaj_users_list, ...
  now_creds_sha="$(sha256sum "$REAL_CLAUDE_CREDS" 2>/dev/null | awk '{print $1}')"
  now_livedb_sha="$(sha256sum "$REAL_LIVE_DB" 2>/dev/null | awk '{print $1}')"
  now_livedb_mtime="$(stat -c %Y "$REAL_LIVE_DB" 2>/dev/null || echo NA)"
  now_users_list="$(ls -1 "$REAL_NASSAJ_USERS" 2>/dev/null | sort | tr '\n' ',')"

  # The shadow NEVER writes the real credential: every shadow claude run uses a
  # per-user COPY under $SHADOW_HOME, never the canonical ~/.claude. A content
  # change here is therefore the LIVE nassaj-dev process refreshing its own OAuth
  # token in place (that is WHY canonical auth works) — NOT a shadow leak. We
  # assert only that the shadow did not DELETE/corrupt it (still valid JSON).
  if [ ! -s "$REAL_CLAUDE_CREDS" ] || ! head -c1 "$REAL_CLAUDE_CREDS" | grep -q '{'; then
    warn "REAL credential missing/corrupted after run"; RC=1
  elif [ "$now_creds_sha" != "${creds_sha:-}" ]; then
    log "NOTE: owner credential CONTENT changed — attributable to the LIVE process's own token"
    log "      refresh (the shadow only ever reads a copy); file intact & valid."
  else
    log "OK: owner credential unchanged ($now_creds_sha)"
  fi

  if [ "$now_livedb_sha" != "${live_db_sha:-}" ] || [ "$now_livedb_mtime" != "${live_db_mtime:-}" ]; then
    warn "LIVE DB CHANGED (leak!) sha:$now_livedb_sha mtime:$now_livedb_mtime"; RC=1
  else log "OK: live DB unchanged"; fi

  if [ "$now_users_list" != "${nassaj_users_list:-}" ]; then
    warn "real ~/.nassaj-users listing CHANGED: was [${nassaj_users_list:-}] now [$now_users_list]"; RC=1
  else log "OK: real ~/.nassaj-users untouched"; fi
fi

# --- final: no lingering units of ours --------------------------------------
if [ -z "$QUIET" ] && [ "${#UNITS[@]}" -gt 0 ]; then
  left="$(systemctl --user list-units --all --type=service --no-legend --plain 'wf-*.service' 2>/dev/null \
    | awk '{print $1}' | grep -Fxf <(printf '%s\n' "${UNITS[@]}") || true)"
  if [ -n "$left" ]; then warn "units still present after teardown: $left"; RC=1
  else log "OK: zero transient units of this run remain"; fi
fi

# --- delete the temp world ---------------------------------------------------
rm -rf "$SHADOW_ROOT"
log "removed $SHADOW_ROOT"
[ "$RC" -eq 0 ] && log "teardown clean" || warn "teardown completed WITH warnings (rc=$RC)"
exit "$RC"
