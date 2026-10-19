// The company calendar. Each order keeps the join (room) password so a
// restart can enter the room. The admin password is never a field here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { roomFromLink } from './meetings.js';
import { plainLink } from './invite.js';
import { readPrivate, writePrivate } from './private-file.js';

export const QUIET_MS = 10 * 60 * 1000;
export const DEFAULT_SPAN_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_EARLY_MS = 60 * 1000;
export const DEFAULT_HORIZON_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CAP = 4;
// The owner's goal and instructions for one meeting (a check-in's questions,
// say). Plain text kept for the agent that drives the bot; this server never
// runs it. Empty means the default: transcribe only.
export const INSTRUCTIONS_MAX = 4000;

export function cleanInstructions(text) {
  if (text == null) return '';
  if (typeof text !== 'string') throw new Error('instructions must be text.');
  const out = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (out.length > INSTRUCTIONS_MAX) throw new Error('instructions must be at most ' + INSTRUCTIONS_MAX + ' characters.');
  return out;
}

// Only rows that have instructions carry the field, so a meeting without
// them looks exactly as before.
export function withInstructions(row, instructions) {
  return instructions ? { ...row, instructions } : row;
}

const DAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const OPEN = new Set(['upcoming', 'waiting_for_capacity', 'live', 'overrun']);

function pad(n) { return String(n).padStart(2, '0'); }

export function assertZone(tz) {
  const name = String(tz || 'UTC');
  try {
    Intl.DateTimeFormat('en-US', { timeZone: name }).format(0);
  } catch (e) {
    throw new Error('Unknown time zone ' + JSON.stringify(name) + '.');
  }
  return name;
}

export function zonedParts(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const map = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour === '24' ? '0' : map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WD[map.weekday],
  };
}

export function utcFromZoned(y, m, d, hh, mm, ss, timeZone) {
  let utc = Date.UTC(y, m - 1, d, hh, mm, ss);
  for (let i = 0; i < 4; i++) {
    const p = zonedParts(utc, timeZone);
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const want = Date.UTC(y, m - 1, d, hh, mm, ss);
    if (got === want) return utc;
    utc += want - got;
  }
  return utc;
}

