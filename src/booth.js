// The booth: the host's own seat in a GifOS broadcast (the /cast page), in a headless Chromium on this computer.
// It drives the page the way a host does, through the page's own buttons: Rebroadcast plays video files into the
// broadcast (viewers see Prerecorded), and "Publish to GifOS.tv" lists the broadcast on gifos.tv, after which the page
// itself keeps the listing live while its host is in the room.
//
// A booth is made to run for days:
//   - play_video takes one file or a list, and can loop the list. The next file starts the moment one ends.
//   - A file that "ends" well before its length (a decoder that gave up on a bad spot) is not the end: the page never
//     hears that ended, and the video jumps past the spot and plays on. If it stops early anyway, the same file starts
//     again past the spot (five tries at one place, then the next file).
//   - A video that says it plays but has not moved for 20 s, a page that crashed or lost its hooks, a seat that is not
//     the host for 2 minutes, and a new live GifOS release all reload the page in place: the same profile, the same
//     room, and the same file from the same second.
// Each booth has its own browser profile (GIFOS_MCP_HOME/booth-<room>), so the host key, a credentials file loaded
// into it and the "listed on gifos.tv" mark survive a restart of this server. Nothing here talks to anything but the
// GifOS site, its relay and gifos.tv (the page's own requests).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { launchInstalled } from './browser.js';
import { log } from './log.js';
import { createHash } from 'node:crypto';

const credSha = (b64) => createHash('sha256').update(String(b64 || '')).digest('hex');

const POLL_MS = 1000;
const HOST_WAIT_MS = 90000;      // a fresh page must be the host with its relay up within this
const NOT_HOST_MAX_MS = 120000;  // seated but not the host (or no relay) this long: reload in place
const PAGE_BACK_MS = 45000;      // the page went away (it reloads itself for a release): wait this long, then reload
const STALL_MS = 20000;          // "sending" but the position stood still this long: reload in place
const START_FAILS_MAX = 5;       // files in a row that would not start: the booth reports itself broken
const EARLY_S = 8;               // an end more than this many seconds before the length is a bad spot, not the end
const EARLY_TRIES = 5;           // tries at one bad spot before moving on to the next file
const SITE_CHECK_MS = 10 * 60 * 1000;
const YIELD_CLEAR_MS = 1500;     // filler mode: the Stage free of people this long, then the video goes on

