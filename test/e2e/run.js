// End-to-end: a real GifOS, a real MCP client over stdio, a real meeting.
//
//   GIFOS_APP_DIR=../gifos-app MEETING_BOT_SRC=../gifos-apps-source/meeting-bot \
//   E2E_SPEECH_WAV=/path/to/speech.wav npm run test:e2e
//
// 1. Serves GIFOS_APP_DIR on 127.0.0.1:19510; Meeting Bot comes from its store
//    listing, or is packed from MEETING_BOT_SRC and added to that store.
// 2. Starts a relay (RELAY_SCRIPT, on 19511) or uses E2E_RELAY.
// 3. Spawns bin/gifos-mcp.js over stdio and drives it with an MCP client:
//    create_meeting -> start_meeting -> a second headless browser joins as
//    "Alice" and plays speech -> get_transcript is non-empty -> share_content,
//    mute/unmute, list_meetings, status -> end_meeting -> the bot is gone.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { packApp, startSite } from './site.js';
import { workDir } from './work.js';
import { SYNTH_STT, SYNTH_TTS, SYNTH_LLM } from './synth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SITE_DIR = process.env.GIFOS_APP_DIR ? path.resolve(process.env.GIFOS_APP_DIR) : '';
const BOT_SRC = process.env.MEETING_BOT_SRC ? path.resolve(process.env.MEETING_BOT_SRC) : '';
const SITE_PORT = Number(process.env.E2E_SITE_PORT || 19510);
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT || 19511);
const STT = process.env.E2E_STT || 'whisper';            // whisper | synthetic
const SPEECH = process.env.E2E_SPEECH_WAV ? path.resolve(process.env.E2E_SPEECH_WAV) : ''; // Chromium needs an absolute path
const EXPECT = new RegExp(process.env.E2E_EXPECT || (STT === 'synthetic' ? 'synthetic speech' : '[A-Za-z]{3,}'), 'i');
const PROOF = path.resolve(process.env.E2E_PROOF_DIR || path.join(REPO, '.e2e', 'proof'));
const BASE = 'http://127.0.0.1:' + SITE_PORT;
const TRANSCRIPT_WAIT_MS = Number(process.env.E2E_TRANSCRIPT_WAIT_MS || 300000);
const CALL = { timeout: 600000 }; // the first call may install apps and start two browsers

let failures = 0;
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const say = (s) => console.log(stamp() + ' ' + s);
const check = (name, cond, detail) => {
  say((cond ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? '  (' + String(detail).slice(0, 300) + ')' : ''));
  if (!cond) failures++;
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r && r.content && r.content[0] && r.content[0].text) || '';

function need(cond, msg) { if (!cond) { console.error('e2e setup: ' + msg); process.exit(2); } }

function noiseWav(dest) {
  const rate = 44100, loud = rate * 2, quiet = Math.floor(rate * 1.2);
  const data = Buffer.alloc((loud + quiet) * 2);
  let seed = 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed / 0x100000000) * 2 - 1; };
  for (let i = 0; i < loud; i++) data.writeInt16LE((Math.max(-1, Math.min(1, 0.55 * Math.sin(2 * Math.PI * 440 * i / rate) + 0.4 * rnd())) * 32767) | 0, i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(dest, Buffer.concat([h, data]));
}

async function waitPort(port, ms) {
  const net = await import('node:net');
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.end(); r(true); }); s.on('error', () => r(false)); });
    if (ok) return true;
    await sleep(200);
  }
  return false;
}

