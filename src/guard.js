// Guard a room: the bot holds a GifOS room as its admin and keeps the room the way its owner set it.
//
// A guard is one room link plus a policy:
//   mode        'open'  an open room: the bot CAPTURES it ("Make me admin") with a subscription file on the $5 or $10
//                       plan, so nobody else can take it or set its password (GifOS 0.9.26).
//               'admin' a room with a host: the bot signs in as its host with host_password.
//   credentials path of the subscription file (the GifOS credentials GIF people export from Settings > Subscription).
//               Read once at start; its bytes go only into the bot's own browser. Never logged or returned.
//   password    null (default): the room has no password; the bot clears any that appears.
//               '<value>': the bot sets it and puts it back if it changes.
//   blur_all    press "Blur guests" when the page offers it to the bot.
//   greet       true (default text), a text with {names}, or false. The default says "Clear video is disabled." only with blur_all.
//   Removing someone is setting a password (everyone inside keeps it, the removed person does not get it). GifOS keeps
//   no ban list, by design: a person can change browsers. So a room held with no password removes nobody; to remove
//   people, hold the room with a password.
//   rank        0, 1, ...: SIBLINGS. Copies of one guard (the same credentials file, or the same host_password) run on
//               several computers, each with its own name. A sibling is known by its KEY, never by its name: the page
//               names a seat an admin only after verifying its signed orders against the room's one admin key (an open
//               room's capture key, the same check that makes a second session of one pass admin; a room with a host,
//               the host key). So an admin seat beside this one, while this one is admin too, holds the same key. A
//               visitor who takes a sibling's name is a visitor. All siblings are the room's admin at once;
//               the one that holds the subscription's meeting ticket is the LEAD (greets, answers chat). When
//               the lead's seat is gone the next sibling takes the ticket back, rank 0 first.
//               A PASS (the staff pass) keeps a ticket in every session of one room (the pay Worker's sameMeeting),
//               so all siblings hold one: the lowest rank present leads, the others are co-admins until its seat goes.
//   handler     path of a module exporting onMessage(message, room): called on the lead for every chat or spoken
//               line from a person; room.sendChat(text) and room.say(text) answer. See examples/.
//
// plan() decides; it is pure (the unit tests drive it). RoomGuard runs it every few seconds against the bot's seat
// (room.js guard.* ops) and does what it says.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { roomFromLink } from './links.js';
import { makeLimiter, suffix } from './log-limit.js';
import { scrub } from './voice/settings.js';

export const GREETING = 'Welcome, {names}! This is a GifOS public room: be kind. If someone is out of line, tap Vote, then "Vote out of room" on them.';
// Said only when the guard blurs everyone (blur_all): otherwise it is not true.
export const CLEAR_VIDEO_NOTE = 'Clear video is disabled.';
const TICK_MS = 3000;
const CAPTURE_EVERY_MS = 8000;
const RELOAD_EVERY_MS = 30000;
const GREET_EVERY_MS = 12000;   // an open room's chat is in slow mode: one line per 10 s
// A newcomer is greeted once it has sat this long and is not an admin: a sibling sits down as a guest and is an admin
// one guard tick (3 s) after it loads its credentials, plus one page beat (4 s) for its signed orders to reach the lead,
// plus the lead's next tick (3 s). So a sibling is not greeted, whatever its name.
const GREET_SETTLE_MS = 10000;
const RANK_DELAY_MS = 60000;    // with nobody holding the room, rank N waits N x this before taking it
const SIBLING_GONE_MS = 45000;  // the lead's seat gone this long (+20 s per rank): take the ticket back
const SESSION_GONE_RE = /not in that meeting any more|No such meeting/;   // room.js / driver.js / Meet Bot: the session frame is gone

// The default welcome: neutral; it adds the clear-video note only when the guard blurs everyone.
export function defaultGreeting(blurAll) {
  return blurAll ? GREETING.replace('be kind.', 'be kind. ' + CLEAR_VIDEO_NOTE) : GREETING;
}

