// The Meeting Bot with no browser (GIFOS_BOT_MODE=core). Each meeting is a participant of the GifOS core running in
// this process, through the agent SDK's core transport (@gifos-app/agent): the meeting's own code, loaded from the
// meeting's site, over real WebRTC: data channels, and media through the core's Node media plane (it carries its
// row's duties like any seat). It holds a seat, reads people, chat and the captions people share, posts chat, speaks
// with this process's Kokoro, and leaves. It has no camera, screenshot or recording yet: those tools answer with their
// gap, as for a Meeting Bot app without the method. Room ops ride the page's 'room' agent action once a site has it.
//
// Surface: the same duck-typed bot the tools call (ensureStarted, join, leave, say, people, transcript, chat,
// transcribe, networkWarning, botNames, botNameFor, setLook, info, close, room, interject, meetingState, raiseHand).
import path from 'node:path';
import { ROOM_OPS } from './room.js';
import { log } from './log.js';

// The page's 'room' agent action (agenda, app, stage, host, guard.*) arrives after GifOS 0.9.28.30 (js/meet-agent.js
// 'room' -> the core's own room ops; src/room.js is the browser bot's version, reached in its meeting frame). A site
// whose core has no such action answers "No such action: room": every core room op is then this gap.
export const CORE_ROOM_GAP = "This GifOS site's core has no room actions yet; the browser Meeting Bot is needed for this.";
// The core path speaks through the meeting's Node media plane with this process's Kokoro; no Kokoro here (GIFOS_TTS_ENGINE
// off, or its weights failed to load) -> no voice. Chat still carries the words.
export const CORE_VOICE_GAP = 'The bot has no voice here: this process has no Kokoro voice engine (GIFOS_TTS_ENGINE).';


