import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeEvent, claudeHook, children, answer, operation, elicitationResponse } from "../mods/chat/session.mjs";
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

test("a sibling interaction neither adopts a completed agent nor starts a new turn", async t => {
  const tap = new CodexTap('', temp(t), 't1', process.pid);
  tap.join = async () => {};
  tap.child('worker', { parent: 'root', status: 'completed', observedAt: 100 });
  tap.collaboration('sibling', { type: 'subAgentActivity', agentThreadId: 'worker', kind: 'interacted' }, 200);
  assert.equal(tap.children.get('worker').parent, 'root');
  assert.equal(tap.children.get('worker').status, 'completed');
  tap.note('turn/started', { threadId: 'worker', turn: { id: 'new-turn' }, observedAt: 300 });
  assert.equal(tap.children.get('worker').status, 'running');
  assert.equal(tap.children.get('worker').parent, 'root');
  await tap.writes;
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
  fs.writeFileSync(path.join(folder, 'parent.jsonl'), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'Agent' }] } }) + '\n');
  fs.writeFileSync(path.join(dir, "agent-child.meta.json"), JSON.stringify({ toolUseId: "call" }));
  fs.writeFileSync(path.join(dir, "agent-child.jsonl"), JSON.stringify({ type: "assistant", message: { model: "actual-model", content: [{ type: "text", text: "Result" }] } }) + "\n");
  const found = await children(path.join(folder, "parent.jsonl"), "claude", []);
  assert.equal(found[0].call, "call"); assert.equal(found[0].model, "actual-model"); assert.equal(found[0].result, "Result");
});

test("Claude history distinguishes a delivered report, an ended handback, and an API limit", async t => {
  const folder = temp(t), file = path.join(folder, 'child.jsonl');
  const rows = [{ type: 'assistant', timestamp: '2026-11-06T00:00:00Z', message: { content: [{ type: 'tool_use', id: 'report', name: 'SubagentHandback', input: { message: 'Finished the implementation' } }] } }];
  const read = async () => { fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n'); return (await operation('sessions', [JSON.stringify([{ terminal: 't1', path: file, kind: 'claude' }])]))[0]; };
  assert.notEqual((await read()).status, 'completed');
  rows.push({ type: 'user', timestamp: '2026-11-06T00:00:01Z', toolEndsTurn: true, toolUseResult: { success: true }, message: { content: [{ type: 'tool_result', tool_use_id: 'report', content: 'Delivered' }] } });
  let info = await read(); assert.equal(info.status, 'completed'); assert.equal(info.result, 'Finished the implementation');
  rows.push({ type: 'assistant', timestamp: '2026-11-06T00:00:02Z', isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your weekly limit" }] } });
  info = await read(); assert.equal(info.status, 'waiting'); assert.equal(info.waitingReason, 'api_limit');
  rows.push({ type: 'api-request', timestamp: '2026-11-06T00:00:03Z' });
  info = await read(); assert.equal(info.status, 'running'); assert.equal(info.waitingReason, null);
});

test("Claude trees match each spawning call to its actual parent, including calls before long outputs", async t => {
  const folder = temp(t), root = path.join(folder, 'root.jsonl'), dir = path.join(folder, 'root/subagents');
  fs.mkdirSync(dir, { recursive: true });
  const call = (id, agentId) => ({ type: 'assistant', agentId, isSidechain: Boolean(agentId), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: {} }] } });
  fs.writeFileSync(root, [call('spawn-a'), call('spawn-c')].map(JSON.stringify).join('\n') + '\n');
  for (const [id, toolUseId] of [['a', 'spawn-a'], ['b', 'spawn-b'], ['c', 'spawn-c']]) fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ toolUseId, description: id }));
  fs.writeFileSync(path.join(dir, 'agent-a.jsonl'), [call('spawn-b', 'a'), { type: 'user', message: { role: 'user', content: 'x'.repeat(400000) } }].map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'agent-b.jsonl'), JSON.stringify(call('spawn-a', 'b')) + '\n');
  fs.writeFileSync(path.join(dir, 'agent-c.jsonl'), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }) + '\n');
  const tree = await operation('tree', [root, 'claude', '[]']);
  assert.deepEqual(tree.map(h => h.id), ['a', 'c']);
  assert.equal(tree[0].children[0].id, 'b'); assert.equal(tree[0].children[0].parent, 'a');
  assert.equal(tree[0].children[0].children.length, 0, 'a malformed cycle cannot reattach its ancestor');
  const nested = await operation('tree', [path.join(dir, 'agent-a.jsonl'), 'claude', '[]', root]);
  assert.equal(nested[0].id, 'b');
});

