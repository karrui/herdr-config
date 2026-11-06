// Run: node --test tests/remote-workspaces.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function load(file, names, globals = {}) {
  const source = readFileSync(`${__dirname}/../${file}`, 'utf8').replace(/^import .*;$/gm, '')
    .replace(/^export /gm, '').replace('default class ', 'class ');
  return vm.runInNewContext(`${source}\n;({${names.join(',')}})`, { View: class {}, ...globals });
}

test('remote spaces and their folders stay active without agents or terminals', () => {
  for (const folder of [false, true]) {
    const { Spaces } = load('mods/space-folders/main.js', ['Spaces'], {
      exec() {}, panes: () => [],
      shared: () => ({ vps: { list: folder ? [{ id: 'repo' }] : [], of: { s1: 'repo' } } }),
    });
    const view = Object.assign(Object.create(Spaces.prototype), {
      now: { agents: [], terminals: [] }, split: items => items,
    });
    const [item] = view.foldered([{ w: { id: 'vps/s1', machine: 'vps', tabs: [], active: false } }], 'vps', {}, false);
    assert.equal(Boolean(item.busy), true, 'remote entries must not enter the folded Inactive section');
  }
});

test('remote chat worktrees use their parked terminal folder for Git and PR lookup', () => {
  const space = { id: 'vps/s1', machine: 'vps', tabs: [{ id: 'vps/tab' }], folder: '' };
  const globals = {
    exec() {}, panes: () => [{ pane: 'vps/chat', tab: 'vps/tab', mod: 'chat' }],
    terminals: () => [{ address: 'vps/t1', state: 'live', cwd: '/workspace/repo',
      foreground: { cwd: '/workspace/repo/src' }, labels: { 'herdr.chat': 'vps/chat' } }],
  };
  for (const file of ['mods/space-folders/main.js', 'mods/worktree-hooks/main.js']) {
    const { place } = load(file, ['place'], globals);
    assert.equal(place(space, globals.panes()), '/workspace/repo/src');
  }
});

test('remote PR badges query the target login shell and preserve the worktree', async () => {
  const on = 'vps', cwd = '/workspace/worktree with spaces', repo = JSON.stringify([on, '/workspace/repo/.git']);
  const key = JSON.stringify([on, cwd]), calls = [];
  const pull = { number: 42, url: 'https://github.com/owner/repo/pull/42', state: 'OPEN', statusCheckRollup: [] };
  const globals = {
    spaces: () => [{ id: 'vps/s1', machine: on }], terminals: () => [], readTextFile: async () => null,
    exec: async command => ({ code: 1, stdout: '', stderr: `${command}: no login auth` }),
    loginExec: async (command, args, options) => { calls.push({ command, args, options }); return { code: 0, stdout: JSON.stringify([pull]) }; },
  };
  const { Spaces } = load('mods/space-folders/main.js', ['Spaces'], globals);
  const view = Object.assign(Object.create(Spaces.prototype), {
    at: { 'vps/s1': key }, git: { [key]: { branch: 'feature', repo } }, prs: {},
  });
  await view.findPRs({ notify() {} }, false);
  assert.equal(view.prs[`${repo}|feature`]?.pr?.number, 42);
  assert.equal(calls[0].command, 'gh');
  assert.equal(calls[0].options.on, on);
  assert.equal(calls[0].options.cwd, cwd);
  assert.equal(calls[0].args.includes('feature'), true);
});

test('PR badges remain visible when the token cannot read CI checks', async () => {
  const place = JSON.stringify(['vps', '/repo']), repo = JSON.stringify(['vps', '/repo/.git']);
  const fields = [];
  const { Spaces } = load('mods/space-folders/main.js', ['Spaces'], {
    exec() {}, spaces: () => [{ id: 'vps/s1', machine: 'vps' }], terminals: () => [], readTextFile: async () => null,
    loginExec: async (_command, args) => {
      fields.push(args.at(-1));
      return args[0] === 'api'
        ? { code: 1, stderr: 'GraphQL: Resource not accessible by personal access token (repository.pullRequests.nodes.0.statusCheckRollup)' }
        : { code: 0, stdout: JSON.stringify([{ number: 42, url: 'https://github.com/owner/repo/pull/42', state: 'OPEN' }]) };
    },
  });
  const view = Object.assign(Object.create(Spaces.prototype), {
    at: { 'vps/s1': place }, git: { [place]: { branch: 'feature', repo } }, prs: {},
  });
  await view.findPRs({ notify() {} }, false);
  assert.equal(view.prs[`${repo}|feature`].pr.number, 42);
  assert.equal(view.prs[`${repo}|feature`].pr.state, 'open');
  assert.equal(fields.length, 2);
  assert.equal(fields[0].includes('statusCheckRollup'), false);
  assert.equal(fields[1].includes('statusCheckRollup{state}'), true);
});

