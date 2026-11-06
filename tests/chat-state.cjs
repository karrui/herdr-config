const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(file, names, globals = {}) {
  const source = fs.readFileSync(`${__dirname}/../${file}`, 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '').replace('default class ', 'class ');
  return vm.runInNewContext(`${source}\n;({${names.join(',')}})`, { View: class {}, ...globals });
}
const adapters = load('mods/chat/adapters.js', ['providerEvents']);
const state = load('mods/chat/state.js', ['applyEvent', 'childrenOf', 'active', 'settled', 'handoffText', 'projectChildren'], adapters);
const { Live, Conversation, eventLines } = load('mods/chat/log.js', ['Live', 'Conversation', 'eventLines'], { ...adapters, ...state });
const feed = (live, ...events) => live.feed(events.map(e => JSON.stringify(e)));
const codex = (ev, fields = {}) => ({ src: 'codex', thread: 'root', t: 100, ev, ...fields });

test('both adapters isolate a child lifecycle from parent completion and retain its report', () => {
  for (const provider of ['codex', 'claude']) {
    const live = new Live('root');
    const child = provider === 'codex' ? codex('child', { child: 'child', status: 'running', prompt: 'Review' })
      : { src: 'claude-hook', ev: 'SubagentStart', sid: 'root', agent: 'child', t: 100 };
    feed(live, child, provider === 'codex' ? codex('turn/completed', { status: 'completed', t: 200 }) : { src: 'claude-hook', ev: 'Stop', sid: 'root', t: 200 });
    assert.equal(live.children.get('child').status, 'running');
    feed(live, { ...child, ev: provider === 'codex' ? 'child' : 'SubagentStop', status: 'completed', result: 'Found a bug', t: 300 });
    assert.equal(live.children.get('child').status, 'completed');
    assert.equal(live.children.get('child').result, 'Found a bug');
    assert.equal(live.children.size, 1);
  }
});

test('replayed and delayed deltas cannot duplicate text or resurrect completed activity', () => {
  const live = new Live('root');
  feed(live, codex('turn/started', { turn: 't1', epoch: 'p', seq: 1 }),
    codex('item/started', { turn: 't1', type: 'agentMessage', item: 'a', epoch: 'p', seq: 2 }),
    codex('item/agentMessage/delta', { turn: 't1', item: 'a', delta: 'Hello', epoch: 'p', seq: 3 }));
  feed(live, codex('item/agentMessage/delta', { turn: 't1', item: 'a', delta: 'Hello', epoch: 'p', seq: 3 }));
  assert.equal(live.tail.parts.join(''), 'Hello');
  feed(live, codex('item/completed', { turn: 't1', type: 'agentMessage', item: 'a', text: 'Final text', t: 200 }),
    codex('turn/completed', { turn: 't1', status: 'completed', t: 201 }),
    codex('item/agentMessage/delta', { turn: 't1', item: 'a', delta: ' stale', t: 202 }),
    codex('turn/started', { turn: 't1', t: 203 }));
  assert.equal(live.tail.parts.join(''), 'Final text');
  assert.equal(live.turnState, 'completed');
  assert.equal(live.activity, null);
  assert.equal(live.over({ items: [] }, false).at(-1).text, 'Final text');
});

test('reasoning gives way to a tool and stops on interruption', () => {
  const live = new Live('root');
  feed(live, codex('turn/started', { turn: 't1' }), codex('item/started', { type: 'reasoning', item: 'r', turn: 't1' }),
    codex('item/reasoning/summaryTextDelta', { item: 'r', delta: 'Checking the graph', turn: 't1' }),
    codex('item/completed', { type: 'reasoning', item: 'r', text: 'Checking the graph', turn: 't1' }),
    codex('item/started', { type: 'commandExecution', item: 'c', command: 'Run tests', turn: 't1' }));
  assert.equal(live.activity, 'Run tests');
  assert.equal(live.thought.parts.join(''), 'Checking the graph');
  feed(live, codex('turn/completed', { turn: 't1', status: 'interrupted', t: 200 }));
  assert.equal(live.activity, null);
  assert.equal(live.turnState, 'interrupted');
});

