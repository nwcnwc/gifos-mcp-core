// The tools both servers share, over a real MCP client/server pair, with the
// browser replaced by a fake bot. A tiny product adds one join tool through
// ctx.joinByLink, the way gifos-meet-mcp and gifos-broadcast-mcp do.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { loadConfig } from '../../src/config.js';
import { MeetingStore, publicView } from '../../src/meetings.js';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './fixtures/tmp-home.js';
import { tinyPng } from './profile.test.js';

class FakeBot {
  constructor() { this.calls = []; this.seq = 0; this.voice = null; }
  async ensureStarted() {}
  async join(link, password) { this.calls.push(['join', link, password]); return 'mt_' + (++this.seq); }
  async leave(id) { this.calls.push(['leave', id]); }
  async transcribe(id, on) { this.calls.push(['transcribe', id, on]); }
  async say(id, text) { this.calls.push(['say', id, text]); }
  async transcript() { return ''; }
  async info() { return { state: 'ready', bot_name: 'notes-test' }; }
  async setVoice(v) { this.voice = v; return { applied: true, result: v }; }
  async setLook(look) { this.calls.push(['setLook', look]); if (look.name) this.name = look.name; if (look.picture !== undefined) this.picture = look.picture; return { name: this.name || 'notes-test', picture: !!this.picture }; }
  botNames() { return [this.name || 'notes-test']; }
  async interject(id, text, opts) { this.calls.push(['interject', id, text, opts || null]); return { applied: true }; }
}

let home, ctx, bot, client;
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const json = (r) => JSON.parse(r.content[0].text);

function product(server, c) {
  server.registerTool('test_join', { description: 'Test product: join a room by link.', inputSchema: { link: z.string() } },
    c.guarded(async ({ link }) => c.ok(publicView((await c.joinByLink(link, '', 'Test')).meeting))));
}

beforeEach(async () => {
  home = tmpHome('gifos-mcp-core-unit-');
  const cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:19510/', GIFOS_BOT_NAME: 'notes-test', GIFOS_BOT_PASSWORD: 'quiet-cedar-42' });
  bot = new FakeBot();
  ctx = createContext({ cfg, meetings: new MeetingStore(home), bot, botName: 'notes-test', botPassword: 'quiet-cedar-42' });
  const server = createServer({ name: 'core-test', version: '0.0.0', ctx, register: product });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'unit', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
});

test('the shared tools are there, and there is no voice-model switch', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  for (const n of ['get_transcript', 'tail_transcript', 'tail_lines', 'wait_lines', 'say', 'send_chat', 'share_content', 'mute', 'unmute',
    'get_meeting_state', 'snapshot', 'leave_meeting', 'end_meeting', 'list_meetings', 'status', 'meeting_status', 'meetings_report',
    'tail_events', 'capacity_status', 'schedule_meeting', 'list_schedule', 'update_schedule', 'cancel_schedule', 'import_schedule', 'test_join']) {
    assert.ok(names.includes(n), n);
  }
  assert.equal(names.includes('set_voice'), false);
});

test('a join hands Meet Bot both switches off: it says only what say gives it', async () => {
  const m = json(await call('test_join', { link: 'http://127.0.0.1:19510/run.html#v=room1' }));
  assert.equal(m.state, 'live');
  assert.deepEqual(bot.voice, { respond_to_command: false, speak: false });
  const st = json(await call('status'));
  assert.equal(st.voice.respond_to_command, false);
  assert.equal(st.voice.speak, false);
  assert.equal(st.voice.handed, true);
  for (const k of ['model', 'url', 'key', 'conversation_voice']) assert.equal(k in st.voice, false, k);
  assert.equal(JSON.stringify(st).includes('quiet-cedar-42'), false);
});

test('say speaks the line, with a voice for that line when asked', async () => {
  const m = json(await call('test_join', { link: 'http://127.0.0.1:19510/run.html#v=room2' }));
  json(await call('say', { meeting_id: m.meeting_id, text: 'Hello all.' }));
  json(await call('say', { meeting_id: m.meeting_id, text: 'And again.', voice: 'am_michael' }));
  const said = bot.calls.filter((c) => c[0] === 'interject');
  assert.deepEqual(said.map((c) => c[3]), [null, { voice: 'am_michael' }]);
  const lines = json(await call('tail_lines', { meeting_id: m.meeting_id }));
  assert.deepEqual(lines.lines.map((l) => [l.kind, l.text]), [['spoken', 'Hello all.'], ['spoken', 'And again.']]);
});

