// Run: node --test tests/chat-context.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

// Exercise the mods' real methods without GPUI or a running agent.
function load(file, names, globals) {
  const source = readFileSync(`${__dirname}/../${file}`, 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/export default class /g, 'class ')
    .replace(/^export /gm, '');
  return vm.runInNewContext(`${source}\n;({${names.join(',')}})`, { View: class {}, ...globals });
}

test('Claude footer and panel share API limits before a first turn, preserving session context and cost', async () => {
  const api = { at: 100, source: 'api', five: 25, five_reset: 2000000000, week: 51, week_reset: 2000100000,
    limits: { five_hour: { used_percentage: 25, resets_at: 2000000000 }, seven_day: { used_percentage: 51 },
      seven_day_sonnet: { used_percentage: 12 } } };
  const report = { at: 200, ctx: 10, cost: 1.25, model: 'Opus', five: 1, week: 2 };
  for (const hasSession of [false, true]) {
    const globals = { appHome: () => '/app',
      fs: { readdir: async () => hasSession ? ['t1.json'] : [] }, readTextFile: async () => JSON.stringify(report),
      execFile: async (command, args) => {
        assert.equal(command, 'python3');
        assert.equal(args.join('|'), '/app/usage/account-limits|claude');
        return { stdout: JSON.stringify(api) };
      } };
    const { loadUsage } = load('mods/agent-bar/usage.js', ['loadUsage'], globals);
    const footer = await loadUsage({ app: 'claude-code', address: 't1' });
    const { claude } = load('mods/usage/main.js', ['claude'], globals);
    const panel = await claude();
    assert.equal(footer.five, 25, 'a status line can repeat an older API value with a newer timestamp');
    assert.equal(footer.week, 51);
    assert.equal(footer.limits_at, panel.at);
    assert.equal(panel.windows[2].name, 'Weekly, Sonnet');
    assert.equal(footer.ctx, hasSession ? 10 : undefined);
    assert.equal(footer.cost, hasSession ? 1.25 : undefined);
    globals.execFile = async () => ({ stdout: '' });
    const fallback = await load('mods/agent-bar/usage.js', ['loadUsage'], globals).loadUsage({ app: 'claude-code', address: 't1' });
    assert.equal(fallback?.five ?? null, hasSession ? 1 : null);
  }
});

test('the usage bar polls either provider only while the window is active', () => {
  let active = true;
  for (const app of ['codex', 'claude-code']) {
    const timers = [];
    const { AgentBar } = load('mods/agent-bar/main.js', ['AgentBar'], {
      props: () => ({}), window: () => ({ active }), agentAt: () => ({ app }),
    });
    const view = Object.assign(Object.create(AgentBar.prototype), { address: () => 't1' });
    let reads = 0;
    view.refresh = () => reads++;
    view.init({}, { spawn() {}, timer: { every: (ms, fn) => timers.push({ ms, fn }) } });
    assert.equal(timers[0].ms, 30000);
    active = true;
    timers[0].fn({});
    assert.equal(reads, 1);
    active = false;
    timers[0].fn({});
    assert.equal(reads, 1);
  }
});

const space = { active: true, folder: '/other', branch: 'other-branch', machine: 'remote' };
const chat = { pane: 'chat-pane', mod: 'chat' };
const terminal = { address: 'remote/t1', state: 'live', cwd: '/initial', foreground: { cwd: '/worktree' }, labels: { 'herdr.chat': chat.pane } };
const context = {
  spaces: () => [space], panes: () => [chat], terminals: () => [terminal],
  focused: () => ({ pane: chat.pane }), shared: () => null, LINKS: 'linear.links',
};