// Runs INSIDE the page (stringified into the init script). Each <video> the page makes gets:
//  - resume: window.__boothSeek set means jump there on loadedmetadata, before it plays (the page has no start input);
//  - a trace: window.__boothEv keeps the last 60 media events for booth_status;
//  - the bad-spot guard: an "ended" more than EARLY_S before the length never reaches the page; the video jumps past
//    the spot (2, 5, 15, 30 s on repeats within a minute) and plays on.
function videoHook(earlyS) {
  const ce = document.createElement.bind(document);
  window.__boothEv = window.__boothEv || [];
  let bumps = 0, lastBump = 0;
  document.createElement = function (t) {
    const e = ce.apply(null, arguments);
    if (String(t).toLowerCase() !== 'video') return e;
    window.__boothVideos = (window.__boothVideos || []).slice(-3).concat([e]);   // the rebroadcast's video is never in the page
    const note = (k, x) => {
      const ev = window.__boothEv;
      ev.push(Object.assign({ at: Date.now(), k, pos: Math.round(e.currentTime * 10) / 10, dur: Math.round(e.duration || 0), rs: e.readyState, err: e.error ? e.error.code + ':' + String(e.error.message || '').slice(0, 80) : null }, x || {}));
      if (ev.length > 60) ev.shift();
    };
    e.addEventListener('loadedmetadata', function () {
      const s = window.__boothSeek;
      if (typeof s === 'number' && s > 0 && isFinite(e.duration)) { try { e.currentTime = Math.min(s, Math.max(0, e.duration - 2)); } catch (x) { /* plays from 0 */ } }
      window.__boothSeek = 0;
      note('loadedmetadata');
    }, { once: true });
    for (const k of ['error', 'stalled', 'emptied', 'abort']) e.addEventListener(k, () => note(k));
    e.addEventListener('ended', function (ev) {
      const d = e.duration, p = e.currentTime;
      note('ended');
      if (!(isFinite(d) && d > 0 && p < d - earlyS)) return;   // the real end: the page moves on
      ev.stopImmediatePropagation();
      const now = Date.now();
      bumps = now - lastBump < 60000 ? bumps + 1 : 0; lastBump = now;
      const step = [2, 5, 15, 30][Math.min(bumps, 3)];
      window.__boothSkips = (window.__boothSkips || 0) + 1;
      note('skip', { step });
      try { e.currentTime = Math.min(p + step, d - 3); const pr = e.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (x) { /* the booth sees an early end */ }
    });
    return e;
  };
}

// Read in the page: what the host page shows. Runs INSIDE the browser.
function pageState() {
  const g = window.__gifosVideo;
  if (!g || typeof g.amAdmin !== 'function') return { gone: true };
  const txt = (id) => { const x = document.getElementById(id); return x ? x.textContent.trim() : ''; };
  let rb = null; try { rb = typeof g.rebroadcastForTest === 'function' ? g.rebroadcastForTest() : null; } catch (e) { rb = null; }
  let host = false; try { host = !!g.amAdmin(); } catch (e) { host = false; }
  let relay = false; try { relay = !!(g.relayUp && g.relayUp()); } catch (e) { relay = false; }
  let tv = null;
  try {
    const s = window.GifOS && GifOS.tvPublish && GifOS.tvPublish._state ? GifOS.tvPublish._state() : null;
    if (s) tv = { listed: !!s.listed, url: s.listed ? s.listed.url : null, delisted: !!(s.listed && s.listed.delisted), on_air: !!s.onAirFor, keep_due_in_s: s.keepDue ? Math.round((s.keepDue - Date.now()) / 1000) : null };
  } catch (e) { tv = null; }
  const ver = /\/versions\/([0-9.]+)\//.exec(location.pathname);
  return {
    host, relay, rb, tv,
    hooks: typeof g.rebroadcastForTest === 'function',
    broadcast: document.body.classList.contains('broadcast'),
    watching: txt('airwho'),
    status: txt('status'),
    page_version: ver ? ver[1] : '',
    skips: window.__boothSkips || 0,
    // The rebroadcast's No blur pick (#rb-blur): shown only while the room's clear right lets viewers tap to unblur.
    no_blur: (() => { const b = document.getElementById('rb-blur'); return !b ? 'not offered' : b.getAttribute('aria-pressed') === 'true' ? 'picked' : 'offered'; })(),
    // The room's clear right as this page reads it: 'stage' (the host showed Clear Stage), 'all', or '' (viewers get a
    // blurred picture whatever the host picks).
    clear_right: (() => { try { const c = g.clearStateForTest ? g.clearStateForTest() : null; return c ? c.mode || '' : null; } catch (e) { return null; } })(),
    // Who else is on the Stage (a person who stepped up: a co-host, or someone the host let up).
    others: (() => { try { const i = g.stageInfo ? g.stageInfo() : null; return i && Array.isArray(i.stagers) ? i.stagers.filter((x) => !x.me).map((x) => x.name || 'someone') : []; } catch (e) { return []; } })(),
  };
}

// Runs INSIDE the host page: gifos.tv orders with the GifOS site's own signing, proof of work and canvas.
async function tvInPage({ op, seed, rk, f }) {
  const net = window.GifOS && GifOS.net;
  const API = String((window.GifOS && GifOS.tvPublish && GifOS.tvPublish.api) || window.GIFOS_TV_API || 'https://gifos.tv').replace(/\/+$/, '');
  const KEY = 'gifos_tv:' + rk;
  const [name, v] = rk.split('.');
  const readListing = async () => {
    const r = await fetch(API + '/api/l/' + name + '/' + v, { credentials: 'omit', cache: 'no-store' });
    if (r.status === 404) return null;
    const j = await r.json().catch(() => ({}));
    return j.listing || null;
  };
  try {
    if (op === 'read') return { ok: true, listing: await readListing() };
    if (!net || typeof net.edKeysFromSeedHex !== 'function' || typeof net.edSign !== 'function') return { ok: false, error: 'This GifOS page cannot sign gifos.tv orders.' };
    const keys = await net.edKeysFromSeedHex(seed);
    const sign = async (act, extra) => { const sp = JSON.stringify(Object.assign({ act, ts: Date.now(), room: rk, by: 'mcp' }, extra || {})); return { sp, sig: await net.edSign(keys.priv, sp), pub: keys.pubB64 }; };
    const post = async (w, jt) => { const r = await fetch(API + '/api/order', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ w, jt: jt || undefined }) }); const j = await r.json().catch(() => ({})); j.status = r.status; return j; };
    if (op === 'unlist') {
      const j = await post(await sign('tvunlist', {}));
      if (!j.ok && j.status !== 404) return { ok: false, error: 'gifos.tv did not take the stop: ' + (j.error || j.status) };
      try { localStorage.removeItem(KEY); } catch (e) { /* no storage */ }
      return { ok: true, listed: false };
    }
    // The person check, as the page earns it for gifos.tv.
    const ticket = net.relayTicket({ relayBase: API + '/api', sid: 'tv' });
    const dev = Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => b.toString(16).padStart(2, '0')).join('');
    const token = async () => { await ticket.prepare(dev); return ticket.token(dev); };
    // The thumbnail: a picture file or a still of the Stage, drawn to 640x360 (cover) and kept under 240 KB.
    let canvas = null;
    const cover = (src, sw, sh) => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 640, 360); const s = Math.max(640 / sw, 360 / sh); g.drawImage(src, (640 - sw * s) / 2, (360 - sh * s) / 2, sw * s, sh * s); return c; };
    if (f.thumbB64) {
      const blob = new Blob([Uint8Array.from(atob(f.thumbB64), (c) => c.charCodeAt(0))]);
      const bmp = await createImageBitmap(blob).catch(() => null);
      if (!bmp) return { ok: false, error: 'That thumbnail is not a picture this browser can read.' };
      canvas = cover(bmp, bmp.width, bmp.height);
    } else if (f.fromStage) {
      let best = null, area = 0;
      for (const vid of Array.from(document.querySelectorAll('video')).concat(window.__boothVideos || [])) {
        if (!vid.videoWidth || vid.readyState < 2) continue;
        const a = vid.videoWidth * vid.videoHeight;
        if (a > area) { area = a; best = vid; }
      }
      if (!best) return { ok: false, error: 'Nothing is showing on the Stage yet: play a video first, or give a thumbnail file.' };
      canvas = cover(best, best.videoWidth, best.videoHeight);
    }
    let thumb = '';
    let jt = await token();
    // The thumbnail is checked for sexually explicit content on this computer first, by the GifOS page's own on-device
    // check (the same one a host's page runs); gifos.tv takes no thumbnail without its verdict. A picture that trips it,
    // or that could not be checked, is not uploaded and the listing uses the standard picture.
    let verdict = null, thumbNote = '';
    if (canvas) {
      // The page loads its check only when a person picks a picture; the booth loads it the same way the page does (from
      // beside the page's tv-publish.js, else the site's /js/), so a booth thumbnail is checked, not dropped as unchecked.
      if (window.GifOS && !GifOS.explicit) {
        const tp = Array.from(document.scripts).map((x) => x.src).find((u) => /\/tv-publish\.js(\?|$)/.test(u || ''));
        const src = tp ? tp.replace(/tv-publish\.js(\?.*)?$/, 'gifos-explicit.js') : new URL('/js/gifos-explicit.js', location.href).href;
        await new Promise((res) => { const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = res; document.head.appendChild(sc); });
      }
      const E = window.GifOS && GifOS.explicit;
      const r = E ? await E.checkStill(canvas).catch(() => null) : null;
      if (r && r.ok && r.verdict) verdict = r.verdict;
      else { canvas = null; thumbNote = r ? 'The thumbnail was not used: it may show nudity or sexual content. The listing uses the standard picture.' : 'The thumbnail was not used: this page could not check it. The listing uses the standard picture.'; }
    }
    if (canvas) {
      let blob = null;
      for (const q of [0.85, 0.75, 0.6, 0.45]) { blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', q)); if (blob && blob.size <= 240 * 1024) break; }
      const bytes = await blob.arrayBuffer();
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((b) => b.toString(16).padStart(2, '0')).join('');
      const r = await fetch(API + '/api/thumb', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'image/jpeg', 'x-gifos-jt': jt || '', 'x-gifos-order': JSON.stringify(await sign('tvthumb', { sha, chk: verdict })) }, body: bytes });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) return { ok: false, error: 'The thumbnail did not upload: ' + (j.error || r.status) };
      thumb = j.thumb;
      jt = await token();
    } else if (f.keepThumb) thumb = f.keepThumb;
    // The kind, as the page shows it: Prerecorded while the Rebroadcast plays (the page's own on-air notes keep it current).
    const kind = document.body.classList.contains('rb-on') ? 'pre' : 'live';
    const j = await post(await sign('tvlist', { title: f.title, desc: f.desc || '', thumb, tip: f.tip || '', pw: f.pw ? 1 : 0, cat: f.cat || 'chat', tags: Array.isArray(f.tags) ? f.tags.slice(0, 3) : [], lang: f.lang || 'en', k: kind }), jt);
    if (!j.ok) return { ok: false, error: 'The listing was not published: ' + (j.error || j.status) };
    // The page's own "listed" mark: from here the page goes on air and keeps the listing live while it hosts.
    try { localStorage.setItem(KEY, JSON.stringify({ url: j.url, at: Date.now(), delisted: !!j.delisted })); } catch (e) { /* no storage */ }
    return { ok: true, url: j.url, delisted: !!j.delisted, thumb: j.thumb != null ? j.thumb : thumb, thumb_note: thumbNote || undefined, listing: await readListing() };
  } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 300) }; }
}