test('same prefixes do not reconcile distinct messages; native identity does', () => {
  const live = new Live('root');
  live.tail = { id: 'new', start: 100, done: true };
  assert.equal(live.logged([{ kind: 'agent', text: 'I will inspect the code.', at: 100 }], 'I will inspect the code. Then the lineage.'), false);
  assert.equal(live.logged([{ kind: 'agent', mid: 'old', text: 'Same words', at: 100 }], 'Same words'), false);
  assert.equal(live.logged([{ kind: 'agent', mids: ['new'], text: 'Authoritative text' }], 'Partial text'), true);
});

test('a steering message retires the interrupted draft and completed legacy items settle', () => {
  const live = new Live('root');
  feed(live, codex('turn/started', { turn: 't1' }),
    codex('item/started', { turn: 't1', type: 'agentMessage', item: 'abandoned' }),
    codex('item/agentMessage/delta', { turn: 't1', item: 'abandoned', delta: 'Interrupted draft' }),
    codex('item/started', { turn: 't1', type: 'userMessage', item: 'steer', t: 200 }),
    codex('item/completed', { turn: 't1', type: 'userMessage', item: 'steer', t: 201 }));
  assert.equal(live.over({ items: [] }, true).length, 0);
  assert.equal(live.openItems.has('abandoned'), false);
  feed(live, codex('item/agentMessage/delta', { turn: 't1', item: 'abandoned', delta: ' late', t: 202 }),
    codex('item/completed', { turn: 't1', type: 'agentMessage', item: 'abandoned', text: 'Interrupted draft late', t: 202 }));
  assert.equal(live.over({ items: [] }, true).length, 0);
  feed(live, codex('item/started', { turn: 't1', type: 'agentMessage', item: 'reply', t: 202 }),
    codex('item/agentMessage/delta', { turn: 't1', item: 'reply', delta: 'Updated reply', t: 203 }),
    codex('item/completed', { turn: 't1', type: 'agentMessage', item: 'reply', t: 204 }));
  assert.equal(live.messages.get('reply').done, true);
  assert.equal(live.over({ items: [] }, false)[0].text, 'Updated reply');
});

test('native children keep completed history and merge the spawning call once', () => {
  const conv = new Conversation('codex');
  conv.helpers.set('call', { desc: 'Review', done: false, uncertain: true });
  const live = new Live('root');
  feed(live, codex('child', { child: 'native', call: 'call', status: 'completed', path: '/remote/child.jsonl' }));
  const children = state.childrenOf(conv, live);
  assert.equal(children.length, 1);
  assert.equal(children[0].id, 'native');
  assert.equal(children[0].label, 'Review');
  conv.codex({ type: 'event_msg', payload: { type: 'task_complete' } }, 1);
  assert.equal(conv.helpers.get('call').done, false);
});

test('foreign sessions and internal reviewers cannot become this conversation activity', () => {
  const live = new Live('root');
  feed(live, codex('child', { child: 'guardian', internal: true }), codex('child', { thread: 'other', child: 'foreign' }),
    { src: 'claude-hook', ev: 'MessageDisplay', sid: 'root', agent: 'child', msg: 'wrong', i: 0, delta: 'Wrong parent', t: 100 });
  assert.equal(live.children.size, 0);
  assert.equal(live.tail, null);
});

test('partial event lines remain unread until complete, including UTF-8 byte offsets', () => {
  const line = JSON.stringify(codex('child', { child: '子' }));
  assert.equal(eventLines(`E 100 0 0 0\n${line}`).lines.length, 0);
  assert.equal(eventLines(`E 100 0 0 0\n${line}\n`).next, Buffer.byteLength(line + '\n'));
});

