// Provider observations share identity and lifecycle here; native payloads stay out of the view.
const status = (s) => ({ active: "running", inProgress: "running", in_progress: "running", spawning: "starting", pendingInit: "starting", notFound: "unavailable", shutdown: "stopped", errored: "failed", systemError: "failed", notLoaded: "unavailable" }[s] ?? s ?? "unavailable");

export function codexEvent(e) {
  const base = { ...e, session: e.thread, at: Number(e.t) || 0, provider: "codex" };
  if (e.ev === "joined") return [{ ...base, kind: "session", path: e.rollout }];
  if (e.ev === "child") return [{ ...base, kind: "child", status: status(e.status) }];
  if (e.ev === "transport") return [{ ...base, kind: "connection" }];
  if (e.ev === "thread/status/changed") return [{ ...base, kind: "status", status: status(e.status) }];
  if (e.ev === "turn/started" || e.ev === "turn/completed") return [{ ...base, kind: "turn", status: e.ev.endsWith("started") ? "running" : status(e.status) }];
  if (e.ev === "item/started" || e.ev === "item/completed") return [{ ...base, kind: "item", done: e.ev.endsWith("completed"), status: status(e.status) }];
  if (e.ev === "item/agentMessage/delta") return [{ ...base, kind: "text", type: "agentMessage" }];
  if (e.ev === "item/reasoning/summaryTextDelta") return [{ ...base, kind: "text", type: "reasoning", part: e.part ?? 0 }];
  if (e.ev === "turn/plan/updated") return [{ ...base, kind: "plan" }];
  if (e.ev === "error") return [{ ...base, kind: "error" }];
  return [];
}

export function claudeEvent(e) {
  const base = { ...e, session: e.sid, at: Number(e.t) || 0, provider: "claude" };
  if (e.ev === "SubagentStart" || e.ev === "SubagentStop" || e.ev === "SubagentHandback") {
    return [{ ...base, kind: "child", child: e.agent, status: e.ev === "SubagentStart" ? "running" : e.ev === "SubagentStop" ? "completed" : undefined }];
  }
  if (e.agent) return []; // A child's ordinary hooks are not its parent's activity.
  if (e.ev === "UserPromptSubmit" || e.ev === "Stop" || e.ev === "StopFailure" || e.ev === "SessionEnd") {
    return [{ ...base, kind: "turn", status: e.ev === "UserPromptSubmit" ? "running" : e.ev === "StopFailure" ? "failed" : e.ev === "SessionEnd" ? "stopped" : "completed" }];
  }
  if (e.ev === "PreCompact" || e.ev === "PostCompact") return [{ ...base, kind: "compact", active: e.ev === "PreCompact" }];
  if (e.ev === "MessageDisplay") return [{ ...base, kind: "text", type: "agentMessage", item: e.msg, index: e.i }];
  if (e.ev === "PermissionDenied") return [{ ...base, kind: "denied", item: e.id }];
  return [];
}

export const providerEvents = (e) => e?.src === "codex" ? codexEvent(e) : e?.src === "claude-hook" ? claudeEvent(e) : [];