export class BoothPool {
  // cfg: the core config (home, gifosUrl, relay, chrome, headless). site: ctx.site (the live release), optional.
  constructor(cfg, { site, launch } = {}) {
    this.cfg = cfg;
    this.site = site || null;
    this.launchFn = launch || null;
    this.booths = new Map();
  }

  get(id) { return this.booths.get(String(id || '')) || null; }
  list() { return Array.from(this.booths.values()); }

  // room, verifier, seedHex: the broadcast and its host key. name: the seat's name. credentialsB64: a credentials GIF.
  async open({ room, verifier, seedHex, name, credentialsB64 }) {
    const had = this.booths.get(room);
    if (had && !had.closed) {
      if (had.verifier !== verifier) throw new Error('A booth is already open for ' + room + ' with another host key. Close it first.');
      return had;
    }
    const b = new Booth(this, { room, verifier, seedHex, name: name || 'Host', credentialsB64: credentialsB64 || '' });
    this.booths.set(room, b);
    try { await b.start(); } catch (e) { await b.close().catch(() => {}); throw e; }
    return b;
  }

  async closeAll() { for (const b of this.list()) await b.close().catch(() => {}); }
}

export class Booth {
  constructor(pool, o) {
    this.pool = pool;
    this.cfg = pool.cfg;
    this.room = o.room;
    this.verifier = o.verifier;
    this.seedHex = o.seedHex;
    this.name = o.name;
    this.credB64 = o.credentialsB64;
    this.ctx = null;
    this.page = null;
    this.closed = false;
    this.loadedOn = '';          // the live release when the page was (re)loaded
    this.lastSiteCheck = 0;
    this.list = null;            // { files: [abs], loop, i, clear }
    this.playing = null;         // { i, file, pos, len, movedAt }
    this.resume = null;          // { i, file, pos } to start next instead of the next file
    this.early = { file: '', at: 0, n: 0 };
    this.fails = 0;
    this.notHostSince = 0;
    this.goneSince = 0;
    this.counts = { plays: 0, ends: 0, skips: 0, early: 0, reloads: 0, yields: 0 };
    this.yielded = null;         // { since, to: [names], clearSince } while the booth leaves the Stage to people
    this.lastEvent = null;
    this.lastError = '';
    this.loop = null;
    this.busy = Promise.resolve();
  }