test('remote readers and child navigation keep machine and local terminal identity', async () => {
  const calls = [], overlays = [];
  const { Chat } = load('mods/chat/main.js', ['Chat'], {
    ...state, agent: { modelName: x => x, levelName: x => x },
    sessionIO: async (...args) => { calls.push(args); return { app: '/srv/herdr', home: '/home/agent', spool: '/srv/spool' }; },
    exec: async (...args) => { calls.push(args); return { code: 0, stdout: '' }; },
    terminals: () => [], openOverlay: x => overlays.push(x), props: () => ({}),
  });
  const view = Object.assign(Object.create(Chat.prototype), { addr: 'vps/t1', machine: 'vps', phase: 'ready', kind: 'codex' });
  await view.flag();
  assert.equal(calls[0][2], 'vps');
  assert.equal(calls[1][2].on, 'vps');
  assert.equal(calls[1][1].at(-1), 't1');
  assert.equal(view.askDir, '/srv/spool/chat-asks');
  view.openHelper({ id: 'child', path: '/home/agent/child.jsonl', label: 'Review', provider: 'codex' });
  assert.equal(overlays[0].props.transcript.machine, 'vps');
  assert.equal(overlays[0].props.transcript.owner, 'vps/t1');
  assert.equal(overlays[0].props.transcript.kind, 'codex');
});

test('shared native modules stay identical across Herdr module isolation', () => {
  for (const name of ['state.js', 'adapters.js', 'parked.js']) assert.equal(fs.readFileSync(`${__dirname}/../mods/chat/${name}`, 'utf8'), fs.readFileSync(`${__dirname}/../mods/agents-sandbox/${name}`, 'utf8'));
});

test('handoffs retain roles and recent work with explicit history limits', () => {
  const history = [{ kind: 'user', text: 'old '.repeat(20000) }, { kind: 'agent', text: 'Earlier answer' }, { kind: 'user', text: 'Latest request' }, { kind: 'tools', steps: [{ line: 'Tests passed' }] }];
  const text = state.handoffText(history, '/remote/source.jsonl', '/remote/worktree');
  assert.ok(text.includes('## User\nLatest request'));
  assert.ok(text.includes('Tool: Tests passed'));
  assert.ok(text.includes('Source transcript: /remote/source.jsonl'));
  assert.ok(text.length < 50000);
  assert.ok(!text.includes('Thinking'));
});

test('child approval urgency reaches parked agents without changing their completed history', () => {
  const globals = { panes: () => [{ mod: 'chat', pane: 'p', tab: 'tb' }], spaces: () => [], focused: () => ({ pane: 'p' }),
    terminals: () => [{ address: 'vps/t1', state: 'live', status: 'idle', labels: { 'herdr.chat': 'p' } }],
    shared: key => key === 'chat.subagents' ? { 'vps/t1': { list: [{ status: 'waiting' }] } } : null };
  const { chatAgents } = load('mods/chat/parked.js', ['chatAgents'], globals);
  assert.equal(chatAgents()[0].status, 'blocked');
  globals.shared = key => key === 'chat.subagents' ? { 'vps/t1': { list: [{ status: 'completed' }] } } : null;
  assert.equal(load('mods/chat/parked.js', ['chatAgents'], globals).chatAgents()[0].status, 'idle');
});

test('remote launches resolve the remote home and preserve native sandbox policy', () => {
  const { remoteRun } = load('mods/chat/launch.js', ['remoteRun']);
  assert.equal(Array.from(remoteRun(['/Users/me/.config/herdr-app/agent/launch', '--sandbox', 'codex', '--sandbox', 'danger-full-access'], '/home/agent/.config/herdr-app', 'Linux')).join('|'), '/home/agent/.config/herdr-app/agent/launch|codex');
  assert.equal(Array.from(remoteRun(['/Users/me/.config/herdr-app/agent/launch', '--sandbox', 'claude'], '/remote/config', 'Darwin')).join('|'), '/remote/config/agent/launch|--sandbox|claude');
  assert.equal(fs.readFileSync(`${__dirname}/../mods/chat/launch.js`, 'utf8'), fs.readFileSync(`${__dirname}/../mods/new-menu-sandbox/launch.js`, 'utf8'));
});

