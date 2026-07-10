#!/usr/bin/env bash
#
# T-819 CONSUMER spike orchestrator (§و criteria 4-7). Runs the three offline criteria (no LLM)
# and the one real-LLM criterion (6: >=15 tiny haiku background tasks), then writes the
# machine-readable evidence file spikes/b103-t819/evidence/consumer.json.
#
# All artifacts/claude cwd live under STATE_ROOT in /tmp (never a real project dir). The only
# real quota spent is criterion 6's tiny haiku tasks; criteria 4/5/7 are fully offline.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPIKE_DIR="$(cd "$HERE/.." && pwd)"
export STATE_ROOT="${STATE_ROOT:-$(mktemp -d /tmp/b103-t819-consumer-XXXXXX)}"
CLAUDE_VERSION="$(claude --version 2>/dev/null | head -1)"
CONV_DIR="$SPIKE_DIR/fixtures"

echo "=== T-819 consumer spike — STATE_ROOT=$STATE_ROOT ==="

# 4) delivery idempotency (offline)
bash "$HERE/criterion4-idempotency.sh"
# 5) torn-jsonl dedup + regex negative control (offline, on REAL harvested transcripts)
bash "$HERE/criterion5-torn-jsonl.sh"
# 7) single-owner flock (offline)
bash "$HERE/criterion7-flock.sh"
# 6) supervisor resilience under kill -9 (REAL haiku background tasks)
C6_ROOT="$STATE_ROOT/c6" bash "$HERE/criterion6-supervisor-resilience.sh"

# aggregate → evidence/consumer.json
node "$SPIKE_DIR/lib/aggregate-consumer-evidence.mjs" \
  "$STATE_ROOT/criterion4.json" "$STATE_ROOT/criterion5.json" \
  "$STATE_ROOT/criterion6.json" "$STATE_ROOT/criterion7.json" \
  "$CONV_DIR" "$SPIKE_DIR/evidence/consumer.json" "$STATE_ROOT" "$CLAUDE_VERSION"

# tidy any lingering transient units
systemctl --user reset-failed 'wf-t819-*' 2>/dev/null || true
echo "=== done. evidence: $SPIKE_DIR/evidence/consumer.json ; state: $STATE_ROOT ==="
