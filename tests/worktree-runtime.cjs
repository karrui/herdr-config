// Run: node --test tests/worktree-runtime.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');

function load(file, names, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/^import .*;$/gm, '')
    .replace(/^export /gm, '').replace('default class ', 'class ');
  return vm.runInNewContext(`${source}\n;({${names.join(',')}})`, { View: class {}, ...globals });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr hooks '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main'), checkout = path.join(root, 'checkout with spaces');
  const app = path.join(root, 'app'), bin = path.join(root, 'bin');
  fs.mkdirSync(main); fs.mkdirSync(path.join(app, 'agent'), { recursive: true }); fs.mkdirSync(bin);
  const script = path.join(app, 'agent/worktree');
  fs.copyFileSync(path.join(__dirname, '../agent/worktree'), script); fs.chmodSync(script, 0o755);
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'herdr-app'), '#!/bin/sh\nprintf closed >> "$TEST_ORDER"\n', { mode: 0o755 });
  const env = { ...process.env, HOME: root, HERDR_APP_HOME: app, TEST_ORDER: path.join(root, 'order'), PATH: `${bin}:${process.env.PATH}` };
  const run = (command, args, cwd = main) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 20000 });
  const git = (...args) => { const r = run('git', args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-b', 'main'); git('config', 'user.name', 'Herdr fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(main, 'tracked'), 'original\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'setup.out\ncopy with spaces.cfg\n');
  fs.writeFileSync(path.join(main, '.termic.yaml'), 'scripts:\n  setup: printf setup > setup.out\n  archive: printf teardown >> "$TEST_ORDER"\n  files_to_copy:\n    - copy with spaces.cfg\n');
  git('add', '.'); git('commit', '-m', 'fixture'); git('worktree', 'add', '-b', 'fixture', checkout);
  fs.writeFileSync(path.join(main, 'copy with spaces.cfg'), 'copied\n');
  return { root, main, checkout, app, bin, script, env, run, git,
    hook: (...args) => run(script, args), config: path.join(app, 'worktrees/main.yaml') };
}

test('worktree runtime imports config, copies files, runs setup and preserves dirty checkouts', t => {
  const f = fixture(t);
  let r = f.hook('setup', f.checkout); assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(f.checkout, 'setup.out'), 'utf8'), 'setup');
  assert.equal(fs.readFileSync(path.join(f.checkout, 'copy with spaces.cfg'), 'utf8'), 'copied\n');
  r = f.hook('config', f.checkout); assert.equal(r.status, 0, r.stderr);
  const config = JSON.parse(r.stdout); assert.equal(config.copy[0], 'copy with spaces.cfg');
  fs.writeFileSync(path.join(f.checkout, 'tracked'), 'keep my changes\n');
  r = f.hook('closed', f.checkout); assert.equal(r.status, 3, r.stderr);
  assert.equal(fs.readFileSync(path.join(f.checkout, 'tracked'), 'utf8'), 'keep my changes\n');
  assert.equal(fs.readFileSync(f.env.TEST_ORDER, 'utf8'), 'teardown');
  fs.writeFileSync(path.join(f.checkout, 'tracked'), 'original\n');
  r = f.hook('finish', f.checkout, 'closed', '', ''); assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(f.checkout), false);
  assert.equal(f.git('branch', '--list', 'fixture'), 'fixture', 'automatic cleanup keeps the branch');
});

test('a failing teardown or invalid config never closes or removes the worktree', t => {
  const f = fixture(t);
  let r = f.hook('save', f.checkout, JSON.stringify({ copy: [], setup: '', teardown: 'exit 7' })); assert.equal(r.status, 0, r.stderr);
  r = f.hook('remove', f.checkout, 's1', '', 'fixture'); assert.equal(r.status, 7, r.stderr);
  assert.equal(fs.readFileSync(path.join(f.app, 'agent/logs/s1.log.exit'), 'utf8').trim(), '7');
  assert.equal(fs.existsSync(f.checkout), true); assert.equal(fs.existsSync(f.env.TEST_ORDER), false);
  fs.writeFileSync(f.config, 'setup: [broken\n');
  r = f.hook('remove', f.checkout, 's1', '--force', 'fixture'); assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(f.checkout), true); assert.equal(fs.existsSync(f.env.TEST_ORDER), false);
});

test('failed teardown restores the space row, reports the failure and permits retry', async () => {
  let going = { 'vps/s1': Date.now() }, notices = 0;
  const jobs = [], cx = { notify() {}, spawn: fn => jobs.push(fn(cx)) };
  const { Spaces } = load('mods/space-folders/main.js', ['Spaces'], {
    exec() {}, appHome: () => '/app', spaces: () => [{ id: 'vps/s1' }],
    shared: () => going, setShared: (_key, value) => { going = value; }, notify: () => notices++,
    readTextFile: async file => file.endsWith('.exit') ? '7\n' : 'Teardown command failed\n',
  });
  const view = Object.assign(Object.create(Spaces.prototype), { teardown: { 'vps/s1': {} } });
  view.watchTeardown(cx); await Promise.all(jobs);
  assert.equal(notices, 1); assert.equal(Object.keys(going).length, 0); assert.equal(Object.keys(view.teardown).length, 0);
});