test('chat search finds folded replies and jumps between matching message rows', () => {
  const stop = new Error('jumped');
  let element;
  element = new Proxy({}, { get: () => () => element });
  const jumps = [];
  const { Chat } = load('mods/chat/main.js', ['Chat'], {
    shared: () => null, focused: () => ({ pane: 'chat' }), theme: () => ({}),
    div: () => element, v_flex: () => element,
  });
  const view = Object.assign(Object.create(Chat.prototype), {
    addr: 't1', phase: 'ready', finding: true, findIdx: 0, findJump: true,
    findBox: { value: () => 'needle' }, opened: new Set(),
    myPane: () => 'chat', alerts() {}, sizeBox() {}, status: () => 'idle', button: () => element,
    scroll: { scroll_to_item: (...args) => { jumps.push(args); throw stop; } },
  });
  const items = [
    { id: 'u1', kind: 'user', text: 'Question' },
    { id: 'a1', kind: 'agent', text: 'Hidden NEEDLE in an earlier reply' },
    { id: 'a2', kind: 'agent', text: 'Final reply' },
    { id: 'u2', kind: 'user', text: 'Another needle' },
  ];
  view.finding = false;
  assert.ok(!view.foldTurns(items, false).some(r => r.id === 'a1'));
  view.finding = true;
  const rows = view.foldTurns(items, false);
  assert.ok(rows.some(r => r.id === 'a1'));
  view.rows = () => rows;
  assert.equal(view.findMatches(rows).length, 2);
  for (const direction of [0, 1, 1, -1]) {
    if (direction) view.findStep(direction, rows, { notify() {} });
    assert.throws(() => view.draw({}), e => e === stop);
    const expected = view.findRow(view.findMatches(rows));
    assert.deepEqual(jumps.at(-1), [expected.index, 'center']);
    assert.equal(view.pinned, false);
    view.findJump = true;
  }
  view.finding = false;
  assert.ok(view.foldTurns(items, false).some(r => r.id === 'a1'), 'jump target stays open after search closes');
});

test('search focuses only when requested, selects the query, and leaves the composer draft untouched', () => {
  let pane = 'chat', focused = 0, selection;
  const { Chat } = load('mods/chat/main.js', ['Chat'], { focused: () => ({ pane }) });
  const view = Object.assign(Object.create(Chat.prototype), {
    myPane: () => 'chat', findBox: { value: () => 'existing query', focus: () => focused++, set_selected_range: r => { selection = r; } },
    box: { focus: () => focused++, value: () => 'Unsent draft' },
  });
  let later;
  const cx = { timer: { after: (_ms, fn) => { later = fn; } }, notify() {} };
  view.openFind(cx);
  later();
  assert.equal(focused, 1);
  assert.equal(selection.end, 'existing query'.length);
  assert.equal(view.box.value(), 'Unsent draft');
  view.openFind(cx);
  pane = 'another-pane';
  later();
  assert.equal(focused, 1, 'a delayed search must not reclaim focus after switching panes');
  view.transcript = {};
  view.closeFind(cx);
  assert.equal(focused, 1, 'a read-only transcript has no composer to focus');
  const keys = JSON.parse(readFileSync(`${__dirname}/../keys.json`, 'utf8'))['mod:chat'];
  assert.equal(keys['cmd-f'], 'chat.find');
  assert.equal(keys['ctrl-f'], 'chat.find');
});

for (const [file, subject] of [['mods/linear/main.js', 'key'], ['mods/tabs-sandbox/main.js', 'Tabs']]) {
  test(`${file}: Linear follows the chat's parked terminal`, () => {
    const { linearLocation } = load('mods/linear/resolve.js', ['linearLocation'], context);
    const loaded = load(file, [subject], { ...context, linearLocation });
    const where = subject === 'Tabs' ? loaded.Tabs.prototype.linearPlace().where : JSON.parse(loaded.key())[0];
    assert.equal(where.cwd, '/worktree');
    assert.equal(where.branch, null, 'must not borrow another pane\'s branch');
    assert.equal(where.on, 'remote');
  });
}

test('Codex with no rollout exposes the composer before its first turn, including retries', async () => {
  const { starting } = load('mods/chat/screens.js', ['starting'], {});
  const t = { state: 'live', status: { app: 'codex', state: 'idle' }, turn: 0,
    foreground: { pid: 42, name: 'bash', argv: ['codex'] }, labels: {} };
  const { Chat } = load('mods/chat/main.js', ['Chat'], {
    hc: async () => ({ stdout: JSON.stringify(t), stderr: '' }),
    exec: async () => ({ stdout: '' }), panes: () => [], starting,
    agent: { own: (a) => a }, FIND: '', MAIN_ROLLOUT: '',
    Conversation: class { constructor(kind) { this.kind = kind; this.items = []; } },
  });
  for (const phase of ['finding', 'none']) {
    const view = Object.assign(Object.create(Chat.prototype), {
      addr: 't1', phase, dfltFor: 'codex|42', live: { rollouts: [] },
    });
    await view.locate({ notify() {} });
    assert.equal(view.phase, 'ready', `initial phase: ${phase}`);
    assert.equal(view.kind, 'codex');
    assert.equal(view.path, undefined, 'must not guess another session');
    assert.ok(view.conv);
  }
});

