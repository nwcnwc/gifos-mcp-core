// guard_status carries what a sibling's updater needs before it restarts a bot (gifos-meet-mcp scripts/self-update.sh):
// whether this bot is seated, and when its seat last saw a sibling holding the room (another admin seat beside it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomGuard, normalizePolicy } from '../../src/guard.js';

function fakeCtx(people) {
  const rows = new Map();
  const ctx = {
    botName: 'Gwen', emit: () => {},
    meetings: { get: (id) => rows.get(id) || null },
    holdSeat: (id, f) => { rows.set(id, Object.assign({}, rows.get(id), f)); return rows.get(id); },
    joinByLink: async () => { const m = { meeting_id: 'm1', room: 'r', state: 'live', session_id: 'mt_1' }; rows.set('m1', m); return { meeting: m }; },
    bot: { room: async (sid, op) => (op === 'guard.state' ? { supported: true, seated: true, host: true, me: 'me', people: people(), blur_all: null } : {}) },
  };
  return ctx;
}
const policy = () => normalizePolicy({ link: 'https://gifos.app/meet#room=r', mode: 'admin', host_password: 'x', greet: false, blur_all: false }, '/');

test('status says seated and when a sibling holding the room was last seen', async () => {
  let people = [{ id: 'me', admin: true }, { id: 'sib', admin: true }];
  const g = new RoomGuard(fakeCtx(() => people), policy());
  assert.equal(g.status().sibling_seen_at, undefined, 'nothing before the first tick');
  await g.tick();
  const s1 = g.status();
  assert.equal(s1.seated, true);
  assert.ok(s1.sibling_seen_at && Date.now() - Date.parse(s1.sibling_seen_at) < 2000, 'sibling seen now');
  people = [{ id: 'me', admin: true }, { id: 'guest', admin: false }];
  await new Promise((r) => setTimeout(r, 20));
  await g.tick();
  const s2 = g.status();
  assert.equal(s2.sibling_seen_at, s1.sibling_seen_at, 'a guest is not a sibling: the time stays where the sibling was last seen');
});

test('a bot alone never reports a sibling', async () => {
  const g = new RoomGuard(fakeCtx(() => [{ id: 'me', admin: true }, { id: 'guest' }]), policy());
  await g.tick();
  assert.equal(g.status().seated, true);
  assert.equal(g.status().sibling_seen_at, null);
});
