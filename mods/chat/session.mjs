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

function records(file, limit = 262144) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - limit);
    const head = Buffer.alloc(Math.min(65536, size)), tail = Buffer.alloc(Math.min(size, limit));
    fs.readSync(fd, head, 0, head.length, 0); fs.readSync(fd, tail, 0, tail.length, start);
    const lines = tail.toString("utf8").split("\n");
    if (start) { lines.shift(); lines.unshift(head.toString("utf8").split("\n")[0]); }
    return lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } finally { fs.closeSync(fd); }
}

function describe(file, kind, meta = {}) {
  const child = { path: file, provider: kind, ...meta };
  for (const r of records(file)) {
    if (kind === "claude") {
      const m = r.message ?? {};
      if (m.model && m.model !== "<synthetic>") child.model = m.model;
      if (r.perTurnEffort) child.effort = r.perTurnEffort;
      const text = typeof m.content === "string" ? m.content : (m.content ?? []).filter(p => p.type === "text").map(p => p.text).join("\n");
      if (r.type === "user" && text && !child.prompt) child.prompt = text.slice(0, 4000);
      if (r.type === "assistant" && text) child.result = text.slice(-4000);
    } else {
      const p = r.payload ?? {};
      if (r.type === "session_meta") {
        const sub = p.source?.subagent ?? {}, spawn = sub.thread_spawn ?? {};
        if (["guardian", "review"].includes(sub.other)) return null;
        Object.assign(child, { id: p.id, parent: p.parent_thread_id ?? spawn.parent_thread_id, model: p.model ?? spawn.model });
      } else if (r.type === "turn_context") Object.assign(child, { model: p.model, effort: p.effort ?? p.reasoning_effort });
      else if (r.type === "response_item" && p.type === "message" && p.role === "assistant") child.result = (p.content ?? []).filter(i => i.type === "output_text").map(i => i.text).join("\n").slice(-4000);
      else if (["task_complete", "turn_aborted"].includes(p.type)) child.status = p.type === "turn_aborted" ? "interrupted" : p.error ? "failed" : "completed";
      else if (p.type === "task_started") child.status = "running";
    }
  }
  return Object.fromEntries(Object.entries(child).filter(([, v]) => v != null));
}

export async function children(file, kind, ids) {
  const parent = path.basename(file, ".jsonl").slice(-36), found = [];
  if (kind === "claude") {
    const dir = file.replace(/\.jsonl$/, "") + "/subagents";
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith(".meta.json")).slice(-128) : []) {
      try {
        const meta = readJSON(path.join(dir, name));
        if (!meta.toolUseId) continue;
        const child = describe(path.join(dir, name.replace(/\.meta\.json$/, ".jsonl")), kind, { id: name.replace(/^agent-|\.meta\.json$/g, ""), call: meta.toolUseId, parent });
        if (child) found.push(child);
      } catch {}
    }
  } else {
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
        for (const row of conn.prepare(`select rollout_path from threads where ${clauses.join(" or ")} limit 128`).all(...args)) {
          try { const child = describe(row.rollout_path, kind); if (child?.parent === parent) found.push(child); } catch {}
        }
      } catch { /* Older Node/Codex versions still expose children through the event snapshot. */ }
      finally { conn?.close(); }
    }
  }
  return found;
}

export function answer(folder, id, expected, text, how) {
  if (!/^[\w.-]+$/.test(id) || id.includes("..")) throw new Error("Invalid request identity");
  if (!isDeepStrictEqual(readJSON(path.join(folder, "req", `${id}.json`)), expected)) throw new Error("This request changed; no answer was sent");
  if (!alive(id.split(".").at(-1))) throw new Error("This provider request is no longer live");
  const temp = path.join(folder, "ans", `${id}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.linkSync(temp, path.join(folder, "ans", `${id}.json`));
    if (how) atomicWrite(path.join(folder, "end", id), how + "\n");
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return true;
}

export async function operation(action, args) {
  if (action === "hook") return writeEvent(args[0], args[1], claudeHook(JSON.parse(fs.readFileSync(0, "utf8"))));
  if (action === "paths") {
    const app = process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config/herdr-app");
    return { app, home: os.homedir(), platform: process.platform === "darwin" ? "Darwin" : process.platform, spool: process.env.HERDR_HC_SPOOL || (args[0] ? `${app}/sandbox/broker/${args[0]}` : `${app}/data`) };
  }
  if (action === "children") return children(args[0], args[1], JSON.parse(args[2]));
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
