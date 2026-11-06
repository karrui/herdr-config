// Observe the TUI's private app-server; approvals are answered only by a person's card response.
import * as fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { writeEvent, atomicWrite, alive, elicitationResponse } from "./session.mjs";

const clip = (text, n = 4000) => typeof text === "string" && text.length > n ? text.slice(0, n - 1) + "…" : text;
const remove = file => { try { fs.unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; } };

export class RpcSocket {
  constructor(socket, head, onMessage, onClose) {
    this.socket = socket; this.buffer = head; this.parts = []; this.bytes = 0;
    this.onMessage = onMessage;
    socket.on("data", bytes => { this.buffer = Buffer.concat([this.buffer, bytes]); this.read(); });
    socket.on("close", onClose); socket.on("error", () => socket.destroy());
  }
  static connect(socketPath, onMessage, onClose) {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const request = http.request({ socketPath, path: "/", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" } });
      request.on("upgrade", (response, socket, head) => {
        const expected = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        if (response.headers["sec-websocket-accept"] !== expected) { socket.destroy(); reject(new Error("Invalid app-server handshake")); return; }
        socket.pause(); resolve(new RpcSocket(socket, head, onMessage, onClose));
      });
      request.on("response", response => { response.resume(); reject(new Error(`App-server refused connection: ${response.statusCode}`)); });
      request.on("error", reject); request.setTimeout(10000, () => request.destroy(new Error("App-server connection timed out"))); request.end();
    });
  }
  start() { this.read(); this.socket.resume(); }
  frame(op, data) {
    const mask = randomBytes(4), header = Buffer.alloc(data.length < 126 ? 2 : data.length < 65536 ? 4 : 10);
    header[0] = 0x80 | op; header[1] = 0x80 | (data.length < 126 ? data.length : data.length < 65536 ? 126 : 127);
    if (header.length === 4) header.writeUInt16BE(data.length, 2);
    if (header.length === 10) header.writeBigUInt64BE(BigInt(data.length), 2);
    const payload = Buffer.from(data);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, payload]));
  }
  send(message) { this.frame(1, Buffer.from(JSON.stringify(message))); }
  read() {
    while (this.buffer.length >= 2) {
      const b = this.buffer, op = b[0] & 15;
      let size = b[1] & 127, offset = 2;
      if (size === 126) { if (b.length < 4) return; size = b.readUInt16BE(2); offset = 4; }
      else if (size === 127) { if (b.length < 10) return; size = Number(b.readBigUInt64BE(2)); offset = 10; }
      if ((b[1] & 128) || size > 16777216 || this.bytes + size > 16777216) { this.socket.destroy(); return; }
      if (b.length < offset + size) return;
      const payload = b.subarray(offset, offset + size); this.buffer = b.subarray(offset + size);
      if (op === 8) { this.socket.end(); return; }
      if (op === 9) { this.frame(10, payload); continue; }
      if (![0, 1, 2].includes(op)) continue;
      this.parts.push(payload); this.bytes += size;
      if (b[0] & 128) {
        const data = Buffer.concat(this.parts); this.parts = []; this.bytes = 0;
        try { this.onMessage(JSON.parse(data.toString("utf8"))); } catch (e) { console.error(`codex-tap: ${e.message}`); }
      }
    }
  }
}

