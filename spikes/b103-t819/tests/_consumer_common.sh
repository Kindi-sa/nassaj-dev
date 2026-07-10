#!/usr/bin/env bash
# Shared helpers for the T-819 CONSUMER criterion scripts (4-7). Source this (it sources
# _common.sh). Nothing here touches live server code, builds, or PM2.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

CLI_HANDOFF="node $SPIKE_DIR/bin/handoff-cli.mjs"
SUP_RUN="$SPIKE_DIR/bin/supervisor-run.sh"
# a REAL captured result.json (from the producer wave) used as the delivered payload
RESULT_FIXTURE="$(find "$SPIKE_DIR/fixtures" -maxdepth 1 -name 't819-succ-*.json' | sort | head -1)"
CONV_A="$SPIKE_DIR/fixtures/conversation-a.jsonl"
CONV_B="$SPIKE_DIR/fixtures/conversation-b.jsonl"

# print the sessionId (conversationId) carried by a real transcript
sid_of () { # jsonl
  node -e 'const fs=require("fs");for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){if(!l)continue;try{const o=JSON.parse(l);if(o.sessionId){console.log(o.sessionId);process.exit(0);}}catch{}}' "$1"
}

# copy a real transcript to dest, guaranteeing a trailing newline (clean base line boundary)
seed_conv () { # dest src
  cp "$2" "$1"
  if [ -s "$1" ] && [ -n "$(tail -c1 "$1")" ]; then printf '\n' >> "$1"; fi
}

seed_task_json () { # dir taskId conversationId convJsonl unit
  printf '{"schema_version":"2-spike","taskId":"%s","conversationId":"%s","userId":1,"projectPath":"/tmp","conversationJsonl":"%s","unit":"%s","spec":{"handoffPolicy":"auto-turn","leafOnly":true},"requestedAt":"%s"}\n' \
    "$2" "$3" "$4" "$5" "$(date -u +%FT%TZ)" > "$1/task.json"
}

hid_of () { $CLI_HANDOFF --hid --task-id "$1"; }

# echo "validMatchCount regexMatchCount tornLines"
scan_counts () { # jsonl hid [matcher]
  $CLI_HANDOFF --scan --jsonl "$1" --handoff-id "$2" ${3:+--matcher "$3"} \
    | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(`${o.validMatchCount} ${o.regexMatchCount} ${o.tornLines}`)'
}

ledger_entries_for () { # stateRoot conversationId taskId
  node -e 'const fs=require("fs");const p=process.argv[1];if(!fs.existsSync(p)){console.log(0);process.exit(0)}try{const o=JSON.parse(fs.readFileSync(p,"utf8"));console.log((o.entries||[]).filter(e=>e.taskId===process.argv[2]).length)}catch{console.log(-1)}' \
    "$1/handoffs/$2.done" "$3"
}

# count real injection events for a task across ALL supervisor incarnations (actions log)
count_inject_events () { # actionsFile taskId
  node -e 'const fs=require("fs");const p=process.argv[1];if(!fs.existsSync(p)){console.log(0);process.exit(0)}let n=0;for(const l of fs.readFileSync(p,"utf8").split("\n")){if(!l)continue;try{const o=JSON.parse(l);if(o.taskId===process.argv[2]&&o.event==="inject+ledger")n++}catch{}}console.log(n)' \
    "$1" "$2"
}

# launch one REAL background task as wf-<tid>.service, result into taskDir. Echoes the unit.
launch_task () { # taskDir taskId prompt
  local td="$1" tid="$2" prompt="$3"
  local cwd; cwd=$(mktemp -d /tmp/b103c6cwd-XXXXXX)
  mkdir -p "$td"
  bash "$RUNNER" --task-id "$tid" --outdir "$td" --cwd "$cwd" \
    --prompt "$prompt" --model haiku --libdir "$LIB" --inner "$INNER" >/dev/null 2>&1
  echo "wf-${tid}.service"
}
