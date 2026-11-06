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
    });
    assert.deepEqual(JSON.parse(JSON.stringify(location())), { cwd: '/worktree/web', on });
    assert.deepEqual(JSON.parse(JSON.stringify(location('/explicit'))), { cwd: '/explicit', on: null });
  }
});
