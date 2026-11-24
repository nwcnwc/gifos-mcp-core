// Guard a room: the bot holds a GifOS room as its admin and keeps the room the way its owner set it.
//
// A guard is one room link plus a policy:
//   mode        'open'  an open room: the bot CAPTURES it ("Make me host") with a subscription file on a $5+
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
//               A pass whose ticket moved to another meeting comes back only with a fresh join of this one (the page
//               never takes a moved pass back by itself; reloading the file does not either): the guard leaves and
//               joins the room again (guard.rejoin), whatever its rank, so every sibling holds the ticket again.
//   voice       a Kokoro voice id (e.g. "af_heart", "bm_george"): the greeting is spoken aloud in that voice as well as
//               sent to chat. Unset: chat only. The voice runs in this bot's process (GIFOS_TTS_ENGINE=none turns it off).
//   picture     path of the bot's profile picture (GIF, PNG, JPEG, WebP, up to 256 KB), shown to the room like anyone's.
//               One picture per bot process; GIFOS_BOT_PICTURE wins when set. Rooms without a password blur it.
//   handler     path of a module exporting onMessage(message, room): called on the lead for every chat or spoken
//               line from a person; room.sendChat(text) and room.say(text) answer. See examples/.
//               With stage on, the handler is called only for the person the staged bot promoted (src/stagehost.js).
//   stage       false (default): the guard never touches the Stage. true: a bot takes a free Stage spot whenever no
//               bot is up there (it never moves a human), the bot on the Stage is the one that greets, and it brings
//               up one raised hand at a time. stage_idle_s, stage_max_s, stage_takeover_s, stage_done_words: src/stagehost.js.
//   name        optional fallback for the greeting's {bot} when the process has no bot name. GIFOS_BOT_NAME wins.
//
// plan() decides; it is pure (the unit tests drive it). RoomGuard runs it every few seconds against the bot's seat
// (room.js guard.* ops) and does what it says.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { roomFromLink } from './links.js';
import { makeLimiter, suffix } from './log-limit.js';
import { scrub } from './voice/settings.js';
import { STAGE_GREETING, firstName, noteLine, planStage, shouldAnswer, stageTiming, stageView } from './stagehost.js';

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
const RETAKE_EVERY_MS = 60000;  // a pass's moved ticket: one fresh join of the room per this long (a join takes ~15 s)
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
  const rank = Math.max(0, Math.trunc(Number(p.rank) || 0));
  const stage = stageTiming(p, rank);
  const greetCustom = typeof p.greet === 'string' && p.greet.includes('{names}');
  const out = {
    link: p.link, mode, topic: String(p.topic || ''),
    credentials: rel(p.credentials), host_password: p.host_password ? String(p.host_password) : '',
    join_password: p.join_password ? String(p.join_password) : (typeof p.password === 'string' ? p.password : ''),
    password: typeof p.password === 'string' && p.password !== '' ? p.password : null,
    blur_all: p.blur_all !== false,
    greet: p.greet === false ? false : (greetCustom ? p.greet : (stage.stage ? STAGE_GREETING : defaultGreeting(p.blur_all !== false))),
    rank,
    handler: rel(p.handler),
    voice: typeof p.voice === 'string' && /^[a-z]{2}_[a-z0-9]+$/i.test(p.voice.trim()) ? p.voice.trim() : '',
    picture: rel(p.picture),
    name: typeof p.name === 'string' ? p.name.trim().slice(0, 40) : '',
    ...stage,
  };
  if (mode === 'open' && !out.credentials) throw new Error('A public open-floor meeting (mode open) is held by capture: set credentials to a subscription file on a $5+ plan.');
  if (mode === 'admin' && !out.host_password) throw new Error('A private meeting (mode admin) needs host_password.');
  return out;
}

