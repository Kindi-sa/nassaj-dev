#!/usr/bin/env bash
# T-822 acceptance — full cycle: up → 6 criteria → down (with zero-drift asserts).
# Teardown is guaranteed by trap. Real claude runs are haiku + short (quota-aware).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/../harness/_env.sh"

cleanup() { bash "$HERE/../harness/shadow-down.sh" || true; }
trap cleanup EXIT

bash "$HERE/../harness/shadow-up.sh"

RC=0
for c in criterion1-ondemand-leaf criterion2-chat-lock-concurrent criterion3-untrusted-wrapping \
         criterion4-coalescing-crash criterion5-budget-fallback criterion6-flag-off-identical; do
  echo; echo "========== $c =========="
  bash "$HERE/$c.sh" || RC=1
done
echo; echo "========== run-all done (rc=$RC) =========="
exit $RC
