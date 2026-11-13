// The guard's decisions (src/guard.js plan) over the room states the bot's seat reads (room.js guard.state), and the
// guard.* page ops against a fake GifOS 0.9.26 meeting frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, normalizePolicy, newMemory, greetingText, GREETING } from '../../src/guard.js';
import { roomPageOp, ROOM_OPS } from '../../src/room.js';

const BOT = 'GifOS Welcome';
const pol = (o) => normalizePolicy(Object.assign({ link: 'https://gifos.app/meet/welcome', credentials: '/x/sub.gif' }, o || {}), '/');
const st = (o) => Object.assign({ supported: true, seated: true, participants: 3, me: 'me', admin_room: false, host: false,
  capture: { on: false, mine: false, can_take: false }, password_set: false, password_ok: true, locked_out: false,
  subscription: null, blur_all: { offered: false, on: false }, people: [] }, o || {});
const ops = (p) => p.actions.map((a) => a.op);

test('policy: an open room needs credentials, a room with a host needs its password; defaults keep no password', () => {
  assert.throws(() => normalizePolicy({ link: 'https://gifos.app/meet/x' }), /credentials/);
  assert.throws(() => normalizePolicy({ link: 'https://gifos.app/meet/x', mode: 'admin' }), /host_password/);
  const p = pol();
  assert.equal(p.password, null); assert.equal(p.blur_all, true); assert.equal(p.vote_out, true); assert.equal(p.greet, GREETING); assert.equal(p.rank, 0);
  assert.equal(pol({ password: 'abc' }).password, 'abc');
  assert.equal(pol({ greet: false }).greet, false);
});

test('an open room nobody holds: rank 0 loads the credentials, then takes the room, then clears a password', () => {
  const p = pol(), m = newMemory();
  let r = plan(st(), p, m, 1000, BOT);
  assert.deepEqual(ops(r), ['guard.credentials']); assert.equal(r.role, 'taking');
  r = plan(st({ capture: { on: false, mine: false, can_take: true } }), p, m, 2000, BOT);
  assert.deepEqual(ops(r), ['guard.capture']);
  r = plan(st({ capture: { on: false, mine: false, can_take: true }, password_set: true }), p, m, 3000, BOT);
  assert.deepEqual(ops(r), ['guard.password'], 'no second tap inside 8 s; the password is cleared');
  assert.equal(r.actions[0].args.value, '');
});

test('rank 1 waits a minute before taking a room nobody holds', () => {
  const p = pol({ rank: 1 }), m = newMemory();
  assert.deepEqual(ops(plan(st(), p, m, 1000, BOT)), []);
  assert.deepEqual(ops(plan(st(), p, m, 30000, BOT)), []);
  assert.deepEqual(ops(plan(st(), p, m, 62000, BOT)), ['guard.credentials']);
});

test('the lead (holds the ticket) clears any password at once and keeps a set one', () => {
  const m = Object.assign(newMemory(), { credLoaded: true });
  const held = { capture: { on: true, mine: true }, subscription: { held: true } };
  let r = plan(st(Object.assign({ password_set: true, password_ok: false }, held)), pol(), m, 1000, BOT);
  assert.equal(r.role, 'lead'); assert.deepEqual(ops(r), ['guard.password']); assert.equal(r.actions[0].args.value, '');
  const m2 = Object.assign(newMemory(), { credLoaded: true });
  r = plan(st(Object.assign({ password_set: true, password_ok: false }, held)), pol({ password: 'keep-me-1' }), m2, 1000, BOT);
  assert.deepEqual(ops(r), ['guard.password']); assert.equal(r.actions[0].args.value, 'keep-me-1');
  r = plan(st(Object.assign({ password_set: true, password_ok: true }, held)), pol({ password: 'keep-me-1' }), m2, 9000, BOT);
  assert.deepEqual(ops(r), [], 'the right password is left alone');
});

test('a stranger holds the room: the bot waits, no actions', () => {
  const m = Object.assign(newMemory(), { credLoaded: true });
  const r = plan(st({ capture: { on: true, mine: false }, password_set: true }), pol(), m, 1000, BOT);
  assert.equal(r.role, 'held-by-other'); assert.deepEqual(ops(r), []); assert.ok(r.events.some((e) => e.type === 'guard.taken'));
});

