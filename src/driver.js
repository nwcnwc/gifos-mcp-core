// Drives the GifOS Meeting Bot store app in headless Chromium, through the
// app's local control API (window.MeetingBot). Contract version 1 is the
// published CONTROL.md. Version 2 methods (setVoice, interject, raiseHand,
// setMic, setCamera, meetingState, snapshot) are called only when present.
//
// One browser profile under GIFOS_MCP_HOME/profile-bot: a GifOS desktop with
// Meeting Bot and a speech-to-text provider app installed from the GifOS app
// store. Meeting Bot runs in RUN mode in one tab.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { launchInstalled } from './browser.js';
import { botPicture } from './profile.js';
import { log } from './log.js';
import { siteVersion } from '@gifos-app/agent/site';
import { VOICE_GAP, INTERJECT_GAP, HAND_GAP, MIC_GAP, CAMERA_GAP, CONTROLS_GAP, SNAPSHOT_GAP } from './voice/settings.js';
import { bridgeScript, hostRoles, HOST_BINDING, installPlan } from './voice/providers.js';
import { packHostResult, serveHost } from './voice/host.js';
import { installKokoro } from './voice/kokoro.js';
import { SpeechQueue } from './voice/queue.js';
import { ROOM_OPS, TURNS_OPS, OLD_SITE, roomPageOp, turnsPageOp } from './room.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The plan (a subscription or pass) rides only in meetings the bot JOINS, never in Meeting Bot's own sessions (its
// control meeting, its probe and remote seats). A GifOS page joins every meeting it starts with the plan its browser
// holds (subscriptions are always on in meetings since 0.9.26), and a pass that works in one meeting at a time then
// moves to whichever meeting joined last: each bot's control meeting took the staff pass from the guarded room (seen
// live 2026-11-23: both welcome bots lost their ticket two minutes after a restart). The plan is the browser's copy of
// the credentials file (meet-subs CRED_KEY, WALLET_KEY): every frame of the bot's browser reads it through this gate.
// A meeting session frame (meet-host srcdoc) reads it only once the host's 'join' has said the session is not Meeting
// Bot's own (control false); until then, and for good after a control join, it reads nothing. Any other frame (the
// desk, Meeting Bot's app frame) reads it as it is.
export const PLAN_KEYS = ['gifos-sub-cred', 'gifos-pass-wallet'];
export const PLAN_GATE = '(function(){try{var session=location.href==="about:srcdoc",said=false,open=false;'
  + 'addEventListener("message",function(e){var d=e.data;if(!said&&e.source===parent&&e.source!==window&&d&&d.op==="join"){said=true;open=!d.control;}},true);'
  + 'var keys=' + JSON.stringify(PLAN_KEYS) + ',g=Storage.prototype.getItem;'
  + 'Storage.prototype.getItem=function(k){if(session&&!open&&keys.indexOf(k)>=0)return null;return g.call(this,k);};'
  + '}catch(e){}})();';

// The store listing for one app. Fails when app.json is missing (404) or names a different app, before any store page
// is opened. A failure to REACH the store (network error, timeout, 5xx, 429) is tried again (4 tries over ~14 s) and,
// if it persists, reported as that, not as a missing app: one blip on a fresh start read "has no meeting-bot app".
// A call into the meeting page that never answers (a renderer wedged under memory pressure) must not hang the tool
// that made it, nor pile the next calls up behind it: every page call has a deadline and then fails with a typed
// timeout (code PAGE_TIMEOUT). Reads answer in milliseconds, so theirs is under an MCP client's 20 s request limit.
export const READ_DEADLINE_MS = 15000;
export function withDeadline(p, ms, what) {
  let t = null;
  const late = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error('The meeting page did not answer (' + what + ') within ' + Math.round(ms / 1000) + ' s.'), { code: 'PAGE_TIMEOUT' })), ms);
    if (t.unref) t.unref();
  });
  return Promise.race([Promise.resolve(p), late]).finally(() => clearTimeout(t));
}
const READS = new Set(['people', 'status', 'meetingState', 'snapshot']);

// The bot's browser can lose Meeting Bot in several ways: the browser or its profile closes (a crash, a kill, out of
// memory), the run.html tab closes or crashes, or the tab moves to a new document. A site deploy moves every open page
// to the new version (js/gifos-update.js go(), run.html askLive), which replaces Meeting Bot's frame and every meeting
// frame in it. After that, a Frame handle from before answers "Target page, context or browser has been closed" for
// good, while the page itself still looks open. Seen live 2026-11-21: both welcome bots stayed out of their room for
// 45 h, failing every join with it. So the driver treats any of these as a lost browser: it tells onLost listeners
// which meetings went with it, and the next call starts a fresh browser.
export const DEAD_PAGE_RE = /Target page, context or browser has been closed|Target closed|Target crashed|Frame was detached|Execution context was destroyed|Browser has been closed|browser has disconnected/i;
export function isDeadPage(e) { return DEAD_PAGE_RE.test(String((e && e.message) || e || '')); }

export async function storeAppListing(gifosUrl, slug, { fetchFn = fetch, sleepFn = sleep, tries = 4 } = {}) {
  const base = String(gifosUrl || '').replace(/\/$/, '');
  const listing = base + '/apps/' + encodeURIComponent(slug) + '/app.json';
  let why = '';
  for (let i = 0; i < tries; i++) {
    if (i) await sleepFn(2000 * 2 ** (i - 1));
    let r;
    try { r = await fetchFn(listing, { signal: AbortSignal.timeout(15000) }); }
    catch (e) { why = String((e && e.cause && e.cause.code) || (e && e.name) || 'network error'); continue; }
    if (r.status === 429 || r.status >= 500) { why = 'HTTP ' + r.status; continue; }
    const listed = r.ok ? await r.json().catch(() => null) : null;
    if (listed && listed.appId === slug) return listed;
    throw new Error('The GifOS store at ' + base + ' has no ' + slug + ' app, or this is the wrong build. Set GIFOS_URL to a 0.9.23b or newer site that lists Meeting Bot. (HTTP ' + r.status + ')');
  }
  throw new Error('Could not reach the GifOS store at ' + base + ' (' + why + ', ' + tries + ' tries). Check this computer\'s network and try again.');
}

