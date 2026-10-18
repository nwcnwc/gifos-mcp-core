import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, botCredentials, credentialProblem, generateCredentials, DEFAULT_GIFOS_URL, voiceConfig } from '../../src/config.js';
import { MeetingStore, newRoom, linkFor, roomFromLink } from '../../src/meetings.js';
import { EventLog } from '../../src/events.js';
import { tmpHome } from './fixtures/tmp-home.js';

const tmp = () => tmpHome('gifos-mcp-cfg-');

test('defaults', () => {
  const c = loadConfig({ GIFOS_MCP_HOME: '/x' });
  assert.equal(c.gifosUrl, DEFAULT_GIFOS_URL);
  assert.equal(c.sttApp, 'offline-stt-whisper');
  assert.equal(c.headless, true);
  assert.equal(c.relay, '');
  assert.equal(c.timeoutMs, 120000);
  assert.equal(loadConfig({ GIFOS_STT_APP: 'none' }).sttApp, '');
  assert.equal(loadConfig({ GIFOS_URL: 'http://127.0.0.1:19510///' }).gifosUrl, 'http://127.0.0.1:19510');
  assert.throws(() => loadConfig({ GIFOS_URL: 'gifos.app' }), /GIFOS_URL/);
});

test('there is no text model: no model URL, key or name is read, and speech is Kokoro here', () => {
  // Old settings are ignored, not used: the assistant calling the tools writes every line.
  const env = { GIFOS_LLM_KEY: 'sk-test-key', GIFOS_LLM_URL: 'https://api.example.test/v1', GIFOS_LLM_MODEL: 'm', GIFOS_CONVERSATION_VOICE: 'local' };
  const v = voiceConfig(env);
  assert.deepEqual(Object.keys(v).sort(), ['pollMs', 'sttApp', 'sttUrl', 'tts']);
  assert.equal(JSON.stringify(loadConfig({ GIFOS_MCP_HOME: '/x', ...env })).includes('sk-test-key'), false);
  assert.equal(JSON.stringify(loadConfig({ GIFOS_MCP_HOME: '/x', ...env })).includes('api.example.test'), false);
  const local = voiceConfig({});
  assert.equal(local.pollMs, 300);
  assert.equal(local.tts.engine, 'kokoro');
  assert.equal(local.tts.source, 'mcp');
  assert.equal(local.tts.app, 'mcp-tts-kokoro');
  assert.equal(local.tts.voice, 'af_heart');
  assert.equal(local.sttUrl, '');
  const standin = voiceConfig({
    GIFOS_TTS_URL: 'http://127.0.0.1:10/voice',
    GIFOS_STT_URL: 'http://127.0.0.1:11/captions',
    GIFOS_TTS_VOICE: 'af_heart',
  });
  assert.equal(standin.tts.engine, 'http');
  assert.equal(standin.tts.url, 'http://127.0.0.1:10/voice');
  assert.equal(standin.sttUrl, 'http://127.0.0.1:11/captions');
  assert.equal(voiceConfig({ GIFOS_TTS_ENGINE: 'none' }).tts.engine, 'none');
  assert.throws(() => voiceConfig({ GIFOS_TTS_ENGINE: 'piper' }), /GIFOS_TTS_ENGINE/);
  assert.throws(() => voiceConfig({ GIFOS_TTS_URL: 'not a url' }), /GIFOS_TTS_URL/);
});

test('credential rules match the Meeting Bot app', () => {
  assert.match(credentialProblem('bot', 'bot'), /less obvious/);
  assert.match(credentialProblem('harbor-maple', 'short1'), /10 characters/);
  assert.match(credentialProblem('harbor-maple', 'harbor-maple'), /not be the name/);
  assert.match(credentialProblem('harbor-maple', 'abcdefghijk'), /letter and a digit/);
  assert.equal(credentialProblem('harbor-maple', 'quiet-cedar-42'), '');
  for (let i = 0; i < 50; i++) {
    const g = generateCredentials();
    assert.equal(credentialProblem(g.name, g.password), '', JSON.stringify(g));
  }
});

test('generated credentials persist with mode 0600; env wins and is checked', () => {
  const home = tmp();
  const a = botCredentials(loadConfig({ GIFOS_MCP_HOME: home }));
  assert.equal(a.source, 'generated');
  const st = fs.statSync(path.join(home, 'bot.json'));
  assert.equal(st.mode & 0o777, 0o600);
  const b = botCredentials(loadConfig({ GIFOS_MCP_HOME: home }));
  assert.equal(b.source, 'file');
  assert.equal(b.name, a.name);
  assert.equal(b.password, a.password);
  const e = botCredentials(loadConfig({ GIFOS_MCP_HOME: home, GIFOS_BOT_NAME: 'harbor-maple', GIFOS_BOT_PASSWORD: 'quiet-cedar-42' }));
  assert.equal(e.source, 'env');
  assert.throws(() => botCredentials(loadConfig({ GIFOS_MCP_HOME: home, GIFOS_BOT_NAME: 'bot', GIFOS_BOT_PASSWORD: 'bot' })), /less obvious/);
});

