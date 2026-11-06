import { providerEvents } from "./adapters.js";

export const settled = (s) => ["completed", "failed", "interrupted", "cancelled", "stopped"].includes(s);
export const active = (s) => ["starting", "pending", "running", "waiting"].includes(s);

// This reducer is shared by both provider adapters. A parent's terminal event never settles children.
export function applyEvent(state, e) {
  if (e.session === state.own && e.permission) state.permission = e.permission;
  if (e.kind === "session") {
    if (e.session === state.own) state.connection = "connected";
    if (e.path) state.rollouts = [...state.rollouts.filter(r => r.path !== e.path), { path: e.path, t: e.at, session: e.session, parent: e.parent }].slice(-100);
    return false;
  }
  if (e.kind === "child") {
    if (!e.child || e.session !== state.own || e.internal) return false;
    const old = state.children.get(e.child);
    if (!old && e.provider === "claude" && e.ev === "SubagentStop" && !e.label) return false;
    if (old && old.updated > e.at) return false;
    // A handback delivers a report; only a stop/turn event establishes completion.
    const next = { ...old, id: e.child, provider: e.provider, parent: e.session, updated: e.at,
      at: old?.at ?? e.at, status: e.status ?? old?.status ?? "unavailable" };
    if (e.ev === "SubagentStart") { delete next.delivery; delete next.result; delete next.waitingReason; }
    for (const key of ["path", "call", "prompt", "label", "model", "effort", "result", "error", "delivery", "waitingReason"]) if (e[key] != null) next[key] = e[key];
    state.children.set(e.child, next);
    return true;
  }
  if (e.session !== state.own || !state.own) return false;
  if (e.kind === "connection") { state.connection = e.status; return true; }
  if (e.at < state.turnAt || (e.turn && state.turnId && e.turn !== state.turnId && e.kind !== "turn")) return false;
  if (e.kind === "turn") {
    if (e.status === "running" && e.turn && state.endedTurns.has(e.turn)) return false;
    if (settled(e.status) && e.turn && state.turnId && e.turn !== state.turnId) return false;
    const changedTurn = e.status === "running" && (e.turn ? e.turn !== state.turnId : e.at > state.turnAt);
    state.turnAt = e.at;
    state.turnId = e.turn ?? state.turnId;
    state.turnState = e.status;
    state.activity = null;
    state.retry = state.compact = null;
    if (changedTurn) { state.tail = null; state.thought = null; state.plan = null; state.openItems.clear(); state.error = null; state.limit = null; }
    if (settled(e.status)) {
      if (e.turn) state.endedTurns.add(e.turn);
      if (state.endedTurns.size > 128) state.endedTurns.delete(state.endedTurns.values().next().value);
      state.openItems.clear();
      if (e.status === "failed") {
        state.error = { at: e.at, text: String(e.text || e.details || e.error || "The agent's turn failed.") };
        state.limit = e.error === "rate_limit" ? state.error : null;
      }
    }
    return true;
  }
  if (e.kind === "status") {
    state.observedStatus = e.status;
    state.activity = e.flags?.includes("waitingOnApproval") ? "Waiting for approval" : e.flags?.includes("waitingOnUserInput") ? "Waiting for your answer" : state.activity;
    return true;
  }
  if (e.kind === "compact") { state.compact = e.active ? { at: e.at } : null; return true; }
  if (e.kind === "denied") { if (e.item) state.denied.set(String(e.item), String(e.reason ?? "")); return true; }
  if (e.kind === "error") {
    const error = { at: e.at, text: String(e.error || "Connection dropped") };
    if (e.retry) { state.retry = { ...error, text: `Retrying · ${error.text}` }; state.connection = "retrying"; }
    else { state.error = error; state.turnState = "failed"; state.activity = null; state.openItems.clear(); }
    return true;
  }
  if (e.kind === "plan") {
    state.plan = { at: e.at, steps: (e.plan ?? []).map(s => ({ text: String(s.step ?? ""), status: ({ inProgress: "in_progress" }[s.status] ?? s.status) })) };
    return true;
  }
  if (e.kind === "item") {
    state.retry = null;
    if (e.type === "userMessage") {
      if (!e.done) for (const [id, message] of state.messages) if (!message.done) {
        message.discarded = true;
        state.openItems.delete(id);
      }
      if (state.tail?.discarded) state.tail = null;
      state.activity = [...state.openItems.values()].pop() ?? null;
      return true;
    }
    if (e.type === "contextCompaction") state.compact = e.done ? null : { at: e.at };
    if (e.type === "agentMessage") {
      if (state.messages.get(e.item)?.discarded) return false;
      if (!e.done) state.stream(e.item, e.at, 0, e.text ?? "");
      else if (typeof e.text === "string") {
        state.tail = { id: e.item, start: state.messages.get(e.item)?.start ?? e.at, parts: [e.text], whole: true, done: true, phase: e.phase };
        state.messages.set(e.item, state.tail);
      } else if (state.messages.has(e.item)) state.messages.get(e.item).done = true;
    }
    if (e.type === "reasoning") {
      if (state.thought?.id === e.item && state.thought.done) return false;
      if (!e.done) state.thought = { id: e.item, start: e.at, parts: [e.text ?? ""], whole: true };
      else if (e.text != null) state.thought = { id: e.item, start: state.thought?.start ?? e.at, parts: [e.text], whole: true, done: true };
    }
    if (e.done) state.openItems.delete(e.item);
    else state.openItems.set(e.item, e.type === "reasoning" ? "Thinking" : e.type === "agentMessage" ? "Writing a reply" : e.command || e.tool || e.query || (e.type === "contextCompaction" ? "Compacting conversation" : "Working"));
    state.activity = [...state.openItems.values()].pop() ?? null;
    return true;
  }
  if (e.kind === "text") {
    if (e.turn && state.endedTurns.has(e.turn)) return false;
    state.limit = null;
    if (e.type === "reasoning") {
      if (state.thought?.id === e.item && state.thought.done) return false;
      if (state.thought?.id !== e.item) state.thought = { id: e.item, start: e.at, parts: [], whole: false };
      const part = Number(e.part) || 0;
      state.thought.parts[part] = (state.thought.parts[part] ?? "") + String(e.delta ?? "");
      if (!state.openItems.size || state.openItems.get(e.item) === [...state.openItems.values()].pop()) state.activity = "Thinking";
    } else state.stream(String(e.item), e.at, e.index ?? null, String(e.delta ?? ""));
    state.retry = null;
    return true;
  }
  return false;
}

