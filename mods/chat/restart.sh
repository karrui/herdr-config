#!/usr/bin/env bash
# Restarts a chat's agent with another argv (model, effort or agent), parked behind the same
# chat pane, through agent/launch: sandboxed when the old one was, with Herdr's instructions.
# Called by agent.js restart(). Prints the new address.
# usage: HERDR_RESTART_CHAT=<chat pane> [HERDR_RESTART_RESUME=1] restart.sh <old address> <argv as JSON>
#   HERDR_RESTART_RESUME=1: argv resumes the same conversation, so no handoff is sent.
set -u
old=$1 argv=${2:-} context=${3:-null}
app="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
info=$(hc get "$old" --json) || exit 1
get() { jq -r "$1 // empty" <<<"$info"; }
cwd=$(get .foreground.cwd); [ -n "$cwd" ] || cwd=$(get .cwd)
chat=${HERDR_RESTART_CHAT:-$(get '.labels["herdr.chat"]')}
[ -n "$chat" ] || exit 1
origin=$(get '.labels["herdr.chat.origin"]'); origin=${origin:-$old}
cmd=()
while IFS= read -r a; do cmd+=("$a"); done < <(jq -r '.[]' <<<"$argv")
[ ${#cmd[@]} -gt 0 ] || exit 1
[ -x "$app/agent/launch" ] || { echo "Install Herdr's agent scripts on this machine before restarting an agent." >&2; exit 1; }
key=$(basename "${cmd[0]}")
wrap=("$app/agent/launch")
if [ -n "$(get '.labels["herdr.sandbox"]')" ]; then
  wrap+=(--sandbox)
  # Codex can't start its own sandbox inside Herdr's, which confines it instead (programs.json).
  if [ "$key" = codex ]; then
    keep=() i=0
    while [ $i -lt ${#cmd[@]} ]; do
      case "${cmd[$i]}" in -s|--sandbox) i=$((i + 2)); continue ;; esac
      keep+=("${cmd[$i]}"); i=$((i + 1))
    done
    cmd=("${keep[@]}" --sandbox danger-full-access)
  fi
fi

# Another conversation: the new agent gets the old one's last screen, in a folder a sandboxed
# agent can read, as its first message.
handoff=$(get '.labels["herdr.chat.handoff"]')
if [ -z "${HERDR_RESTART_RESUME:-}" ]; then
  screen=$(mktemp "${TMPDIR:-/tmp}/herdr-handoff.XXXXXX") || exit 1
  if [ "$context" != null ] && jq -e '.text | length > 0' <<<"$context" >/dev/null; then
    jq -r '.text' <<<"$context" >"$screen" || exit 1
  else
    hc read "$old" --lines 400 >"$screen" 2>/dev/null
  fi
  mkdir -p "$app/data/chat-handoffs" || exit 1
  handoff=$(mktemp "$app/data/chat-handoffs/handoff.XXXXXX") || exit 1
  jq -nc --argjson context "$context" --arg old "$old" --arg path "$screen" '{source: $context.source, previousTerminal: $old, contextPath: $path, delivery: "prepared"}' >"$handoff" || exit 1
  cmd+=("You are continuing a conversation from $(get .status.app) ($old). Read the attributed handoff at $screen, then continue the latest user request. The original transcript is referenced there.")
fi

new=$(hc run --bg --json --no-parent --keep --cwd "$cwd" --label "herdr.chat=$chat" --label "herdr.chat.origin=$origin" \
  --label "herdr.chat.handoff=$handoff" --label "herdr.agent=$key" -- "${wrap[@]}" "${cmd[@]}" | jq -r '.address // empty')
[ -n "$new" ] || exit 1
if [ -n "$handoff" ] && [ -f "$handoff" ]; then
  jq --arg target "$new" '.targetTerminal = $target | .delivery = "queued"' "$handoff" >"$handoff.tmp" && mv "$handoff.tmp" "$handoff"
fi
hc kill "$old" >/dev/null 2>&1
hc rm "$old" >/dev/null 2>&1
echo "$new"
