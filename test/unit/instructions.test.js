// The owner's goal and instructions for a meeting: bounded plain text, kept
// in the 0600 schedule, handed back by list_schedule, meeting_status and the
// clock's events, and never run. A meeting without them looks as before.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ScheduleStore, publicOrder, cleanInstructions, INSTRUCTIONS_MAX } from '../../src/schedule.js';
import { createClock } from '../../src/clock.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { loadConfig } from '../../src/config.js';
import { MeetingStore, publicView } from '../../src/meetings.js';
import { tmpHome } from './fixtures/tmp-home.js';

const LINK = 'http://127.0.0.1:19510/run.html#v=checkin1';
const PW = 'amber-gate-77';
const GOAL = 'Daily check-in for the owner.\nAsk: 1) What did you finish yesterday? 2) What is next today? 3) Anything blocking you?\nUp to two follow-ups each. 15 minutes.';
const DAY = 24 * 60 * 60 * 1000;

function order(extra = {}) {
  return { link: LINK, room_password: PW, start: '2026-01-05T17:00:00.000Z', end: '2026-01-05T17:15:00.000Z', topic: 'Check-in: Alex', ...extra };
}

// The fields a row had before instructions existed.
const OLD_KEYS = ['schedule_id', 'occurrence_id', 'series_id', 'meeting_id', 'topic', 'link', 'start', 'end', 'end_defaulted',
  'timezone', 'early_margin', 'recurrence', 'phase', 'external_id', 'missed_reason'].sort();

test('instructions are bounded plain text: 4000 characters, control characters dropped, never another type', () => {
  assert.equal(INSTRUCTIONS_MAX, 4000);
  assert.equal(cleanInstructions(undefined), '');
  assert.equal(cleanInstructions('  a\r\nb\rc\u0000\u0007\td  '), 'a\nb\nc\td');
  assert.equal(cleanInstructions('x'.repeat(4000)).length, 4000);
  assert.throws(() => cleanInstructions('x'.repeat(4001)), /at most 4000/);
  assert.throws(() => cleanInstructions({ run: 'rm -rf /' }), /must be text/);
  const store = new ScheduleStore(tmpHome('gifos-instr-'));
  assert.throws(() => store.add(order({ instructions: 'y'.repeat(4001) })), /at most 4000/);
  assert.equal(store.all().length, 0);
});

