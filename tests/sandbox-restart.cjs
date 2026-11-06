const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');

test('sandbox toggle restarts direct chat agents with their conversation and only kills after launch succeeds', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const folder of ['sandbox', 'agent', 'mods/chat', 'usage']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  for (const file of ['sandbox/agent-restart', 'mods/chat/restart.sh']) fs.copyFileSync(path.join(__dirname, '..', file), path.join(dir, file));
  const script = (file, code) => fs.writeFileSync(path.join(dir, file), code, { mode: 0o755 });
  script('agent/launch', '#!/bin/sh\nexit 99\n');
  script('uname', '#!/bin/sh\necho "${PLATFORM:-Darwin}"\n');
  script('usage/codex-usage', '#!/bin/sh\nprintf \'{"session":"saved-session"}\\n\'\n');
  script('hc', `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'get') console.log(process.env.INFO);
if (args[0] === 'run') { if (process.env.FAIL_RUN) process.exit(1); console.log('{"address":"t2"}'); }
`);
  const info = { argv: ['/app/agent/launch', 'codex'], pid: 987654321, cwd: dir, status: { app: 'codex' },
    foreground: { pid: 987654321, argv: ['bash', '/app/agent/codex-live', 'codex', '-m', 'model', '--sandbox', 'danger-full-access'] },
    labels: { 'herdr.chat': 'pane1', 'herdr.chat.origin': 't0', 'herdr.sandbox': 'box' } };
  const run = (mode, extra = {}) => {
    fs.writeFileSync(path.join(dir, 'calls'), '');
    const result = spawnSync('bash', [path.join(dir, 'sandbox/agent-restart'), 't1', mode], { encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HERDR_APP_HOME: dir, CALLS: path.join(dir, 'calls'), INFO: JSON.stringify(info), ...extra } });
    const calls = fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    return { result, calls };
  };
  for (const mode of ['off', 'on']) {
    const { result, calls } = run(mode);
    assert.equal(result.status, 0, result.stderr);
    const launch = calls.find(args => args[0] === 'run');
    const command = launch.slice(launch.indexOf('--') + 1);
    assert.equal(command[0], path.join(dir, 'agent/launch'));
    assert.equal(command[1] === '--sandbox', mode === 'on');
    assert.ok(command.includes('saved-session') && command.includes('resume') && command.includes('model'));
    assert.ok(launch.includes('herdr.chat=pane1') && launch.includes('herdr.chat.origin=t0'));
    assert.deepEqual(calls.slice(-2), [['kill', 't1'], ['rm', 't1']]);
  }
  const failed = run('off', { FAIL_RUN: '1' });
  assert.notEqual(failed.result.status, 0);
  assert.ok(!failed.calls.some(args => ['kill', 'rm'].includes(args[0])));
  info.argv = ['sh', '-c', 'exec launch codex'];
  assert.equal(run('off').result.status, 0, 'a shell that execed the launcher has no shell to return to');
  const linux = run('on', { PLATFORM: 'Linux' });
  assert.match(linux.result.stderr, /only available on macOS/); assert.deepEqual(linux.calls, []);
  script('usage/codex-usage', '#!/bin/sh\necho "{}"\n');
  const unsaved = run('off');
  assert.match(unsaved.result.stderr, /isn't saved yet/);
  assert.ok(!unsaved.calls.some(args => ['run', 'kill', 'rm'].includes(args[0])));
});

test('sandbox confirmations run on the selected agent host', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../mods/agent-bar/main.js'), 'utf8')
    .replace(/^import [^;]*;\r?\n/gm, '').replace('export default class', 'class');
  for (const address of ['t1', 'mac/t1']) {
    const handlers = new Map(), calls = [], jobs = [];
    const el = () => {
      let id;
      const proxy = new Proxy({}, { get: (_target, key) => key === 'id' ? value => { id = value; return proxy; }
        : key === 'when' ? (on, fn) => on ? fn(proxy) : proxy
        : key === 'on_click' ? fn => { handlers.set(id, fn); return proxy; } : () => proxy });
      return proxy;
    };
    const AgentBar = vm.runInNewContext(`${source}\nAgentBar`, { View: class {}, div: el, v_flex: el, h_flex: el,
      props: () => ({ address, on: false, overlay: 'popup' }), theme: () => ({}), agentAt: () => null, SANDBOX_DIR: '/local/sandbox',
      execFile: async (...args) => { calls.push(args); return { code: 0 }; }, closeOverlay() {} });
    const bar = new AgentBar(), cx = { notify() {}, stop_propagation() {}, spawn: fn => jobs.push(fn(cx)) };
    bar.confirm(); handlers.get('restart')({}, cx); await Promise.all(jobs);
    if (address.includes('/')) {
      assert.equal(calls[0][0], 'sh'); assert.equal(calls[0][2].on, 'mac');
      assert.deepEqual(Array.from(calls[0][1].slice(-2)), ['t1', 'off']);
    } else assert.deepEqual(Array.from(calls[0][1]), ['t1', 'off']);
  }
});