test('Linear resolves a parked terminal\'s branch in its own worktree', async () => {
  for (const file of ['mods/linear/resolve.js', 'mods/tabs-sandbox/linear-resolve.js']) {
    const calls = [];
    const { findTicket } = load(file, ['findTicket'], {
      shared: () => ({ '/worktree|devx-42': 'DEVX-42' }),
      execFile: async (_cmd, args, options) => {
        calls.push({ args, options });
        return { code: 0, stdout: args[0] === 'rev-parse' ? '/worktree/.git\n' : 'devx-42\n' };
      },
      fetch: async () => ({ ok: true, json: async () => ({ data: { issue: { identifier: 'DEVX-42' } } }) }),
    });
    const found = await findTicket('test-key', { cwd: '/worktree', branch: null, on: 'remote' });
    assert.equal(found.issue?.identifier, 'DEVX-42');
    assert.equal(found.branch, 'devx-42');
    assert.equal(calls[1].options.cwd, '/worktree');
    assert.equal(calls[1].options.on, 'remote');
  }
});

test('Codex session discovery skips the approval reviewer even when it is open first', (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'herdr chat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reviewer = join(dir, 'rollout-reviewer.jsonl'), main = join(dir, 'rollout-main.jsonl');
  writeFileSync(reviewer, JSON.stringify({ type: 'session_meta', payload: { source: { subagent: { other: 'guardian' } } } }) + '\n');
  writeFileSync(main, JSON.stringify({ type: 'session_meta', payload: { source: 'vscode' } }) + '\n');
  writeFileSync(join(dir, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(dir, 'lsof'), `#!/bin/sh\nprintf 'n%s\\nn%s\\n' '${reviewer}' '${main}'\n`, { mode: 0o755 });
  const { FIND, MAIN_ROLLOUT } = load('mods/chat/log.js', ['FIND', 'MAIN_ROLLOUT'], {});
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const discovered = spawnSync('sh', ['-c', FIND, 'chat', 'codex', '99999999'], { env, encoding: 'utf8' });
  assert.equal(discovered.status, 0, discovered.stderr);
  assert.equal(discovered.stdout.trim(), main);
  for (const path of [reviewer, main]) {
    const checked = spawnSync('sh', ['-c', MAIN_ROLLOUT, 'chat', path], { env, encoding: 'utf8' });
    assert.equal(checked.stdout.trim(), path === main ? main : '');
  }
});

test('tab bar renders while resources, change counts and tickets are still loading', () => {
  let element;
  element = new Proxy({}, { get: (_obj, name) => {
    if (name === 'child') return (value) => {
      assert.ok(typeof value === 'string' || value === element, 'invalid UI child');
      return element;
    };
    if (name === 'when') return (condition, fn) => condition ? fn(element) : element;
    return () => element;
  } });
  const { Tabs } = load('mods/tabs-sandbox/main.js', ['Tabs'], {
    theme: () => ({}), spaces: () => [{ active: true, tabs: [] }],
    chatAgents: () => [], layout: () => null, window: () => null, shared: () => null,
    linearLocation: () => ({}),
    div: () => element, h_flex: () => element, svg: () => element,
  });
  const view = Object.assign(Object.create(Tabs.prototype), {
    resources: {}, ticket: {}, changes: {}, spaceFolder: () => ({ id: 'new-folder' }),
    countResources() {}, findLinear() {}, syncPanel() {}, linearPlace: () => null,
  });
  view.render({});
});

test('chat renders never reclaim keyboard focus from a dialog over the selected pane', () => {
  const stop = new Error('focus handling finished');
  const { Chat } = load('mods/chat/main.js', ['Chat'], {
    focused: () => ({ pane: 'chat-pane' }),
    shared: () => { throw stop; },
  });
  for (const wasFocused of [false, true]) {
    let focusCalls = 0;
    const timers = [];
    const view = Object.assign(Object.create(Chat.prototype), {
      addr: 't1', phase: 'ready', wasFocused, hadBox: true, focused: false,
      myPane: () => 'chat-pane', box: { focus: () => focusCalls++ },
    });
    // A dialog owns the keyboard, while focused().pane still identifies the pane beneath it.
    const cx = { timer: { after: (_delay, fn) => timers.push(fn) } };
    for (let i = 0; i < 3; i++) {
      assert.throws(() => view.draw(cx), (error) => error === stop);
      while (timers.length) timers.shift()(cx);
    }
    assert.equal(focusCalls, 0, `previously selected: ${wasFocused}`);
  }
});

test('Codex names MCP tools inside code-mode scripts and direct calls', () => {
  const { codexStep } = load('mods/chat/log.js', ['codexStep'], {});
  for (const [name, args] of [
    ['exec', 'const result = await tools.mcp__linear__get_issue({ id: "DEVX-42" }); text(result);'],
    ['mcp__linear__get_issue', '{"id":"DEVX-42"}'],
  ]) {
    const step = codexStep(name, args);
    assert.equal(step.kind, 'mcp');
    assert.equal(step.line, 'Used linear: get_issue');
    assert.equal(step.doing, 'get issue (linear)');
  }
  const mixed = codexStep('exec', 'await tools.exec_command({cmd: "git status"}); await tools.mcp__linear__get_issue({id: "DEVX-42"});');
  assert.equal(mixed.parts.length, 2);
  assert.equal(mixed.parts[0].kind, 'run');
  assert.equal(mixed.parts[1].line, 'Used linear: get_issue');
  assert.equal(mixed.doing, 'get issue (linear)');
});

test('space sandbox shields include agents parked behind chat panes', () => {
  const { Spaces } = load('mods/space-folders/main.js', ['Spaces'], { exec() {} });
  for (const sandboxed of [false, true]) {
    const parked = { address: 't1', state: 'live', labels: { 'herdr.chat': 'chat-pane', ...(sandboxed ? { 'herdr.sandbox': '1' } : {}) } };
    const agent = { address: 't1', space: 'space-1', status: 'working' };
    const view = Object.assign(Object.create(Spaces.prototype), { now: { terminals: [parked], agents: [agent] } });
    const facts = view.facts({ id: 'space-1', machine: null });
    assert.equal(facts.sandboxed, sandboxed);
    assert.equal(facts.lead, agent);
  }
});

test('MCP summaries name single calls and count mixed calls', () => {
  const { summary, codexStep, claudeStep } = load('mods/chat/log.js', ['summary', 'codexStep', 'claudeStep'], {});
  const issue = codexStep('mcp__linear__get_issue', {});
  assert.equal(summary([issue]), 'Used linear: get_issue');
  assert.equal(summary([issue, issue]), 'Used 2 MCP tools');
  assert.equal(summary([{ kind: 'run' }, issue]), 'Ran a command and used an MCP tool');
  assert.equal(claudeStep('mcp__linear__get_issue', {}).line, issue.line);
});

test('expanded code-mode MCP calls display their returned text', () => {
  const { resultText } = load('mods/chat/log.js', ['resultText'], {});
  const line = JSON.stringify({ payload: { output: [
    { text: 'Script completed\nOutput:' },
    { text: JSON.stringify({ content: [{ type: 'text', text: 'DEVX-42: Fix the chat panel' }] }) },
  ] } });
  assert.equal(resultText(line, 'call-1'), 'DEVX-42: Fix the chat panel');
});

test('recorded MCP execution identifies dynamically dispatched tools without a script placeholder', (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'herdr-mcp-record-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'session.jsonl');
  const calls = [
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'outer', input: 'await tools[discovered.name]({code});' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', id: 'exec-inner', server: 'codex_apps', tool: 'ogp_mcp_gateway.portal_codemode_execute', status: 'completed', result: { content: [{ type: 'text', text: 'Ticket updated' }], structuredContent: { large: 'x'.repeat(1000000) } } } } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'outer', output: 'Script completed' } },
  ];
  writeFileSync(log, calls.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const { LOG, records, Conversation, summary, resultText } = load('mods/chat/log.js', ['LOG', 'records', 'Conversation', 'summary', 'resultText'], {});
  const read = spawnSync('sh', ['-c', LOG, 'log', 'page', log, '999999999999999', '200'], { encoding: 'utf8' });
  assert.equal(read.status, 0, read.stderr);
  assert.ok(Buffer.byteLength(read.stdout) < 4096, 'large MCP results must stay outside the chat history');
  const conv = new Conversation('codex');
  conv.feed(records(read.stdout).records);
  const steps = conv.items.filter((x) => x.kind === 'tools').flatMap((x) => x.steps);
  assert.equal(steps.length, 1);
  assert.equal(summary(steps), 'Used codex_apps: ogp_mcp_gateway.portal_codemode_execute');
  assert.equal(steps[0].failed, false);
  assert.equal(steps[0].out, Buffer.byteLength(JSON.stringify(calls[0])) + 1);
  assert.equal(resultText(JSON.stringify(calls[1]), 'exec-inner'), 'Ticket updated');
});

test('Codex user attachments become image previews and survive conversation storage', () => {
  const { Conversation } = load('mods/chat/log.js', ['Conversation'], {});
  const conv = new Conversation('codex');
  conv.codex({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text: 'Compare these\n\n/Users/test/attach/first image.png\n/Users/test/attach/second.png' },
  ] } }, 0);
  assert.equal(conv.items[0].text, 'Compare these');
  assert.equal(conv.items[0].images, 2);
  assert.equal(Array.from(conv.items[0].paths).join('|'), '/Users/test/attach/first image.png|/Users/test/attach/second.png');
  conv.codex({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_image', image_url: '/Users/test/attach/embedded.png' },
  ] } }, 100);
  assert.equal(conv.items[1].paths[0], '/Users/test/attach/embedded.png');
  assert.equal(conv.items[1].images, 1);
});

