// Stage holding, the staged bot's greeting, and the hand queue (src/stagehost.js).
// stage:false keeps the guard's old decisions; those cases are at the bottom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, normalizePolicy, newMemory, greetingText, defaultGreeting, RoomGuard } from '../../src/guard.js';
import { roomPageOp } from '../../src/room.js';
import { STAGE_GREETING, firstName, noteLine, planStage, queueHands, shouldAnswer, stageView, thanksLine } from '../../src/stagehost.js';

const pol = (o) => normalizePolicy(Object.assign({ link: 'https://gifos.app/meet/welcome', credentials: '/x/sub.gif', blur_all: false }, o || {}), '/');
const held = (people, extra) => ({
  supported: true, seated: true, me: 'me', host: false, admin_room: true,
  capture: { on: true, mine: true }, subscription: { held: true }, password_set: false, password_ok: true,
  blur_all: null, people, ...extra,
});
const view = (o) => Object.assign({ ok: true, me: 'me', me_on: false, am_admin: true, seats: 5, on_stage: [], people: [] }, o || {});
const bot = (id, name) => ({ id, name, bot: true });
const human = (id, name) => ({ id, name, bot: false });
const person = (id, name, hand, extra) => Object.assign({ id, name, admin: false, bot: false, hand: hand === undefined ? null : hand }, extra || {});

test('policy: stage defaults, and stage off keeps the old greeting', () => {
  const off = pol();
  assert.equal(off.stage, false);
  assert.equal(off.greet, defaultGreeting(false));
  assert.equal(off.stage_idle_s, 45);
  assert.equal(off.stage_max_s, 240);
  assert.equal(off.stage_takeover_s, 6);
  assert.equal(pol({ rank: 1 }).stage_takeover_s, 12);
  assert.equal(pol({ rank: 2 }).stage_takeover_s, 18);
  assert.equal(pol({ stage_takeover_s: 3 }).stage_takeover_s, 3);
  const on = pol({ stage: true, blur_all: true, rank: 1 });
  assert.equal(on.stage, true);
  assert.equal(on.greet, STAGE_GREETING);
  assert.equal(on.greet.includes('Clear video'), false, 'the stage line does not add the blur note');
  assert.equal(on.stage_takeover_s, 12);
  assert.equal(pol({ stage: true, greet: 'Hello {names}.' }).greet, 'Hello {names}.');
  assert.equal(pol({ stage: true, greet: false }).greet, false);
  assert.equal(pol({ name: 'Mia' }).name, 'Mia');
});

test('takes an empty stage after stage_takeover_s, and not before', () => {
  const p = pol({ stage: true }), m = newMemory();
  let d = planStage(view(), m, 1000, p);
  assert.deepEqual(d.actions, []);
  assert.equal(d.note, 'waiting to take the stage');
  d = planStage(view(), m, 6999, p);
  assert.deepEqual(d.actions, []);
  d = planStage(view(), m, 7000, p);
  assert.deepEqual(d.actions, [{ op: 'stage.set', on: true }]);
  assert.equal(d.note, 'taking a free stage spot');
});

test('a human already up: the bot takes the free spot beside them and never moves them', () => {
  const p = pol({ stage: true }), m = newMemory();
  const v = view({ on_stage: [human('sam', 'Sam')] });
  assert.deepEqual(planStage(v, m, 1000, p).actions, []);
  const d = planStage(v, m, 7000, p);
  assert.deepEqual(d.actions, [{ op: 'stage.set', on: true }]);
  assert.equal(d.actions.some((a) => a.on === false), false);
  // The bot is up beside Sam and stays. It does not step down.
  const stay = planStage(view({ me_on: true, on_stage: [human('sam', 'Sam'), bot('me', 'Mia')] }), m, 8000, p);
  assert.deepEqual(stay.actions, []);
  assert.equal(stay.note, 'on stage');
});