test('desktop coordinates remote teardown, then space close, then removal', t => {
  const f = fixture(t), desktop = path.join(f.root, 'desktop');
  fs.mkdirSync(path.join(desktop, 'agent'), { recursive: true });
  const coordinator = path.join(desktop, 'agent/worktree'); fs.copyFileSync(f.script, coordinator); fs.chmodSync(coordinator, 0o755);
  const fake = path.join(f.bin, 'hc.cjs');
  fs.writeFileSync(fake, `const {spawnSync}=require('node:child_process');
    let args=process.argv.slice(2); if(args.shift()!=='exec')process.exit(90);
    while(args[0]==='--on'||args[0]==='--timeout')args.splice(0,2);
    if(args[0]==='bash')args=args.slice(4);
    const r=spawnSync(args[0],args.slice(1),{env:{...process.env,HERDR_APP_HOME:process.env.REMOTE_APP},encoding:'utf8'});
    process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);`);
  fs.writeFileSync(path.join(f.bin, 'hc'), `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o755 });
  const r = spawnSync(coordinator, ['remote', 'vps', 'remove', f.checkout, 'vps/s1', '', 'fixture'], {
    env: { ...f.env, HERDR_APP_HOME: desktop, REMOTE_APP: f.app }, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr + fs.readFileSync(path.join(desktop, 'agent/logs/vps/s1.log'), 'utf8'));
  assert.equal(fs.readFileSync(f.env.TEST_ORDER, 'utf8'), 'teardownclosed');
  assert.equal(fs.existsSync(f.checkout), false);
  assert.equal(f.git('branch', '--list', 'fixture'), '');
});

test('worktree UI launches the runtime and routes config and resources to their machine', async () => {
  const calls = [];
  const { worktreeArgv, worktreeExec } = load('mods/space-folders/worktree-runtime.js', ['worktreeArgv', 'worktreeExec'], {
    appHome: () => '/desktop/app', loginExec: async (...args) => { calls.push(args); return { code: 0 }; },
  });
  const argv = worktreeArgv('start', '/workspace/with spaces', ['--', 'codex'], 'vps');
  assert.equal(argv.includes('/desktop/app/agent/worktree'), false);
  assert.deepEqual(Array.from(argv.slice(-4)), ['start', '/workspace/with spaces', '--', 'codex']);
  await worktreeExec('save', '~/Projects/idp', ['{"setup":"echo hi"}'], 'vps');
  assert.equal(calls[0][2].on, 'vps');
  const Tabs = load('mods/tabs-sandbox/main.js', ['Tabs'], { spaces: () => [], panes: () => [] }).Tabs;
  const view = Object.assign(Object.create(Tabs.prototype), { spaceFolder: () => ({ on: 'vps', folder: '/workspace/worktree', id: 'vps|worktree' }), look: async (_s, _k, _f, _cx, work) => work() });
  // Exercise the actual remote resource path without a Docker daemon.
  const RoutedTabs = load('mods/tabs-sandbox/main.js', ['Tabs'], { worktreeExec: async (...args) => { calls.push(args); return { stdout: '{"containers":[],"volumes":[]}' }; }, shared: () => null }).Tabs;
  Object.setPrototypeOf(view, RoutedTabs.prototype); view.resources = {};
  view.countResources({}); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1)[0], 'resources'); assert.equal(calls.at(-1)[3], 'vps');
});

test('a disconnected remote layout never triggers automatic teardown', () => {
  let ready = false, cleaned = 0;
  const { Spaces } = load('mods/space-folders/main.js', ['Spaces'], {
    exec() {}, machines: () => [{ name: 'vps', layout: ready ? 'ready' : 'unavailable' }],
    spaces: () => [], panes: () => [], shared: () => null,
  });
  const view = Object.assign(Object.create(Spaces.prototype), { worktrees: { 'vps/s1': { top: '/workspace/.herdr/worktrees/idp/topic', on: 'vps' } }, git: {}, cleanUp() { cleaned++; } });
  view.watchClosed({}); assert.equal(cleaned, 0); assert.ok(view.worktrees['vps/s1']);
  ready = true; view.watchClosed({}); assert.equal(cleaned, 1);
});

test('remote worktrees collect by their main checkout even without a main-checkout space', () => {
  const { folderOf } = load('mods/space-folders/main.js', ['folderOf'], { exec() {}, terminals: () => [] });
  const s = { id: 'vps/s1', machine: 'vps', folder: '/workspace/developer/.herdr/worktrees/idp/topic', tabs: [] };
  const f = { list: [{ id: 'idp', match: '/workspace/developer/Projects/idp' }], of: {} };
  const git = { repo: JSON.stringify(['vps', '/workspace/developer/Projects/idp/.git']) };
  assert.equal(folderOf(s, f, [], git), 'idp');
  assert.equal(folderOf(s, { ...f, of: { s1: '' } }, [], git), null, 'an explicit drag out still wins');
});

test('remote folder menus open the setup editor on the folder machine', () => {
  const clicks = {}, overlays = [];
  function element() {
    let id;
    const el = new Proxy({}, { get(_target, name) {
      if (name === 'id') return value => { id = value; return el; };
      if (name === 'on_click') return action => { clicks[id] = action; return el; };
      if (name === 'when') return (condition, draw) => condition ? draw(el) : el;
      return () => el;
    } });
    return el;
  }
  const { Spaces } = load('mods/space-folders/main.js', ['Spaces'], {
    exec() {}, div: element, v_flex: element, h_flex: element,
    shared: () => ({ vps: { list: [{ id: 'idp', path: '/workspace/developer/Projects/idp' }], of: {} } }),
    closeOverlay() {}, openOverlay: value => overlays.push(value), home: () => '/Users/local',
  });
  const view = Object.assign(Object.create(Spaces.prototype), { folderMenu: { id: 'idp', machine: 'vps' } });
  view.folderMenuView({}); clicks['folder-worktree']();
  assert.equal(overlays[0].mod, 'worktree-setup');
  assert.equal(overlays[0].props.machine, 'vps');
  assert.equal(overlays[0].props.folder, '/workspace/developer/Projects/idp');
});