// The meeting page's address in agent mode (the SDK's own rule).
function agentLink(link) {
  const u = new URL(link);
  u.searchParams.set('agent', '1');
  const h = new URLSearchParams(u.hash.replace(/^#/, ''));
  if (Array.from(h.keys()).length) { h.set('agent', '1'); u.hash = h.toString(); }
  return u.toString();
}

export class CoreBotDriver {
  constructor(cfg, creds, opts = {}) {
    this.cfg = cfg;
    this.creds = creds;
    this.opts = opts;
    this.state = 'stopped';
    this.error = '';
    this.sessions = new Map();   // id -> { meet, link, lines: [], chat: [], people: [] }
    this.seq = 0;
    // Kokoro, when this process has it (same object MeetingBotDriver's hostServices() reads): loads in the
    // background, so interject() must not fail just because the first call lands before it is ready.
    this.kokoroPromise = opts.kokoroPromise || null;
    this.kokoro = opts.kokoro || null;
    if (this.kokoroPromise) this.kokoroPromise.then((v) => { this.kokoro = v || null; }, () => { this.kokoro = null; });
  }

  sdk() { return this.opts.sdk ? Promise.resolve(this.opts.sdk) : import('@gifos-app/agent'); }

  async ensureStarted() {
    if (this.state === 'ready') return;
    try { await this.sdk(); this.state = 'ready'; this.error = ''; }
    catch (e) { this.state = 'error'; this.error = 'The agent SDK (@gifos-app/agent) is not installed: ' + String(e.message || e); throw new Error(this.error); }
  }

  async join(link, password) {
    await this.ensureStarted();
    const S = await this.sdk();
    const room = S.roomOf(link);
    const transport = await S.coreTransport(agentLink(link), {
      name: this.creds.name, relay: this.cfg.relay || '', room, password: password || '',
      profile: path.join(this.cfg.home, 'core-bot'), coreKeys: this.cfg.coreKeys && this.cfg.coreKeys.length ? this.cfg.coreKeys : undefined,
      // GIFOS_MCP_PAY_URL (testing): a local stack's payment service, as the browser bot's init script hands its page
      payUrl: /^https?:\/\/[^\s'"]+$/.test(String(process.env.GIFOS_MCP_PAY_URL || '')) ? String(process.env.GIFOS_MCP_PAY_URL).replace(/\/$/, '') : undefined,
    });
    const meet = new S.Meeting(transport, { tts: (text, opts) => this.ttsFor(text, opts) });
    meet.core = true;
    const id = 'c' + (++this.seq);
    const s = { meet, link, lines: [], chat: [], people: [] };
    this.sessions.set(id, s);
    meet.on('people', (p) => { s.people = Array.isArray(p) ? p : s.people; });
    meet.on('line', (l) => {
      if (!l || l.final === false) return;
      if (l.kind === 'chat') s.chat.push({ by: l.name || '', byId: l.id || '', at: l.ts || Date.now(), text: String(l.text || '') });
      else if (l.kind === 'speech' || l.kind === 'spoken') s.lines.push((l.name || '') + ': ' + String(l.text || ''));
    });
    meet.on('left', () => { s.gone = true; });
    meet.on('password', () => { s.passwordAsked = true; });
    try {
      await transport.ready(60000);
      const ms = 120000, t0 = Date.now();
      for (;;) {
        const st = await meet.state().catch(() => null);
        if (st && st.joined) break;
        if (s.passwordAsked) throw new Error('The room asks for a password.');
        if (Date.now() - t0 > ms) throw new Error('The meeting did not seat the bot in ' + Math.round(ms / 1000) + ' s.');
        await new Promise((r) => setTimeout(r, 250));
      }
      // what the room already holds (lines said before the bot came are read as history the page keeps)
      const r = await meet.call('lines').catch(() => null);
      for (const l of (r && r.lines) || []) {
        if (l.kind === 'chat') s.chat.push({ by: l.name || '', byId: l.id || '', at: l.ts || 0, text: String(l.text || '') });
        else if (l.kind === 'speech' || l.kind === 'spoken') s.lines.push((l.name || '') + ': ' + String(l.text || ''));
      }
    } catch (e) {
      this.sessions.delete(id);
      await meet.close().catch(() => {});
      throw e;
    }
    log('core bot joined ' + room + ' as session ' + id);
    return id;
  }

  session(id) {
    const s = this.sessions.get(String(id));
    if (!s || s.gone) throw new Error('Meeting Bot: not in that meeting any more');
    return s;
  }

  async leave(id) { const s = this.sessions.get(String(id)); if (!s) return; this.sessions.delete(String(id)); await s.meet.leave().catch(() => {}); }
  async transcribe() { /* the core reads the captions people share; there is no own speech-to-text to switch */ }
  async say(id, text) { await this.session(id).meet.chat(String(text)); }
  async people(id) {
    const s = this.session(id);
    const p = await s.meet.call('people').then((r) => r.people, () => s.people);
    return (p || []).map((x) => ({ id: x.id, name: x.name, bot: !!x.bot, me: !!x.me }));
  }
  async transcript(id) { return this.session(id).lines.join('\n'); }
  async chat(id) { return this.session(id).chat.slice(); }
  async networkWarning() { return ''; }
  // agenda, app, stage, host, guard.* (src/room.js ROOM_OPS), as ONE action on the meeting's agent contract: the page
  // runs the same ops roomPageOp runs, on the core's state, and answers the same { ok, v }/{ ok, error } shape. An
  // older core with no 'room' action answers CORE_ROOM_GAP (SwitchBotDriver reads this message to fall back to the
  // browser bot).
  async room(id, op, args) {
    if (!ROOM_OPS.includes(op)) throw new Error('Unknown room op.');
    const s = this.session(id);
    try {
      const r = await s.meet.call('room', { op, args: args || {} });
      return r.v;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/^No such action: room\.?$/.test(msg)) throw new Error(CORE_ROOM_GAP);
      throw e;
    }
  }
  // the browser bot's whenMethod shape: { applied, result } or { applied: false, gap }
  async raiseHand(id, on) { const r = await this.session(id).meet.hand(!!on); return { applied: true, result: { hand: !!(r && r.up) } }; }
  // Spoken interjection, through the SDK's say() (the tts slot every Meeting is built with: ttsFor, bound once, so a
  // Kokoro that finishes loading after the join still gets used on the next line). No voice engine in this process
  // -> the gap shape, same as a missing Meeting Bot method: callers (guard.greet) already posted the words to chat.
  async interject(id, text, opts) {
    const s = this.session(id);
    try {
      const r = await s.meet.say(String(text), opts && opts.voice ? { voice: String(opts.voice) } : {});
      return { applied: true, result: r == null ? null : r };
    } catch (e) {
      if (String((e && e.message) || e) === CORE_VOICE_GAP) return { applied: false, gap: CORE_VOICE_GAP };
      throw e;
    }
  }
  // tts slot for S.Meeting: kokoro-js wrapped as {(text,opts)->{wav}}, the same engine MeetingBotDriver's
  // hostServices() hands the browser. Bound (not a one-time closure) so a Kokoro that is still loading at join time
  // is picked up the moment it is ready.
  async ttsFor(text, opts) {
    if (!this.kokoro && this.kokoroPromise) { try { this.kokoro = await this.kokoroPromise; } catch (e) { this.kokoro = null; } }
    if (!this.kokoro) throw new Error(CORE_VOICE_GAP);
    const voice = opts && opts.voice ? String(opts.voice) : undefined;
    return { wav: await this.kokoro.speak(String(text), voice) };
  }
  async meetingState(id) {
    const st = await this.session(id).meet.state();
    const me = (st && st.me) || {};
    return { applied: true, result: { hand: !!me.hand, mic: me.muted === false, camera: !!me.camera } };
  }
  async list() { return Array.from(this.sessions.keys()).map((id) => ({ id })); }
  botNames() { return [this.creds.name]; }
  botNameFor() { return this.creds.name; }
  async setLook({ name, picture }) {
    if (name && name !== this.creds.name) {
      if (this.sessions.size) throw new Error('Leave every meeting before renaming the bot.');
      this.creds.name = name;
    }
    if (picture !== undefined) this.picture = picture;
    return { name: this.creds.name, picture: !!this.picture };
  }
  async info() {
    const out = { state: this.state, mode: 'core', bot_name: this.creds.name, bot_picture: !!this.picture, stt_ready: false };
    if (this.error) out.error = this.error;
    out.bot_sessions = [];
    for (const [id, s] of this.sessions) out.bot_sessions.push({ session_id: id, transcribing: true, people: (s.people || []).map((p) => p.name) });
    return out;
  }
  async close() {
    const all = Array.from(this.sessions.keys());
    await Promise.all(all.map((id) => this.leave(id)));
    this.state = 'stopped';
  }
}
