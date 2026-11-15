// The guard's decisions (src/guard.js plan) over the room states the bot's seat reads (room.js guard.state), and the
// guard.* page ops against a fake GifOS 0.9.26 meeting frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, normalizePolicy, newMemory, greetingText, GREETING, defaultGreeting } from '../../src/guard.js';
import { roomPageOp, ROOM_OPS } from '../../src/room.js';

// Siblings have their own names; a visitor may take any name, a sibling's too.
const B1 = 'Welcome Bot 1', B2 = 'Welcome Bot 2';
const pol = (o) => normalizePolicy(Object.assign({ link: 'https://gifos.app/meet/welcome', credentials: '/x/sub.gif' }, o || {}), '/');
const st = (o) => Object.assign({ supported: true, seated: true, participants: 3, me: 'me', admin_room: false, host: false,
  capture: { on: false, mine: false, can_take: false }, password_set: false, password_ok: true, locked_out: false,
  subscription: null, blur_all: { offered: false, on: false }, people: [] }, o || {});
const ops = (p) => p.actions.map((a) => a.op);

test('policy: an open room needs credentials, a room with a host needs its password; defaults keep no password', () => {
  assert.throws(() => normalizePolicy({ link: 'https://gifos.app/meet/x' }), /credentials/);
  assert.throws(() => normalizePolicy({ link: 'https://gifos.app/meet/x', mode: 'admin' }), /host_password/);
  const p = pol();
  assert.equal(p.password, null); assert.equal(p.blur_all, true); assert.equal(p.vote_out, undefined, 'no ban list: removing someone is a password'); assert.equal(p.greet, defaultGreeting(true)); assert.equal(p.rank, 0);
  assert.equal(pol({ password: 'abc' }).password, 'abc');
  assert.equal(pol({ greet: false }).greet, false);
  assert.ok(!/18\+/.test(GREETING) && !GREETING.includes('Clear video'), 'the base greeting is neutral');
  assert.ok(pol().greet.includes('Clear video is disabled.'), 'blur_all (default): the greeting says clear video is off');
  assert.ok(!pol({ blur_all: false }).greet.includes('Clear video'), 'no blur_all: it would not be true');
  assert.equal(pol({ greet: 'Hi {names}, chess today.' }).greet, 'Hi {names}, chess today.', 'an operator text replaces the default');
});

test('an open room nobody holds: rank 0 loads the credentials, then takes the room, then clears a password', () => {
  const p = pol(), m = newMemory();
  let r = plan(st(), p, m, 1000);
  assert.deepEqual(ops(r), ['guard.credentials']); assert.equal(r.role, 'taking');
  r = plan(st({ capture: { on: false, mine: false, can_take: true } }), p, m, 2000);
  assert.deepEqual(ops(r), ['guard.capture']);
  r = plan(st({ capture: { on: false, mine: false, can_take: true }, password_set: true }), p, m, 3000);
  assert.deepEqual(ops(r), ['guard.password'], 'no second tap inside 8 s; the password is cleared');
  assert.equal(r.actions[0].args.value, '');
});

test('rank 1 waits a minute before taking a room nobody holds', () => {
  const p = pol({ rank: 1 }), m = newMemory();
  assert.deepEqual(ops(plan(st(), p, m, 1000)), []);
  assert.deepEqual(ops(plan(st(), p, m, 30000)), []);
  assert.deepEqual(ops(plan(st(), p, m, 62000)), ['guard.credentials']);
});

test('the lead (holds the ticket) clears any password at once and keeps a set one', () => {
  const m = Object.assign(newMemory(), { credLoaded: true });
  const held = { capture: { on: true, mine: true }, subscription: { held: true } };
  let r = plan(st(Object.assign({ password_set: true, password_ok: false }, held)), pol(), m, 1000);
  assert.equal(r.role, 'lead'); assert.deepEqual(ops(r), ['guard.password']); assert.equal(r.actions[0].args.value, '');
  const m2 = Object.assign(newMemory(), { credLoaded: true });
  r = plan(st(Object.assign({ password_set: true, password_ok: false }, held)), pol({ password: 'keep-me-1' }), m2, 1000);
  assert.deepEqual(ops(r), ['guard.password']); assert.equal(r.actions[0].args.value, 'keep-me-1');
  r = plan(st(Object.assign({ password_set: true, password_ok: true }, held)), pol({ password: 'keep-me-1' }), m2, 9000);
  assert.deepEqual(ops(r), [], 'the right password is left alone');
});

