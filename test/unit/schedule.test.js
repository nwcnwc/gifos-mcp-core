// Schedule store, recurrence, capacity, the clock, and the speech queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ScheduleStore, parseRRule, capacityAt, DEFAULT_SPAN_MS } from '../../src/schedule.js';
import { createClock } from '../../src/clock.js';
import { SpeechQueue } from '../../src/voice/queue.js';
import { serveHost } from '../../src/voice/host.js';
import { tmpHome } from './fixtures/tmp-home.js';

const ROOM = 'guest-ticket-9';
const LINK = 'https://gifos.app/run.html#room=room123';
const ADMIN = 'admin-must-not-land';

function homeDir() {
  return tmpHome('gifos-sched-');
}

function order(extra = {}) {
  return {
    link: LINK,
    room_password: ROOM,
    start: '2026-01-05T17:00:00.000Z',
    end: '2026-01-05T18:00:00.000Z',
    topic: 'Notes',
    ...extra,
  };
}

test('a one-off order stores the join password and never the admin password', () => {
  const home = homeDir();
  const store = new ScheduleStore(home);
  const { order: row } = store.add(order({ admin_password: ADMIN, end: undefined }));
  assert.equal(row.end_defaulted, true);
  assert.equal(Date.parse(row.end) - Date.parse(row.start), DEFAULT_SPAN_MS);
  assert.equal(row.room_password, ROOM);
  assert.equal(row.early_margin, 60000);
  const disk = fs.readFileSync(path.join(home, 'schedule.json'), 'utf8');
  assert.match(disk, new RegExp(ROOM));
  assert.equal(disk.includes(ADMIN), false);
  assert.equal(fs.statSync(path.join(home, 'schedule.json')).mode & 0o777, 0o600);
  const again = new ScheduleStore(home);
  assert.equal(again.passwordFor('room123'), ROOM);
  assert.equal(again.all()[0].admin_password, undefined);
});

test('an unknown recurrence rule is refused and not stored', () => {
  const store = new ScheduleStore(homeDir());
  assert.throws(() => store.add(order({ recurrence: 'every other blue moon' })), /cannot expand/);
  assert.equal(store.all().length, 0);
  assert.equal(parseRRule('FREQ=YEARLY').error, 'cannot expand');
});

test('a weekly rule expands in the order time zone', () => {
  const home = homeDir();
  const store = new ScheduleStore(home);
  const now = Date.parse('2026-01-05T16:00:00.000Z');
  const { order: series } = store.add(order({
    recurrence: 'RRULE:FREQ=WEEKLY;BYDAY=MO',
    timezone: 'America/Los_Angeles',
    start: '2026-01-05T17:00:00.000Z',
    end: '2026-01-05T18:00:00.000Z',
  }), now);
  assert.equal(series.phase, 'series');
  store.materialize(now, 8 * 24 * 60 * 60 * 1000);
  store.save();
  const kids = store.all().filter((o) => o.occurrence_id);
  assert.equal(kids.length, 2);
  assert.equal(kids[0].start, '2026-01-05T17:00:00.000Z');
  assert.equal(kids[1].start, '2026-01-12T17:00:00.000Z');
  assert.equal(kids[0].room_password, ROOM);
  assert.equal(kids[0].schedule_id, series.schedule_id);
});

test('an update with no occurrence changes the future series, and one occurrence stays put', () => {
  const store = new ScheduleStore(homeDir());
  const now = Date.parse('2026-01-05T16:00:00.000Z');
  const { order: series } = store.add(order({ recurrence: 'FREQ=DAILY', start: '2026-01-05T17:00:00.000Z', end: '2026-01-05T18:00:00.000Z' }), now);
  store.materialize(now, 3 * 24 * 60 * 60 * 1000);
  store.save();
  const kids = store.all().filter((o) => o.occurrence_id).sort((a, b) => a.start.localeCompare(b.start));
  assert.ok(kids.length >= 2);
  store.update(series.schedule_id, kids[0].occurrence_id, { topic: 'Only this one' }, now);
  assert.equal(store.get(kids[0].occurrence_id).topic, 'Only this one');
  store.update(series.schedule_id, undefined, { topic: 'The series' }, now);
  const future = store.all().filter((o) => o.occurrence_id && o.phase === 'upcoming');
  assert.ok(future.every((o) => o.topic === 'The series' || o.occurrence_id === kids[0].occurrence_id));
  assert.equal(store.get(kids[0].occurrence_id).topic, 'Only this one');
});

