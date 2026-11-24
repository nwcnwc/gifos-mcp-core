// A guard with a handler hears the room's lines even when the join started no caption poll
// (GIFOS_ALWAYS_TRANSCRIBE=0): it starts the line poll itself, and only when the join did not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoomGuard, normalizePolicy } from '../../src/guard.js';

function fakeCtx(transcribing) {
  const rows = new Map();
  const started = [];
  const ctx = {
    botName: 'Gwen', emit: () => {},
    meetings: { get: (id) => rows.get(id) || null },
    holdSeat: (id, f) => { rows.set(id, Object.assign({}, rows.get(id), f)); return rows.get(id); },
    joinByLink: async () => { const m = { meeting_id: 'm1', room: 'r', state: 'live', session_id: 'mt_1', transcribing }; rows.set('m1', m); return { meeting: m }; },
    bot: { room: async (sid, op) => (op === 'guard.state' ? { supported: true, seated: true, host: true, me: 'me', people: [{ id: 'me', admin: true }], blur_all: null } : {}) },
    captions: { start: (m) => { started.push(m.meeting_id); } },
  };
  return { ctx, started };
}
const handlerFile = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-ears-'));
  const f = path.join(d, 'h.mjs');
  fs.writeFileSync(f, 'export async function onMessage() {}\n');
  return f;
};
const policy = (handler) => normalizePolicy({ link: 'https://gifos.app/meet#room=r', mode: 'admin', host_password: 'x', greet: false, blur_all: false, handler }, '/');

test('a handler guard starts the line poll when the join did not (transcribe off)', async () => {
  const { ctx, started } = fakeCtx(false);
  const g = new RoomGuard(ctx, policy(handlerFile()));
  await g.start(); g.stop();
  assert.deepEqual(started, ['m1']);
});

test('no second poll when the join already transcribes, and none without a handler', async () => {
  const a = fakeCtx(true);
  const g1 = new RoomGuard(a.ctx, policy(handlerFile()));
  await g1.start(); g1.stop();
  assert.deepEqual(a.started, []);
  const b = fakeCtx(false);
  const g2 = new RoomGuard(b.ctx, policy(undefined));
  await g2.start(); g2.stop();
  assert.deepEqual(b.started, []);
});