test('a stranger holds the room: the bot waits, no actions', () => {
  const m = Object.assign(newMemory(), { credLoaded: true });
  const r = plan(st({ capture: { on: true, mine: false }, password_set: true }), pol(), m, 1000);
  assert.equal(r.role, 'held-by-other'); assert.deepEqual(ops(r), []); assert.ok(r.events.some((e) => e.type === 'guard.taken'));
});

test('siblings: the co-admin fixes the password only if the lead has not, and takes the ticket back when the lead is gone', () => {
  const m = Object.assign(newMemory(), { credLoaded: true });
  const co = (o) => st(Object.assign({ capture: { on: true, mine: true }, subscription: { held: false, moved: 'moved' }, people: [{ id: 'a', name: B1, admin: true }] }, o));
  let r = plan(co({ password_set: true }), pol({ rank: 1 }), m, 1000);
  assert.equal(r.role, 'coadmin'); assert.deepEqual(ops(r), [], 'the lead gets 6 s');
  r = plan(co({ password_set: true }), pol({ rank: 1 }), m, 8000);
  assert.deepEqual(ops(r), ['guard.password']);
  r = plan(co({ people: [] }), pol({ rank: 1 }), m, 30000);
  assert.deepEqual(ops(r), [], 'the lead seat gone 22 s: not yet');
  r = plan(co({ people: [] }), pol({ rank: 1 }), m, 8000 + 45000 + 20000 + 1000);
  assert.deepEqual(ops(r), ['guard.credentials']); assert.ok(r.events.some((e) => e.type === 'guard.takeover'));
});

test('the lead greets newcomers once they have sat 10 s (not the people already there, not its sibling), batched', () => {
  const m = Object.assign(newMemory(), { credLoaded: true });
  const held = (people) => st({ capture: { on: true, mine: true }, subscription: { held: true }, people });
  plan(held([{ id: 'x', name: 'Old' }]), pol(), m, 1000);
  // The sibling sits down as a guest and proves its key a few seconds later; it is never greeted.
  let r = plan(held([{ id: 'x', name: 'Old' }, { id: 'a', name: 'Ada' }, { id: 'b', name: 'Bob' }, { id: 's', name: B2 }]), pol(), m, 20000);
  assert.equal(r.greet, null, 'newcomers settle 10 s first');
  r = plan(held([{ id: 'x', name: 'Old' }, { id: 'a', name: 'Ada' }, { id: 'b', name: 'Bob' }, { id: 's', name: B2, admin: true }]), pol(), m, 26000);
  assert.equal(r.greet, null);
  r = plan(held([{ id: 'x', name: 'Old' }, { id: 'a', name: 'Ada' }, { id: 'b', name: 'Bob' }, { id: 's', name: B2, admin: true }]), pol(), m, 30000);
  assert.deepEqual(r.greet, ['Ada', 'Bob'], 'the sibling (an admin by now) is not greeted');
  r = plan(held([{ id: 'x', name: 'Old' }, { id: 'a', name: 'Ada' }, { id: 'c', name: 'Cy' }]), pol(), m, 35000);
  assert.equal(r.greet, null, 'Cy has not sat 10 s');
  r = plan(held([{ id: 'x', name: 'Old' }, { id: 'a', name: 'Ada' }, { id: 'c', name: 'Cy' }]), pol(), m, 40000);
  assert.equal(r.greet, null, 'slow mode: next greeting after 12 s');
  r = plan(held([{ id: 'c', name: 'Cy' }]), pol(), m, 45000);
  assert.deepEqual(r.greet, ['Cy']); assert.deepEqual(ops(r), []);
  // A visitor who takes the lead's own name is a visitor: greeted like anyone.
  r = plan(held([{ id: 'c', name: 'Cy' }, { id: 'v', name: B1 }]), pol(), m, 50000);
  r = plan(held([{ id: 'c', name: 'Cy' }, { id: 'v', name: B1 }]), pol(), m, 60000);
  assert.deepEqual(r.greet, [B1]);
  assert.equal(greetingText('Hi {names}!', ['Ada', 'Bob', 'Cy']), 'Hi Ada, Bob and Cy!');
  assert.equal(greetingText('Hi {names}!', ['see https://evil.example now']), 'Hi see  now!');
});

