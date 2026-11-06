const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(globals) {
  const source = fs.readFileSync(`${__dirname}/../mods/chat/main.js`, 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '').replace('default class ', 'class ');
  return vm.runInNewContext(`${source}\n;Chat`, { View: class {}, ...globals });
}

test('deferred chat rows register no event handlers during native virtual-list layout', () => {
  const element = () => new Proxy({}, { get: (_target, key) => {
    if (key === 'when') return (on, fn) => on ? fn(element()) : element();
    if (key.startsWith('on_')) return () => { throw new Error('Handlers cannot be registered inside a virtual-list renderer'); };
    return () => element();
  } });
  const Chat = load({ div: element, h_flex: element, v_flex: element, svg: element, TextView: { markdown: element },
    fileName: p => p.split('/').at(-1), green: () => '#00ff00', red: () => '#ff0000' });
  const view = Object.assign(Object.create(Chat.prototype), { width: 600, opened: new Set(), findMark: x => x });
  for (const row of [
    { kind: 'agent', id: 'answer', text: '[developer.ts](/repo/developer.ts)' },
    { kind: 'files', id: 'edited', files: [{ file: '/repo/developer.ts', add: 3, del: 1 }] },
    ...view.fileCardRows({ kind: 'files', id: 'split-card', files: [{ file: '/repo/developer.ts', add: 3, del: 1 }] }),
  ]) assert.doesNotThrow(() => view.rowBare(row, {}));
  const globals = { div: element, h_flex: element, v_flex: element, svg: element, theme: () => ({}), settings: () => ({ dark: true }) };
  const module = (file, names, env = {}) => {
    const source = fs.readFileSync(`${__dirname}/../mods/chat/${file}`, 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '');
    return vm.runInNewContext(`${source}\n;({${names.join(',')}})`, { ...globals, ...env });
  };
  const asks = module('asks.js', ['words', 'answers', 'deny']);
  const { AskCards } = module('cards.js', ['AskCards'], asks);
  const ui = module('ui.js', ['button', 'red', 'TEXT', 'RADIUS']);
  const strips = module('strips.js', ['strip'], ui);
  const cards = new AskCards({}, {}), req = { tool_name: 'AskUserQuestion', elicitation: { property: 'p' },
    tool_input: { questions: [{ question: 'Allow Herdr?', strict: true, options: [{ label: 'Allow', value: 'once' }, { label: 'Always allow', value: 'always' }] }] } };
  const ask = { id: 'permission', req, words: asks.words(req) };
  const PermissionChat = load({ ...globals, strips }), permissionView = Object.assign(Object.create(PermissionChat.prototype), { width: 600 });
  const lines = cards.strips(ask, { who: 'Codex' });
  for (const [i, s] of lines.entries()) assert.doesNotThrow(() => permissionView.rowBare({ kind: 'cardstrip', id: `${i}`, s, first: i === 0, last: i === lines.length - 1 }, {}));
});

test('edited files use independent virtual rows and the list click opens the exact file', () => {
  const Chat = load({});
  const opened = [];
  const view = Object.assign(Object.create(Chat.prototype), { opened: new Set(), hitBar: () => null, openLink: path => opened.push(path) });
  const card = { id: 'edited', kind: 'files', files: [
    { file: '/repo/a.ts', add: 1, del: 0, diffs: [{ id: 'first' }] },
    { file: '/repo/b.ts', add: 2, del: 1, diffs: [{ id: 'second' }] },
  ] };
  const rows = view.fileCardRows(card), cx = { notify() {} };
  assert.equal(rows.length, 3); assert.equal(rows[0].headerOnly, true); assert.equal(rows[2].last, true);
  view.clickRow(rows[2].id, rows, cx, []);
  assert.deepEqual(opened, ['/repo/b.ts']); assert.equal(view.opened.size, 0);
  view.clickRow(rows[0].id, rows, cx, []);
  assert.ok(view.opened.has('edited')); assert.ok(view.opened.has('edited:second'));
});