test('siblings: the co-admin fixes the password only if the lead has not, and takes the ticket back when the lead is gone', () => {
  const m = Object.assign(newMemory(), { credLoaded: true });
  const co = (o) => st(Object.assign({ capture: { on: true, mine: true }, subscription: { held: false, moved: 'moved' }, people: [{ id: 'a', name: BOT }] }, o));
  let r = plan(co({ password_set: true }), pol({ rank: 1 }), m, 1000, BOT);
  assert.equal(r.role, 'coadmin'); assert.deepEqual(ops(r), [], 'the lead gets 6 s');
  r = plan(co({ password_set: true }), pol({ rank: 1 }), m, 8000, BOT);
  assert.deepEqual(ops(r), ['guard.password']);
  r = plan(co({ people: [] }), pol({ rank: 1 }), m, 30000, BOT);
  assert.deepEqual(ops(r), [], 'the lead seat gone 22 s: not yet');
  r = plan(co({ people: [] }), pol({ rank: 1 }), m, 8000 + 45000 + 20000 + 1000, BOT);
  assert.deepEqual(ops(r), ['guard.credentials']); assert.ok(r.events.some((e) => e.type === 'guard.takeover'));
});

test('the lead greets newcomers (not the people already there, not its sibling), batched, and backs a passed vote', () => {
  const m = Object.assign(newMemory(), { credLoaded: true });
  const held = (people) => st({ capture: { on: true, mine: true }, subscription: { held: true }, people });
  plan(held([{ id: 'x', name: 'Old' }]), pol(), m, 1000, BOT);
  let r = plan(held([{ id: 'x', name: 'Old' }, { id: 'a', name: 'Ada' }, { id: 'b', name: 'Bob' }, { id: 's', name: BOT }]), pol(), m, 20000, BOT);
  assert.deepEqual(r.greet, ['Ada', 'Bob']);
  r = plan(held([{ id: 'x', name: 'Old' }, { id: 'a', name: 'Ada' }, { id: 't', name: 'Troll', voted_out: true }]), pol(), m, 25000, BOT);
  assert.deepEqual(ops(r), ['guard.vote_out']); assert.equal(r.greet, null, 'slow mode: next greeting after 12 s');
  r = plan(held([{ id: 't', name: 'Troll', voted_out: true }]), pol(), m, 40000, BOT);
  assert.deepEqual(r.greet, ['Troll']); assert.deepEqual(ops(r), [], 'one vote per person');
  assert.equal(greetingText('Hi {names}!', ['Ada', 'Bob', 'Cy']), 'Hi Ada, Bob and Cy!');
  assert.equal(greetingText('Hi {names}!', ['see https://evil.example now']), 'Hi see  now!');
});

test('Blur guests: pressed when offered, a gap event once when not', () => {
  const m = Object.assign(newMemory(), { credLoaded: true });
  const held = (ba) => st({ capture: { on: true, mine: true }, subscription: { held: true }, blur_all: ba });
  let r = plan(held({ offered: true, on: false }), pol(), m, 1000, BOT);
  assert.deepEqual(ops(r), ['guard.blur_all']);
  const m2 = Object.assign(newMemory(), { credLoaded: true });
  r = plan(held({ offered: false, on: false }), pol(), m2, 1000, BOT);
  assert.ok(r.events.some((e) => e.type === 'guard.gap'));
  r = plan(held({ offered: false, on: false }), pol(), m2, 5000, BOT);
  assert.ok(!r.events.some((e) => e.type === 'guard.gap'));
});

test('a room with a host: sign in, then hold its password', () => {
  const p = normalizePolicy({ link: 'https://gifos.app/meet/r/abc', mode: 'admin', host_password: 'host-pw' }, '/');
  const m = newMemory();
  let r = plan(st({ host: false }), p, m, 1000, BOT);
  assert.deepEqual(ops(r), ['host.signin']);
  r = plan(st({ host: true, password_set: true }), p, m, 5000, BOT);
  assert.equal(r.role, 'lead'); assert.deepEqual(ops(r), ['guard.password']);
});

