// The no-browser Meeting Bot over a fake agent SDK: the tools' bot surface, carried by the gifosAgent contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreBotDriver, CORE_ROOM_GAP } from '../../src/core-driver.js';

function fakeSdk(log) {
  class Meeting {
    constructor(t) { this.t = t; this.h = new Map(); t.onEvent((ev) => { for (const f of this.h.get(ev.type) || []) f(ev.data); }); }
    on(type, fn) { if (!this.h.has(type)) this.h.set(type, new Set()); this.h.get(type).add(fn); return () => this.h.get(type).delete(fn); }
    async call(name, args) { const r = await this.t.call(name, args || {}); if (!r || r.ok === false) throw new Error((r && r.error) || 'no answer'); return r; }
    async state() { return (await this.call('state')).state; }
    chat(text) { return this.call('chat', { text }); }
    hand(up) { return this.call('hand', { up }); }
    async leave() { await this.call('leave'); await this.t.close(); }
    close() { return this.t.close(); }
  }
  return {
    Meeting,
    roomOf: (link) => new URL(link).pathname.split('/').pop(),
    async coreTransport(url, cfg) {
      log.push(['transport', url, cfg.name, cfg.room, cfg.password]);
      let emit = null;
      return {
        onEvent(fn) { emit = fn; },
        async ready() {},
        async call(name, args) {
          log.push([name, args]);
          if (name === 'state') return { ok: true, state: { joined: true } };
          if (name === 'lines') return { ok: true, lines: [{ kind: 'chat', name: 'Ann', text: 'earlier', ts: 1 }] };
          if (name === 'people') return { ok: true, people: [{ id: 'k1', name: 'Ann', bot: false, me: false }, { id: 'k2', name: 'Meeting notes', bot: true, me: true }] };
          if (name === 'chat') { setImmediate(() => emit({ type: 'line', data: { kind: 'chat', name: 'Meeting notes', text: args.text, ts: 2, final: true } })); return { ok: true }; }
          if (name === 'leave') return { ok: true };
          return { ok: true };
        },
        async close() { log.push(['close']); },
        speak(l) { emit({ type: 'line', data: l }); },
      };
    },
  };
}

test('core bot: join, people, chat, captions, leave, gaps', async () => {
  const log = [];
  const bot = new CoreBotDriver({ home: '/nonexistent-home', relay: 'ws://relay.test' }, { name: 'Meeting notes' }, { sdk: fakeSdk(log) });
  const id = await bot.join('https://gifos.app/meet/abc', 'pw1');
  assert.equal(log[0][1], 'https://gifos.app/meet/abc?agent=1');
  assert.deepEqual(log[0].slice(2), ['Meeting notes', 'abc', 'pw1']);
  assert.deepEqual((await bot.people(id)).map((p) => p.name), ['Ann', 'Meeting notes']);
  await bot.say(id, 'hello');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual((await bot.chat(id)).map((l) => l.text), ['earlier', 'hello']);
  await assert.rejects(bot.room(id, 'host.signin', {}), (e) => e.message === CORE_ROOM_GAP);
  assert.equal(typeof bot.interject, 'undefined', 'no voice: the tools report the gap');
  assert.equal((await bot.info()).mode, 'core');
  await bot.leave(id);
  await assert.rejects(bot.say(id, 'x'), /not in that meeting any more/);
  assert.ok(log.some((x) => x[0] === 'close'));
});