test('over capacity is stored, not rejected', () => {
  const store = new ScheduleStore(homeDir());
  store.add(order());
  store.add(order({ link: 'https://gifos.app/run.html#room=room456', start: '2026-01-05T17:30:00.000Z', end: '2026-01-05T18:30:00.000Z', topic: 'Review' }));
  const picture = capacityAt(store.all(), Date.parse('2026-01-05T17:30:00.000Z'), 1);
  assert.equal(picture.over_by, 1);
  assert.equal(picture.waiting.length, 1);
  assert.equal(store.all().length, 2);
});

function memoryMeetings() {
  const items = [];
  return {
    items,
    all() { return items; },
    get(id) { return items.find((m) => m.meeting_id === id) || null; },
    add(fields) {
      const m = { meeting_id: 'm_' + items.length, state: 'scheduled', session_id: null, topic: '', ...fields };
      items.push(m);
      return m;
    },
  };
}

test('the clock joins one minute early, joins late while end is ahead, and misses a closed window', async () => {
  const store = new ScheduleStore(homeDir());
  const meetings = memoryMeetings();
  const calls = [];
  const { order: row } = store.add(order());
  meetings.add({ meeting_id: 'm_fixed', room: 'room123', link: LINK, topic: 'Notes' });
  store.setPhase(row.schedule_id, { meeting_id: 'm_fixed' });
  const clock = createClock({
    schedule: store,
    meetings,
    cap: 2,
    near: 1,
    horizonMs: 24 * 60 * 60 * 1000,
    join: async (item) => {
      calls.push(['join', item.room_password]);
      const m = meetings.get(item.meeting_id);
      m.state = 'live';
      m.session_id = 's1';
      return m;
    },
    leave: async () => {},
    people: async () => [{ name: 'Ada', bot: false }],
  });
  const start = Date.parse(row.start);
  await clock.tick(start - 2 * 60 * 1000);
  assert.equal(calls.length, 0);
  await clock.tick(start - 30 * 1000);
  assert.deepEqual(calls, [['join', ROOM]]);
  assert.equal(store.get(row.schedule_id).phase, 'live');

  const lateHome = homeDir();
  const lateStore = new ScheduleStore(lateHome);
  const lateMeetings = memoryMeetings();
  const lateCalls = [];
  const late = lateStore.add(order({ start: '2026-01-06T17:00:00.000Z', end: '2026-01-06T18:00:00.000Z' })).order;
  const lateClock = createClock({
    schedule: lateStore,
    meetings: lateMeetings,
    cap: 2,
    near: 1,
    horizonMs: 24 * 60 * 60 * 1000,
    join: async (item) => {
      lateCalls.push(item.room_password);
      const m = lateMeetings.add({ room: item.room, state: 'live', session_id: 's' });
      return m;
    },
    leave: async () => {},
  });
  await lateClock.tick(Date.parse(late.start) + 10 * 60 * 1000);
  assert.deepEqual(lateCalls, [ROOM]);
  await lateClock.tick(Date.parse('2026-01-06T19:00:00.000Z'));
  const missed = lateStore.add(order({ start: '2026-01-07T17:00:00.000Z', end: '2026-01-07T18:00:00.000Z', topic: 'Gone' })).order;
  const before = lateCalls.length;
  await lateClock.tick(Date.parse(missed.end) + 1000);
  assert.equal(lateCalls.length, before);
  assert.equal(lateStore.get(missed.schedule_id).phase, 'missed');
  assert.equal(lateStore.get(missed.schedule_id).missed_reason, 'late');
});

