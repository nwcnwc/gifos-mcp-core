// GIFOS_BOT_MODE=auto: the core first, the browser only when the core cannot do it. A fake SDK drives a real
// CoreBotDriver (Meeting and roomOf are the real @gifos-app/agent ones; only the network is faked); a small stand-in
// plays the browser driver (WorkerPool or MeetingBotDriver), so these tests need no Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Meeting, roomOf } from '@gifos-app/agent';
import { CoreBotDriver } from '../../src/core-driver.js';
import { SwitchBotDriver } from '../../src/switch-driver.js';

// fail: the SDK's coreTransport throws this (core mode off, no signed core, the SDK missing, a join timeout...).
// roomAction(args): the 'room' call's answer. Default: no site signs it yet, so every op is the CORE_ROOM_GAP.
function fakeSdk(log, { fail, roomAction } = {}) {
  return {
    Meeting,
    roomOf,
    async coreTransport(url, cfg) {
      if (fail) throw new Error(fail);
      log.push(['transport', url, cfg.name, cfg.room, cfg.password]);
      let emit = null;
      return {
        onEvent(fn) { emit = fn; },
        async ready() {},
        async call(name, args) {
          log.push([name, args]);
          if (name === 'state') return { ok: true, state: { joined: true } };
          if (name === 'lines') return { ok: true, lines: [] };
          if (name === 'people') return { ok: true, people: [] };
          if (name === 'chat') { setImmediate(() => emit({ type: 'line', data: { kind: 'chat', name: 'Meeting notes', text: args.text, ts: 2, final: true } })); return { ok: true }; }
          if (name === 'room') return roomAction ? roomAction(args) : { ok: false, error: 'No such action: room.' };
          if (name === 'leave') return { ok: true };
          return { ok: true };
        },
        async close() { log.push(['close']); },
      };
    },
  };
}

// A minimal stand-in for WorkerPool/MeetingBotDriver: just enough surface for SwitchBotDriver to route to.
function fakeBrowser(log) {
  let seq = 0;
  const sessions = new Set();
  return {
    joined: 0,
    async join(link, password, opts) { this.joined++; const id = 'local' + (++seq); sessions.add(id); log.push(['browser.join', link, opts]); return id; },
    async leave(id) { sessions.delete(id); log.push(['browser.leave', id]); },
    async say(id, text) { log.push(['browser.say', id, text]); },
    async people() { return [{ id: 'p1', name: 'Bea', bot: false, me: false }]; },
    async room(id, op, args) { log.push(['browser.room', id, op, args]); return { ok: true, op }; },
    botNames() { return ['Meeting notes-browser']; },
    botNameFor() { return 'Meeting notes-browser'; },
    async setLook(look) { return { name: look.name || 'Meeting notes-browser', picture: false }; },
    async list() { return Array.from(sessions).map((id) => ({ id })); },
    async info() { return { state: 'ready', bot_name: 'Meeting notes-browser', stt_ready: true, bot_sessions: Array.from(sessions).map((id) => ({ session_id: id, transcribing: true, people: [] })) }; },
    async close() { log.push(['browser.close']); },
    onLost() { return () => {}; },
  };
}

function withCapturedLog(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  return Promise.resolve().then(fn).finally(() => { process.stderr.write = orig; }).then((v) => ({ v, lines }));
}

test('join: the core works -> the browser is never made', async () => {
  const log = [];
  const core = new CoreBotDriver({ home: '/x' }, { name: 'Meeting notes' }, { sdk: fakeSdk(log) });
  let made = 0;
  const sw = new SwitchBotDriver(core, () => { made++; return fakeBrowser(log); });
  const id = await sw.join('https://gifos.app/meet/abc', '');
  assert.equal(id, 'c1');
  assert.equal(made, 0, 'no browser driver was ever constructed');
  await sw.close();
});

test('join: the core throws (the SDK\'s core-off sentence) -> falls back to the browser, logging one line with no secrets', async () => {
  const log = [];
  const core = new CoreBotDriver({ home: '/x' }, { name: 'Meeting notes' }, { sdk: fakeSdk(log, { fail: 'Core mode is off in this build of the agent SDK.' }) });
  let made = 0;
  const browser = fakeBrowser(log);
  const sw = new SwitchBotDriver(core, () => { made++; return browser; });
  const { v: id, lines } = await withCapturedLog(() => sw.join('https://gifos.app/meet/abc', 's3cr3t-pw'));
  assert.equal(made, 1);
  assert.equal(id, 'b:local1');
  assert.equal(browser.joined, 1);
  const fellBack = lines.filter((l) => l.includes('core join fell back to the browser bot'));
  assert.equal(fellBack.length, 1, 'exactly one log line');
  assert.ok(!lines.some((l) => l.includes('s3cr3t-pw')), 'the password never reaches the log');
});

