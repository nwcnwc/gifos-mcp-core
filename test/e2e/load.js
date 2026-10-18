// Load run: what one Chromium with one Meet Bot costs as it holds more rooms.
// This is the number behind GIFOS_MAX_MEETINGS (stage A) and
// GIFOS_WORKER_ROOMS (stage B: each worker is one such Chromium).
//
//   GIFOS_APP_DIR=../gifos-app E2E_ROOMS=1,4,8 npm run test:e2e:load
//
// Serves the gifos-app checkout on 127.0.0.1:19510 with the synthetic speech
// apps, spawns bin/gifos-mcp.js with one worker (the bot in-process, as in
// stage A), transcription on and conversation voice off.
//
// E2E_STT=whisper swaps the synthetic speech-to-text for Offline Captions
// (Whisper, the real default): each person's mic plays E2E_SPEECH_WAV (served
// by the site, so remote browsers need no copy) and a room counts as heard
// when its own person's line matches E2E_EXPECT. For each step n in
// E2E_ROOMS: n meetings are live -> status shows n bot sessions -> cost of
// the bot alone -> one person joins each room and talks -> each transcript
// holds its own person and nobody else -> cost with everyone talking. Cost
// is the gifos-mcp process alone and its whole tree (Chromium included):
// RSS summed over processes, PSS (shared pages split), CPU over E2E_SAMPLE_MS.
//
// E2E_SOAK_MS keeps everyone talking at the last step for that long and
// samples cost every E2E_SOAK_EVERY_MS (60s), with how many speech lines each
// room stored in that window: if captions fall behind one shared engine,
// lines per minute drop while memory climbs. Every room must still be heard
// in the last window.
//
// E2E_HUMAN_WS=ws://...,ws://... spreads the people over browsers on other
// machines (see stage-b.js for how to start them); "local" in that list is a
// Chromium here. Without it they run in one local Chromium. People are never
// counted in the cost.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { packApp, startSite } from './site.js';
import { workDir } from './work.js';
import { SYNTH_LINE, SYNTH_STT, SYNTH_TTS, SYNTH_LLM } from './synth.js';
import { sleep, procsUnder, usage, peopleBrowser, personIn, waitTiles, SPEECH_PATH } from './people.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SITE_DIR = process.env.GIFOS_APP_DIR ? path.resolve(process.env.GIFOS_APP_DIR) : '';
const SITE_PORT = Number(process.env.E2E_SITE_PORT || 19510);
const BASE = 'http://127.0.0.1:' + SITE_PORT;
const PROOF = path.resolve(process.env.E2E_PROOF_DIR || path.join(REPO, '.e2e', 'proof-load'));
const HUMAN_WS = String(process.env.E2E_HUMAN_WS || '').split(',').map((s) => s.trim()).filter(Boolean);
const STEPS = String(process.env.E2E_ROOMS || '1,4,8').split(',').map(Number).filter((n) => n > 0).sort((a, b) => a - b);
const SAMPLE_MS = Number(process.env.E2E_SAMPLE_MS || 10000);
const WAIT_MS = Number(process.env.E2E_TRANSCRIPT_WAIT_MS || 180000);
const SOAK_MS = Number(process.env.E2E_SOAK_MS || 0);
const SOAK_EVERY_MS = Number(process.env.E2E_SOAK_EVERY_MS || 60000);
const CALL = { timeout: 600000 }; // a first join installs apps and starts a browser
const STT = process.env.E2E_STT || 'synthetic';              // synthetic | whisper
const SPEECH = process.env.E2E_SPEECH_WAV ? path.resolve(process.env.E2E_SPEECH_WAV) : '';
const EXPECT = STT === 'whisper' ? new RegExp(process.env.E2E_EXPECT || '[A-Za-z]{3,}', 'i') : null;
const BOT = { name: 'load-e2e-bot', password: 'load-e2e-pass-' + process.pid };

let failures = 0;
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const say = (s) => console.log(stamp() + ' ' + s);
const check = (name, cond, detail) => {
  say((cond ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? '  (' + String(detail).slice(0, 400) + ')' : ''));
  if (!cond) failures++;
  return cond;
};
const text = (r) => (r && r.content && r.content[0] && r.content[0].text) || '';

