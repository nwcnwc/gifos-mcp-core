// Live proof: one guard bot with its own voice and picture holds a fresh room (mode admin, shared host password, so two
// processes are siblings). Run one process per bot:
//
//   ROOM=<room> HP=<host password> RANK=<0|1> NAME=<first name> VOICE=<kokoro id> PICTURE=<png> node test/e2e/guard-voice.js [seconds=600]
//
// Env: GIFOS_URL (default https://gifos.app), GIFOS_MCP_HOME (default a fresh folder). The lead greets newcomers aloud
// (policy voice) and in chat. Prints guard events and, every 20 s, the resident memory of this process tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRuntime } from '../../src/main.js';
import { startGuardsFromConfig } from '../../src/guard.js';
import { hostKey, meetingLink } from '../../src/links.js';

const secs = Number(process.argv[2] || 600);
const site = (process.env.GIFOS_URL || 'https://gifos.app').replace(/\/$/, '');
const { ROOM: room, HP: hp, NAME: name = 'Bot', VOICE: voice = '', PICTURE: picture = '' } = process.env;
const rank = Number(process.env.RANK || 0);
if (!room || !hp) { console.error('need ROOM and HP'); process.exit(2); }
const home = process.env.GIFOS_MCP_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'guard-voice-'));
const t0 = Date.now();
const say = (s) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's [' + name + '] ' + s);
const env = { ...process.env, GIFOS_URL: site, GIFOS_MCP_HOME: home, GIFOS_BOT_NAME: name, GIFOS_BOT_PASSWORD: 'bv-' + hp.slice(0, 12),
  GIFOS_STT_APP: 'none', GIFOS_ALWAYS_TRANSCRIBE: '0', GIFOS_ALWAYS_RECORD: '0' };
delete env.GIFOS_BOT_PICTURE;
const rt = await createRuntime(env);
rt.ctx.clock.start();
// A private room has its host key in the link (the same link for every sibling: same room, same host password).
const link = meetingLink(site, room, { verifier: (await hostKey(room, hp)).verifier });
say('LINK ' + link);
const conf = path.join(home, 'guard.json');
fs.writeFileSync(conf, JSON.stringify({ guards: [{ link, mode: 'admin', host_password: hp, rank, blur_all: true,
  greet: "Welcome, {names}! I'm " + name + ', a GifOS welcome bot, a program and not a person. Be kind.', voice, picture }] }));
const guards = await startGuardsFromConfig(rt.ctx, conf, { log: say, cfg: rt.cfg });
for (const g of guards) { const n = g.note.bind(g); g.note = (t, d) => { say(t + ' ' + JSON.stringify(d || {}).slice(0, 200)); return n(t, d); }; }
const rss = () => { try { return Math.round(execFileSync('ps', ['-eo', 'rss,args'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(home)).reduce((a, l) => a + Number(l.trim().split(/\s+/)[0] || 0), 0) / 1024); } catch { return -1; } };
const tick = setInterval(() => say('mem tree (rss MB, procs naming this home) ' + rss() + ' node ' + Math.round(process.memoryUsage().rss / 1048576)), 20000);
await new Promise((r) => setTimeout(r, secs * 1000));
clearInterval(tick); await rt.bot.close?.(); process.exit(0);