test('stored 0600, read back after a restart, and listed with the order', () => {
  const home = tmpHome('gifos-instr-');
  const store = new ScheduleStore(home);
  const { order: row } = store.add(order({ instructions: GOAL }));
  const file = path.join(home, 'schedule.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).orders[0].instructions, GOAL);
  const again = new ScheduleStore(home);
  assert.equal(again.get(row.schedule_id).instructions, GOAL);
  assert.equal(publicOrder(again.get(row.schedule_id)).instructions, GOAL);
  assert.equal('room_password' in publicOrder(row), false);
});

test('without instructions an order looks exactly as before', () => {
  const home = tmpHome('gifos-instr-');
  const store = new ScheduleStore(home);
  const { order: row } = store.add(order());
  assert.deepEqual(Object.keys(publicOrder(row)).sort(), OLD_KEYS);
  assert.equal('instructions' in JSON.parse(fs.readFileSync(path.join(home, 'schedule.json'), 'utf8')).orders[0], false);
  // Cleared with '': back to transcribe only.
  const withGoal = store.add(order({ link: LINK.replace('checkin1', 'checkin2'), instructions: GOAL })).order;
  store.update(withGoal.schedule_id, '', { instructions: '' });
  assert.deepEqual(Object.keys(publicOrder(store.get(withGoal.schedule_id))).sort(), OLD_KEYS);
});

test('a daily series hands its instructions to each day; one day can have its own and keep them', () => {
  const store = new ScheduleStore(tmpHome('gifos-instr-'));
  const now = Date.parse('2026-01-05T16:00:00.000Z');
  const { order: series } = store.add(order({ recurrence: 'RRULE:FREQ=DAILY', timezone: 'America/Los_Angeles', instructions: GOAL }), now);
  store.materialize(now, 3 * DAY);
  const kids = () => store.all().filter((o) => o.series_id === series.schedule_id && o.phase === 'upcoming');
  assert.ok(kids().length >= 3);
  for (const k of kids()) assert.equal(k.instructions, GOAL);
  const day2 = kids()[1].occurrence_id;
  store.update(series.schedule_id, day2, { instructions: 'Friday: also ask about the week ahead.' }, now);
  // A series change rebuilds the future days; day 2 keeps its own.
  store.update(series.schedule_id, '', { instructions: 'New questions.' }, now);
  for (const k of kids()) assert.equal(k.instructions, k.occurrence_id === day2 ? 'Friday: also ask about the week ahead.' : 'New questions.');
});

test('the clock puts the instructions in schedule.due and meeting.joined, and leaves them out when there are none', async () => {
  const store = new ScheduleStore(tmpHome('gifos-instr-'));
  const meetings = new MeetingStore(tmpHome('gifos-instr-m-'));
  const a = store.add(order({ instructions: GOAL })).order;
  store.add(order({ link: LINK.replace('checkin1', 'checkin3'), topic: 'Plain notes' }));
  const events = [];
  const clock = createClock({
    schedule: store, meetings, cap: 4, near: 3, horizonMs: DAY,
    emit: (e) => events.push(e),
    join: async (item) => meetings.add({ room: item.room, link: item.link, state: 'live', session_id: 's-' + item.room }),
    leave: async () => {},
  });
  await clock.tick(Date.parse(a.start) - 30 * 1000);
  const of = (type, topic) => events.find((e) => e.type === type && e.data.topic === topic);
  assert.equal(of('schedule.due', 'Check-in: Alex').data.instructions, GOAL);
  assert.equal(of('meeting.joined', 'Check-in: Alex').data.instructions, GOAL);
  assert.equal(of('meeting.joined', 'Check-in: Alex').data.schedule_id, a.schedule_id);
  assert.equal('instructions' in of('schedule.due', 'Plain notes').data, false);
  assert.equal('instructions' in of('meeting.joined', 'Plain notes').data, false);
});

class FakeBot {
  constructor() { this.calls = []; this.seq = 0; }
  async ensureStarted() {}
  async join(link, password) { this.calls.push(['join', link, password]); return 'mt_' + (++this.seq); }
  async leave(id) { this.calls.push(['leave', id]); }
  async transcribe(id, on) { this.calls.push(['transcribe', id, on]); }
  async say(id, text) { this.calls.push(['say', id, text]); }
  async transcript() { return ''; }
  async info() { return { state: 'ready', bot_name: 'notes-test' }; }
  async setVoice(v) { return { applied: true, result: v }; }
  botNames() { return ['notes-test']; }
}

let client;
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const json = (r) => JSON.parse(r.content[0].text);

// A tiny product with one join tool, the way gifos-meet-mcp passes instructions.
function product(server, c) {
  server.registerTool('test_join', { description: 'Test product: join a room by link.', inputSchema: { link: z.string(), password: z.string().optional(), instructions: z.string().optional() } },
    c.guarded(async ({ link, password, instructions }) => {
      const { meeting, note } = await c.joinByLink(link, password, 'Test', instructions);
      const view = { ...publicView(meeting), ...(note ? { note } : {}) };
      const said = c.instructionsFor(meeting);
      return c.ok(said ? { ...view, instructions: said } : view);
    }));
}

beforeEach(async () => {
  const home = tmpHome('gifos-instr-tools-');
  const cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:19510/', GIFOS_BOT_NAME: 'notes-test', GIFOS_BOT_PASSWORD: 'quiet-cedar-42' });
  const ctx = createContext({ cfg, meetings: new MeetingStore(home), bot: new FakeBot(), botName: 'notes-test', botPassword: 'quiet-cedar-42' });
  const server = createServer({ name: 'core-test', version: '0.0.0', ctx, register: product });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'unit', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
});

test('schedule_meeting, list_schedule, update_schedule and import_schedule carry instructions; secrets in them are scrubbed', async () => {
  const start = new Date(Date.now() + DAY).toISOString();
  const made = json(await call('schedule_meeting', { link: LINK, room_password: PW, start, recurrence: 'FREQ=DAILY;COUNT=5', instructions: GOAL + ' Room password ' + PW }));
  assert.equal(made.instructions, GOAL + ' Room password [redacted]');
  let rows = json(await call('list_schedule')).orders;
  assert.ok(rows.length >= 1);
  for (const r of rows) assert.equal(r.instructions, GOAL + ' Room password [redacted]');
  json(await call('update_schedule', { schedule_id: made.schedule_id, instructions: GOAL }));
  rows = json(await call('list_schedule')).orders;
  for (const r of rows) assert.equal(r.instructions, GOAL);
  const status = json(await call('meeting_status', { meeting_id: made.meeting_id }));
  assert.equal(status.instructions, GOAL);
  const created = json(await call('tail_events')).events.find((e) => e.type === 'schedule.created');
  assert.match(created.data.instructions, /\[redacted\]/);
  assert.equal(JSON.stringify(json(await call('tail_events'))).includes(PW), false);

  const imp = json(await call('import_schedule', { orders: [
    { link: LINK.replace('checkin1', 'imp1'), room_password: PW, start, external_id: 'cal-1', topic: 'Check-in: Sam', instructions: 'Ask Sam the three questions.' },
    { link: LINK.replace('checkin1', 'imp2'), room_password: PW, start, external_id: 'cal-2', topic: 'Team notes' },
  ] }));
  assert.equal(imp.created.length, 2);
  rows = json(await call('list_schedule')).orders;
  assert.equal(rows.find((r) => r.topic === 'Check-in: Sam').instructions, 'Ask Sam the three questions.');
  assert.equal('instructions' in rows.find((r) => r.topic === 'Team notes'), false);
  // A second import with the same id updates them.
  json(await call('import_schedule', { orders: [{ link: LINK.replace('checkin1', 'imp1'), room_password: PW, start, external_id: 'cal-1', instructions: 'Changed.' }] }));
  rows = json(await call('list_schedule')).orders;
  assert.equal(rows.find((r) => r.topic === 'Check-in: Sam').instructions, 'Changed.');
});

test('the tools refuse instructions over 4000 characters', async () => {
  const start = new Date(Date.now() + DAY).toISOString();
  const r = await call('schedule_meeting', { link: LINK, room_password: PW, start, instructions: 'z'.repeat(4001) });
  assert.equal(r.isError, true);
  assert.equal(json(await call('list_schedule')).orders.length, 0);
});

test('a join by link with instructions shows them in meeting_status and get_meeting_state; one without shows none', async () => {
  const m = json(await call('test_join', { link: LINK, instructions: GOAL }));
  assert.equal(m.instructions, GOAL);
  assert.equal(json(await call('meeting_status', { meeting_id: m.meeting_id })).instructions, GOAL);
  assert.equal(json(await call('get_meeting_state', { meeting_id: m.meeting_id })).instructions, GOAL);
  const joined = json(await call('tail_events')).events.find((e) => e.type === 'meeting.joined');
  assert.equal(joined.data.instructions, GOAL);

  const plain = json(await call('test_join', { link: LINK.replace('checkin1', 'plain1') }));
  assert.equal('instructions' in plain, false);
  const st = json(await call('meeting_status', { meeting_id: plain.meeting_id }));
  assert.equal('instructions' in st, false);
  assert.equal('instructions' in json(await call('get_meeting_state', { meeting_id: plain.meeting_id })), false);
  assert.equal('instructions' in json(await call('tail_events')).events.filter((e) => e.type === 'meeting.joined')[1].data, false);
});

test('a join with a room password keeps the instructions on its order, so a rejoin still has them', async () => {
  const m = json(await call('test_join', { link: LINK, password: PW, instructions: GOAL }));
  const rows = json(await call('list_schedule')).orders;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meeting_id, m.meeting_id);
  assert.equal(rows[0].instructions, GOAL);
});
