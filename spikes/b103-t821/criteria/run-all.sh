#!/usr/bin/env bash
#
# T-821 full acceptance run: shadow-up → criteria 1..5 → shadow-down. A trap
# GUARANTEES teardown (kill shadow procs + all wf-*.service + rm temp) on ANY
# exit, including a timeout/interrupt — zero orphan processes, zero orphan units.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/../harness/_env.sh"

teardown() { bash "$HERE/../harness/shadow-down.sh" || true; }
trap teardown EXIT INT TERM

bash "$HERE/../harness/shadow-up.sh" || { echo "shadow-up failed"; exit 1; }

RC=0
for c in criterion1-success-card criterion2-crash-card criterion3-monitor-crash-safety \
         criterion4-two-monitors criterion5-adversarial-resume; do
  echo; echo "========== $c =========="
  if ! bash "$HERE/$c.sh"; then RC=1; fi
done

echo; echo "========== T-821 run-all result: $([ $RC -eq 0 ] && echo ALL-PASS || echo SOME-FAIL) =========="
exit $RC
