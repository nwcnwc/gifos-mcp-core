// The schedule clock. One tick decides who joins, who waits, and who leaves.
// It does not read a calendar. Callers pass `now` so a test can move the clock.
import { QUIET_MS, briefOrder, capacityPicture, publicOrder, withInstructions } from './schedule.js';
import { readPrivate, writePrivate } from './private-file.js';
import { log } from './log.js';

function idKey(rows) {
  return (rows || []).map((row) => row.occurrence_id || row.schedule_id || row.meeting_id || '').join(',');
}

const CRASH_MS = 60 * 1000;
const CRASH_MAX_MS = 30 * 60 * 1000;

export function createClock(deps) {
  const quietMs = deps.quietMs > 0 ? deps.quietMs : QUIET_MS;
  const crashMs = deps.crashMs > 0 ? deps.crashMs : CRASH_MS;
  const seen = new Set();
  let booted = false;
  let timer = null;

  function emit(type, meetingId, data) {
    if (typeof deps.emit !== 'function') return null;
    return deps.emit({ type, meeting_id: meetingId || '', data: data || {} });
  }

  // A schedule.json save that fails (disk full) keeps the order in memory,
  // where setPhase already put it, and the tick goes on; the next save that
  // works writes it. Logged once until a save works, not once per tick.
  let saveFailing = false;
  function keep(write) {
    try {
      const out = write();
      saveFailing = false;
      return out;
    } catch (e) {
      if (!saveFailing) log('schedule.json not saved (' + e.message + '); orders are kept in memory until the next save.');
      saveFailing = true;
      return undefined;
    }
  }
  const setPhase = (id, fields) => keep(() => deps.schedule.setPhase(id, fields));

  // Orders that already announced their wait, so a wait is one event and
  // not one per tick. A seated order is taken off.
  const waited = new Set();
  const orderKey = (order) => order.occurrence_id || order.schedule_id;
  // What an order already announced holds for its window only: one moved
  // to a new window announces again there.
  const noteKey = (order) => orderKey(order) + '@' + order.start + '/' + order.end;
  const isNoSeat = (e) => !!(e && e.code === 'no_seat');

  // A failed leave keeps the room live for the next tick. It is one
  // meeting.error per order until a leave works, and never stops the tick.
  const leaveFailed = new Set();
  async function leave(order, reason) {
    const key = noteKey(order);
    try {
      await deps.leave(order, reason);
      leaveFailed.delete(key);
    } catch (e) {
      if (leaveFailed.has(key)) return;
      leaveFailed.add(key);
      emit('meeting.error', order.meeting_id, { text: 'The room could not be left; trying again.' });
    }
  }

  // A room whose join took down the workers it reached (stage B) is not
  // joined again until its wait is over: one minute, doubling to 30. Joining
  // it every tick would drop every other meeting on those workers each time.
  // Keyed by room, so a start_meeting by hand waits on the same clock.
  // Kept in deps.crashFile, so a supervisor restarted within the wait does
  // not walk straight back in.
  const crashed = new Map(); // room -> { count, at }
  if (deps.crashFile) {
    const saved = readPrivate(deps.crashFile, 'starting with no crash waits', (x) => x && typeof x.rooms === 'object');
    for (const [room, row] of Object.entries((saved && saved.rooms) || {})) {
      if (row && row.count > 0 && Number.isFinite(row.at)) crashed.set(room, { count: row.count, at: row.at });
    }
  }
  function saveCrashes() {
    if (!deps.crashFile) return;
    // A save that fails keeps the wait in memory; the tick goes on.
    try { writePrivate(deps.crashFile, JSON.stringify({ rooms: Object.fromEntries(crashed) }, null, 2) + '\n'); } catch (e) { log('crash waits not saved: ' + e.message); }
  }
  function crashCleared(room) {
    if (crashed.delete(room)) saveCrashes();
  }
  const crashLeft = (room, now) => (crashed.has(room) ? Math.max(0, crashed.get(room).at - now) : 0);
  const crashWaits = (room, now) => crashLeft(room, now) > 0;
  function crashFound(room, now) {
    const count = (crashed.has(room) ? crashed.get(room).count : 0) + 1;
    const ms = Math.min(CRASH_MAX_MS, crashMs * 2 ** (count - 1));
    crashed.set(room, { count, at: now + ms });
    saveCrashes();
    return ms;
  }
  // A room that cannot be entered (not a crash, not a full pool) is one
  // meeting.error per order or reseat until a join works, not one per tick.
  const enterFailed = new Set();
  // schedule.due is once per order too, not once per retry tick.
  const dueSent = new Set();
  function joinFailed(key, room, meetingId, e, now) {
    if (!(e && e.code === 'worker_died')) {
      if (enterFailed.has(key)) return;
      enterFailed.add(key);
      emit('meeting.error', meetingId, { text: 'The room could not be entered; trying again.' });
      return;
    }
    const ms = crashFound(room, now);
    emit('meeting.error', meetingId, { text: 'The room crashed the bot; trying again in ' + Math.ceil(ms / 60000) + ' min.', retry_in_ms: ms });
  }

  // 'capacity' when the cap is reached, 'worker' when every worker is full
  // or waiting out a restart (stage B), otherwise ''.
  function fullReason() {
    if (deps.meetings.all().filter((m) => m.state === 'live').length >= deps.cap) return 'capacity';
    if (typeof deps.canSeat === 'function' && !deps.canSeat()) return 'worker';
    return '';
  }

  // An order that cannot be seated now. One still before its window's end
  // waits for capacity and is missed for capacity if no seat frees. A live
  // or overrun order that lost its seat keeps its phase and rejoins later.
  function wait(order, reason) {
    const key = noteKey(order);
    const phase = order.phase;
    if (phase === 'upcoming') setPhase(orderKey(order), { phase: 'waiting_for_capacity' });
    if (waited.has(key) || phase === 'waiting_for_capacity') return;
    waited.add(key);
    emit('schedule.waiting', order.meeting_id, { ...briefOrder(deps.schedule.get(key) || order), reason });
  }

  function emitCapacity(now, force) {
    const picture = capacityPicture({
      orders: deps.schedule.all(),
      liveMeetings: deps.meetings.all().filter((m) => m.state === 'live').map((m) => ({ meeting_id: m.meeting_id, topic: m.topic || '' })),
      cap: deps.cap,
      near: deps.near,
      now,
      horizonMs: deps.horizonMs,
    });
    const alerts = [];
    if (picture.live.level !== 'ok') {
      alerts.push({
        when: 'live',
        level: picture.live.level,
        at: new Date(now).toISOString(),
        seated: picture.live.seated,
        affected: picture.live.affected,
        waiting: picture.live.waiting,
      });
    }
    for (const row of picture.upcoming) {
      alerts.push({
        when: 'scheduled',
        level: row.level,
        at: row.at,
        seated: row.seated,
        affected: row.affected,
        waiting: row.waiting,
      });
    }
    const keys = new Set(alerts.map((row) => [row.when, row.level, row.at, idKey(row.affected), idKey(row.waiting)].join('|')));
    if (!alerts.length) {
      if (booted && seen.size) {
        emit('capacity.cleared', '', { when: 'live', at: new Date(now).toISOString(), cap: deps.cap, near: deps.near, seated: picture.live.seated, affected: [], waiting: [] });
      }
      seen.clear();
      booted = true;
      return picture;
    }
    for (const row of alerts) {
      const key = [row.when, row.level, row.at, idKey(row.affected), idKey(row.waiting)].join('|');
      if (!force && seen.has(key)) continue;
      const type = row.level === 'reached' ? 'capacity.reached' : 'capacity.near';
      emit(type, '', {
        when: row.when,
        at: row.at,
        cap: deps.cap,
        near: deps.near,
        seated: row.seated,
        affected: row.affected,
        waiting: row.waiting,
      });
      seen.add(key);
    }
    for (const key of [...seen]) if (!keys.has(key)) seen.delete(key);
    booted = true;
    return picture;
  }

  async function tick(now = Date.now()) {
    deps.schedule.materialize(now, deps.horizonMs);
    keep(() => deps.schedule.save());
    const orders = deps.schedule.all().filter((o) => o.phase !== 'series' && o.phase !== 'cancelled' && o.phase !== 'ended' && o.phase !== 'missed' && o.phase !== 'left_early');
    for (const order of orders) {
      const start = Date.parse(order.start);
      const end = Date.parse(order.end);
      const joinAt = start - (order.early_margin == null ? 60000 : order.early_margin);
      const meeting = order.meeting_id ? deps.meetings.get(order.meeting_id) : null;
      const seated = meeting && meeting.state === 'live';
      if ((order.phase === 'upcoming' || order.phase === 'waiting_for_capacity') && now >= end) {
        const reason = order.phase === 'waiting_for_capacity' ? 'capacity' : 'late';
        crashCleared(order.room);
        enterFailed.delete(noteKey(order));
        dueSent.delete(noteKey(order));
        setPhase(order.occurrence_id || order.schedule_id, { phase: 'missed', missed_reason: reason });
        emit('schedule.missed', order.meeting_id, { ...briefOrder(order), reason });
        continue;
      }
      if ((order.phase === 'upcoming' || order.phase === 'waiting_for_capacity') && now >= joinAt && now < end) {
        if (crashWaits(order.room, now)) continue;
        const full = fullReason();
        if (full) {
          wait(order, full);
          continue;
        }
        if (!dueSent.has(noteKey(order))) {
          dueSent.add(noteKey(order));
          // An agent woken by this event learns what the meeting is for.
          emit('schedule.due', order.meeting_id, withInstructions(briefOrder(order), order.instructions));
        }
        try {
          const joined = await deps.join(order);
          if (!joined || joined.state !== 'live') continue; // ended while joining
          waited.delete(noteKey(order));
          enterFailed.delete(noteKey(order));
          dueSent.delete(noteKey(order));
          crashCleared(order.room);
          setPhase(order.occurrence_id || order.schedule_id, { phase: 'live', meeting_id: joined.meeting_id });
          emit('meeting.joined', joined.meeting_id, withInstructions({ topic: order.topic, link: order.link, state: 'live', schedule_id: order.schedule_id }, order.instructions));
        } catch (e) {
          if (isNoSeat(e)) wait(order, 'worker');
          else joinFailed(noteKey(order), order.room, order.meeting_id, e, now);
        }
        continue;
      }
      const restarted = (order.phase === 'live' || order.phase === 'overrun') && !seated;
      if (restarted) {
        if (crashWaits(order.room, now)) continue;
        const full = fullReason();
        if (full) {
          wait(order, full);
          continue;
        }
        try {
          const joined = await deps.join(order);
          if (!joined || joined.state !== 'live') continue; // ended while joining
          waited.delete(noteKey(order));
          enterFailed.delete(noteKey(order));
          crashCleared(order.room);
          setPhase(order.occurrence_id || order.schedule_id, { phase: now >= end ? 'overrun' : 'live', meeting_id: joined.meeting_id, overrun_at: now >= end ? new Date(now).toISOString() : '' });
          emit('meeting.joined', joined.meeting_id, withInstructions({ topic: order.topic, link: order.link, state: 'live', schedule_id: order.schedule_id }, order.instructions));
        } catch (e) {
          if (isNoSeat(e)) wait(order, 'worker');
          else joinFailed(noteKey(order), order.room, order.meeting_id, e, now);
        }
      }
      const fresh = deps.schedule.get(order.occurrence_id || order.schedule_id) || order;
      const freshMeeting = fresh.meeting_id ? deps.meetings.get(fresh.meeting_id) : meeting;
      if ((fresh.phase === 'live' || fresh.phase === 'overrun') && freshMeeting && freshMeeting.state === 'live' && now >= end) {
        if (fresh.phase !== 'overrun') {
          setPhase(fresh.occurrence_id || fresh.schedule_id, { phase: 'overrun', overrun_at: fresh.overrun_at || new Date(now).toISOString() });
          emit('schedule.overrun', fresh.meeting_id, { ...briefOrder(fresh), overrun_quiet_minutes: quietMs / 60000 });
        }
        const current = deps.schedule.get(fresh.occurrence_id || fresh.schedule_id) || fresh;
        let humans = null;
        if (typeof deps.people === 'function') {
          try { humans = await deps.people(freshMeeting); } catch (e) { humans = null; }
        }
        const humanCount = Array.isArray(humans) ? humans.filter((p) => !p.bot).length : null;
        if (humanCount === 0) {
          await leave(current, 'empty');
          continue;
        }
        const last = typeof deps.lastHumanAt === 'function' ? deps.lastHumanAt(freshMeeting.meeting_id) : null;
        const since = last != null ? last : Date.parse(current.overrun_at || new Date(now).toISOString());
        if (now - since >= quietMs) await leave(current, 'quiet');
      }
    }
    // Meetings a lost worker dropped that no order will bring back.
    if (typeof deps.reseat === 'function') {
      for (const m of deps.meetings.all()) {
        if (!m.reseat || m.state !== 'scheduled' || deps.schedule.forMeeting(m.meeting_id)) continue;
        if (crashWaits(m.room, now)) continue;
        // meeting.disconnected already told the owner; no seat is a quiet wait.
        if (fullReason()) break;
        try {
          const joined = await deps.reseat(m);
          if (!joined || joined.state !== 'live') continue; // ended while joining
          enterFailed.delete('m:' + m.meeting_id);
          crashCleared(m.room);
          emit('meeting.joined', joined.meeting_id, { topic: joined.topic, link: joined.link, state: 'live', reason: 'worker' });
        } catch (e) {
          if (!isNoSeat(e)) joinFailed('m:' + m.meeting_id, m.room, m.meeting_id, e, now);
        }
      }
    }
    forgetDone();
    return emitCapacity(now, !booted);
  }

  // Keys of orders that are done (cancelled, ended, missed, moved) and of
  // reseats that are over, so a long-lived clock does not keep them all.
  const notes = [waited, leaveFailed, enterFailed, dueSent];
  function forgetDone() {
    const open = new Set();
    for (const o of deps.schedule.all()) {
      if (o.phase !== 'series' && o.phase !== 'cancelled' && o.phase !== 'ended' && o.phase !== 'missed' && o.phase !== 'left_early') open.add(noteKey(o));
    }
    for (const m of deps.meetings.all()) if (m.reseat && m.state === 'scheduled') open.add('m:' + m.meeting_id);
    for (const set of notes) for (const key of [...set]) if (!open.has(key)) set.delete(key);
  }

  return {
    tick,
    // How many per-order notes the clock holds (tests: nothing leaks).
    held: () => notes.reduce((n, set) => n + set.size, 0),
    emitCapacity,
    // For joins by hand: ms until a room that crashed the bot may be tried,
    // record a new crash (returns its wait), forget it after a good join.
    crashLeft,
    crashFound,
    crashCleared,
    picture(now = Date.now()) {
      return capacityPicture({
        orders: deps.schedule.all(),
        liveMeetings: deps.meetings.all().filter((m) => m.state === 'live').map((m) => ({ meeting_id: m.meeting_id, topic: m.topic || '' })),
        cap: deps.cap,
        near: deps.near,
        now,
        horizonMs: deps.horizonMs,
      });
    },
    start(ms = 15000) {
      if (timer) return timer;
      // A join can outlast the interval; skip a tick while the last one runs.
      let running = false;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        tick().catch((e) => log('clock tick failed: ' + ((e && e.message) || e))).finally(() => { running = false; });
      }, ms);
      if (timer.unref) timer.unref();
      return timer;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    publicOrder,
  };
}
