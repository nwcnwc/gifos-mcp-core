// A new live release on the site (src/site.js, src/guard.js siteTurn): a guard reloads its bot on it and takes the
// room back, and two siblings move one at a time. Seen live 2026-11-26: both welcome bots stayed on 0.9.28.35 pages
// while the site moved to .38 (floor .38, one link grammar), so they held a room fresh pages never reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomGuard, normalizePolicy, siteTurn, newMemory } from '../../src/guard.js';
import { createSiteWatch } from '../../src/site.js';

const held = (people) => ({ supported: true, seated: true, me: 'me', capture: { on: true, mine: true }, subscription: { held: true, via: 'pass' }, people: people || [] });
const T = 1e6;   // a clock that is never 0
const sib = (id) => ({ id, name: 'Mia', admin: true });

test('siteTurn: rank 0 goes first while its sibling holds the room', () => {
  const mem = newMemory();
  assert.deepEqual(siteTurn(held([sib('s1')]), { rank: 0 }, mem, 1000, '0.9.28.39').go, true);
});

test('siteTurn: alone, or not holding anything, a seat goes at once', () => {
  assert.equal(siteTurn(held([]), { rank: 1 }, newMemory(), 1000, 'v2').go, true);
  assert.equal(siteTurn({ supported: true, seated: false }, { rank: 1 }, newMemory(), 1000, 'v2').go, true);
});

test('siteTurn: rank 1 waits for its sibling to leave and come back (same room), then goes', () => {
  const mem = newMemory();
  const pol = { rank: 1 };
  assert.equal(siteTurn(held([sib('s1')]), pol, mem, T + 0, 'v2').go, false, 'the sibling is still on the old page');
  assert.equal(siteTurn(held([]), pol, mem, T + 5000, 'v2').go, false, 'the sibling just left: it is moving, keep the room');
  assert.equal(siteTurn(held([]), pol, mem, T + 30000, 'v2').go, false);
  const back = siteTurn(held([sib('s2')]), pol, mem, T + 40000, 'v2');
  assert.equal(back.go, true, 'a new sibling seat: it is back');
  // The same seat id coming back counts too.
  const m2 = newMemory();
  siteTurn(held([sib('s1')]), pol, m2, T + 0, 'v2');
  siteTurn(held([]), pol, m2, T + 3000, 'v2');
  assert.equal(siteTurn(held([sib('s1')]), pol, m2, T + 20000, 'v2').go, true);
});

test('siteTurn: rank 1 goes once its sibling has been gone a minute (the new release meets in a room this page cannot reach)', () => {
  const mem = newMemory();
  const pol = { rank: 1 };
  siteTurn(held([sib('s1')]), pol, mem, T + 0, 'v2');
  assert.equal(siteTurn(held([]), pol, mem, T + 59000, 'v2').go, false);
  assert.equal(siteTurn(held([]), pol, mem, T + 61000, 'v2').go, true);
});

test('siteTurn: rank 0 that sees its sibling away moments ago waits for it (never two seats gone at once)', () => {
  const mem = newMemory();
  mem.siblingSeenAt = 1000;
  assert.equal(siteTurn(held([]), { rank: 0 }, mem, 11000, 'v2').go, false);
  assert.equal(siteTurn(held([sib('s9')]), { rank: 0 }, mem, 20000, 'v2').go, true);
});

test('siteTurn: a sibling that never moves (an older bot) holds rank 1 back at most the wait limit', () => {
  const mem = newMemory();
  const pol = { rank: 1 };
  siteTurn(held([sib('s1')]), pol, mem, T + 0, 'v2');
  assert.equal(siteTurn(held([sib('s1')]), pol, mem, T + 119000, 'v2').go, false);
  assert.equal(siteTurn(held([sib('s1')]), pol, mem, T + 120000, 'v2').go, true);
});

function fakeCtx(site) {
  const rows = new Map();
  let sessions = 0;
  const ctx = {
    botName: 'Leo', emitted: [], joins: 0, departed: 0, site,
    emit: (e) => ctx.emitted.push(e),
    meetings: { get: (id) => rows.get(id) || null },
    holdSeat: (id, f) => { rows.set(id, Object.assign({}, rows.get(id), f)); return rows.get(id); },
    depart: async (m) => { ctx.departed++; ctx.holdSeat(m.meeting_id, { state: 'ended', session_id: null }); },
    joinByLink: async () => {
      ctx.joins++;
      const m = Object.assign({ meeting_id: 'm1' }, rows.get('m1') || {}, { state: 'live', session_id: 's' + (++sessions) });
      rows.set('m1', m);
      return { meeting: m };
    },
    people: [],
    ops: [],
    bot: { room: async (sid, op) => { ctx.ops.push(op); return op === 'guard.state' ? held(ctx.people) : {}; } },
  };
  return ctx;
}

