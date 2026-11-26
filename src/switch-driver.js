// GIFOS_BOT_MODE=auto: the core first (no browser), the browser only when a meeting's site cannot run the core path
// yet. Holds a CoreBotDriver always and the browser driver (WorkerPool or MeetingBotDriver) LAZILY: a process whose
// meetings all run on the core never launches a browser.
//
// Session ids carry their side: a core id is the CoreBotDriver's own ('c1', 'c2', ...); a browser id is 'b:' plus
// the browser driver's own id. Every per-session method below reads that prefix to route to the driver that owns
// the session; nothing else needs to know which side a meeting landed on.
import { log } from './log.js';
import { scrub } from './voice/settings.js';
import { CORE_ROOM_GAP } from './core-driver.js';

const BROWSER_PREFIX = 'b:';
const isBrowserId = (id) => String(id).startsWith(BROWSER_PREFIX);
const localOf = (id) => String(id).slice(BROWSER_PREFIX.length);
const toPublic = (id) => BROWSER_PREFIX + id;

export class SwitchBotDriver {
  // core: a CoreBotDriver already made (this class owns its lifecycle the same way it owns the browser's).
  // makeBrowser(): returns a fresh WorkerPool or MeetingBotDriver, called at most once, and only once a join needs it.
  constructor(core, makeBrowser) {
    this.core = core;
    this.makeBrowser = makeBrowser;
    this._browser = null;
    this.lostHooks = [];
  }

  // The browser driver, built the first time a meeting actually needs it. Routing (say, people, ...) calls this
  // too, but only ever for a 'b:' id, which only exists once a browser join made one.
  browser() {
    if (!this._browser) {
      this._browser = this.makeBrowser();
      for (const fn of this.lostHooks) this.hookBrowserLost(fn);
    }
    return this._browser;
  }

  hookBrowserLost(fn) {
    if (typeof this._browser.onLost !== 'function') return;
    this._browser.onLost((ids, why, extra) => fn((ids || []).map(toPublic), why, extra));
  }

  // Core only: a process whose meetings all run on the core never starts a browser just to be "ready".
  async ensureStarted() { return this.core.ensureStarted(); }

  // Try the core first. Falls back to the browser when the core join throws (core mode off in the SDK, a site
  // with no signed core, the SDK missing, a join timeout) or, for a guard join (opts.guard), when the core has no
  // room ops yet (CORE_ROOM_GAP from a host.state probe): the guard needs those, so a core seat it cannot drive
  // is left and the browser joins instead. Every fallback logs one line with the reason, no secrets.
  async join(link, password, opts) {
    let id;
    try {
      id = await this.core.join(link, password, opts);
    } catch (e) {
      log('core join fell back to the browser bot: ' + scrub(String((e && e.message) || e), [password || '']));
      return this.joinBrowser(link, password, opts);
    }
    if (opts && opts.guard) {
      try {
        await this.core.room(id, 'host.state', {});
      } catch (e) {
        if (String((e && e.message) || e) !== CORE_ROOM_GAP) throw e;
        await this.core.leave(id).catch(() => {});
        log('guard join fell back to the browser bot: the core has no room actions yet');
        return this.joinBrowser(link, password, opts);
      }
    }
    return id;
  }

  async joinBrowser(link, password, opts) {
    const local = await this.browser().join(link, password, opts);
    return toPublic(local);
  }

