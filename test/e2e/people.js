// Shared by the live e2e runs: process-tree cost from /proc, and "people"
// in Chromium (local or on another machine) whose fake microphone plays a
// tone the synthetic speech-to-text hears as one line per burst, or a speech
// clip for Whisper.
import fs from 'node:fs';
import { chromium } from 'playwright';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function procTable() {
  const kids = new Map();
  const stat = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const raw = fs.readFileSync('/proc/' + d + '/stat', 'utf8');
      const f = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(f[1]);
      stat.set(Number(d), { ticks: Number(f[11]) + Number(f[12]), rssPages: Number(f[21]) });
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(d));
    } catch (e) { /* the process exited */ }
  }
  return { kids, stat };
}

// Every pid under root, root included.
export function procsUnder(root) {
  const { kids } = procTable();
  const all = [];
  const walk = (p) => { all.push(p); for (const c of kids.get(p) || []) walk(c); };
  walk(root);
  return all;
}

// Every process under root (or only root). RSS in MB, CPU as ticks so far.
export function tree(root, only = false) {
  const { kids, stat } = procTable();
  const all = [];
  const walk = (p) => { all.push(p); if (!only) for (const c of kids.get(p) || []) walk(c); };
  walk(root);
  const page = 4096 / (1024 * 1024);
  let rss = 0, ticks = 0;
  for (const p of all) { const s = stat.get(p); if (s) { rss += s.rssPages * page; ticks += s.ticks; } }
  return { pids: all.length, rssMb: Math.round(rss), ticks };
}

export function alive(pid) {
  try {
    // A zombie still answers kill 0; it holds no browser and no seat.
    return !/^\S+ \(.*\) Z/.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8'));
  } catch (e) { return false; }
}

export async function usage(pid, ms, only = false) {
  const a = tree(pid, only);
  await sleep(ms);
  const b = tree(pid, only);
  const hz = 100;
  return { processes: b.pids, rss_mb: b.rssMb, cpu_pct: Math.round(((b.ticks - a.ticks) / hz) / (ms / 1000) * 100) };
}

// A fake microphone that plays a loud tone for 1.6s, then 1.6s of quiet.
export const TONE = `(() => {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const orig = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    const s = await orig(c);
    if (!c || !c.audio) return s;
    const ac = new AudioContext();
    const o = ac.createOscillator(); o.frequency.value = 440;
    const g = ac.createGain(); g.gain.value = 0;
    const d = ac.createMediaStreamDestination();
    o.connect(g); g.connect(d); o.start();
    let on = false;
    setInterval(() => { ac.resume(); on = !on; g.gain.value = on ? 0.6 : 0; }, 1600);
    for (const t of s.getAudioTracks()) { s.removeTrack(t); t.stop(); }
    s.addTrack(d.stream.getAudioTracks()[0]);
    return s;
  };
})();`;

// A fake microphone that plays the site's SPEECH_PATH clip, then 3s of quiet,
// over and over. The clip comes from the page's own origin, so a browser on
// another machine needs no file of its own.
export const SPEECH_PATH = '/e2e/speech.wav';
export const SPEECH = `(() => {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const orig = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    const s = await orig(c);
    if (!c || !c.audio) return s;
    const ac = new AudioContext();
    const d = ac.createMediaStreamDestination();
    const clip = fetch(${JSON.stringify(SPEECH_PATH)}).then((r) => r.arrayBuffer()).then((b) => ac.decodeAudioData(b));
    const play = async () => {
      const buf = await clip;
      ac.resume();
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(d);
      src.onended = () => setTimeout(play, 3000);
      src.start();
    };
    play();
    for (const t of s.getAudioTracks()) { s.removeTrack(t); t.stop(); }
    s.addTrack(d.stream.getAudioTracks()[0]);
    return s;
  };
})();`;

export const MEDIA_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];

// A browser for people: chromium.connect(ws) when ws is set, else local.
export async function peopleBrowser(ws) {
  return ws
    ? chromium.connect(ws, { headers: { 'x-playwright-launch-options': JSON.stringify({ headless: true, args: MEDIA_ARGS }) }, timeout: 60000 })
    : chromium.launch({ headless: true, args: MEDIA_ARGS });
}

// One person: its own context (name, mic) in the given browser. speech: the
// mic plays SPEECH instead of TONE.
export async function personIn(browser, name, log, speech = false) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] });
  await ctx.addInitScript({ content: 'try{localStorage.setItem("gifos_name",' + JSON.stringify(name) + ');localStorage.setItem("gifos_meet_bar","0");sessionStorage.setItem("gifos_appeared","1");}catch(e){}' });
  await ctx.addInitScript({ content: speech ? SPEECH : TONE });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('  [' + name + '] ' + e.message));
  return { name, ctx, page };
}

export async function botTiles(page) {
  return page.locator('.tile', { has: page.locator('.botbadge') }).allInnerTexts().catch(() => []);
}

export async function waitTiles(page, want, ms) {
  const end = Date.now() + ms;
  let tiles = [];
  while (Date.now() < end) {
    tiles = await botTiles(page);
    if (want(tiles)) return { ok: true, tiles };
    await sleep(500);
  }
  return { ok: false, tiles };
}
