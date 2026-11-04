#!/bin/sh
# Claude Code's live events for the chat, as one async command hook (agent/launch adds it).
# Codex's come from mods/chat/codex-tap.py, into the same file.
#
# Contract (the chat reads it; the log stays the record, events only say what it can't yet):
#   File: <d>/chat-events/<terminal>.jsonl, <d> = $HERDR_HC_SPOOL in Herdr's sandbox, else
#   ~/.config/herdr-app/data (as ask-hook.sh). One JSON object per line, each line one write,
#   so lines never mix. A Codex agent's app-server socket sits beside it, <terminal>.sock.
#   Bounds: a line is under 4 KB from here and 16 KB from the tap. Writers empty the file once
#   it is past 1 MB (no chat reading); the reader empties it past 256 KB, and starts over at 0
#   whenever the file is shorter than where it read to. A clipped text ends with "…", at the
#   length noted (else 900). A field with nothing to say is left out.
#   Every line: t (ms since 1970, when the writer ran; hooks run async, so order by t), src, ev.
#   Lines from before the agent's session (an old terminal's address reused) carry another
#   sid or thread than its log.
#
#   src "claude-hook": ev is the hook's name; also sid (session id, the log's file name) and
#   agent (set when a subagent fired it: not the main conversation).
#     UserPromptSubmit    prompt, pid (prompt id): Claude took a message
#     PreCompact          trigger ("manual" | "auto"): compaction started
#     PostCompact         trigger: compaction done
#     MessageDisplay      turn, msg, i (line index), final, delta: whole lines of the reply as
#                         they show; a long line comes only with final; Esc drops the rest
#     StopFailure         error (rate_limit, overloaded, server_error, ...), details (300),
#                         text (300): an API error ended the turn (no Stop then)
#     PostToolUseFailure  tool, id (tool_use_id), interrupt, ms, error (300)
#     PermissionDenied    tool, id, reason (300): auto mode refused a call
#     Stop                the turn ended (not after an interrupt)
#
#   src "codex" (codex-tap.py): ev is the app-server method; also thread (the rollout's
#   session id: other threads are subagents or Codex's auto-reviewer) and turn where given.
#   The tap joins a thread once its rollout exists, so a new thread's first turn/started and
#   first items can be missing.
#     joined                      rollout (path), cwd: the tap follows this thread now
#     thread/status/changed       status (idle | active | systemError | notLoaded), flags
#                                 ([waitingOnApproval, waitingOnUserInput])
#     turn/started                turn
#     turn/completed              turn, status (completed | interrupted | failed), error (500)
#     item/started, item/completed
#                                 item, type (userMessage, agentMessage, reasoning,
#                                 commandExecution, fileChange, mcpToolCall, webSearch,
#                                 contextCompaction, ...), status, and by type: command (300,
#                                 as the TUI shows it), exit; files (paths, 20); server, tool;
#                                 query (300)
#     item/agentMessage/delta     item, delta: reply text, coalesced (every 0.1 s or 2000
#                                 characters, not clipped)
#     turn/plan/updated           turn, explanation (500), plan ([{step (200), status
#                                 (pending | inProgress | completed)}], 50)
#     error                       turn, error (500), info (codexErrorInfo's kind), retry
#                                 (willRetry: true is a reconnect, the turn goes on)
#     thread/queue/changed        queue ([text (300)]): the server's queue (not the TUI's own,
#                                 which typing Tab while it works fills)
#     thread/closed               the thread was unloaded
#   Approvals and questions go to chat-asks (req/ans/end) as ask-hook.sh's do.
#
# Async: Claude never waits on it, and whatever it prints would reach Claude, so it prints
# nothing. Any failure just loses that event.

t="${HC_TERMINAL_ID:-}"
case "$t" in ""|*/*|*..*) exit 0 ;; esac
d="${HERDR_HC_SPOOL:-${HERDR_APP_HOME:-$HOME/.config/herdr-app}/data}/chat-events"
f="$d/$t.jsonl"
[ -d "$d" ] || mkdir -p "$d" 2>/dev/null || exit 0
# Nobody reading (no chat open): keep it bounded.
s=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null || echo 0)
[ "$s" -gt 1048576 ] && : > "$f"
# One line well under 4 KB, so jq writes it in one go and lines from hooks running at the
# same time never mix.
jq -c '
  def clip($n): if type == "string" and length > $n then .[0:$n] + "…" else . end;
  .hook_event_name as $e
  | {t: (now * 1000 | floor), src: "claude-hook", ev: $e, sid: .session_id, agent: .agent_id}
  + if $e == "UserPromptSubmit" then {prompt: (.prompt | clip(900)), pid: .prompt_id}
    elif $e == "PreCompact" or $e == "PostCompact" then {trigger}
    elif $e == "MessageDisplay" then {turn: .turn_id, msg: .message_id, i: .index, final, delta: (.delta | clip(900))}
    elif $e == "StopFailure" then {error, details: (.error_details | clip(300)), text: (.last_assistant_message | clip(300))}
    elif $e == "PostToolUseFailure" then {tool: .tool_name, id: .tool_use_id, interrupt: .is_interrupt, ms: .duration_ms, error: (.error | clip(300))}
    elif $e == "PermissionDenied" then {tool: .tool_name, id: .tool_use_id, reason: (.reason | clip(300))}
    else {} end
  | with_entries(select(.value != null))' >> "$f" 2>/dev/null
# Files of terminals long gone (outside the sandbox they'd stay).
[ "$s" = 0 ] && find "$d" -name '*.jsonl' -mtime +2 -delete 2>/dev/null
exit 0
