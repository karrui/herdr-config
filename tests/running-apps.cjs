// Run: node --test tests/running-apps.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');

function load(file, names, globals = {}) {
  const code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/^import .*;$/gm, '')
    .replace(/^export /gm, '').replace('default class ', 'class ');
  return vm.runInNewContext(`${code}\n;({${names.join(',')}})`, { View: class {}, ...globals });
}
const modulePath = 'mods/status-sandbox/apps.js';
const result = stdout => ({ code: 0, stdout, stderr: '' });
const config = { TCP: { 13000: { HTTPS: true } }, Web: { 'vps.example.ts.net:13000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };

test('lsof preserves spaced paths, matches worktree boundaries, and normalizes wildcard/IPv6 listeners', () => {
  const { listeners, workspaceListeners } = load(modulePath, ['listeners', 'workspaceListeners']);
  const rows = listeners('p1\ncWeb Server\nn*:3000\nn[::1]:3000\np2\ncnode\nn127.0.0.1:4000\np3\ncredis\nn127.0.0.1:6379\n');
  const selected = workspaceListeners(rows, 'p1\nfcwd\nn/repo with spaces/apps/web\np2\nfcwd\nn/repo with spaces-other\np3\nfcwd\nn/another worktree\n', '/repo with spaces');
  assert.equal(selected.length, 2);
  assert.equal(selected[0].name, 'Web Server');
  assert.equal(selected[0].host, '127.0.0.1');
  assert.equal(selected[1].host, '[::1]');
});

test('Serve links preserve mount paths, HTTP, foreground configs and services, excluding nonlocal targets', () => {
  const { serveLinks } = load(modulePath, ['serveLinks']);
  const links = serveLinks({ ...config, Foreground: { session: {
    TCP: { 8080: { HTTP: true } }, Web: { 'vps.example.ts.net:8080': { Handlers: {
      '/web/': { Proxy: 'https+insecure://localhost:3001' }, '/other': { Proxy: 'http://elsewhere:3000' },
    } } },
  } }, Services: { 'svc:web': { Web: { 'web.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://[::1]:3002' } } } } } } });
  assert.deepEqual(Array.from(links, l => [l.port, l.url]), [
    [3000, 'https://vps.example.ts.net:13000/'], [3001, 'http://vps.example.ts.net:8080/web/'], [3002, 'https://web.example.ts.net:443/'],
  ]);
});

test('menu URLs show local addresses or exact existing and planned Serve URLs without creating routes', async () => {
  const calls = [];
  const { appURLs } = load(modulePath, ['appURLs'], {
    loginExec: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return result(JSON.stringify(args.includes('serve') ? config : { Self: { DNSName: 'vps.example.ts.net.' } }));
    },
  });
  const apps = [{ port: 3000, url: 'http://127.0.0.1:3000' }, { port: 4000, url: 'http://127.0.0.1:4000' }];
  assert.equal((await appURLs(apps, null))[0].browserUrl, apps[0].url);
  assert.equal(calls.length, 0);
  const remote = await appURLs(apps, 'vps');
  assert.equal(remote[0].browserUrl, 'https://vps.example.ts.net:13000/');
  assert.equal(remote[1].browserUrl, 'https://vps.example.ts.net:4000/');
  assert.equal(calls.length, 2);
  assert.equal(calls.every(call => call.options.on === 'vps' && call.args.includes('--json')), true);
});

test('remote app opening reuses an existing mapping and opens the browser locally', async () => {
  const calls = [];
  const { openApp } = load(modulePath, ['openApp'], {
    loginExec: async (cmd, args, options) => { calls.push({ cmd, args, options }); return result(JSON.stringify(config)); },
    exec: async (cmd, args, options) => { calls.push({ cmd, args, options }); return result(''); }, window: () => ({ platform: 'macos' }),
  });
  await openApp({ port: 3000, url: 'http://127.0.0.1:3000' }, 'vps');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.on, 'vps');
  assert.equal(calls[1].cmd, 'open');
  assert.equal(calls[1].args[0], 'https://vps.example.ts.net:13000/');
  assert.equal(calls[1].options, undefined);
});

test('new Serve routes keep the app port and use the restricted sudo fallback', async () => {
  const calls = [];
  const { serveApp } = load(modulePath, ['serveApp'], {
    loginExec: async (cmd, args, options) => {
      calls.push({ cmd, args: Array.from(args), options });
      if (args.includes('--json')) return result(JSON.stringify(args.includes('serve') ? config : { Self: { DNSName: 'vps.example.ts.net.' } }));
      return cmd === 'sudo' ? result('started') : { code: 1, stderr: 'Access denied' };
    },
  });
  const url = await serveApp({ port: 3001, url: 'http://127.0.0.1:3001' }, 'vps');
  assert.equal(url, 'https://vps.example.ts.net:3001/');
  assert.deepEqual(calls.at(-1).args, ['-n', 'tailscale', 'serve', '--bg', '--https=3001', 'http://127.0.0.1:3001']);
  assert.equal(calls.every(call => call.options.on === 'vps'), true);
});

test('a conflicting Serve port is never overwritten', async () => {
  let writes = 0;
  const { serveApp } = load(modulePath, ['serveApp'], {
    loginExec: async (_cmd, args) => {
      if (!args.includes('--json')) writes++;
      return result(JSON.stringify(args.includes('serve') ? { ...config, TCP: { 3001: { HTTPS: true } } } : { Self: { DNSName: 'vps.example.ts.net.' } }));
    },
  });
  await assert.rejects(serveApp({ port: 3001, url: 'http://127.0.0.1:3001' }, 'vps'), /already belongs/);
  assert.equal(writes, 0);
});