test('a staff pass: every sibling holds a ticket; the lowest rank present leads, the other is co-admin until its seat goes', () => {
  const pass = (people, o) => st(Object.assign({ capture: { on: true, mine: true }, subscription: { held: true, via: 'pass' }, people }, o));
  const mB = Object.assign(newMemory(), { credLoaded: true });
  const mA = Object.assign(newMemory(), { credLoaded: true });
  // B (rank 1) alone leads and greets.
  let r = plan(pass([{ id: 'x', name: 'Old' }]), pol({ rank: 1 }), mB, 1000);
  assert.equal(r.role, 'lead');
  // A (rank 0) sits beside it: A leads, B is co-admin and does not greet.
  r = plan(pass([{ id: 'x', name: 'Old' }, { id: 'a', name: B1, admin: true }, { id: 'n', name: 'Ned' }]), pol({ rank: 1 }), mB, 20000);
  assert.equal(r.role, 'coadmin'); assert.equal(r.greet, null); assert.deepEqual(ops(r), []);
  r = plan(pass([{ id: 'x', name: 'Old' }, { id: 'b', name: B2, admin: true }]), pol({ rank: 0 }), mA, 20000);
  assert.equal(r.role, 'lead');
  // The co-admin fixes a password only when the lead has not, after 6 s.
  r = plan(pass([{ id: 'a', name: B1, admin: true }], { password_set: true }), pol({ rank: 1 }), mB, 21000);
  assert.deepEqual(ops(r), []);
  r = plan(pass([{ id: 'a', name: B1, admin: true }], { password_set: true }), pol({ rank: 1 }), mB, 28000);
  assert.deepEqual(ops(r), ['guard.password']);
  // A's seat goes: B leads at once, with no credentials reload, and does not greet people it already saw (Ned).
  r = plan(pass([{ id: 'x', name: 'Old' }, { id: 'n', name: 'Ned' }, { id: 'z', name: 'Zoe' }]), pol({ rank: 1 }), mB, 60000);
  assert.equal(r.role, 'lead'); assert.deepEqual(ops(r), []); assert.equal(r.greet, null);
  r = plan(pass([{ id: 'x', name: 'Old' }, { id: 'n', name: 'Ned' }, { id: 'z', name: 'Zoe' }]), pol({ rank: 1 }), mB, 70000);
  assert.deepEqual(r.greet, ['Zoe']);
  // The bot's own seat never counts as its sibling.
  r = plan(pass([{ id: 'me', name: B2, admin: true }]), pol({ rank: 1 }), Object.assign(newMemory(), { credLoaded: true }), 1000);
  assert.equal(r.role, 'lead');
});