test("terminal session batches read reported models and keep native identity across providers", async t => {
  const folder = temp(t), codex = path.join(folder, 'codex.jsonl'), claude = path.join(folder, 'claude.jsonl');
  fs.writeFileSync(codex, [
    { type: 'session_meta', payload: { id: 'codex-native', source: 'cli' } },
    { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ].map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(claude, JSON.stringify({ type: 'assistant', sessionId: 'claude-native', message: { model: 'claude-sonnet-4-6', content: [] } }) + '\n');
  const result = await operation('sessions', [JSON.stringify([
    { terminal: 't1', path: codex, kind: 'codex' },
    { terminal: 't2', path: claude, kind: 'claude' },
    { terminal: 'missing', path: path.join(folder, 'missing.jsonl'), kind: 'codex' },
  ])]);
  assert.deepEqual(result.map(s => [s.terminal, s.id, s.model]), [
    ['t1', 'codex-native', 'gpt-6.1-sol'], ['t2', 'claude-native', 'claude-sonnet-4-6'],
  ]);
  assert.equal(result[0].effort, 'high'); assert.equal(result[0].status, 'completed');
  await assert.rejects(operation('sessions', ['[null]']), /Invalid session identity/);
  await assert.rejects(operation('sessions', ['{}']), /Invalid session list/);
});

test('Codex child scope excludes inherited parent metadata, messages and completion', async t => {
  const folder = temp(t), file = path.join(folder, 'child.jsonl');
  const rows = [
    { type: 'session_meta', payload: { id: 'child', parent_thread_id: 'parent', subagent_history_start_ordinal: 5, source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } },
    { type: 'session_meta', payload: { id: 'parent' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Parent request' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Parent answer' }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
    { type: 'turn_context', payload: { model: 'child-model', effort: 'high' } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Child reply' }] } },
  ];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  const scope = await operation('scope', [file]);
  assert.equal(scope.start, Buffer.byteLength(rows.slice(0, 5).map(JSON.stringify).join('\n') + '\n'));
  const info = (await operation('sessions', [JSON.stringify([{ terminal: 't1', path: file, kind: 'codex' }])]))[0];
  assert.equal(info.id, 'child'); assert.equal(info.parent, 'parent'); assert.equal(info.model, 'child-model');
  assert.equal(info.status, 'running'); assert.equal(info.result, 'Child reply');
  fs.writeFileSync(file, JSON.stringify(rows[0]) + '\n');
  assert.equal((await operation('scope', [file])).start, null, 'partially copied context must wait rather than expose parent history');
});

test("Codex terminal metadata finds the latest model before a long tool output", async t => {
  const folder = temp(t), file = path.join(folder, 'long.jsonl');
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id: 'native', model: 'initial-model', source: 'cli' } },
    { type: 'turn_context', payload: { model: 'earlier-model', effort: 'low' } },
    { type: 'response_item', payload: { output: 'x'.repeat(300000) } },
    { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'xhigh' } },
    { type: 'response_item', payload: { output: 'x'.repeat(3000000) } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const [session] = await operation('sessions', [JSON.stringify([{ terminal: 't1', path: file, kind: 'codex' }])]);
  assert.equal(session.model, 'gpt-6.1-sol'); assert.equal(session.effort, 'xhigh');
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
  fs.writeFileSync(`${folder}/rollout-${parent}.jsonl`, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-call', arguments: JSON.stringify({ task_name: 'review' }) } }) + '\n');
  const db = new DatabaseSync(path.join(folder, 'state_5.sqlite'));
  db.exec('create table threads(id text, rollout_path text, source text)');
  for (const [id, owner, internal] of [['child', parent, false], ['nested', 'child', false], ['other', 'different-parent', false], ['guardian', parent, true]]) {
    const source = { subagent: internal ? { other: 'guardian' } : { thread_spawn: { parent_thread_id: owner, agent_path: '/root/review' } } };
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
  assert.equal(JSON.parse(result.stdout)[0].call, 'spawn-call', 'native IDs reconcile the saved spawn placeholder');
  const nested = spawnSync(process.execPath, ['--input-type=module', '-e', source + '\nawait run(process.argv.slice(1));', '--', 'tree', `${folder}/rollout-${parent}.jsonl`, 'codex', '[]'], { env: { ...process.env, CODEX_HOME: folder }, encoding: 'utf8' });
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(JSON.parse(nested.stdout)[0].children[0].id, 'nested');
  assert.equal(process.env.CODEX_HOME, previous);
});

test('remote session reads recover native descendants from snapshots without a SQLite index', async t => {
  const folder = temp(t), file = path.join(folder, 'root.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'root' } }) + '\n');
  const events = [{ src: 'codex', ev: 'child', thread: 'root', child: 'child', status: 'completed' },
    { src: 'codex', ev: 'child', thread: 'child', child: 'deep', status: 'running' },
    { src: 'codex', ev: 'item/agentMessage/delta', thread: 'child', delta: 'not lineage' }];
  const sandbox = path.join(folder, 'sandbox/broker/box2/chat-events'); fs.mkdirSync(sandbox, { recursive: true });
  fs.writeFileSync(path.join(sandbox, 't2.state.json'), JSON.stringify({ events: Object.fromEntries(events.map((e, i) => [i, e])) }));
  const source = fs.readFileSync(new URL('../mods/chat/session.mjs', import.meta.url), 'utf8');
  const run = requests => spawnSync(process.execPath, ['--input-type=module', '-e', source + '\nawait run(process.argv.slice(1));', '--', 'sessions', JSON.stringify(requests)],
    { env: { ...process.env, HERDR_APP_HOME: folder, CODEX_HOME: folder }, encoding: 'utf8' });
  const request = { terminal: 'vps/t2', path: file, kind: 'codex', box: 'box2' };
  let result = run([request]); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].children.length, 0);
  assert.deepEqual(JSON.parse(result.stdout)[0].events, events.slice(0, 2));
  fs.mkdirSync(path.join(folder, 'data'), { recursive: true }); fs.renameSync(sandbox, path.join(folder, 'data/chat-events'));
  result = run([request]); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout)[0].events, events.slice(0, 2), 'history survives sandbox cleanup');
  assert.notEqual(run([{ ...request, box: '../escape' }]).status, 0);
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
  fs.writeFileSync(rootPath, "{}\n"); fs.writeFileSync(childPath, "{}\n"); let socket, approved, mcpApproved;
  const file = await server(t, folder, (message, peer) => {
    socket = peer;
    if (message.id === "approval") { approved = message.result; return; }
    if (message.id === "mcp-approval") { mcpApproved = message.result; return; }
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
  socket.write(frame({ id: "mcp-approval", method: "mcpServer/elicitation/request", params: { threadId: "root", turnId: "turn", serverName: "computer", mode: "form", message: "Allow Herdr?",
    requestedSchema: { type: "object", required: ["access"], properties: { access: { type: "string", enum: ["once", "session"], enumNames: ["Allow", "Allow for this session"] } } } } }));
  await until(() => tap.pending.size === 1);
  const aid = [...tap.pending.keys()][0], req = json(path.join(tap.asks, "req", `${aid}.json`));
  await operation("answer", [tap.asks, aid, JSON.stringify(req), JSON.stringify({ hookSpecificOutput: { decision: { behavior: "allow", updatedInput: { answers: { [req.elicitation.question]: "once" } } } } }), "Answered in chat"]);
  await until(() => mcpApproved);
  assert.deepEqual(mcpApproved, { action: "accept", content: { access: "once" } });
});

test("MCP permission cards preserve exact enum values and fence invalid answers before publishing", async t => {
  const folder = temp(t), tap = new CodexTap("unused", folder, "t1", process.pid), sent = [];
  for (const dir of ["req", "ans", "end"]) fs.mkdirSync(path.join(tap.asks, dir), { recursive: true });
  tap.conn = { send: message => sent.push(message) };
  const params = { threadId: "root", turnId: "turn", serverName: "computer", mode: "form", message: 'Allow Computer Use to use "Herdr"?',
    requestedSchema: { type: "object", required: ["permission"], properties: { permission: { type: "string", oneOf: [
      { const: "allow_once", title: "Allow" }, { const: "allow_session", title: "Allow for this session" }, { const: "allow_always", title: "Always allow" },
    ] } } } };
  const approve = (request, value) => ({ behavior: "allow", updatedInput: { answers: { [request.elicitation.question]: value } } });
  for (const value of ["allow_once", "allow_session", "allow_always"]) {
    tap.ask({ id: value, method: "mcpServer/elicitation/request", params });
    const id = [...tap.pending.keys()][0], request = json(path.join(tap.asks, "req", `${id}.json`));
    assert.deepEqual(request.tool_input.questions[0].options.map(o => o.value), ["allow_once", "allow_session", "allow_always"]);
    assert.throws(() => answer(tap.asks, id, request, JSON.stringify({ hookSpecificOutput: { decision: approve(request, "Allow") } })), /Choose an option/);
    assert.throws(() => answer(tap.asks, id, request, '{}'), /Invalid permission answer/);
    assert.ok(!fs.existsSync(path.join(tap.asks, "ans", `${id}.json`)));
    assert.throws(() => tap.answer(id, approve(request, "bogus")), /Choose an option/);
    assert.ok(tap.pending.has(id) && fs.existsSync(path.join(tap.asks, "req", `${id}.json`)));
    answer(tap.asks, id, request, JSON.stringify({ hookSpecificOutput: { decision: approve(request, value) } }));
    tap.answers();
    assert.deepEqual(sent.at(-1), { id: value, result: { action: "accept", content: { permission: value } } });
    assert.equal(tap.pending.size, 0);
  }
  const request = tap.words("mcpServer/elicitation/request", params);
  assert.deepEqual(elicitationResponse(request, { behavior: "deny" }), { action: "cancel" });
  assert.equal(elicitationResponse(request, null), null);
  const legacy = tap.words("mcpServer/elicitation/request", { ...params, mode: "openai/form", requestedSchema: { type: "object", required: ["p"], properties: { p: { type: "string", enum: ["yes", "no"], enumNames: ["Allow", "Deny"] } } } });
  assert.equal(legacy.tool_input.questions[0].options[0].value, "yes");
  for (const other of [{ mode: "url", url: "https://example.com" }, { mode: "openai/userVerification", title: "Verify", challenge: "secret" },
    { mode: "form", requestedSchema: { type: "object", properties: { password: { type: "string" } } } }]) {
    const native = tap.words("mcpServer/elicitation/request", { ...params, ...other });
    assert.equal(native.tool_name, "McpElicitation");
    assert.throws(() => elicitationResponse(native, { behavior: "allow" }), /Choose an option/);
    assert.ok(!JSON.stringify(native).includes('"secret"'));
  }
  tap.ask({ id: "cancel", method: "mcpServer/elicitation/request", params });
  tap.answer([...tap.pending.keys()][0], { behavior: "deny" });
  assert.deepEqual(sent.at(-1), { id: "cancel", result: { action: "cancel" } });
  tap.ask({ id: "terminal", method: "mcpServer/elicitation/request", params });
  const count = sent.length; tap.answer([...tap.pending.keys()][0], null);
  assert.equal(sent.length, count, "terminal handoff sends no server answer");
});
