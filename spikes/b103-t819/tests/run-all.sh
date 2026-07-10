#!/usr/bin/env bash
#
# T-819 producer spike orchestrator. Runs the three criteria on REAL claude output,
# harvests real fixtures into the committed fixtures dir, and writes the machine-readable
# evidence file spikes/b103-t819/evidence/producer.json.
#
# All claude cwd/artifacts live under STATE_ROOT in /tmp (never a real project dir).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPIKE_DIR="$(cd "$HERE/.." && pwd)"
export STATE_ROOT="${STATE_ROOT:-$(mktemp -d /tmp/b103-t819-all-XXXXXX)}"
REPO_FIXTURES="$SPIKE_DIR/fixtures"
CLAUDE_VERSION="$(claude --version 2>/dev/null | head -1)"

echo "=== T-819 producer spike — STATE_ROOT=$STATE_ROOT ==="

# 1) classification (real runs) — harvests real stdout into $STATE_ROOT/fixtures
FIX_SRC="$STATE_ROOT/fixtures" bash "$HERE/criterion1-classify.sh"

# publish harvested REAL fixtures into the committed dir so criterion 2 is reproducible offline
mkdir -p "$REPO_FIXTURES"
find "$STATE_ROOT/fixtures" -maxdepth 1 -name '*.json' -exec cp {} "$REPO_FIXTURES/" \; 2>/dev/null || true

# 2) tearing (offline, no LLM) — against the committed real fixtures
FIXTURE_DIR="$REPO_FIXTURES" bash "$HERE/criterion2-tearing.sh"

# 3) rename→DONE window + skip-done (real runs)
FIX_SRC="$STATE_ROOT/fixtures" bash "$HERE/criterion3-window.sh"

# publish any window-harvested fixtures too
find "$STATE_ROOT/fixtures" -maxdepth 1 -name '*.json' -exec cp {} "$REPO_FIXTURES/" \; 2>/dev/null || true

# 4) aggregate → evidence/producer.json
node "$SPIKE_DIR/lib/aggregate-evidence.mjs" \
  "$STATE_ROOT/criterion1.json" "$STATE_ROOT/criterion2.json" "$STATE_ROOT/criterion3.json" \
  "$REPO_FIXTURES" "$SPIKE_DIR/evidence/producer.json" "$STATE_ROOT" "$CLAUDE_VERSION"

# tidy any lingering transient units
systemctl --user reset-failed 'wf-t819-*' 2>/dev/null || true
echo "=== done. evidence: $SPIKE_DIR/evidence/producer.json ; state: $STATE_ROOT ==="