export function normalizePolicy(p, base) {
  if (!p || typeof p !== 'object') throw new Error('A guard needs a policy object.');
  if (!p.link || typeof p.link !== 'string') throw new Error('A guard needs the room link.');
  const mode = p.mode === 'admin' ? 'admin' : 'open';
  const rel = (f) => (f ? path.resolve(base || process.cwd(), String(f)) : '');
  const out = {
    link: p.link, mode, topic: String(p.topic || ''),
    credentials: rel(p.credentials), host_password: p.host_password ? String(p.host_password) : '',
    join_password: p.join_password ? String(p.join_password) : (typeof p.password === 'string' ? p.password : ''),
    password: typeof p.password === 'string' && p.password !== '' ? p.password : null,
    blur_all: p.blur_all !== false,
    greet: p.greet === false ? false : (typeof p.greet === 'string' && p.greet.includes('{names}') ? p.greet : defaultGreeting(p.blur_all !== false)),
    rank: Math.max(0, Math.trunc(Number(p.rank) || 0)),
    handler: rel(p.handler),
  };
  if (mode === 'open' && !out.credentials) throw new Error('A public open-floor meeting (mode open) is held by capture: set credentials to a subscription file on the $5 or $10 plan.');
  if (mode === 'admin' && !out.host_password) throw new Error('A private meeting (mode admin) needs host_password.');
  return out;
}

export function newMemory() {
  const never = -Infinity;   // no throttle has run yet, whatever the clock reads
  return { credLoaded: false, capOffSince: 0, lastCapture: never, lastReload: never, siblingSeenAt: 0, pwWrongSince: 0, lastPwFix: never,
    role: 'starting', seen: null, queue: [], lastGreet: never, blurGap: false, signinAt: never };
}

// state: the guard.state op's answer (people[].admin: the page verified that seat's admin key).
// Returns { role, actions: [{ op, args, why }], greet: [names] | null, events: [{ type, data }] }.
export function plan(state, policy, mem, now) {
  const out = { role: mem.role, actions: [], greet: null, events: [] };
  const act = (op, args, why) => out.actions.push({ op, args: args || {}, why });
  const setRole = (r, why) => { if (r !== mem.role) out.events.push({ type: 'guard.role', data: { from: mem.role, to: r, why } }); mem.role = r; out.role = r; };
  if (!state || !state.supported) { setRole('unsupported', 'this GifOS site has no room capture yet (it needs 0.9.26 or newer)'); return out; }
  if (!state.seated) { setRole(state.locked_out ? 'locked-out' : 'waiting', state.locked_out ? 'the door asks for a password' : 'not seated yet'); return out; }
  // A sibling: another seat the page proves an admin while this seat is admin too. The room has one admin key, so it
  // holds this bot's key. Its name plays no part.
  const amAdmin = !!(state.host || (state.capture && state.capture.mine));
  const sibling = amAdmin && (state.people || []).some((p) => p.id !== state.me && p.admin === true);
  if (sibling) mem.siblingSeenAt = now;
  const sub = state.subscription || {};
  const wantPw = policy.password || '';
  // The password: wrong means set when it should be none, or (state.password_ok false) not the value it should be.
  const pwWrong = wantPw ? state.password_ok === false : !!state.password_set;
  const fixPassword = (why) => {
    if (!pwWrong) { mem.pwWrongSince = 0; return; }
    if (!mem.pwWrongSince) mem.pwWrongSince = now;
    if (now - mem.lastPwFix < 3000) return;
    mem.lastPwFix = now;
    act('guard.password', { value: wantPw }, why);
  };

  if (policy.mode === 'admin') {
    if (!mem.credLoaded && policy.credentials) { act('guard.credentials', {}, 'the room carries the subscription\'s plan'); mem.credLoaded = true; }
    if (!state.host) {
      setRole('signing-in', 'not the host yet');
      if (now - mem.signinAt > 20000) { mem.signinAt = now; act('host.signin', { password: policy.host_password }, 'sign in as the room\'s host'); }
      return out;
    }
    const lead = !sibling || (policy.credentials ? !!sub.held : policy.rank === 0);
    setRole(lead ? 'lead' : 'coadmin', lead ? 'host of the room' : 'host of the room beside its sibling');
    fixPassword('the room password is not what the policy says');
    leadDuties(state, policy, mem, now, lead, act, out);
    return out;
  }

  // ---- an open room, held by capture ----
  const cap = state.capture || {};
  if (!cap.on) {
    if (!mem.capOffSince) mem.capOffSince = now;
    setRole('taking', 'nobody holds the room');
    if (!mem.credLoaded) {
      if (now - mem.capOffSince >= policy.rank * RANK_DELAY_MS) { mem.credLoaded = true; act('guard.credentials', {}, 'load the subscription to take the room'); }
    } else if (cap.can_take && now - mem.lastCapture > CAPTURE_EVERY_MS) { mem.lastCapture = now; act('guard.capture', {}, 'take charge of the meeting ("Make me host")'); }
    else if (!sub.held && sub.moved && now - mem.lastReload > RELOAD_EVERY_MS) { mem.lastReload = now; act('guard.credentials', {}, 'the subscription\'s ticket is ' + sub.moved + ': join this meeting with it again'); }
    fixPassword('a public open-floor meeting nobody holds had its password changed; anyone inside may set it');
    return out;
  }
  mem.capOffSince = 0;
  if (!mem.credLoaded) { mem.credLoaded = true; act('guard.credentials', {}, 'the room is held: load the subscription (a sibling\'s key lets the bot hold it too)'); return out; }
  if (!cap.mine) {
    if (mem.role !== 'held-by-other') out.events.push({ type: 'guard.taken', data: { note: 'Someone else holds this room until their subscription ticket ends; the bot takes it back then.' } });
    setRole('held-by-other', 'another subscriber holds the room');
    return out;
  }
  if (sub.held && sub.via === 'pass' && sibling && policy.rank > 0) {
    // Every sibling holds the pass's ticket: the lower rank beside this one leads.
    setRole('coadmin', 'holds the meeting by the shared pass; a sibling of lower rank leads');
    if (pwWrong && !mem.pwWrongSince) mem.pwWrongSince = now;
    else if (pwWrong && now - mem.pwWrongSince > 6000) fixPassword('the lead has not fixed the password');
    else if (!pwWrong) mem.pwWrongSince = 0;
    leadDuties(state, policy, mem, now, false, act, out);
  } else if (sub.held) {
    setRole('lead', 'leads, holds the meeting ticket');
    fixPassword('the room password is not what the policy says');
    leadDuties(state, policy, mem, now, true, act, out);
  } else {
    setRole('coadmin', 'holds the meeting by the shared key; a sibling holds the ticket');
    if (pwWrong && now - mem.pwWrongSince > 6000) fixPassword('the lead has not fixed the password');
    else if (pwWrong && !mem.pwWrongSince) mem.pwWrongSince = now;
    if (!sibling && now - (mem.siblingSeenAt || 0) > SIBLING_GONE_MS + policy.rank * 20000 && now - mem.lastReload > RELOAD_EVERY_MS) {
      mem.lastReload = now;
      out.events.push({ type: 'guard.takeover', data: { why: 'the lead\'s seat is gone' } });
      act('guard.credentials', {}, 'take the subscription\'s ticket back: the lead is gone');
    }
  }
  return out;
}