test('siblings with different names: one key, one lead and one co-admin (pass and subscription)', () => {
  // Pass: both hold a ticket. Each sees the other as an admin seat (the page verified the shared key).
  const pass = (people) => st({ capture: { on: true, mine: true }, subscription: { held: true, via: 'pass' }, people });
  const m0 = Object.assign(newMemory(), { credLoaded: true }), m1 = Object.assign(newMemory(), { credLoaded: true });
  assert.equal(plan(pass([{ id: 'w2', name: B2, admin: true }]), pol({ rank: 0 }), m0, 1000).role, 'lead');
  assert.equal(plan(pass([{ id: 'w1', name: B1, admin: true }]), pol({ rank: 1 }), m1, 1000).role, 'coadmin');
  // Subscription: one ticket. The holder leads; the other is co-admin and does not take the ticket while the lead sits.
  const sub = (held, people) => st({ capture: { on: true, mine: true }, subscription: { held, moved: held ? null : 'moved' }, people });
  const s0 = Object.assign(newMemory(), { credLoaded: true }), s1 = Object.assign(newMemory(), { credLoaded: true });
  assert.equal(plan(sub(true, [{ id: 'w2', name: B2, admin: true }]), pol({ rank: 0 }), s0, 1000).role, 'lead');
  for (const t of [1000, 60000, 120000]) {
    const r = plan(sub(false, [{ id: 'w1', name: B1, admin: true }]), pol({ rank: 1 }), s1, t);
    assert.equal(r.role, 'coadmin'); assert.deepEqual(ops(r), [], 'the lead sits: no takeover at ' + t);
  }
  // A room with a host: the other host seat holds the same host key; rank 0 leads.
  const hp = normalizePolicy({ link: 'https://gifos.app/meet/r/abc', mode: 'admin', host_password: 'host-pw' }, '/');
  assert.equal(plan(st({ host: true, people: [{ id: 'w2', name: B2, admin: true }] }), hp, newMemory(), 1000).role, 'lead');
  assert.equal(plan(st({ host: true, people: [{ id: 'w1', name: B1, admin: true }] }), { ...hp, rank: 1 }, newMemory(), 1000).role, 'coadmin');
});

test('security: a visitor with a sibling\'s NAME but not its key is not a sibling', () => {
  // Pass: rank 1 beside a visitor named like the lead still leads (the visitor is no admin), and greets it.
  const pass = (people) => st({ capture: { on: true, mine: true }, subscription: { held: true, via: 'pass' }, people });
  const m = Object.assign(newMemory(), { credLoaded: true });
  let r = plan(pass([{ id: 'x', name: 'Old' }]), pol({ rank: 1 }), m, 1000);
  for (const name of [B1, B2]) {
    r = plan(pass([{ id: 'x', name: 'Old' }, { id: 'v', name }]), pol({ rank: 1 }), m, 2000);
    assert.equal(r.role, 'lead', 'a visitor named ' + name + ' does not make the bot step down');
  }
  r = plan(pass([{ id: 'x', name: 'Old' }, { id: 'v', name: B1 }]), pol({ rank: 1 }), m, 13000);
  assert.deepEqual(r.greet, [B1], 'and is greeted as a visitor');
  // Subscription: a co-admin whose lead left takes the ticket back though a visitor sits there with the lead's name.
  const sub = (people) => st({ capture: { on: true, mine: true }, subscription: { held: false, moved: 'moved' }, people });
  const c = Object.assign(newMemory(), { credLoaded: true });
  plan(sub([{ id: 'w1', name: B1, admin: true }]), pol({ rank: 1 }), c, 1000);
  r = plan(sub([{ id: 'v', name: B1 }]), pol({ rank: 1 }), c, 1000 + 45000 + 20000 + 1000);
  assert.deepEqual(ops(r), ['guard.credentials']); assert.ok(r.events.some((e) => e.type === 'guard.takeover'));
  // A host room: a visitor named like the host bot is no host.
  const hp = normalizePolicy({ link: 'https://gifos.app/meet/r/abc', mode: 'admin', host_password: 'host-pw', rank: 1 }, '/');
  assert.equal(plan(st({ host: true, people: [{ id: 'v', name: B1 }] }), hp, newMemory(), 1000).role, 'lead');
  // Before this bot is an admin, an admin seat is someone else's key (a stranger's capture): no sibling.
  const o = Object.assign(newMemory(), { credLoaded: true });
  r = plan(st({ capture: { on: true, mine: false }, people: [{ id: 'cap', name: B1, admin: true }] }), pol({ rank: 1 }), o, 1000);
  assert.equal(r.role, 'held-by-other'); assert.equal(o.siblingSeenAt, 0);
});

test('Blur guests: pressed when offered, a gap event once when not', () => {
  const m = Object.assign(newMemory(), { credLoaded: true });
  const held = (ba) => st({ capture: { on: true, mine: true }, subscription: { held: true }, blur_all: ba });
  let r = plan(held({ offered: true, on: false }), pol(), m, 1000);
  assert.deepEqual(ops(r), ['guard.blur_all']);
  const m2 = Object.assign(newMemory(), { credLoaded: true });
  r = plan(held({ offered: false, on: false }), pol(), m2, 1000);
  assert.ok(r.events.some((e) => e.type === 'guard.gap'));
  r = plan(held({ offered: false, on: false }), pol(), m2, 5000);
  assert.ok(!r.events.some((e) => e.type === 'guard.gap'));
});