  base() { return String(this.cfg.gifosUrl || 'https://gifos.app').replace(/\/+$/, ''); }
  // The broadcast PAGE is the broadcast (GifOS docs/links.md): /cast#room=&v= on gifos.app, cast.html#… on a local site.
  link() {
    const routed = /(^|\.)gifos\.app$/i.test(new URL(this.base()).hostname);
    return this.base() + (routed ? '/cast' : '/cast.html') + '#room=' + this.room + '&v=' + this.verifier;
  }
  note(ev, data) {
    this.lastEvent = { t: new Date().toISOString(), ev, ...(data || {}) };
    log('booth ' + this.room + ': ' + ev + (data ? ' ' + JSON.stringify(data) : ''));
  }

  async start() {
    const dir = path.join(this.cfg.home, 'booth-' + this.room);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const args = ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-translate',
      '--disable-component-update', '--disable-breakpad', '--mute-audio', '--disk-cache-size=8000000'];
    const opts = { headless: this.cfg.headless !== false, args, viewport: { width: 960, height: 540 }, permissions: [] };
    const started = this.pool.launchFn ? { browser: await this.pool.launchFn(dir, opts), used: 'test' }
      : await launchInstalled((o) => chromium.launchPersistentContext(dir, o), opts, this.cfg);
    this.ctx = started.browser;
    this.ctx.setDefaultTimeout(30000);
    const keep = {
      ['gifos_vadm_' + this.room + '.' + this.verifier]: this.seedHex,
      gifos_name: this.name,
      gifos_meet_bar: '0',
    };
    if (this.cfg.relay) keep.gifos_relay = this.cfg.relay;
    // Each load: the host key, the seat's name, no "how you look" card, every tool in the dock, the bad-spot guard.
    await this.ctx.addInitScript({
      content: 'try{var k=' + JSON.stringify(keep) + ';for(var n in k)localStorage.setItem(n,k[n]);'
        + 'sessionStorage.setItem("gifos_appear_ok","1");sessionStorage.setItem("gifos_appeared","1");sessionStorage.setItem("gifos_more_tools","1");}catch(e){}'
        + 'try{(' + videoHook.toString() + ')(' + EARLY_S + ');}catch(e){}',
    });
    this.page = this.ctx.pages()[0] || await this.ctx.newPage();
    this.watchPage();
    if (this.credB64) await this.loadCredentials();
    await this.join();
    this.loop = this.run();
    this.loop.catch((e) => { this.lastError = String((e && e.message) || e).slice(0, 300); this.note('stopped', { why: this.lastError }); });
    this.note('open', { link: this.link() });
  }

  watchPage() {
    this.page.on('crash', () => { this.crashed = true; this.note('page.crash'); });
    this.page.on('dialog', (d) => d.dismiss().catch(() => {}));
  }

  // A credentials file goes into the profile the way Settings > Subscription takes one. Taken again whenever the file's
  // bytes differ from the ones this profile last took (credentials.sha in the profile), so a new pass (one that adds
  // Clear Stage, say) replaces the old one on the next open: the page keeps the better pass (the best-plan rule).
  // The same file is not loaded twice.
  async loadCredentials() {
    const shaFile = path.join(this.cfg.home, 'booth-' + this.room, 'credentials.sha');
    const sha = credSha(this.credB64);
    let had = ''; try { had = fs.readFileSync(shaFile, 'utf8').trim(); } catch (e) { had = ''; }
    if (had === sha) { this.note('credentials', { loaded: false, same_file: true }); return; }
    await this.page.goto(this.base() + '/run.html', { waitUntil: 'load' });
    await this.page.waitForFunction(() => window.GifOS && GifOS.meetSubs && typeof GifOS.meetSubs.useFile === 'function', null, { timeout: 60000 })
      .catch(() => { throw new Error('This GifOS site cannot take a credentials file.'); });
    const r = await this.page.evaluate(async (b64) => {
      const M = GifOS.meetSubs;
      const st = await M.useFile(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      let n = 0; try { n = (await M.passes()).length; } catch (e) { n = 0; }
      const took = st && st.took && st.took.passes ? st.took.passes : null;
      return { loaded: true, added: took ? took.added : null, in_use: took ? !!took.inUse : null, passes: n };
    }, this.credB64);
    try { fs.writeFileSync(shaFile, sha + '\n', { mode: 0o600 }); } catch (e) { /* loaded again next time */ }
    this.note('credentials', r);
  }

  hostedNow() {
    return this.page.waitForFunction(() => { const g = window.__gifosVideo; return !!(g && g.amAdmin && g.amAdmin() && g.relayUp && g.relayUp()); }, null, { timeout: HOST_WAIT_MS });
  }

  async join() {
    await this.page.goto(this.link(), { waitUntil: 'load' });
    await this.hostedNow().catch(() => { throw new Error('The booth did not become the host of this broadcast within ' + (HOST_WAIT_MS / 1000) + ' s. Check the host password.'); });
    this.loadedOn = this.siteLatest();
    this.notHostSince = 0; this.goneSince = 0; this.crashed = false;
  }

  // The same page again: same profile, room and host key. A crashed page is replaced.
  async reload(why) {
    this.counts.reloads++;
    this.note('reload', { why });
    if (this.playing) this.resume = { i: this.playing.i, file: this.playing.file, pos: this.playing.pos };
    this.playing = null;
    if (this.crashed) { await this.page.close().catch(() => {}); this.page = await this.ctx.newPage(); this.watchPage(); }
    try { await this.page.reload({ waitUntil: 'load' }); } catch (e) { await this.page.goto(this.link(), { waitUntil: 'load' }); }
    await this.hostedNow();
    this.loadedOn = this.siteLatest();
    this.notHostSince = 0; this.goneSince = 0; this.crashed = false;
  }

  siteLatest() { try { return this.pool.site && this.pool.site.latest ? String(this.pool.site.latest() || '') : ''; } catch (e) { return ''; } }
  async siteMoved() {
    let latest = this.siteLatest();
    if (!this.pool.site && Date.now() - this.lastSiteCheck > SITE_CHECK_MS) {
      this.lastSiteCheck = Date.now();
      try { const r = await fetch(this.base() + '/version.json', { cache: 'no-store' }); latest = String((await r.json()).latest || ''); } catch (e) { latest = ''; }
      if (latest && !this.loadedOn) this.loadedOn = latest;
    }
    return !!latest && !!this.loadedOn && latest !== this.loadedOn ? latest : '';
  }

  need() {
    if (this.closed) throw new Error('The booth for ' + this.room + ' is closed.');
    if (this.broken) throw new Error('The booth for ' + this.room + ' stopped: ' + this.lastError);
  }

  async read() { return this.page.evaluate(pageState).catch((e) => ({ gone: true, err: String((e && e.message) || e).slice(0, 160) })); }

  // Close the notices a host acknowledges (the recording notice, a blur explanation).
  async ackNotices() {
    await this.page.evaluate(() => { for (const id of ['rec-notice-ok', 'blurwhy-ok']) { const b = document.getElementById(id); if (b && b.offsetParent !== null) b.click(); } }).catch(() => {});
  }

  // The host's No blur pick for a rebroadcast (#rb-blur), offered where the room's clear right lets viewers see it clear.
  async pickNoBlur() {
    const want = await this.page.evaluate(() => { const b = document.getElementById('rb-blur'); return !!(b && b.getAttribute('aria-pressed') === 'false' && b.getClientRects().length); }).catch(() => false);
    if (!want) return;
    await this.page.locator('#rb-blur').click({ timeout: 3000 }).then(() => this.note('noblur'), () => {});
    await this.ackNotices();
  }

  // One file through the page's own Rebroadcast sheet ("Choose a video"), from startAt seconds.
  async startFile(file, startAt) {
    await this.ackNotices();
    const opened = await this.page.evaluate(() => {
      const g = window.__gifosVideo;
      if (g && g.rebroadcastForTest && g.rebroadcastForTest()) return 'busy';
      const b = document.getElementById('rbbtn');
      if (!b) return 'This GifOS page has no Rebroadcast button.';
      b.click();
      return document.getElementById('rb-file') ? 'ok' : 'The Rebroadcast sheet did not open.';
    });
    if (opened !== 'ok') return { ok: false, why: opened };
    await this.page.evaluate((s) => { window.__boothSeek = s || 0; }, startAt || 0);
    await this.page.setInputFiles('#rb-file', file);
    const up = await this.page.waitForFunction(() => { const g = window.__gifosVideo; const r = g && g.rebroadcastForTest && g.rebroadcastForTest(); return !!(r && r.sending && !r.paused); }, null, { timeout: 30000 }).then(() => true, () => false);
    if (!up) return { ok: false, why: 'the video did not start' };
    const r = await this.page.evaluate(() => window.__gifosVideo.rebroadcastForTest()).catch(() => null);
    return { ok: true, pos: r ? r.pos : 0, len: r ? r.len : 0 };
  }

  // files: absolute paths. Replaces what plays now.
  async play(files, { loop = false, startAt = 0, clear = true, yieldToPeople = false } = {}) {
    this.need();
    for (const f of files) if (!fs.existsSync(f) || !fs.statSync(f).isFile()) throw new Error('No video file at ' + f + '.');
    // What played before stops first; with no list the loop does not take that stop for an early end.
    this.list = null; this.playing = null; this.resume = null; this.yielded = null;
    const st = await this.read();
    if (st.rb) await this.stopNow();
    this.list = { files, loop: !!loop, i: -1, clear: clear !== false, yieldToPeople: !!yieldToPeople };
    this.resume = startAt > 0 ? { i: 0, file: files[0], pos: startAt } : null;
    this.fails = 0;
    this.wake();
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && !this.playing && !this.broken) await new Promise((r) => setTimeout(r, 250));
    if (!this.playing) throw new Error('The video did not start' + (this.lastError ? ': ' + this.lastError : '.'));
    return this.state();
  }

  async stopNow() {
    await this.page.evaluate(() => { const b = document.getElementById('rb-stop'); if (b) b.click(); }).catch(() => {});
    await this.page.waitForFunction(() => { const g = window.__gifosVideo; return !(g && g.rebroadcastForTest && g.rebroadcastForTest()); }, null, { timeout: 10000 }).catch(() => {});
  }

  async stop() {
    this.need();
    this.list = null; this.playing = null; this.resume = null; this.yielded = null;
    await this.stopNow();
    return this.state();
  }

  wake() { if (this.wakeFn) this.wakeFn(); }

  // The booth's own loop: keeps the seat the host, the list playing, and the page on the live release.
  async run() {
    let fatalFails = 0;
    while (!this.closed) {
      try {
        await this.tick();
        fatalFails = 0;
      } catch (e) {
        const m = String((e && e.message) || e).slice(0, 300);
        this.lastError = m;
        this.note('trouble', { m });
        if (this.closed) return;
        if (++fatalFails >= 3) { this.broken = true; throw new Error(m); }
        await this.reload('trouble: ' + m).catch((x) => { this.lastError = String((x && x.message) || x).slice(0, 300); });
      }
      if (this.closed) return;
      // Wake at once when a video ends (checked in the page every 100 ms), or when play_video asks; else after a poll.
      await new Promise((resolve) => {
        const t = setTimeout(resolve, POLL_MS);
        this.wakeFn = () => { clearTimeout(t); this.wakeFn = null; resolve(); };
        // In filler mode a person stepping onto the Stage wakes it too, so the booth gives way within a moment.
        const yieldNow = !!(this.list && this.list.yieldToPeople && !this.yielded);
        if (this.playing) this.page.waitForFunction((y) => {
          const g = window.__gifosVideo;
          if (!g || !g.rebroadcastForTest || !g.rebroadcastForTest()) return true;
          if (!y || !g.stageInfo) return false;
          try { const i = g.stageInfo(); return !!(i && i.stagers && i.stagers.some((x) => !x.me)); } catch (e) { return false; }
        }, yieldNow, { timeout: POLL_MS, polling: 100 }).then(() => this.wake(), () => {});
      });
      this.wakeFn = null;
    }
  }

  async tick() {
    if (this.crashed) return this.reload('the page crashed');
    const st = await this.read();
    const now = Date.now();
    if (st.gone || !st.hooks) {
      // The page is away (it reloads itself for a release), mid-navigation, or lost a hook: wait, then reload.
      if (!this.goneSince) this.goneSince = now;
      if (now - this.goneSince < PAGE_BACK_MS) return;
      return this.reload('the page went away');
    }
    this.goneSince = 0;
    if (!st.host || !st.relay) {
      if (!this.notHostSince) this.notHostSince = now;
      if (now - this.notHostSince > NOT_HOST_MAX_MS) return this.reload(st.relay ? 'not the host' : 'no relay');
      return;
    }
    this.notHostSince = 0;
    if (st.skips > this.counts.skips) { this.counts.skips = st.skips; this.note('skip', { file: this.playing && path.basename(this.playing.file), trace: await this.trace(6) }); }
    const moved = await this.siteMoved();
    if (moved) return this.reload('GifOS moved to ' + moved);
    if (!this.list) return;
    // Filler mode: a person on the Stage has it. The video stops at once and the booth steps off (it never fights for
    // the Stage); once the Stage has been free of people for a moment, the same video goes on from the same second.
    if (this.list.yieldToPeople) {
      if (st.others.length) {
        if (!this.yielded) {
          if (this.playing) this.resume = { i: this.playing.i, file: this.playing.file, pos: st.rb ? st.rb.pos : this.playing.pos };
          this.playing = null;
          this.yielded = { since: now, to: st.others, clearSince: 0 };
          this.counts.yields++;
          if (st.rb) await this.stopNow();
          await this.page.evaluate(() => { try { window.__gifosVideo.stageForTest(false); } catch (e) { /* not on the Stage */ } }).catch(() => {});
          this.note('yield', { to: st.others, at: this.resume ? Math.round(this.resume.pos) : null });
        } else { this.yielded.to = st.others; this.yielded.clearSince = 0; }
        return;
      }
      if (this.yielded) {
        if (!this.yielded.clearSince) this.yielded.clearSince = now;
        if (now - this.yielded.clearSince < YIELD_CLEAR_MS) return;
        this.note('resume', { after_s: Math.round((now - this.yielded.since) / 1000) });
        this.yielded = null;
      }
    }
    // The seat stays on the Stage between videos, so a video's end is only a source swap.
    if (!st.rb) await this.page.evaluate(() => { try { window.__gifosVideo.stageForTest(true); } catch (e) { /* the Rebroadcast sheet steps up itself */ } }).catch(() => {});
    if (st.rb) {
      if (this.playing) {
        if (this.playing.pos !== st.rb.pos || st.rb.paused) this.playing.movedAt = now;
        else if (now - this.playing.movedAt > STALL_MS) return this.reload('the video stood still for ' + STALL_MS / 1000 + ' s');
        this.playing.pos = st.rb.pos;
        if (st.rb.len) this.playing.len = st.rb.len;
      }
      if (this.list.clear) await this.pickNoBlur();
      return;
    }
    // Nothing plays: the last video ended (or was never started). Start the next one.
    if (this.playing) {
      const p = this.playing;
      this.playing = null;
      this.counts.ends++;
      if (p.len && p.pos < p.len - EARLY_S) {
        // Ended well before its length: start the same file again past the spot, a few times, then move on.
        const same = this.early.file === p.file && now - this.early.at < 10 * 60 * 1000;
        this.early = { file: p.file, at: now, n: same ? this.early.n + 1 : 1 };
        this.counts.early++;
        this.note('early', { file: path.basename(p.file), pos: Math.round(p.pos), len: Math.round(p.len), n: this.early.n, trace: await this.trace(10) });
        if (this.early.n <= EARLY_TRIES) this.resume = { i: p.i, file: p.file, pos: Math.min(p.pos + 3 * this.early.n, p.len - 3) };
      }
    }
    const L = this.list;
    let i, startAt = 0;
    if (this.resume && L.files[this.resume.i] === this.resume.file) { i = this.resume.i; startAt = this.resume.pos; }
    else {
      i = L.i + 1;
      if (i >= L.files.length) { if (!L.loop) { this.list = null; this.note('list.done'); return; } i = 0; }
    }
    this.resume = null;
    L.i = i;
    const file = L.files[i];
    const t0 = Date.now();
    const r = await this.startFile(file, startAt);
    if (!r.ok) {
      this.fails++;
      this.note('start.fail', { file: path.basename(file), why: r.why, fails: this.fails });
      if (this.fails >= START_FAILS_MAX) { this.list = null; this.lastError = 'videos will not start: ' + r.why; }
      return;
    }
    this.fails = 0;
    this.counts.plays++;
    this.playing = { i, file, pos: r.pos || 0, len: r.len || 0, movedAt: Date.now() };
    this.note('start', { i, file: path.basename(file), ms: Date.now() - t0, at: startAt ? Math.round(startAt) : undefined });
  }

  async trace(n) { return this.page.evaluate((k) => (window.__boothEv || []).slice(-k), n).catch(() => []); }

  // gifos.tv listing: the same signed records as the page's own "Publish to GifOS.tv" sheet (js/tv-publish.js), made
  // in the host page with the GifOS site's own code: orders signed with the room's host key, the person check (proof
  // of work), the 640x360 JPEG thumbnail drawn on the page's canvas. Then the page's "listed" mark is set, and the page
  // itself goes on air, sends the keep-alive every few minutes and goes off air when the host leaves.
  //   f: { title, desc, thumbB64 (picture file bytes) | fromStage, tip, pw, keepThumb, cat, tags, lang }
  async tvList(f) {
    this.need();
    const r = await this.page.evaluate(tvInPage, { op: 'list', seed: this.seedHex, rk: this.room + '.' + this.verifier, f });
    if (!r.ok) throw new Error(r.error);
    this.note('tv.listed', { url: r.url });
    return r;
  }
  async tvUnlist() {
    this.need();
    const r = await this.page.evaluate(tvInPage, { op: 'unlist', seed: this.seedHex, rk: this.room + '.' + this.verifier });
    if (!r.ok) throw new Error(r.error);
    this.note('tv.unlisted');
    return r;
  }
  // The listing as gifos.tv shows it to anyone (null when not listed).
  async tvRead() {
    return this.page.evaluate(tvInPage, { op: 'read', rk: this.room + '.' + this.verifier }).then((r) => (r && r.ok ? r.listing : null));
  }

  async state() {
    if (this.closed) return { open: false, room: this.room };
    const st = await this.read();
    const p = this.playing;
    return {
      open: true,
      room: this.room,
      link: this.link(),
      host: !!st.host,
      relay: !!st.relay,
      on_air: !!st.rb,
      video: st.rb ? { file: p ? path.basename(p.file) : null, index: p ? p.i : null, pos_s: Math.round(st.rb.pos), length_s: Math.round(st.rb.len || 0), paused: !!st.rb.paused } : null,
      playlist: this.list ? { files: this.list.files.length, loop: this.list.loop, yield_to_people: this.list.yieldToPeople } : null,
      yielding_to: this.yielded ? this.yielded.to : null,
      watching: st.watching || null,
      no_blur: st.rb ? st.no_blur : null,
      clear_right: st.clear_right === undefined ? null : st.clear_right,
      gifos_tv: st.tv,
      page_version: st.page_version || null,
      site_latest: this.siteLatest() || null,
      counts: { ...this.counts },
      last_event: this.lastEvent,
      error: this.broken ? this.lastError : null,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.wake();
    if (this.pool.booths.get(this.room) === this) this.pool.booths.delete(this.room);
    if (this.page) await this.page.evaluate(() => { const b = document.getElementById('leavebtn'); if (b) b.click(); }).catch(() => {});
    if (this.ctx) await Promise.race([this.ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
  }
}