  // ---- per-session: routed by the id's side ----
  leave(id) { return isBrowserId(id) ? this.browser().leave(localOf(id)) : this.core.leave(id); }
  say(id, text) { return isBrowserId(id) ? this.browser().say(localOf(id), text) : this.core.say(id, text); }
  people(id) { return isBrowserId(id) ? this.browser().people(localOf(id)) : this.core.people(id); }
  transcript(id) { return isBrowserId(id) ? this.browser().transcript(localOf(id)) : this.core.transcript(id); }
  chat(id) { return isBrowserId(id) ? this.browser().chat(localOf(id)) : this.core.chat(id); }
  transcribe(id, on) { return isBrowserId(id) ? this.browser().transcribe(localOf(id), on) : this.core.transcribe(id, on); }
  networkWarning(id) { return isBrowserId(id) ? this.browser().networkWarning(localOf(id)) : this.core.networkWarning(id); }
  room(id, op, args) { return isBrowserId(id) ? this.browser().room(localOf(id), op, args) : this.core.room(id, op, args); }
  interject(id, text, opts) { return isBrowserId(id) ? this.browser().interject(localOf(id), text, opts) : this.core.interject(id, text, opts); }
  meetingState(id) { return isBrowserId(id) ? this.browser().meetingState(localOf(id)) : this.core.meetingState(id); }
  raiseHand(id, on) { return isBrowserId(id) ? this.browser().raiseHand(localOf(id), on) : this.core.raiseHand(id, on); }
  setMic(id, on) { return isBrowserId(id) ? this.browser().setMic(localOf(id), on) : this.core.setMic(id, on); }
  setCamera(id, on) { return isBrowserId(id) ? this.browser().setCamera(localOf(id), on) : this.core.setCamera(id, on); }
  snapshot(id) { return isBrowserId(id) ? this.browser().snapshot(localOf(id)) : this.core.snapshot(id); }
  startRecording(id) { return isBrowserId(id) ? this.browser().startRecording(localOf(id)) : this.core.startRecording(id); }
  stopRecording(id) { return isBrowserId(id) ? this.browser().stopRecording(localOf(id)) : this.core.stopRecording(id); }
  getRecording(id, opts) { return isBrowserId(id) ? this.browser().getRecording(localOf(id), opts) : this.core.getRecording(id, opts); }

  // ---- no session: both sides ----
  botNames() {
    const core = this.core.botNames();
    const browser = this._browser ? this._browser.botNames() : [];
    return Array.from(new Set([...core, ...browser]));
  }
  botNameFor(id) { return isBrowserId(id) ? this._browser && this._browser.botNameFor(localOf(id)) : this.core.botNameFor(id); }

  // A browser not yet made picks up the same name and picture the moment it starts: it shares cfg and creds with
  // the core (main.js builds both from one creds object), so renaming never has to launch it early.
  async setLook(look) {
    const core = await this.core.setLook(look);
    if (!this._browser) return core;
    const browser = await this._browser.setLook(look).catch((e) => { log('setLook on the browser bot failed: ' + String((e && e.message) || e)); return null; });
    return { name: core.name, picture: core.picture || !!(browser && browser.picture) };
  }

  async list() {
    const core = await this.core.list();
    if (!this._browser) return core;
    const browser = await this._browser.list();
    return core.concat(browser.map((row) => ({ ...row, id: toPublic(row.id) })));
  }

  onLost(fn) {
    this.lostHooks.push(fn);
    if (this._browser) this.hookBrowserLost(fn);
    return () => { this.lostHooks = this.lostHooks.filter((f) => f !== fn); };
  }

  // Each session tagged with the path it runs on, so guard_status / health probes can tell core from browser.
  async info() {
    const core = await this.core.info();
    const rows = (core.bot_sessions || []).map((row) => ({ ...row, mode: 'core' }));
    const out = { state: core.state, mode: 'auto', bot_name: core.bot_name, bot_picture: core.bot_picture, stt_ready: core.stt_ready };
    if (core.error) out.core_error = core.error;
    if (this._browser) {
      const browser = await this._browser.info();
      for (const row of browser.bot_sessions || []) rows.push({ ...row, session_id: toPublic(row.session_id), mode: 'browser' });
      out.stt_ready = out.stt_ready || !!browser.stt_ready;
      out.browser_state = browser.state;
      if (browser.error) out.browser_error = browser.error;
    }
    out.bot_sessions = rows;
    return out;
  }

  // The site's live release (src/site.js): the browser page's, once a browser runs. A core seat loads the site's
  // signed core at each join, so a guard that leaves and joins again (src/guard.js) moves it to the new release.
  pageVersion() { return this._browser && typeof this._browser.pageVersion === 'function' ? this._browser.pageVersion() : ''; }
  async refresh(why) { if (this._browser && typeof this._browser.refresh === 'function') await this._browser.refresh(why); }

  async close() {
    await this.core.close();
    if (this._browser) await this._browser.close();
  }
}
