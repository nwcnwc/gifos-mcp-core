// A site deploy moves open pages to the new version, which drops Meeting Bot's meeting session frames: every guard
// op then answers "The bot is not in that meeting any more." Seen live 2026-11-15 19:45 UTC: both welcome bots sat out
// of their room for 5.5 min (109 errors each, 3 s apart) until restarted. The guard must take its seat again by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomGuard, normalizePolicy } from '../../src/guard.js';

function fakeCtx() {
  const rows = new Map();
  let seq = 0, sessions = 0, gone = new Set();
  const ctx = {
    botName: 'Gwen', emitted: [], joins: 0,
    emit: (e) => ctx.emitted.push(e),
    meetings: { get: (id) => rows.get(id) || null },
    holdSeat: (id, f) => { rows.set(id, Object.assign({}, rows.get(id), f)); return rows.get(id); },
    joinByLink: async () => {
      ctx.joins++;
      const id = 'm1';
      const m = Object.assign({ meeting_id: id, room: 'welcome' }, rows.get(id) || {}, { state: 'live', session_id: 'mt_' + (++sessions) });
      rows.set(id, m);
      return { meeting: m };
    },
    bot: {
      room: async (sid, op) => {
        if (gone.has(sid)) throw new Error('The bot is not in that meeting any more.');
        if (op === 'guard.state') return { supported: true, seated: true, me: 'me', capture: { on: true, mine: true }, subscription: { held: true, via: 'pass' }, people: [], blur_all: null };
        return {};
      },
    },
    dropSession: (sid) => gone.add(sid),
  };
  return ctx;
}

test('a guard whose meeting session vanished (a site deploy) takes its seat again on its own', async () => {
  const ctx = fakeCtx();
  const g = new RoomGuard(ctx, normalizePolicy({ link: 'https://gifos.app/meet/welcome', mode: 'admin', host_password: 'x', greet: false }, '/'));
  await g.tick();
  assert.equal(ctx.joins, 1);
  ctx.dropSession('mt_1');
  await g.tick();   // the op says the session is gone
  await g.tick();   // the next tick joins again
  assert.equal(ctx.joins, 2, 'joined again after the session vanished');
  assert.equal(ctx.meetings.get('m1').session_id, 'mt_2');
  assert.ok(ctx.emitted.some((e) => e.type === 'guard.rejoin'), 'says why it rejoined');
  const errs = ctx.emitted.filter((e) => e.type === 'guard.error').length;
  assert.ok(errs <= 1, 'no error every tick: ' + errs);
});

test('guard.rejoin (a pass that moved away): the guard leaves the room and joins it again, keeping its retake clock', async () => {
  const ctx = fakeCtx();
  let lost = true;
  ctx.departed = 0;
  ctx.depart = async (m) => { ctx.departed++; ctx.holdSeat(m.meeting_id, { state: 'ended', session_id: null }); };
  const room = ctx.bot.room;
  ctx.bot.room = async (sid, op, args) => {
    if (op === 'guard.state' && lost) return { supported: true, seated: true, me: 'me', capture: { on: true, mine: true }, subscription: { held: false, via: null, pass: true, moved: 'moved' }, people: [], blur_all: null };
    return room(sid, op, args);
  };
  const g = new RoomGuard(ctx, normalizePolicy({ link: 'https://gifos.app/meet/welcome', credentials: new URL(import.meta.url).pathname, greet: false }, '/'));
  await g.tick();   // joins, loads the credentials (the room is held by its key)
  await g.tick();   // the pass's ticket is gone: a fresh join
  assert.equal(ctx.departed, 1, 'left the room');
  assert.ok(ctx.emitted.some((e) => e.type === 'guard.retake'));
  lost = false;
  await g.tick();   // joins again
  assert.equal(ctx.joins, 2);
  assert.equal(ctx.meetings.get('m1').session_id, 'mt_2');
  assert.ok(Number.isFinite(g.mem.lastRetake), 'the retake clock survives the new seat (no rejoin storm)');
});
