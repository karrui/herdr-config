const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(file, names, globals = {}) {
  const source = fs.readFileSync(`${__dirname}/../${file}`, 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '').replace('default class ', 'class ');
  return vm.runInNewContext(`${source}\n;({${names.join(',')}})`, { View: class {}, panes: () => [], spaces: () => [], ...globals });
}
const adapters = load('mods/chat/adapters.js', ['providerEvents']);
const state = load('mods/chat/state.js', ['applyEvent', 'childrenOf', 'active', 'settled', 'handoffText', 'projectChildren'], adapters);
Object.assign(state, load('mods/chat/lineage.js', ['storedTerminals', 'descendantTerminals', 'withLineage', 'conversationTitle'], { modelName: x => x, levelName: x => x }));
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

test('Claude retains a Codex terminal child with its model and native transcript after exit', async () => {
  const overlays = [], saved = new Map(), calls = [];
  let child = { address: 'vps/t2', parent: 'vps/t1', state: 'live', status: 'working', report: { app: 'codex' }, name: 'Codex review', foreground: { pid: 42 }, created_ms: 100 };
  const path = '/home/agent/rollout-11111111-1111-4111-8111-111111111111.jsonl', session = '11111111-1111-4111-8111-111111111111';
  const { Chat } = load('mods/chat/main.js', ['Chat'], { ...state, FIND: 'find',
    agent: { modelName: x => x, levelName: x => x, sessionOf: () => session },
    terminals: () => child ? [child] : [], props: () => ({}), openOverlay: x => overlays.push(x),
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    sessionIO: async (operation, args, machine) => {
      calls.push({ operation, machine });
      return operation === 'sessions' ? [{ terminal: 'vps/t2', id: session, path, model: 'gpt-6.1-sol', effort: 'high', status: 'completed' }] : [];
    },
    exec: async (_cmd, _args, options) => { assert.equal(options.on, 'vps'); return { stdout: path }; },
  });
  const view = Object.assign(Object.create(Chat.prototype), { addr: 'vps/t1', machine: 'vps', path: '/home/agent/parent.jsonl', kind: 'claude', own: () => 'parent', live: new Live('parent'), conv: { helpers: new Map() } });
  await view.refreshChildren();
  assert.equal(view.helpers()[0].spec, 'gpt-6.1-sol · high');
  assert.equal(view.helpers()[0].status, 'running', 'a saved completed turn cannot settle a working terminal');
  child.status = 'done'; view.childrenAt = 0; await view.refreshChildren();
  child.status = 'idle'; view.childrenAt = 0; await view.refreshChildren();
  assert.equal(view.helpers()[0].status, 'completed', 'viewing a finished agent does not remove it from previous agents');
  child = { ...child, report: null, state: 'exited', exit_code: 0 };
  view.childrenAt = 0; await view.refreshChildren();
  assert.equal(view.helpers()[0].status, 'completed');
  child = null; view.childrenAt = 0; await view.refreshChildren();
  const archived = view.helpers()[0];
  assert.equal(archived.provider, 'codex'); assert.equal(archived.session, session);
  view.openHelper(archived);
  const transcript = overlays[0].props.transcript;
  assert.equal(transcript.kind, 'codex'); assert.equal(transcript.session, session);
  assert.equal(transcript.owner, 'vps/t2'); assert.equal(transcript.rootPath, path);
  assert.equal(transcript.side, false); assert.equal(transcript.machine, 'vps');
  assert.ok(calls.filter(c => c.operation === 'sessions').every(c => c.machine === 'vps'));
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

test('subagent panel follows the focused conversation and keeps remote ownership', () => {
  const { subagentContext } = load('mods/chat/subagents.js', ['subagentContext'], state);
  const all = { 'vps/t1': { machine: 'vps', list: [] }, t2: { list: [] } };
  const core = [{ address: 'vps/t1', labels: { 'herdr.chat': 'p1' } }, { address: 't2', labels: { 'herdr.chat': 'p2' } }];
  const panes = [{ pane: 'p1', tab: 'vps/tab' }, { pane: 'p2', tab: 'local-tab' }];
  assert.equal(subagentContext(all, core, panes, { pane: 'p1', tab: 'vps/tab' }).owner, 'vps/t1');
  assert.equal(subagentContext(all, core, panes, { pane: 'review', tab: 'local-tab' }).owner, 't2');
  assert.equal(subagentContext(all, core, panes, { terminal: 'vps/t1' }).entry.machine, 'vps');
  assert.equal(subagentContext(all, core, panes, { tab: 'unrelated' }), null);
});

function elements() {
  const nodes = new Map(), text = [], animations = [];
  function element() {
    const node = {}; let proxy;
    proxy = new Proxy({}, { get: (_target, name) => {
      if (name === 'id') return id => { nodes.set(id, node); return proxy; };
      if (name === 'when') return (condition, fn) => condition ? fn(proxy) : proxy;
      if (name === 'child') return value => { if (typeof value === 'string') text.push(value); return proxy; };
      if (name === 'on_click') return fn => { node.click = fn; return proxy; };
      if (name === 'spin') return value => { animations.push(value); return proxy; };
      return () => proxy;
    } }); return proxy;
  }
  return { nodes, text, animations, div: element, svg: element, image: element, h_flex: element, v_flex: element };
}

test('composer shows active subagents and disappears when only history remains', () => {
  const ui = elements(), actions = [];
  const { Chat } = load('mods/chat/main.js', ['Chat'], { ...state, ...ui, settings: () => ({}), run: (name, args) => actions.push({ name, args }) });
  let helpers = [{ id: 'old', label: 'Finished review', status: 'completed' }, { id: 'offline', label: 'Offline child', status: 'unavailable' }];
  const view = Object.assign(Object.create(Chat.prototype), { helpers: () => helpers, jobs: () => [] });
  assert.equal(view.background({}, 'idle'), null);
  helpers = [...helpers, { id: 'work', label: 'Running review', status: 'running' }, { id: 'ask', label: 'Waiting review', status: 'waiting' }];
  assert.ok(view.background({}, 'working'));
  assert.ok(ui.text.includes('Running review')); assert.ok(ui.text.includes('Waiting review'));
  assert.ok(!ui.text.includes('Finished review')); assert.ok(!ui.text.includes('Offline child'));
  assert.ok(!ui.nodes.has('previous-agents')); assert.ok(ui.nodes.has('helpers-panel'));
  ui.nodes.get('helpers-panel').click({}, { stop_propagation() {}, notify() {} });
  assert.equal(actions[0].name, 'layout.select'); assert.equal(actions[0].args.child, 'subagents');
  assert.equal(actions[1].name, 'layout.show');
});

test('subagent panel retains history and opens the selected transcript without treating outages as running', () => {
  const ui = elements(), opened = []; let closed = false;
  const { subagentPanel } = load('mods/chat/subagents.js', ['subagentPanel'], { ...state, ...ui });
  const context = { owner: 'vps/t1', title: 'Parent', entry: { kind: 'codex', list: [
    { id: 'running', label: 'Running', provider: 'codex', status: 'running' },
    { id: 'waiting', label: 'Waiting', provider: 'claude', status: 'waiting' },
    { id: 'completed', label: 'Completed', provider: 'codex', status: 'completed', path: '/remote/result.jsonl' },
  ] } };
  subagentPanel({}, context, h => opened.push(h), () => { closed = true; });
  assert.ok(ui.text.includes('Active · 2')); assert.ok(ui.text.includes('Previous agents · 1'));
  ui.nodes.get('subagent-vps/t1:completed').click();
  assert.equal(opened[0].path, '/remote/result.jsonl');
  ui.nodes.get('subagents-close').click(); assert.equal(closed, true);
  ui.text.length = 0; context.entry.connection = 'unavailable';
  subagentPanel({}, context, () => {}, () => {});
  assert.ok(!ui.text.some(t => t.startsWith('Active ·')));
  assert.ok(ui.text.includes('Other agents · 2')); assert.ok(ui.text.includes('Previous agents · 1'));
});

test('opening and closing the history panel does not start an agent chat or release its approvals', async () => {
  const { Chat } = load('mods/chat/main.js', ['Chat'], { props: () => ({ view: 'subagents' }), exec: () => assert.fail('panel must not release approvals') });
  const view = Object.create(Chat.prototype);
  view.init({}, { spawn: () => assert.fail('panel must not start chat watchers') });
  assert.equal(view.subagentsPanel, true);
  await view.close({});
});

test('quota failures wait without changing child lifecycle and clear after a new request', () => {
  const conv = new Conversation('claude');
  conv.claude({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', timestamp: '2026-11-06T00:00:00Z', message: { content: [{ type: 'text', text: "You've hit your weekly limit" }] } }, 1);
  conv.claude({ type: 'system', subtype: 'turn_duration', timestamp: '2026-11-06T00:00:01Z' }, 2);
  const { Chat } = load('mods/chat/main.js', ['Chat'], { ...state, agent: { modelName: x => x, levelName: x => x }, agents: () => [], terminals: () => [] });
  const view = Object.assign(Object.create(Chat.prototype), { kind: 'claude', conv, discovered: [
    { id: 'native', provider: 'claude', status: 'running' },
    { id: 'quota-child', provider: 'claude', status: 'waiting', waitingReason: 'api_limit' },
    { id: 'finished', provider: 'claude', status: 'completed' },
    { id: 'independent', terminal: 't2', provider: 'codex', status: 'running' },
    { id: 'other-account', terminal: 't3', provider: 'claude', status: 'running' },
    { id: 'resumed', provider: 'claude', status: 'running', updated: Date.parse('2026-11-06T00:00:02Z') },
  ] });
  assert.equal(view.status(), 'blocked');
  const rows = view.helpers();
  assert.equal(rows.find(h => h.id === 'native').status, 'running');
  assert.equal(rows.find(h => h.id === 'quota-child').status, 'waiting');
  assert.equal(rows.find(h => h.id === 'quota-child').waitingReason, 'api_limit');
  assert.equal(rows.find(h => h.id === 'finished').status, 'completed');
  assert.equal(rows.find(h => h.id === 'independent').status, 'running');
  assert.equal(rows.find(h => h.id === 'other-account').status, 'running');
  assert.equal(rows.find(h => h.id === 'resumed').status, 'running');
  conv.claude({ type: 'user', message: { content: 'Retry with another model' } }, 3);
  assert.equal(view.apiLimit(), null);
});

test('newer transcript completion wins over a stale child-start event', () => {
  const live = new Live('root');
  feed(live, { src: 'claude-hook', ev: 'SubagentStart', sid: 'root', agent: 'child', t: 100 });
  const rows = state.childrenOf(null, live, [{ id: 'child', provider: 'claude', status: 'completed', updated: 200, result: 'Report' }]);
  assert.equal(rows[0].status, 'completed'); assert.equal(rows[0].result, 'Report');
});

test('API-limit waits use a calm label and keep the parked agent blocked', () => {
  const ui = elements();
  const { Chat } = load('mods/chat/main.js', ['Chat'], { ...state, ...ui, settings: () => ({}) });
  const view = Object.assign(Object.create(Chat.prototype), { helpers: () => [{ id: 'quota', label: 'Review', status: 'waiting', waitingReason: 'api_limit' }], jobs: () => [] });
  view.background({}, 'blocked');
  assert.ok(ui.text.includes('Waiting · API limit')); assert.equal(ui.animations.length, 0);
  const { chatAgents } = load('mods/chat/parked.js', ['chatAgents'], {
    panes: () => [{ pane: 'p', mod: 'chat', tab: 'tb' }], spaces: () => [], focused: () => ({}),
    terminals: () => [{ address: 't1', state: 'live', status: 'error', labels: { 'herdr.chat': 'p' } }],
    shared: key => key === 'chat.subagents' ? { t1: { waitingReason: 'api_limit', list: [] } } : null,
  });
  assert.equal(chatAgents()[0].status, 'blocked');
});

test('live API-limit failures stay blocked until the next prompt', () => {
  const live = new Live('root');
  feed(live, { src: 'claude-hook', sid: 'root', ev: 'StopFailure', error: 'rate_limit', text: 'Weekly limit reached', t: 100 });
  assert.equal(live.limit.text, 'Weekly limit reached');
  assert.equal(live.activity, null);
  feed(live, { src: 'claude-hook', sid: 'root', ev: 'UserPromptSubmit', t: 200 });
  assert.equal(live.limit, null);
  feed(live, { src: 'claude-hook', sid: 'root', ev: 'StopFailure', error: 'authentication_failed', t: 300 });
  assert.equal(live.limit, null);
});

test('nested panel keeps an active descendant under its completed ancestors and can collapse the branch', () => {
  const ui = elements(), branches = new Map(), opened = [];
  const { subagentPanel, subagentTree } = load('mods/chat/subagents.js', ['subagentPanel', 'subagentTree'], { ...state, ...ui });
  const list = [{ id: 't2', terminal: 't2', provider: 'codex', label: 'Codex reviewer', status: 'completed', children: [
    { id: 'native', provider: 'codex', label: 'Native reviewer', status: 'completed', children: [
      { id: 'deep', provider: 'codex', label: 'Deep reviewer', status: 'waiting', waitingReason: 'api_limit' },
    ] },
  ] }];
  const tree = subagentTree(list, 't1');
  assert.equal(tree[0].activeCount, 1); assert.equal(tree[0].agent.status, 'completed');
  assert.equal(tree[0].children[0].children[0].agent.id, 'deep');
  const context = { owner: 't1', title: 'Claude parent', entry: { kind: 'claude', list } };
  subagentPanel({}, context, h => opened.push(h), () => {}, branches);
  assert.ok(ui.nodes.has('subagent-t2:deep')); assert.ok(ui.text.includes('Active · 1'));
  ui.nodes.get('subagent-t2:deep').click(); assert.equal(opened[0].id, 'deep');
  ui.nodes.get('subagent-fold-t1:t2').click({}, { stop_propagation() {}, notify() {} });
  ui.nodes.clear(); subagentPanel({}, context, () => {}, () => {}, branches);
  assert.ok(!ui.nodes.has('subagent-t2:deep'));
  const cyclic = { id: 'cycle', status: 'running' }; cyclic.children = [cyclic];
  assert.equal(subagentTree([cyclic], 'owner')[0].size, 1);
});

test('mixed provider lineage binds deep native transcripts to the Codex owner and immediate parent', () => {
  const list = state.withLineage([{ id: 'vps/t2', terminal: 'vps/t2', session: 'codex-root', provider: 'codex', label: 'Codex child', path: '/remote/codex.jsonl', machine: 'vps', children: [
    { id: 'native', provider: 'codex', label: 'Native child', path: '/remote/native.jsonl', children: [{ id: 'deep', provider: 'codex', label: 'Deep child', path: '/remote/deep.jsonl' }] },
  ] }], { owner: 'vps/t1', session: 'claude-root', path: '/remote/claude.jsonl', machine: 'vps', title: 'Claude parent' });
  const deep = list[0].children[0].children[0], overlays = [];
  assert.equal(deep.owner, 'vps/t2'); assert.equal(deep.ownerSession, 'codex-root');
  assert.equal(deep.rootPath, '/remote/codex.jsonl'); assert.equal(deep.parentTitle, 'Native child');
  const { Chat } = load('mods/chat/main.js', ['Chat'], { terminals: () => [], openOverlay: x => overlays.push(x), props: () => ({}) });
  const view = Object.assign(Object.create(Chat.prototype), { addr: 'vps/t1', kind: 'claude', machine: 'vps' });
  view.openHelper(deep);
  const transcript = overlays[0].props.transcript;
  assert.equal(transcript.owner, 'vps/t2'); assert.equal(transcript.session, 'deep');
  assert.equal(transcript.kind, 'codex'); assert.equal(transcript.parent.title, 'Native child');
  assert.equal(transcript.rootPath, '/remote/codex.jsonl');
});

test('hc descendants retain terminal ancestry and deep waiting states reach navigation', () => {
  const core = [{ address: 'vps/t2', parent: 'vps/t1' }, { address: 'vps/t3', parent: 'vps/t2' }, { address: 'vps/t1', parent: 'vps/t3' }, { address: 'other', parent: 'unrelated' }];
  assert.deepEqual(Array.from(state.descendantTerminals(core, 'vps/t1'), h => h.address), ['vps/t2', 'vps/t3']);
  assert.equal(state.descendantTerminals([{ address: 'unrelated', parent: null }], null).length, 0, 'a native transcript without a terminal must not adopt every root agent');
  const nested = { id: 'native', status: 'waiting' };
  const roots = [{ id: 't2', terminal: 't2', status: 'completed', children: [{ id: 't3', terminal: 't3', status: 'completed', children: [nested] }] }];
  const stored = state.storedTerminals(roots, 't1');
  assert.equal(stored.get('t3').parentTerminal, 't2');
  const { chatAgents } = load('mods/chat/parked.js', ['chatAgents'], {
    panes: () => [{ pane: 'p', mod: 'chat', tab: 'tb' }], spaces: () => [], focused: () => ({}),
    terminals: () => [{ address: 't1', state: 'live', status: 'idle', labels: { 'herdr.chat': 'p' } }],
    shared: key => key === 'chat.subagents' ? { t1: { list: roots } } : null,
  });
  assert.equal(chatAgents()[0].status, 'blocked'); assert.equal(roots[0].status, 'completed');
  nested.status = 'completed'; assert.equal(chatAgents()[0].status, 'idle');
});

test('parent labels prefer the named tab over an obsolete terminal title', () => {
  const terminal = { address: 't13x', name: null, title: 'Lambda vs ECS architecture', labels: { 'herdr.chat': 'p1' } };
  const panes = [{ pane: 'p1', tab: 'devx-tab' }], spaces = [{ tabs: [{ id: 'devx-tab', named: true, name: 'DEVX-471' }] }];
  assert.equal(state.conversationTitle(terminal, panes, spaces), 'DEVX-471');
  const { subagentContext } = load('mods/chat/subagents.js', ['subagentContext'], state);
  assert.equal(subagentContext({ t13x: {} }, [terminal], panes, { pane: 'p1' }, spaces).title, 'DEVX-471');
  assert.equal(state.conversationTitle({ ...terminal, name: 'Explicit agent name' }, panes, spaces), 'Explicit agent name');
  assert.equal(state.conversationTitle(terminal, panes, [{ name: 'DEVX-471', named: true, tabs: [{ id: 'devx-tab', named: true, name: 'Claude Code' }] }]), 'DEVX-471 · Claude Code');
});

test('snapshot events reconstruct nested Codex children without leaking their messages into the parent', () => {
  const live = new Live('root');
  feed(live, codex('child', { child: 'child', status: 'completed', t: 100 }),
    codex('child', { thread: 'child', child: 'deep', status: 'running', t: 200 }),
    codex('child', { thread: 'deep', child: 'root', status: 'running', t: 300 }),
    codex('item/completed', { thread: 'child', type: 'agentMessage', item: 'foreign', text: 'Child text' }));
  assert.equal(live.tail, null); assert.equal(live.children.size, 1);
  const events = [...live.descendantEvents.values()];
  const tree = state.projectChildren(events, 'root');
  assert.equal(tree[0].status, 'completed'); assert.equal(tree[0].children[0].status, 'running');
  assert.equal(tree[0].children[0].children.length, 0, 'cyclic observations cannot make a parent its own descendant');
  feed(live, codex('child', { thread: 'child', child: 'deep', status: 'completed', result: 'Report', t: 400 }),
    codex('child', { thread: 'child', child: 'deep', status: 'running', t: 250 }));
  const settled = state.projectChildren([...live.descendantEvents.values()], 'root', tree);
  assert.equal(settled[0].children[0].status, 'completed'); assert.equal(settled[0].children[0].result, 'Report');
});

test('authoritative thread parents remove a stale running copy under a sibling', () => {
  const live = new Live('root');
  feed(live,
    codex('joined', { thread: 'worker', parent: 'root', rollout: '/worker.jsonl', t: 100 }),
    codex('joined', { thread: 'sibling', parent: 'root', rollout: '/sibling.jsonl', t: 100 }),
    codex('child', { child: 'worker', status: 'completed', t: 200 }),
    codex('child', { child: 'sibling', status: 'completed', t: 300 }),
    codex('child', { thread: 'sibling', child: 'worker', status: 'running', t: 250 }));
  const saved = [
    { id: 'worker', provider: 'codex', status: 'completed', updated: 200 },
    { id: 'sibling', provider: 'codex', status: 'completed', updated: 300, children: [{ id: 'worker', provider: 'codex', status: 'running', updated: 250 }] },
  ];
  const tree = state.projectChildren([...live.descendantEvents.values()], 'root', saved);
  assert.equal(tree.find(h => h.id === 'worker').status, 'completed');
  assert.equal(tree.find(h => h.id === 'sibling').children.length, 0);
  feed(live, codex('child', { child: 'worker', status: 'running', t: 400 }));
  const resumed = state.projectChildren([...live.descendantEvents.values()], 'root', tree);
  assert.equal(resumed.find(h => h.id === 'worker').status, 'running', 'a genuine new turn must still show work');
});

test('refresh preserves two terminal generations and their native descendants after exit and reload', async () => {
  const saved = new Map(), requests = [];
  let core = [{ address: 'vps/t2', parent: 'vps/t1', state: 'live', status: 'done', agent: 'codex', foreground: { pid: 2 }, labels: { 'herdr.sandbox': 'box2' } },
    { address: 'vps/t3', parent: 'vps/t2', state: 'live', status: 'done', agent: 'codex', foreground: { pid: 3 } },
    { address: 'unrelated', parent: null, state: 'live', agent: 'codex' }];
  const { Chat } = load('mods/chat/main.js', ['Chat'], { ...state, FIND: 'find',
    terminals: () => core, agent: { sessionOf: (_kind, file) => file },
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    exec: async (_cmd, args, options) => { assert.equal(options.on, 'vps'); return { stdout: `/remote/${args.at(-1)}.jsonl` }; },
    sessionIO: async (op, args, machine) => {
      assert.equal(machine, 'vps');
      if (op !== 'sessions') return [];
      requests.push(...JSON.parse(args[0]));
      return [{ terminal: 'vps/t2', id: 'codex2', status: 'completed', events: [codex('child', { thread: 'codex2', child: 'native2', status: 'running' })] },
        { terminal: 'vps/t3', id: 'codex3', status: 'completed', children: [{ id: 'native3', provider: 'codex', status: 'completed', path: '/remote/native3.jsonl' }] }];
    },
  });
  const create = () => Object.assign(Object.create(Chat.prototype), { addr: 'vps/t1', machine: 'vps', path: '/remote/claude.jsonl', kind: 'claude', own: () => 'parent', live: new Live('parent'), conv: { helpers: new Map() } });
  let view = create(); await view.refreshChildren();
  const verify = view => {
    const roots = view.helpers(); assert.equal(roots.length, 1); assert.equal(roots[0].terminal, 'vps/t2');
    assert.equal(roots[0].children.length, 2);
    const terminal = roots[0].children.find(h => h.terminal === 'vps/t3');
    assert.equal(terminal.parentTerminal, 'vps/t2'); assert.equal(terminal.children[0].id, 'native3');
    assert.equal(terminal.children[0].owner, 'vps/t3'); assert.equal(terminal.children[0].rootPath, '/remote/3.jsonl');
    assert.equal(roots[0].children.find(h => h.id === 'native2').status, 'running');
  };
  verify(view); assert.equal(requests[0].box, 'box2');
  core = []; view.childrenAt = 0; await view.refreshChildren(); verify(view);
  view = create(); await view.refreshChildren(); verify(view);
  assert.ok([...saved.values()].every(value => !value.includes('unrelated')));
});

test('read-only native transcripts discard old unrelated terminal children', async () => {
  const { Chat } = load('mods/chat/main.js', ['Chat'], { ...state, terminals: () => [{ address: 't12g', parent: null, agent: 'claude-code' }],
    sessionIO: async () => [], localStorage: { getItem: () => JSON.stringify([{ id: 't12g', terminal: 't12g', status: 'running' }]), setItem() {} },
  });
  const view = Object.assign(Object.create(Chat.prototype), { addr: null, path: '/root/subagents/agent-child.jsonl', kind: 'claude', own: () => 'child',
    transcript: { session: 'child', owner: 't13x', rootPath: '/root.jsonl' }, live: new Live('child') });
  await view.refreshChildren(); assert.equal(view.discovered.length, 0);
});

test('transcript trees repair grandchildren previously saved as siblings', async () => {
  const { Chat } = load('mods/chat/main.js', ['Chat'], { ...state, terminals: () => [],
    localStorage: { getItem: () => JSON.stringify([{ id: 'child', provider: 'claude' }, { id: 'deep', provider: 'claude', result: 'Preserved report', updated: 100 }]), setItem() {} },
    sessionIO: async () => [{ id: 'child', provider: 'claude', children: [{ id: 'deep', provider: 'claude', status: 'completed', updated: 200 }] }],
  });
  const view = Object.assign(Object.create(Chat.prototype), { addr: 't1', path: '/root.jsonl', kind: 'claude', own: () => 'root', live: new Live('root') });
  await view.refreshChildren();
  assert.equal(view.discovered.length, 1); assert.equal(view.discovered[0].children[0].id, 'deep');
  assert.equal(view.discovered[0].children[0].result, 'Preserved report');
});

test('Codex async questions remain answerable after the tool returns and reconcile native answer IDs', () => {
  const conv = new Conversation('codex');
  const questions = [{ title: 'Can you install zsh?', options: ['Installed', 'Later'] }, { title: 'Which host?' }];
  conv.codex({ type: 'response_item', timestamp: '2026-11-06T07:36:00Z', payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'call-question', arguments: JSON.stringify({ questions }) } }, 1);
  const item = conv.questions.get('call-question');
  assert.equal(item?.async, true, 'async questions must become question records, not plain tool output');
  conv.done('call-question', 2);
  assert.equal(item.closed, undefined, 'returning immediately does not answer an async question');
  const reply = (index, answer) => ({ answer, question: questions[index].title, questionItemId: JSON.stringify(['request_user_input_async', 'call-question', index]) });
  const respond = (items, off) => conv.codex({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<send_user_message_question_reply>\n${JSON.stringify(items)}\n</send_user_message_question_reply>` }] } }, off);
  respond([reply(0, 'Installed')], 3); assert.equal(item.closed, undefined);
  respond([reply(1, 'VPS')], 4); assert.equal(item.closed, 'answered');
  assert.equal(conv.items.filter(x => x.kind === 'user').at(-1).text, 'VPS');
  assert.ok(!conv.items.some(x => x.text?.includes('<send_user_message_question_reply>')));
  const live = new Live('root');
  feed(live, codex('item/completed', { type: 'agentMessage', item: 'call-question', text: 'Can you install zsh?', t: Date.parse('2026-11-06T07:36:00Z') }));
  assert.ok(!live.over({ items: [item] }, true).some(x => x.id === 'live:call-question'), 'the live question prose must not duplicate its card');
});

for (const address of ['t1', 'vps/t1']) test(`async question cards send native human replies to ${address} and survive send failures`, async () => {
  const askWords = load('mods/chat/asks.js', ['words', 'answers']);
  const { AskCards } = load('mods/chat/cards.js', ['AskCards'], askWords);
  const conv = new Conversation('codex');
  conv.askedAsync('call-q', [{ title: 'Install the packages?', options: ['Installed', 'Later'] }], 1, 1234);
  const sent = [], jobs = []; let fail = true;
  const { Chat } = load('mods/chat/main.js', ['Chat'], { ...askWords,
    sessionIO: () => assert.fail('async questions do not have a blocking RPC callback'),
    sendInput: async (...args) => { sent.push(args); if (fail) throw new Error('machine offline'); return { code: 0 }; },
  });
  const view = Object.assign(Object.create(Chat.prototype), { kind: 'codex', addr: address, own: () => 'session', conv, asks: [], askEnded() {} });
  const cx = { notify() {}, spawn: fn => jobs.push(fn(cx)) };
  view.cards = new AskCards({ reply: (...args) => view.reply(...args) }, {});
  const ask = view.asyncAsks()[0];
  assert.equal(view.asyncAsks()[0], ask, 'rerenders preserve the in-flight send guard');
  const strips = view.cards.strips(ask, { who: 'Codex' });
  assert.ok(strips.some(s => s.kind === 'option' && s.label === 'Installed'));
  view.cards.pick(ask, 0, 0); view.cards.submit(ask, cx);
  await Promise.all(jobs);
  assert.match(view.error, /machine offline/); assert.equal(view.asyncAsks().length, 1);
  fail = false; jobs.length = 0;
  const reply = askWords.answers(ask.req, { 'Install the packages?': 'Installed' });
  view.reply(ask, reply, cx); view.reply(view.asyncAsks()[0], reply, cx);
  await Promise.all(jobs);
  assert.equal(sent.length, 2, 'one failed attempt and one successful retry, without a double submit');
  assert.equal(sent[1][0], address);
  const payload = JSON.parse(sent[1][1].split('\n')[1]);
  assert.equal(payload[0].answer, 'Installed'); assert.equal(payload[0].questionItemId, '["request_user_input_async","call-q",0]');
  assert.equal(view.asyncAsks().length, 0);
});

for (const address of ['t1', 'vps/t1']) test(`MCP permission cards at ${address} require an explicit choice and keep its native value`, async () => {
  const askWords = load('mods/chat/asks.js', ['words', 'answers', 'deny']);
  const { AskCards } = load('mods/chat/cards.js', ['AskCards'], askWords);
  const calls = [], jobs = [], { Chat } = load('mods/chat/main.js', ['Chat'], { sessionIO: async (...args) => calls.push(args) });
  const view = Object.assign(Object.create(Chat.prototype), { addr: address, machine: address.includes('/') ? 'vps' : null, asks: [], askEnded() {} });
  Object.defineProperty(view, 'askDir', { value: '/host/chat-asks' });
  const cx = { notify() {}, spawn: fn => jobs.push(fn(cx)) }, cards = new AskCards({ reply: (...args) => view.reply(...args) }, {});
  const req = { tool_name: 'AskUserQuestion', elicitation: { property: 'access', question: 'Allow Herdr?', values: ['one', 'session', 'always'] },
    tool_input: { questions: [{ question: 'Allow Herdr?', strict: true, options: [{ label: 'Allow', value: 'one' }, { label: 'Allow for this session', value: 'session' }, { label: 'Always allow', value: 'always' }] }] } };
  const ask = { id: 'pending', req, words: askWords.words(req) };
  const strips = cards.strips(ask, { who: 'Codex' });
  assert.ok(strips.find(s => s.key === 'submit').ctls.find(c => c.label === 'Submit').disabled);
  assert.deepEqual(Array.from(strips.filter(s => s.kind === 'option'), s => s.label), ['Allow', 'Allow for this session', 'Always allow']);
  cards.submit(ask, cx); assert.equal(jobs.length, 0);
  cards.pick(ask, 0, 1); cards.submit(ask, cx); await Promise.all(jobs);
  assert.equal(calls[0][0], 'answer'); assert.equal(calls[0][2], address.includes('/') ? 'vps' : null);
  assert.equal(JSON.parse(calls[0][1][3]).hookSpecificOutput.decision.updatedInput.answers['Allow Herdr?'], 'session');
  assert.ok(cards.strips(ask).find(s => s.key === 'submit').ctls.some(c => c.label === 'Cancel'));
  const native = { id: 'native', req: { tool_name: 'McpElicitation', elicitation: { unsupported: true }, tool_input: { message: 'Verify your identity', detail: 'Answer in terminal' } } };
  native.words = askWords.words(native.req);
  const ctls = cards.strips(native).flatMap(s => s.ctls ?? []);
  assert.ok(!ctls.some(c => c.label === 'Allow')); assert.ok(ctls.some(c => c.label === 'Cancel'));
});

test('semantic async question items recover on reload and keep separate card identities', () => {
  const conv = new Conversation('codex'), askWords = load('mods/chat/asks.js', ['words']);
  for (const id of ['first', 'second']) conv.codex({ type: 'event_msg', timestamp: '2026-11-06T07:36:00Z', payload: {
    type: 'item_completed', item: { type: 'AgentMessage', id, delivery: 'async', questions: [{ title: id, options: ['Yes', 'No'] }] },
  } }, id);
  const { Chat } = load('mods/chat/main.js', ['Chat'], { ...askWords, openCard: () => null });
  const view = Object.assign(Object.create(Chat.prototype), { kind: 'codex', addr: 't1', own: () => 'session', conv, asks: [], cards: { strips: () => [], keep() {} }, cli: () => 'Codex' });
  const cards = view.timelineCards();
  assert.equal(cards.length, 2); assert.notEqual(cards[0].id, cards[1].id);
  assert.equal(cards[0].call, 'first'); assert.equal(cards[1].call, 'second');
  view.transcript = {}; assert.equal(view.asyncAsks().length, 0, 'a native child transcript cannot send an answer into its parent thread');
});

test('the host log reader retains async question metadata and its immediate tool result', t => {
  const { spawnSync } = require('node:child_process');
  const folder = fs.mkdtempSync('/tmp/herdr-async-log-'); t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = `${folder}/rollout.jsonl`, questions = [{ title: 'Install packages?', options: ['Now', 'Later'] }];
  const rows = [
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call-q', name: 'request_user_input_async', arguments: JSON.stringify({ questions }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-q', output: 'Request sent' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'call-q', delivery: 'async', questions } } },
  ];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  const { LOG, records } = load('mods/chat/log.js', ['LOG', 'records']);
  const result = spawnSync('sh', ['-c', LOG, 'log', 'page', file, '999999999999999', '200'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const conv = new Conversation('codex'); conv.feed(records(result.stdout).records);
  assert.equal(conv.questions.size, 1); assert.equal(conv.questions.get('call-q').closed, undefined);
  assert.equal(conv.items.filter(x => x.kind === 'ask').length, 1);
});