test('failed Serve setup never opens a localhost URL on the local machine', async () => {
  let opened = false;
  const { openApp } = load(modulePath, ['openApp'], {
    loginExec: async () => ({ code: 1, stderr: 'Permission denied' }), exec: async () => { opened = true; },
  });
  await assert.rejects(openApp({ port: 3000, url: 'http://127.0.0.1:3000' }, 'vps'), /Permission denied/);
  assert.equal(opened, false);
});

test('real detection finds two HTTP ports, deduplicates sockets and rejects a non-HTTP service', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr apps '));
  fs.mkdirSync(path.join(folder, 'web'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', `
    const http = require('http'), net = require('net');
    const servers = [http.createServer((q, r) => { r.writeHead(405); r.end(); }), http.createServer((q, r) => { r.writeHead(302, { Location: 'https://example.invalid/' }); r.end(); }), net.createServer(s => s.end('not HTTP'))];
    Promise.all(servers.map(s => new Promise(r => s.listen(0, '127.0.0.1', r)))).then(() => console.log(JSON.stringify(servers.map(s => s.address().port))));
  `], { cwd: path.join(folder, 'web'), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const [output] = await once(child.stdout, 'data');
  const ports = JSON.parse(output.toString());
  const probed = [];
  const { scanApps } = load(modulePath, ['scanApps'], {
    exec: async (cmd, args, options) => {
      if (cmd === 'curl') probed.push(args.at(-1));
      try { return result((await promisify(execFile)(cmd, Array.from(args), { cwd: options?.cwd })).stdout); }
      catch (e) { return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }; }
    },
  });
  const apps = await scanApps({ cwd: folder, machine: null });
  assert.deepEqual(Array.from(apps, app => app.port), ports.slice(0, 2).sort((a, b) => a - b));
  probed.length = 0;
  await scanApps({ cwd: folder, machine: null }, apps);
  assert.equal(probed.some(url => ports.slice(0, 2).some(port => url.endsWith(`:${port}`))), false, 'unchanged web servers must not receive repeat requests');
});

test('switching workspace ignores an older async scan result', async () => {
  let resolve;
  const { WorkspaceStatus } = load('mods/status-sandbox/main.js', ['WorkspaceStatus'], { scanApps: () => new Promise(r => { resolve = r; }) });
  const context = { cwd: '/first', machine: null };
  const view = Object.assign(new WorkspaceStatus(), { context: () => context, appKey: JSON.stringify(context), apps: [] });
  let pending;
  view.refreshApps({ spawn: fn => { pending = fn({ notify() {} }); } });
  view.appKey = JSON.stringify({ cwd: '/second', machine: 'vps' });
  resolve([{ port: 3000 }]);
  await pending;
  assert.equal(view.apps.length, 0);
});

test('footer opens one app directly and uses a native anchored popover for multiple ports', async () => {
  const elements = new Map(), context = { cwd: '/repo', machine: 'vps' };
  const element = () => {
    const state = { events: {}, items: [] };
    const node = new Proxy(state, { get(target, key) {
      if (key in target) return target[key];
      return (...args) => {
        if (key === 'when' && args[0]) args[1](node);
        if (key === 'id') elements.set(args[0], node);
        if (key === 'on_click') state.events.click = args[0];
        if (key === 'on_open_change') state.events.openChange = args[0];
        if (key === 'anchor') state.anchorCorner = args[0];
        if (key === 'child' || key === 'content') state.items.push(args[0]);
        if (key === 'children') state.items.push(...args[0]);
        return node;
      };
    } });
    return node;
  };
  let launched, pending;
  const { WorkspaceStatus } = load('mods/status-sandbox/main.js', ['WorkspaceStatus'], {
    div: element, svg: element, h_flex: element, v_flex: element, theme: () => ({}),
    Popover: { new: id => element().id(id) },
    spaces: () => [{ active: true, machine: 'vps' }], agents: () => [], chatAgents: () => [],
    appURLs: async apps => apps.map(app => ({ ...app, browserUrl: `https://vps.example.ts.net:${app.port}/` })),
  });
  const view = Object.assign(new WorkspaceStatus(), {
    context: () => context, appKey: JSON.stringify(context), apps: [{ port: 3000, name: 'Web', url: 'http://127.0.0.1:3000' }],
    launch: (...args) => { launched = args; },
  });
  view.render({});
  elements.get('running-apps').events.click({}, {});
  assert.equal(launched[0].port, 3000);
  assert.equal(launched[1], 'vps');
  assert.equal(elements.has('running-apps-popover'), false);
  view.apps.push({ port: 4000, name: 'Docs', url: 'http://127.0.0.1:4000' });
  view.render({});
  const popover = elements.get('running-apps-popover');
  assert.equal(popover.anchorCorner, 'bottom_left');
  const cx = { notify() {}, spawn: fn => { pending = fn(cx); } };
  popover.events.openChange(true, cx);
  await pending;
  assert.equal(view.appsOpen, true);
  view.render({});
  const text = node => typeof node === 'string' ? node : node.items.map(text).join('\n');
  assert.match(text(elements.get('app-3000')), /Port 3000\nhttps:\/\/vps.example.ts.net:3000\//);
  assert.match(text(elements.get('app-4000')), /Port 4000\nhttps:\/\/vps.example.ts.net:4000\//);
  elements.get('app-4000').events.click({}, {});
  assert.equal(launched[0].port, 4000);
  assert.equal(launched[1], 'vps');
  popover.events.openChange(false, cx);
  assert.equal(view.appsOpen, false);
});
