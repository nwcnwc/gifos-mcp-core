// Live repro: a guard whose bot browser loses its page, frame or whole browser must take its seat again by itself.
//
//   node test/e2e/guard-relaunch.js <update|reload|kill|closepage> [cycles=3] [recoverSec=150]
//
// Env: GIFOS_URL (default https://gifos.app), GUARD_ROOM (default a fresh random room), GIFOS_MCP_HOME (default a
// fresh folder under the OS temp folder). It runs one guard (mode admin, a random host password, no greeting) in this
// process on the real driver, waits until the bot is seated, then each cycle:
//   update     moves the bot's run.html to ANOTHER released version (/versions/<x>/run.html#id=...), what a site
//              deploy does to an open page (js/gifos-update.js go(), run.html askLive): the page, Meeting Bot's frame
//              and every meeting frame in it are replaced.
//   reload     reloads the bot's run.html in place (the same page, a new document).
//   kill       SIGKILLs the bot's own Chrome (the browser process this script launched, found by its profile folder).
//   closepage  closes the run.html tab.
// and then waits up to recoverSec for the guard to be seated again (a guard.state from a live meeting frame that says
// seated). Prints one line per guard event and a verdict per cycle; exit 0 only if every cycle recovered.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRuntime } from '../../src/main.js';
import { RoomGuard, normalizePolicy } from '../../src/guard.js';

const how = process.argv[2] || 'update';
const cycles = Number(process.argv[3] || 3);
const recoverMs = Number(process.argv[4] || 150) * 1000;
if (!['update', 'reload', 'kill', 'closepage'].includes(how)) { console.error('usage: guard-relaunch.js <update|reload|kill|closepage> [cycles] [recoverSec]'); process.exit(2); }

const site = (process.env.GIFOS_URL || 'https://gifos.app').replace(/\/$/, '');
const home = process.env.GIFOS_MCP_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'guard-relaunch-'));
const room = process.env.GUARD_ROOM || 'relaunch' + crypto.randomBytes(4).toString('hex');
const env = {
  ...process.env, GIFOS_URL: site, GIFOS_MCP_HOME: home,
  GIFOS_BOT_NAME: process.env.GIFOS_BOT_NAME || 'Relaunch Probe', GIFOS_BOT_PASSWORD: process.env.GIFOS_BOT_PASSWORD || 'rp-' + crypto.randomBytes(9).toString('hex'),
  GIFOS_TTS_ENGINE: 'none', GIFOS_STT_APP: 'none', GIFOS_ALWAYS_TRANSCRIBE: '0', GIFOS_ALWAYS_RECORD: '0',
};
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const say = (s) => console.log(at() + ' ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

say('home ' + home + ' room ' + room + ' site ' + site + ' how ' + how + ' cycles ' + cycles);
const rt = await createRuntime(env);
const { ctx, bot } = rt;
const emit = ctx.emit;
ctx.emit = (e) => { if (e && /^guard\./.test(e.type)) say('event ' + e.type + ' ' + JSON.stringify(e.data || {}).slice(0, 160)); return emit(e); };
const guard = new RoomGuard(ctx, normalizePolicy({ link: site + '/meet/' + room, mode: 'admin', host_password: 'hp-' + crypto.randomBytes(9).toString('hex'), greet: false, blur_all: false }, home), { log: () => {} });
await guard.start();

// Seated now: the last guard tick read a live meeting frame that says the bot sits in the room.
let lastSeatedAt = 0;
const origRoom = bot.room.bind(bot);
bot.room = async (sid, op, args) => {
  const v = await origRoom(sid, op, args);
  if (op === 'guard.state' && v && v.seated) lastSeatedAt = Date.now();
  return v;
};
const seatedNow = () => Date.now() - lastSeatedAt < 7000;
async function waitSeated(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (seatedNow()) return true; await sleep(500); }
  return false;
}

function chromePid() {
  // The browser this process launched: a direct child whose command line holds this run's profile folder.
  const out = execFileSync('ps', ['-o', 'pid=,args=', '--ppid', String(process.pid)], { encoding: 'utf8' });
  const rows = out.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => ({ pid: Number(l.split(/\s+/)[0]), args: l.slice(l.indexOf(' ') + 1) }))
    .filter((r) => /chrom/i.test(r.args) && r.args.includes('--user-data-dir=' + path.join(home, 'profile-bot')));
  return rows.length === 1 ? rows[0].pid : 0;
}

async function disrupt() {
  const app = bot.bot && bot.bot.app;
  if (how === 'kill') {
    const pid = chromePid();
    if (!pid) throw new Error('could not find exactly one bot Chrome under this process');
    const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ');
    if (!/chrom/i.test(cmd) || !cmd.includes(home)) throw new Error('pid ' + pid + ' is not this run\'s Chrome');
    say('kill -9 ' + pid + ' (this run\'s Chrome)');
    process.kill(pid, 'SIGKILL');
    return;
  }
  if (!app || app.isClosed()) throw new Error('no run.html page to disrupt');
  if (how === 'closepage') { say('closing the run.html tab'); await app.close(); return; }
  if (how === 'reload') { say('reloading run.html'); await app.evaluate(() => location.reload()); return; }
  // update: move to another released version, the way a deploy moves an open page.
  const here = app.url();
  const vj = await (await fetch(site + '/version.json', { cache: 'no-store' })).json();
  const vs = (vj.versions || []).slice(0, 2);
  const m = here.match(/\/versions\/([^/]+)\//);
  const cur = m ? m[1] : '';
  const to = vs.find((v) => v !== cur) || vj.latest;
  const url = m ? here.replace('/versions/' + cur + '/', '/versions/' + to + '/') : site + '/versions/' + to + '/run.html' + new URL(here).hash;
  say('site update: run.html ' + (cur || '(root)') + ' -> ' + to);
  await app.evaluate((u) => location.replace(u), url);
}

let pass = 0;
if (!(await waitSeated(180000))) { say('VERDICT never seated at the start'); process.exit(3); }
say('seated (start)');
for (let i = 1; i <= cycles; i++) {
  await sleep(5000);
  await disrupt().catch((e) => say('disrupt failed: ' + e.message));
  await sleep(8000);   // let the guard see the loss
  const t = Date.now();
  const ok = await waitSeated(recoverMs);
  say('VERDICT cycle ' + i + ' ' + how + ': ' + (ok ? 'RECOVERED in ' + ((Date.now() - t + 8000) / 1000).toFixed(1) + 's' : 'NOT RECOVERED within ' + (recoverMs / 1000 + 8) + 's'));
  if (ok) pass++; else break;
}
say('RESULT ' + how + ' ' + pass + '/' + cycles + ' recovered');
guard.stop();
await bot.close().catch(() => {});
process.exit(pass === cycles ? 0 : 1);