export function newMemory() {
  const never = -Infinity;   // no throttle has run yet, whatever the clock reads
  return { credLoaded: false, capOffSince: 0, lastCapture: never, lastReload: never, lastRetake: never, siblingSeenAt: 0, pwWrongSince: 0, lastPwFix: never,
    role: 'starting', seen: null, queue: [], lastGreet: never, blurGap: false, signinAt: never,
    stageEmptySince: null, stageFullNoted: false, promoted: null, onStage: false, served: null };
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
  // A pass rides in this meeting (held, or lost to another meeting): its ticket is retaken by a fresh join, not a reload.
  const viaPass = sub.via === 'pass' || (!sub.held && !!sub.pass);
  const retake = (why) => {
    if (now - mem.lastRetake < RETAKE_EVERY_MS) return;
    mem.lastRetake = now;
    out.events.push({ type: 'guard.retake', data: { why } });
    act('guard.rejoin', {}, why);
  };
  const PASS_MOVED = 'the pass\'s ticket moved to another meeting; a pass comes back only with a fresh join: join the room again';
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
    else if (!sub.held && sub.moved === 'moved' && viaPass) retake(PASS_MOVED);
    else if (!sub.held && sub.moved && !viaPass && now - mem.lastReload > RELOAD_EVERY_MS) { mem.lastReload = now; act('guard.credentials', {}, 'the subscription\'s ticket is ' + sub.moved + ': join this meeting with it again'); }
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
  } else if (viaPass) {
    // Every sibling holds a pass's ticket in this room at once, so a seat without it lost it to another meeting (or is
    // still joining): it takes it back with a fresh join while a sibling, if any, leads.
    setRole('coadmin', 'holds the meeting by the shared pass; its ticket is ' + (sub.moved || 'not here yet'));
    if (sub.moved === 'moved') retake(PASS_MOVED);
    if (pwWrong && now - mem.pwWrongSince > 6000) fixPassword('the lead has not fixed the password');
    else if (pwWrong && !mem.pwWrongSince) mem.pwWrongSince = now;
    leadDuties(state, policy, mem, now, false, act, out);
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
  // Stage off: the lead greets, and a co-admin does not (it does not greet them later either).
  // Stage on: the seat that is on the Stage greets, whether or not it is the lead.
  const mayGreet = policy.stage ? !!(state.stage && state.stage.me_on) : lead;
  if (!mayGreet) { if (mem.seen) for (const p of people) mem.seen.add(p.id); mem.queue = []; return; }
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

export function greetingText(template, names, bot) {
  const clean = names.map((n) => String(n || '').replace(/https?:\/\/\S+/gi, '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'friend');
  const shown = clean.slice(0, 6), more = clean.length - shown.length;
  const who = shown.length === 1 ? shown[0] : shown.slice(0, -1).join(', ') + (more > 0 ? ', ' + shown[shown.length - 1] + ' and ' + more + ' more' : ' and ' + shown[shown.length - 1]);
  let text = String(template || GREETING).replace('{names}', who);
  if (bot != null && text.includes('{bot}')) text = text.replaceAll('{bot}', firstName(bot) || 'GifOS');
  return text;
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
  botName() { const n = typeof this.ctx.ourNames === 'function' ? this.ctx.ourNames() : [this.ctx.botName]; return String((n && n[0]) || this.ctx.botName || this.policy.name || ''); }
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
      this.meetingId = meeting.meeting_id; this.joinFails = 0;
      // A new seat starts over, but keeps the clock of its last fresh join for a moved pass (one a minute, never a storm).
      this.mem = Object.assign(newMemory(), { role: 'waiting', lastRetake: this.mem.lastRetake });
      this.note('guard.joined', { link: this.policy.link.replace(/[?#&]pw=[^&]*/, '') });
      // A handler needs the room's lines. With GIFOS_ALWAYS_TRANSCRIBE=0 the join starts no poll, so the handler and
      // the Stage's "thanks" never heard anyone (seen live 2026-11-24). Poll the lines the page already keeps (chat and
      // others' shared captions); this does not turn on the bot's own Whisper.
      if (this.handler && this.ctx.captions && !meeting.transcribing && typeof this.ctx.captions.start === 'function') {
        await Promise.resolve(this.ctx.captions.start(this.live() || meeting)).catch(() => {});
      }
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
      // Stage on: who is up, read before plan(), so the seat on the Stage is the one allowed to greet.
      let stageNow = null;
      if (this.policy.stage && st && st.supported && st.seated) {
        let snap = null;
        try { snap = await this.ctx.bot.room(m.session_id, 'stage.get', {}); }
        catch (e) { this.note('guard.stage_failed', { text: String((e && e.message) || e).slice(0, 200) }); }
        if (snap) { stageNow = stageView(st, snap, this.botName()); this.mem.names = stageNow.people.map((q) => q.name); st.stage = { me_on: stageNow.me_on }; }
        else st.stage = { me_on: false };
      }
      const p = plan(st, this.policy, this.mem, Date.now());
      this.last = { at: new Date().toISOString(), role: p.role, participants: st && st.participants, capture: st && st.capture, password_set: st && st.password_set,
        password_ok: st && st.password_ok, subscription: st && st.subscription, blur_all: st && st.blur_all,
        // For a sibling's updater (gifos-meet-mcp scripts/self-update.sh): restart only while a sibling holds the room.
        seated: !!(st && st.seated), sibling_seen_at: this.mem.siblingSeenAt ? new Date(this.mem.siblingSeenAt).toISOString() : null };
      for (const e of p.events) this.note(e.type, e.data);
      for (const a of p.actions) {
        if (a.op === 'guard.rejoin') { await this.rejoin(m, a.why); return; }
        const args = a.op === 'guard.credentials' ? { gif_b64: this.credB64 } : a.args;
        try { const v = await this.ctx.bot.room(m.session_id, a.op, args); this.note('guard.action', { op: a.op, why: a.why, ok: true, v: a.op === 'guard.credentials' ? { loaded: !!(v && v.loaded) } : v }); }
        catch (e) { this.note('guard.action', { op: a.op, why: a.why, ok: false, error: String((e && e.message) || e).slice(0, 200) }); }
      }
      if (p.greet && p.greet.length) {
        const names = this.policy.stage ? p.greet.map((n) => firstName(n)) : p.greet;
        const text = greetingText(this.policy.greet, names, this.policy.stage ? this.botName() : undefined);
        await this.greet(text).then(() => this.note('guard.greeted', { n: p.greet.length, spoken: !!this.policy.voice }), (e) => { this.mem.queue.unshift(...p.greet.map((name) => ({ id: '', name, at: 0 }))); this.note('guard.greet_failed', { text: String(e.message || e).slice(0, 120) }); });
      }
      if (stageNow && stageNow.ok) await this.applyStage(m, planStage(stageNow, this.mem, Date.now(), this.policy));
    } finally { this.busy = false; }
  }
  // What planStage decided: take a free spot, grant one person up or down, thank them, log a full Stage once.
  async applyStage(m, d) {
    if (!d) return;
    if (d.log) this.note('guard.stage', { note: d.log });
    for (const a of d.actions) {
      const args = a.op === 'stage.set' ? { on: !!a.on } : { person_id: a.person_id, on: !!a.on };
      try { const v = await this.ctx.bot.room(m.session_id, a.op, args); this.note('guard.action', { op: a.op, why: d.note, ok: true, v }); }
      catch (e) { this.note('guard.action', { op: a.op, why: d.note, ok: false, error: String((e && e.message) || e).slice(0, 200) }); }
    }
    if (!d.thanks) return;
    try { await this.greet(d.thanks); this.note('guard.stage_thanks', { spoken: !!this.policy.voice }); }
    catch (e) { this.note('guard.stage_thanks', { ok: false, text: String((e && e.message) || e).slice(0, 160) }); }
  }
  // Leave the room and join it again at the next tick: a page start, the one way a GifOS page takes back a pass that
  // moved to another meeting. The new seat loads the credentials and proves its key again (plan() from 'waiting').
  async rejoin(m, why) {
    try { await this.ctx.depart(m, 'guard'); }
    catch (e) { this.note('guard.action', { op: 'guard.rejoin', why, ok: false, error: String((e && e.message) || e).slice(0, 200) }); return; }
    this.note('guard.action', { op: 'guard.rejoin', why, ok: true });
    this.meetingId = null; this.nextJoin = 0;
    this.mem.role = 'waiting';
  }
  // Chat first (the line people can read), then the same words aloud when the policy has a voice. A voice that
  // fails (no Kokoro on this box) is noted and never fails the greeting: the chat line already went.
  async greet(text) {
    await this.sendChat(text);
    if (!this.policy.voice) return;
    try {
      const said = await this.ctx.bot.interject(this.live().session_id, text.replace(/https?:\/\/\S+/g, '').slice(0, 400), { voice: this.policy.voice });
      if (!said || said.applied === false) throw new Error((said && said.gap) || 'Meeting Bot cannot speak yet');
    }
    catch (e) { this.note('guard.voice_failed', { text: String((e && e.message) || e).slice(0, 160) }); }
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
  // Stage on: only the bot that is on the Stage, and only the person it promoted. The join greeting is the other
  // thing this bot says. a line with a seat id is matched by id; one without is matched by name only
  // while the name is unique in the room (shouldAnswer).
  hookLines() {
    if (!this.handler || !this.ctx.transcript || typeof this.ctx.transcript.onLine !== 'function') return;
    const ours = () => new Set(typeof this.ctx.ourNames === 'function' ? this.ctx.ourNames() : [this.botName()]);
    const fn = (row) => {
      if (!row || row.meeting_id !== this.meetingId || ours().has(row.speaker) || (row.kind !== 'chat' && row.kind !== 'speech')) return;
      const msg = { text: row.text, from: row.speaker, fromId: row.speaker_id || '', kind: row.kind, at: row.ts };
      if (this.policy.stage) {
        if (!shouldAnswer(this.mem, msg)) return;
        if (!noteLine(this.mem, msg, this.policy).answer) return;
      } else if (this.mem.role !== 'lead') return;
      const room = { meeting_id: this.meetingId, link: this.policy.link, sendChat: (t) => this.sendChat(String(t).slice(0, 2000)), say: (t) => this.say(String(t).slice(0, 2000)) };
      Promise.resolve().then(() => this.handler(msg, room))
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
  for (const p of list) {
    const pol = normalizePolicy(p, path.dirname(path.resolve(file)));
    // The bot's picture is read when its browser starts, which is after this: the first guard with one sets it.
    if (pol.picture && opts.cfg && !opts.cfg.botPicture) opts.cfg.botPicture = pol.picture;
    out.push(await new RoomGuard(ctx, pol, opts).start());
  }
  return out;
}