async function main() {
  need(SITE_DIR && fs.existsSync(path.join(SITE_DIR, 'run.html')), 'set GIFOS_APP_DIR to a gifos-app checkout (release/0.9.23 or later)');
  const listed = fs.existsSync(path.join(SITE_DIR, 'apps', 'meeting-bot', 'app.json'));
  need(listed || (BOT_SRC && fs.existsSync(path.join(BOT_SRC, 'manifest.json'))),
    'this GifOS store has no meeting-bot listing: set MEETING_BOT_SRC to the meeting-bot source folder (gifos-apps-source)');
  need(STT === 'whisper' || STT === 'synthetic', 'E2E_STT is whisper or synthetic');
  need(STT !== 'whisper' || (SPEECH && fs.existsSync(SPEECH)), 'whisper mode needs E2E_SPEECH_WAV, a WAV file of someone speaking');
  fs.mkdirSync(PROOF, { recursive: true });
  const work = workDir('gifos-mcp-e2e-');
  const wav = SPEECH || path.join(work, 'noise.wav');
  if (!SPEECH) noiseWav(wav);
  say('site ' + BASE + ' from the gifos-app checkout; STT ' + STT + '; speech ' + path.basename(wav));

  // ---- local GifOS with Meeting Bot in its store ----
  const logo = fs.readFileSync(path.join(REPO, 'assets', 'logo-512.png'));
  // Meeting Bot from MEETING_BOT_SRC when given, else the site's own store listing.
  const extra = [];
  if (BOT_SRC) {
    const bot = await packApp(BOT_SRC, SITE_DIR, ['manifest.json', 'index.html', 'app.js', 'protocol.js', 'voice.js', 'help.md', 'CONTROL.md', 'listing.json']);
    extra.push({ slug: 'meeting-bot', ...bot, cover: logo });
  }
  if (STT === 'synthetic') {
    const apps = [['stt-synthetic', SYNTH_STT], ['tts-synthetic', SYNTH_TTS], ['llm-synthetic', SYNTH_LLM]];
    for (const [slug, files] of apps) {
      const dir = path.join(work, slug);
      fs.mkdirSync(dir);
      for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
      extra.push({ slug, ...(await packApp(dir, SITE_DIR, ['manifest.json', 'index.html'])), cover: logo });
    }
  }
  const site = await startSite({ siteDir: SITE_DIR, port: SITE_PORT, extraApps: extra });
  const listing = JSON.parse(await (await fetch(BASE + '/apps/meeting-bot/app.json')).text());
  check('local GifOS store lists meeting-bot', listing.appId === 'meeting-bot',
    (BOT_SRC ? 'packed from MEETING_BOT_SRC' : 'the site\'s own listing') + ', version ' + listing.version + ', ' + listing.bytes + ' bytes, sha256 ' + String(listing.sha256).slice(0, 12));

  let relayProc = null;
  let relay = process.env.E2E_RELAY || '';
  if (process.env.RELAY_SCRIPT) {
    relay = 'ws://127.0.0.1:' + RELAY_PORT;
    relayProc = spawn(process.execPath, [process.env.RELAY_SCRIPT], { env: { ...process.env, RELAY_PORT: String(RELAY_PORT) }, stdio: ['ignore', 'ignore', 'pipe'] });
    relayProc.stderr.on('data', (d) => process.stdout.write('  [relay] ' + d));
    need(await waitPort(RELAY_PORT, 15000), 'the relay did not start on ' + RELAY_PORT);
  }
  say('relay ' + (relay || '(GifOS default)'));

  // ---- the MCP server, over stdio ----
  const mcpHome = path.join(work, 'mcp-home');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO, 'bin', 'gifos-mcp.js')],
    env: {
      ...process.env,
      GIFOS_URL: BASE,
      GIFOS_RELAY: relay,
      GIFOS_MCP_HOME: mcpHome,
      GIFOS_STT_APP: STT === 'synthetic' ? 'stt-synthetic' : 'offline-stt-whisper',
      GIFOS_TTS_APP: STT === 'synthetic' ? 'tts-synthetic' : '',
      GIFOS_TTS_ENGINE: STT === 'synthetic' ? 'kokoro' : 'none',
      GIFOS_LLM_APP: STT === 'synthetic' ? 'llm-synthetic' : '',
      GIFOS_CONVERSATION_VOICE: STT === 'synthetic' ? 'local' : 'none',
      GIFOS_VOICE: STT === 'synthetic' ? '' : '0',
      GIFOS_LLM_KEY: '',
      GIFOS_LLM_URL: '',
      GIFOS_MCP_SHOTS: PROOF,
    },
    stderr: 'pipe',
  });
  transport.stderr.on('data', (d) => process.stdout.write('  ' + String(d).replace(/\n(?=.)/g, '\n  ')));
  const client = new Client({ name: 'gifos-mcp-e2e', version: '1' });
  let human = null;
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    check('MCP server lists its tools over stdio', tools.length === 30 && names.includes('set_voice') && names.includes('say') && names.includes('schedule_meeting') && names.includes('leave_meeting'), names.join(', '));

    const created = await client.callTool({ name: 'create_meeting', arguments: { name: 'Demo meeting', admin_password: 'owner-key-77' } }, undefined, CALL);
    const meeting = JSON.parse(text(created));
    check('create_meeting returns a link on the local GifOS', meeting.link && meeting.link.startsWith(BASE + '/run.html#v=') && !meeting.meeting_id, meeting.link);
    const listed = JSON.parse(text(await client.callTool({ name: 'list_meetings', arguments: {} }, undefined, CALL)));
    meeting.meeting_id = listed.meetings.find((m) => m.link === meeting.link).meeting_id;

    const started = await client.callTool({ name: 'start_meeting', arguments: { meeting_id: meeting.meeting_id } }, undefined, CALL);
    const live = started.isError ? null : JSON.parse(text(started));
    if (!check('start_meeting: the bot installs from the store, joins and transcribes', live && live.state === 'live' && live.transcribing, text(started))) throw new Error('start failed');

    const st = JSON.parse(text(await client.callTool({ name: 'status', arguments: {} }, undefined, CALL)));
    check('status: bot ready, one live meeting, STT app installed', st.bot.state === 'ready' && st.live_meetings.length === 1 && st.bot.stt_ready, JSON.stringify(st));

    // ---- a person joins and talks ----
    human = await chromium.launch({
      headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav,
        '--autoplay-policy=no-user-gesture-required'],
    });
    const hctx = await human.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] });
    await hctx.addInitScript({ content: 'try{localStorage.setItem("gifos_name","Alice");localStorage.setItem("gifos_meet_bar","0");sessionStorage.setItem("gifos_appeared","1");' +
      (relay ? 'localStorage.setItem("gifos_relay",' + JSON.stringify(relay) + ');' : '') + '}catch(e){}' });
    // Alice's browser has no speech engine (as in Firefox), so Meet Bot is the
    // one that writes her down. Headless Chromium exposes the API without a
    // working engine, which would make her claim her own voice and write nothing.
    await hctx.addInitScript({ content: 'try{window.webkitSpeechRecognition=undefined;window.SpeechRecognition=undefined;}catch(e){}' });
    const alice = await hctx.newPage();
    alice.on('pageerror', (e) => say('  [alice] ' + e.message));
    await alice.goto(meeting.link + '&DEBUG=on', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await alice.locator('.tile .botbadge').first().waitFor({ timeout: 90000 });
    let tile = '';
    for (let i = 0; i < 40; i++) {
      tile = await alice.locator('.tile', { has: alice.locator('.botbadge') }).first().innerText();
      if (/bot/.test(tile)) break;
      await sleep(500);
    }
    // GifOS joins with the mic off; Alice turns hers on to talk.
    // GifOS 0.9.23b fades the call buttons after 3 s without input; a person
    // moves the pointer to reach them, so the test does too.
    await alice.mouse.move(200, 200); await alice.mouse.move(220, 220);
    await alice.locator('#mic').click();
    const micOn = await alice.waitForSelector('#mic:not(.off)', { timeout: 15000 }).then(() => true, () => false);
    check('Alice turns her microphone on', micOn);
    check('Alice sees the 🤖 bot badge', /bot/.test(tile), tile.replace(/\s+/g, ' '));
    await alice.screenshot({ path: path.join(PROOF, 'alice-sees-bot.png') });

    let transcript = '';
    const end = Date.now() + TRANSCRIPT_WAIT_MS;
    while (Date.now() < end) {
      const r = await client.callTool({ name: 'get_transcript', arguments: { meeting_id: meeting.meeting_id } }, undefined, CALL);
      transcript = r.isError ? '' : text(r);
      if (/^Alice: /m.test(transcript) && EXPECT.test(transcript)) break;
      await sleep(5000);
    }
    if (!EXPECT.test(transcript)) say('status at transcript timeout: ' + text(await client.callTool({ name: 'status', arguments: {} }, undefined, CALL)));
    say('transcript so far:\n' + transcript.split('\n').slice(0, 12).map((l) => '    | ' + l).join('\n'));
    check('get_transcript returns Alice\'s words', /^Alice: /m.test(transcript) && EXPECT.test(transcript), 'expect ' + EXPECT);

    if (STT === 'synthetic') {
      const said = await client.callTool({ name: 'say', arguments: { meeting_id: meeting.meeting_id, text: 'Hello from the bot' } }, undefined, CALL);
      const spoken = said.isError ? null : JSON.parse(text(said));
      check('say speaks through the assigned text-to-speech provider', spoken && spoken.spoken === true, text(said));
      let round = null;
      let sawConversation = 0;
      const voiceEnd = Date.now() + 90000;
      while (Date.now() < voiceEnd) {
        round = JSON.parse(text(await client.callTool({ name: 'status', arguments: {} }, undefined, CALL)));
        const cmds = (round.bot && round.bot.commands) || [];
        const errs = (round.bot && round.bot.errors) || [];
        if (errs.length) break;
        if (cmds.some((c) => c.op === 'conversation')) {
          if (!sawConversation) sawConversation = Date.now();
          if (Date.now() - sawConversation > 2500) break;
        }
        await sleep(500);
      }
      const cmds = (round && round.bot && round.bot.commands) || [];
      const errs = (round && round.bot && round.bot.errors) || [];
      const voice = (round && round.voice) || {};
      check('status handed local voice to Meet Bot without a URL or a key',
        voice.conversation_voice === 'local' && voice.handed === true && voice.tts && voice.tts.app === 'tts-synthetic' &&
        !JSON.stringify(voice).includes('127.0.0.1') && !JSON.stringify(round.bot.commands || []).includes('gifos-provider'),
        JSON.stringify(voice));
      check('a converse turn round-trips through speech-to-text, the language model, and speech',
        cmds.some((c) => c.op === 'conversation') && errs.length === 0,
        JSON.stringify({ commands: cmds, errors: errs }));
    }

    const shared = await client.callTool({ name: 'share_content', arguments: { meeting_id: meeting.meeting_id, text: 'Agenda for the demo meeting: intro, questions.' } }, undefined, CALL);
    check('share_content answers', !shared.isError, text(shared));
    await alice.locator('#chatbtn').click();
    await alice.locator('#chatlog', { hasText: 'Agenda for the demo meeting' }).waitFor({ timeout: 30000 }).then(() => true, () => false)
      .then((seen) => check('Alice sees the shared text in chat', seen));
    await alice.screenshot({ path: path.join(PROOF, 'alice-chat.png') });

    const muted = JSON.parse(text(await client.callTool({ name: 'mute', arguments: { meeting_id: meeting.meeting_id } }, undefined, CALL)));
    // GifOS 0.9.23 transcribes in every browser and shows no per-tile chip for it.
    check('mute stops transcribing', muted.muted === true && muted.transcribing === false);
    const unmuted = JSON.parse(text(await client.callTool({ name: 'unmute', arguments: { meeting_id: meeting.meeting_id } }, undefined, CALL)));
    check('unmute turns transcribing back on', unmuted.transcribing === true);

    const now = JSON.parse(text(await client.callTool({ name: 'list_meetings', arguments: {} }, undefined, CALL)));
    check('list_meetings shows the live meeting', now.meetings.length === 1 && now.meetings[0].state === 'live');

    const ended = JSON.parse(text(await client.callTool({ name: 'end_meeting', arguments: { meeting_id: meeting.meeting_id } }, undefined, CALL)));
    check('end_meeting: the bot leaves and keeps the transcript', ended.state === 'ended' && ended.transcript_lines >= 1, JSON.stringify(ended));
    const gone = await alice.waitForFunction(() => !document.querySelector('.tile .botbadge'), null, { timeout: 45000 }).then(() => true, () => false);
    check('Alice no longer sees the bot', gone);
    await alice.screenshot({ path: path.join(PROOF, 'alice-after-end.png') });

    const after = await client.callTool({ name: 'get_transcript', arguments: { meeting_id: meeting.meeting_id } }, undefined, CALL);
    check('get_transcript still works after end_meeting', !after.isError && /^Alice: /m.test(text(after)), text(after).slice(0, 200));
  } catch (e) {
    check('suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : String(e));
  } finally {
    if (human) await human.close().catch(() => {});
    await client.close().catch(() => {});
    if (relayProc) relayProc.kill();
    site.close();
  }
  say(failures ? failures + ' FAILURE(S)' : 'ALL PASS');
  say('screenshots in ' + PROOF);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
