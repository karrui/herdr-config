const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(globals = {}) {
  const code = fs.readFileSync(`${__dirname}/../mods/chat/links.js`, 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  return vm.runInNewContext(`${code}\n;({codeTarget,openCodeLink})`, { URL, home: () => '/home/me', ...globals });
}

test('code links resolve relative paths, file URLs, spaces and line references', () => {
  const { codeTarget } = load();
  for (const [link, path, line] of [
    ['/repo/src/a.ts:23:4', '/repo/src/a.ts', 23], ['a.ts:2', '/repo/pkg/a.ts', 2],
    ['file:///repo/space%20name.ts#L12-L14', '/repo/space name.ts', 12],
    ['../src/a.ts#L3C4', '/repo/src/a.ts', 3], ['%2Frepo%2Fa.ts', '/repo/a.ts', null],
    ['~/a.ts', '/home/me/a.ts', null],
  ]) assert.deepEqual(JSON.parse(JSON.stringify(codeTarget(link, '/repo/pkg'))), { path, line });
  for (const url of ['https://example.com:123', 'https://example.com/a.ts#L2', 'mailto:a@example.com', 'file://server/a.ts', '#heading', '/a\0.ts']) assert.equal(codeTarget(url, '/repo'), null);
});

test('file and web links use the system opener without starting a review service', async () => {
  const calls = [];
  const { openCodeLink } = load({
    window: () => ({ platform: 'macos' }),
    exec: async (cmd, args) => { calls.push([cmd, Array.from(args)]); return { code: 0 }; },
  });
  const here = { cwd: '/repo', machine: null };
  await openCodeLink('src/a.ts#L23', here);
  await openCodeLink('https://example.com', here);
  assert.deepEqual(calls, [['open', ['/repo/src/a.ts']], ['open', ['https://example.com']]]);
  await assert.rejects(openCodeLink('src/a.ts', { ...here, machine: 'vps' }), /own machine/);
  await assert.rejects(openCodeLink('javascript:alert(1)', here), /cannot be opened/);
  assert.equal(calls.length, 2);
});

test('a text file opens in its tab\'s viewer: split off at first, then sent to it; the rest falls back', async () => {
  const code = fs.readFileSync(`${__dirname}/../mods/viewer/open.js`, 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  assert.equal(code, fs.readFileSync(`${__dirname}/../mods/chat/viewer-open.js`, 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, ''));
  let list = [{ pane: 'p1', tab: 't1' }];
  const runs = [], sent = [], tested = [];
  const { openInViewer } = vm.runInNewContext(`${code}\n;({openInViewer})`, {
    panes: () => list, run: (name, args) => runs.push([name, args]), setShared: (k, v) => sent.push([k, v]),
    execFile: async (cmd, args, opts) => { tested.push([args[1], opts.on]); return { code: args[1].includes('missing') ? 1 : 0 }; },
  });
  assert.equal(await openInViewer({ path: '/repo/a.md', line: 3, pane: 'p1' }), true);
  assert.equal(JSON.stringify(runs), JSON.stringify([['pane.split', { direction: 'right', pane: 'p1', mod: 'viewer', props: { tab: 't1', file: { path: '/repo/a.md', line: 3, on: null } } }]]));
  list = [...list, { pane: 'p2', tab: 't1', mod: 'viewer' }];
  assert.equal(await openInViewer({ path: '/srv/b.ts', on: 'vps', pane: 'p1' }), true);
  assert.equal(JSON.stringify(sent[0][1].file), JSON.stringify({ path: '/srv/b.ts', line: null, on: 'vps' }));
  assert.equal(runs.length, 1);
  for (const path of ['/repo/shot.png', '/repo/missing.md', null]) assert.equal(await openInViewer({ path, pane: 'p1' }), false);
  assert.equal(await openInViewer({ path: '/repo/a.md', pane: 'gone' }), false);
  assert.equal(JSON.stringify(tested), JSON.stringify([['/repo/a.md', null], ['/srv/b.ts', 'vps'], ['/repo/missing.md', null]]));

  const calls = [], viewed = [];
  const { openCodeLink } = load({
    exec: async (cmd, args) => { calls.push([cmd, Array.from(args)]); return { code: 0 }; }, window: () => ({ platform: 'macos' }),
    openInViewer: async (f) => { viewed.push(f.path); return !f.path.endsWith('.png'); },
  });
  await openCodeLink('src/a.ts#L2', { cwd: '/repo', machine: 'vps', pane: 'p1' });
  await openCodeLink('shot.png', { cwd: '/repo', machine: null, pane: 'p1' });
  assert.deepEqual(viewed, ['/repo/src/a.ts', '/repo/shot.png']);
  assert.deepEqual(calls, [['open', ['/repo/shot.png']]]);
});