// A short silent WAV for the bot's fake microphone, so the bot never opens
// the real microphone of the machine it runs on.
function silenceWav(file) {
  const rate = 16000, n = rate * 2;
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + n * 2, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(n * 2, 40);
  fs.writeFileSync(file, Buffer.concat([hdr, Buffer.alloc(n * 2)]));
}

// First launch shows the permission sheet; later launches go straight to the
// app. Polls both and says which came first: 'sheet', 'ready' or 'timeout'.
// 'ready' needs two looks in a row with no sheet, so a sheet drawn a beat
// after the app is not missed.
export async function sheetOrReady({ sheet, ready, timeoutMs = 8000, pollMs = 100, sleepFn = sleep, now = Date.now }) {
  const end = now() + timeoutMs;
  let readyRun = 0;
  for (;;) {
    if (await sheet()) return 'sheet';
    if (await ready()) { if (++readyRun >= 2) return 'ready'; } else readyRun = 0;
    if (now() >= end) return 'timeout';
    await sleepFn(pollMs);
  }
}

// 'auto' (Whisper detects), or a language code. A bare code is widened to the
// region GifOS lists for it (ru -> ru-RU); others pass through.
const CC_REGION = { en: 'en-US', ru: 'ru-RU', uk: 'uk-UA', es: 'es-ES', pt: 'pt-BR', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', pl: 'pl-PL', tr: 'tr-TR', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', hi: 'hi-IN', ar: 'ar-SA' };
export function captionLang(lang) {
  const v = String(lang || '').trim();
  if (!v || v.toLowerCase() === 'auto') return 'auto';
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(v)) throw new Error('language must be auto or a language code such as ru or es-ES.');
  const [a, b] = v.split('-');
  return b ? a.toLowerCase() + '-' + b.toUpperCase() : (CC_REGION[a.toLowerCase()] || a.toLowerCase());
}

// {"gifos_x": "v", ...} from GIFOS_MCP_PAGE_STORAGE: only gifos_ keys and
// string values; anything else is ignored.
export function pageStorage(raw) {
  if (!raw) return {};
  let o;
  try { o = JSON.parse(String(raw)); } catch (e) { log('GIFOS_MCP_PAGE_STORAGE is not JSON; ignored'); return {}; }
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o)) if (/^gifos[_-][A-Za-z0-9_.-]{1,60}$/.test(k) && typeof v === 'string' && v.length <= 2000) out[k] = v;
  return out;
}

export const RECORDING_SLICE = 4 * 1024 * 1024;

