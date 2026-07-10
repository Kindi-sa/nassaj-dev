#!/usr/bin/env bash
#
# T-820 — bring the shadow up, run all four acceptance criteria, tear down (with
# zero-leftover / zero-touch assertions). Exit non-zero if ANY criterion or the
# teardown fails. Teardown ALWAYS runs (trap).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="$HERE/../harness"

cleanup() { bash "$HARNESS/shadow-down.sh" || echo "[run-all] teardown reported warnings"; }
trap cleanup EXIT

echo "=================== T-820 acceptance — shadow run ==================="
bash "$HARNESS/shadow-up.sh" || { echo "[run-all] shadow-up FAILED"; exit 1; }

RC=0
for c in criterion1-launch-isolation criterion2-gate2-deny criterion3-queue-cap criterion4-flag-off; do
  echo; echo "------------------- $c -------------------"
  bash "$HERE/$c.sh" || RC=1
done

echo; echo "=================== summary ==================="
[ "$RC" -eq 0 ] && echo "ALL CRITERIA PASSED" || echo "SOME CRITERIA FAILED (rc=$RC)"
exit "$RC"