function dayNumber(y, m, d) {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function parseIcalUtc(text) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(text || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

export function parseRRule(rule) {
  const raw = String(rule || '').trim();
  if (!raw) return null;
  const body = raw.replace(/^RRULE:/i, '');
  const parts = {};
  for (const bit of body.split(';')) {
    if (!bit) continue;
    const i = bit.indexOf('=');
    if (i <= 0) return { error: 'cannot expand' };
    parts[bit.slice(0, i).toUpperCase()] = bit.slice(i + 1);
  }
  const known = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL']);
  if (Object.keys(parts).some((k) => !known.has(k))) return { error: 'cannot expand' };
  const freq = parts.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return { error: 'cannot expand' };
  const interval = parts.INTERVAL == null ? 1 : Number(parts.INTERVAL);
  if (!Number.isInteger(interval) || interval < 1) return { error: 'cannot expand' };
  let byday = null;
  if (parts.BYDAY) {
    byday = parts.BYDAY.split(',');
    if (!byday.length || byday.some((d) => DAY[d] == null)) return { error: 'cannot expand' };
    byday = byday.map((d) => DAY[d]);
  }
  let count = null;
  if (parts.COUNT != null) {
    count = Number(parts.COUNT);
    if (!Number.isInteger(count) || count < 1) return { error: 'cannot expand' };
  }
  let until = null;
  if (parts.UNTIL != null) {
    until = parseIcalUtc(parts.UNTIL);
    if (until == null) return { error: 'cannot expand' };
  }
  return { freq, interval, byday, count, until };
}

export function expandRule(series, parsed, now, horizonEnd) {
  const start0 = Date.parse(series.start);
  const end0 = Date.parse(series.end);
  const duration = end0 - start0;
  const zone = series.timezone || 'UTC';
  const first = zonedParts(start0, zone);
  const byday = parsed.byday || [first.weekday];
  const slots = [];
  let made = 0;
  const limit = parsed.count || 400;
  let cursor = { y: first.year, m: first.month, d: first.day };
  for (let n = 0; n < 800 && made < limit; n++) {
    const probe = zonedParts(utcFromZoned(cursor.y, cursor.m, cursor.d, 12, 0, 0, zone), zone);
    const days = dayNumber(cursor.y, cursor.m, cursor.d) - dayNumber(first.year, first.month, first.day);
    let hit = false;
    if (parsed.freq === 'DAILY') hit = days % parsed.interval === 0;
    else if (parsed.freq === 'WEEKLY') hit = byday.includes(probe.weekday) && Math.floor(days / 7) % parsed.interval === 0;
    else if (parsed.freq === 'MONTHLY') {
      const months = (cursor.y - first.year) * 12 + (cursor.m - first.month);
      hit = cursor.d === first.day && months % parsed.interval === 0;
    }
    if (hit) {
      const slotStart = utcFromZoned(cursor.y, cursor.m, cursor.d, first.hour, first.minute, first.second, zone);
      if (parsed.until != null && slotStart > parsed.until) break;
      made++;
      const slotEnd = slotStart + duration;
      if (slotEnd > now && slotStart < horizonEnd) {
        slots.push({
          key: cursor.y + '-' + pad(cursor.m) + '-' + pad(cursor.d),
          start: new Date(slotStart).toISOString(),
          end: new Date(slotEnd).toISOString(),
        });
      }
    }
    if (utcFromZoned(cursor.y, cursor.m, cursor.d, 0, 0, 0, zone) > horizonEnd + 86400000 && made > 0) break;
    cursor = addDays(cursor.y, cursor.m, cursor.d, 1);
  }
  return slots;
}

export function publicOrder(order) {
  if (!order) return null;
  return withInstructions({
    schedule_id: order.schedule_id,
    occurrence_id: order.occurrence_id || '',
    series_id: order.series_id || '',
    meeting_id: order.meeting_id || '',
    topic: order.topic || '',
    link: order.link,
    start: order.start,
    end: order.end,
    end_defaulted: !!order.end_defaulted,
    timezone: order.timezone || 'UTC',
    early_margin: order.early_margin,
    recurrence: order.recurrence || '',
    phase: order.phase,
    external_id: order.external_id || '',
    missed_reason: order.missed_reason || '',
  }, order.instructions || '');
}

export function briefOrder(order) {
  const row = publicOrder(order);
  return {
    schedule_id: row.schedule_id,
    occurrence_id: row.occurrence_id,
    meeting_id: row.meeting_id,
    topic: row.topic,
    phase: row.phase,
    start: row.start,
    end: row.end,
  };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function concreteOrders(orders) {
  return orders.filter((o) => o.phase !== 'series');
}

export function coveringAt(orders, at) {
  return concreteOrders(orders).filter((o) => OPEN.has(o.phase) && Date.parse(o.start) <= at && at < Date.parse(o.end));
}

export function splitCap(orders, cap) {
  const sorted = orders.slice().sort((a, b) => (a.start || '').localeCompare(b.start || '') || a.schedule_id.localeCompare(b.schedule_id));
  return { affected: sorted.slice(0, cap), waiting: sorted.slice(cap) };
}

export function levelFor(seated, cap, near) {
  if (seated >= cap) return 'reached';
  if (near > 0 && seated >= near) return 'near';
  return 'ok';
}

export function capacityAt(orders, at, cap) {
  const covering = coveringAt(orders, at);
  const overBy = Math.max(0, covering.length - cap);
  const parts = splitCap(covering, cap);
  return {
    cap,
    seated_at_start: Math.min(covering.length, cap),
    over_by: overBy,
    affected: parts.affected.map(briefOrder),
    waiting: parts.waiting.map(briefOrder),
  };
}

function worse(a, b) {
  const rank = { ok: 0, near: 1, reached: 2 };
  return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
}

export function capacityPicture({ orders, liveMeetings, cap, near, now, horizonMs }) {
  const live = liveMeetings || [];
  const waitingNow = orders.filter((o) => o.phase === 'waiting_for_capacity');
  const liveLevel = levelFor(live.length, cap, near);
  const upcoming = [];
  const instants = [...new Set(concreteOrders(orders).filter((o) => OPEN.has(o.phase)).map((o) => Date.parse(o.start)))]
    .filter((at) => at > now && at <= now + horizonMs)
    .sort((a, b) => a - b);
  let ahead = 'ok';
  for (const at of instants) {
    const covering = coveringAt(orders, at);
    const lv = levelFor(covering.length, cap, near);
    if (lv === 'ok') continue;
    ahead = worse(ahead, lv);
    const parts = splitCap(covering, cap);
    upcoming.push({
      at: new Date(at).toISOString(),
      level: lv,
      cap,
      near,
      seated: covering.length,
      affected: parts.affected.map(briefOrder),
      waiting: parts.waiting.map(briefOrder),
    });
  }
  return {
    level: worse(liveLevel, ahead),
    cap,
    near,
    live: {
      seated: live.length,
      level: liveLevel,
      affected: live.map((m) => ({ meeting_id: m.meeting_id, topic: m.topic || '', phase: 'live' })),
      waiting: waitingNow.map(briefOrder),
    },
    upcoming,
  };
}

function iso(ms) { return new Date(ms).toISOString(); }

export class ScheduleStore {
  constructor(home) {
    this.home = home;
    this.file = path.join(home, 'schedule.json');
    // It may still hold the only copy of the room passwords.
    const saved = readPrivate(this.file, 'starting with no orders', (x) => x && Array.isArray(x.orders || []));
    this.items = ((saved && saved.orders) || []).map(stripAdmin);
  }

  save() {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const orders = this.items.map(stripAdmin);
    writePrivate(this.file, JSON.stringify({ orders }, null, 2) + '\n');
  }

  all() { return this.items.slice(); }

  get(id) {
    return this.items.find((o) => o.schedule_id === id || o.occurrence_id === id) || null;
  }

  forMeeting(meetingId) {
    return this.items.find((o) => o.meeting_id === meetingId && o.phase !== 'series' && OPEN.has(o.phase)) || null;
  }

  passwordFor(room) {
    const rows = this.items.filter((o) => o.room === room && o.room_password && o.phase !== 'cancelled' && o.phase !== 'series');
    const live = rows.find((o) => o.phase === 'live' || o.phase === 'overrun');
    if (live) return live.room_password;
    rows.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    return (rows[0] && rows[0].room_password) || '';
  }

  add(input, now = Date.now()) {
    const order = buildOrder(input, now);
    const rule = order.recurrence ? parseRRule(order.recurrence) : null;
    if (rule && rule.error) throw new Error('This process cannot expand that recurrence rule.');
    const existingId = input.external_id && this.items.find((o) => o.external_id === input.external_id && o.phase !== 'cancelled');
    if (existingId && !existingId.occurrence_id) {
      return this.applyPatch(existingId, input, now);
    }
    const start = Date.parse(order.start);
    const end = Date.parse(order.end);
    const dup = this.items.find((o) => o.room === order.room && o.phase !== 'cancelled' && o.phase !== 'missed' && o.phase !== 'ended' && o.phase !== 'left_early'
      && overlaps(Date.parse(o.start), Date.parse(o.end), start, end));
    if (dup) {
      if (order.room_password) dup.room_password = order.room_password;
      if (order.topic) dup.topic = order.topic;
      if (order.instructions) dup.instructions = order.instructions;
      this.save();
      return { order: dup, duplicate: true };
    }
    this.items.push(order);
    if (rule) {
      order.phase = 'series';
      this.materialize(now, DEFAULT_HORIZON_MS);
    }
    this.save();
    return { order, duplicate: false };
  }

  materialize(now, horizonMs) {
    const horizonEnd = now + horizonMs;
    for (const series of this.items.filter((o) => o.phase === 'series')) {
      const parsed = parseRRule(series.recurrence);
      if (!parsed || parsed.error) continue;
      const exceptions = series.exceptions || [];
      for (const slot of expandRule(series, parsed, now, horizonEnd)) {
        const occurrenceId = series.schedule_id + ':' + slot.key;
        const exception = exceptions.find((ex) => ex.occurrence_id === occurrenceId);
        if (exception && exception.skip) continue;
        const found = this.items.find((o) => o.occurrence_id === occurrenceId);
        if (found) continue;
        this.items.push(childOrder(series, occurrenceId, exception || slot));
      }
    }
  }

  applyPatch(order, patch, now) {
    const next = { ...patch };
    delete next.admin_password;
    delete next.password;
    if (next.start || next.end) {
      const start = Date.parse(next.start || order.start);
      let end;
      let endDefaulted = order.end_defaulted;
      if (next.end) {
        end = Date.parse(next.end);
        endDefaulted = false;
      } else if (next.start && !next.end) {
        end = start + (Date.parse(order.end) - Date.parse(order.start));
      } else end = Date.parse(order.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('end must be after start.');
      order.start = iso(start);
      order.end = iso(end);
      order.end_defaulted = endDefaulted;
      // Its wait was for the old window; the new one has not been tried.
      if (order.phase === 'waiting_for_capacity') order.phase = 'upcoming';
    }
    if (next.topic) order.topic = String(next.topic);
    // '' clears them: the meeting goes back to transcribe only.
    if (next.instructions != null) order.instructions = cleanInstructions(next.instructions);
    if (next.room_password) order.room_password = String(next.room_password);
    if (next.timezone) order.timezone = assertZone(next.timezone);
    if (next.early_margin != null) order.early_margin = Number(next.early_margin);
    if (next.recurrence != null) {
      const parsed = next.recurrence ? parseRRule(next.recurrence) : null;
      if (parsed && parsed.error) throw new Error('This process cannot expand that recurrence rule.');
      order.recurrence = String(next.recurrence || '');
      if (order.recurrence) order.phase = 'series';
    }
    if (order.phase === 'series') {
      this.items = this.items.filter((o) => o.series_id !== order.schedule_id || (o.phase !== 'upcoming' && o.phase !== 'waiting_for_capacity'));
      this.materialize(now, DEFAULT_HORIZON_MS);
    }
    this.save();
    return { order, duplicate: true, updated: true };
  }

  update(scheduleId, occurrence, patch, now = Date.now()) {
    const target = this.get(scheduleId);
    if (!target) throw new Error('Unknown schedule_id ' + JSON.stringify(scheduleId) + '.');
    if (occurrence) {
      const row = this.items.find((o) => o.occurrence_id === occurrence || (o.schedule_id === scheduleId && o.occurrence_id === occurrence));
      const series = target.phase === 'series' ? target : this.items.find((o) => o.schedule_id === target.series_id && o.phase === 'series');
      if (!row) throw new Error('Unknown occurrence ' + JSON.stringify(occurrence) + '.');
      const done = this.applyPatch(row, patch, now);
      if (series) {
        series.exceptions = series.exceptions || [];
        const ex = { occurrence_id: row.occurrence_id, start: row.start, end: row.end, topic: row.topic };
        const at = series.exceptions.findIndex((item) => item.occurrence_id === row.occurrence_id);
        const before = at >= 0 ? series.exceptions[at] : null;
        if (patch.instructions != null) ex.instructions = row.instructions;
        else if (before && before.instructions != null) ex.instructions = before.instructions;
        if (at >= 0) series.exceptions[at] = ex;
        else series.exceptions.push(ex);
        this.save();
      }
      return done.order;
    }
    const series = target.phase === 'series' ? target : (target.series_id ? this.get(target.series_id) : null);
    if (series && series.phase === 'series' && series !== target && !target.occurrence_id) {
      return this.applyPatch(series, patch, now).order;
    }
    if (target.phase === 'series' || (target.recurrence && !target.occurrence_id)) {
      return this.applyPatch(target.phase === 'series' ? target : target, patch, now).order;
    }
    return this.applyPatch(target, patch, now).order;
  }

  cancel(scheduleId, occurrence, now = Date.now()) {
    const target = this.get(scheduleId);
    if (!target) throw new Error('Unknown schedule_id ' + JSON.stringify(scheduleId) + '.');
    const touched = [];
    const mark = (row) => {
      if (!row || row.phase === 'cancelled' || row.phase === 'ended' || row.phase === 'missed') return;
      row.phase = 'cancelled';
      touched.push(row);
    };
    if (occurrence) {
      const row = this.items.find((o) => o.occurrence_id === occurrence);
      if (!row) throw new Error('Unknown occurrence ' + JSON.stringify(occurrence) + '.');
      mark(row);
      const series = this.items.find((o) => o.schedule_id === row.series_id && o.phase === 'series');
      if (series) {
        series.exceptions = series.exceptions || [];
        series.exceptions.push({ occurrence_id: occurrence, skip: true });
      }
    } else if (target.phase === 'series') {
      mark(target);
      for (const row of this.items) {
        if (row.series_id === target.schedule_id && (row.phase === 'upcoming' || row.phase === 'waiting_for_capacity')) mark(row);
      }
    } else {
      mark(target);
    }
    this.save();
    return touched;
  }

  setPhase(id, fields) {
    const row = this.get(id) || this.items.find((o) => o.meeting_id === id && OPEN.has(o.phase));
    if (!row) return null;
    Object.assign(row, fields);
    delete row.admin_password;
    this.save();
    return row;
  }
}

function stripAdmin(order) {
  const out = { ...order };
  delete out.admin_password;
  delete out.password;
  return out;
}

function buildOrder(input, now) {
  if (!input || !input.link) throw new Error('schedule_meeting needs a GifOS meeting link.');
  const room = input.room || roomFromLink(input.link);
  if (!room) throw new Error('That is not a GifOS meeting link.');
  const roomPassword = String(input.room_password || '');
  if (!roomPassword) throw new Error('schedule_meeting needs the room password.');
  const link = plainLink(input.link, roomPassword);
  if (!input.start) throw new Error('schedule_meeting needs a start time.');
  const start = Date.parse(input.start);
  if (!Number.isFinite(start)) throw new Error('start must be a time.');
  let end;
  let endDefaulted = false;
  if (input.end) {
    end = Date.parse(input.end);
    if (!Number.isFinite(end)) throw new Error('end must be a time.');
  } else {
    end = start + DEFAULT_SPAN_MS;
    endDefaulted = true;
  }
  if (end <= start) throw new Error('end must be after start.');
  const timezone = assertZone(input.timezone || 'UTC');
  const early = input.early_margin == null ? DEFAULT_EARLY_MS : Number(input.early_margin);
  if (!Number.isFinite(early) || early < 0) throw new Error('early_margin must be a number of milliseconds.');
  const recurrence = String(input.recurrence || '');
  const instructions = cleanInstructions(input.instructions);
  return stripAdmin({
    schedule_id: 'sch_' + crypto.randomBytes(5).toString('hex'),
    occurrence_id: '',
    series_id: '',
    meeting_id: input.meeting_id || '',
    topic: String(input.topic || ''),
    link,
    room,
    start: iso(start),
    end: iso(end),
    end_defaulted: endDefaulted,
    timezone,
    early_margin: early,
    recurrence,
    phase: 'upcoming',
    external_id: String(input.external_id || ''),
    room_password: roomPassword,
    missed_reason: '',
    exceptions: [],
    created_at: iso(now),
    ...(instructions ? { instructions } : {}),
  });
}

function childOrder(series, occurrenceId, slot) {
  return stripAdmin({
    schedule_id: series.schedule_id,
    occurrence_id: occurrenceId,
    series_id: series.schedule_id,
    meeting_id: '',
    topic: slot.topic || series.topic,
    link: series.link,
    room: series.room,
    start: slot.start,
    end: slot.end,
    end_defaulted: series.end_defaulted,
    timezone: series.timezone,
    early_margin: series.early_margin,
    recurrence: '',
    phase: 'upcoming',
    external_id: series.external_id,
    room_password: series.room_password,
    missed_reason: '',
    exceptions: [],
    created_at: new Date().toISOString(),
    ...(childInstructions(series, slot) ? { instructions: childInstructions(series, slot) } : {}),
  });
}

// One occurrence changed by hand keeps its own; the rest follow the series.
function childInstructions(series, slot) {
  return slot.instructions != null ? slot.instructions : (series.instructions || '');
}

export function localStamp(isoTime, timeZone) {
  const p = zonedParts(Date.parse(isoTime), assertZone(timeZone));
  return p.year + '-' + pad(p.month) + '-' + pad(p.day) + ' ' + pad(p.hour) + ':' + pad(p.minute);
}