test('rooms and links', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const r = newRoom(); assert.match(r, /^[0-9a-z]{24}$/); seen.add(r); }
  assert.equal(seen.size, 200);
  assert.equal(linkFor('https://gifos.app', 'abc'), 'https://gifos.app/run.html#v=abc');
  assert.equal(roomFromLink('https://gifos.app/run.html#v=abc-1&relay=x'), 'abc-1');
  assert.equal(roomFromLink('https://gifos.app/meet/Room42'), 'Room42');
  assert.equal(roomFromLink('https://gifos.app/meet/Room42/'), 'Room42');
  assert.equal(roomFromLink('https://gifos.app/index.html'), '');
  assert.equal(roomFromLink('javascript:alert(1)#v=abc'), '');
  assert.equal(roomFromLink('https://gifos.app/run.html#v=bad%20room'), '');
});

test('a restart puts live meetings back to scheduled', () => {
  const home = tmp();
  const s = new MeetingStore(home);
  const m = s.add({ topic: 'Demo meeting', room: 'r1', link: 'https://gifos.app/run.html#v=r1' });
  s.update(m.meeting_id, { state: 'live', session_id: 'mt_1', transcribing: true });
  const again = new MeetingStore(home);
  assert.equal(again.resetLive(), 1);
  assert.equal(new MeetingStore(home).get(m.meeting_id).state, 'scheduled');
  assert.equal(new MeetingStore(home).get(m.meeting_id).session_id, null);
});

// A torn meetings.json (disk full, killed mid-write by another tool) must not
// be read as no meetings and then saved over: it holds every transcript.
test('an unreadable meetings.json is kept aside, not overwritten by the next save', () => {
  const home = tmp();
  try {
    const torn = '{"meetings":[{"meeting_id":"m_1","transcript":"the only copy of';
    fs.writeFileSync(path.join(home, 'meetings.json'), torn, { mode: 0o600 });
    const s = new MeetingStore(home);
    assert.equal(s.all().length, 0);
    s.add({ topic: 'After' });
    const kept = fs.readdirSync(home).filter((f) => f.startsWith('meetings.json.bad'));
    assert.equal(kept.length, 1, 'kept ' + JSON.stringify(fs.readdirSync(home)));
    assert.equal(fs.readFileSync(path.join(home, kept[0]), 'utf8'), torn);
    assert.equal(fs.statSync(path.join(home, kept[0])).mode & 0o777, 0o600);
    assert.equal(new MeetingStore(home).all().length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A torn bot.json must not be replaced by a fresh pair: the old pair is the
// bot's identity and derives its admin meeting, and nothing else holds it.
test('an unreadable bot.json is kept aside, not overwritten by a fresh pair', () => {
  const home = tmp();
  try {
    const torn = '{"name":"notes-abc123","password":"only-copy-of-th';
    fs.writeFileSync(path.join(home, 'bot.json'), torn, { mode: 0o600 });
    const fresh = botCredentials(loadConfig({ GIFOS_MCP_HOME: home }));
    assert.equal(fresh.source, 'generated');
    const kept = fs.readdirSync(home).filter((f) => f.startsWith('bot.json.bad'));
    assert.equal(kept.length, 1, 'kept ' + JSON.stringify(fs.readdirSync(home)));
    assert.equal(fs.readFileSync(path.join(home, kept[0]), 'utf8'), torn);
    assert.equal(fs.statSync(path.join(home, kept[0])).mode & 0o777, 0o600);
    assert.equal(botCredentials(loadConfig({ GIFOS_MCP_HOME: home })).password, fresh.password);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A meetings.json save cut short must leave the last good file and no temp.
test('a meetings save cut short keeps the last good meetings.json', () => {
  const home = tmp();
  try {
    const s = new MeetingStore(home);
    const m = s.add({ topic: 'First' });
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, text, opts) => {
      if (String(file).includes('meetings.json')) {
        write(file, String(text).slice(0, 20), opts);
        const e = new Error('ENOSPC: no space left on device');
        e.code = 'ENOSPC';
        throw e;
      }
      return write(file, text, opts);
    };
    try {
      assert.throws(() => s.add({ topic: 'Second' }), /ENOSPC/);
    } finally {
      fs.writeFileSync = write;
    }
    assert.deepEqual(new MeetingStore(home).all().map((x) => x.meeting_id), [m.meeting_id]);
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A process killed mid-append leaves events.jsonl ending in a torn line with
// no newline. The next event must not be glued onto it: that line would not
// parse at the next start, the event would be lost, and its seq handed out
// again, so a client whose cursor already passed it never sees the new one.
test('an event appended after a torn last line survives a restart and its seq is not reused', () => {
  const home = tmp();
  try {
    const file = path.join(home, 'events.jsonl');
    const good = [1, 2, 3].map((seq) => JSON.stringify({ seq, ts: 't', meeting_id: '', type: 'meeting.joined', data: {} }));
    fs.writeFileSync(file, good.join('\n') + '\n{"seq":4,"ts":"t","meeting_id":"","ty', { mode: 0o600 });
    const first = new EventLog(home);
    assert.equal(first.seq, 3);
    const a = first.append({ type: 'meeting.left', meeting_id: 'm_1' });
    const cursor = first.tail(3).next;
    assert.equal(cursor, a.seq);
    const again = new EventLog(home);
    assert.deepEqual(again.tail(3).events.map((row) => [row.seq, row.type]), [[a.seq, 'meeting.left']]);
    const b = again.append({ type: 'meeting.ended', meeting_id: 'm_1' });
    assert.deepEqual(again.tail(cursor).events.map((row) => row.seq), [b.seq]);
    assert.deepEqual(new EventLog(home).tail(0).events.map((row) => row.type),
      ['meeting.joined', 'meeting.joined', 'meeting.joined', 'meeting.left', 'meeting.ended']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
