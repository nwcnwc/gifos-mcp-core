// Fixes for what a live run against gifos.app found (2026-10-24): clean
// links, links that are not GifOS, dates that are not dates, the Kokoro
// weights an AVX-512 CPU needs, the bot's own lines in get_transcript, and
// the banner GifOS shows when the network blocks a meeting's connections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { loadConfig } from '../../src/config.js';
import { MeetingStore, publicView } from '../../src/meetings.js';
import { meetingLink, gifosHostAllowed, roomFromLink } from '../../src/links.js';
import { parseWhen, meetingInvite, assertNotPast, PAST_GRACE_MS } from '../../src/invite.js';
import { kokoroDtypeFor } from '../../src/voice/kokoro.js';
import { labelBotLines } from '../../src/tools/shared.js';
import { WORKER_METHODS } from '../../src/worker.js';
import { tmpHome } from './fixtures/tmp-home.js';

const BANNER = 'Your network blocks the direct connections this meeting needs. People outside your network cannot connect to this meeting.';

test('a plain room gets the clean /meet/<room> link; a hosted, town hall or relayed room keeps run.html', () => {
  assert.equal(meetingLink('https://gifos.app/', 'abc123'), 'https://gifos.app/meet/abc123');
  assert.equal(roomFromLink(meetingLink('https://gifos.app', 'abc123')), 'abc123');
  assert.match(meetingLink('https://gifos.app', 'abc123', { verifier: 'f'.repeat(24) }), /\/run\.html#v=abc123&av=f{24}$/);
  assert.match(meetingLink('https://gifos.app', 'abc123', { townHall: true }), /\/run\.html#v=abc123&th=1$/);
  assert.match(meetingLink('https://gifos.app', 'abc123', { relay: 'wss://r.example' }), /\/run\.html#v=abc123&relay=/);
});

test('the bot joins only GifOS: GIFOS_URL, gifos.app, or this computer', () => {
  assert.equal(gifosHostAllowed('https://gifos.app/meet/abc', 'https://gifos.app'), true);
  assert.equal(gifosHostAllowed('https://beta.gifos.app/meet/abc', 'https://gifos.app'), true);
  assert.equal(gifosHostAllowed('http://127.0.0.1:19510/run.html#v=abc', 'https://gifos.app'), true);
  assert.equal(gifosHostAllowed('https://meet.example.org/meet/abc', 'https://meet.example.org'), true);
  assert.equal(gifosHostAllowed('https://evil.example.com/meet/abc', 'https://gifos.app'), false);
  assert.equal(gifosHostAllowed('https://gifos.app.evil.example.com/meet/abc', 'https://gifos.app'), false);
  assert.equal(gifosHostAllowed('http://gifos.app/meet/abc', 'https://gifos.app'), false);
});

test('a date or time of day that does not exist is refused, not rolled over', () => {
  assert.throws(() => parseWhen('2026-13-45T99:00', 'UTC'), /no such date/);
  assert.throws(() => parseWhen('2026-02-30T10:00', 'America/Los_Angeles'), /no such date/);
  assert.throws(() => parseWhen('2026-10-20T24:00', 'UTC'), /no such date/);
  assert.throws(() => parseWhen('2026-10-20T17:60', 'UTC'), /no such date/);
  assert.throws(() => parseWhen('2026-02-30T10:00:00Z', 'UTC'), /no such date/);
  assert.throws(() => parseWhen('2026-13-01T10:00:00-07:00', 'UTC'), /no such date/);
  assert.equal(new Date(parseWhen('2028-02-29T10:00', 'UTC')).toISOString(), '2028-02-29T10:00:00.000Z');
  assert.equal(new Date(parseWhen('2026-10-20T23:59:59Z', 'UTC')).toISOString(), '2026-10-20T23:59:59.000Z');
});

test('a start that has already passed is refused; a few minutes late or no start is fine', () => {
  const now = Date.parse('2026-10-24T20:00:00Z');
  const inv = (start) => meetingInvite({ title: 'x', link: 'https://gifos.app/meet/abc', start, timezone: 'UTC' });
  assert.throws(() => assertNotPast(inv('2020-01-01T09:00'), now), /in the past/);
  assert.throws(() => assertNotPast(inv('2026-10-24T19:30'), now), /in the past/);
  assert.doesNotThrow(() => assertNotPast(inv('2026-10-24T19:50'), now));
  assert.doesNotThrow(() => assertNotPast(inv('2026-10-25T09:00'), now));
  assert.doesNotThrow(() => assertNotPast(inv(undefined), now));
  assert.equal(PAST_GRACE_MS, 15 * 60 * 1000);
});

test('an AVX-512 CPU loads the fp32 Kokoro weights up front; others keep q8', () => {
  assert.equal(kokoroDtypeFor('flags\t\t: fpu vme sse sse2 avx2 avx512f avx512dq'), 'fp32');
  assert.equal(kokoroDtypeFor('flags\t\t: fpu vme sse sse2 avx2'), 'q8');
  assert.equal(kokoroDtypeFor(''), 'q8');
});

test('the bot\'s own lines are kept and labelled (bot); nobody else\'s are', () => {
  const text = 'Alex: hello\nnotes-test: Hi, I am the note taker.\nnotes-tester: not the bot';
  assert.equal(labelBotLines(text, ['notes-test']), 'Alex: hello\nnotes-test (bot): Hi, I am the note taker.\nnotes-tester: not the bot');
  assert.equal(labelBotLines('', ['notes-test']), '');
  assert.equal(labelBotLines(text, []), text);
});

test('a worker may be asked for the network banner', () => {
  assert.ok(WORKER_METHODS.includes('networkWarning'));
});

class FakeBot {
  constructor() { this.seq = 0; this.joins = 0; this.banner = ''; }
  async ensureStarted() {}
  async join() { this.joins++; return 'mt_' + (++this.seq); }
  async leave() {}
  async transcribe() {}
  async say() {}
  async people() { return [{ name: 'notes-test', me: true }]; }
  async transcript() { return 'Alex: hi\nnotes-test: Hi, I am the note taker.'; }
  async info() { return { state: 'ready', bot_name: 'notes-test' }; }
  async setVoice(v) { return { applied: true, result: v }; }
  async networkWarning() { return this.banner; }
  botNames() { return ['notes-test']; }
}

async function setup() {
  const home = tmpHome('gifos-live-findings-');
  const cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'https://gifos.app', GIFOS_BOT_NAME: 'notes-test', GIFOS_BOT_PASSWORD: 'quiet-cedar-42' });
  const bot = new FakeBot();
  const ctx = createContext({ cfg, meetings: new MeetingStore(home), bot, botName: 'notes-test', botPassword: 'quiet-cedar-42' });
  const product = (server, c) => server.registerTool('test_join', { description: 'Test product: join by link.', inputSchema: { link: z.string() } },
    c.guarded(async ({ link }) => c.ok(publicView((await c.joinByLink(link)).meeting))));
  const server = createServer({ name: 'core-test', version: '0.0.0', ctx, register: product });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'unit', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  return { bot, call };
}
const json = (r) => JSON.parse(r.content[0].text);

test('a join to a host that is not GifOS fails at once and never opens the page', async () => {
  const { bot, call } = await setup();
  const t0 = Date.now();
  const r = await call('test_join', { link: 'https://evil.example.com/meet/abc' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not on GifOS \(evil\.example\.com\)/);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(bot.joins, 0);
});

test('meeting_status and get_meeting_state warn when the network blocks the meeting, and say nothing otherwise', async () => {
  const { bot, call } = await setup();
  const m = json(await call('test_join', { link: 'https://gifos.app/meet/room-one' }));
  assert.equal('warning' in json(await call('meeting_status', { meeting_id: m.meeting_id })), false);
  assert.equal('warning' in json(await call('get_meeting_state', { meeting_id: m.meeting_id })), false);
  bot.banner = BANNER;
  const st = json(await call('meeting_status', { meeting_id: m.meeting_id }));
  assert.match(st.warning, /network blocks the direct connections/);
  assert.match(st.warning, /cannot see or hear it/);
  assert.match(json(await call('get_meeting_state', { meeting_id: m.meeting_id })).warning, /network blocks/);
  assert.deepEqual(st.people, json(await call('get_meeting_state', { meeting_id: m.meeting_id })).people);
});

test('get_transcript labels the bot\'s own lines, live and after the meeting', async () => {
  const { call } = await setup();
  const m = json(await call('test_join', { link: 'https://gifos.app/meet/room-two' }));
  const live = (await call('get_transcript', { meeting_id: m.meeting_id })).content[0].text;
  assert.equal(live, 'Alex: hi\nnotes-test (bot): Hi, I am the note taker.');
  await call('end_meeting', { meeting_id: m.meeting_id });
  const after = (await call('get_transcript', { meeting_id: m.meeting_id })).content[0].text;
  assert.equal(after, 'Alex: hi\nnotes-test (bot): Hi, I am the note taker.');
});
