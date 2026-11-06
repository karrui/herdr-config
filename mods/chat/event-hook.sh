#!/bin/sh
# Async Claude observations; session.mjs and the Codex tap share a sequenced journal.
# The writer retains child/session metadata in <terminal>.state.json across journal rotation.
# Always use the producer's local terminal address and data/spool folder, including over SSH.
# Permission decisions still belong to ask-hook.sh; an observation never grants access.
t="${HC_TERMINAL_ID:-}"
case "$t" in ""|*/*|*..*) exit 0 ;; esac
d="${HERDR_HC_SPOOL:-${HERDR_APP_HOME:-$HOME/.config/herdr-app}/data}"
exec node "$(dirname "$0")/session.mjs" hook "$d" "$t"