function leadDuties(state, policy, mem, now, lead, act, out) {
  if (policy.blur_all && state.blur_all) {
    if (state.blur_all.offered && !state.blur_all.on) act('guard.blur_all', { on: true }, 'the policy blurs every guest');
    else if (!state.blur_all.offered && !mem.blurGap) { mem.blurGap = true; out.events.push({ type: 'guard.gap', data: { what: 'blur_all', note: 'This GifOS page offers Blur guests only to the host of a private meeting; with no password the room shows no clear video anyway.' } }); }
  }
  const people = state.people || [];
  if (!lead) { if (mem.seen) for (const p of people) mem.seen.add(p.id); mem.queue = []; return; }   // the lead greets them; this bot does not later
  if (!mem.seen) { mem.seen = new Set(people.map((p) => p.id)); return; }   // who was here when this bot became the lead: not newcomers
  for (const p of people) {
    if (p.id === state.me) continue;
    if (!mem.seen.has(p.id) && p.name) { mem.seen.add(p.id); mem.queue.push({ id: p.id, name: p.name, at: now }); }
  }
  // Greet only who is still here and not an admin (a sibling, or the room's host).
  const guests = new Set(people.filter((p) => p.admin !== true).map((p) => p.id));
  mem.queue = mem.queue.filter((q) => !q.id || guests.has(q.id));
  const due = mem.queue.filter((q) => now - q.at >= GREET_SETTLE_MS);
  if (policy.greet && due.length && now - mem.lastGreet >= GREET_EVERY_MS) {
    mem.lastGreet = now;
    mem.queue = mem.queue.filter((q) => now - q.at < GREET_SETTLE_MS);
    out.greet = due.map((q) => q.name);
  }
}

