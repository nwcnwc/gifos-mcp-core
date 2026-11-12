// The meeting-page ops (src/room.js) against a fake GifOS 0.9.26 meeting
// frame and a fake Take Turns frame, and against an older site without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomPageOp, turnsPageOp, OLD_SITE, ROOM_OPS, TURNS_OPS } from '../../src/room.js';

function el(id, extra = {}) {
  return { id, style: { display: '' }, value: '', hidden: false, disabled: false, textContent: '', clicks: 0, click() { this.clicks++; if (this.onclick) this.onclick(); }, ...extra };
}

// A meeting frame: an agenda, an app slot, a stage of 2 seats, an Admin dialog.
function meeting({ old = false, admin = false, canRun = true, hostRoom = true } = {}) {
  const s = { admin, agenda: null, app: null, onStage: false, stagers: [], grants: [] };
  const ids = { admbtn: el('admbtn', { style: { display: hostRoom ? '' : 'none' } }), 'adm-pass': el('adm-pass'), 'adm-enable': el('adm-enable'), 'adm-modal': el('adm-modal') };
  ids['adm-enable'].onclick = () => { if (ids['adm-pass'].value === 'host-pw') s.admin = true; };
  const w = {
    document: { getElementById: (id) => ids[id] || null },
    GifOS: { store: { allFileMeta: async () => [
      { id: 'f1', appId: 'taketurns', name: 'Take Turns', isApp: true },
      { id: 'f2', appId: 'meet', name: 'Meet', isApp: true },
      { id: 'f3', appId: 'chess', name: 'Chess.gif', isApp: true },
      { id: 'f4', appId: 'notes', name: 'notes.txt', isApp: false },
    ] } },
  };
  if (!old) {
    w.__meetContent = () => ({ agenda: s.agenda });
    w.__meetContentDo = {
      agendaOpen: async () => true,
      agendaAdd: async (t, min) => { if (hostRoom && !s.admin) return false; s.agenda = s.agenda || { v: 1, cur: -1, n: 0, items: [], clock: '' }; s.agenda.items.push(t); s.agenda.n++; s.agenda.mins = (s.agenda.mins || []).concat(min); return true; },
      agendaNext: async () => { if (hostRoom && !s.admin) return false; s.agenda.cur++; s.agenda.clock = '5:00'; return true; },
    };
    w.__gifosVideo = {
      statusText: () => (s.admin ? '' : 'Only the host can change the agenda.'),
      amAdmin: () => s.admin,
      appActive: () => !!s.app, appName: () => (s.app || ''), appIsHost: () => !!s.app, canRunApp: () => canRun || s.admin,
      runAppForTest: async (fid, name) => { s.app = name; s.fid = fid; },
      stopAppForTest: async () => { s.app = null; },
      stageInfo: () => ({ stagers: s.stagers, cap: 2 }),
      onStage: () => s.onStage, canStageNow: () => !hostRoom || s.admin,
      setStageForTest: async (on) => { s.onStage = on; s.stagers = on ? s.stagers.concat({ id: 'bot', name: 'Bot', me: true }) : s.stagers.filter((x) => !x.me); },
      grantApp: async (pid, on) => { s.grants.push([pid, on]); },
    };
  } else {
    w.__gifosVideo = { statusText: () => '' };
  }
  return { w, s, ids };
}

async function run(frameWin, op, args, id = 'mt_1') {
  const frame = { getAttribute: () => id, contentWindow: frameWin };
  globalThis.document = { querySelectorAll: () => [frame] };
  try { return await roomPageOp({ id: 'mt_1', op, args, oldSite: OLD_SITE, waitMs: 600 }); }
  finally { delete globalThis.document; }
}

test('op lists name every case the page function handles', () => {
  assert.ok(ROOM_OPS.length >= 12 && TURNS_OPS.includes('turns.next'));
});

test('an older GifOS site answers plainly instead of failing', async () => {
  const { w } = meeting({ old: true });
  assert.deepEqual((await run(w, 'agenda.get')).v, { supported: false, note: OLD_SITE });
  assert.equal((await run(w, 'agenda.add', { items: [{ title: 'x' }] })).error, OLD_SITE);
  assert.equal((await run(w, 'app.run', { app: 'chess' })).error, OLD_SITE);
  assert.equal((await run(w, 'stage.get')).error, OLD_SITE);
});