test('remote event reads recover from outages without dropping lineage or duplicating text', async () => {
  const stop = new Error('one iteration'), calls = [];
  let offline = false;
  const events = [codex('turn/started', { epoch: 'remote', seq: 1 }), codex('item/started', { type: 'agentMessage', item: 'a', epoch: 'remote', seq: 2 }), codex('item/agentMessage/delta', { item: 'a', delta: 'Remote reply', epoch: 'remote', seq: 3 }), codex('child', { child: 'child', status: 'running', epoch: 'remote', seq: 4 })];
  const { Chat } = load('mods/chat/main.js', ['Chat'], { ...state, Live, EVENTS: '', eventLines,
    readTextFile: async (_file, options) => { assert.equal(options.on, 'vps'); return null; },
    exec: async (...args) => { calls.push(args); if (offline) throw new Error('machine offline'); return { code: 0, stdout: `E 100 0 0 0\n${events.map(JSON.stringify).join('\n')}\n` }; },
    terminals: () => [],
  });
  const view = Object.assign(Object.create(Chat.prototype), { addr: 'vps/t1', machine: 'vps', machinePaths: { spool: '/home/agent/events' }, live: new Live(), own: () => 'root', publishHelpers() {} });
  const cx = { notify() {}, sleep: async () => { throw stop; } };
  await assert.rejects(view.watchEvents(cx), error => error === stop);
  assert.equal(calls[0][2].on, 'vps');
  assert.equal(calls[0][1][3], '/home/agent/events/chat-events/t1.jsonl');
  assert.equal(view.live.tail.parts.join(''), 'Remote reply');
  offline = true; await assert.rejects(view.watchEvents(cx), error => error === stop);
  assert.equal(view.remoteError, true); assert.equal(view.live.children.get('child').status, 'running');
  offline = false; await assert.rejects(view.watchEvents(cx), error => error === stop);
  assert.equal(view.live.tail.parts.join(''), 'Remote reply'); assert.equal(view.remoteError, false);
});

test('remote approval read failures preserve pending cards; restart runs on the same host', async () => {
  const { Chat } = load('mods/chat/main.js', ['Chat'], { exec: async () => ({ code: 1, stderr: 'machine offline' }) });
  const card = { id: 't1.1.123' };
  const view = Object.assign(Object.create(Chat.prototype), { addr: 'vps/t1', machine: 'vps', machinePaths: { spool: '/remote' }, asks: [card] });
  await assert.rejects(view.readAsks({ notify() {} }), /offline/);
  assert.equal(view.asks[0], card);
  const calls = [];
  const { restart } = load('mods/chat/agent.js', ['restart'], { appHome: () => '/local/herdr', readTextFile: async () => 'echo "$1"', exec: async (...args) => { calls.push(args); return { code: 0, stdout: 't2\n' }; } });
  assert.equal(await restart({ address: 'vps/t1' }, { argv: ['codex'], resume: true }, 'pane'), 'vps/t2');
  assert.equal(calls[0][2].on, 'vps'); assert.ok(calls[0][1].includes('t1')); assert.ok(!calls[0][1].includes('vps/t1'));
});

