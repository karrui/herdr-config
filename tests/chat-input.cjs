// Run: node --test tests/chat-input.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function load(file, result, globals) {
  const source = readFileSync(`${__dirname}/../${file}`, 'utf8')
    .replace(/^import .*;$/gm, '').replace(/export default class /g, 'class ').replace(/^export /gm, '');
  return vm.runInNewContext(`${source}\n;(${result})`, { View: class {}, ...globals });
}

for (const kind of ['codex', 'claude']) {
  for (const address of ['t1', 'vps-karrui/t1']) {
    test(`${kind} chat delivers human text unchanged to ${address}`, async () => {
      const messages = [], calls = [], jobs = [];
      let view;
      const ok = () => { view.pending = []; return { code: 0, stdout: '{}', stderr: '' }; };
      const globals = {
        hc: async args => {
          calls.push(['hc', ...args]);
          messages.push(args[1].includes('/') ? `<hc from="laptop/ppid:123">${args[2]}</hc>` : args[2]);
          return ok();
        },
        exec: async (command, args, options) => {
          calls.push([command, ...args, options.on]);
          messages.push(args[2]);
          return ok();
        },
      };
      const sendInput = load('mods/chat/transport.js', 'typeof sendInput === "function" ? sendInput : undefined', globals);
      const Chat = load('mods/chat/main.js', 'Chat', {
        ...globals, sendInput, openCard: () => null, slash: { opensMenu: () => null }, attach: { deliver: async () => [] },
      });
      view = Object.assign(Object.create(Chat.prototype), {
        kind, addr: address, originKey: address, asks: [], replied: [],
        deliverTo: () => ({}), typed: fn => fn(), steerNow: async () => {},
      });
      const cx = { notify() {}, spawn: fn => jobs.push(fn(cx)), sleep: async () => {} };
      const text = 'A human message\nwith Unicode: 你好';
      view.deliver({ id: 'input', text, files: [], notes: [] }, cx);
      await Promise.all(jobs);
      assert.deepEqual(messages, [text]);
      assert.equal(calls.length, 1, 'never send through both routes');
      if (address.includes('/')) assert.deepEqual(calls[0], ['hc', 'send', 't1', text, 'vps-karrui']);
    });
  }
}

test('remote human input preserves blocked refusals and transport failures', async () => {
  const refusal = { code: 1, stdout: '', stderr: '{"error":{"kind":"blocked","message":"Needs an answer"}}' };
  const sendInput = load('mods/chat/transport.js', 'sendInput', {
    hc: () => assert.fail('must not retry through forwarding'), exec: async () => refusal,
  });
  assert.equal(await sendInput('remote/t1', 'hello'), refusal);
  const error = new Error('offline');
  const offline = load('mods/chat/transport.js', 'sendInput', {
    hc: () => assert.fail('must not retry an uncertain send'), exec: async () => { throw error; },
  });
  await assert.rejects(offline('remote/t1', 'hello'), error);
});

test('queued human reactions use the same input route', () => {
  const messages = [];
  const Chat = load('mods/chat/main.js', 'Chat', {
    sendInput: (address, text) => messages.push([address, text]),
    hc: () => assert.fail('a reaction must not acquire an agent sender'), openCard: () => null,
  });
  const reaction = { raw: true, text: '<hc from="person" reaction="👍" to="reply"/>' };
  const view = Object.assign(Object.create(Chat.prototype), {
    addr: 'remote/t1', queue: [reaction], phase: 'ready', asks: [], pending: [], status: () => 'idle', saveSoon() {},
  });
  view.drainQueue({ notify() {} });
  assert.deepEqual(messages, [['remote/t1', reaction.text]]);
});
