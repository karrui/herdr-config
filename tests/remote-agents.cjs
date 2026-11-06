// Run: node --test tests/remote-agents.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function load(file, result, globals = {}) {
  const source = readFileSync(`${__dirname}/../${file}`, 'utf8').replace(/^import .*;$/gm, '')
    .replace(/^export /gm, '').replace('default class ', 'class ');
  return vm.runInNewContext(`${source}\n;(${result})`, { View: class {}, ...globals });
}

const listed = () => ['claude', 'codex', 'claude-unsandboxed', 'codex-unsandboxed'].map(key => ({
  key, name: key, installed: false,
  run: ['/Users/me/.config/herdr-app/agent/launch', ...(!key.endsWith('-unsandboxed') ? ['--sandbox'] : []),
    key.split('-')[0], ...(key === 'codex' ? ['--sandbox', 'danger-full-access'] : [])],
}));

test('remote folder/worktree popup detects CLIs and launches with the remote argv', async () => {
  const jobs = [], starts = [];
  const globals = {
    knownAgents: async () => listed(),
    exec: async () => ({ code: 0, stdout: '/workspace/developer/.config/herdr-app\nLinux\nclaude\ncodex\nruntime\n' }),
    shared: () => null,
    InputState: { new: () => ({ on() {}, focus() {}, value: () => '', set_value() {} }) },
  };
  globals.availableAgents = load('mods/chat/launch.js', 'typeof availableAgents === "function" ? availableAgents : undefined', globals);
  const Spaces = load('mods/space-folders/main.js', 'Spaces', globals);
  const view = Object.assign(Object.create(Spaces.prototype), { startSpace: argv => starts.push(argv) });
  const cx = { notify() {}, timer: { after() {} }, spawn: fn => jobs.push(fn(cx)) };
  view.initNewSpace('folder', 'vps-karrui', 'popup', cx);
  await Promise.all(jobs);
  const choices = view.choices();
  assert.deepEqual(Array.from(choices, a => a.installed), [true, true]);
  const argvFor = load('mods/space-folders/main.js', 'argvFor', globals);
  for (const a of choices) {
    const argv = argvFor(a, view.launching.agents, false);
    assert.equal(argv[0], '/workspace/developer/.config/herdr-app/agent/launch');
    assert.deepEqual(Array.from(argv.slice(1)), [a.key]);
  }
});

test('remote discovery requires the runtime and each CLI, preserving other agents', async () => {
  for (const files of ['codex\nruntime', 'claude\ncodex']) {
    const other = { key: 'other', installed: true, run: ['custom-agent'] };
    const availableAgents = load('mods/chat/launch.js', 'availableAgents', {
      knownAgents: async () => [...listed(), other],
      exec: async () => ({ code: 0, stdout: `/remote/app\nLinux\n${files}\n` }),
    });
    const result = await availableAgents('remote');
    assert.equal(result[0].installed, false);
    assert.equal(result[1].installed, files.includes('runtime'));
    assert.equal(result.at(-1), other);
  }
});

test('local discovery keeps the existing launch and installation results', async () => {
  const agents = listed();
  const availableAgents = load('mods/chat/launch.js', 'availableAgents', {
    knownAgents: async () => agents, exec: () => assert.fail('local agents need no remote probe'),
  });
  assert.equal(await availableAgents(null), agents);
});

test('isolated mods share the same remote launcher resolution', () => {
  const source = readFileSync(`${__dirname}/../mods/chat/launch.js`, 'utf8');
  for (const mod of ['new-menu-sandbox', 'space-folders']) {
    assert.equal(readFileSync(`${__dirname}/../mods/${mod}/launch.js`, 'utf8'), source);
  }
});