test('join: a guard join probes the core for room ops; "No such action: room." leaves the core seat and joins the browser', async () => {
  const log = [];
  // Default fakeSdk: the 'room' action does not exist yet, as on every real site today.
  const core = new CoreBotDriver({ home: '/x' }, { name: 'Meeting notes' }, { sdk: fakeSdk(log) });
  const browser = fakeBrowser(log);
  const sw = new SwitchBotDriver(core, () => browser);
  const id = await sw.join('https://gifos.app/meet/abc', '', { guard: true });
  assert.equal(id, 'b:local1');
  assert.equal(browser.joined, 1);
  assert.equal(core.sessions.size, 0, 'the core seat was left, not kept alongside the browser one');
  assert.ok(log.some((x) => x[0] === 'leave'), 'the core session was told to leave');
});

test('join: a guard join whose core session answers room ops stays on the core', async () => {
  const log = [];
  const core = new CoreBotDriver({ home: '/x' }, { name: 'Meeting notes' }, {
    sdk: fakeSdk(log, { roomAction: (args) => (args.op === 'host.state' ? { ok: true, v: { bot_is_host: true } } : { ok: false, error: 'Unknown room op.' }) }),
  });
  let made = 0;
  const sw = new SwitchBotDriver(core, () => { made++; return fakeBrowser(log); });
  const id = await sw.join('https://gifos.app/meet/abc', '', { guard: true });
  assert.equal(id, 'c1');
  assert.equal(made, 0, 'the probe succeeded; no browser was needed');
  assert.deepEqual(await sw.room(id, 'host.state', {}), { bot_is_host: true });
});

test('routing: people, say and room go to the session\'s own side; info lists both sides with their mode', async () => {
  const log = [];
  const core = new CoreBotDriver({ home: '/x' }, { name: 'Meeting notes' }, { sdk: fakeSdk(log) });
  const browser = fakeBrowser(log);
  const sw = new SwitchBotDriver(core, () => browser);
  const coreId = await sw.join('https://gifos.app/meet/abc', '');
  const browserId = await sw.joinBrowser('https://gifos.app/meet/def', '', {});
  assert.equal(browserId, 'b:local1');

  await sw.say(coreId, 'hi core');
  await sw.say(browserId, 'hi browser');
  assert.ok(log.some((x) => x[0] === 'chat' && x[1].text === 'hi core'), 'the core session got its own say()');
  assert.ok(log.some((x) => x[0] === 'browser.say' && x[1] === 'local1' && x[2] === 'hi browser'), 'the browser session got its own, with the public prefix stripped');

  assert.deepEqual((await sw.people(browserId)).map((p) => p.name), ['Bea']);
  await assert.rejects(sw.room(coreId, 'host.signin', {})); // the core has no room action yet: a real gap, still routed to the core
  await sw.room(browserId, 'host.signin', { password: 'x' });
  assert.ok(log.some((x) => x[0] === 'browser.room' && x[1] === 'local1' && x[2] === 'host.signin'));

  const info = await sw.info();
  assert.equal(info.mode, 'auto');
  const rows = new Map(info.bot_sessions.map((s) => [s.session_id, s.mode]));
  assert.equal(rows.get(coreId), 'core');
  assert.equal(rows.get(browserId), 'browser');
});

test('botNames, setLook, list and close combine both sides', async () => {
  const log = [];
  const core = new CoreBotDriver({ home: '/x' }, { name: 'Meeting notes' }, { sdk: fakeSdk(log) });
  const browser = fakeBrowser(log);
  const sw = new SwitchBotDriver(core, () => browser);
  await sw.join('https://gifos.app/meet/abc', '');
  await sw.joinBrowser('https://gifos.app/meet/def', '', {});
  assert.deepEqual(new Set(sw.botNames()), new Set(['Meeting notes', 'Meeting notes-browser']));
  const list = await sw.list();
  assert.deepEqual(list.map((r) => r.id).sort(), ['b:local1', 'c1']);
  await sw.close();
  assert.ok(log.some((x) => x[0] === 'close'), 'the core side closed');
  assert.ok(log.some((x) => x[0] === 'browser.close'), 'the browser side closed');
});

test('setLook renames the core without ever making a browser', async () => {
  const log = [];
  const core = new CoreBotDriver({ home: '/x' }, { name: 'Meeting notes' }, { sdk: fakeSdk(log) });
  let made = 0;
  const sw = new SwitchBotDriver(core, () => { made++; return fakeBrowser(log); });
  const out = await sw.setLook({ name: 'New name' });
  assert.equal(out.name, 'New name');
  assert.equal(made, 0, 'a rename does not need a browser; it shares cfg/creds with the core');
});
