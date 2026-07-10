#!/usr/bin/env bash
# Shared helpers for the T-821 acceptance criteria. Each criterion sources this,
# which loads the live session written by shadow-up.
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

# POST /launch. Prints "<http_code>\t<body>".
launch_post() { # <token> <json-body>
  local token="$1" body="$2"
  curl -sS -m 30 -o "/tmp/.t821body.$$" -w '%{http_code}' \
    -X POST "$BASE_URL/api/workflow-supervisor/launch" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "$body"
  printf '\t%s' "$(cat "/tmp/.t821body.$$" 2>/dev/null)"
  rm -f "/tmp/.t821body.$$"
}

# GET /sessions/:id/messages — the EXACT path the UI reads. Prints the JSON body.
get_messages() { # <token> <conversationId>
  curl -sS -m 20 -H "Authorization: Bearer $1" \
    "$BASE_URL/api/providers/sessions/$2/messages"
}

json_field() { sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" <<<"$1" | head -1; }

unit_is_active() { systemctl --user is-active "$1" 2>/dev/null; }
unit_mainpid()   { systemctl --user show -p MainPID --value "$1" 2>/dev/null || echo 0; }
global_active_count() { systemctl --user list-units --type=service --state=active --no-legend --plain 'wf-*.service' 2>/dev/null | grep -c 'wf-.*\.service' || true; }

wait_for_file() { # <path> <timeout_s>
  local p="$1" t="${2:-60}" i=0
  while [ "$i" -lt "$((t*10))" ]; do [ -e "$p" ] && return 0; sleep 0.1; i=$((i+1)); done
  return 1
}

# Seed a claude session row (conversationId → temp jsonl under the owned project).
# Prints the jsonl path it created.
seed_session() { # <conversationId>
  local conv="$1" jsonl="$SHADOW_TRANSCRIPTS/$1.jsonl"
  env $(shadow_env_common) DB_INDEX="$DB_INDEX" "$NODE_BIN" \
    "$_CH/../harness/seed-session.mjs" "$conv" "$PROJECT_PATH" "$jsonl" >/dev/null 2>&1 || return 1
  printf '%s' "$jsonl"
}

# Count VALID (JSON.parse-able) card lines carrying a handoffId, in a jsonl.
count_cards() { # <jsonlPath>
  [ -f "$1" ] || { echo 0; return; }
  "$NODE_BIN" -e '
    const fs=require("fs");
    const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
    let n=0; for(const l of lines){ try{ const o=JSON.parse(l); if(o.kind==="task_reconcile"&&o.handoffId) n++; }catch{} }
    process.stdout.write(String(n));
  ' "$1"
}

# Start a standalone supervisor (nohup), record its pid in a given pidfile.
start_supervisor() { # <pidfileName>
  local pf="$SHADOW_RUN/$1"
  nohup env $(shadow_env_common) "$NODE_BIN" "$SUPERVISOR_ENTRY" \
    >> "$SHADOW_LOGS/$1.log" 2>&1 < /dev/null &
  echo $! > "$pf"
  printf '%s' "$(cat "$pf")"
}

# Hard-kill a supervisor pidfile (kill -9 for the crash test; SIGTERM otherwise).
stop_supervisor() { # <pidfileName> [-9]
  local pf="$SHADOW_RUN/$1" sig="${2:-}"
  [ -f "$pf" ] || return 0
  local pid; pid="$(cat "$pf" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    if [ "$sig" = "-9" ]; then kill -9 "$pid" 2>/dev/null || true;
    else kill "$pid" 2>/dev/null || true; for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done; kill -9 "$pid" 2>/dev/null || true; fi
  fi
  rm -f "$pf"
}