test('aggregate CI status colors PR badges without querying individual check runs', async () => {
  for (const [state, expected] of [['SUCCESS', 'passing'], ['FAILURE', 'error'], ['PENDING', 'pending']]) {
    const place = JSON.stringify(['vps', '/repo']), repo = JSON.stringify(['vps', '/repo/.git']);
    const { Spaces } = load('mods/space-folders/main.js', ['Spaces'], {
      exec() {}, spaces: () => [{ id: 'vps/s1', machine: 'vps' }], terminals: () => [], readTextFile: async () => null,
      loginExec: async (_command, args) => args[0] === 'api'
        ? { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } } } } }) }
        : { code: 0, stdout: JSON.stringify([{ number: 42, state: 'OPEN' }]) },
    });
    const view = Object.assign(Object.create(Spaces.prototype), { at: { 'vps/s1': place }, git: { [place]: { branch: 'feature', repo } }, prs: {} });
    await view.findPRs({ notify() {} }, false);
    assert.equal(view.prs[`${repo}|feature`].pr.state, expected);
  }
});

test('remote worktree fetch uses login auth before creating the new checkout', async () => {
  let fetched = false;
  const globals = {
    execFile: async (command, args) => {
      const result = { code: 0, stdout: '', stderr: '' };
      if (args.includes('symbolic-ref')) result.stdout = 'origin/main\n';
      else if (args.includes('for-each-ref')) result.stdout = 'refs/heads/main\n';
      else if (command === 'test') result.code = 1;
      else if (args.includes('fetch')) return { code: 1, stdout: '', stderr: 'Auth unavailable without login shell' };
      else if (args.includes('worktree') && !fetched) return { code: 1, stdout: '', stderr: 'Using stale origin/main' };
      return result;
    },
    loginExec: async (command, args, options) => {
      assert.equal(command, 'env'); assert.equal(args[0], 'GIT_TERMINAL_PROMPT=0');
      assert.equal(options.on, 'vps'); fetched = true;
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  for (const file of ['mods/space-folders/fresh-worktree.js', 'mods/worktree-hooks/fresh-worktree.js']) {
    fetched = false;
    const { freshWorktree } = load(file, ['freshWorktree'], globals);
    const result = await freshWorktree('/workspace/repo', 'feature', branch => `/workspace/worktrees/${branch}`, 'vps');
    assert.equal(result.error, undefined);
    assert.equal(result.branch, 'feature');
  }
});

test('login shell preserves argument boundaries, auth and cwd even when startup changes it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr shell '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const shell = path.join(directory, 'login-shell');
  fs.writeFileSync(shell, '#!/bin/sh\n[ "$1" = -lic ] || exit 91\nshift\nexport HERDR_TEST_AUTH=loaded\ncd /\nexec /bin/sh -c "$@"\n', { mode: 0o755 });
  const { loginExec } = load('mods/space-folders/shell.js', ['loginExec'], {
    exec: async (command, args, options) => {
      const r = spawnSync(command, args, { cwd: options.cwd, env: { ...process.env, SHELL: shell }, encoding: 'utf8' });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  });
  const values = ['spaces in a path', "apostrophe's", '$(exit 99)', '你好', '; false'];
  const r = await loginExec(process.execPath, ['-e', 'console.log(JSON.stringify([process.cwd(), process.env.HERDR_TEST_AUTH, ...process.argv.slice(1)]))', '--', ...values], { cwd: directory });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [fs.realpathSync(directory), 'loaded', ...values]);
  assert.equal(readFileSync(`${__dirname}/../mods/space-folders/shell.js`, 'utf8'), readFileSync(`${__dirname}/../mods/worktree-hooks/shell.js`, 'utf8'));
});