test('Claude nested conversations scope their own text and correlate direct children only', () => {
  const live = new Live('child', { agent: 'child', parentSession: 'root' });
  feed(live,
    { src: 'claude-hook', sid: 'root', agent: 'sibling', ev: 'MessageDisplay', msg: 'wrong', i: 0, delta: 'Sibling', t: 100 },
    { src: 'claude-hook', sid: 'root', agent: 'child', ev: 'MessageDisplay', msg: 'own', i: 0, delta: 'Child reply', t: 101 },
    { src: 'claude-hook', sid: 'root', agent: 'grandchild', ev: 'SubagentStart', call: 'child-call', label: 'Nested task', t: 102 });
  assert.equal(live.tail.parts.join(''), 'Child reply');
  const conv = new Conversation('claude'); conv.helpers.set('child-call', { desc: 'Nested task' });
  assert.equal(state.childrenOf(conv, live).length, 1);
  const projected = state.projectChildren([
    { src: 'claude-hook', sid: 'root', agent: 'direct', ev: 'SubagentStart', call: 'root-call', t: 100 },
    { src: 'claude-hook', sid: 'root', agent: 'grandchild', ev: 'SubagentStart', call: 'child-call', t: 102 },
  ], 'root', [], ['root-call']);
  assert.equal(projected.length, 1); assert.equal(projected[0].id, 'direct');
});

test('event reads check the producer on its own host and never truncate shared history', t => {
  const { mkdtempSync, writeFileSync, statSync, rmSync } = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const dir = mkdtempSync('/tmp/herdr-event-reader-'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = `${dir}/t1.jsonl`, text = JSON.stringify(codex('child', { child: 'child' })) + '\n';
  writeFileSync(file, text); writeFileSync(`${dir}/t1.cursor.json`, JSON.stringify({ producerPid: process.pid }));
  const { EVENTS } = load('mods/chat/log.js', ['EVENTS']);
  const result = spawnSync('sh', ['-c', EVENTS, 'events', file, '0', '65536'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(eventLines(result.stdout).producer, true);
  assert.equal(statSync(file).size, Buffer.byteLength(text));
});

test('sidebar refresh preserves concurrent entries, replaced sessions, and newer child state', async () => {
  let store = { t1: { spool: '/events', session: 'root', list: [{ id: 'child', provider: 'codex', status: 'completed', updated: 300 }] }, t2: { spool: '/events', session: 'old', list: [] } };
  const { Agents } = load('mods/agents-sandbox/main.js', ['Agents'], { ...state,
    shared: () => store, setShared: (_key, value) => { store = value; },
    terminals: () => [{ address: 't1', state: 'live' }, { address: 't2', state: 'live' }],
    readTextFile: async file => {
      if (file.includes('t1.')) store = { ...store, t3: { session: 'new-agent', list: [] } };
      else store = { ...store, t2: { session: 'replacement', list: [] } };
      return JSON.stringify({ events: { child: codex('child', { child: 'child', status: 'running', t: 200 }) } });
    },
  });
  await Object.create(Agents.prototype).refreshHelpers();
  assert.equal(store.t1.list[0].status, 'completed');
  assert.equal(store.t2.session, 'replacement');
  assert.equal(store.t3.session, 'new-agent');
});

test('producer restart restores availability without changing explicit transport state', async () => {
  let alive = false, notices = 0;
  const stop = new Error('one iteration');
  const { Chat } = load('mods/chat/main.js', ['Chat'], { ...state, Live, EVENTS: '', eventLines,
    exec: async () => ({ code: 0, stdout: `E 0 0 0 0 ${alive ? 1 : 0}\n` }),
    terminals: () => [],
  });
  const view = Object.assign(Object.create(Chat.prototype), { addr: 'vps/t1', machine: 'vps', machinePaths: { spool: '/events' }, live: new Live('root'), own: () => 'root', evFile: '/events/chat-events/t1.jsonl', evOff: 0, publishHelpers() {} });
  const cx = { notify() { notices++; }, sleep: async () => { throw stop; } };
  await assert.rejects(view.watchEvents(cx), error => error === stop);
  assert.equal(view.producerGone, true);
  assert.equal(view.live.connection, 'connected');
  alive = true;
  await assert.rejects(view.watchEvents(cx), error => error === stop);
  assert.equal(view.producerGone, false);
  assert.equal(notices, 2);
});