test('a full stage of humans is logged once per stretch, then a free spot is taken', () => {
  const p = pol({ stage: true }), m = newMemory();
  const full = view({ seats: 2, on_stage: [human('a', 'Ann'), human('b', 'Ben')] });
  let d = planStage(full, m, 1000, p);
  assert.deepEqual(d.actions, []);
  assert.equal(d.log, 'stage full of humans');
  d = planStage(full, m, 4000, p);
  assert.equal(d.log, null, 'one line for this stretch');
  assert.deepEqual(d.actions, []);
  const gap = view({ seats: 2, on_stage: [human('a', 'Ann')] });
  d = planStage(gap, m, 5000, p);
  assert.equal(d.log, null);
  assert.deepEqual(d.actions, []);
  assert.equal(d.note, 'waiting to take the stage');
  d = planStage(gap, m, 11000, p);
  assert.deepEqual(d.actions, [{ op: 'stage.set', on: true }]);
  // A later stretch, the humans fill it again: say so again.
  d = planStage(full, m, 12000, p);
  assert.equal(d.log, 'stage full of humans');
});

test('the wait is continuous, and the lower rank takes the spot first', () => {
  const m = newMemory();
  const p0 = pol({ stage: true, rank: 0 });
  planStage(view(), m, 0, p0);
  planStage(view({ on_stage: [bot('sib', 'Leo')], me_on: false }), m, 3000, p0);   // a bot appeared: the wait restarts
  const again = planStage(view(), m, 4000, p0);
  assert.deepEqual(again.actions, []);
  assert.deepEqual(planStage(view(), m, 9999, p0).actions, []);
  assert.deepEqual(planStage(view(), m, 10000, p0).actions, [{ op: 'stage.set', on: true }]);
  const lead = newMemory(), sib = newMemory();
  const empty = view();
  planStage(empty, lead, 0, pol({ stage: true, rank: 0 }));
  planStage(empty, sib, 0, pol({ stage: true, rank: 1 }));
  assert.deepEqual(planStage(empty, lead, 6000, pol({ stage: true, rank: 0 })).actions, [{ op: 'stage.set', on: true }]);
  assert.deepEqual(planStage(empty, sib, 6000, pol({ stage: true, rank: 1 })).actions, [], 'rank 1 waits 12 s');
  assert.deepEqual(planStage(empty, sib, 12000, pol({ stage: true, rank: 1 })).actions, [{ op: 'stage.set', on: true }]);
});

test('a sibling takes the stage when the staged bot is gone', () => {
  const p = pol({ stage: true, rank: 1 }), m = newMemory();
  const up = view({ on_stage: [bot('mia', 'Mia')] });
  assert.deepEqual(planStage(up, m, 1000, p).actions, []);
  assert.equal(planStage(up, m, 1000, p).note, 'a bot holds the stage');
  const gone = view({ on_stage: [human('sam', 'Sam')] });
  assert.deepEqual(planStage(gone, m, 2000, p).actions, []);
  assert.deepEqual(planStage(gone, m, 14000, p).actions, [{ op: 'stage.set', on: true }]);
});

test('stage.get: a human beside us is not a bot; an admin sibling is, even with a cut id', () => {
  const v = stageView(
    { me: 'me', host: true, people: [person('sam', 'Sam', null), person('sibling-id-long', 'Leo', null, { admin: true })] },
    { seats: 5, bot_on_stage: false, on_stage: [{ id: 'sam', name: 'Sam', bot: false }, { id: 'sibling-id-l', name: 'Leo', bot: false }] },
  );
  assert.equal(v.ok, true);
  assert.equal(v.on_stage[0].bot, false);
  assert.equal(v.on_stage[1].bot, true, 'the page cuts the id to 12; the admin flag still matches');
  assert.equal(v.me_on, false);
  const mine = stageView({ me: 'me', host: true, people: [] }, { seats: 5, bot_on_stage: true, on_stage: [{ id: 'me', name: 'Mia', bot: true }] });
  assert.equal(mine.me_on, true);
  assert.equal(mine.on_stage[0].bot, true);
});