test('wait_lines returns as soon as a line lands, and marks lines addressed to the bot', async () => {
  const m = json(await call('test_join', { link: 'http://127.0.0.1:19510/run.html#v=room3' }));
  const t0 = Date.now();
  const pending = call('wait_lines', { meeting_id: m.meeting_id, since: 0, timeout_ms: 10000 });
  setTimeout(() => ctx.transcript.append({ meeting_id: m.meeting_id, speaker: 'Ada', text: 'Hey bot, what is next?', kind: 'speech' }), 150);
  const got = json(await pending);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, 'it woke on the line, not the timeout (' + ms + ' ms)');
  assert.equal(got.lines.length, 1);
  assert.equal(got.lines[0].to_bot, true);
  ctx.transcript.append({ meeting_id: m.meeting_id, speaker: 'Bob', text: 'I will bring the slides tomorrow', kind: 'speech' });
  ctx.transcript.append({ meeting_id: m.meeting_id, speaker: 'Cy', text: 'Does notes-test have the agenda?', kind: 'speech' });
  const next = json(await call('wait_lines', { meeting_id: m.meeting_id, since: got.next, timeout_ms: 0 }));
  assert.deepEqual(next.lines.map((l) => l.to_bot), [false, true]);
  const quiet = Date.now();
  const none = json(await call('wait_lines', { meeting_id: m.meeting_id, since: next.next, timeout_ms: 300 }));
  assert.equal(none.lines.length, 0);
  assert.ok(Date.now() - quiet >= 280, 'with nothing new it waits for timeout_ms');
});

test('set_bot_profile: the operator names the bot and gives it a picture; the name waits until it is in no room', async () => {
  const png = path.join(home, 'face.png'); fs.writeFileSync(png, tinyPng());
  const r = json(await call('set_bot_profile', { name: 'Ada\u2019s notes', picture_path: png }));
  assert.equal(r.name, 'Ada\u2019s notes');
  assert.equal(r.picture, true);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'bot.json'), 'utf8'));
  assert.equal(saved.name, 'Ada\u2019s notes');
  assert.equal(saved.password, 'quiet-cedar-42', 'the password is kept');
  assert.equal(JSON.stringify(r).includes('quiet-cedar-42'), false);
  assert.equal(fs.statSync(path.join(home, 'bot-picture.json')).mode & 0o777, 0o600);
  const svg = path.join(home, 'face.svg'); fs.writeFileSync(svg, '<svg/>');
  const bad = await call('set_bot_profile', { picture_path: svg });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /GIF, PNG, JPEG or WebP/);
  json(await call('test_join', { link: 'http://127.0.0.1:19510/run.html#v=room9' }));
  const busy = await call('set_bot_profile', { name: 'Other name' });
  assert.equal(busy.isError, true);
  assert.match(busy.content[0].text, /in a room/);
  const cleared = json(await call('set_bot_profile', { clear_picture: true }));
  assert.equal(cleared.picture, false, 'the picture can change while in a room');
  assert.equal(fs.existsSync(path.join(home, 'bot-picture.json')), false);
  assert.equal((await call('set_bot_profile', {})).isError, true);
  // Lines the renamed bot speaks are credited to its new name.
  const m = json(await call('list_meetings')).meetings[0];
  json(await call('say', { meeting_id: m.meeting_id, text: 'Hi.' }));
  const lines = json(await call('tail_lines', { meeting_id: m.meeting_id })).lines;
  assert.deepEqual(lines.map((l) => [l.speaker, l.kind]), [['Ada\u2019s notes', 'spoken']]);
});

test('snapshot returns the PNG as image content when the file is there', async () => {
  const m = json(await call('test_join', { link: 'http://127.0.0.1:19510/run.html#v=room4' }));
  const png = path.join(home, 'shot.png');
  fs.writeFileSync(png, tinyPng());
  bot.snapshot = async () => ({ applied: true, png, result: { ok: true } });
  const shot = await call('snapshot', { meeting_id: m.meeting_id });
  const body = JSON.parse(shot.content[0].text);
  assert.equal(body.png, png);
  assert.equal(body.gap, null);
  assert.equal(shot.content[1].type, 'image');
  assert.equal(shot.content[1].mimeType, 'image/png');
  assert.equal(Buffer.from(shot.content[1].data, 'base64').equals(tinyPng()), true);
});
