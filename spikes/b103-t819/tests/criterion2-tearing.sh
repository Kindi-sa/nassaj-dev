#!/usr/bin/env bash
#
# Criterion 2: kill -9 during the result write NEVER yields a torn result.json (only
# .partial). Runs 100 (ITERATIONS) local injections that re-pass REAL captured stdout
# through the SAME write path (lib/capture-writer.mjs seal()), SIGKILL-ing at a random
# byte offset each time. No LLM cost.
#
# FIXTURE_DIR (default: committed spikes/b103-t819/fixtures) — REAL claude stdout only.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

ITERATIONS="${ITERATIONS:-100}"
FIXTURE_DIR="${FIXTURE_DIR:-$SPIKE_DIR/fixtures}"
WORK="$STATE_ROOT/tearing"; mkdir -p "$WORK"
OFFS="$WORK/offsets.tsv"; : > "$OFFS"

mapfile -t FIXTURES < <(find "$FIXTURE_DIR" -maxdepth 1 -name '*.json' | sort)
[ "${#FIXTURES[@]}" -gt 0 ] || { echo "[criterion2] no fixtures in $FIXTURE_DIR" >&2; exit 3; }
echo "[criterion2] fixtures=${#FIXTURES[@]} dir=$FIXTURE_DIR iterations=$ITERATIONS"

torn=0
for ((n=1; n<=ITERATIONS; n++)); do
  fix="${FIXTURES[$((RANDOM % ${#FIXTURES[@]}))]}"
  L=$(wc -c < "$fix")
  K=$((RANDOM % (L + 1)))            # [0, L]: before first byte .. right after last byte
  od="$WORK/it-$n"; rm -rf "$od"; mkdir -p "$od"
  # background + wait so the shell does not print a "Killed" job notice for the
  # deliberate self-SIGKILL (non-interactive shells suppress async job messages).
  node "$LIB/capture-writer.mjs" --replay --outdir "$od" \
    --input "$fix" --exit-code 0 --kill-at-offset "$K" >/dev/null 2>&1 &
  wait $! ; ec=$?
  res=no; [ -f "$od/result.json" ] && res=yes
  done=no; [ -f "$od/DONE" ] && done=yes
  part=no; [ -f "$od/result.json.partial" ] && part=yes
  printf '%d\t%s\t%d\t%d\t%d\t%s\t%s\t%s\n' "$n" "$(basename "$fix")" "$L" "$K" "$ec" "$res" "$done" "$part" >> "$OFFS"
  if [ "$res" = yes ] || [ "$done" = yes ]; then
    torn=$((torn + 1))
    echo "  [TORN] it=$n fix=$(basename "$fix") L=$L K=$K ec=$ec result=$res done=$done"
  fi
  rm -rf "$od"
done

# Control: same path WITHOUT a kill must produce result.json + DONE (proves the harness
# can actually observe a completed write — so torn=0 is a real pass, not a dead path).
CTL=3; ctl_ok=0
for ((c=1; c<=CTL; c++)); do
  fix="${FIXTURES[$((RANDOM % ${#FIXTURES[@]}))]}"
  od="$WORK/ctl-$c"; rm -rf "$od"; mkdir -p "$od"
  node "$LIB/capture-writer.mjs" --replay --outdir "$od" --input "$fix" --exit-code 0 >/dev/null 2>&1
  [ -f "$od/result.json" ] && [ -f "$od/DONE" ] && ctl_ok=$((ctl_ok + 1))
  rm -rf "$od"
done

node - "$OFFS" "$ITERATIONS" "$torn" "$CTL" "$ctl_ok" "$FIXTURE_DIR" "${#FIXTURES[@]}" "$STATE_ROOT/criterion2.json" <<'NODE'
const fs = require('fs');
const [offs, iters, torn, ctl, ctlOk, fixDir, nFix, outFile] = process.argv.slice(2);
const rows = fs.readFileSync(offs,'utf8').trim().split('\n').filter(Boolean).map(l=>{
  const [it,fixture,len,offset,ec,result,done,partial] = l.split('\t');
  return {it:+it, fixture, len:+len, offset:+offset, ec:+ec, resultPresent:result==='yes', donePresent:done==='yes', partialPresent:partial==='yes'};
});
const killedBySignal = rows.filter(r=>r.ec===137).length;
const summary = { criterion: 2, iterations:+iters, torn:+torn,
  tornOffsets: rows.filter(r=>r.resultPresent||r.donePresent).map(r=>({it:r.it,offset:r.offset,len:r.len})),
  killedBySignal, controls:+ctl, controlsProducedResult:+ctlOk,
  fixtureDir: fixDir, fixturesAvailable:+nFix,
  offsetSpread: { min: Math.min(...rows.map(r=>r.offset)), max: Math.max(...rows.map(r=>r.offset)) },
  sample: rows.slice(0,8) };
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log(`[criterion2] torn=${torn}/${iters}  killedBySignal=${killedBySignal}/${iters}  controls ok=${ctlOk}/${ctl}  offsets [${summary.offsetSpread.min}..${summary.offsetSpread.max}]`);
NODE
