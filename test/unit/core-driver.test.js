// The no-browser Meeting Bot over a fake agent SDK: the tools' bot surface, carried by the gifosAgent contract.
// Meeting itself and roomOf come from the real @gifos-app/agent package; only its transport (the network) is faked,
// so say()'s wait for say.done and call()'s { ok, error } handling are the SDK's own, not a stand-in's guess at them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Meeting, roomOf } from '@gifos-app/agent';
import { CoreBotDriver, CORE_ROOM_GAP, CORE_VOICE_GAP } from '../../src/core-driver.js';

// roomAction(args) -> the 'room' call's answer ({ ok, v } or { ok:false, error }). Default: no site signs the
// action yet (the real answer today), so every room() op is a CORE_ROOM_GAP until roomAction says otherwise.
function fakeSdk(log, { roomAction } = {}) {
  return {
    Meeting,
    roomOf,
    async coreTransport(url, cfg) {
      log.push(['transport', url, cfg.name, cfg.room, cfg.password]);
      let emit = null;
      let sayId = 0;
      return {
        onEvent(fn) { emit = fn; },
        async ready() {},
        async call(name, args) {
          log.push([name, args]);
          if (name === 'state') return { ok: true, state: { joined: true } };
          if (name === 'lines') return { ok: true, lines: [{ kind: 'chat', name: 'Ann', text: 'earlier', ts: 1 }] };
          if (name === 'people') return { ok: true, people: [{ id: 'k1', name: 'Ann', bot: false, me: false }, { id: 'k2', name: 'Meeting notes', bot: true, me: true }] };
          if (name === 'chat') { setImmediate(() => emit({ type: 'line', data: { kind: 'chat', name: 'Meeting notes', text: args.text, ts: 2, final: true } })); return { ok: true }; }
          if (name === 'say') { const id = ++sayId; setImmediate(() => emit({ type: 'say.done', data: { id } })); return { ok: true, id }; }
          if (name === 'room') return roomAction ? roomAction(args) : { ok: false, error: 'No such action: room.' };
          if (name === 'leave') return { ok: true };
          return { ok: true };
        },
        async close() { log.push(['close']); },
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
  await assert.rejects(bot.room(id, 'not.a.real.op', {}), /Unknown room op\./);
  assert.equal((await bot.info()).mode, 'core');
  assert.deepEqual(await bot.meetingState(id), { applied: true, result: { hand: false, mic: false, camera: false } });
  await bot.leave(id);
  await assert.rejects(bot.say(id, 'x'), /not in that meeting any more/);
  assert.ok(log.some((x) => x[0] === 'close'));
});

test('core bot: room() maps the "No such action: room." gap and passes a real answer\'s v through', async () => {
  const log = [];
  // A future page that signs the 'room' action: the same { ok, v } shape roomPageOp returns.
  const bot = new CoreBotDriver({ home: '/x' }, { name: 'Meeting notes' }, {
    sdk: fakeSdk(log, { roomAction: (args) => (args.op === 'host.state' ? { ok: true, v: { bot_is_host: true } } : { ok: false, error: 'Unknown room op.' }) }),
  });
  const id = await bot.join('https://gifos.app/meet/abc', '');
  assert.deepEqual(await bot.room(id, 'host.state', {}), { bot_is_host: true });
  // An op this page's room action does not know either: its own error passes through unchanged (not forced to the gap).
  await assert.rejects(bot.room(id, 'stage.get', {}), /Unknown room op\./);
});

test('core bot: interject has no voice engine -> the gap shape (the words already went to chat elsewhere)', async () => {
  const log = [];
  const bot = new CoreBotDriver({ home: '/x' }, { name: 'Meeting notes' }, { sdk: fakeSdk(log) });
  const id = await bot.join('https://gifos.app/meet/abc', '');
  const said = await bot.interject(id, 'hi there');
  assert.deepEqual(said, { applied: false, gap: CORE_VOICE_GAP });
  assert.ok(!log.some((x) => x[0] === 'say'), 'no say() attempted with no voice engine');
});

test('core bot: interject speaks through say() once a voice engine (Kokoro) is in this process', async () => {
  const log = [];
  const spoke = [];
  const kokoro = { speak: async (text, voice) => { spoke.push([text, voice]); return Buffer.from('wav-bytes'); } };
  const bot = new CoreBotDriver({ home: '/x' }, { name: 'Meeting notes' }, { sdk: fakeSdk(log), kokoro });
  const id = await bot.join('https://gifos.app/meet/abc', '');
  const said = await bot.interject(id, 'hi there', { voice: 'bm_george' });
  assert.equal(said.applied, true);
  assert.deepEqual(spoke, [['hi there', 'bm_george']]);
  const sayCall = log.find((x) => x[0] === 'say');
  assert.ok(sayCall, 'a say() call reached the transport');
  assert.equal(sayCall[1].text, 'hi there');
  assert.equal(Buffer.from(sayCall[1].wav, 'base64').toString(), 'wav-bytes');

  // kokoroPromise (not just opts.kokoro, the same background-load slot createRuntime hands MeetingBotDriver): a
  // Kokoro that failed to load is the gap; one that loaded is used.
  const bot2 = new CoreBotDriver({ home: '/x' }, { name: 'Meeting notes' }, { sdk: fakeSdk(log), kokoroPromise: Promise.reject(new Error('no weights')) });
  const id2 = await bot2.join('https://gifos.app/meet/abc', '');
  assert.deepEqual(await bot2.interject(id2, 'nope'), { applied: false, gap: CORE_VOICE_GAP });

  const bot3 = new CoreBotDriver({ home: '/x' }, { name: 'Meeting notes' }, { sdk: fakeSdk(log), kokoroPromise: Promise.resolve(kokoro) });
  const id3 = await bot3.join('https://gifos.app/meet/abc', '');
  const said2 = await bot3.interject(id3, 'now it works');
  assert.equal(said2.applied, true);
});