test('after the scheduled end the bot leaves when the room is empty or quiet, and stays while people talk', async () => {
  async function run(people, lastHuman, nowOffset) {
    const store = new ScheduleStore(homeDir());
    const meetings = memoryMeetings();
    const reasons = [];
    const row = store.add(order()).order;
    const meeting = meetings.add({ meeting_id: 'm_live', room: 'room123', state: 'live', session_id: 's' });
    store.setPhase(row.schedule_id, { phase: 'live', meeting_id: meeting.meeting_id });
    const clock = createClock({
      schedule: store,
      meetings,
      cap: 2,
      near: 1,
      horizonMs: 60 * 60 * 1000,
      quietMs: 10 * 60 * 1000,
      join: async () => meeting,
      leave: async (_order, reason) => {
        reasons.push(reason);
        meeting.state = 'ended';
      },
      people: async () => people,
      lastHumanAt: () => lastHuman,
    });
    await clock.tick(Date.parse(row.end) + nowOffset);
    return { reasons, phase: store.get(row.schedule_id).phase };
  }
  const empty = await run([{ name: 'Bot', bot: true }], null, 0);
  assert.deepEqual(empty.reasons, ['empty']);
  const quiet = await run([{ name: 'Ada', bot: false }], Date.parse('2026-01-05T18:00:00.000Z') - 11 * 60 * 1000, 0);
  assert.deepEqual(quiet.reasons, ['quiet']);
  const stay = await run([{ name: 'Ada', bot: false }], Date.parse('2026-01-05T18:00:00.000Z') - 60 * 1000, 0);
  assert.deepEqual(stay.reasons, []);
  assert.equal(stay.phase, 'overrun');
});

test('speech and captions are queued per meeting, and thinking shows while a reply is composed', async () => {
  const seen = [];
  const queue = new SpeechQueue({ onThinking: (id, on) => seen.push(['think', id, on]) });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = queue.run('tts', { meetingId: 'm_a' }, async () => {
    seen.push('tts-a-start');
    await gate;
    seen.push('tts-a-end');
    return { role: 'tts' };
  });
  const second = queue.run('tts', { meetingId: 'm_b' }, async () => {
    seen.push('tts-b');
    return { role: 'tts' };
  });
  const captions = queue.run('stt', { meetingId: 'm_b' }, async () => ({ role: 'stt', text: 'hello' }));
  assert.equal(seen.includes('tts-b'), false, 'the second room waits for the first voice');
  const heard = await captions;
  assert.equal(heard.text, 'hello');
  assert.equal(heard.meetingId, 'm_b');
  release();
  await first;
  await second;
  assert.deepEqual(seen.filter((x) => x === 'tts-a-start' || x === 'tts-a-end' || x === 'tts-b'), ['tts-a-start', 'tts-a-end', 'tts-b']);

  let thinking = false;
  const marked = new SpeechQueue({ onThinking: (_id, on) => { thinking = on; } });
  let finish;
  const pending = marked.run('smartest', { meetingId: 'm_a' }, () => new Promise((resolve) => { finish = resolve; }));
  assert.equal(thinking, true);
  assert.equal(marked.isThinking('m_a'), true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(thinking, true);
  finish({ role: 'smartest', text: 'ok' });
  await pending;
  assert.equal(thinking, false);

  marked.leave('m_a');
  const dropped = await marked.run('tts', { meetingId: 'm_a' }, async () => ({ role: 'tts' }));
  assert.equal(dropped.dropped, true);

  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0);
  wav.write('WAVE', 8);
  const out = await serveHost({
    queue,
    tts: { url: 'http://127.0.0.1:9/voice' },
  }, 'tts', { meetingId: 'm_c', text: 'Hi' }, async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'audio/wav' },
    arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
  }));
  assert.equal(out.meetingId, 'm_c');
  assert.equal(out.role, 'tts');
});

