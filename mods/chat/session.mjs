// Machine-side session IO. The native view sends this module to remote machines unchanged.
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

const readJSON = file => JSON.parse(fs.readFileSync(file, "utf8"));
export const alive = pid => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; } };
export function atomicWrite(file, text) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, text, { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}

export async function writeEvent(folder, terminal, event) {
  if (!/^[\w.-]+$/.test(terminal) || terminal.includes("..")) throw new Error("Invalid terminal identity");
  const root = path.join(folder, "chat-events"), file = path.join(root, `${terminal}.jsonl`);
  fs.mkdirSync(root, { recursive: true });
  const lock = `${file}.lock`, until = Date.now() + 5000;
  for (;;) {
    try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "owner"), String(process.pid)); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = Number(fs.readFileSync(path.join(lock, "owner"), "utf8"));
        if (owner && !alive(owner)) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      } catch {
        const stat = fs.statSync(lock, { throwIfNoEntry: false });
        if (!stat) continue;
        if (Date.now() - stat.mtimeMs > 10000) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      }
      if (Date.now() > until) throw new Error("Agent event writer is busy");
      await delay(20);
    }
  }
  try {
    const snapshot = file.replace(/\.jsonl$/, ".state.json"), counter = file.replace(/\.jsonl$/, ".cursor.json");
    let cursor, state;
    try { cursor = readJSON(counter); } catch { cursor = { epoch: randomUUID(), seq: 0 }; }
    const next = { t: Date.now(), ...event, epoch: cursor.epoch, seq: ++cursor.seq };
    cursor.producerPid = event.src === "codex" ? process.pid : process.ppid;
    const session = next.sid ?? next.thread;
    const child = next.child ?? (next.ev?.startsWith("Subagent") ? next.agent : null);
    const key = child ? `${session}:child:${child}` : next.ev === "joined" ? `${session}:joined` : null;
    if (key) {
      try { state = readJSON(snapshot); } catch { state = { events: {} }; }
      const old = state.events[key] ?? {};
      if ((old.t ?? 0) <= next.t) {
        if (next.ev === "SubagentStart") { delete old.delivery; delete old.result; }
        if (next.ev === "SubagentStop" && old.delivery === "reported") delete next.result;
        state.events[key] = { ...old, ...next };
      }
      state.events = Object.fromEntries(Object.entries(state.events).slice(-512));
      atomicWrite(snapshot, JSON.stringify(state));
    }
    // Persist sequence before appending: a crash produces a detectable gap, never a reused ID.
    atomicWrite(counter, JSON.stringify(cursor));
    if (fs.existsSync(file) && fs.statSync(file).size > 1048576) fs.truncateSync(file);
    fs.appendFileSync(file, JSON.stringify(next) + "\n", { mode: 0o600 });
    return next;
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

export function claudeHook(p) {
  const ev = p.hook_event_name;
  const e = { src: "claude-hook", ev, sid: p.session_id, agent: p.agent_id, permission: p.permission_mode ? { mode: p.permission_mode, confirmed: true } : undefined };
  const fields = { UserPromptSubmit: ["prompt", "prompt_id"], MessageDisplay: ["turn_id", "message_id", "index", "final", "delta"],
    StopFailure: ["error", "error_details", "last_assistant_message"], PermissionDenied: ["tool_use_id", "reason"],
    SubagentStart: ["agent_type"], SubagentStop: ["agent_type", "agent_transcript_path", "last_assistant_message"], PreCompact: ["trigger"], PostCompact: ["trigger"] };
  const names = { prompt_id: "pid", turn_id: "turn", message_id: "msg", index: "i", error_details: "details", last_assistant_message: "text", tool_use_id: "id", agent_type: "label", agent_transcript_path: "path" };
  for (const k of fields[ev] ?? []) if (p[k] != null) e[names[k] ?? k] = typeof p[k] === "string" ? p[k].slice(0, 12000) : p[k];
  if (ev === "SubagentStop") Object.assign(e, { status: "completed", result: p.last_assistant_message?.slice(0, 4000) });
  if (["SubagentStart", "SubagentStop"].includes(ev) && p.agent_id && p.transcript_path) {
    const meta = p.agent_transcript_path?.replace(/\.jsonl$/, ".meta.json") ?? p.transcript_path.replace(/\.jsonl$/, "") + "/subagents/agent-" + p.agent_id.replace(/^agent-/, "") + ".meta.json";
    try { e.call = readJSON(meta).toolUseId; } catch {}
  }
  if (["PreToolUse", "PostToolUse"].includes(ev) && p.tool_name === "SubagentHandback") Object.assign(e, { ev: "SubagentHandback", result: p.tool_input?.message?.slice(0, 4000), delivery: "reported" });
  return e;
}

function historyScope(file) {
  const fd = fs.openSync(file, "r"), block = Buffer.alloc(65536), chunks = [];
  let position = 0, ordinal = 0, boundary = 0, first = null;
  try {
    for (;;) {
      const length = fs.readSync(fd, block, 0, block.length, position);
      if (!length) break;
      let from = 0;
      for (let i = 0; i < length; i++) {
        if (block[i] !== 10) continue;
        if (!ordinal) {
          chunks.push(Buffer.from(block.subarray(from, i)));
          try { first = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
          boundary = first?.type === "session_meta" ? first.payload?.subagent_history_start_ordinal ?? 0 : 0;
          if (!Number.isSafeInteger(boundary) || boundary < 0) throw new Error("Invalid Codex child history boundary");
          if (!boundary) return { start: 0, first };
        }
        ordinal++; from = i + 1;
        if (ordinal === boundary) return { start: position + from, first };
      }
      if (!ordinal) chunks.push(Buffer.from(block.subarray(from, length)));
      position += length;
    }
    if (!ordinal) {
      try { first = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      boundary = first?.type === "session_meta" ? first.payload?.subagent_history_start_ordinal ?? 0 : 0;
      if (!Number.isSafeInteger(boundary) || boundary < 0) throw new Error("Invalid Codex child history boundary");
    }
    return { start: boundary || !first ? null : 0, first };
  } finally { fs.closeSync(fd); }
}

function records(file, limit = 262144) {
  const scope = historyScope(file);
  if (scope.start === null) return scope.first ? [scope.first] : [];
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(scope.start, size - limit);
    const tail = Buffer.alloc(Math.max(0, size - start));
    fs.readSync(fd, tail, 0, tail.length, start);
    const lines = tail.toString("utf8").split("\n");
    if (start > scope.start) lines.shift();
    const rows = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    if (start && scope.first) rows.unshift(scope.first);
    return rows;
  } finally { fs.closeSync(fd); }
}

// Scan metadata backwards without retaining large tool-output lines.
function* matchingRecords(file, pattern, floor = 0) {
  const fd = fs.openSync(file, "r");
  try {
    let end = fs.fstatSync(fd).size, lineEnd = end;
    while (end > floor) {
      const start = Math.max(floor, end - 262144), block = Buffer.alloc(end - start);
      fs.readSync(fd, block, 0, block.length, start);
      let cursor = block.length;
      for (;;) {
        const newline = cursor > 0 ? block.lastIndexOf(10, cursor - 1) : -1;
        if (newline < 0 && start > floor) break;
        const position = start + newline + 1, length = lineEnd - position;
        if (length > 0) {
          const head = Buffer.alloc(Math.min(512, length));
          fs.readSync(fd, head, 0, head.length, position);
          if (pattern.test(head.toString("utf8"))) {
            const line = Buffer.alloc(length);
            fs.readSync(fd, line, 0, line.length, position);
            try { yield JSON.parse(line.toString("utf8")); } catch {}
          }
        }
        lineEnd = start + newline;
        if (newline < 0) break;
        cursor = newline;
      }
      end = start;
    }
  } finally { fs.closeSync(fd); }
}

function latestContext(file) {
  const { start } = historyScope(file);
  if (start === null) return null;
  for (const row of matchingRecords(file, /"type"\s*:\s*"turn_context"/, start)) if (row.type === "turn_context" && row.payload?.model) return row.payload;
  return null;
}

function describe(file, kind, meta = {}) {
  const child = { path: file, provider: kind, ...meta };
  let hasContext = false, hasMetadata = false;
  for (const r of records(file)) {
    if (kind === "claude") {
      const m = r.message ?? {};
      if (!child.id && r.sessionId) child.id = r.sessionId;
      if (m.model && m.model !== "<synthetic>") child.model = m.model;
      if (r.perTurnEffort) child.effort = r.perTurnEffort;
      const text = typeof m.content === "string" ? m.content : (m.content ?? []).filter(p => p.type === "text").map(p => p.text).join("\n");
      if (r.type === "user" && text && !child.prompt) child.prompt = text.slice(0, 4000);
      if (r.type === "api-request" || (r.type === "assistant" && !r.isApiErrorMessage && m.model !== "<synthetic>")) {
        if (child.status === "completed") { delete child.delivery; delete child.result; }
        Object.assign(child, { status: "running", waitingReason: null, updated: Date.parse(r.timestamp) || 0 });
      }
      if (r.type === "assistant" && r.isApiErrorMessage) Object.assign(child, {
        status: r.error === "rate_limit" ? "waiting" : "failed", waitingReason: r.error === "rate_limit" ? "api_limit" : null,
        error: text.slice(0, 4000), updated: Date.parse(r.timestamp) || 0 });
      else if (r.type === "assistant" && text && child.delivery !== "reported") child.result = text.slice(-4000);
      for (const item of Array.isArray(m.content) ? m.content : []) if (item.type === "tool_use" && item.name === "SubagentHandback" && typeof item.input?.message === "string") {
        Object.assign(child, { result: item.input.message.slice(0, 4000), delivery: "reported" });
      }
      if (r.type === "user" && r.toolEndsTurn === true) Object.assign(child, {
        status: r.toolUseResult?.success === false ? "failed" : "completed", waitingReason: null, updated: Date.parse(r.timestamp) || 0 });
    } else {
      const p = r.payload ?? {};
      if (r.type === "session_meta") {
        if (hasMetadata) continue;
        hasMetadata = true;
        const sub = p.source?.subagent ?? {}, spawn = sub.thread_spawn ?? {};
        if (["guardian", "review"].includes(sub.other)) return null;
        Object.assign(child, { id: p.id, parent: p.parent_thread_id ?? spawn.parent_thread_id, model: p.model ?? spawn.model,
          label: p.agent_nickname ?? spawn.agent_nickname ?? child.label, agentPath: p.agent_path ?? spawn.agent_path });
      } else if (r.type === "turn_context") { hasContext = true; Object.assign(child, { model: p.model, effort: p.effort ?? p.reasoning_effort }); }
      else if (r.type === "response_item" && p.type === "message" && p.role === "assistant") child.result = (p.content ?? []).filter(i => i.type === "output_text").map(i => i.text).join("\n").slice(-4000);
      else if (["task_complete", "turn_aborted"].includes(p.type)) child.status = p.type === "turn_aborted" ? "interrupted" : p.error ? "failed" : "completed";
      else if (p.type === "task_started") child.status = "running";
    }
  }
  if (kind === "codex" && !hasContext) {
    const context = latestContext(file);
    if (context) Object.assign(child, { model: context.model, effort: context.effort ?? context.reasoning_effort });
  }
  return Object.fromEntries(Object.entries(child).filter(([key, v]) => v != null || key === "waitingReason"));
}

export async function children(file, kind, ids, root = file) {
  const parent = kind === "claude" ? path.basename(file, ".jsonl").replace(/^agent-/, "") : path.basename(file, ".jsonl").slice(-36), found = [];
  if (kind === "claude") {
    const dir = root.replace(/\.jsonl$/, "") + "/subagents", calls = new Set();
    for (const row of matchingRecords(file, /"role"\s*:\s*"assistant"/)) {
      if (row.type !== "assistant" || (file !== root && row.agentId && row.agentId !== parent) || (file === root && row.isSidechain)) continue;
      for (const item of Array.isArray(row.message?.content) ? row.message.content : []) if (item.type === "tool_use" && ["Agent", "Task"].includes(item.name)) calls.add(item.id);
    }
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith(".meta.json")).slice(-128) : []) {
      try {
        const meta = readJSON(path.join(dir, name));
        if (!meta.toolUseId || !calls.has(meta.toolUseId)) continue;
        const child = describe(path.join(dir, name.replace(/\.meta\.json$/, ".jsonl")), kind, { id: name.replace(/^agent-|\.meta\.json$/g, ""), call: meta.toolUseId, parent });
        if (child) {
          child.label = meta.description;
          if (meta.finished && child.status === "running") { child.status = "completed"; child.updated = fs.statSync(path.join(dir, name)).mtimeMs; }
          found.push(child);
        }
      } catch {}
    }
  } else {
    const calls = new Map();
    if (fs.existsSync(file)) {
      const { start } = historyScope(file);
      if (start !== null) for (const row of matchingRecords(file, /"type"\s*:\s*"function_call"/, start)) {
        const p = row.payload;
        if (p?.type !== "function_call" || p.name?.split(".").at(-1) !== "spawn_agent") continue;
        try { const task = JSON.parse(p.arguments).task_name; if (task && !calls.has(task)) calls.set(task, p.call_id); } catch {}
      }
    }
    const root = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    const db = fs.existsSync(root) && fs.readdirSync(root).filter(n => /^state_.*\.sqlite$/.test(n)).sort().at(-1);
    if (db) {
      let conn;
      try {
        const { DatabaseSync } = await import("node:sqlite");
        conn = new DatabaseSync(path.join(root, db), { readOnly: true });
        const columns = new Set(conn.prepare("pragma table_info(threads)").all().map(r => r.name));
        if (!columns.has("id") || !columns.has("rollout_path")) return found;
        const clauses = [], args = [];
        if (ids.length) { clauses.push(`id in (${ids.map(() => "?").join(",")})`); args.push(...ids); }
        if (columns.has("source")) { clauses.push("source like ?"); args.push(`%${parent}%`); }
        if (!clauses.length) return found;
        for (const row of conn.prepare(`select rollout_path${columns.has("title") ? ", title" : ""} from threads where ${clauses.join(" or ")} limit 128`).all(...args)) {
          try {
            const child = describe(row.rollout_path, kind, { label: row.title });
            if (child?.parent === parent) { child.call = calls.get(child.agentPath?.split("/").at(-1)); found.push(child); }
          } catch {}
        }
      } catch { /* Older Node/Codex versions still expose children through the event snapshot. */ }
      finally { conn?.close(); }
    }
  }
  return found;
}

