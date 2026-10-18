// Stage B end-to-end: one supervisor, two worker processes, two real meetings.
//
//   GIFOS_APP_DIR=../gifos-app npm run test:e2e:stage-b
//
// Serves the gifos-app checkout (it must list apps/meeting-bot) on
// 127.0.0.1:19510 with the synthetic speech apps from synth.js, and spawns
// bin/gifos-mcp.js with GIFOS_WORKERS=2 and one room per worker. Then:
// two meetings start at once and land on different workers -> status shows
// both workers ready, each with its own bot name -> RSS and CPU per worker
// (its whole Chromium tree) -> one person joins each meeting and sees only
// that worker's bot -> each transcript holds only its own room's person ->
// say in the worker-1 room is a spoken line under <name>-w1, never speech ->
// chat shared in room A is not seen in room B -> worker 1 is killed: room B
// drops to scheduled, worker 0 is untouched, the clock seats B again on
// the restarted worker 1 by itself, and start_meeting then does not seat it twice -> end the worker-0
// room -> SIGKILL the supervisor: both workers and their Chromium trees exit and the worker-1 bot leaves.
//
// E2E_HUMAN_WS=ws://127.0.0.1:39301/pw,ws://127.0.0.1:39302/pw runs the two
// people in Chromium on other machines, started there with
// chromium.launchServer({ port, host: '127.0.0.1', wsPath: 'pw', args }) and
// the fake-media args below (a run-server ignores them). Forward that port
// here and 19510 back there, so the page stays on 127.0.0.1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { packApp, startSite } from './site.js';
import { workDir } from './work.js';
import { SYNTH_LINE, SYNTH_STT, SYNTH_TTS, SYNTH_LLM } from './synth.js';
import { sleep, procsUnder, alive, usage, peopleBrowser, personIn, botTiles, waitTiles } from './people.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SITE_DIR = process.env.GIFOS_APP_DIR ? path.resolve(process.env.GIFOS_APP_DIR) : '';
const SITE_PORT = Number(process.env.E2E_SITE_PORT || 19510);
const BASE = 'http://127.0.0.1:' + SITE_PORT;
const PROOF = path.resolve(process.env.E2E_PROOF_DIR || path.join(REPO, '.e2e', 'proof-stage-b'));
const HUMAN_WS = String(process.env.E2E_HUMAN_WS || '').split(',').map((s) => s.trim()).filter(Boolean);
const WAIT_MS = Number(process.env.E2E_TRANSCRIPT_WAIT_MS || 180000);
const CALL = { timeout: 600000 }; // a first join installs apps and starts a browser
const BOT = { name: 'stageb-e2e-bot', password: 'stageb-e2e-pass-' + process.pid };

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

async function person(name, slot) {
  const ws = HUMAN_WS[slot];
  const browser = await peopleBrowser(ws);
  const p = await personIn(browser, name, say);
  return { ...p, browser, where: ws ? 'remote ' + (slot + 1) : 'local' };
}

