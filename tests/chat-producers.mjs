import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeEvent, claudeHook, children, answer, operation } from "../mods/chat/session.mjs";
import { CodexTap, RpcSocket } from "../mods/chat/codex-tap.mjs";

function temp(t) { const folder = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-chat-test-")); t.after(() => fs.rmSync(folder, { recursive: true, force: true })); return folder; }
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await delay(20); } assert.fail("Condition did not settle"); }

test("event journal serializes concurrent producers and retains lineage through rotation", async t => {
  const folder = temp(t), moduleURL = new URL("../mods/chat/session.mjs", import.meta.url).href;
  const code = `import { writeEvent } from ${JSON.stringify(moduleURL)}; for(let i=0;i<5;i++) await writeEvent(process.argv[1], 't1', {src:'codex',ev:'child',thread:'root',child:process.argv[2],status:'running'});`;
  await Promise.all(["one", "two", "three"].map(id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, folder, id]);
    let error = ""; child.stderr.on("data", b => error += b); child.on("error", reject); child.on("exit", n => n === 0 ? resolve() : reject(new Error(error)));
  })));
  const file = path.join(folder, "chat-events/t1.jsonl"), events = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map(e => e.seq), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.equal(new Set(events.map(e => e.epoch)).size, 1);
  fs.writeFileSync(file, "x".repeat(1048577));
  const last = await writeEvent(folder, "t1", { src: "codex", ev: "child", thread: "root", child: "one", status: "completed" });
  assert.equal(json(file).seq, 16);
  assert.equal(last.epoch, events[0].epoch);
  assert.equal(Object.keys(json(file.replace(".jsonl", ".state.json")).events).length, 3);
});

test("Claude handback survives closing prose and a repeated activation", async t => {
  const folder = temp(t), input = { session_id: "root", agent_id: "child", agent_type: "Review" };
  for (const p of [{ ...input, hook_event_name: "SubagentStart" }, { ...input, hook_event_name: "PostToolUse", tool_name: "SubagentHandback", tool_input: { message: "Actual report" } }, { ...input, hook_event_name: "SubagentStop", last_assistant_message: "Goodbye" }]) {
    await writeEvent(folder, "t1", claudeHook(p));
  }
  const event = json(path.join(folder, "chat-events/t1.state.json")).events["root:child:child"];
  assert.equal(event.result, "Actual report"); assert.equal(event.status, "completed");
  const resumed = claudeHook({ ...input, hook_event_name: "SubagentStart" });
  assert.equal(resumed.ev, "SubagentStart");
});

test("late reconciliation cannot regress live child state or its persisted snapshot", async t => {
  const folder = temp(t), tap = new CodexTap('', folder, 't1', process.pid);
  tap.child('child', { parent: 'root', status: 'completed', observedAt: 300 });
  tap.child('child', { status: 'running', observedAt: 200 });
  assert.equal(tap.children.get('child').status, 'completed');
  await tap.writes;
  await writeEvent(folder, 't1', { src: 'codex', ev: 'child', thread: 'root', child: 'child', status: 'running', t: 200 });
  assert.equal(json(path.join(folder, 'chat-events/t1.state.json')).events['root:child:child'].status, 'completed');
});

test("join requests full history and keeps completed items completed during an active turn", async t => {
  const tap = new CodexTap('', temp(t), 't1', process.pid), events = [];
  tap.emit = (ev, fields) => events.push({ ev, ...fields });
  tap.call = async (method, params) => {
    if (method === 'thread/resume') return { thread: { id: 'child', parentThreadId: 'root' } };
    assert.equal(params.itemsView, 'full');
    return { data: [{ id: 'turn', status: 'inProgress', items: [{ id: 'cmd', type: 'commandExecution', status: 'completed', completedAtMs: 100 }] }] };
  };
  await tap.join('child');
  assert.equal(events.find(e => e.item === 'cmd').ev, 'item/completed');
});

test("approval answers are fenced, atomically published once, and never overwrite another viewer", t => {
  const folder = temp(t); for (const sub of ["req", "ans", "end"]) fs.mkdirSync(path.join(folder, sub));
  const id = `t1.1.${process.pid}`, expected = { session_id: "original", tool_name: "Bash" };
  fs.writeFileSync(path.join(folder, "req", `${id}.json`), JSON.stringify(expected));
  assert.throws(() => answer(folder, id, { session_id: "new" }, "allow", ""), /changed/);
  answer(folder, id, expected, "first", "Allowed");
  assert.throws(() => answer(folder, id, expected, "second", ""), { code: "EEXIST" });
  assert.equal(fs.readFileSync(path.join(folder, "ans", `${id}.json`), "utf8"), "first");
});

test("Claude child metadata correlates its own model and spawning call", async t => {
  const folder = temp(t), dir = path.join(folder, "parent/subagents"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent-child.meta.json"), JSON.stringify({ toolUseId: "call" }));
  fs.writeFileSync(path.join(dir, "agent-child.jsonl"), JSON.stringify({ type: "assistant", message: { model: "actual-model", content: [{ type: "text", text: "Result" }] } }) + "\n");
  const found = await children(path.join(folder, "parent.jsonl"), "claude", []);
  assert.equal(found[0].call, "call"); assert.equal(found[0].model, "actual-model"); assert.equal(found[0].result, "Result");
});

test("paths are resolved in the agent environment", async () => {
  const previous = { app: process.env.HERDR_APP_HOME, spool: process.env.HERDR_HC_SPOOL };
  try {
    process.env.HERDR_APP_HOME = "/srv/remote-herdr"; process.env.HERDR_HC_SPOOL = "/srv/agent-spool";
    const paths = await operation("paths", [""]);
    assert.equal(paths.app, "/srv/remote-herdr"); assert.equal(paths.spool, "/srv/agent-spool");
  } finally {
    for (const [name, value] of [["HERDR_APP_HOME", previous.app], ["HERDR_HC_SPOOL", previous.spool]]) if (value == null) delete process.env[name]; else process.env[name] = value;
  }
});

test("the shipped reader executes as a remote Node command without an installation there", t => {
  const source = fs.readFileSync(new URL('../mods/chat/session.mjs', import.meta.url), 'utf8');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source + '\nawait run(process.argv.slice(1));', '--', 'paths', ''],
    { env: { ...process.env, HERDR_APP_HOME: '/remote/herdr', HERDR_HC_SPOOL: '/remote/spool' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).spool, '/remote/spool');
});

