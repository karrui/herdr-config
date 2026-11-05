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

const space = { active: true, folder: '/other', branch: 'other-branch', machine: 'remote' };
const chat = { pane: 'chat-pane', mod: 'chat' };
const terminal = { address: 'remote/t1', state: 'live', cwd: '/initial', foreground: { cwd: '/worktree' }, labels: { 'herdr.chat': chat.pane } };
const context = {
  spaces: () => [space], panes: () => [chat], terminals: () => [terminal],
  focused: () => ({ pane: chat.pane }), shared: () => null, LINKS: 'linear.links',
};

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

test('tab bar renders while branch statistics are still loading', () => {
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
    div: () => element, h_flex: () => element, svg: () => element,
  });
  const view = Object.assign(Object.create(Tabs.prototype), {
    resources: {}, branch: {}, ticket: {}, spaceFolder: () => ({ id: 'new-folder' }),
    countResources() {}, countBranch() {}, findLinear() {}, syncPanel() {}, linearPlace: () => null,
  });
  view.render({});
});
