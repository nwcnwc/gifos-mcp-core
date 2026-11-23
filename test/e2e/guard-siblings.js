// Live repro: two sibling guards (one shared credentials file, ranks 0 and 1, each in its own process and browser, as two
// computers run them) hold one fresh open room. Run one process per sibling:
//
//   CRED=<subscription or pass file> ROOM=<room> RANK=<0|1> NAME=<bot name> node test/e2e/guard-siblings.js [seconds=480]
//
// Env: GIFOS_URL (default https://gifos.app), GIFOS_MCP_HOME (default a fresh folder under the OS temp folder),
// RESTART_AT=<s>[,<s>...]: stop this sibling's whole runtime (browser too) at those seconds and start a fresh one, the
// way a service restart does. It prints every guard event, the role and ticket each tick when they change, and every
// payment-service join/renew the bot's browser makes (meeting tag, generation, answer), so a ticket that moves shows
// who moved it. It never prints the credentials. Exit 0 at the end; the caller scores the log (see guard-siblings.sh).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRuntime } from '../../src/main.js';
import { startGuardsFromConfig } from '../../src/guard.js';

const secs = Number(process.argv[2] || 480);
const site = (process.env.GIFOS_URL || 'https://gifos.app').replace(/\/$/, '');
const cred = path.resolve(process.env.CRED || '');
const room = process.env.ROOM;
const rank = Number(process.env.RANK || 0);
const name = process.env.NAME || 'Sibling ' + rank;
if (!room || !fs.existsSync(cred)) { console.error('need ROOM and CRED'); process.exit(2); }
const home = process.env.GIFOS_MCP_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'guard-sib-'));
const restartAt = String(process.env.RESTART_AT || '').split(',').map(Number).filter((n) => n > 0).sort((a, b) => a - b);
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const say = (s) => console.log(at() + ' [r' + rank + '] ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const conf = path.join(home, 'guard.json');
fs.writeFileSync(conf, JSON.stringify({ guards: [{ link: site + '/meet/' + room, mode: 'open', credentials: cred, password: null, blur_all: true, rank }] }));
const env = {
  ...process.env, GIFOS_URL: site, GIFOS_MCP_HOME: home, GIFOS_GUARD_CONFIG: conf, GIFOS_BOT_SIBLING: '1',
  GIFOS_BOT_NAME: name, GIFOS_BOT_PASSWORD: 'sb-' + crypto.randomBytes(9).toString('hex'),
  GIFOS_TTS_ENGINE: 'none', GIFOS_STT_APP: 'none', GIFOS_ALWAYS_TRANSCRIBE: '0', GIFOS_ALWAYS_RECORD: '0',
};
say('home ' + home + ' room ' + room + ' site ' + site + ' for ' + secs + 's restarts ' + (restartAt.join(',') || 'none'));

// Every payment-service meeting call this browser makes: which meeting (ours or another), the generation, the answer.
const watched = new WeakSet();
function watchNet(bot) {
  const app = bot && bot.bot && bot.bot.app;
  if (!app || app.isClosed()) return;
  const c = app.context();
  if (watched.has(c)) return;
  watched.add(c);
  c.on('requestfinished', async (req) => {
    const m = req.url().match(/\/gifos\/(pass|sub)\/(join|renew)$/);
    if (!m) return;
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
    let ans = {}; try { const r = await req.response(); ans = (r && await r.json()) || {}; } catch (e) {}
    let fr = '?'; try { const f = req.frame(); fr = f.url() === 'about:srcdoc' ? 'session' : f.url().replace(/[#?].*$/, '').replace(site, ''); } catch (e) {}
    const which = 'mtg:' + String(body.meeting || '').slice(0, 8);   // the payment service's meeting tag (meet-subs meetingTag)
    say('net ' + m[1] + '/' + m[2] + ' ' + which + ' frame=' + fr + ' sent_gen=' + (body.gen ?? '-') + (body.ifFree !== undefined ? ' ifFree=' + body.ifFree : '')
      + ' -> active=' + !!ans.active + ' gen=' + (ans.gen ?? '-') + (ans.moved ? ' MOVED' : '') + (ans.full ? ' FULL' : '') + (ans.ended ? ' ENDED' : ''));
  });
}

let rt = null, guards = [], netTimer = null, stateTimer = null, lastLine = '';
async function startRuntime() {
  rt = await createRuntime(env);
  const emit = rt.ctx.emit;
  rt.ctx.emit = (e) => { if (e && /^guard\./.test(e.type)) say('event ' + e.type + ' ' + JSON.stringify(e.data || {}).slice(0, 200)); return emit(e); };
  guards = await startGuardsFromConfig(rt.ctx, conf, { log: () => {} });
  netTimer = setInterval(() => watchNet(rt.bot), 500);
  stateTimer = setInterval(() => {
    const s = guards[0] && guards[0].status();
    if (!s) return;
    const sub = s.subscription || {};
    const line = 'role=' + s.role + ' cap=' + (s.capture ? (s.capture.on ? (s.capture.mine ? 'mine' : 'other') : 'off') : '-')
      + ' ticket=' + (sub.held ? 'held/' + sub.via : (sub.moved ? 'lost/' + sub.moved : 'none'));
    if (line !== lastLine) { lastLine = line; say('STATE ' + line); }
  }, 1000);
}
async function stopRuntime() {
  clearInterval(netTimer); clearInterval(stateTimer);
  for (const g of guards) g.stop();
  guards = [];
  if (rt) { rt.ctx.clock && rt.ctx.clock.stop && rt.ctx.clock.stop(); await rt.bot.close().catch(() => {}); }
  rt = null; lastLine = '';
}

await startRuntime();
for (const r of restartAt) {
  const wait = t0 + r * 1000 - Date.now();
  if (wait > 0) await sleep(wait);
  say('RESTART (the whole runtime and its browser, as a service restart)');
  await stopRuntime();
  await sleep(3000);
  await startRuntime();
}
const left = t0 + secs * 1000 - Date.now();
if (left > 0) await sleep(left);
const s = guards[0] && guards[0].status();
say('FINAL role=' + (s && s.role) + ' ticket=' + JSON.stringify((s && s.subscription) || null));
await stopRuntime();
process.exit(0);
