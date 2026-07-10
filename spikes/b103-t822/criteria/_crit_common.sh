#!/usr/bin/env bash
# Shared helpers for the T-822 acceptance criteria. Each criterion sources this,
# which loads the live shadow session written by shadow-up.
set -uo pipefail
_CH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$_CH/../harness/_env.sh"
if [ ! -f "$SHADOW_RUN/session.env" ]; then
  echo "[criterion] no session — run harness/shadow-up.sh first" >&2
  exit 2
fi
# shellcheck source=/dev/null
source "$SHADOW_RUN/session.env"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
note() { printf '  ---- %s\n' "$*"; }
finish() { echo; printf '[%s] pass=%d fail=%d\n' "${CRIT_NAME:-criterion}" "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }

drv() { env $(shadow_env_common) "$@" $TSX "$DRIVER"; }   # extra env before, then driver
run_driver() { env $(shadow_env_common) "$@"; }

hoff() { "$NODE_BIN" -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0,32))' "$1"; }
ref_for() { printf 'bgtaskref-%s' "$(hoff "$1")"; }

# Count parseable jsonl lines that TEXT-contain a needle (torn lines ignored).
count_valid_needle() { # <jsonl> <needle>
  "$NODE_BIN" -e '
    const fs=require("fs");const [p,needle]=process.argv.slice(1);
    if(!fs.existsSync(p)){console.log(0);process.exit(0)}
    const ls=fs.readFileSync(p,"utf8").split("\n").filter(Boolean);let n=0;
    for(const l of ls){try{JSON.parse(l);if(l.includes(needle))n++}catch{}}
    console.log(n);' "$1" "$2"
}

# Print "<lines> <unparseable>" for a jsonl.
jsonl_health() { # <jsonl>
  "$NODE_BIN" -e '
    const fs=require("fs");const p=process.argv[1];
    if(!fs.existsSync(p)){console.log("0 0");process.exit(0)}
    const ls=fs.readFileSync(p,"utf8").split("\n").filter(Boolean);let bad=0;
    for(const l of ls){try{JSON.parse(l)}catch{bad++}}
    console.log(ls.length+" "+bad);' "$1"
}

ledger_entries() { # <conv>
  local p="$SHADOW_STATE/handoffs/$1.done"
  [ -f "$p" ] || { echo 0; return; }
  "$NODE_BIN" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).entries.length)}catch{console.log(-1)}' "$p"
}

wf_units_count() { systemctl --user list-units --all --type=service --no-legend --plain 'wf-*.service' 2>/dev/null | grep -c 'wf-' || true; }
intent_files_count() { find "$SHADOW_STATE/intents" -name '*.json' 2>/dev/null | wc -l; }

# Seed a terminal task dir with a real-ish result payload.
seed_task() { # <taskId> <conv> <policy> <resultText>
  local tid="$1" conv="$2" policy="$3" text="$4"
  local td="$SHADOW_STATE/tasks/$tid"; mkdir -p "$td"
  "$NODE_BIN" -e '
    const fs=require("fs");const [td,tid,uid,conv,policy,pp,text]=process.argv.slice(1);
    fs.writeFileSync(td+"/result.json",JSON.stringify({result:text,usage:{input_tokens:600,output_tokens:80}}));
    // DONE last (exit 0) so the classifier ⇒ SUCCEEDED (a completed producer).
    fs.writeFileSync(td+"/DONE",JSON.stringify({exit_code:0,signal:null,finalizedAt:new Date().toISOString(),schema:"t820-producer-1"}));
    fs.writeFileSync(td+"/task.json",JSON.stringify({schema_version:"2",taskId:tid,userId:+uid,projectPath:pp,conversationId:conv,originMessageId:"m-"+tid,spec:{scriptOrPrompt:"x",model:null,effort:null,handoffPolicy:policy,leafOnly:true},requestedAt:new Date(0).toISOString()}));
  ' "$td" "$tid" "$OWNER_ID" "$conv" "$policy" "$PROJECT_PATH" "$text"
}

# Create a FRESH real claude session (haiku) under the temp cfg; prints "<sid> <transcript>".
make_session() { # [seedprompt]
  local prompt="${1:-قل فقط: بدأنا}" out sid tr
  out="$(cd "$PROJECT_PATH" && timeout 120 env HOME="$SHADOW_HOME" CLAUDE_CONFIG_DIR="$OWNER_CFG" \
    "$CLAUDE_BIN" -p "$prompt" --model "$SHADOW_HANDOFF_MODEL" --output-format json 2>/dev/null)"
  sid="$("$NODE_BIN" -e 'try{console.log(JSON.parse(process.argv[1]).session_id||"")}catch{console.log("")}' "$out")"
  [ -n "$sid" ] || return 1
  tr="$(find -L "$OWNER_CFG/projects" -name "$sid.jsonl" 2>/dev/null | head -1)"
  [ -n "$tr" ] || return 1
  # seed the DB row so C2 resolves it.
  env $(shadow_env_common) $TSX "$DB_DRIVER" seed-session "$sid" "$PROJECT_PATH" "$tr" >/dev/null 2>&1 || return 1
  printf '%s %s' "$sid" "$tr"
}