export async function descendants(file, kind, ids = [], root = file, budget = { left: 128 }, seen = new Set()) {
  if (budget.left <= 0 || seen.has(file)) return [];
  seen.add(file);
  let list;
  try { list = await children(file, kind, ids, root); } catch { return []; }
  const result = [];
  for (const child of list) {
    if (budget.left <= 0) break;
    if (seen.has(child.path)) continue;
    budget.left--;
    child.children = await descendants(child.path, kind, [], root, budget, seen);
    result.push(child);
  }
  return result;
}

export function elicitationResponse(request, decision) {
  if (decision === null) return null; // The person chose to answer in the terminal.
  if (!decision) throw new Error("Invalid permission answer; no answer was sent");
  if (decision.behavior === "deny") return { action: "cancel" };
  const e = request.elicitation, values = decision.updatedInput?.answers;
  if (decision.behavior !== "allow" || !e || e.unsupported || !values || Object.keys(values).length !== 1 || !e.values.includes(values[e.question])) {
    throw new Error("Choose an option from this permission card; no answer was sent");
  }
  return { action: "accept", content: { [e.property]: values[e.question] } };
}

export function answer(folder, id, expected, text, how) {
  if (!/^[\w.-]+$/.test(id) || id.includes("..")) throw new Error("Invalid request identity");
  if (!isDeepStrictEqual(readJSON(path.join(folder, "req", `${id}.json`)), expected)) throw new Error("This request changed; no answer was sent");
  if (!alive(id.split(".").at(-1))) throw new Error("This provider request is no longer live");
  if (expected.elicitation) elicitationResponse(expected, text ? JSON.parse(text).hookSpecificOutput?.decision : null);
  const temp = path.join(folder, "ans", `${id}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.linkSync(temp, path.join(folder, "ans", `${id}.json`));
    if (how) atomicWrite(path.join(folder, "end", id), how + "\n");
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return true;
}

export async function operation(action, args) {
  if (action === "scope") return { start: historyScope(args[0]).start };
  if (action === "hook") return writeEvent(args[0], args[1], claudeHook(JSON.parse(fs.readFileSync(0, "utf8"))));
  if (action === "paths") {
    const app = process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config/herdr-app");
    return { app, home: os.homedir(), platform: process.platform === "darwin" ? "Darwin" : process.platform, spool: process.env.HERDR_HC_SPOOL || (args[0] ? `${app}/sandbox/broker/${args[0]}` : `${app}/data`) };
  }
  if (action === "children") return children(args[0], args[1], JSON.parse(args[2]));
  if (action === "tree") return descendants(args[0], args[1], JSON.parse(args[2]), args[3] || args[0]);
  if (action === "sessions") {
    const requests = JSON.parse(args[0]);
    if (!Array.isArray(requests) || requests.length > 128) throw new Error("Invalid session list");
    const result = [], budget = { left: 128 };
    for (const request of requests) {
      if (typeof request?.terminal !== "string" || typeof request.path !== "string" || !["codex", "claude"].includes(request.kind)) throw new Error("Invalid session identity");
      const terminal = request.terminal.split("/").pop();
      if (!/^[\w.-]+$/.test(terminal) || terminal.includes("..") || (request.box != null && (!/^[\w.-]+$/.test(request.box) || request.box.includes("..")))) throw new Error("Invalid session identity");
      try {
        const info = describe(request.path, request.kind);
        if (info) {
          info.children = await descendants(request.path, request.kind, [], request.path, budget);
          if (request.kind === "codex") {
            const app = process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config/herdr-app");
            const folders = request.box ? [`${app}/sandbox/broker/${request.box}`, `${app}/data`] : [`${app}/data`];
            for (const folder of folders) {
              try { info.events = Object.values(readJSON(`${folder}/chat-events/${terminal}.state.json`).events ?? {}).filter(e => e.src === "codex" && e.ev === "child").slice(-512); break; } catch {}
            }
          }
          result.push({ ...info, terminal: request.terminal });
        }
      } catch { /* Keep other sessions when one transcript has disappeared. */ }
    }
    return result;
  }
  if (action === "answer") return answer(args[0], args[1], JSON.parse(args[2]), args[3], args[4]);
  if (action === "ask-end") {
    const request = readJSON(args[0]), results = new Map();
    let use, last;
    for (const r of records(request.transcript_path, 1048576)) for (const item of Array.isArray(r.message?.content) ? r.message.content : []) {
      if (item.type === "tool_use" && item.name === request.tool_name) {
        last = item.id;
        if (isDeepStrictEqual(item.input, request.tool_input)) use = item.id;
      } else if (item.type === "tool_result") results.set(item.tool_use_id, item);
    }
    const result = results.get(use ?? last);
    if (!result) return "";
    return result.is_error && /doesn't want to proceed|rejected|interrupted/.test(JSON.stringify(result.content)) ? "declined" : "answered";
  }
  throw new Error("Unknown session operation");
}

export async function run(args) {
  try { const value = await operation(args[0], args.slice(1)); if (args[0] !== "hook") process.stdout.write(args[0] === "ask-end" ? value : JSON.stringify(value)); }
  catch (e) { if (args[0] !== "hook") { console.error(e.message); process.exitCode = 1; } }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await run(process.argv.slice(2));
