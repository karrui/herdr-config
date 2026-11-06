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