// A save cut short (disk full, process killed mid-write) must not cost the
// calendar: the next start would read a torn file as no orders and the
// first tick would save that empty list over every room password.
test('a schedule save cut short keeps the last good schedule.json', () => {
  const home = homeDir();
  try {
    const store = new ScheduleStore(home);
    store.add(order());
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, text, opts) => {
      if (String(file).includes('schedule.json')) {
        write(file, String(text).slice(0, 20), opts);
        const e = new Error('ENOSPC: no space left on device');
        e.code = 'ENOSPC';
        throw e;
      }
      return write(file, text, opts);
    };
    try {
      assert.throws(() => store.add(order({ topic: 'Second' })), /ENOSPC/);
    } finally {
      fs.writeFileSync = write;
    }
    const again = new ScheduleStore(home);
    assert.equal(again.all().length, 1);
    assert.equal(again.all()[0].room_password, ROOM);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an unreadable schedule.json is kept aside, not overwritten by the next save', () => {
  const home = homeDir();
  try {
    const torn = '{"orders":[{"schedule_id":"s_1","room_password":"' + ROOM;
    fs.writeFileSync(path.join(home, 'schedule.json'), torn, { mode: 0o600 });
    const store = new ScheduleStore(home);
    assert.equal(store.all().length, 0);
    store.save();
    const kept = fs.readdirSync(home).filter((f) => f.startsWith('schedule.json.bad'));
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(home, kept[0]), 'utf8'), torn);
    assert.equal(fs.statSync(path.join(home, kept[0])).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a room that cannot be entered raises one meeting.error per order, not one every tick; a good join resets it', async () => {
  const store = new ScheduleStore(homeDir());
  const meetings = memoryMeetings();
  const events = [];
  let fail = true;
  const { order: row } = store.add(order());
  meetings.add({ meeting_id: 'm_fixed', room: 'room123', link: LINK, topic: 'Notes' });
  store.setPhase(row.schedule_id, { meeting_id: 'm_fixed' });
  // A meeting a lost worker dropped that no order brings back.
  meetings.add({ meeting_id: 'm_hand', room: 'room456', link: LINK, topic: 'Hand', reseat: true });
  const clock = createClock({
    schedule: store,
    meetings,
    cap: 4,
    near: 3,
    horizonMs: 24 * 60 * 60 * 1000,
    emit: (e) => events.push(e),
    join: async (item) => {
      if (fail) throw new Error('Meet Bot: the room did not open');
      const m = meetings.get(item.meeting_id);
      m.state = 'live';
      m.session_id = 's1';
      return m;
    },
    reseat: async () => { throw new Error('Meet Bot: the room did not open'); },
    leave: async () => {},
    people: async () => [{ name: 'Ada', bot: false }],
  });
  const errors = (id) => events.filter((e) => e.type === 'meeting.error' && e.meeting_id === id).length;
  const start = Date.parse(row.start);
  for (let i = 0; i < 3; i++) await clock.tick(start - 30 * 1000 + i * 15000);
  assert.equal(errors('m_fixed'), 1, 'one error for the order over 3 failed ticks');
  assert.equal(errors('m_hand'), 1, 'one error for the reseat over 3 failed ticks');

  fail = false;
  await clock.tick(start + 30 * 1000);
  assert.equal(store.get(row.schedule_id).phase, 'live');
  // The seat is lost again (worker died); the next failures are news once more.
  meetings.get('m_fixed').state = 'scheduled';
  fail = true;
  for (let i = 0; i < 3; i++) await clock.tick(start + 60 * 1000 + i * 15000);
  assert.equal(errors('m_fixed'), 2, 'one more error after the good join, not one per tick');
});

