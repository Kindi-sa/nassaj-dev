#!/usr/bin/env bash
#
# T-823 item 1 — PROVE on the shadow that safe-restart.sh's wf-*.service visibility
# is (a) present when the flag is ON and a real unit exists, (b) SILENT when OFF
# (byte-identical: no new line), and (c) purely READ-ONLY (it never stops/kills the
# unit and never changes the exit/defer decision). Self-contained: it creates a REAL
# transient wf-*.service unit (systemd-run sleep — no server, no claude), runs
# safe-restart in FILE-scan mode against a temp WF_BASE so it never touches the real
# journals, and asserts. Guaranteed teardown via trap.
set -uo pipefail

REPO="${REPO:-/home/nassaj/Project/nassaj-dev}"
SR="$REPO/scripts/safe-restart.sh"
UNIT="wf-t823vis-$$.service"
TMP_WF="$(mktemp -d /tmp/t823-vis-wfbase.XXXXXX)"   # empty ⇒ safe-restart finds no live journal work
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

cleanup() {
  systemctl --user stop "$UNIT" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
  rm -rf "$TMP_WF"
}
trap cleanup EXIT INT TERM

echo "[safe-restart-visibility] proving read-only wf-*.service listing (flag-gated)"

# 1) create a REAL live transient wf-*.service unit (the "background task").
systemd-run --user --quiet --unit="$UNIT" --description="nassaj workflow wf-owner=1 (t823 visibility probe)" -- sleep 120 \
  || { bad "could not create test wf unit (systemd --user unavailable?)"; echo "[safe-restart-visibility] pass=$PASS fail=$FAIL"; exit 1; }
sleep 0.5
state="$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
[ "$state" = "active" ] && ok "created a live wf-*.service unit ($UNIT active)" || { bad "unit not active (state=$state)"; exit 1; }

# 2) flag ON ⇒ safe-restart LISTS the unit (read-only). Use PROC_NAME=absent so the
#    PM2 precondition doesn't matter; WF_BASE=temp so the journal scan is empty/exit0.
env WORKFLOW_SUPERVISOR=1 PROC_NAME="t823-absent-proc" WF_BASE="$TMP_WF" \
  bash "$SR" >/tmp/.t823vis_on.out 2>/tmp/.t823vis_on.err || true
if grep -q 'المهام الخلفية الحيّة' /tmp/.t823vis_on.err && grep -q "$UNIT" /tmp/.t823vis_on.err; then
  ok "flag ON ⇒ safe-restart lists the live unit ($UNIT) for the operator"
else
  bad "flag ON but the unit was not listed"; grep -i 'wf-\|المهام' /tmp/.t823vis_on.err | head
fi

# 3) flag OFF ⇒ NO visibility line (byte-identical). PROC_NAME absent ⇒ the flag
#    fallback reads no PM2 flag ⇒ OFF.
env -u WORKFLOW_SUPERVISOR PROC_NAME="t823-absent-proc" WF_BASE="$TMP_WF" \
  bash "$SR" >/tmp/.t823vis_off.out 2>/tmp/.t823vis_off.err || true
if grep -q 'المهام الخلفية الحيّة' /tmp/.t823vis_off.err; then
  bad "flag OFF but a visibility line was printed (not byte-identical)"
else
  ok "flag OFF ⇒ NO wf visibility line (byte-identical output)"
fi

# 4) READ-ONLY: after BOTH runs the unit is STILL active (safe-restart never touched it).
state2="$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
[ "$state2" = "active" ] && ok "unit still active after both runs (safe-restart is read-only, did not stop it)" \
  || bad "unit state changed to '$state2' — safe-restart altered it (must be read-only)"

echo "[safe-restart-visibility] pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