function recordingName(sessionId, rec) {
  return String(rec.name || ('recording-' + sessionId + '.webm')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'recording.webm';
}
const EMPTY_REC = 'There is no recording for this meeting. Call start_recording first, then stop_recording or get_recording.';

// Appends slices (Buffers, sync or async iterable) to a file under dir.
// opts.file names it outright; otherwise <now>-<name>. Empty is an error.
export async function writeRecording(dir, sessionId, rec, slices, opts = {}, now = Date.now) {
  if (!rec.size) throw new Error(EMPTY_REC);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = recordingName(sessionId, rec);
  const file = path.join(dir, opts.file || (now() + '-' + name));
  const part = file + '.part';
  const fd = fs.openSync(part, 'w', 0o600);
  let size = 0;
  try {
    for await (const b of slices) { fs.writeSync(fd, b); size += b.length; }
  } finally { fs.closeSync(fd); }
  fs.renameSync(part, file);
  return { path: file, name, mime: rec.mime || 'video/webm', size };
}

// The same, from one base64 string (unit tests and small files).
export function saveRecording(home, sessionId, rec, now = Date.now) {
  const bytes = Buffer.from(rec.b64 || '', 'base64');
  if (!bytes.length) throw new Error(EMPTY_REC);
  const dir = path.join(home, 'recordings');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = recordingName(sessionId, rec);
  const file = path.join(dir, now() + '-' + name);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { path: file, name, mime: rec.mime || 'video/webm', size: bytes.length };
}

export class MeetingBotDriver {
  constructor(cfg, creds, kokoro, hooks) {
    this.cfg = cfg;
    this.creds = creds;
    this.kokoro = kokoro || null;
    this.kokoroPromise = (hooks && hooks.kokoroPromise) || null;
    this.kokoroSettled = !this.kokoroPromise;
    if (this.kokoroPromise) {
      this.kokoroPromise.then((v) => { this.kokoro = v || null; this.kokoroSettled = true; }, () => { this.kokoro = null; this.kokoroSettled = true; });
    }
    this.queue = (hooks && hooks.queue) || new SpeechQueue(hooks || {});
    this.listing = (hooks && hooks.storeAppListing) || storeAppListing;   // tests hand in a stand-in
    this.state = 'stopped';
    this.error = '';
    this.starting = null;
    this.bot = null;      // { ctx, desk, app, frame, fileId }
    this.sttFileId = '';
    this.sessions = new Set();   // meeting session ids joined in this browser, for onLost
    this.lostHooks = [];
    this.lostWhy = '';
    this.gen = 0;                // which browser start the page listeners belong to
  }

  // fn(sessionIds, why): the browser lost these meetings (see DEAD_PAGE_RE). Same shape as WorkerPool.onLost.
  onLost(fn) {
    this.lostHooks.push(fn);
    return () => { this.lostHooks = this.lostHooks.filter((f) => f !== fn); };
  }

  // A ready bot whose run.html tab and Meeting Bot frame are both still there.
  alive() {
    const b = this.bot;
    return this.state === 'ready' && !!b && !!b.app && !b.app.isClosed() && !!b.frame && !b.frame.isDetached();
  }

  // Only a ready bot is lost: a start that fails is ensureStarted's to handle.
  lose(why) {
    if (this.state !== 'ready') return;
    this.state = 'lost';
    this.lostWhy = why;
    const ids = [...this.sessions];
    this.sessions.clear();
    log('bot browser lost: ' + why + (ids.length ? '; ' + ids.length + ' meeting(s) dropped' : '') + '; the next call starts a fresh browser');
    for (const fn of this.lostHooks) {
      try { fn(ids, why); } catch (e) { log('onLost listener failed: ' + String((e && e.message) || e)); }
    }
  }

  // A page call that failed because the page, frame or browser is gone marks the browser lost.
  dead(e) {
    if (isDeadPage(e)) this.lose('a page call answered: ' + String((e && e.message) || e).split('\n')[0].slice(0, 160));
    return e;
  }

  ensureStarted() {
    if (this.alive()) return Promise.resolve();
    if (this.state === 'ready') this.lose(this.bot && this.bot.app && this.bot.app.isClosed() ? 'the Meeting Bot tab is closed' : 'the Meeting Bot frame is gone');
    // A worker process ends on a loss (worker.js) and sets relaunch false: it must not start a browser on its way out.
    if (this.relaunch === false && this.lostWhy) return Promise.reject(new Error('The bot browser was lost (' + this.lostWhy + ').'));
    if (!this.starting) {
      this.starting = (async () => {
        // A lost browser is closed first: a new one cannot open the same profile while the old one holds it.
        if (this.bot) { log('relaunching the bot browser (' + (this.lostWhy || this.state) + ')'); await this.close(); }
        await this.start();
      })().then(() => { this.starting = null; this.lostWhy = ''; }, async (e) => {
        this.error = String((e && e.message) || e);
        log('start failed: ' + this.error);
        // Callers meanwhile wait on this same start, so nobody starts another browser before this one is closed.
        await this.close().catch(() => {});
        this.state = 'error';
        this.starting = null;
        throw e;
      });
    }
    return this.starting;
  }

  async launch(profile, audioFile) {
    // The browser already on this computer (Chrome, then Edge); never a download.
    const dir = path.join(this.cfg.home, profile);
    const { browser: ctx, used } = await launchInstalled((o) => chromium.launchPersistentContext(dir, o), {
      headless: this.cfg.headless,
      viewport: { width: 1280, height: 800 },
      permissions: ['microphone'],
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--use-file-for-fake-audio-capture=' + audioFile,
        '--autoplay-policy=no-user-gesture-required',
        // Meetings live in background tabs; keep their timers running.
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    }, this.cfg);
    this.browserName = used;
    log('browser: ' + used);
    const init = { gifos_meet_bar: '0', gifos_name: this.creds.name };
    // The bot's picture, as GifOS keeps a person's (gifos_avatar). Rooms send
    // it to everyone, the same as anyone's picture.
    const picture = this.picture === undefined ? botPicture(this.cfg) : this.picture;
    if (picture) init.gifos_avatar = JSON.stringify(picture);
    if (this.cfg.relay) init.gifos_relay = this.cfg.relay;
    // GIFOS_MCP_PAGE_STORAGE (testing): extra gifos_* page settings, such as a
    // test TURN credential service (gifos_turn_worker) on a private network.
    Object.assign(init, pageStorage(process.env.GIFOS_MCP_PAGE_STORAGE));
    // Captions language: Whisper detects it unless a join asks for one. The
    // headless browser's own language (en-US) would make Whisper translate
    // every other language into English.
    init.gifos_cc_lang = captionLang(this.cfg.ccLang);
    const roles = hostRoles(this.cfg);
    if (roles.length) {
      await ctx.exposeBinding(HOST_BINDING, async (_source, role, payload) => {
        let req = {};
        try { req = JSON.parse(String(payload || '{}')); }
        catch (e) { throw new Error('The host provider call was not a request.'); }
        return packHostResult(await serveHost(this.hostServices(), String(role || ''), req));
      });
    }
    await ctx.addInitScript({ content: 'try{var o=' + JSON.stringify(init) + ';for(var k in o)localStorage.setItem(k,o[k]);}catch(e){}' });
    await ctx.addInitScript({ content: PLAN_GATE });
    // GIFOS_MCP_PAY_URL (testing): the payment service a local GifOS stack serves (subscriptions, room capture);
    // the site's own default is the production one.
    const payUrl = String(process.env.GIFOS_MCP_PAY_URL || '');
    if (/^https?:\/\/[^\s'"]+$/.test(payUrl)) await ctx.addInitScript({ content: 'window.GIFOS_PAY_URL=' + JSON.stringify(payUrl.replace(/\/$/, '')) + ';' });
    // This process embeds the page, so provider calls for the roles it hosts
    // come back through the binding above. The page does not fetch them.
    // Meet Bot's frame never sees a URL or a key. On a fresh profile the
    // script also writes the GifOS AI rows for those roles, so gifos.ai.tts
    // and gifos.ai.chat are configured without MeetingBot.setVoice.
    await ctx.addInitScript({ content: bridgeScript({ hostRoles: roles }) });
    return ctx;
  }

  // What the binding may use. The key stays in this object, on this side
  // of the page. A store app is not listed here, so the page's own provider
  // answers that role.
  hostServices() {
    const voice = this.cfg.voice || {};
    const tts = voice.tts || {};
    const roles = new Set(hostRoles(this.cfg));
    return {
      kokoro: tts.source === 'mcp' ? async () => {
        if (this.kokoro) return this.kokoro;
        if (this.kokoroPromise) {
          try { this.kokoro = await this.kokoroPromise; } catch (e) { this.kokoro = null; }
        }
        return this.kokoro;
      } : null,
      tts: tts.engine === 'http' ? { url: tts.url, voice: tts.voice || '' } : null,
      stt: roles.has('stt') ? { url: voice.sttUrl } : null,
      queue: this.queue,
      // A voice asked for one line (say with voice), while that line is spoken.
      lineVoice: () => this.lineVoice || '',
    };
  }

  async desktop(ctx) {
    const page = ctx.pages()[0] || await ctx.newPage();
    if (this.cfg.debug) {
      page.on('console', (m) => log('[desk console] ' + m.text().slice(0, 300)));
      page.on('framenavigated', (f) => { if (f === page.mainFrame()) log('[desk] ' + f.url()); });
    }
    await page.goto(this.cfg.gifosUrl + '/index.html', { waitUntil: 'domcontentloaded', timeout: this.cfg.timeoutMs });
    await page.waitForFunction(() => window.GifOS && GifOS.store && GifOS.store.allFiles, null, { timeout: this.cfg.timeoutMs });
    await page.waitForSelector('.icon', { timeout: this.cfg.timeoutMs });
    return page;
  }

  installedFileId(desk, appId) {
    return desk.evaluate(async (appId) => {
      const files = await GifOS.store.allFiles();
      const f = files.find((x) => x.isApp && x.appId === appId);
      return f ? f.id : '';
    }, appId);
  }

  // Installs (or updates) an app through the GifOS store page, the same
  // clicks a person makes. Returns the installed fileId.
  async installFromStore(desk, slug) {
    await storeAppListing(this.cfg.gifosUrl, slug);
    const have = await this.installedFileId(desk, slug);
    await desk.goto(this.cfg.gifosUrl + '/store.html#app=' + encodeURIComponent(slug), { waitUntil: 'domcontentloaded', timeout: this.cfg.timeoutMs });
    const button = desk.locator('#install, #update').first();
    try {
      await button.waitFor({ timeout: 30000 });
    } catch (e) {
      if (have) { log('store page for ' + slug + ' did not load; keeping the installed copy'); return have; }
      throw new Error('The GifOS store at ' + this.cfg.gifosUrl + ' has no "' + slug + '" app (or the store did not load).');
    }
    const id = await button.getAttribute('id');
    const disabled = await button.isDisabled();
    if (disabled) {
      if (have) return have;
      throw new Error('The store refused to install ' + slug + ': ' + (await button.innerText()));
    }
    if (have && id === 'install') return have; // installed and current ("Install again")
    log((have ? 'updating ' : 'installing ') + slug + ' from the GifOS store');
    await button.click();
    if (have) {
      await desk.waitForFunction(() => !document.querySelector('#update'), null, { timeout: this.cfg.timeoutMs }).catch(() => {});
      return have;
    }
    // 0.9.24+ returns to /versions/<ver>/ after an install; older builds return to index.html.
    await desk.waitForURL(/index\.html|\/versions\/[^/]+\/(?:[?#]|$)/, { timeout: this.cfg.timeoutMs }).catch(async () => {
      await this.shot(desk, 'store-stuck-' + slug + '.png');
      if (this.cfg.debug) {
        const why = await desk.evaluate(async (slug) => {
          const out = {};
          try {
            const app = await (await fetch('/apps/' + slug + '/app.json')).json();
            const bytes = new Uint8Array(await (await fetch(app.gif)).arrayBuffer());
            out.n = bytes.length; out.want = app.bytes;
            try { const a = await GifOS.gif.decode(bytes); out.app = a ? (GifOS.gif.readManifest(a) || {}).appId : null; } catch (e) { out.decodeErr = String((e && e.stack) || e).slice(0, 400); }
          } catch (e) { out.err = String(e).slice(0, 300); }
          try { const est = await navigator.storage.estimate(); out.quota = est.quota; out.usage = est.usage; } catch (e) { /* none */ }
          return out;
        }, slug).catch((e) => ({ evalErr: String(e).slice(0, 200) }));
        log('store stuck: ' + JSON.stringify(why));
      }
      throw new Error('Installing "' + slug + '" from the GifOS store at ' + this.cfg.gifosUrl + ' did not return to the desktop (still at ' + desk.url() + ').');
    });
    await desk.waitForSelector('.icon', { timeout: this.cfg.timeoutMs });
    // The store writes the file, then the desktop places its icon (a provider
    // app into Providers). Leaving the page earlier loses the icon.
    let fid = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      fid = await this.installedFileId(desk, slug);
      if (fid && await this.placedParent(desk, fid) !== undefined) return fid;
      await sleep(300);
    }
    throw new Error('Installing ' + slug + ' did not finish.');
  }

  // The parent folder of the app's icon: null for the Home Screen, undefined
  // when no icon exists.
  placedParent(desk, fileId) {
    return desk.evaluate(async (fileId) => {
      const it = (await GifOS.store.allItems()).find((i) => i.fileId === fileId);
      return it ? (it.parent || null) : undefined;
    }, fileId);
  }

  // Installs each provider the way Settings → AI models does, then assigns it.
  // An app lands in the Providers folder. An HTTP stand-in is an endpoint row
  // { url, key, model } in gifos_ai_config. The key is typed into the GifOS
  // computer here, never into MeetingBot.setVoice.
  async applyProviders(desk) {
    for (const step of installPlan(this.cfg)) {
      if (step.appId) {
        const fileId = await this.installFromStore(desk, step.appId);
        await this.assignProvider(desk, step.role, fileId, step.appId);
        if (step.role === 'stt') this.sttFileId = fileId;
      } else if (step.endpoint) {
        await this.assignEndpoint(desk, step.role, step.endpoint);
        if (step.role === 'stt') this.sttFileId = 'endpoint';
      }
    }
  }

  async assignProvider(desk, role, fileId, appId) {
    // GifOS only lets a provider answer from the Providers folder.
    if (await this.placedParent(desk, fileId) !== 'sys_providers') {
      throw new Error('The ' + appId + ' app is installed but not in the Providers folder of the bot desktop. Remove ' +
        this.cfg.home + '/profile-bot and restart to reinstall it.');
    }
    await desk.evaluate(({ role, fileId, appId }) => {
      const row = { fileId, appId, name: appId };
      if (window.GifOS && GifOS.providers && typeof GifOS.providers.assign === 'function') {
        GifOS.providers.assign(role, row);
        return;
      }
      const cfg = JSON.parse(localStorage.getItem('gifos_ai_config') || '{}') || {};
      cfg[role] = { app: fileId, appId, appName: appId };
      localStorage.setItem('gifos_ai_config', JSON.stringify(cfg));
    }, { role, fileId, appId });
  }

  async assignEndpoint(desk, role, endpoint) {
    await desk.evaluate(({ role, endpoint }) => {
      const cfg = JSON.parse(localStorage.getItem('gifos_ai_config') || '{}') || {};
      const row = {};
      if (endpoint.url) row.url = endpoint.url;
      if (endpoint.model) row.model = endpoint.model;
      if (endpoint.key) row.key = endpoint.key;
      if (endpoint.voice) row.voice = endpoint.voice;
      cfg[role] = row;
      localStorage.setItem('gifos_ai_config', JSON.stringify(cfg));
    }, { role, endpoint });
  }

  async openApp(ctx, fileId) {
    const app = await ctx.newPage();
    app.on('pageerror', (e) => log('[app] ' + e.message));
    if (this.cfg.debug) app.on('console', (m) => log('[console] ' + m.text().slice(0, 300)));
    await app.goto(this.cfg.gifosUrl + '/run.html#id=' + encodeURIComponent(fileId), { waitUntil: 'domcontentloaded', timeout: this.cfg.timeoutMs });
    await app.waitForSelector('#appmount iframe', { timeout: this.cfg.timeoutMs });
    // First launch asks for the app's abilities. Meeting Bot needs Meet and Remote.
    const sheet = app.locator('.perm-box');
    // A profile that already granted them shows no sheet: stop as soon as the
    // app is up instead of waiting out the sheet's 8 s.
    const botUp = async () => {
      const h = await app.$('#appmount iframe').catch(() => null);
      const f = h && await h.contentFrame().catch(() => null);
      return !!(f && await f.evaluate(() => !!(window.MeetingBot && window.MeetingBot.version >= 1)).catch(() => false));
    };
    const seen = await sheetOrReady({ sheet: () => sheet.isVisible().catch(() => false), ready: botUp, timeoutMs: 8000 });
    if (seen === 'sheet') {
      for (const cap of ['meet', 'remote']) {
        const box = sheet.locator('input[data-cap="' + cap + '"]');
        if (await box.count()) await box.check();
      }
      await sheet.locator('.done').click();
      await sheet.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
    }
    const frame = await (await app.$('#appmount iframe')).contentFrame();
    await frame.waitForFunction(() => window.MeetingBot && window.MeetingBot.version >= 1, null, { timeout: this.cfg.timeoutMs })
      .catch(() => { throw new Error('This Meeting Bot has no local control API (window.MeetingBot v1). Update Meeting Bot from the GifOS store.'); });
    return { app, frame };
  }

  async shot(page, name) {
    if (!this.cfg.shotsDir || !page) return;
    try {
      fs.mkdirSync(this.cfg.shotsDir, { recursive: true });
      await page.screenshot({ path: path.join(this.cfg.shotsDir, name) });
    } catch (e) { log('screenshot ' + name + ': ' + e.message); }
  }

  async start() {
    this.state = 'starting';
    this.error = '';
    // Meeting Bot's listing first. A later provider (Offline Captions) can be
    // listed and still hang its store page; that must not hide a missing bot.
    await this.listing(this.cfg.gifosUrl, 'meeting-bot');
    fs.mkdirSync(this.cfg.home, { recursive: true, mode: 0o700 });
    // Speech weights load in the background (createRuntime). Starting the
    // browser does not wait on them; say() fails clearly if they never arrive.
    if (this.cfg.voice.tts.source === 'mcp' && !this.kokoro && !this.kokoroPromise) {
      this.kokoroPromise = installKokoro({ home: this.cfg.home, voice: this.cfg.voice.tts.voice, host: this.cfg.voice.tts.weights })
        .catch((e) => { log('Kokoro is not available: ' + String((e && e.message) || e)); return null; });
    }
    let audio = this.cfg.botAudio;
    if (!audio) { audio = path.join(this.cfg.home, 'silence.wav'); if (!fs.existsSync(audio)) silenceWav(audio); }

    const live = await siteVersion(this.cfg.gifosUrl).catch(() => null);
    this.startedOn = (live && live.latest) || '';
    log('starting the bot browser for ' + this.cfg.gifosUrl + (this.startedOn ? ' (live release ' + this.startedOn + ')' : ''));
    const ctx = await this.launch(this.cfg.profile || 'profile-bot', audio);
    this.bot = { ctx };
    // Listeners of an older browser start (closed by close(), which moves gen on) say nothing.
    const gen = ++this.gen;
    const lost = (why) => { if (gen === this.gen) this.lose(why); };
    ctx.on('close', () => lost('the bot browser closed'));
    const desk = await this.desktop(ctx);
    this.bot.desk = desk;
    await this.applyProviders(desk);
    this.bot.fileId = await this.installFromStore(desk, 'meeting-bot');
    await this.shot(desk, 'bot-desktop.png');
    Object.assign(this.bot, await this.openApp(ctx, this.bot.fileId));
    const { app, frame } = this.bot;
    app.on('close', () => lost('the Meeting Bot tab closed'));
    app.on('crash', () => lost('the Meeting Bot tab crashed'));
    // The tab moved to a new document (a site update, a reload): Meeting Bot's frame goes with the old one.
    app.on('framedetached', (f) => { if (f === frame) lost('the Meeting Bot frame is gone (its tab moved: a site update or a reload)'); });
    await this.startRun();
    await this.shot(this.bot.app, 'bot-running.png');
    this.state = 'ready';
    log('ready: Meeting Bot "' + this.creds.name + '" is running');
  }

  // RUN first listens ~5 s for a bot with the same name and password. A copy
  // of this server stopped seconds ago can still look alive: wait it out once.
  async startRun() {
    const run = () => this.bot.frame.evaluate((c) => window.MeetingBot.start({ mode: 'run', name: c.name, password: c.password, override: c.override })
      .then((s) => ({ ok: true, s }), (e) => ({ ok: false, error: String((e && e.message) || e) })), { ...this.creds, override: !!this.cfg.botSibling });
    let r = await run();
    if (!r.ok && /already running/.test(r.error)) {
      log('another bot with these credentials looks alive; waiting 20 s and trying once more');
      await sleep(20000);
      r = await run();
    }
    if (!r.ok) throw new Error('Meeting Bot did not start: ' + r.error);
    const t0 = Date.now();
    while (Date.now() - t0 < this.cfg.timeoutMs) {
      const st = await withDeadline(this.bot.frame.evaluate(() => window.MeetingBot.status()), this.readMs(), 'status');
      if (st.phase === 'run' && st.connected) return st;
      await sleep(300);
    }
    throw new Error('Meeting Bot started but never joined its admin meeting.');
  }

  // Calls window.MeetingBot.<method>(...args) in the app frame. A rejection
  // comes back as an Error with the app's own message.
  async call(method, ...args) {
    await this.ensureStarted();
    const r = await withDeadline(this.bot.frame.evaluate(({ method, args }) => window.MeetingBot[method](...args)
      .then((v) => ({ ok: true, v }), (e) => ({ ok: false, error: String((e && e.message) || e) })), { method, args }),
    READS.has(method) ? this.readMs() : this.callMs(), method).catch((e) => { throw this.dead(e); });
    if (!r.ok) throw new Error('Meeting Bot: ' + r.error);
    return r.v;
  }

  async join(link, password) {
    const r = await this.call('join', link, password || '');
    if (r && r.id != null) this.sessions.add(String(r.id));
    await this.shot(this.bot.app, 'bot-joined.png');
    return r.id;
  }

  // Sets the captions language for the next join ('auto' or a code such as
  // ru or es-ES). One browser holds one setting, so rooms joined at the
  // same time share the latest.
  async setCaptionLanguage(lang) {
    await this.ensureStarted();
    const v = captionLang(lang);
    await this.bot.app.evaluate((v) => { try { localStorage.setItem('gifos_cc_lang', v); } catch (e) {} }, v);
    return v;
  }

  async leave(sessionId) {
    await this.call('end', sessionId);
    this.sessions.delete(String(sessionId));
    await this.forgetHostKeys();
  }

  // A host key the bot took with sign_in_as_host stays in its browser only
  // while it is in a meeting: once no meeting page is open, it is removed.
  async forgetHostKeys() {
    if (!this.bot || !this.bot.app) return;
    await this.bot.app.evaluate(() => {
      if (document.querySelector('iframe[data-gifos-meet]')) return;
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.indexOf('gifos_vadm_') === 0) localStorage.removeItem(k);
      }
    }).catch(() => {});
  }

  // The agenda, apps, Take Turns, the stage and host sign-in (src/room.js),
  // reached in the bot's own meeting page. Throws the page's reason.
  async room(sessionId, op, args) {
    if (!ROOM_OPS.includes(op) && !TURNS_OPS.includes(op)) throw new Error('Unknown room op.');
    await this.ensureStarted();
    const r = await (TURNS_OPS.includes(op)
      ? this.turnsOp(sessionId, op, args || {})
      : withDeadline(this.bot.app.evaluate(roomPageOp, { id: String(sessionId), op, args: args || {}, oldSite: OLD_SITE, waitMs: 15000 }), this.callMs(), op))
      .catch((e) => { throw this.dead(e); });
    if (!r || !r.ok) throw new Error((r && r.error) || 'The meeting page did not answer.');
    return r.v;
  }

  // Take Turns runs in a sandboxed frame inside the meeting page; it is
  // reached as a frame, not through the page's window.
  async turnsOp(sessionId, op, args) {
    const sel = 'iframe[data-gifos-meet="' + String(sessionId).replace(/["\\]/g, '') + '"]';
    const el = await this.bot.app.$(sel);
    if (!el) return { ok: false, error: 'The bot is not in that meeting any more.' };
    const sess = await el.contentFrame();
    const appEl = sess ? await sess.$('#appmount iframe') : null;
    const appFrame = appEl ? await appEl.contentFrame() : null;
    if (!appFrame) return { ok: false, error: 'No app is running in this meeting. Start Take Turns with take_turns action start.' };
    return withDeadline(appFrame.evaluate(turnsPageOp, { op, args }), this.callMs(), op);
  }
  async transcribe(sessionId, on) { await this.call('transcribe', sessionId, !!on); }
  async say(sessionId, text) { await this.call('say', sessionId, String(text)); }
  async people(sessionId) { return this.call('people', sessionId); }

  // GifOS shows a banner in the meeting page when this network blocks the
  // direct (peer to peer) connections a meeting needs. Then nobody outside
  // sees or hears the bot. Returns that banner's text, or ''.
  async networkWarning(sessionId) {
    if (!this.bot || !this.bot.app) return '';
    return this.bot.app.evaluate((id) => {
      const re = /(network blocks the direct connections[^.]*\.?|outside your network cannot connect[^.]*\.?)/i;
      const frames = Array.from(document.querySelectorAll('iframe[data-gifos-meet]'));
      const f = frames.find((x) => x.getAttribute('data-gifos-meet') === String(id)) || (frames.length === 1 ? frames[0] : null);
      const docs = [];
      try { if (f && f.contentDocument) docs.push(f.contentDocument); } catch (e) { /* other origin */ }
      for (const d of docs) {
        const t = (d.body && d.body.innerText) || '';
        const m = re.exec(t);
        if (m) {
          const line = t.split('\n').find((l) => re.test(l)) || m[1];
          return line.trim().slice(0, 300);
        }
      }
      return '';
    }, sessionId).catch(() => '');
  }
  async list() { return this.call('list'); }
  async transcript(sessionId) { return (await this.call('transcript', sessionId)).text || ''; }

  // The chat lines Meet Bot kept for this meeting (CONTROL.md chatFile):
  // everyone's posts, the bot's own included, oldest first. A contract-1
  // app has no chat list; that is null, once checked, not an error per poll.
  async chat(sessionId) {
    if (this.chatMethod === false) return null;
    if (this.chatMethod !== true) {
      await this.ensureStarted();
      this.chatMethod = await this.bot.frame.evaluate(() => typeof (window.MeetingBot && window.MeetingBot.chatFile) === 'function');
      if (!this.chatMethod) return null;
    }
    const r = await this.call('chatFile', sessionId);
    return Array.isArray(r && r.lines) ? r.lines : [];
  }

  // The check passes no arguments, so a missing method never receives a payload.
  readMs() { return (this.cfg && this.cfg.readDeadlineMs) || READ_DEADLINE_MS; }
  callMs() { return (this.cfg && this.cfg.timeoutMs) || 120000; }

  async whenMethod(check, gap, invoke, ms) {
    await this.ensureStarted();
    const has = await withDeadline(this.bot.frame.evaluate(check), this.readMs(), 'a method check').catch((e) => { throw this.dead(e); });
    if (!has) return { applied: false, gap };
    const result = await withDeadline(invoke(), ms || this.callMs(), 'a page call').catch((e) => { throw this.dead(e); });
    return { applied: true, result: result == null ? null : result };
  }

  // Hands provider roles to the app. The object has no URL and no key.
  async setVoice(settings) {
    return this.whenMethod(
      () => typeof (window.MeetingBot && window.MeetingBot.setVoice) === 'function',
      VOICE_GAP,
      () => this.bot.frame.evaluate((s) => window.MeetingBot.setVoice(s), settings),
    );
  }

  // Spoken interjection from the assistant. Chat stays on say().
  // opts.voice: a Kokoro voice for this line only.
  async interject(sessionId, text, opts) {
    const voice = opts && opts.voice ? String(opts.voice) : '';
    this.lineVoice = voice;
    try {
      return await this.whenMethod(
        () => typeof (window.MeetingBot && window.MeetingBot.interject) === 'function',
        INTERJECT_GAP,
        () => this.bot.frame.evaluate(
          ({ id, text }) => window.MeetingBot.interject(id, text),
          { id: sessionId, text: String(text) },
        ),
      ).catch((e) => {
        const msg = String((e && e.message) || e);
        if (/Kokoro is not available/.test(msg)) throw new Error('Kokoro is not available on this computer.');
        throw e;
      });
    } finally {
      if (this.lineVoice === voice) this.lineVoice = '';
    }
  }

  async raiseHand(sessionId, on) {
    return this.whenMethod(
      () => typeof (window.MeetingBot && window.MeetingBot.raiseHand) === 'function',
      HAND_GAP,
      () => this.bot.frame.evaluate(({ id, on }) => window.MeetingBot.raiseHand(id, on), { id: sessionId, on: !!on }),
    );
  }

  async setMic(sessionId, on) {
    return this.whenMethod(
      () => typeof (window.MeetingBot && window.MeetingBot.setMic) === 'function',
      MIC_GAP,
      () => this.bot.frame.evaluate(({ id, on }) => window.MeetingBot.setMic(id, on), { id: sessionId, on: !!on }),
    );
  }

  async setCamera(sessionId, on) {
    return this.whenMethod(
      () => typeof (window.MeetingBot && window.MeetingBot.setCamera) === 'function',
      CAMERA_GAP,
      // GifOS 0.9.26 turns a camera on only with a blur choice, which
      // MeetingBot.setCamera (0.9.25) does not pass; then ask the meeting
      // API in the app frame directly, with No blur (the bot's own picture).
      () => this.bot.frame.evaluate(({ id, on }) => window.MeetingBot.setCamera(id, on).catch((e) => {
        const g = window.gifos && window.gifos.meet;
        if (on && g && typeof g.setCamera === 'function' && /blur/i.test(String((e && e.message) || e))) return g.setCamera(id, true, 0);
        throw e;
      }), { id: sessionId, on: !!on }),
    );
  }

  async meetingState(sessionId) {
    return this.whenMethod(
      () => typeof (window.MeetingBot && window.MeetingBot.meetingState) === 'function',
      CONTROLS_GAP,
      () => this.bot.frame.evaluate((id) => window.MeetingBot.meetingState(id), sessionId),
      this.readMs(),
    );
  }

  // Read-only. The PNG is the Meet Bot page this browser already has open.
  async snapshot(sessionId) {
    const taken = await this.whenMethod(
      () => typeof (window.MeetingBot && window.MeetingBot.snapshot) === 'function',
      SNAPSHOT_GAP,
      () => this.bot.frame.evaluate((id) => window.MeetingBot.snapshot(id), sessionId),
      this.readMs(),
    );
    let png = '';
    if (this.bot && this.bot.app && typeof this.bot.app.screenshot === 'function') {
      const dir = this.cfg.shotsDir || path.join(this.cfg.home, 'shots');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      png = path.join(dir, 'snapshot-' + String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '') + '.png');
      try { await this.bot.app.screenshot({ path: png }); } catch (e) { png = ''; }
    }
    return { applied: taken.applied, gap: taken.gap || null, png, result: taken.result == null ? null : taken.result };
  }

  // Recording (contract v1: record, recording). Everyone in the room sees the
  // ⏺ recording indicator on the bot's tile while it is on; the app draws it.
  async startRecording(sessionId) { return this.call('record', sessionId, true); }
  async stopRecording(sessionId) { return this.call('record', sessionId, false); }

  // Stops recording if it is on (the app's recording() does), then saves the
  // file under <home>/recordings and returns { path, name, mime, size }.
  async getRecording(sessionId, opts = {}) {
    await this.ensureStarted();
    const frame = this.bot.frame;
    const key = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const head = await frame.evaluate(({ id, key }) => window.MeetingBot.recording(id).then((rec) => {
      (window.__mcpRec = window.__mcpRec || {})[key] = new Uint8Array(rec.bytes || new ArrayBuffer(0));
      return { ok: true, name: rec.name || '', mime: rec.mime || '', size: window.__mcpRec[key].length };
    }, (e) => ({ ok: false, error: String((e && e.message) || e) })), { id: sessionId, key });
    if (!head.ok) throw new Error('Meeting Bot: ' + head.error);
    // Copy across in slices and append to disk, so a long meeting is never
    // one giant string in this process.
    const slices = (async function* () {
      try {
        for (let at = 0; at < head.size; at += RECORDING_SLICE) {
          const b64 = await frame.evaluate(({ key, at, n }) => {
            const u8 = window.__mcpRec[key].subarray(at, at + n);
            let bin = '';
            for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
            return btoa(bin);
          }, { key, at, n: RECORDING_SLICE });
          yield Buffer.from(b64, 'base64');
        }
      } finally {
        await frame.evaluate((key) => { if (window.__mcpRec) delete window.__mcpRec[key]; }, key).catch(() => {});
      }
    })();
    return writeRecording(opts.dir || path.join(this.cfg.home, 'recordings'), sessionId, head, slices, opts);
  }

  botNames() { return [this.creds.name]; }
  botNameFor() { return this.creds.name; }

  // A new name or picture from set_bot_profile. The picture goes to the
  // running profile at once (rooms joined from now on send it). A new name
  // restarts Meeting Bot, so only when it is in no room.
  async setLook({ name, picture }) {
    if (picture !== undefined) {
      this.picture = picture;
      const desk = this.bot && this.bot.desk;
      if (desk && !desk.isClosed()) {
        await desk.evaluate((rec) => {
          if (window.GifOS && GifOS.store && GifOS.store.setAvatar) GifOS.store.setAvatar(rec);
          else if (rec) localStorage.setItem('gifos_avatar', JSON.stringify(rec)); else localStorage.removeItem('gifos_avatar');
        }, picture || null).catch(() => {});
      }
    }
    if (name && name !== this.creds.name) {
      this.creds.name = name;
      if (this.state === 'ready' || this.bot) await this.close();
    }
    return { name: this.creds.name, picture: !!(this.picture === undefined ? botPicture(this.cfg) : this.picture) };
  }

  async info() {
    const out = { state: this.state, bot_name: this.creds.name, bot_picture: !!(this.picture === undefined ? botPicture(this.cfg) : this.picture), stt_ready: !!this.sttFileId };
    if (this.kokoroSettled && !this.kokoro && this.cfg.voice && this.cfg.voice.tts && this.cfg.voice.tts.engine === 'kokoro') {
      out.tts_unavailable = 'Kokoro is not available on this computer.';
    }
    if (this.error) out.error = this.error;
    if (this.state === 'ready') {
      try {
        const st = await this.bot.frame.evaluate(() => window.MeetingBot.status());
        out.connected = !!st.connected;
        if (st.warning) out.warning = st.warning;
        out.bot_sessions = (st.meetings || []).map((m) => ({ session_id: m.id, transcribing: !!m.cc, people: m.people || [] }));
        if (Array.isArray(st.commands)) out.commands = st.commands.map((c) => ({ op: c.op || '', detail: c.detail || '' }));
        if (Array.isArray(st.errors)) out.errors = st.errors.map((e) => ({ text: e.text || '' }));
      } catch (e) { out.error = String(e.message || e); }
      // GIFOS_MCP_DEBUG=1: what each meeting page says about its captions.
      if (this.cfg.debug) {
        await this.bot.app.evaluate(async () => {
          for (const f of Array.from(document.querySelectorAll('iframe[data-gifos-meet]'))) {
            try {
              const g = f.contentWindow.__gifosVideo;
              const ts = g && typeof g.turnState === 'function' ? g.turnState() : null;
              const paths = g && typeof g.turnPathsForTest === 'function' ? await g.turnPathsForTest() : null;
              f.__mcpTurn = ts || paths ? { directPath: ts ? ts.directPath : null, links: ts ? ts.links : null, paths } : null;
            } catch (e) { f.__mcpTurn = { error: String(e).slice(0, 200) }; }
          }
        }).catch(() => {});
        out.debug_sessions = await this.bot.app.evaluate(() => Array.from(document.querySelectorAll('iframe[data-gifos-meet]')).map((f) => {
          try {
            const g = f.contentWindow.__gifosVideo;
            return { id: f.getAttribute('data-gifos-meet'), captions: g && g.whisperForTest ? g.whisperForTest() : null,
              status: (f.contentDocument.querySelector('#status') || {}).textContent || '', turn: g ? f.__mcpTurn || null : null };
          } catch (e) { return { id: f.getAttribute('data-gifos-meet'), error: String(e) }; }
        })).catch((e) => String(e));
      }
    }
    return out;
  }

  // The release the Meeting Bot page runs: on a site with release snapshots the loader moved it to /versions/<v>/;
  // elsewhere (a local or edge site), the live release read when the browser started. '' before a start.
  pageVersion() {
    const app = this.bot && this.bot.app;
    if (!app || app.isClosed()) return '';
    const m = /\/versions\/(\d+(?:\.\d+){1,3})\//.exec(app.url());
    return m ? m[1] : (this.startedOn || '');
  }

  // A new live release on the site (src/site.js): drop this browser; the next call starts a fresh one, which loads
  // the live release. Its meetings are lost the usual way (onLost: back to scheduled, the clock seats them again).
  async refresh(why) {
    if (this.starting) await this.starting.catch(() => {});
    if (this.state === 'ready') this.lose(why || 'the site moved to a new release');
    if (this.bot) await this.close();
  }

  async close() {
    this.gen++;   // this browser's own close is not a loss
    this.sessions.clear();
    // Let go of this browser before waiting on it, so a start that begins meanwhile is not undone afterwards.
    const bot = this.bot;
    this.bot = null;
    this.state = 'stopped';
    if (bot && bot.ctx) await bot.ctx.close().catch(() => {});
  }
}
