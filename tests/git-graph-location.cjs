const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../mods/git-graph/graph.js`, 'utf8')
  .replace(/^import[\s\S]*? from ["'][^"']+["'];/gm, '').replace(/^export /gm, '');

test('graph follows local and remote chat worktrees through their parked terminals', () => {
  for (const on of [null, 'vps']) {
    const location = vm.runInNewContext(`${source}\n;location`, {
      spaces: () => [{ active: true, machine: on, folder: '/main' }],
      focused: () => ({ pane: 'chat', cwd: null }), panes: () => [{ pane: 'chat', mod: 'chat' }],
      terminals: () => [{ state: 'live', cwd: '/fallback', foreground: { cwd: '/worktree/web' }, labels: { 'herdr.chat': 'chat' } }],
      props: () => ({ machine: on }),
    });
    assert.deepEqual(JSON.parse(JSON.stringify(location())), { cwd: '/worktree/web', on });
    assert.deepEqual(JSON.parse(JSON.stringify(location('/explicit'))), { cwd: '/explicit', on });
  }
});

test('graph follows a remote layout terminal independently of the active space', () => {
  const location = vm.runInNewContext(`${source}\n;location`, {
    spaces: () => [{ active: true, machine: null, folder: '/local' }],
    focused: () => ({ pane: null, terminal: 'vps/t1', cwd: '/remote' }), panes: () => [],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(location())), { cwd: '/remote', on: 'vps' });
});

test('remote history, commit details and diffs execute on the owning machine', async t => {
  const { spawnSync } = require('node:child_process');
  const { tmpdir } = require('node:os');
  const path = require('node:path');
  const git = await import('../mods/git-graph/git.js');
  const repo = fs.mkdtempSync(path.join(tmpdir(), 'graph-remote-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const run = args => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'commit.gpgsign', 'false']]) assert.equal(run(args).status, 0);
  fs.writeFileSync(path.join(repo, 'file'), 'remote contents\n');
  assert.equal(run(['add', 'file']).status, 0);
  assert.equal(run(['commit', '-qm', 'remote commit']).status, 0);
  const calls = [], pending = [], cx = { notify() {}, spawn(fn) { pending.push(fn(cx)); } };
  const { Graph, readFolder } = vm.runInNewContext(`${source}\n;({ Graph, readFolder })`, {
    ...git,
    exec: async (program, args, options) => {
      assert.equal(program, 'git');
      assert.equal(options.on, 'vps');
      assert.equal(fs.realpathSync(options.cwd), fs.realpathSync(repo));
      calls.push(args);
      const r = run(args);
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  });
  const read = await readFolder(repo, 'vps', { all: true, remotes: true, limit: 10 });
  assert.equal(read.base[0].subject, 'remote commit');
  const graph = Object.assign(new Graph(), read, { commitDetails: new Map(), selected: read.head });
  graph.loadDetails(read.base[0], cx);
  await Promise.all(pending.splice(0));
  assert.equal(graph.details.message, 'remote commit');
  assert.equal(graph.details.files[0].path, 'file');
  graph.openDiff(read.base[0], graph.details.files[0], cx);
  await Promise.all(pending.splice(0));
  assert.ok(graph.diff.rows.some(row => row.text.includes('remote contents')));
  assert.ok(calls.some(args => args.includes('log')));
  assert.ok(calls.some(args => args.includes('show')));
});

test('remote Git actions and bulk fetch load the target login shell without falling back locally', async () => {
  assert.equal(fs.readFileSync(`${__dirname}/../mods/git-graph/shell.js`, 'utf8'),
    fs.readFileSync(`${__dirname}/../mods/resources/shell.js`, 'utf8'));
  const { executeAction } = await import('../mods/git-graph/execute.js');
  const { doneText } = await import('../mods/git-graph/git.js');
  const { FETCH } = await import('../mods/git-graph/repos.js');
  const calls = [], local = async () => { throw new Error('must not run locally'); };
  const loginExec = async (program, args, options) => {
    calls.push({ program, args: [...args], ...options });
    return { code: 0, stdout: '', stderr: '' };
  };
  const actionSource = fs.readFileSync(`${__dirname}/../mods/git-graph/act.js`, 'utf8')
    .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  const { perform } = vm.runInNewContext(`${actionSource}\n;({ perform })`, {
    exec: local, loginExec, executeAction, doneText, notify() {}, setShared() {},
  });
  assert.equal((await perform({ type: 'fetch' }, {}, { root: '/remote/repo', on: 'vps' })).ok, true);
  assert.equal(calls[0].on, 'vps');
  assert.equal(calls[0].cwd, '/remote/repo');
  assert.ok(calls[0].args.includes('fetch'));

  const { Graph } = vm.runInNewContext(`${source}\n;({ Graph })`, {
    exec: local, loginExec, FETCH, fetchable: () => true, notify() {},
  });
  const pending = [], cx = { notify() {}, spawn(fn) { pending.push(fn(cx)); } };
  const graph = Object.assign(new Graph(), {
    workspace: { root: '/remote', repos: [{ path: '/remote/repo' }] },
    on: 'vps', statuses: new Map(), fetchErrors: new Map(), readStatus: async () => {},
  });
  graph.fetchEvery(cx);
  await Promise.all(pending);
  assert.equal(calls[1].program, 'env');
  assert.equal(calls[1].on, 'vps');
  assert.equal(calls[1].cwd, '/remote/repo');
  assert.deepEqual(calls[1].args, [...FETCH]);
});