test('a meeting the bot is not in is refused', async () => {
  const { w } = meeting();
  globalThis.document = { querySelectorAll: () => [{ getAttribute: () => 'mt_9', contentWindow: w }] };
  try { assert.match((await roomPageOp({ id: 'mt_1', op: 'stage.get', args: {} })).error, /not in that meeting/); }
  finally { delete globalThis.document; }
});

test('agenda: a guest in a host room is refused with the page\'s words; the host sets and moves it', async () => {
  const { w, ids, s } = meeting();
  const r = await run(w, 'agenda.add', { items: [{ title: 'Intro', minutes: 5 }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /sign_in_as_host/);
  assert.match(r.error, /Only the host can change the agenda/);
  assert.equal((await run(w, 'agenda.next')).ok, false, 'no agenda yet');
  assert.equal((await run(w, 'host.signin', { password: 'wrong' })).error, 'That host password did not sign the bot in.');
  assert.equal(ids['adm-pass'].value, '', 'the password does not stay in the field');
  assert.equal((await run(w, 'host.signin', { password: 'host-pw' })).v.bot_is_host, true);
  const set = await run(w, 'agenda.add', { items: [{ title: 'Intro', minutes: 5 }, { title: 'Demo', minutes: 900 }] });
  assert.deepEqual(set.v.added, ['Intro', 'Demo']);
  assert.deepEqual(s.agenda.mins, [5, 600], 'minutes are clamped to the page limit');
  assert.match((await run(w, 'agenda.add', { items: [{ title: 'More' }] })).error, /append:true/);
  assert.equal((await run(w, 'agenda.add', { items: [{ title: 'More' }], append: true })).ok, true);
  const nx = await run(w, 'agenda.next');
  assert.equal(nx.v.agenda.cur, 0);
  assert.equal((await run(w, 'agenda.get')).v.agenda.clock, '5:00');
});

test('host sign-in in an open room says there is no host', async () => {
  const { w } = meeting({ hostRoom: false });
  assert.match((await run(w, 'host.signin', { password: 'x' })).error, /no host/);
});

test('apps: lists runnable apps without system apps, runs by name or id, stops only its own', async () => {
  const { w, s } = meeting({ hostRoom: false });
  const list = (await run(w, 'app.list')).v;
  assert.deepEqual(list.apps.map((a) => a.name), ['Take Turns', 'Chess']);
  assert.match((await run(w, 'app.run', { app: 'Pong' })).error, /No app named "Pong".*Take Turns, Chess/);
  const r = await run(w, 'app.run', { app: 'take turns' });
  assert.equal(r.v.started, 'Take Turns');
  assert.equal(s.fid, 'f1');
  assert.equal((await run(w, 'app.stop')).v.stopped, true);
  assert.equal((await run(w, 'app.stop')).v.stopped, false);
  const guest = meeting({ canRun: false });
  assert.match((await run(guest.w, 'app.run', { app: 'chess' })).error, /may not run apps/);
});

test('stage: steps the bot on and off within its rights; only a host may allow others', async () => {
  const open = meeting({ hostRoom: false });
  const on = await run(open.w, 'stage.set', { on: true });
  assert.equal(on.v.bot_on_stage, true);
  assert.equal(on.v.on_stage[0].bot, true);
  assert.equal((await run(open.w, 'stage.set', { on: false })).v.bot_on_stage, false);
  open.s.stagers = [{ id: 'a', me: false }, { id: 'b', me: false }];
  assert.match((await run(open.w, 'stage.set', { on: true })).error, /stage is full/);
  const host = meeting();
  assert.match((await run(host.w, 'stage.set', { on: true })).error, /may not step on the stage/);
  assert.match((await run(host.w, 'stage.grant', { person_id: 'p1', on: true })).error, /Only a host/);
  await run(host.w, 'host.signin', { password: 'host-pw' });
  assert.equal((await run(host.w, 'stage.grant', { person_id: 'p1', on: true })).v.allowed, true);
  assert.deepEqual(host.s.grants, [['p1', true]]);
});

function turnsDoc({ notTurns = false } = {}) {
  const ids = {
    who: el('who', { textContent: 'Ana' }), upnext: el('upnext', { textContent: 'Up next Ben · Item 2' }), item: el('item', { textContent: 'Item 1' }),
    turnno: el('turnno', { textContent: 'Turn 1' }), timeleft: el('timeleft', { textContent: '1:00 left' }), chip: el('chip', { textContent: '3 here' }),
    next: el('next'), back: el('back'), pass: el('pass', { hidden: true }), restart: el('restart'), shuffle: el('shuffle'), note: el('note'), stagenote: el('stagenote'),
  };
  const b = { textContent: 'Ben' };
  const t60 = el('t60');
  const lis = [
    { classList: { contains: (c) => c === 'cur' }, querySelector: () => ({ textContent: 'Ana' }) },
    { classList: { contains: () => false }, querySelector: () => ({ textContent: 'Ben (you)' }) },
  ];
  ids.next.onclick = () => { ids.who.textContent = 'Ben'; };
  return {
    ids, t60,
    querySelector: (s) => {
      if (notTurns) return null;
      if (s === '#upnext b') return b;
      if (s === '#timers button[data-t="60"]') return t60;
      if (s.startsWith('#timers')) return null;
      return ids[s.slice(1)] || null;
    },
    querySelectorAll: (s) => (s === '#order li' ? lis : []),
  };
}

test('Take Turns: reads who is up and next, presses Next, refuses a hidden button and a bad timer', () => {
  const d = turnsDoc();
  globalThis.document = d;
  try {
    const st = turnsPageOp({ op: 'turns.state' }).v;
    assert.equal(st.up_now, 'Ana');
    assert.equal(st.up_next, 'Ben');
    assert.equal(st.time_left, '1:00 left');
    assert.deepEqual(st.order, [{ name: 'Ana', current: true }, { name: 'Ben (you)', current: false }]);
    assert.equal(turnsPageOp({ op: 'turns.next' }).v.up_now, 'Ben');
    assert.match(turnsPageOp({ op: 'turns.pass' }).error, /not available/);
    assert.match(turnsPageOp({ op: 'turns.timer', args: { seconds: 45 } }).error, /60, 120/);
    assert.equal(turnsPageOp({ op: 'turns.timer', args: { seconds: 60 } }).ok, true);
    assert.equal(d.t60.clicks, 1);
  } finally { delete globalThis.document; }
  globalThis.document = turnsDoc({ notTurns: true });
  try { assert.match(turnsPageOp({ op: 'turns.state' }).error, /not Take Turns/); }
  finally { delete globalThis.document; }
});

test('room tools: route to the bot seat, start Take Turns once, and never echo the host password', async () => {
  const { registerRoomTools } = await import('../../src/tools/room.js');
  const tools = {};
  const calls = [];
  let running = false;
  const bot = {
    async room(sid, op, args) {
      calls.push([sid, op]);
      if (op === 'app.state') return { running, name: running ? 'Take Turns' : '' };
      if (op === 'app.run') { running = true; return { started: 'Take Turns' }; }
      if (op === 'turns.state') return { up_now: 'Ana' };
      if (op === 'host.signin') throw new Error('Wrong password s3cret-host for this room.');
      return { op };
    },
  };
  const ok = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
  const guarded = (fn) => async (a) => { try { return await fn(a); } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; } };
  const ctx = { bot, ok, guarded, secrets: () => [], needLive: (id) => ({ meeting_id: id, session_id: 'w0:mt_1' }) };
  registerRoomTools({ registerTool: (n, d, fn) => { tools[n] = fn; } }, ctx, { name: 'gifos-meet-mcp' });
  assert.deepEqual(Object.keys(tools).sort(), ['get_agenda', 'list_apps', 'next_agenda_item', 'run_app', 'set_agenda', 'sign_in_as_host', 'stage', 'stop_app', 'take_turns']);
  const st = JSON.parse((await tools.take_turns({ meeting_id: 'm1', action: 'start' })).content[0].text);
  assert.equal(st.started, true);
  assert.equal(st.turns.up_now, 'Ana');
  const again = JSON.parse((await tools.take_turns({ meeting_id: 'm1', action: 'start' })).content[0].text);
  assert.equal(again.started, false, 'already running: not started twice');
  assert.equal(calls.filter((c) => c[1] === 'app.run').length, 1);
  assert.equal(calls[0][0], 'w0:mt_1');
  const bad = await tools.sign_in_as_host({ meeting_id: 'm1', host_password: 's3cret-host' });
  assert.equal(bad.isError, true);
  assert.equal(bad.content[0].text.includes('s3cret-host'), false);
  assert.match((await tools.stage({ meeting_id: 'm1', action: 'allow' })).content[0].text, /person_id/);
});