test('Codex restart session lookup ignores helper and reviewer rollouts', (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'herdr-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessions = join(dir, '.codex/sessions/2026/11/05');
  mkdirSync(sessions, { recursive: true });
  const mainId = '00000000-0000-4000-8000-000000000001';
  const main = join(sessions, `rollout-10-${mainId}.jsonl`);
  const helper = join(sessions, 'rollout-11-00000000-0000-4000-8000-000000000002.jsonl');
  for (const [path, source] of [[main, 'vscode'], [helper, { subagent: { other: 'guardian' } }]]) {
    writeFileSync(path, [
      { type: 'session_meta', payload: { source } },
      { type: 'token_count', payload: { info: { model_context_window: 100, last_token_usage: { total_tokens: 10 } } } },
    ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  }
  writeFileSync(join(dir, 'ps'), '#!/bin/sh\nprintf "100 1\\n101 100\\n"\n', { mode: 0o755 });
  writeFileSync(join(dir, 'lsof'), `#!/bin/sh\nprintf 'n%s\\nn%s\\n' '${main}' '${helper}'\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'ls'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(dir, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  mkdirSync(join(dir, 'data/usage'), { recursive: true });
  writeFileSync(join(dir, 'data/usage/codex-limits.json'), JSON.stringify({ checked: Date.now() / 1000,
    data: { at: 1234, source: 'api', week: 51 } }));
  const result = spawnSync('bash', [`${__dirname}/../usage/codex-usage`, '100'], { env: { ...process.env,
    HERDR_APP_HOME: dir, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).session, mainId);
  assert.equal(JSON.parse(result.stdout).ctx, 10);
  assert.equal(JSON.parse(result.stdout).week, 51);
  assert.equal(JSON.parse(result.stdout).at, 1234);
});

test('embedded Codex images are decoded from the log into preview files', async (t) => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'herdr-codex-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ4kAAAAASUVORK5CYII=';
  const record = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${png}` }] } };
  writeFileSync(file, JSON.stringify(record) + '\n');
  record.payload.content[0].image_url = '';
  const stdout = `P 0 1000\n0\tJ\t${JSON.stringify(record)}\n`;
  const { logImages } = load('mods/chat/attach.js', ['logImages'], {
    appHome: () => dir,
    exec: async (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8' });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  });
  const hydrated = await logImages(file, stdout);
  const { records, Conversation } = load('mods/chat/log.js', ['records', 'Conversation'], {});
  const conv = new Conversation('codex');
  conv.feed(records(hydrated).records);
  assert.equal(conv.items[0].images, 1);
  assert.equal(readFileSync(conv.items[0].paths[0]).toString('base64'), png);
  assert.ok(conv.items[0].paths[0].startsWith(join(dir, 'attach')));
});

test('clicking an edited-files card expands its recorded diffs and collapses them again', () => {
  const { Chat } = load('mods/chat/main.js', ['Chat'], {});
  const first = { kind: 'diff', id: 'd1', file: 'docs/design.md', add: 1, del: 1, lines: [{ t: '-', s: 'before' }, { t: '+', s: 'after' }] };
  const second = { kind: 'diff', id: 'd2', file: 'docs/design.md', add: 1, del: 0, lines: [{ t: '+', s: 'another edit' }] };
  const view = Object.assign(Object.create(Chat.prototype), {
    opened: new Set(), width: 760, hitBar: () => null, findQuery: () => '', views: {},
  });
  assert.equal(view.guess(first), 32, 'edit blocks start with their header only');
  const items = view.foldTurns([
    { kind: 'user', id: 'u1', text: 'Edit the design' }, first, second,
    { kind: 'agent', id: 'a1', text: 'Updated it' }, { kind: 'turnend', id: 'end1' },
  ], false);
  const card = items.find((x) => x.kind === 'files');
  assert.equal(card.files[0].diffs.length, 2);
  assert.equal(card.files[0].diffs[0], first);
  Object.assign(view, {
    live: { over: () => [] }, foldTurns: () => [card], status: () => 'idle',
    resolveArts: () => new Map(), loadAskEnds() {}, timelineCards: () => [],
    askEnds: [], replied: [], spaced: (rows) => rows,
  });
  const closedKey = view.key(card);
  assert.equal(view.rows().filter((x) => x.kind === 'diff').length, 0);
  view.clickRow(card.id, [card], { notify() {} }, []);
  const expanded = view.rows().filter((x) => x.kind === 'diff');
  assert.equal(expanded.length, 2);
  assert.equal(expanded[0].lines, first.lines);
  assert.ok(view.guess(expanded[0]) > 32, 'clicking the summary reveals diff lines immediately');
  view.clickRow(expanded[0].id, expanded, { notify() {} }, []);
  assert.equal(view.guess(expanded[0]), 32);
  view.clickRow(expanded[0].id, expanded, { notify() {} }, []);
  assert.ok(view.guess(expanded[0]) > 32);
  assert.notEqual(expanded[0].id, first.id, 'the summary diff must not share expansion state with the work timeline');
  assert.notEqual(view.key(card), closedKey, 'expansion must invalidate the measured row state');
  view.clickRow(card.id, [card], { notify() {} }, []);
  assert.equal(view.rows().filter((x) => x.kind === 'diff').length, 0);
});

test('queued messages can move to a drop target without losing attachments or sending early', () => {
  const { Chat } = load('mods/chat/main.js', ['Chat'], { openCard: () => null });
  const first = { id: 'first', text: 'First', files: [] };
  const second = { id: 'second', text: 'Second', files: [] };
  const third = { id: 'third', text: 'Third', files: [{ path: '/test/image.png' }], quote: { text: 'Quoted context' } };
  let saved = 0, sent = null;
  const view = Object.assign(Object.create(Chat.prototype), {
    queue: [first, second, third], phase: 'ready', asks: [], status: () => 'idle',
    saveSoon: () => saved++, deliver: (message) => { sent = message; },
  });
  const cx = { notify() {} };
  view.moveQueued(third, second, cx);
  assert.equal(view.queue.map((m) => m.id).join(','), 'first,third,second');
  view.moveQueued(third, first, cx);
  assert.equal(view.queue[0], third);
  view.moveQueued(third, third, cx);
  view.moveQueued(second, undefined, cx);
  view.moveQueued({ id: 'stale' }, first, cx);
  assert.equal(saved, 2, 'boundary and stale clicks must leave the queue alone');
  assert.equal(sent, null, 'reordering must never send a message');
  view.moveQueued(third, first, cx);
  assert.equal(view.queue.map((m) => m.id).join(','), 'first,third,second');
  view.moveQueued(third, first, cx);
  view.drainQueue(cx);
  assert.equal(sent, third, 'the reordered message goes first with its original attachments and quote');
});

test('Up edits the last queued message before history and preserves the message extras', () => {
  const { Chat } = load('mods/chat/main.js', ['Chat']);
  const file = { path: '/tmp/note.txt', name: 'note.txt' }, quote = { text: 'Quoted context' };
  const first = { id: 'first', text: 'First queued message', files: [] }, last = { id: 'last', text: 'Last queued\nmessage', files: [file], quote };
  let value = '', focused = false, saved = 0;
  const cx = {};
  const view = Object.assign(Object.create(Chat.prototype), {
    queue: [first, last], files: [], quote: null, recall: -1,
    conv: { items: [{ kind: 'user', text: 'Older sent message' }] }, pending: [],
    box: { value: () => value, set_value: text => { value = text; }, focus: () => { focused = true; } },
    saveSoon: context => { assert.equal(context, cx); saved++; },
  });
  assert.equal(view.recallStep(1, cx), true);
  assert.equal(value, last.text); assert.equal(view.queue.length, 1); assert.equal(view.queue[0], first);
  assert.equal(view.files[0], file); assert.equal(view.quote, quote); assert.ok(focused); assert.equal(saved, 1);
  assert.equal(view.recall, -1, 'editing a queued message must not enter message history');
  assert.equal(view.recallStep(1, cx), false, 'a repeated Up must not overwrite the active edit');
  assert.equal(value, last.text); assert.equal(view.queue.length, 1);
  value = ''; view.queue = [];
  assert.equal(view.recallStep(1, cx), true); assert.equal(value, 'Older sent message');
  assert.equal(view.recallStep(-1, cx), true); assert.equal(value, '');
});

test('Codex native child logs read only their own history across initial pages and tails', async t => {
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const { operation } = await import('../mods/chat/session.mjs');
  const folder = fs.mkdtempSync('/tmp/herdr-child-log-'); t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = `${folder}/child.jsonl`, stamp = '2026-11-06T09:17:05.544Z';
  const data = [
    { type: 'session_meta', payload: { id: 'child', subagent_history_start_ordinal: 5, base_instructions: { text: 'x'.repeat(70000) } } },
    { type: 'session_meta', payload: { id: 'parent' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Parent security audit request' }] } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'parent-tool', output: 'x'.repeat(1100000) } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Parent prose' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Actual child findings' }] } },
  ].map(row => ({ timestamp: stamp, ...row }));
  fs.writeFileSync(file, data.map(JSON.stringify).join('\n') + '\n');
  const { start } = await operation('scope', [file]);
  const { LOG, records, Conversation } = load('mods/chat/log.js', ['LOG', 'records', 'Conversation']);
  for (const args of [['page', file, '999999999999999', '200'], ['tail', file, '0']]) {
    const result = spawnSync('sh', ['-c', LOG, 'log', ...args], { env: { ...process.env, FLOOR: String(start) }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    if (args[0] === 'page') assert.match(result.stdout, /^P 0 /, 'the child boundary is the logical start, so paging never goes into its parent');
    const conv = new Conversation('codex'); conv.feed(records(result.stdout).records);
    assert.deepEqual(Array.from(conv.items, x => x.text).filter(Boolean), ['Actual child findings']);
    assert.ok(!result.stdout.includes('Parent security audit request'));
  }
});

test('native child scope resolves on the owning machine, retries initialization and caches the boundary', async () => {
  const calls = []; let start = null;
  const { Chat } = load('mods/chat/main.js', ['Chat'], { LOG: 'echo log',
    sessionIO: async (...args) => { calls.push(['scope', ...args]); return { start }; },
    exec: async (...args) => { calls.push(['exec', ...args]); return { stdout: 'log' }; },
  });
  const view = Object.assign(Object.create(Chat.prototype), { kind: 'codex', machine: 'vps', path: '/remote/child.jsonl', transcript: { session: 'child' } });
  const args = ['page', view.path, '999999999999999', '200'];
  await assert.rejects(view.log(args), /initializing/); assert.equal(calls.filter(c => c[0] === 'exec').length, 0);
  start = 1234; await view.log(args); await view.log(args);
  assert.equal(calls.filter(c => c[0] === 'scope').length, 2);
  assert.equal(calls[1][3], 'vps'); assert.equal(calls[2][3].on, 'vps'); assert.match(calls[2][2][1], /^FLOOR=1234\nSIDE=1\n/);
});

test('Codex skill submissions dismiss completion without consuming the send Enter', async () => {
  for (const kind of ['codex', 'claude']) {
    const jobs = [];
    let sent, view;
    const { Chat } = load('mods/chat/main.js', ['Chat'], {
      openCard: () => null, slash: { opensMenu: () => null },
      attach: { deliver: async () => [] },
      sendInput: async (_address, text) => { sent = text; view.pending = []; return { code: 0 }; },
    });
    view = Object.assign(Object.create(Chat.prototype), {
      kind, addr: 'test', originKey: 'test', asks: [], replied: [],
      deliverTo: () => ({}), typed: (fn) => fn(), steerNow: async () => {},
    });
    const cx = { notify() {}, spawn: (fn) => jobs.push(fn(cx)), sleep: async () => {} };
    view.deliver({ id: 'message', text: 'lets implement it then. use $council', files: [], notes: [] }, cx);
    await Promise.all(jobs);
    assert.equal(sent, `lets implement it then. use $council${kind === 'codex' ? ' ' : ''}`);
  }
});

test('queue drag handles move messages on drop, cancel outside, and retain keyboard reordering', () => {
  const nodes = new Map(), previews = [];
  function element() {
    const node = { events: new Map() };
    let proxy;
    proxy = new Proxy({}, { get: (_target, name) => {
      if (name === 'id') return (id) => { nodes.set(id, node); return proxy; };
      if (name === 'when') return (condition, fn) => condition ? fn(proxy) : proxy;
      if (name === 'child') return value => { if (typeof value === 'string') previews.push(value); return proxy; };
      if (name.startsWith('on_')) return (...args) => { node.events.set(`${name}:${typeof args[0] === 'string' ? args[0] : ''}`, args.at(-1)); return proxy; };
      return () => proxy;
    } });
    return proxy;
  }
  const { Chat } = load('mods/chat/main.js', ['Chat'], { div: element, h_flex: element, v_flex: element, svg: element, openCard: () => null });
  const queue = [1, 2, 3].map((id) => ({ id, text: `Question ${id}`, files: [] }));
  queue[1].text = 'Second steering message\nexample\r\nmore details';
  let saved = 0, sent = 0;
  const view = Object.assign(Object.create(Chat.prototype), {
    queue, phase: 'ready', asks: [], status: () => 'idle', saveSoon: () => saved++, deliver: () => sent++,
  });
  const cx = { notify() {}, stop_propagation() {} };
  view.queued({});
  assert.ok(previews.includes('Second steering message example more details'), 'queued previews stay on one line when several messages are waiting');
  assert.ok(!previews.some(text => /[\r\n]/.test(text)));
  assert.equal(queue[1].text, 'Second steering message\nexample\r\nmore details', 'the full text is preserved for editing and sending');
  nodes.get('queued-grip-3').events.get('on_mouse_down:left')({}, cx);
  view.drainQueue(cx);
  assert.equal(sent, 0, 'automatic sending pauses during a drag');
  nodes.get('queued-1').events.get('on_mouse_move:')({}, cx);
  assert.equal(view.queueDrag.target.id, 1);
  nodes.get('queued-1').events.get('on_mouse_up:left')({}, cx);
  assert.equal(view.queue.map((m) => m.id).join(','), '3,1,2');
  assert.equal(saved, 1);
  assert.equal(view.queueDrag, null);
  nodes.get('queued-grip-1').events.get('on_mouse_down:left')({}, cx);
  nodes.get('queued-tray').events.get('on_hover:')(false, cx);
  assert.equal(view.queueDrag, null);
  assert.equal(saved, 1, 'canceling does not change the saved queue');
  nodes.get('queued-grip-3').events.get('on_key_down:')({ key: 'down' }, cx);
  assert.equal(view.queue.map((m) => m.id).join(','), '1,3,2');
});

test('repository folders stay active when their agents are parked behind chat panes', () => {
  const { Spaces } = load('mods/space-folders/main.js', ['Spaces'], {
    exec() {}, panes: () => [],
    shared: (key) => key === 'space-folders' ? { '': { list: [{ id: 'idp', name: 'idp' }], of: { 'idp-work': 'idp' } } } : null,
  });
  const row = { w: { id: 'idp-work', machine: null, tabs: [] }, tree: null };
  const cases = [
    { agents: [{ space: 'idp-work', address: 't1', status: 'working' }], terminals: [{ address: 't1', labels: { 'herdr.chat': 'chat-pane' } }], active: true },
    { agents: [{ space: 'idp-work', address: 't1', status: 'idle' }], terminals: [{ address: 't1', labels: { 'herdr.chat': 'chat-pane' } }], active: true },
    { agents: [], terminals: [{ address: 't1', labels: { 'herdr.space': 'idp-work' } }], active: true },
    { agents: [], terminals: [], active: false },
  ];
  for (const { agents, terminals, active } of cases) {
    const view = Object.assign(Object.create(Spaces.prototype), { now: { agents, terminals }, split: (items) => items });
    const folder = view.foldered([row], null, {}, false)[0];
    assert.equal(folder.busy, active);
  }
});

test('skill completion keeps the caret after the inserted skill for menu and Enter selection', () => {
  const { Chat } = load('mods/chat/main.js', ['Chat'], {});
  const completion = { insert: '👋 Please use $council ' };
  for (const keyboard of [false, true]) {
    let text = '👋 Please use $cou', caret = text.length;
    const timers = [];
    const view = Object.assign(Object.create(Chat.prototype), {
      slashSel: 0, suggestions: () => [completion],
      box: { value: () => text, set_value: (value) => { text = value; caret = 0; },
        set_selected_range: (range) => { assert.equal(range.start, range.end); caret = range.end; }, focus() {} },
    });
    const cx = { notify() {}, timer: { after: (_delay, fn) => timers.push(fn) } };
    if (keyboard) view.enter(cx, false); else view.pick(completion, cx);
    assert.equal(text, completion.insert);
    assert.equal(caret, completion.insert.length);
    while (timers.length) timers.shift()(cx);
    assert.equal(caret, completion.insert.length, 'the delayed Enter cleanup must keep the same caret position');
  }
});