test("Codex history lookup verifies exact parent identity and excludes guardian logs", async t => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { t.skip('This Node version has no built-in SQLite'); return; }
  const folder = temp(t), parent = '12345678-1234-1234-1234-123456789abc';
  const db = new DatabaseSync(path.join(folder, 'state_5.sqlite'));
  db.exec('create table threads(id text, rollout_path text, source text)');
  for (const [id, owner, internal] of [['child', parent, false], ['other', 'different-parent', false], ['guardian', parent, true]]) {
    const source = { subagent: internal ? { other: 'guardian' } : { thread_spawn: { parent_thread_id: owner } } };
    const file = path.join(folder, id + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, source } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
    db.prepare('insert into threads values(?,?,?)').run(id, file, JSON.stringify(source));
  }
  db.close();
  const previous = process.env.CODEX_HOME;
  // Query the isolated fixture without changing the user's process environment.
  const source = fs.readFileSync(new URL('../mods/chat/session.mjs', import.meta.url), 'utf8');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source + '\nawait run(process.argv.slice(1));', '--', 'children', `${folder}/rollout-${parent}.jsonl`, 'codex', '["child","other","guardian"]'], { env: { ...process.env, CODEX_HOME: folder }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).map(c => c.id), ['child']);
  assert.equal(process.env.CODEX_HOME, previous);
});

function frame(value, op = 1, final = true) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(data.length < 126 ? 2 : 4); head[0] = (final ? 128 : 0) | op; head[1] = data.length < 126 ? data.length : 126;
  if (head.length === 4) head.writeUInt16BE(data.length, 2);
  return Buffer.concat([head, data]);
}

async function server(t, folder, onMessage) {
  const file = path.join(folder, "rpc.sock"), sockets = new Set();
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on("data", data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 2) {
        const op = buffer[0] & 15; let length = buffer[1] & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + 4 + length) return;
        assert.ok(buffer[1] & 128, "client frames are masked");
        const mask = buffer.subarray(offset, offset + 4), payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + 4 + length);
        onMessage(op === 1 ? JSON.parse(payload) : { op, payload }, socket);
      }
    });
  });
  await new Promise(resolve => server.listen(file, resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return file;
}

test("Unix WebSocket preserves fragmented Unicode JSON and answers ping", async t => {
  const folder = temp(t), received = []; let pong = false;
  const file = await server(t, folder, (message, socket) => {
    if (message.op === 10) { pong = true; return; }
    const data = Buffer.from(JSON.stringify({ text: "子".repeat(1000) }));
    socket.write(frame(data.subarray(0, 1001), 1, false));
    socket.write(frame(Buffer.from("ping"), 9));
    socket.write(frame(data.subarray(1001), 0, true));
  });
  const conn = await RpcSocket.connect(file, message => received.push(message), () => {});
  t.after(() => conn.socket.destroy()); conn.start(); conn.send({ test: true });
  await until(() => received.length && pong);
  assert.equal(received[0].text, "子".repeat(1000));
});

test("tap round trip keeps a child running after parent completion and resolves one approval", async t => {
  const folder = temp(t), rootPath = path.join(folder, "root.jsonl"), childPath = path.join(folder, "child.jsonl");
  fs.writeFileSync(rootPath, "{}\n"); fs.writeFileSync(childPath, "{}\n"); let socket, approved;
  const file = await server(t, folder, (message, peer) => {
    socket = peer;
    if (message.id === "approval") { approved = message.result; return; }
    if (message.id == null) return;
    const result = message.method === "thread/loaded/list" ? { data: ["root"] } : message.method === "thread/resume" ? { thread: { id: message.params.threadId, path: message.params.threadId === "root" ? rootPath : childPath, parentThreadId: message.params.threadId === "child" ? "root" : null } } : { data: [] };
    peer.write(frame({ id: message.id, result }));
  });
  const tap = new CodexTap(file, folder, "t1", process.pid);
  t.after(() => tap.stop()); await tap.start(); await until(() => tap.joined.has("root"));
  for (const event of [
    { method: "item/completed", params: { threadId: "root", turnId: "t", item: { id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } }, prompt: "Review code" } } },
    { method: "turn/completed", params: { threadId: "root", turn: { id: "t", status: "completed" } } },
    { id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: "child", turnId: "ct", command: "true" } },
  ]) socket.write(frame(event));
  await until(() => tap.pending.size === 1);
  assert.equal(tap.children.get("child").status, "waiting");
  const id = [...tap.pending.keys()][0], request = json(path.join(tap.asks, "req", `${id}.json`));
  answer(tap.asks, id, request, JSON.stringify({ hookSpecificOutput: { decision: { behavior: "allow" } } }), "Allowed in chat");
  await until(() => approved);
  assert.equal(approved.decision, "accept"); assert.equal(tap.pending.size, 0);
  await tap.writes;
  assert.equal(json(path.join(folder, "chat-events/t1.state.json")).events["root:child:child"].status, "waiting");
});
