// Stage on: a promoted person is answered by the staged bot (as before); every other chat line (a seated guest, an
// embed viewer) goes to the LEAD only, flagged open, so one bot answers each line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomGuard, normalizePolicy } from '../../src/guard.js';

function rig(role, extra) {
  let fire; const calls = [];
  const ctx = { botName: 'Mia', emit: () => {}, transcript: { onLine: (f) => { fire = f; return () => {}; }, append: () => {} }, ourNames: () => ['Mia', 'Leo'] };
  const g = new RoomGuard(ctx, normalizePolicy(Object.assign({ link: 'https://gifos.app/meet/welcome', credentials: new URL(import.meta.url).pathname, stage: true }, extra || {}), '/'));
  g.handler = async (msg) => { calls.push(msg); };
  g.meetingId = 'm1'; g.mem.role = role;
  g.hookLines();
  const say = (speaker, text, id) => fire({ meeting_id: 'm1', speaker, speaker_id: id || '', text, kind: 'chat', ts: 1 });
  return { g, calls, say };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('the lead gets any guest or embed viewer line as open; a co-admin gets none', async () => {
  const a = rig('lead'); a.say('Zoe', 'how do I share my screen?', 's1'); a.say('Embed Eve', 'what is this?'); await tick();
  assert.deepEqual(a.calls.map((c) => [c.from, c.open]), [['Zoe', true], ['Embed Eve', true]]);
  const b = rig('coadmin'); b.say('Zoe', 'how do I share my screen?', 's1'); await tick();
  assert.equal(b.calls.length, 0);
});

test('the bot\'s own lines and a person on the Stage (answered by the promoting bot) are not open lines', async () => {
  const a = rig('lead'); a.g.mem.stageIds = ['s9'];
  a.say('Mia', 'hello', 'm'); a.say('Stan', 'a question?', 's9'); await tick();
  assert.equal(a.calls.length, 0);
});

test('a promoted person is answered by the staged bot, not flagged open', async () => {
  const a = rig('coadmin'); a.g.mem.onStage = true; a.g.mem.promoted = { id: 's1', name: 'Zoe', since: 0, spoke: false };
  a.say('Zoe', 'how do I share my screen?', 's1'); await tick();
  assert.equal(a.calls.length, 1); assert.equal(a.calls[0].open, undefined);
});

test('chat_answers false keeps the old promoted-only behaviour', async () => {
  const a = rig('lead', { chat_answers: false }); a.say('Zoe', 'how?', 's1'); await tick();
  assert.equal(a.calls.length, 0);
});