// Saved calls provide prompts; timestamps choose the newest transcript or live lifecycle.
export function childrenOf(conv, live, discovered = []) {
  const out = new Map();
  for (const [id, h] of conv?.helpers ?? []) out.set(id, { ...h, id, call: id, label: h.desc, status: h.done ? "completed" : h.uncertain ? "unavailable" : "running", provider: conv.kind });
  for (const child of [...discovered, ...(live?.children?.values() ?? [])]) {
    const old = out.get(child.call) ?? out.get(child.id);
    if (child.call && child.call !== child.id) out.delete(child.call);
    const merged = old?.updated > (child.updated ?? 0) ? { ...child, ...old } : { ...old, ...child };
    if (old?.children || child.children) merged.children = childrenOf(null, null, [...(old?.children ?? []), ...(child.children ?? [])]);
    out.set(child.id, { ...merged, id: child.id, label: merged.label || old?.label || "Subagent" });
  }
  return [...out.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

export function projectChildren(events, session, previous = [], calls = null) {
  if (!session) return previous;
  const observed = events.flatMap(providerEvents), observations = observed.filter(e => e.kind === "child");
  const parents = new Map(observed.filter(e => e.kind === "session" && e.parent).map(e => [e.session, e.parent]));
  let remaining = 128;
  const project = (own, saved, calls, ancestors) => {
    if (!own || ancestors.has(own) || remaining-- <= 0) return [];
    // Thread metadata owns parentage; messaging a sibling must not adopt it.
    saved = saved.filter(h => !parents.has(h.id) || parents.get(h.id) === own);
    const state = { own, children: new Map(saved.map(h => [h.id, h])) }, seen = new Set([...ancestors, own]);
    for (const e of observations) if (!seen.has(e.child) && (!parents.has(e.child) || parents.get(e.child) === own)) applyEvent(state, e);
    return childrenOf(null, state).filter(h => !seen.has(h.id) && (!calls || h.provider !== "claude" || calls.includes(h.call) || saved.some(p => p.id === h.id)))
      .map(h => h.provider === "codex" && !h.terminal ? { ...h, children: project(h.id, h.children ?? [], null, seen) } : h);
  };
  return project(session, previous, calls, new Set());
}

export function handoffText(items, source, folder) {
  const entries = items.filter(x => ["user", "agent", "tools", "plan", "error", "compacted"].includes(x.kind));
  const kept = [];
  let size = 0;
  for (const x of [...entries].reverse()) {
    const role = x.kind === "user" ? x.from ? `Agent message from ${x.from}` : "User" : x.kind === "agent" ? "Assistant" : x.kind;
    const text = x.kind === "tools" ? x.steps.map(s => `${s.failed ? "Failed" : "Tool"}: ${s.line}`).join("\n") : x.text ?? "";
    const part = `## ${role}\n${text.slice(0, 8000)}${text.length > 8000 ? "\n[Entry truncated; see source transcript.]" : ""}\n`;
    if (size + part.length > 48000) break;
    kept.unshift(part); size += part.length;
  }
  return `# Conversation handoff\nWorking directory: ${folder ?? "unknown"}\nSource transcript: ${source}\n` +
    `Roles below describe prior conversation; continue the latest user request and preserve existing work.\n` +
    (kept.length < entries.length ? "Earlier entries omitted; the source transcript remains available.\n" : "") + kept.join("\n");
}