export class CodexTap {
  constructor(socketPath, folder, terminal, serverPid) {
    this.socketPath = socketPath; this.folder = folder; this.terminal = terminal; this.serverPid = serverPid;
    this.asks = path.join(folder, "chat-asks"); this.parent = process.ppid;
    this.calls = new Map(); this.joined = new Map(); this.joining = new Set(); this.children = new Map();
    this.pending = new Map(); this.changes = new Map(); this.reply = null; this.seq = 0; this.asked = 0;
    this.writes = Promise.resolve();
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
  }
  emit(ev, fields = {}) {
    this.writes = this.writes.then(() => writeEvent(this.folder, this.terminal, { src: "codex", ev, ...fields })).catch(e => console.error(`codex-tap: ${e.message}`));
  }
  call(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error(`${method} timed out`)); }, 15000); timer.unref();
      this.calls.set(id, { resolve, reject, timer });
      this.conn.send({ id, method, params });
    });
  }
  handle(message) {
    if (message.method && message.id != null) this.ask(message);
    else if (message.id != null) {
      const call = this.calls.get(message.id);
      if (!call) return;
      clearTimeout(call.timer); this.calls.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message ?? "App-server rejected request")); else call.resolve(message.result);
    } else if (message.method) this.note(message.method, message.params ?? {});
  }
  async join(id) {
    if (!id || this.joined.has(id) || this.joining.has(id)) return;
    this.joining.add(id);
    try {
      const result = await this.call("thread/resume", { threadId: id, excludeTurns: true }), thread = result.thread ?? {};
      this.joined.set(id, result.cwd ?? thread.cwd);
      const parent = thread.parentThreadId ?? this.children.get(id)?.parent;
      this.emit("joined", { thread: id, rollout: thread.path, cwd: thread.cwd, parent,
        permission: result.approvalPolicy || result.sandbox ? { approval: result.approvalPolicy, sandbox: result.sandbox, confirmed: true } : undefined });
      if (parent && !/guardian|review/i.test(JSON.stringify(thread.source ?? ""))) this.child(id, { parent, path: thread.path, label: thread.agentNickname ?? thread.name, model: thread.model, effort: thread.reasoningEffort });
      if (thread.path && !parent) {
        if (this.held != null) fs.closeSync(this.held);
        try { this.held = fs.openSync(thread.path, "r"); } catch { this.held = null; }
      }
      // Joining can miss the first starts; reconcile the latest turn when the server supports paging.
      try {
        const observedAt = Date.now();
        const page = await this.call("thread/turns/list", { threadId: id, limit: 1, sortDirection: "desc", itemsView: "full" });
        const turn = page.data?.[0];
        if (turn) {
          this.note(turn.status === "inProgress" ? "turn/started" : "turn/completed", { threadId: id, turn, observedAt });
          const items = turn.items ?? [];
          for (const [index, item] of items.entries()) {
            const running = turn.status === "inProgress" && item.completedAtMs == null && (item.status === "inProgress" || (!item.status && index === items.length - 1));
            this.note(running ? "item/started" : "item/completed", { threadId: id, turnId: turn.id, item, observedAt });
          }
        }
      } catch { /* Older app-servers recover their history from the provider log. */ }
    } catch { /* A new thread may not have a rollout yet; poll retries. */ }
    finally { this.joining.delete(id); }
  }
  async poll() {
    try { for (const id of (await this.call("thread/loaded/list", {})).data ?? []) void this.join(id); } catch {}
  }
  child(id, fields) {
    const { observedAt, ...observations } = fields;
    const previous = this.children.get(id) ?? {};
    const at = observedAt ?? Date.now();
    if ((previous.observedAt ?? 0) > at) return;
    const next = { ...previous, ...Object.fromEntries(Object.entries(observations).filter(([, v]) => v != null)), observedAt: at };
    this.children.set(id, next);
    if (next.parent) { const { parent, observedAt, ...rest } = next; this.emit("child", { thread: parent, child: id, ...rest, t: observedAt }); }
  }
  collaboration(parent, item, observedAt) {
    if (item.type === "collabAgentToolCall") {
      for (const id of item.receiverThreadIds ?? []) {
        if (!["spawnAgent", "resumeAgent"].includes(item.tool) && !this.children.has(id)) continue;
        const state = item.agentsStates?.[id] ?? {};
        this.child(id, { observedAt, status: state.status, result: clip(state.message), ...(item.tool === "spawnAgent" ? {
          parent, call: item.id, prompt: clip(item.prompt), label: clip(item.prompt, 80), model: item.model, effort: item.reasoningEffort } : {}) });
        void this.join(id);
      }
    } else if (item.type === "subAgentActivity" && item.agentThreadId) {
      if (item.kind !== "interacted") this.child(item.agentThreadId, {
        parent: this.children.get(item.agentThreadId)?.parent ?? parent, observedAt,
        status: ({ started: "running", completed: "completed", interrupted: "interrupted" })[item.kind] });
      void this.join(item.agentThreadId);
    }
  }
  item(item) {
    const value = { item: item.id, type: item.type, status: item.status };
    if (item.type === "agentMessage") Object.assign(value, { text: clip(item.text, 12000), phase: item.phase });
    else if (item.type === "reasoning") value.text = clip((item.summary ?? []).join("\n\n"), 12000);
    else if (item.type === "commandExecution") Object.assign(value, { command: clip(item.command, 300), exit: item.exitCode });
    else if (item.type === "fileChange") value.files = (item.changes ?? []).slice(0, 20).map(c => c.path);
    else if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(item.type)) Object.assign(value, { server: item.server, tool: item.tool });
    else if (item.type === "webSearch") value.query = clip(item.query, 300);
    return value;
  }
  flush() {
    if (!this.reply) return;
    this.emit("item/agentMessage/delta", this.reply); this.reply = null;
  }
  note(method, p) {
    const id = p.threadId, at = { thread: id, turn: p.turnId, ...(p.observedAt != null ? { t: p.observedAt } : {}) };
    if (method === "item/agentMessage/delta") {
      if (this.reply && (this.reply.item !== p.itemId || this.reply.thread !== id)) this.flush();
      this.reply ??= { ...at, item: p.itemId, delta: "" }; this.reply.delta += p.delta ?? "";
      if (this.reply.delta.length >= 2000) this.flush();
      return;
    }
    this.flush();
    if (method === "thread/started") { void this.join(p.thread?.id); return; }
    if (method === "thread/status/changed") {
      void this.join(id); this.emit(method, { ...at, status: p.status?.type, flags: p.status?.activeFlags });
      if (this.children.has(id) && p.status?.type === "active") this.child(id, { status: p.status.activeFlags?.length ? "waiting" : "running" });
    } else if (["turn/started", "turn/completed"].includes(method)) {
      const done = method === "turn/completed", turn = p.turn ?? {};
      this.emit(method, { ...at, turn: turn.id, status: done ? turn.status : undefined, error: clip(turn.error?.message, 500) });
      if (this.children.has(id)) this.child(id, { status: done ? turn.status : "running", error: clip(turn.error?.message, 500), observedAt: p.observedAt });
    } else if (["item/started", "item/completed"].includes(method)) {
      const item = p.item ?? {};
      if (item.type === "fileChange") { if (method === "item/started") this.changes.set(item.id, item.changes ?? []); else this.changes.delete(item.id); }
      this.collaboration(id, item, p.observedAt); this.emit(method, { ...at, ...this.item(item) });
      if (method === "item/completed" && item.type === "agentMessage" && this.children.has(id) && ["final", "final_answer"].includes(item.phase)) this.child(id, { result: clip(item.text), observedAt: p.observedAt });
    } else if (method === "item/reasoning/summaryTextDelta") this.emit(method, { ...at, item: p.itemId, part: p.summaryIndex, delta: p.delta });
    else if (method === "item/fileChange/patchUpdated") this.changes.set(p.itemId, p.changes ?? []);
    else if (method === "turn/plan/updated") this.emit(method, { ...at, explanation: clip(p.explanation, 500), plan: (p.plan ?? []).slice(0, 50).map(s => ({ step: clip(s.step, 200), status: s.status })) });
    else if (method === "error") this.emit(method, { ...at, error: clip(p.error?.message, 500), retry: p.willRetry });
    else if (method === "serverRequest/resolved") {
      for (const [aid, request] of this.pending) if (request.id === p.requestId) {
        this.pending.delete(aid); atomicWrite(path.join(this.asks, "end", aid), "Answered in the terminal\n");
        remove(path.join(this.asks, "req", `${aid}.json`)); remove(path.join(this.asks, "ans", `${aid}.json`));
      }
    } else if (method === "thread/closed") {
      this.joined.delete(id); this.emit(method, at);
      if (this.children.has(id) && !["completed", "failed", "errored", "interrupted", "shutdown"].includes(this.children.get(id).status)) this.child(id, { status: "unavailable" });
    }
  }
  words(method, p) {
    const cwd = p.cwd ?? this.joined.get(p.threadId);
    if (method === "item/commandExecution/requestApproval") return { tool_name: "Bash", cwd, tool_input: { command: p.command || p.reason || "a command", description: p.reason } };
    if (method === "item/fileChange/requestApproval") return { tool_name: "apply_patch", cwd, tool_input: { reason: p.reason, files: (this.changes.get(p.itemId) ?? []).map(c => ({ path: c.path, kind: c.kind?.type, diff: c.diff })) } };
    if (method === "item/permissions/requestApproval") return { tool_name: "request_permissions", cwd, tool_input: { reason: p.reason, permissions: p.permissions } };
    if (method === "mcpServer/elicitation/request") {
      const schema = p.requestedSchema, fields = Object.entries(schema?.properties ?? {}), [property, field] = fields[0] ?? [];
      const choices = Array.isArray(field?.oneOf) ? field.oneOf.map(o => ({ label: o?.title, value: o?.const, description: o?.description }))
        : Array.isArray(field?.enum) ? field.enum.map((value, i) => ({ label: field.enumNames?.[i] ?? value, value })) : null;
      // shortcut: only a required single-choice form is answerable here; other MCP forms stay native.
      if (["form", "openai/form", "openaiForm"].includes(p.mode) && schema?.type === "object" && fields.length === 1 && schema.required?.includes(property)
        && field?.type === "string" && choices?.length && choices.every(o => typeof o.label === "string" && o.label && typeof o.value === "string" && o.value)) {
        const question = [p.message, field.title, field.description].filter(Boolean).join("\n\n") || `Permission for ${p.serverName}`;
        return { tool_name: "AskUserQuestion", cwd, elicitation: { property, question, values: choices.map(o => o.value) },
          tool_input: { questions: [{ question, strict: true, options: choices }] } };
      }
      return { tool_name: "McpElicitation", cwd, elicitation: { unsupported: true },
        tool_input: { message: p.message ?? p.title ?? "Permission required", detail: [p.description, p.url, "Answer this request in the terminal."].filter(Boolean).join("\n") } };
    }
    if (method === "item/tool/requestUserInput" && p.questions?.length && !p.questions.some(q => q.isSecret)) return {
      tool_name: "AskUserQuestion", cwd, tool_input: { questions: p.questions.map(q => ({ question: q.question, header: q.header, multiSelect: false, options: q.options ?? [] })) } };
    return null;
  }
  ask(message) {
    const p = message.params ?? {}, request = this.words(message.method, p);
    if (!request) return;
    const id = `${this.terminal}.${++this.asked}.${Math.floor(Date.now() / 1000)}.${process.pid}`;
    Object.assign(request, { session_id: p.threadId, turn_id: p.turnId, request_id: message.id });
    atomicWrite(path.join(this.asks, "req", `${id}.json`), JSON.stringify(request));
    this.pending.set(id, message);
    if (this.children.has(p.threadId)) this.child(p.threadId, { status: "waiting" });
  }
  answer(id, decision) {
    const request = this.pending.get(id);
    if (!request) return;
    const p = request.params, allow = decision?.behavior === "allow", message = decision?.message;
    let result;
    if (request.method === "mcpServer/elicitation/request") result = elicitationResponse(this.words(request.method, p), decision);
    else if (!decision) result = null;
    else if (request.method === "item/tool/requestUserInput") {
      const values = decision.updatedInput?.answers ?? {};
      result = { answers: Object.fromEntries((p.questions ?? []).map(q => [q.id, { answers: [allow ? String(values[q.question] ?? "") : message].filter(Boolean) }])) };
    } else if (request.method === "item/permissions/requestApproval") result = allow ? { permissions: p.permissions ?? {}, scope: "turn" } : { permissions: {} };
    else result = { decision: allow ? "accept" : "decline" };
    if (result) this.conn.send({ id: request.id, result });
    this.pending.delete(id);
    remove(path.join(this.asks, "req", `${id}.json`)); remove(path.join(this.asks, "ans", `${id}.json`));
    if (!allow && message && message !== "The person declined this in the chat." && !["item/tool/requestUserInput", "mcpServer/elicitation/request"].includes(request.method)) {
      void this.call("turn/steer", { threadId: p.threadId, expectedTurnId: p.turnId, input: [{ type: "text", text: message, text_elements: [] }] }).catch(e => this.emit("error", { thread: p.threadId, error: e.message }));
    }
  }
  answers() {
    for (const id of this.pending.keys()) {
      const file = path.join(this.asks, "ans", `${id}.json`);
      try {
        const text = fs.readFileSync(file, "utf8");
        let decision = null;
        try { if (text.trim()) decision = JSON.parse(text).hookSpecificOutput?.decision; }
        catch { if (Date.now() - fs.statSync(file).mtimeMs < 1000) continue; }
        this.answer(id, decision);
      } catch (e) { if (e.code !== "ENOENT") console.error(`codex-tap: ${e.message}`); }
    }
  }
  async start() {
    for (const dir of ["req", "ans", "end"]) fs.mkdirSync(path.join(this.asks, dir), { recursive: true });
    this.conn = await RpcSocket.connect(this.socketPath, m => this.handle(m), () => { void this.stop(); });
    this.conn.start();
    await this.call("initialize", { clientInfo: { name: "herdr-tap", version: "2" }, capabilities: { experimentalApi: true } });
    this.conn.send({ method: "initialized" }); void this.poll();
    this.timer = setInterval(() => { this.flush(); this.answers(); }, 100);
    this.poller = setInterval(() => {
      void this.poll();
      if (process.ppid !== this.parent) { try { process.kill(this.serverPid, "SIGTERM"); } catch {} void this.stop(); }
    }, 2000);
  }
  async stop() {
    if (this.stopped) return this.writes;
    this.stopped = true; clearInterval(this.timer); clearInterval(this.poller); this.flush();
    this.conn?.socket.destroy();
    for (const [id, call] of this.calls) { clearTimeout(call.timer); call.reject(new Error("Agent connection closed")); this.calls.delete(id); }
    for (const id of this.joined.keys()) this.emit("transport", { thread: id, status: "disconnected" });
    for (const [id, child] of this.children) if (!["completed", "failed", "errored", "interrupted", "shutdown"].includes(child.status)) this.child(id, { status: "unavailable" });
    for (const id of this.pending.keys()) {
      atomicWrite(path.join(this.asks, "end", id), "Agent stopped\n"); remove(path.join(this.asks, "req", `${id}.json`)); remove(path.join(this.asks, "ans", `${id}.json`));
    }
    if (this.held != null) { fs.closeSync(this.held); this.held = null; }
    await this.writes;
    this.resolveClosed();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [socket, folder, terminal, server] = process.argv.slice(2), parent = process.ppid;
  let tap, stopping = false;
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => { stopping = true; void tap?.stop().finally(() => process.exit()); });
  while (!stopping && alive(server) && process.ppid === parent) {
    tap = new CodexTap(socket, folder, terminal, Number(server));
    try { await tap.start(); } catch (e) { console.error(`codex-tap: ${e.message}`); await tap.stop(); }
    await tap.closed;
    if (!stopping && alive(server)) await delay(500);
  }
}