// PSS splits pages shared between Chromium's processes, so it does not
// count the same library once per renderer the way summed RSS does.
function pssMb(root) {
  let kb = 0;
  for (const pid of procsUnder(root)) {
    try {
      const m = /^Pss:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8'));
      if (m) kb += Number(m[1]);
    } catch (e) { /* the process exited */ }
  }
  return Math.round(kb / 1024);
}

async function cost(pid) {
  const [all, own] = await Promise.all([usage(pid, SAMPLE_MS), usage(pid, SAMPLE_MS, true)]);
  return { processes: all.processes, tree_rss_mb: all.rss_mb, tree_pss_mb: pssMb(pid), tree_cpu_pct: all.cpu_pct, mcp_rss_mb: own.rss_mb, mcp_cpu_pct: own.cpu_pct };
}

async function main() {
  if (!SITE_DIR || !fs.existsSync(path.join(SITE_DIR, 'apps', 'meeting-bot', 'app.json'))) {
    console.error('e2e setup: set GIFOS_APP_DIR to a gifos-app checkout (0.9.23 or later) that lists apps/meeting-bot');
    process.exit(2);
  }
  if (STT !== 'synthetic' && STT !== 'whisper') { console.error('e2e setup: E2E_STT is synthetic or whisper'); process.exit(2); }
  if (STT === 'whisper' && !(SPEECH && fs.existsSync(SPEECH))) { console.error('e2e setup: E2E_STT=whisper needs E2E_SPEECH_WAV, a WAV of someone speaking'); process.exit(2); }
  if (!STEPS.length) { console.error('e2e setup: E2E_ROOMS must list room counts, e.g. 1,4,8'); process.exit(2); }
  const max = STEPS[STEPS.length - 1];
  fs.mkdirSync(PROOF, { recursive: true });
  const work = workDir('gifos-mcp-load-');
  const logo = fs.readFileSync(path.join(REPO, 'assets', 'logo-512.png'));
  const extra = [];
  const synth = [['tts-synthetic', SYNTH_TTS], ['llm-synthetic', SYNTH_LLM]];
  if (STT === 'synthetic') synth.unshift(['stt-synthetic', SYNTH_STT]);
  for (const [slug, files] of synth) {
    const dir = path.join(work, slug);
    fs.mkdirSync(dir);
    for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
    extra.push({ slug, ...(await packApp(dir, SITE_DIR, ['manifest.json', 'index.html'])), cover: logo });
  }
  const site = await startSite({ siteDir: SITE_DIR, port: SITE_PORT, extraApps: extra,
    files: STT === 'whisper' ? { [SPEECH_PATH]: { type: 'audio/wav', body: fs.readFileSync(SPEECH) } } : {} });
  say('site ' + BASE + '; STT ' + STT + (STT === 'whisper' ? ' (' + path.basename(SPEECH) + ', expect ' + EXPECT + ')' : '') + '; steps ' + STEPS.join(',') + '; people: ' + (HUMAN_WS.length ? HUMAN_WS.length + ' remote browser(s)' : 'one local browser') + '; ' + os.cpus().length + ' cores, ' + Math.round(os.totalmem() / 2 ** 30) + ' GB');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO, 'bin', 'gifos-mcp.js')],
    env: {
      ...process.env,
      GIFOS_URL: BASE,
      GIFOS_RELAY: process.env.E2E_RELAY || '',
      GIFOS_MCP_HOME: path.join(work, 'mcp-home'),
      GIFOS_BOT_NAME: BOT.name,
      GIFOS_BOT_PASSWORD: BOT.password,
      GIFOS_WORKERS: '1',
      GIFOS_MAX_MEETINGS: String(max),
      GIFOS_STT_APP: STT === 'whisper' ? 'offline-stt-whisper' : 'stt-synthetic',
      GIFOS_TTS_APP: 'tts-synthetic',
      GIFOS_TTS_ENGINE: 'kokoro',
      GIFOS_LLM_APP: 'llm-synthetic',
      GIFOS_CONVERSATION_VOICE: 'none',
      GIFOS_LLM_KEY: '',
      GIFOS_LLM_URL: '',
      GIFOS_MCP_SHOTS: PROOF,
    },
    stderr: 'pipe',
  });
  transport.stderr.on('data', (d) => process.stdout.write('  ' + String(d).replace(/\n(?=.)/g, '\n  ')));
  const client = new Client({ name: 'gifos-mcp-load-e2e', version: '1' });
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, CALL);
    if (r.isError) throw new Error(name + ': ' + text(r));
    return JSON.parse(text(r));
  };
  const browsers = [];
  const results = [];
  const rooms = [];
  try {
    await client.connect(transport);
    for (let i = 0; i < Math.max(1, HUMAN_WS.length); i++) browsers.push(await peopleBrowser(HUMAN_WS[i] === 'local' ? '' : HUMAN_WS[i]));

    for (const n of STEPS) {
      say('---- ' + n + ' room(s) ----');
      // ---- n rooms live ----
      while (rooms.length < n) {
        const name = 'Load ' + (rooms.length + 1);
        const { link } = await call('create_meeting', { name, admin_password: 'owner-key-' + (rooms.length + 1) });
        const id = (await call('list_meetings')).meetings.find((m) => m.link === link).meeting_id;
        rooms.push({ name, link, meeting_id: id });
      }
      const started = await Promise.allSettled(rooms.map((r) => call('start_meeting', { meeting_id: r.meeting_id })));
      check(n + ' meeting(s) live', started.every((s) => s.status === 'fulfilled' && s.value.state === 'live'),
        started.map((s) => (s.status === 'fulfilled' ? s.value.state : s.reason.message)).join(' | '));
      const st = await call('status');
      check('status shows ' + n + ' bot session(s)', (st.bot.bot_sessions || []).length === n, (st.bot.bot_sessions || []).length);

      // ---- the bot alone ----
      await sleep(5000);
      const alone = await cost(transport.pid);
      say('cost, bot alone in ' + n + ' room(s): ' + JSON.stringify(alone));

      // ---- one person talking in each room ----
      const people = [];
      for (let i = 0; i < n; i++) {
        const p = await personIn(browsers[i % browsers.length], 'Person ' + (i + 1), say, STT === 'whisper');
        people.push(p);
        await p.page.goto(rooms[i].link + '&DEBUG=on', { waitUntil: 'domcontentloaded', timeout: 90000 });
      }
      const seen = [];
      for (const p of people) {
        const got = await waitTiles(p.page, (t) => t.length === 1, 120000);
        await p.page.mouse.move(200, 200).catch(() => {}); await p.page.mouse.move(220, 220).catch(() => {}); // wake the calm call buttons
        await p.page.locator('#mic').click().catch(() => {});
        const micOn = await p.page.waitForSelector('#mic:not(.off)', { timeout: 30000 }).then(() => true, () => false);
        seen.push(got.ok && micOn);
      }
      check('each of ' + n + ' person(s) sees one bot and has the mic on', seen.every(Boolean), JSON.stringify(seen));
      await people[n - 1].page.screenshot({ path: path.join(PROOF, 'step-' + n + '-person-' + n + '.png') });

      const heard = new Array(n).fill(false);
      const others = new Array(n).fill(false);
      const sample = new Array(n).fill('');
      const end = Date.now() + WAIT_MS;
      while (Date.now() < end && heard.some((h) => !h)) {
        for (let i = 0; i < n; i++) {
          if (heard[i]) continue;
          await call('get_transcript', { meeting_id: rooms[i].meeting_id }).catch(() => null);
          const lines = (await call('tail_lines', { meeting_id: rooms[i].meeting_id })).lines || [];
          const speech = lines.filter((l) => l.kind === 'speech');
          const mine = speech.find((l) => l.speaker === people[i].name && (EXPECT ? EXPECT.test(l.text) : l.text.includes(SYNTH_LINE)));
          heard[i] = !!mine;
          if (mine) sample[i] = mine.text;
          others[i] = speech.some((l) => l.speaker !== people[i].name);
        }
        if (heard.some((h) => !h)) await sleep(3000);
      }
      check('the bot hears all ' + n + ' room(s), each transcript only its own person', heard.every(Boolean) && !others.some(Boolean),
        JSON.stringify({ heard, others }));
      say('heard, room 1: ' + JSON.stringify(sample[0]) + (n > 1 ? '; room ' + n + ': ' + JSON.stringify(sample[n - 1]) : ''));
      const talking = await cost(transport.pid);
      say('cost, ' + n + ' room(s), one person talking in each: ' + JSON.stringify(talking));
      const row = { rooms: n, alone, talking, heard: heard.filter(Boolean).length };
      if (SOAK_MS > 0 && n === max) row.soak = await soak(n);
      results.push(row);
      fs.writeFileSync(path.join(PROOF, 'load.json'), JSON.stringify({ stt: STT, cores: os.cpus().length, mem_gb: Math.round(os.totalmem() / 2 ** 30), sample_ms: SAMPLE_MS, results }, null, 2) + '\n');
      for (const p of people) await p.ctx.close().catch(() => {});
    }

    // Lines are stored by the caption poller while a room is live; the
    // window count is seq-based, so a line is counted once.
    async function soak(n) {
      const since = new Array(n).fill(0);
      for (let i = 0; i < n; i++) since[i] = (await call('tail_lines', { meeting_id: rooms[i].meeting_id })).next || 0;
      const rows = [];
      const start = Date.now();
      say('soak: ' + n + ' room(s) talking for ' + Math.round(SOAK_MS / 1000) + 's, a sample every ' + Math.round(SOAK_EVERY_MS / 1000) + 's');
      while (Date.now() - start < SOAK_MS) {
        await sleep(Math.max(0, SOAK_EVERY_MS - SAMPLE_MS));
        const c = await cost(transport.pid);
        const lines = [];
        for (let i = 0; i < n; i++) {
          const t = await call('tail_lines', { meeting_id: rooms[i].meeting_id, since: since[i], kinds: ['speech'] });
          lines.push((t.lines || []).length);
          if (t.next) since[i] = t.next;
        }
        const r = { at_s: Math.round((Date.now() - start) / 1000), ...c, lines_per_room: lines };
        rows.push(r);
        say('soak ' + r.at_s + 's: ' + JSON.stringify(r));
      }
      const last = rows[rows.length - 1];
      check('soak: every room still heard in the last window', !!last && last.lines_per_room.every((x) => x > 0), last && JSON.stringify(last.lines_per_room));
      return rows;
    }

    for (const r of rooms) await call('end_meeting', { meeting_id: r.meeting_id }).catch((e) => say('end ' + r.name + ': ' + e.message));
    const last = await call('status');
    check('every room ended, no bot session left', (last.bot.bot_sessions || []).length === 0, (last.bot.bot_sessions || []).length);

    say('rooms | alone: tree RSS / PSS MB, tree CPU %, mcp RSS MB | talking: tree RSS / PSS MB, tree CPU %, mcp RSS MB');
    for (const r of results) {
      const f = (c) => c.tree_rss_mb + ' / ' + c.tree_pss_mb + ', ' + c.tree_cpu_pct + '%, ' + c.mcp_rss_mb;
      say(String(r.rooms).padStart(5) + ' | ' + f(r.alone) + ' | ' + f(r.talking));
    }
    for (const r of results.filter((x) => x.soak)) {
      say('soak, ' + r.rooms + ' rooms talking | s | tree PSS / RSS MB, tree CPU %, mcp RSS MB | speech lines per room in the window');
      for (const s of r.soak) say(String(s.at_s).padStart(5) + ' | ' + s.tree_pss_mb + ' / ' + s.tree_rss_mb + ', ' + s.tree_cpu_pct + '%, ' + s.mcp_rss_mb + ' | ' + s.lines_per_room.join(' '));
    }
  } catch (e) {
    check('suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : String(e));
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
    await client.close().catch(() => {});
    site.close();
  }
  say(failures ? failures + ' FAILURE(S)' : 'ALL PASS');
  say('results in ' + path.join(PROOF, 'load.json'));
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
