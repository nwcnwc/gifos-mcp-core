// The Meeting Bot with no browser (GIFOS_BOT_MODE=core). Each meeting is a participant of the GifOS core running in
// this process, through the agent SDK's core transport (@gifos-app/agent): the meeting's own code, loaded from the
// meeting's site, over real WebRTC data channels. It holds a seat, reads people, chat and the captions people share,
// posts chat, and leaves. It has no voice, camera or recording yet: those tools answer with their gap, as for a
// Meeting Bot app without the method.
//
// Surface: the same duck-typed bot the tools call (ensureStarted, join, leave, say, people, transcript, chat,
// transcribe, networkWarning, botNames, botNameFor, setLook, info, close, room).
import path from 'node:path';
import { log } from './log.js';

export const CORE_ROOM_GAP = 'This room action needs the browser Meeting Bot; the bot runs with no browser (GIFOS_BOT_MODE=core).';


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
      profile: path.join(this.cfg.home, 'core-bot'), webrtc: this.opts.webrtc,
    });
    const meet = new S.Meeting(transport, { tts: null });
    meet.core = true;
    const id = 'c' + (++this.seq);
    const s = { meet, link, lines: [], chat: [], people: [] };
    this.sessions.set(id, s);
    meet.on('people', (p) => { s.people = Array.isArray(p) ? p : s.people; });
    meet.on('line', (l) => {
      if (!l || l.final === false) return;
      if (l.kind === 'chat') s.chat.push({ by: l.name || '', at: l.ts || Date.now(), text: String(l.text || '') });
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
        if (l.kind === 'chat') s.chat.push({ by: l.name || '', at: l.ts || 0, text: String(l.text || '') });
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
  async room() { throw new Error(CORE_ROOM_GAP); }
  // the browser bot's whenMethod shape: { applied, result } or { applied: false, gap }
  async raiseHand(id, on) { const r = await this.session(id).meet.hand(!!on); return { applied: true, result: { hand: !!(r && r.up) } }; }
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