async function main() {
  if (!SITE_DIR || !fs.existsSync(path.join(SITE_DIR, 'apps', 'meeting-bot', 'app.json'))) {
    console.error('e2e setup: set GIFOS_APP_DIR to a gifos-app checkout (0.9.23 or later) that lists apps/meeting-bot');
    process.exit(2);
  }
  fs.mkdirSync(PROOF, { recursive: true });
  const work = workDir('gifos-mcp-stage-b-');
  const logo = fs.readFileSync(path.join(REPO, 'assets', 'logo-512.png'));
  const extra = [];
  for (const [slug, files] of [['stt-synthetic', SYNTH_STT], ['tts-synthetic', SYNTH_TTS], ['llm-synthetic', SYNTH_LLM]]) {
    const dir = path.join(work, slug);
    fs.mkdirSync(dir);
    for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
    extra.push({ slug, ...(await packApp(dir, SITE_DIR, ['manifest.json', 'index.html'])), cover: logo });
  }
  const site = await startSite({ siteDir: SITE_DIR, port: SITE_PORT, extraApps: extra });
  say('site ' + BASE + '; people: ' + (HUMAN_WS.length ? HUMAN_WS.length + ' remote browser(s)' : 'local'));

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
      GIFOS_WORKERS: '2',
      GIFOS_WORKER_ROOMS: '1',
      GIFOS_MAX_MEETINGS: '2',
      GIFOS_STT_APP: 'stt-synthetic',
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
  const client = new Client({ name: 'gifos-mcp-stage-b-e2e', version: '1' });
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, CALL);
    if (r.isError) throw new Error(name + ': ' + text(r));
    return JSON.parse(text(r));
  };
  const people = [];
  const metrics = {};
  try {
    await client.connect(transport);

    // ---- two meetings, started together ----
    const rooms = [];
    for (const name of ['Room A', 'Room B']) {
      const { link } = await call('create_meeting', { name, admin_password: 'owner-key-' + name.slice(-1) });
      rooms.push({ name, link });
    }
    const listed = await call('list_meetings');
    for (const r of rooms) r.meeting_id = listed.meetings.find((m) => m.link === r.link).meeting_id;
    const started = await Promise.allSettled(rooms.map((r) => call('start_meeting', { meeting_id: r.meeting_id })));
    check('both meetings start at once', started.every((s) => s.status === 'fulfilled' && s.value.state === 'live'),
      started.map((s) => s.status === 'fulfilled' ? s.value.state : s.reason.message).join(' | '));

    const st = await call('status');
    const workers = st.bot.workers || [];
    const sessions = st.bot.bot_sessions || [];
    check('status: two workers ready, one room each, each its own bot name',
      workers.length === 2 && workers.every((w) => w.state === 'ready' && w.rooms === 1) &&
      workers[0].bot_name === BOT.name && workers[1].bot_name === BOT.name + '-w1',
      JSON.stringify(workers));
    check('status: one bot session on each worker', sessions.filter((s) => s.worker === 0).length === 1 && sessions.filter((s) => s.worker === 1).length === 1,
      JSON.stringify(sessions.map((s) => s.session_id)));
    // ---- what each worker costs ----
    for (const w of workers) {
      if (!w.pid) continue;
      metrics['worker_' + w.worker] = await usage(w.pid, 5000);
    }
    check('status reports each worker pid, so its cost can be measured', workers.every((w) => w.pid > 0), JSON.stringify(workers.map((w) => w.pid)));
    say('per-worker cost, idle in one room each: ' + JSON.stringify(metrics));

    // ---- one person in each room ----
    people.push(await person('Alice', 0), await person('Bob', 1));
    for (let i = 0; i < 2; i++) {
      const { page } = people[i];
      await page.goto(rooms[i].link + '&DEBUG=on', { waitUntil: 'domcontentloaded', timeout: 90000 });
    }
    const seen = [];
    for (let i = 0; i < 2; i++) {
      const got = await waitTiles(people[i].page, (t) => t.length === 1 && /bot/.test(t[0]), 90000);
      seen.push(got.tiles.map((t) => t.replace(/\s+/g, ' ')));
      await people[i].page.mouse.move(200, 200); await people[i].page.mouse.move(220, 220); // wake the calm call buttons
      await people[i].page.locator('#mic').click();
      const micOn = await people[i].page.waitForSelector('#mic:not(.off)', { timeout: 15000 }).then(() => true, () => false);
      check(people[i].name + ' (' + people[i].where + ') turns the microphone on', micOn);
      await people[i].page.screenshot({ path: path.join(PROOF, people[i].name.toLowerCase() + '-sees-bot.png') });
    }
    const nameIn = (tiles, n) => tiles.length === 1 && tiles[0].includes(n);
    const w1 = BOT.name + '-w1';
    // Both rooms started together, so either room may hold either worker.
    const aW1 = nameIn(seen[0], w1);
    const bW1 = nameIn(seen[1], w1);
    check('each person sees exactly one bot, and the two rooms hold different workers',
      seen.every((t) => t.length === 1) && aW1 !== bW1,
      people.map((p, i) => p.name + ' (' + p.where + '): ' + JSON.stringify(seen[i])).join(' | '));
    for (let i = 0; i < 2; i++) rooms[i].worker = nameIn(seen[i], w1) ? 1 : 0;
    const roomOn = (w) => rooms.find((r) => r.worker === w);

    // ---- each transcript holds only its own room's person ----
    const lines = {};
    const end = Date.now() + WAIT_MS;
    while (Date.now() < end) {
      for (const r of rooms) {
        await call('get_transcript', { meeting_id: r.meeting_id }).catch(() => null);
        lines[r.name] = (await call('tail_lines', { meeting_id: r.meeting_id })).lines;
      }
      if (rooms.every((r, i) => lines[r.name].some((l) => l.kind === 'speech' && l.speaker === people[i].name))) break;
      await sleep(3000);
    }
    for (let i = 0; i < 2; i++) {
      const rows = lines[rooms[i].name] || [];
      const speakers = [...new Set(rows.filter((l) => l.kind === 'speech').map((l) => l.speaker))];
      check(rooms[i].name + ' (worker ' + rooms[i].worker + ') transcript has ' + people[i].name + ' and nobody from the other room',
        speakers.length === 1 && speakers[0] === people[i].name && rows.some((l) => l.text.includes(SYNTH_LINE)),
        JSON.stringify(speakers) + ' ' + rows.length + ' line(s)');
    }

    // ---- the worker-1 bot's lines go under its own name, never as speech ----
    // (say needs MeetingBot.interject, which the 0.9.23 store listing lacks.)
    const r1 = roomOn(1);
    const i1 = rooms.indexOf(r1);
    const sent = await call('send_chat', { meeting_id: r1.meeting_id, text: 'Hello from worker one' });
    await people[i1].page.locator('#chatbtn').click();
    const chatSeen = await people[i1].page.locator('#chatlog', { hasText: 'Hello from worker one' }).waitFor({ timeout: 30000 }).then(() => true, () => false);
    await call('get_transcript', { meeting_id: r1.meeting_id }).catch(() => null);
    const rows1 = (await call('tail_lines', { meeting_id: r1.meeting_id })).lines;
    check('send_chat in the worker-1 room reaches ' + people[i1].name + ' and is stored under ' + w1 + '; no bot name shows up as speech',
      sent.sent === true && chatSeen && rows1.some((l) => l.kind === 'chat' && l.speaker === w1) &&
      !rows1.some((l) => l.kind === 'speech' && (l.speaker === w1 || l.speaker === BOT.name)),
      JSON.stringify(rows1.filter((l) => l.kind !== 'speech')));

    // ---- chat stays in its own room ----
    await call('share_content', { meeting_id: rooms[0].meeting_id, text: 'Only for room A: agenda item one.' });
    await people[1 - i1].page.locator('#chatbtn').click();
    const inA = await people[0].page.locator('#chatlog', { hasText: 'Only for room A' }).waitFor({ timeout: 30000 }).then(() => true, () => false);
    await sleep(3000);
    const inB = await people[1].page.locator('#chatlog', { hasText: 'Only for room A' }).count();
    check('chat shared in room A shows in A and not in B', inA && inB === 0, 'A ' + inA + ', B ' + inB);

    // ---- kill worker 1: its room drops, worker 0 keeps going ----
    const w1pid = workers[1].pid;
    const r0 = roomOn(0);
    process.kill(w1pid, 'SIGKILL');
    let after = null;
    for (let i = 0; i < 40; i++) {
      after = await call('status');
      if (after.bot.workers[1].state === 'lost') break;
      await sleep(250);
    }
    const dropped = await call('meeting_status', { meeting_id: r1.meeting_id });
    const kept = await call('meeting_status', { meeting_id: r0.meeting_id });
    check('killing worker 1 drops its room to scheduled; worker 0 and its room stay up',
      after.bot.workers[1].state === 'lost' && after.bot.workers[0].state === 'ready' && dropped.state === 'scheduled' && kept.state === 'live',
      JSON.stringify({ w: after.bot.workers.map((w) => w.state), dropped: dropped.state, kept: kept.state }));
    const goneFromRoom = await waitTiles(people[i1].page, (t) => t.length === 0, 60000);
    check(people[i1].name + ' sees the worker-1 bot leave when its process dies', goneFromRoom.ok, JSON.stringify(goneFromRoom.tiles));
    const stillThere = await botTiles(people[1 - i1].page);
    check(people[1 - i1].name + ' still sees the worker-0 bot', stillThere.length === 1, JSON.stringify(stillThere));

    // Worker 0 is full; worker 1 restarts after its 1s backoff and the clock
    // (one tick each 15s) takes the room back with nobody calling start_meeting.
    let back = dropped;
    const backBy = Date.now() + 120000;
    while (back.state !== 'live' && Date.now() < backBy) {
      await sleep(1000);
      back = await call('meeting_status', { meeting_id: r1.meeting_id });
    }
    const backSt = await call('status');
    check('the clock seats the dropped room again on the restarted worker 1, on its own',
      back.state === 'live' && backSt.bot.workers[1].state === 'ready' && backSt.bot.workers[1].rooms === 1 && backSt.bot.workers[1].pid !== w1pid,
      JSON.stringify({ state: back.state, workers: backSt.bot.workers.map((w) => ({ state: w.state, rooms: w.rooms })) }));
    const again = await call('start_meeting', { meeting_id: r1.meeting_id });
    const againSt = await call('status');
    check('start_meeting on the room it is already back in does not seat it twice',
      again.state === 'live' && againSt.bot.workers[1].rooms === 1 && (againSt.bot.bot_sessions || []).filter((x) => x.worker === 1).length === 1,
      JSON.stringify(againSt.bot.workers.map((w) => w.rooms)));
    const events = (await call('tail_events')).events || [];
    check('tail_events shows the room joined again for reason worker',
      events.some((e) => e.type === 'meeting.joined' && e.meeting_id === r1.meeting_id && e.data && e.data.reason === 'worker'),
      JSON.stringify(events.filter((e) => e.meeting_id === r1.meeting_id).map((e) => e.type)));
    const backTile = await waitTiles(people[i1].page, (t) => t.length === 1 && t[0].includes(w1), 90000);
    check(people[i1].name + ' sees the bot come back', backTile.ok, JSON.stringify(backTile.tiles));
    await people[i1].page.screenshot({ path: path.join(PROOF, people[i1].name.toLowerCase() + '-bot-back.png') });

    for (const w of backSt.bot.workers) if (w.pid) metrics['worker_' + w.worker + '_with_person'] = await usage(w.pid, 5000);
    say('per-worker cost with one person in each room: ' + JSON.stringify(metrics));
    fs.writeFileSync(path.join(PROOF, 'worker-cost.json'), JSON.stringify(metrics, null, 2) + '\n');

    // ---- end the worker-0 room ----
    const ended = await call('end_meeting', { meeting_id: r0.meeting_id });
    check('end_meeting ' + r0.name, ended.state === 'ended', ended.state);
    const gone0 = await waitTiles(people[1 - i1].page, (t) => t.length === 0, 45000);
    check(people[1 - i1].name + ' no longer sees a bot', gone0.ok);

    // ---- the supervisor dies with no shutdown (SIGKILL, OOM) ----
    // Each worker and its Chromium must go too, and the seat with them,
    // or a bot sits in the room that nothing can reach or end.
    const before = (await call('status')).bot.workers.filter((w) => w.pid).map((w) => w.pid);
    const trees = before.map((pid) => ({ pid, procs: procsUnder(pid) }));
    say('supervisor pid ' + transport.pid + '; workers ' + JSON.stringify(trees.map((t) => ({ pid: t.pid, processes: t.procs.length }))));
    process.kill(transport.pid, 'SIGKILL');
    const exitBy = Date.now() + 30000;
    let left = [];
    do {
      await sleep(500);
      left = trees.flatMap((t) => t.procs).filter(alive);
    } while (left.length && Date.now() < exitBy);
    check('killing the supervisor stops every worker and its whole Chromium tree', trees.length === 2 && left.length === 0,
      JSON.stringify({ workers: trees.map((t) => t.pid), still_running: left }));
    for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ } }
    const gone1 = await waitTiles(people[i1].page, (t) => t.length === 0, 60000);
    check(people[i1].name + ' sees the worker-1 bot leave when the supervisor dies', gone1.ok, JSON.stringify(gone1.tiles));
  } catch (e) {
    check('suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : String(e));
  } finally {
    for (const p of people) await p.browser.close().catch(() => {});
    await client.close().catch(() => {});
    site.close();
  }
  say(failures ? failures + ' FAILURE(S)' : 'ALL PASS');
  say('screenshots in ' + PROOF);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