test('the greeting is only from the staged bot, by first name, and names the sound mix', () => {
  const line = greetingText(STAGE_GREETING, ['Sam Smith', 'Ana Lopez'].map(firstName), 'Mia');
  assert.equal(line.startsWith('Hi Sam and Ana, welcome to GifOS!'), true, line);
  assert.match(line, /I'm Mia, a bot/);
  assert.match(line, /My row/);
  assert.match(line, /The stadium/);
  assert.match(line, /Sound mix/);
  assert.equal(line.includes('Row volume'), false);
  assert.equal(firstName('Sam Smith'), 'Sam');
  const p = pol({ stage: true });
  const m = Object.assign(newMemory(), { credLoaded: true });
  const at = (people, me_on) => held(people, { stage: { me_on } });
  plan(at([{ id: 'x', name: 'Old Person' }], true), p, m, 1000);
  plan(at([{ id: 'x', name: 'Old Person' }, { id: 's', name: 'Sam Smith' }], true), p, m, 2000);
  let r = plan(at([{ id: 'x', name: 'Old Person' }, { id: 's', name: 'Sam Smith' }], true), p, m, 12000);
  assert.deepEqual(r.greet, ['Sam Smith']);
  assert.match(greetingText(p.greet, r.greet.map(firstName), 'Mia'), /^Hi Sam, welcome to GifOS! I'm Mia, a bot/);
  // Off the stage: no greeting, including a lead who is not up.
  const off = Object.assign(newMemory(), { credLoaded: true });
  plan(at([{ id: 'x', name: 'Old' }], false), p, off, 1000);
  plan(at([{ id: 'x', name: 'Old' }, { id: 'a', name: 'Ana' }], false), p, off, 2000);
  assert.equal(plan(at([{ id: 'x', name: 'Old' }, { id: 'a', name: 'Ana' }], false), p, off, 30000).greet, null);
  // A co-admin who is the one on the stage does greet.
  const co = Object.assign(newMemory(), { credLoaded: true });
  const sib = [{ id: 'mia', name: 'Mia', admin: true }];
  const pass = (people, me_on) => held(people, { subscription: { held: true, via: 'pass' }, stage: { me_on } });
  plan(pass(sib, true), pol({ stage: true, rank: 1 }), co, 1000);
  plan(pass(sib.concat([{ id: 'a', name: 'Ana' }]), true), pol({ stage: true, rank: 1 }), co, 2000);
  r = plan(pass(sib.concat([{ id: 'a', name: 'Ana' }]), true), pol({ stage: true, rank: 1 }), co, 12000);
  assert.equal(r.role, 'coadmin');
  assert.deepEqual(r.greet, ['Ana']);
});

test('hands are first-raised first-served, one at a time, and not when the stage is full', () => {
  const people = [person('b', 'Bob', 20), person('c', 'Cy', 10), person('a', 'Ana', 10), person('me', 'Mia', 1, { bot: true }), person('leo', 'Leo', 2, { admin: true })];
  assert.deepEqual(queueHands(people, { me: 'me', on: [] }).map((q) => q.id), ['a', 'c', 'b']);
  const p = pol({ stage: true }), m = newMemory();
  const up = view({
    me_on: true,
    on_stage: [bot('me', 'Mia')],
    people: [person('a', 'Ana', 10), person('b', 'Bob', 20)],
  });
  let d = planStage(up, m, 1000, p);
  assert.deepEqual(d.actions, [{ op: 'stage.grant', person_id: 'a', on: true }]);
  assert.equal(m.promoted.id, 'a');
  d = planStage(up, m, 2000, p);
  assert.deepEqual(d.actions, [], 'Bob waits until Ana is done');
  const full = view({ me_on: true, seats: 2, on_stage: [bot('me', 'Mia'), human('x', 'Xi')], people: [person('a', 'Ana', 10)] });
  assert.deepEqual(planStage(full, newMemory(), 1000, p).actions, []);
});

test('done: thanks, lowered hand, idle, max, left; then the next hand', () => {
  const p = pol({ stage: true });
  const base = () => view({ me_on: true, on_stage: [bot('me', 'Mia'), human('a', 'Ana')], people: [person('a', 'Ana', null), person('b', 'Bob', 50)] });
  // Thanks, before she is up, hand stamp unchanged: she is not called straight back; Bob is.
  let m = newMemory();
  m.promoted = { id: 'a', name: 'Ana Lopez', since: 0, lastSpoke: 0, arrived: false, saidDone: false };
  m.onStage = true;
  const up = view({ me_on: true, on_stage: [bot('me', 'Mia')], people: [person('a', 'Ana Lopez', 5), person('b', 'Bob', 50)] });
  assert.equal(noteLine(m, { from: 'Sam', text: 'thanks', at: 1000 }, p).answer, false);
  assert.equal(m.promoted.saidDone, false);
  assert.equal(noteLine(m, { from: 'Ana Lopez', text: 'ok, thanks!', at: 1000 }, p).answer, false);
  assert.equal(m.promoted.saidDone, true);
  let d = planStage(up, m, 1000, p);
  assert.equal(d.note, 'thanks');
  assert.equal(d.thanks, thanksLine('Ana Lopez'));
  assert.match(d.thanks, /^Thanks, Ana!/);
  assert.deepEqual(d.actions[0], { op: 'stage.grant', person_id: 'a', on: false });
  assert.deepEqual(d.actions[1], { op: 'stage.grant', person_id: 'b', on: true });
  assert.equal(m.promoted.id, 'b');
  // Still on the stage when they finish: thank them and wait until the spot is free.
  m = newMemory();
  m.promoted = { id: 'a', name: 'Ana', since: 0, lastSpoke: 0, arrived: true, saidDone: true };
  d = planStage(base(), m, 1000, p);
  assert.deepEqual(d.actions, [{ op: 'stage.grant', person_id: 'a', on: false }]);
  assert.equal(m.promoted, null);
  d = planStage(view({ me_on: true, on_stage: [bot('me', 'Mia')], people: [person('b', 'Bob', 50)] }), m, 2000, p);
  assert.deepEqual(d.actions, [{ op: 'stage.grant', person_id: 'b', on: true }]);
  // Hand down before they arrive: dropped, and it is not the idle clock.
  m = newMemory();
  m.promoted = { id: 'a', name: 'Ana', since: 1000, lastSpoke: 1000, arrived: false, saidDone: false };
  d = planStage(view({ me_on: true, on_stage: [bot('me', 'Mia')], people: [person('a', 'Ana', null)] }), m, 5000, p);
  assert.equal(d.note, 'hand');
  assert.equal(d.actions[0].on, false);
  // Still walking up, hand up, under 20 s: not done.
  m = newMemory();
  m.promoted = { id: 'a', name: 'Ana', since: 1000, lastSpoke: 1000, arrived: false, saidDone: false };
  d = planStage(view({ me_on: true, on_stage: [bot('me', 'Mia')], people: [person('a', 'Ana', 3)] }), m, 1000 + 19999, p);
  assert.equal(d.thanks, null);
  assert.equal(m.promoted.id, 'a');
  d = planStage(view({ me_on: true, on_stage: [bot('me', 'Mia')], people: [person('a', 'Ana', 3)] }), m, 1000 + 20000, p);
  assert.equal(d.note, 'absent');
  // Idle and max, once they are up. A lowered hand on the stage is the step-up, not goodbye.
  m = newMemory();
  m.promoted = { id: 'a', name: 'Ana', since: 0, lastSpoke: 0, arrived: true, saidDone: false };
  d = planStage(base(), m, 44999, p);
  assert.equal(d.thanks, null);
  d = planStage(base(), m, 45000, p);
  assert.equal(d.note, 'idle');
  m = newMemory();
  m.promoted = { id: 'a', name: 'Ana', since: 0, lastSpoke: 200000, arrived: true, saidDone: false };
  d = planStage(base(), m, 239999, p);
  assert.equal(d.thanks, null, 'hand down on stage is not done');
  d = planStage(base(), m, 240000, p);
  assert.equal(d.note, 'max');
  // Left the room.
  m = newMemory();
  m.promoted = { id: 'a', name: 'Ana', since: 0, lastSpoke: 0, arrived: true, saidDone: false };
  d = planStage(view({ me_on: true, on_stage: [bot('me', 'Mia')], people: [person('b', 'Bob', null)] }), m, 1000, p);
  assert.equal(d.note, 'left');
  assert.equal(d.actions[0].person_id, 'a');
  assert.equal(d.actions[0].on, false);
});

test('chat from anyone but the promoted person is not answered; a done line is not either', () => {
  const p = pol({ stage: true });
  const m = newMemory();
  m.onStage = true;
  m.promoted = { id: 'a', name: 'Ana', since: 0, lastSpoke: 0, arrived: true, saidDone: false };
  assert.equal(shouldAnswer(m, { from: 'Sam', text: 'What is GifOS?' }), false);
  assert.equal(noteLine(m, { from: 'Sam', text: 'What is GifOS?', at: 5 }, p).answer, false);
  assert.equal(m.promoted.lastSpoke, 0, 'Sam does not refresh the idle clock');
  assert.equal(noteLine(m, { from: 'Ana', text: 'What is GifOS?', at: 5 }, p).answer, true);
  assert.equal(m.promoted.lastSpoke, 5);
  assert.equal(shouldAnswer({ onStage: false, promoted: m.promoted }, { from: 'Ana', text: 'hi' }), false);
  assert.equal(shouldAnswer({ onStage: true, promoted: null }, { from: 'Ana', text: 'hi' }), false);
  assert.equal(noteLine(m, { from: 'Ana', text: "that's all", at: 9 }, p).answer, false);
  assert.equal(m.promoted.saidDone, true);
});

test('done words match the phrase, not a longer word', () => {
  const m = () => ({ onStage: true, promoted: { id: 'a', name: 'Ana', since: 0, lastSpoke: 0, arrived: true, saidDone: false } });
  const p = pol({ stage: true });
  for (const w of ['thanks', 'thank you', 'bye', 'goodbye', "that's all", 'thats all']) {
    const mem = m();
    assert.equal(noteLine(mem, { from: 'Ana', text: 'Ok ' + w + '!', at: 1 }, p).answer, false, w);
    assert.equal(mem.promoted.saidDone, true, w);
  }
  const stay = m();
  assert.equal(noteLine(stay, { from: 'Ana', text: 'a thankless remark', at: 1 }, p).answer, true);
  assert.equal(stay.promoted.saidDone, false);
});

test('stage off: the lead still greets, planStage does nothing, and the handler hears everyone', async () => {
  const p = pol();
  assert.equal(p.stage, false);
  const m = Object.assign(newMemory(), { credLoaded: true });
  plan(held([{ id: 'x', name: 'Old' }]), p, m, 1000);
  plan(held([{ id: 'x', name: 'Old' }, { id: 'a', name: 'Ada Lovelace' }]), p, m, 2000);
  const r = plan(held([{ id: 'x', name: 'Old' }, { id: 'a', name: 'Ada Lovelace' }]), p, m, 12000);
  assert.equal(r.role, 'lead');
  assert.deepEqual(r.greet, ['Ada Lovelace']);
  assert.equal(greetingText(p.greet, r.greet), greetingText(defaultGreeting(false), ['Ada Lovelace']));
  const mem = newMemory();
  mem.onStage = true;
  assert.deepEqual(planStage(view({ me_on: false }), mem, 99999, p).actions, []);
  assert.equal(mem.onStage, true, 'stage off does not touch stage memory');
  const seen = await hear({}, { role: 'lead' }, [
    { speaker: 'Sam', text: 'hi' },
    { speaker: 'Ana', text: 'hello' },
  ]);
  assert.deepEqual(seen, ['Sam', 'Ana']);
});

test('the handler wrapper answers only the promoted person when stage is on', async () => {
  const seen = await hear({ stage: true }, {
    onStage: true,
    promoted: { id: 'a', name: 'Ana', since: 0, lastSpoke: 0, arrived: true, saidDone: false },
  }, [
    { speaker: 'Sam', text: 'What is GifOS?' },
    { speaker: 'Ana', text: 'What is GifOS?' },
    { speaker: 'Ana', text: 'thanks' },
  ]);
  assert.deepEqual(seen, ['Ana']);
});

test('a tick with stage on takes a free spot beside a human; stage off never reads the stage', async () => {
  const ops = [];
  const ctx = tickCtx((op, args) => {
    ops.push({ op, args });
    if (op === 'guard.state') return {
      supported: true, seated: true, host: true, me: 'me', people: [person('sam', 'Sam', null)], blur_all: null,
    };
    if (op === 'stage.get') return { seats: 5, bot_on_stage: false, on_stage: [{ id: 'sam', name: 'Sam', bot: false }] };
    return {};
  });
  const g = new RoomGuard(ctx, pol({ stage: true, mode: 'admin', host_password: 'x', greet: false, stage_takeover_s: 0, credentials: '' }));
  await g.tick();
  assert.ok(ops.some((o) => o.op === 'stage.get'));
  const set = ops.find((o) => o.op === 'stage.set');
  assert.deepEqual(set && set.args, { on: true });
  assert.equal(ops.some((o) => o.op === 'stage.grant'), false, 'Sam stays; nobody is granted off');
  const quiet = [];
  const g2 = new RoomGuard(tickCtx((op) => {
    quiet.push(op);
    if (op === 'stage.get') throw new Error('stage off must not read the stage');
    return { supported: true, seated: true, host: true, me: 'me', people: [], blur_all: null };
  }), pol({ mode: 'admin', host_password: 'x', greet: false, credentials: '' }));
  await g2.tick();
  assert.equal(quiet.includes('stage.get'), false);
});

test('guard.state copies handQueue when the page has it, and omits hand when it does not', async () => {
  const withHands = frame();
  withHands.w.__gifosVideo.handQueue = () => [{ id: 'p1', name: 'Ada', t: 1234 }];
  let r = await run(withHands, 'guard.state', { want: '' });
  assert.equal(r.v.people.find((p) => p.id === 'p1').hand, 1234);
  assert.equal(r.v.people.find((p) => p.id === 'p2').hand, null);
  const bare = frame();
  r = await run(bare, 'guard.state', { want: '' });
  assert.equal('hand' in r.v.people[0], false);
});

function tickCtx(room) {
  const rows = new Map();
  return {
    botName: 'Mia', emit: () => {}, holdSecret: () => {},
    meetings: { get: (id) => rows.get(id) || null },
    holdSeat: (id, f) => { rows.set(id, Object.assign({}, rows.get(id), f)); return rows.get(id); },
    joinByLink: async () => { const meeting = { meeting_id: 'm1', room: 'r', state: 'live', session_id: 'mt_1' }; rows.set('m1', meeting); return { meeting }; },
    bot: { room: async (sid, op, args) => room(op, args) },
  };
}

async function hear(extra, mem, rows) {
  const policy = pol(Object.assign({ mode: 'admin', host_password: 'x', greet: false, credentials: '' }, extra));
  const seen = [];
  let fn = null;
  const ctx = { botName: 'Mia', ourNames: () => ['Mia'], emit: () => {}, holdSecret: () => {}, transcript: { onLine(f) { fn = f; return () => {}; } } };
  const g = new RoomGuard(ctx, policy);
  g.meetingId = 'm1';
  g.handler = (msg) => { seen.push(msg.from); };
  Object.assign(g.mem, mem);
  g.hookLines();
  for (const row of rows) fn({ meeting_id: 'm1', speaker: row.speaker, text: row.text, kind: 'chat', ts: 1 });
  await new Promise((r) => setImmediate(r));
  return seen;
}

function el(id, extra = {}) {
  return { id, style: { display: '' }, value: '', disabled: false, classList: { contains: () => false }, dataset: {}, ...extra };
}
function frame() {
  const ids = { capnote: el('capnote'), capbtn: el('capbtn'), pwbtn: el('pwbtn'), blurall: el('blurall', { style: { display: 'none' } }), 'pw-modal': el('pw-modal', { style: { display: 'none' } }) };
  const w = {
    document: { getElementById: (id) => ids[id] || null },
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    GifOS: { meetSubs: { useFile: async () => ({ status: 'ACTIVE' }), meeting: () => null, enabled: () => true } },
    __gifosVideo: {
      debugDump: () => ({ me: { peer: 'me', state: 3 }, participants: 2 }),
      hasAdmin: () => true, amAdmin: () => true, roomPw: () => '',
      rosterIdsNow: () => ['p1', 'p2'], nameOf: (pid) => (pid === 'p1' ? 'Ada' : 'Bea'), adminsHere: () => [],
    },
  };
  return { w, doc: { querySelectorAll: () => [{ getAttribute: () => 's1', contentWindow: w }] } };
}
async function run(fr, op, args) {
  const saved = globalThis.document;
  globalThis.document = fr.doc;
  try { return await roomPageOp({ id: 's1', op, args, oldSite: 'old', waitMs: 50 }); }
  finally { globalThis.document = saved; }
}

test('promoted is matched by seat id: a second person with the same name is not answered', () => {
  const p = pol({ stage: true });
  const m = newMemory();
  m.onStage = true;
  m.names = ['Ana', 'Ana', 'Sam'];
  m.promoted = { id: 'aaaaaaaaaaaa1', name: 'Ana', since: 0, lastSpoke: 0, arrived: true, saidDone: false };
  assert.equal(shouldAnswer(m, { from: 'Ana', fromId: 'bbbbbbbbbbbb2', text: 'What is GifOS?' }), false);
  assert.equal(noteLine(m, { from: 'Ana', fromId: 'bbbbbbbbbbbb2', text: 'What is GifOS?', at: 7 }, p).answer, false);
  assert.equal(m.promoted.lastSpoke, 0, 'the other Ana does not refresh the idle clock');
  assert.equal(shouldAnswer(m, { from: 'Ana', fromId: 'aaaaaaaaaaaa1', text: 'What is GifOS?' }), true);
  assert.equal(shouldAnswer(m, { from: 'Ana', fromId: 'aaaaaaaaaaaa', text: 'hi' }), true, 'a 12-char id prefix matches');
  assert.equal(noteLine(m, { from: 'Ana', fromId: 'bbbbbbbbbbbb2', text: 'thanks', at: 8 }, p).answer, false);
  assert.equal(m.promoted.saidDone, false, 'the other Ana saying thanks does not end the session');
});

test('a line with no id is matched by name only while the name is unique', () => {
  const m = newMemory();
  m.onStage = true;
  m.promoted = { id: 'a1', name: 'Ana', since: 0, lastSpoke: 0, arrived: true, saidDone: false };
  m.names = ['Ana', 'Sam'];
  assert.equal(shouldAnswer(m, { from: 'Ana', text: 'hi' }), true);
  m.names = ['Ana', 'Ana', 'Sam'];
  assert.equal(shouldAnswer(m, { from: 'Ana', text: 'hi' }), false);
  assert.equal(shouldAnswer(m, { from: 'Ana', fromId: '', text: 'hi' }), false);
});