test('an order whose room cannot be entered raises one schedule.due, not one every tick', async () => {
  const store = new ScheduleStore(homeDir());
  const meetings = memoryMeetings();
  const events = [];
  let fail = true;
  const { order: row } = store.add(order());
  meetings.add({ meeting_id: 'm_fixed', room: 'room123', link: LINK, topic: 'Notes' });
  store.setPhase(row.schedule_id, { meeting_id: 'm_fixed' });
  const clock = createClock({
    schedule: store,
    meetings,
    cap: 4,
    near: 3,
    horizonMs: 24 * 60 * 60 * 1000,
    emit: (e) => events.push(e),
    join: async (item) => {
      if (fail) throw new Error('Meet Bot: the room did not open');
      const m = meetings.get(item.meeting_id);
      m.state = 'live';
      m.session_id = 's1';
      return m;
    },
    leave: async () => {},
    people: async () => [{ name: 'Ada', bot: false }],
  });
  const due = () => events.filter((e) => e.type === 'schedule.due' && e.meeting_id === 'm_fixed').length;
  const start = Date.parse(row.start);
  for (let i = 0; i < 3; i++) await clock.tick(start - 30 * 1000 + i * 15000);
  assert.equal(due(), 1, 'one schedule.due over 3 failed ticks');
  fail = false;
  await clock.tick(start + 30 * 1000);
  assert.equal(store.get(row.schedule_id).phase, 'live');
  assert.equal(due(), 1, 'the join that works is not due again');
});

test('an order moved to a new window after its room failed or it waited for capacity announces again in that window, and the clock forgets orders that are done', async () => {
  const store = new ScheduleStore(homeDir());
  const meetings = memoryMeetings();
  const events = [];
  const { order: failing } = store.add(order());
  meetings.add({ meeting_id: 'm_fail', room: 'room123', link: LINK, topic: 'Notes' });
  store.setPhase(failing.schedule_id, { meeting_id: 'm_fail' });
  const { order: full } = store.add(order({ link: 'https://gifos.app/run.html#room=room789' }));
  meetings.add({ meeting_id: 'm_full', room: 'room789', link: LINK, topic: 'Full' });
  store.setPhase(full.schedule_id, { meeting_id: 'm_full' });
  let seats = 0; // live meetings that are not ours fill the cap
  const clock = createClock({
    schedule: store,
    meetings,
    cap: 4,
    near: 3,
    horizonMs: 24 * 60 * 60 * 1000,
    emit: (e) => events.push(e),
    canSeat: () => seats < 1,
    join: async (item) => {
      if (item.meeting_id === 'm_fail') throw new Error('Meet Bot: the room did not open');
      seats++;
      throw Object.assign(new Error('no seat'), { code: 'no_seat' });
    },
    leave: async () => {},
    people: async () => [{ name: 'Ada', bot: false }],
  });
  const count = (type, id) => events.filter((e) => e.type === type && e.meeting_id === id).length;
  const start = Date.parse(failing.start);
  for (let i = 0; i < 2; i++) await clock.tick(start - 30 * 1000 + i * 15000);
  assert.equal(count('schedule.due', 'm_fail'), 1);
  assert.equal(count('meeting.error', 'm_fail'), 1);
  assert.equal(count('schedule.waiting', 'm_full'), 1);

  // Both are moved to the same hour tomorrow; that window is news again.
  const day = 24 * 60 * 60 * 1000;
  const later = (row) => ({ start: new Date(Date.parse(row.start) + day).toISOString(), end: new Date(Date.parse(row.end) + day).toISOString() });
  store.update(failing.schedule_id, null, later(failing), start);
  store.update(full.schedule_id, null, later(full), start);
  seats = 0; // the seat is free again when the new window opens
  for (let i = 0; i < 2; i++) await clock.tick(start + day - 30 * 1000 + i * 15000);
  assert.equal(count('schedule.due', 'm_fail'), 2, 'schedule.due again in the new window');
  assert.equal(count('meeting.error', 'm_fail'), 2, 'meeting.error again in the new window');
  assert.equal(count('schedule.waiting', 'm_full'), 2, 'schedule.waiting again in the new window');

  // Cancelled orders leave nothing behind in the clock.
  store.cancel(failing.schedule_id);
  store.cancel(full.schedule_id);
  await clock.tick(start + day + 60 * 1000);
  assert.equal(clock.held(), 0, 'no per-order keys kept for cancelled orders');
});