test('an older site: unsupported, nothing done', () => {
  const r = plan(st({ supported: false }), pol(), newMemory(), 1000, BOT);
  assert.equal(r.role, 'unsupported'); assert.deepEqual(ops(r), []);
});

// ---- the page ops on a fake meeting frame ----
function el(id, extra = {}) { return { id, style: { display: '' }, value: '', disabled: false, textContent: '', classList: { s: new Set(), contains(c) { return this.s.has(c); } }, clicks: 0, click() { this.clicks++; if (this.onclick) this.onclick(); }, dataset: {}, ...extra }; }
function frame({ capOn = false, mine = false, pw = '' } = {}) {
  const s = { pw, used: null, votes: [] };
  const ids = { capnote: el('capnote', { style: { display: capOn ? '' : 'none' } }), capbtn: el('capbtn', { style: { display: capOn ? 'none' : '' } }),
    pwbtn: el('pwbtn', { disabled: capOn && !mine }), 'pw-new': el('pw-new'), 'pw-save': el('pw-save'), blurall: el('blurall', { style: { display: 'none' } }), 'pw-modal': el('pw-modal', { style: { display: 'none' } }) };
  ids['pw-save'].onclick = () => { s.pw = ids['pw-new'].value; };
  const w = {
    document: { getElementById: (id) => ids[id] || null }, localStorage: { setItem() {} }, atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    GifOS: { meetSubs: { useFile: async (u8) => { s.used = u8.length; return { status: 'ACTIVE' }; }, meeting: () => ({ held: true, tier: 'unlimited', paid: true }), enabled: () => true } },
    __gifosVideo: { debugDump: () => ({ me: { peer: 'me', state: 3 }, participants: 2 }), hasAdmin: () => false, amAdmin: () => false, roomPw: () => s.pw,
      rosterIdsNow: () => ['p1'], nameOf: () => 'Ada', kickedForTest: () => true, voteOffForTest: (n) => { s.votes.push(n); return 'voted p1'; } },
  };
  const f = { getAttribute: () => 's1', contentWindow: w };
  return { s, ids, doc: { querySelectorAll: () => [f] } };
}
async function run(fr, op, args) {
  const saved = globalThis.document; globalThis.document = fr.doc;
  try { return await roomPageOp({ id: 's1', op, args, oldSite: 'old', waitMs: 50 }); } finally { globalThis.document = saved; }
}

test('page ops: the guard ops are listed', () => {
  for (const op of ['guard.state', 'guard.credentials', 'guard.capture', 'guard.password', 'guard.blur_all', 'guard.vote_out']) assert.ok(ROOM_OPS.includes(op), op);
});

test('page ops: state reads capture, password, people; credentials, capture, password and vote act through the page', async () => {
  const fr = frame({ capOn: true, mine: true, pw: 'x' });
  let r = await run(fr, 'guard.state', { want: '' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.v.capture, { on: true, mine: true, can_take: false });
  assert.equal(r.v.password_set, true); assert.equal(r.v.password_ok, false);
  assert.deepEqual(r.v.people, [{ id: 'p1', name: 'Ada', voted_out: true }]);
  r = await run(fr, 'guard.password', { value: '' });
  assert.equal(r.ok, true); assert.equal(fr.s.pw, '');
  r = await run(fr, 'guard.credentials', { gif_b64: Buffer.from('GIF89a-bytes').toString('base64') });
  assert.equal(r.ok, true); assert.equal(fr.s.used, 12);
  r = await run(fr, 'guard.vote_out', { id: 'p1' });
  assert.equal(r.v.vote, 'voted p1'); assert.deepEqual(fr.s.votes, ['Ada']);
  r = await run(fr, 'guard.blur_all', { on: true });
  assert.equal(r.ok, false, 'not offered to an open-room admin');
  const other = frame({ capOn: true, mine: false });
  r = await run(other, 'guard.password', { value: '' });
  assert.equal(r.ok, false); assert.match(r.error, /admin/);
  const open = frame();
  r = await run(open, 'guard.capture', {});
  assert.equal(r.ok, true); assert.equal(open.ids.capbtn.clicks, 1);
});