test('a room with a host: sign in, then hold its password', () => {
  const p = normalizePolicy({ link: 'https://gifos.app/meet/r/abc', mode: 'admin', host_password: 'host-pw' }, '/');
  const m = newMemory();
  let r = plan(st({ host: false }), p, m, 1000);
  assert.deepEqual(ops(r), ['host.signin']);
  r = plan(st({ host: true, password_set: true }), p, m, 5000);
  assert.equal(r.role, 'lead'); assert.deepEqual(ops(r), ['guard.password']);
});

test('an older site: unsupported, nothing done', () => {
  const r = plan(st({ supported: false }), pol(), newMemory(), 1000);
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
      rosterIdsNow: () => ['p1', 'p2', 'p3'], nameOf: (pid) => (pid === 'p1' ? 'Ada' : 'Bot 2'), adminsHere: () => ['me', 'p2'], kickedForTest: () => true, voteOffForTest: (n) => { s.votes.push(n); return 'voted p1'; } },
  };
  const f = { getAttribute: () => 's1', contentWindow: w };
  return { s, ids, doc: { querySelectorAll: () => [f] } };
}
async function run(fr, op, args) {
  const saved = globalThis.document; globalThis.document = fr.doc;
  try { return await roomPageOp({ id: 's1', op, args, oldSite: 'old', waitMs: 50 }); } finally { globalThis.document = saved; }
}

test('page ops: the guard ops are listed', () => {
  for (const op of ['guard.state', 'guard.credentials', 'guard.capture', 'guard.password', 'guard.blur_all']) assert.ok(ROOM_OPS.includes(op), op);
});

test('page ops: state reads capture, password, people; credentials, capture and password act through the page', async () => {
  const fr = frame({ capOn: true, mine: true, pw: 'x' });
  let r = await run(fr, 'guard.state', { want: '' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.v.capture, { on: true, mine: true, can_take: false });
  assert.equal(r.v.password_set, true); assert.equal(r.v.password_ok, false);
  assert.deepEqual(r.v.people, [{ id: 'p1', name: 'Ada', admin: false }, { id: 'p2', name: 'Bot 2', admin: true }, { id: 'p3', name: 'Bot 2', admin: false }],
    'admin: the page proved that seat\'s key; a second seat with the same name is not');
  r = await run(fr, 'guard.password', { value: '' });
  assert.equal(r.ok, true); assert.equal(fr.s.pw, '');
  r = await run(fr, 'guard.credentials', { gif_b64: Buffer.from('GIF89a-bytes').toString('base64') });
  assert.equal(r.ok, true); assert.equal(fr.s.used, 12);
  r = await run(fr, 'guard.blur_all', { on: true });
  assert.equal(r.ok, false, 'not offered to an open-room admin');
  // A pass ticket (the staff pass) reads as held, via the pass.
  const pf = frame({ capOn: true, mine: true });
  const ms = pf.doc.querySelectorAll()[0].contentWindow.GifOS.meetSubs;
  ms.meeting = () => ({ held: false, moved: null, tier: null, paid: false }); ms.passMeeting = () => ({ held: true, moved: null });
  r = await run(pf, 'guard.state', { want: '' });
  assert.deepEqual(r.v.subscription, { held: true, via: 'pass', moved: null, tier: 'pass', paid: true });
  ms.passMeeting = () => ({ held: false, moved: 'moved' });
  r = await run(pf, 'guard.state', { want: '' });
  assert.deepEqual(r.v.subscription, { held: false, via: null, moved: 'moved', tier: null, paid: false });
  const other = frame({ capOn: true, mine: false });
  r = await run(other, 'guard.password', { value: '' });
  assert.equal(r.ok, false); assert.match(r.error, /admin/);
  const open = frame();
  r = await run(open, 'guard.capture', {});
  assert.equal(r.ok, true); assert.equal(open.ids.capbtn.clicks, 1);
});