export function greetingText(template, names) {
  const clean = names.map((n) => String(n || '').replace(/https?:\/\/\S+/gi, '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'friend');
  const shown = clean.slice(0, 6), more = clean.length - shown.length;
  const who = shown.length === 1 ? shown[0] : shown.slice(0, -1).join(', ') + (more > 0 ? ', ' + shown[shown.length - 1] + ' and ' + more + ' more' : ' and ' + shown[shown.length - 1]);
  return String(template || GREETING).replace('{names}', who);
}

// ---- the loop over one room ----
export class RoomGuard {
  constructor(ctx, policy, { log, logLimiter } = {}) {
    this.ctx = ctx; this.policy = policy; this.log = log || (() => {});
    if (typeof ctx.holdSecret === 'function') for (const s of [policy.host_password, policy.password, policy.join_password]) ctx.holdSecret(s || '');   // masked everywhere
    this.logLim = logLimiter || makeLimiter();   // a visitor or chat flood must not flood the journal (src/log-limit.js)
    this.mem = newMemory(); this.meetingId = null; this.timer = null; this.busy = false; this.last = null; this.handler = null;
    this.credB64 = policy.credentials ? fs.readFileSync(policy.credentials).toString('base64') : '';
    this.joinFails = 0; this.nextJoin = 0; this.unhook = null;
    if (ctx.credentials && typeof ctx.credentials.guardRoom === 'function') ctx.credentials.guardRoom(roomFromLink(policy.link));
  }
  botName() { const n = typeof this.ctx.ourNames === 'function' ? this.ctx.ourNames() : [this.ctx.botName]; return String((n && n[0]) || this.ctx.botName || ''); }
  async start() {
    if (this.policy.handler) {
      const mod = await import(pathToFileURL(this.policy.handler).href);
      this.handler = typeof mod.onMessage === 'function' ? mod.onMessage : (mod.default && mod.default.onMessage) || null;
      if (!this.handler) throw new Error('The guard handler module exports no onMessage.');
    }
    this.hookLines();
    this.timer = setInterval(() => this.tick().catch((e) => this.note('guard.error', { text: String((e && e.message) || e).slice(0, 200) })), TICK_MS);
    await this.tick().catch(() => {});
    return this;
  }
  stop() { clearInterval(this.timer); this.timer = null; if (this.unhook) this.unhook(); }
  note(type, data) {
    try { this.ctx.emit({ type, meeting_id: this.meetingId || undefined, data }); } catch (e) {}
    const r = this.logLim.take(type);   // the kind is the event type: chosen here in code, never by the room
    if (r.ok) this.log(scrub(type + ' ' + JSON.stringify(data), [this.policy.host_password, this.policy.password, this.policy.join_password].concat(typeof this.ctx.secrets === 'function' ? this.ctx.secrets() : [])) + suffix(r));
  }
  live() { const m = this.meetingId && this.ctx.meetings.get(this.meetingId); return m && m.state === 'live' && m.session_id ? m : null; }
  async ensureJoined() {
    if (this.live()) return this.live();
    if (Date.now() < this.nextJoin) return null;
    try {
      const { meeting } = await this.ctx.joinByLink(this.policy.link, this.policy.join_password, this.policy.topic || 'guard');
      this.meetingId = meeting.meeting_id; this.joinFails = 0; this.mem = Object.assign(newMemory(), { role: 'waiting' });
      this.note('guard.joined', { link: this.policy.link.replace(/[?#&]pw=[^&]*/, '') });
      return this.live();
    } catch (e) {
      this.joinFails++; this.nextJoin = Date.now() + Math.min(120000, 5000 * 2 ** this.joinFails);
      this.note('guard.join_failed', { text: String((e && e.message) || e).slice(0, 200) });
      return null;
    }
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      const m = await this.ensureJoined(); if (!m) return;
      const want = this.policy.password || '';
      let st;
      try { st = await this.ctx.bot.room(m.session_id, 'guard.state', { want }); }
      catch (e) {
        // The meeting session is gone (a site deploy moves open pages to the new version and drops Meeting Bot's
        // session frames; seen live: both welcome bots sat out for minutes). Mark the seat gone and join again at the
        // next tick, instead of asking a dead session every tick.
        if (!SESSION_GONE_RE.test(String((e && e.message) || e))) throw e;
        this.note('guard.rejoin', { why: 'the meeting session is gone (the site was updated, or the page dropped it)' });
        if (typeof this.ctx.holdSeat === 'function') this.ctx.holdSeat(m.meeting_id, { state: 'scheduled', session_id: null, transcribing: false, reseat: false });
        this.meetingId = null; this.mem = Object.assign(newMemory(), { role: 'waiting' });
        return;
      }
      const p = plan(st, this.policy, this.mem, Date.now());
      this.last = { at: new Date().toISOString(), role: p.role, participants: st && st.participants, capture: st && st.capture, password_set: st && st.password_set,
        password_ok: st && st.password_ok, subscription: st && st.subscription, blur_all: st && st.blur_all };
      for (const e of p.events) this.note(e.type, e.data);
      for (const a of p.actions) {
        const args = a.op === 'guard.credentials' ? { gif_b64: this.credB64 } : a.args;
        try { const v = await this.ctx.bot.room(m.session_id, a.op, args); this.note('guard.action', { op: a.op, why: a.why, ok: true, v: a.op === 'guard.credentials' ? { loaded: !!(v && v.loaded) } : v }); }
        catch (e) { this.note('guard.action', { op: a.op, why: a.why, ok: false, error: String((e && e.message) || e).slice(0, 200) }); }
      }
      if (p.greet && p.greet.length) await this.sendChat(greetingText(this.policy.greet, p.greet)).then(() => this.note('guard.greeted', { n: p.greet.length }), (e) => { this.mem.queue.unshift(...p.greet.map((name) => ({ id: '', name, at: 0 }))); this.note('guard.greet_failed', { text: String(e.message || e).slice(0, 120) }); });
    } finally { this.busy = false; }
  }
  async sendChat(text) {
    const m = this.live(); if (!m) throw new Error('The bot is not in the room.');
    await this.ctx.bot.say(m.session_id, text);
    this.ctx.transcript.append({ meeting_id: m.meeting_id, speaker: this.botName(), text, kind: 'chat' });
  }
  async say(text) {
    const m = this.live(); if (!m) throw new Error('The bot is not in the room.');
    await this.ctx.bot.interject(m.session_id, text);
  }
  // Every chat or spoken line from a person in this room reaches the handler, on the lead only (one answer per line).
  hookLines() {
    if (!this.handler || !this.ctx.transcript || typeof this.ctx.transcript.onLine !== 'function') return;
    const ours = () => new Set(typeof this.ctx.ourNames === 'function' ? this.ctx.ourNames() : [this.botName()]);
    const fn = (row) => {
      if (!row || row.meeting_id !== this.meetingId || ours().has(row.speaker) || (row.kind !== 'chat' && row.kind !== 'speech')) return;
      if (this.mem.role !== 'lead') return;
      const room = { meeting_id: this.meetingId, link: this.policy.link, sendChat: (t) => this.sendChat(String(t).slice(0, 2000)), say: (t) => this.say(String(t).slice(0, 2000)) };
      Promise.resolve().then(() => this.handler({ text: row.text, from: row.speaker, kind: row.kind, at: row.ts }, room))
        .catch((e) => this.note('guard.handler_error', { text: String((e && e.message) || e).slice(0, 200) }));
    };
    const off = this.ctx.transcript.onLine(fn);
    this.unhook = typeof off === 'function' ? off : null;
  }
  status() { return { meeting_id: this.meetingId, link: this.policy.link, mode: this.policy.mode, rank: this.policy.rank, password: this.policy.password ? 'held' : 'none', ...(this.last || { role: this.mem.role }) }; }
}

// GIFOS_GUARD_CONFIG: { "guards": [ policy, ... ] } (paths relative to the file). Started when the server starts.
export async function startGuardsFromConfig(ctx, file, opts = {}) {
  const conf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(conf.guards) ? conf.guards : [conf];
  const out = [];
  for (const p of list) out.push(await new RoomGuard(ctx, normalizePolicy(p, path.dirname(path.resolve(file))), opts).start());
  return out;
}
