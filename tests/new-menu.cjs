// Run: node --test tests/new-menu.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/../mods/new-menu-sandbox/main.js`, 'utf8')
  .replace(/^import .*;$/gm, '').replace('export default class ', 'class ');

for (const [name, pane, focusCwd, terminals, expected] of [
  ['terminal subdirectory', { cwd: '/repo/src' }, '/repo/src', [], '/repo/src'],
  ['chat with parked agent', { mod: 'chat' }, null, [
    { state: 'live', labels: { 'herdr.chat': 'other' }, cwd: '/wrong' },
    { state: 'exited', labels: { 'herdr.chat': 'p1' }, cwd: '/stale' },
    { state: 'live', labels: { 'herdr.chat': 'p1' }, cwd: '/repo', foreground: { cwd: '/repo/src' } },
  ], '/repo/src'],
  ['chat without foreground cwd', { mod: 'chat' }, null, [
    { state: 'live', labels: { 'herdr.chat': 'p1' }, cwd: '/repo/src' },
  ], '/repo/src'],
  ['layout terminal', null, '/repo/src', [], '/repo/src'],
  ['space fallback', { mod: 'files' }, null, [], '/repo'],
]) {
  test(`+ menu inherits ${name} for mouse and keyboard launches`, () => {
    const rows = new Map(), calls = [];
    let onKey, focus = { pane: pane ? 'p1' : null, cwd: focusCwd };
    let el;
    el = new Proxy({}, { get: (_, key) => (...args) => {
      if (key === 'when' && args[0]) args[1](el);
      if (key === 'on_key_down') onKey = args[0];
      return el;
    } });
    const globals = {
      View: class {}, div: () => el, svg: () => el, image: () => el, v_flex: () => el,
      theme: () => ({}), spaces: () => [{ id: 's1', active: true, folder: '/repo' }],
      panes: () => pane ? [{ pane: 'p1', focused: true, ...pane }] : [],
      focused: () => focus, terminals: () => terminals, props: () => ({ overlay: 'menu' }),
      keys: () => [], closeOverlay: () => { focus = null; },
      run: (command, args) => calls.push({ command, args }),
    };
    const NewMenu = vm.runInNewContext(`${source}\nNewMenu`, globals);
    const view = new NewMenu();
    view.agents = ['codex', 'claude', 'other'].map(key => ({ key, name: key, run: [key], installed: true }));
    view.row = (id, _icon, _name, action) => { rows.set(id, () => { globals.closeOverlay(); action(); }); return el; };
    view.render();
    for (const key of ['codex', 'claude', 'other', 'terminal']) rows.get(key)();
    onKey({ key: '1', modifiers: {} });
    assert.equal(calls.length, 5);
    for (const { command, args } of calls) {
      assert.equal(command, 'tab.new');
      assert.equal(args.space, 's1');
      assert.equal(args.folder, expected);
    }
    assert.equal(calls[0].args.argv.at(-1), 'codex');
    assert.equal(calls[0].args.argv[2].includes('chat.start=1'), true);
    assert.equal(calls[2].args.argv[0], 'other');
  });
}
