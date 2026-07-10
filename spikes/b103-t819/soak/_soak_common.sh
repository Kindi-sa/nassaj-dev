#!/usr/bin/env bash
#
# B-103 / T-819 FIELD wave — shared helpers for the live soak (§و/المرحلة 1 criterion 8) and the
# injected-turn cost measurement (added criterion 9). Sources the proven producer/consumer
# helpers so the field wave runs the SAME pipeline (run-task.sh → wf-<taskId>.service → classifier
# → supervisor → handoff), only now the delivery target is a REAL claude transcript (not a fixture)
# and every claude -p is real. Nothing here touches live server code, the app DB, builds, or PM2.
set -uo pipefail

# A DELIBERATE, documented cwd so the soak conversations surface as one temp project in the
# nassaj-dev UI (via the inherited CLAUDE_CONFIG_DIR). Cleaned after T-819 closes (see report).
SOAK_BASE="${SOAK_BASE:-/tmp/b103-t819-soak}"
export STATE_ROOT="${STATE_ROOT:-$SOAK_BASE/state}"   # keep supervisor state under the soak tree
mkdir -p "$SOAK_BASE" "$STATE_ROOT/tasks" "$STATE_ROOT/handoffs" "$STATE_ROOT/cwd"

# inherited owner config (user 1) — where real transcripts live; do NOT override (task rule).
: "${CLAUDE_CONFIG_DIR:?CLAUDE_CONFIG_DIR must be inherited}"
export CLAUDE_CONFIG_DIR
PROJECTS_DIR="$CLAUDE_CONFIG_DIR/projects"

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SPIKE_DIR/tests/_consumer_common.sh"   # brings launch/wait_settle/classify_to/hid_of/…

MODEL="${MODEL:-haiku}"

# Run a REAL claude -p turn in a specific cwd; echo the raw JSON envelope on stdout.
# Uses `env -C` for cwd control (no `cd`, avoids the client cd-compound guard).
claude_turn () { # cwd prompt [extra claude args...]
  local cwd="$1" prompt="$2"; shift 2
  mkdir -p "$cwd"
  env -C "$cwd" CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" \
    claude -p "$prompt" --model "$MODEL" --output-format json "$@" 2>/dev/null
}

# Resume a REAL session with a leaf-only handoff turn; echo the JSON envelope.
# leaf-only per §هـ-2: generation/spawn tools disabled so the injected turn cannot fork background.
claude_resume_leaf () { # cwd sessionId prompt [extra]
  local cwd="$1" sid="$2" prompt="$3"; shift 3
  env -C "$cwd" CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" \
    claude -p "$prompt" --resume "$sid" --model "$MODEL" --output-format json \
      --disallowedTools "Task" "TodoWrite" "Bash" "Edit" "Write" "WebSearch" "WebFetch" "$@" 2>/dev/null
}

# Deterministic transcript path: claude encodes a cwd into projects/<cwd with '/'→'-'>/<sid>.jsonl.
# (A broad `find` over the owner's 21 project trees is unreliable/slow; the encoding is exact for
# our [a-z0-9-] /tmp paths.) Retries briefly for the post-return flush, then echoes the path.
transcript_for () { # cwd sessionId
  local enc; enc="$(printf '%s' "$1" | sed 's:/:-:g')"
  local p="$PROJECTS_DIR/$enc/$2.jsonl" i
  for ((i=0; i<30; i++)); do [ -f "$p" ] && { echo "$p"; return 0; }; sleep 0.1; done
  echo "$p"   # echo anyway; caller checks existence
}

# Create a real target conversation in cwd; echo "sessionId|transcriptPath".
seed_real_conversation () { # cwd prompt
  local cwd="$1" prompt="$2" env_json sid tf
  env_json="$(claude_turn "$cwd" "$prompt")"
  sid="$(printf '%s' "$env_json" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).session_id' 2>/dev/null)"
  [ -n "${sid:-}" ] || { echo "|"; return 1; }
  tf="$(transcript_for "$cwd" "$sid")"
  [ -f "$tf" ] || { echo "$sid|"; return 1; }
  echo "$sid|$tf"
}

count_lines () { [ -f "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }

# Inspect the injected handoff line for a given handoffId in a REAL transcript.
# Emits JSON: found / subtype / userType / isPlainUser / untrustedWrapped / validParse / count.
check_injected_line () { # transcript handoffId
  TF="$1" HID="$2" node -e '
    const fs=require("fs");const tf=process.env.TF,hid=process.env.HID;
    const out={found:false,count:0,subtype:null,userType:null,isPlainUser:null,
      untrustedWrapped:false,validParse:false,attributedToTaskNotification:false};
    if(fs.existsSync(tf)){
      for(const l of fs.readFileSync(tf,"utf8").split("\n")){
        if(!l)continue; let o; try{o=JSON.parse(l);}catch{continue;}
        const carries=o&&(o.handoffId===hid||(Array.isArray(o.handoffIds)&&o.handoffIds.includes(hid)));
        if(!carries)continue;
        out.found=true;out.count++;out.validParse=true;
        out.subtype=o.subtype||null;out.userType=o.userType||null;
        // a genuine user turn is type:user WITH NO subtype; the handoff line carries subtype.
        out.isPlainUser=(o.type==="user"&&!o.subtype);
        const c=o.message&&o.message.content;
        out.untrustedWrapped=typeof c==="string"&&c.includes("background_task_result untrusted=\"true\"");
        out.attributedToTaskNotification=(o.subtype==="background_task_handoff");
      }
    }
    process.stdout.write(JSON.stringify(out));
  '
}

# outcome recorded for a task in the conversation ledger (SUCCEEDED|PARTIAL|CRASHED| or none).
ledger_outcome_for () { # stateRoot conversationId taskId
  node -e '
    const fs=require("fs");const p=process.argv[1],tid=process.argv[2];
    if(!fs.existsSync(p)){console.log("none");process.exit(0);}
    try{const o=JSON.parse(fs.readFileSync(p,"utf8"));
      const e=(o.entries||[]).find(e=>e.taskId===tid);console.log(e?(e.outcome||"?"):"none");}
    catch{console.log("err");}
  ' "$1/handoffs/$2.done" "$3"
}
