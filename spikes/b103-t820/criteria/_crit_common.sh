#!/usr/bin/env bash
# Shared helpers for the T-820 acceptance criteria. Each criterion sources this,
# which in turn loads the live session written by shadow-up.
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

# curl POST /launch. Prints "<http_code>\t<body>".
launch_post() { # <token> <json-body>
  local token="$1" body="$2"
  curl -sS -m 30 -o /tmp/.t820body.$$ -w '%{http_code}' \
    -X POST "$BASE_URL/api/workflow-supervisor/launch" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "$body"
  local code=$?
  printf '\t%s' "$(cat /tmp/.t820body.$$ 2>/dev/null)"
  rm -f /tmp/.t820body.$$
  return $code
}

# whitespace-tolerant: handles both compact ("k":"v") and pretty ("k": "v") JSON.
json_field() { sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" <<<"$1" | head -1; }

unit_is_active() { systemctl --user is-active "$1" 2>/dev/null; }
unit_mainpid()   { systemctl --user show -p MainPID --value "$1" 2>/dev/null || echo 0; }
unit_exists()    { systemctl --user list-units --all --type=service --no-legend --plain "$1" 2>/dev/null | grep -q "$1"; }
environ_var()    { tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | sed -n "s/^$2=//p"; }
global_active_count() { systemctl --user list-units --type=service --state=active --no-legend --plain 'wf-*.service' 2>/dev/null | grep -c 'wf-.*\.service' || true; }

wait_for_file() { # <path> <timeout_s>
  local p="$1" t="${2:-60}" i=0
  while [ "$i" -lt "$((t*10))" ]; do [ -e "$p" ] && return 0; sleep 0.1; i=$((i+1)); done
  return 1
}