function fakeSite(page, latest) {
  const s = { page, live: latest, refreshed: [], claimed: false,
    latest: () => s.live, pageVersion: () => s.page, stale: () => s.live !== s.page, claim() { s.claimed = true; },
    async refresh(why) { s.refreshed.push(why); s.page = s.live; } };
  return s;
}

test('a guard on a page the site moved past leaves, reloads its bot, joins again and takes the room back', async () => {
  const site = fakeSite('0.9.28.38', '0.9.28.38');
  const ctx = fakeCtx(site);
  const g = new RoomGuard(ctx, normalizePolicy({ link: 'https://gifos.app/meet/welcome', credentials: new URL(import.meta.url).pathname, greet: false, rank: 0 }, '/'));
  assert.equal(site.claimed, true, 'the guard picks the moment, not the watch');
  await g.tick(); await g.tick();
  assert.equal(ctx.joins, 1);
  ctx.people = [sib('s1')];
  await g.tick();
  site.live = '0.9.28.39';   // a deploy
  await g.tick();            // rank 0, a sibling holds the room: go now
  assert.equal(ctx.departed, 1, 'left the room first (its seat is free at once)');
  assert.equal(site.refreshed.length, 1, 'reloaded the bot once');
  assert.ok(ctx.emitted.some((e) => e.type === 'guard.site_reload' && e.data.to === '0.9.28.39'));
  await g.tick();            // joins again on the new page
  assert.equal(ctx.joins, 2);
  await g.tick();            // loads its credentials again (a new seat takes the room back from 'waiting')
  await g.tick();
  const back = ctx.emitted.find((e) => e.type === 'guard.site_back');
  assert.ok(back, 'says it is back in the room');
  assert.equal(back.data.to, '0.9.28.39');
  assert.ok(back.data.ms >= 0);
  assert.equal(g.status().site.page, '0.9.28.39');
});

test('rank 1 keeps the room while its sibling moves, then moves itself', async () => {
  const site = fakeSite('v1', 'v1');
  const ctx = fakeCtx(site);
  const g = new RoomGuard(ctx, normalizePolicy({ link: 'https://gifos.app/meet/welcome', credentials: new URL(import.meta.url).pathname, greet: false, rank: 1 }, '/'));
  ctx.people = [sib('s1')];
  await g.tick(); await g.tick(); await g.tick();
  site.live = 'v2';
  await g.tick();
  assert.equal(site.refreshed.length, 0, 'waits: the lower rank moves first');
  assert.ok(ctx.emitted.some((e) => e.type === 'guard.site_wait'));
  ctx.people = [];           // the sibling left to reload
  await g.tick();
  assert.equal(site.refreshed.length, 0, 'still holds the room');
  ctx.people = [sib('s2')];  // back on its new page
  await g.tick();
  assert.equal(site.refreshed.length, 1, 'now it moves');
});

test('a guard that must join again never joins on a stale page', async () => {
  const site = fakeSite('v1', 'v2');
  const ctx = fakeCtx(site);
  const g = new RoomGuard(ctx, normalizePolicy({ link: 'https://gifos.app/meet/welcome', mode: 'admin', host_password: 'x', greet: false }, '/'));
  await g.tick();
  assert.equal(site.refreshed.length, 1, 'reloaded before the join');
  assert.equal(ctx.joins, 1);
});

test('createSiteWatch: with no guard a new release reloads the bot at once; a claimed watch only reports', async () => {
  const make = () => {
    let onUpdate = null, latest = 'v1';
    const watch = (_url, fn) => { onUpdate = fn; return { latest: () => latest, check: async () => {}, stop() {} }; };
    const bot = { refreshed: 0, pageVersion: () => '', refresh: async () => { bot.refreshed++; } };
    const events = [];
    const site = createSiteWatch({ cfg: { gifosUrl: 'http://x', siteCheckMs: 60000 }, bot, emit: (e) => events.push(e), watch });
    return { site, bot, events, bump: async (v) => { const from = latest; latest = v; await onUpdate({ from, to: v, floor: v }); } };
  };
  const a = make();
  await new Promise((r) => setImmediate(r));
  assert.equal(a.site.stale(), false);
  await a.bump('v2');
  assert.equal(a.bot.refreshed, 1);
  assert.equal(a.site.stale(), false, 'the reload moved the page to the live release');
  assert.ok(a.events.some((e) => e.type === 'site.update') && a.events.some((e) => e.type === 'site.reload'));
  const b = make();
  await new Promise((r) => setImmediate(r));
  b.site.claim();
  await b.bump('v2');
  assert.equal(b.bot.refreshed, 0);
  assert.equal(b.site.stale(), true);
});
