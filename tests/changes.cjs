// Run: node --test tests/changes.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const gitSource = fs.readFileSync(path.join(__dirname, '../mods/changes-sandbox/git.js'), 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const source = gitSource + '\n' + fs.readFileSync(path.join(__dirname, '../mods/changes-sandbox/main.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace('export default class ', 'class ');
function load(globals) { return vm.runInNewContext(`${source}\n;({Changes, diffRows, WORKTREE_DIFF, readCounts})`, { View: class {}, ...globals }); }
function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr changes ')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  git('init', '-q');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  return { dir, git, write: (file, text) => fs.writeFileSync(path.join(dir, file), text) };
}
async function panel(dir) {
  let pending = [];
  const { Changes, readCounts } = load({
    props: () => ({}), localStorage: { getItem: () => null, setItem() {} }, agents: () => [],
    spaces: () => [{ active: true, folder: dir, machine: null }], panes: () => [], terminals: () => [], focused: () => ({ cwd: dir }),
    execFile: async (cmd, args, options) => {
      try { return { code: 0, ...await promisify(execFile)(cmd, Array.from(args), { cwd: options.cwd, maxBuffer: 4 * 1024 * 1024 }) }; }
      catch (e) { return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }; }
    },
    readTextFile: async file => fs.readFileSync(file, 'utf8'),
  });
  const view = new Changes(); view.watch = () => {};
  const cx = { notify() {}, timer: { every() {} }, focus_handle: () => ({ focus() {} }), spawn: fn => { pending.push(fn(cx)); } };
  const drain = async () => { while (pending.length) { const batch = pending; pending = []; await Promise.all(batch); } assert.equal(view.error, null); };
  view.init({}, cx); await drain();
  return { view, counts: () => readCounts({ cwd: dir, on: null }), mode: async mode => { view.setMode(mode, null, cx); await drain(); } };
}

test('counts include staged, unstaged, untracked and binary files without changing the staging index', async t => {
  const r = repo(t);
  r.write('.gitignore', 'ignored/\n'); r.write('tracked.txt', 'old\n');
  r.git('add', '.'); r.git('commit', '-qm', 'initial');
  r.write('tracked.txt', 'new\nmore\n'); r.write('staged.txt', 'staged\n'); r.git('add', 'staged.txt');
  r.write('new file\nwith tab\t.txt', 'first\nlast'); r.write('image.bin', Buffer.from([0, 1, 2]));
  fs.mkdirSync(path.join(r.dir, 'ignored')); r.write('ignored/noise.txt', 'ignored\n');
  const before = fs.readFileSync(path.join(r.dir, '.git/index'));
  const { view, counts, mode } = await panel(r.dir);
  assert.deepEqual(JSON.parse(JSON.stringify(view.totals)), { add: 5, del: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(await counts())), { add: 5, del: 1, files: 4 }, 'toolbar and panel must agree');
  assert.equal(view.files.length, 4);
  assert.equal(view.files.find(f => f.path.startsWith('new file')).add, 2, 'new files count before they are opened');
  await mode('staged'); assert.deepEqual(JSON.parse(JSON.stringify(view.totals)), { add: 1, del: 0 });
  await mode('unstaged'); assert.deepEqual(JSON.parse(JSON.stringify(view.totals)), { add: 4, del: 1 });
  assert.deepEqual(fs.readFileSync(path.join(r.dir, '.git/index')), before);
});

test('an unborn repository counts new files without creating a real index', async t => {
  const r = repo(t); r.write('first.txt', 'first\nlast');
  const { view, counts } = await panel(r.dir);
  assert.deepEqual(JSON.parse(JSON.stringify(view.totals)), { add: 2, del: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(await counts())), { add: 2, del: 0, files: 1 });
  assert.equal(fs.existsSync(path.join(r.dir, '.git/index')), false);
});

test('the panel and tab bar share identical Git counting logic', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '../mods/tabs-sandbox/git.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../mods/changes-sandbox/git.js'), 'utf8'));
});

test('a staged edit undone in the working tree counts as zero net uncommitted lines', async t => {
  const r = repo(t); r.write('file.txt', 'old\n'); r.git('add', '.'); r.git('commit', '-qm', 'initial');
  r.write('file.txt', 'staged\n'); r.git('add', '.'); r.write('file.txt', 'old\n');
  const { view, mode } = await panel(r.dir);
  assert.deepEqual(JSON.parse(JSON.stringify(view.totals)), { add: 0, del: 0 });
  await mode('staged'); assert.deepEqual(JSON.parse(JSON.stringify(view.totals)), { add: 1, del: 1 });
  await mode('unstaged'); assert.deepEqual(JSON.parse(JSON.stringify(view.totals)), { add: 1, del: 1 });
});

test('Open in actions preserve path arguments and never start a review daemon', async () => {
  const elements = new Map(), calls = [];
  const element = () => {
    const state = { events: {} };
    const node = new Proxy(state, { get(target, key) {
      if (key in target) return target[key];
      return (...args) => {
        if (key === 'when' && args[0]) args[1](node);
        if (key === 'id') elements.set(args[0], node);
        if (key === 'on_click') state.events.click = args[0];
        return node;
      };
    } }); return node;
  };
  const target = { path: "/repo/space and quote's.txt", file: true };
  const { Changes } = load({
    props: () => ({ openIn: target, overlay: 'menu' }), theme: () => ({}),
    div: element, svg: element, h_flex: element, v_flex: element,
    execFile: async (cmd, args) => { calls.push([cmd, Array.from(args)]); return { code: 0 }; }, closeOverlay() {},
  });
  let pending;
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn: fn => { pending = fn(cx); } };
  const view = new Changes(); view.init({}, cx); view.render(cx);
  elements.get('changes-open-code').events.click({}, cx); await pending;
  elements.get('changes-open-finder').events.click({}, cx); await pending;
  assert.deepEqual(calls, [['open', ['-b', 'com.microsoft.VSCode', target.path]], ['open', ['-R', target.path]]]);
});
