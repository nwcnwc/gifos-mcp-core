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
import { VOICE_GAP, INTERJECT_GAP, HAND_GAP, MIC_GAP, CAMERA_GAP, CONTROLS_GAP, SNAPSHOT_GAP } from './voice/settings.js';
import { bridgeScript, hostRoles, HOST_BINDING, installPlan } from './voice/providers.js';
import { packHostResult, serveHost } from './voice/host.js';
import { installKokoro } from './voice/kokoro.js';
import { SpeechQueue } from './voice/queue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The store listing for one app. Fails at once when app.json is missing or
// names a different app, before any store page is opened.
export async function storeAppListing(gifosUrl, slug) {
  const base = String(gifosUrl || '').replace(/\/$/, '');
  const listing = base + '/apps/' + encodeURIComponent(slug) + '/app.json';
  const listed = await fetch(listing).then((r) => r.ok ? r.json() : null).catch(() => null);
  if (!listed || listed.appId !== slug) {
    throw new Error('The GifOS store at ' + base + ' has no ' + slug + ' app, or this is the wrong build. Set GIFOS_URL to a 0.9.23b or newer site that lists Meeting Bot.');
  }
  return listed;
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
    this.state = 'stopped';
    this.error = '';
    this.starting = null;
    this.bot = null;      // { ctx, desk, app, frame, fileId }
    this.sttFileId = '';
  }

  ensureStarted() {
    if (this.state === 'ready' && this.bot && this.bot.app && !this.bot.app.isClosed()) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().then(() => { this.starting = null; }, async (e) => {
        this.starting = null;
        this.state = 'error';
        this.error = String((e && e.message) || e);
        log('start failed: ' + this.error);
        await this.close().catch(() => {});
        this.state = 'error';
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
    await desk.waitForURL(/index\.html|\/versions\/[^/]+\/(?:[?#]|$)/, { timeout: this.cfg.timeoutMs }).catch(() => {
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
    await storeAppListing(this.cfg.gifosUrl, 'meeting-bot');
    fs.mkdirSync(this.cfg.home, { recursive: true, mode: 0o700 });
    // Speech weights load in the background (createRuntime). Starting the
    // browser does not wait on them; say() fails clearly if they never arrive.
    if (this.cfg.voice.tts.source === 'mcp' && !this.kokoro && !this.kokoroPromise) {
      this.kokoroPromise = installKokoro({ home: this.cfg.home, voice: this.cfg.voice.tts.voice, host: this.cfg.voice.tts.weights })
        .catch((e) => { log('Kokoro is not available: ' + String((e && e.message) || e)); return null; });
    }
    let audio = this.cfg.botAudio;
    if (!audio) { audio = path.join(this.cfg.home, 'silence.wav'); if (!fs.existsSync(audio)) silenceWav(audio); }

    log('starting the bot browser for ' + this.cfg.gifosUrl);
    const ctx = await this.launch(this.cfg.profile || 'profile-bot', audio);
    this.bot = { ctx };
    const desk = await this.desktop(ctx);
    this.bot.desk = desk;
    await this.applyProviders(desk);
    this.bot.fileId = await this.installFromStore(desk, 'meeting-bot');
    await this.shot(desk, 'bot-desktop.png');
    Object.assign(this.bot, await this.openApp(ctx, this.bot.fileId));
    await this.startRun();
    await this.shot(this.bot.app, 'bot-running.png');
    this.state = 'ready';
    log('ready: Meeting Bot "' + this.creds.name + '" is running');
  }

  // RUN first listens ~5 s for a bot with the same name and password. A copy
  // of this server stopped seconds ago can still look alive: wait it out once.
  async startRun() {
    const run = () => this.bot.frame.evaluate((c) => window.MeetingBot.start({ mode: 'run', name: c.name, password: c.password })
      .then((s) => ({ ok: true, s }), (e) => ({ ok: false, error: String((e && e.message) || e) })), this.creds);
    let r = await run();
    if (!r.ok && /already running/.test(r.error)) {
      log('another bot with these credentials looks alive; waiting 20 s and trying once more');
      await sleep(20000);
      r = await run();
    }
    if (!r.ok) throw new Error('Meeting Bot did not start: ' + r.error);
    const t0 = Date.now();
    while (Date.now() - t0 < this.cfg.timeoutMs) {
      const st = await this.bot.frame.evaluate(() => window.MeetingBot.status());
      if (st.phase === 'run' && st.connected) return st;
      await sleep(300);
    }
    throw new Error('Meeting Bot started but never joined its admin meeting.');
  }

  // Calls window.MeetingBot.<method>(...args) in the app frame. A rejection
  // comes back as an Error with the app's own message.
  async call(method, ...args) {
    await this.ensureStarted();
    const r = await this.bot.frame.evaluate(({ method, args }) => window.MeetingBot[method](...args)
      .then((v) => ({ ok: true, v }), (e) => ({ ok: false, error: String((e && e.message) || e) })), { method, args });
    if (!r.ok) throw new Error('Meeting Bot: ' + r.error);
    return r.v;
  }

  async join(link, password) {
    const r = await this.call('join', link, password || '');
    await this.shot(this.bot.app, 'bot-joined.png');
    return r.id;
  }

  async leave(sessionId) { await this.call('end', sessionId); }
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
  async whenMethod(check, gap, invoke) {
    await this.ensureStarted();
    const has = await this.bot.frame.evaluate(check);
    if (!has) return { applied: false, gap };
    const result = await invoke();
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
      () => this.bot.frame.evaluate(({ id, on }) => window.MeetingBot.setCamera(id, on), { id: sessionId, on: !!on }),
    );
  }

  async meetingState(sessionId) {
    return this.whenMethod(
      () => typeof (window.MeetingBot && window.MeetingBot.meetingState) === 'function',
      CONTROLS_GAP,
      () => this.bot.frame.evaluate((id) => window.MeetingBot.meetingState(id), sessionId),
    );
  }

  // Read-only. The PNG is the Meet Bot page this browser already has open.
  async snapshot(sessionId) {
    const taken = await this.whenMethod(
      () => typeof (window.MeetingBot && window.MeetingBot.snapshot) === 'function',
      SNAPSHOT_GAP,
      () => this.bot.frame.evaluate((id) => window.MeetingBot.snapshot(id), sessionId),
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
        out.debug_sessions = await this.bot.app.evaluate(() => Array.from(document.querySelectorAll('iframe[data-gifos-meet]')).map((f) => {
          try {
            const g = f.contentWindow.__gifosVideo;
            return { id: f.getAttribute('data-gifos-meet'), captions: g && g.whisperForTest ? g.whisperForTest() : null,
              status: (f.contentDocument.querySelector('#status') || {}).textContent || '' };
          } catch (e) { return { id: f.getAttribute('data-gifos-meet'), error: String(e) }; }
        })).catch((e) => String(e));
      }
    }
    return out;
  }

  async close() {
    if (this.bot && this.bot.ctx) await this.bot.ctx.close().catch(() => {});
    this.bot = null;
    this.state = 'stopped';
  }
}
