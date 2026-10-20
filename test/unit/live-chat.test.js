// Chat reaches the transcript the assistant tails. Meet Bot keeps chat out
// of its transcript (CONTROL.md: chatFile), so the caption poll reads the
// chat list too and appends each new line as kind 'chat'. wait_lines then
// marks a chat that names the bot with to_bot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LiveTranscript, watchCaptions } from '../../src/voice/live.js';
import { tmpHome } from './fixtures/tmp-home.js';

const ID = 'm_0123abcd';

test('ingestChat appends only the lines past the last count, and keeps the bot post once', () => {
  const home = tmpHome('live-chat-');
  try {
    const live = new LiveTranscript(home);
    const one = [{ by: 'Dana', text: 'harbor-maple can you hear me?', at: 1 }];
    assert.equal(live.ingestChat(ID, one, 'harbor-maple').length, 1);
    assert.equal(live.ingestChat(ID, one, 'harbor-maple').length, 0, 'the same list again adds nothing');
    live.append({ meeting_id: ID, speaker: 'harbor-maple', text: 'Yes.', kind: 'chat' });   // send_chat
    const two = one.concat([{ by: 'harbor-maple', text: 'Yes.', at: 2 }, { by: 'Dana', text: 'thanks', at: 3 }]);
    const added = live.ingestChat(ID, two, 'harbor-maple');
    assert.deepEqual(added.map((r) => [r.speaker, r.text]), [['Dana', 'thanks']]);
    const rows = live.query({ meetingId: ID, kinds: ['chat'] }).lines;
    assert.deepEqual(rows.map((r) => [r.speaker, r.text]), [['Dana', 'harbor-maple can you hear me?'], ['harbor-maple', 'Yes.'], ['Dana', 'thanks']]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a restart has no count: stored chat lines are not appended again, new ones are', () => {
  const home = tmpHome('live-chat-');
  try {
    const first = new LiveTranscript(home);
    const lines = [{ by: 'Dana', text: 'hello', at: 1 }, { by: 'Dana', text: 'hello', at: 2 }];
    assert.equal(first.ingestChat(ID, lines, 'bot').length, 2, 'the same words twice are two lines');
    const again = new LiveTranscript(home);
    assert.equal(again.ingestChat(ID, lines, 'bot').length, 0);
    assert.equal(again.ingestChat(ID, lines.concat([{ by: 'Eve', text: 'hi bot', at: 3 }]), 'bot').length, 1);
    assert.equal(again.query({ meetingId: ID, kinds: ['chat'] }).lines.length, 3);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the caption poll reads the chat list beside the transcript, and a bot without one is left alone', async () => {
  const home = tmpHome('live-chat-');
  try {
    const live = new LiveTranscript(home);
    const m = { meeting_id: ID, state: 'live', session_id: 's1' };
    const meetings = { get: (id) => (id === ID ? m : null) };
    let chat = [{ by: 'Dana', text: 'harbor-maple can you hear me?', at: 1 }];
    const bot = {
      async transcript() { return 'Dana: good morning'; },
      async chat(session) { assert.equal(session, 's1'); return chat; },
    };
    const w = watchCaptions({ meetings, bot, live, intervalMs: 20, botName: 'harbor-maple', scrubText: (s) => s.split('secret').join('[x]') });
    await w.start(m);
    let rows = live.query({ meetingId: ID }).lines;
    assert.deepEqual(rows.map((r) => [r.kind, r.speaker, r.text]), [['speech', 'Dana', 'good morning'], ['chat', 'Dana', 'harbor-maple can you hear me?']]);
    chat = chat.concat([{ by: 'Dana', text: 'the secret word', at: 2 }]);
    await new Promise((r) => setTimeout(r, 120));
    w.stop(ID);
    rows = live.query({ meetingId: ID, kinds: ['chat'] }).lines;
    assert.equal(rows.length, 2);
    assert.equal(rows[1].text, 'the [x] word', 'chat text is scrubbed like captions');

    const old = new LiveTranscript(home);
    const quiet = watchCaptions({ meetings, bot: { async transcript() { return ''; } }, live: old, intervalMs: 20, botName: 'harbor-maple' });
    await quiet.start(m);
    quiet.stop(ID);
    assert.equal(old.query({ meetingId: ID, kinds: ['chat'] }).lines.length, 2, 'nothing new from a bot with no chat read');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
