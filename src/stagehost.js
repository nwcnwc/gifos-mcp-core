// Stage holding, the join greeting's words, and the one-at-a-time hand queue.
// Pure: no I/O. RoomGuard calls planStage from its tick when policy.stage is on
// (src/guard.js). With stage off, nothing here runs and the guard is unchanged.
//
// Welcome hosts are bots. A person on the Stage is a bot when they are this seat
// or an admin (a sibling that holds the room's key). A human is anyone else.
// The Stage has several spots (the page's stage cap). A bot takes a free spot
// when no bot is up there, and never moves a human off.

export const STAGE_GREETING = "Hi {names}, welcome to GifOS! I'm {bot}, a bot. To ask me anything, ask in chat, or raise your hand to talk. Tip: to hear only the Stage, turn down My row and The stadium in Settings > Sound mix.";

// Said by the person on the Stage when they are finished. Matched as phrases, not as pieces of longer words.
export const STAGE_DONE_WORDS = ['thanks', 'thank you', 'bye', 'goodbye', "that's all", 'thats all'];

// A grant that never becomes a step-up is dropped. The page only steps up while the hand is still raised.
export const PROMOTE_ARRIVE_MS = 20000;

export function defaultTakeoverS(rank) {
  return 6 + 6 * Math.max(0, Math.trunc(Number(rank) || 0));
}

export function stageTiming(p, rank) {
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : d; };
  const src = p && Array.isArray(p.stage_done_words) ? p.stage_done_words.map((w) => String(w).toLowerCase()).filter(Boolean) : [];
  return {
    stage: !!(p && p.stage === true),
    stage_idle_s: n(p && p.stage_idle_s, 45),
    // A promoted person's first line takes longer than the next ones (walking up, typing a question).
    stage_first_s: n(p && p.stage_first_s, 120),
    stage_max_s: n(p && p.stage_max_s, 240),
    stage_takeover_s: n(p && p.stage_takeover_s, defaultTakeoverS(rank)),
    stage_done_words: src.length ? src : STAGE_DONE_WORDS.slice(),
  };
}

// The room's display name, first word only (the greeting names people that way).
export function firstName(name) {
  const clean = String(name || '').replace(/https?:\/\/\S+/gi, '').replace(/[\u0000-\u001f<>]/g, '').trim();
  return (clean.split(/\s+/).filter(Boolean)[0] || '').slice(0, 24);
}

export function thanksLine(name) {
  return 'Thanks, ' + (firstName(name) || 'friend') + "! You're back in the row.";
}

export function saysDone(text, words) {
  const t = String(text || '').toLowerCase();
  for (const w of words || STAGE_DONE_WORDS) {
    const esc = String(w).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!esc) continue;
    if (new RegExp('(^|[^a-z])' + esc + '([^a-z]|$)', 'i').test(t)) return true;
  }
  return false;
}

// stage.get cuts ids to 12 characters (the page's stageInfo). A cut id matches the full one.
// Two different full ids that share a prefix do not match.
function idsMatch(a, b) {
  if (a == null || b == null || a === '' || b === '') return false;
  const x = String(a), y = String(b);
  if (x === y) return true;
  if (x.length === 12 && y.length > 12 && y.startsWith(x)) return true;
  if (y.length === 12 && x.length > 12 && x.startsWith(y)) return true;
  return false;
}

function handOf(p) {
  if (!p || !Object.prototype.hasOwnProperty.call(p, 'hand')) return undefined;
  return typeof p.hand === 'number' && p.hand > 0 ? p.hand : null;
}

// state: guard.state. stage: stage.get (null when the read failed). botName: this seat's name.
export function stageView(state, stage, botName) {
  const st = state || {};
  const sg = stage || {};
  const people = st.people || [];
  const me = st.me;
  const on = Array.isArray(sg.on_stage) ? sg.on_stage : [];
  // stage.get's bot flag means "this seat" (s.me), not "a bot". A sibling is an admin.
  const isBot = (s) => !!(s && (s.bot || idsMatch(s.id, me) || people.some((p) => (p.admin || p.bot) && idsMatch(p.id, s.id))));
  const seats = Number(sg.seats) || 0;
  return {
    ok: seats > 0,
    me,
    me_on: !!(sg.bot_on_stage || on.some((s) => s && (s.bot || idsMatch(s.id, me)))),
    am_admin: !!(st.host || (st.capture && st.capture.mine)),
    botName: botName || '',
    seats,
    on_stage: on.map((s) => ({ id: s.id, name: s.name || '', bot: isBot(s) })),
    people: people.map((p) => {
      const row = { id: p.id, name: p.name || '', admin: !!p.admin, bot: !!(p.bot || p.admin || idsMatch(p.id, me)) };
      const h = handOf(p);
      if (h !== undefined) row.hand = h;
      return row;
    }),
  };
}

// First raised, then id. Skips this seat, bots (admins), people already up, and a hand we just finished
// (same raise stamp: they said thanks while the stamp was still up, so they are not immediately called again).
export function queueHands(people, opt = {}) {
  const on = opt.on || [];
  const served = opt.served;
  const rows = [];
  for (const p of people || []) {
    if (!p || !p.id) continue;
    const t = typeof p.hand === 'number' && p.hand > 0 ? p.hand : 0;
    if (!t) continue;
    if (opt.me && idsMatch(p.id, opt.me)) continue;
    if (p.admin || p.bot) continue;
    if (on.some((s) => idsMatch(s.id, p.id))) continue;
    if (served && idsMatch(p.id, served.id) && served.hand && t === served.hand) continue;
    rows.push({ id: p.id, name: p.name || '', hand: t });
  }
  rows.sort((a, b) => (a.hand - b.hand) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

function findPerson(people, id) {
  return (people || []).find((p) => idsMatch(p.id, id)) || null;
}

// A line is matched to the promoted person by SEAT ID (message.fromId) whenever the line carries one.
// A line with no id (a caption line is only "Name: words") is matched by name, and only while that name is
// unique among the people in the room (mem.names, read each tick): two people may share a name, and a
// second "Ana" must never be answered as the promoted Ana.
export function shouldAnswer(mem, message) {
  if (!mem || !mem.onStage || !mem.promoted) return false;
  if (message && message.fromId != null && message.fromId !== '') return idsMatch(message.fromId, mem.promoted.id);
  const name = String((message && message.from) || '');
  if (!name || name !== String(mem.promoted.name || '')) return false;
  const same = (mem.names || []).filter((n) => String(n) === name).length;
  return same <= 1;
}

// Records speech from the promoted person. A done-phrase is not an answer: the guard thanks them itself.
export function noteLine(mem, message, policy) {
  const out = { answer: false };
  if (!shouldAnswer(mem, message)) return out;
  const at = message && Number.isFinite(message.at) ? message.at : Date.now();
  mem.promoted.lastSpoke = at;
  mem.promoted.spoke = true;
  const words = policy && policy.stage_done_words && policy.stage_done_words.length ? policy.stage_done_words : STAGE_DONE_WORDS;
  if (saysDone(message && message.text, words)) { mem.promoted.saidDone = true; return out; }
  out.answer = true;
  return out;
}

function doneWhy(promoted, view, now, policy) {
  const on = view.on_stage || [];
  const here = on.some((s) => idsMatch(s.id, promoted.id));
  // Stepping up lowers the hand (the page does that itself). A hand that is down
  // counts as "done" only before they arrive; after that it is the step-up, not a goodbye.
  if (here && !promoted.arrived) { promoted.arrived = true; promoted.arrivedAt = now; }
  const person = findPerson(view.people, promoted.id);
  const idle = (Number.isFinite(policy.stage_idle_s) ? policy.stage_idle_s : 45) * 1000;
  const first = (Number.isFinite(policy.stage_first_s) ? policy.stage_first_s : 120) * 1000;
  const max = (Number.isFinite(policy.stage_max_s) ? policy.stage_max_s : 240) * 1000;
  if (promoted.saidDone) return 'thanks';
  if (!person) return 'left';
  if (now - promoted.since >= max) return 'max';
  if (!promoted.arrived && person.hand === null) return 'hand';
  if (!promoted.arrived && now - promoted.since >= PROMOTE_ARRIVE_MS) return 'absent';
  if (promoted.arrived && !here) return 'down';
  // Before their first line the clock is stage_first_s from the step-up; after it, stage_idle_s from the last line.
  if (promoted.arrived && promoted.spoke === false && now - (promoted.arrivedAt != null ? promoted.arrivedAt : promoted.since) >= first) return 'idle';
  if (promoted.arrived && promoted.spoke !== false && now - (promoted.lastSpoke || promoted.since) >= idle) return 'idle';
  return '';
}

// view: stageView(). mem: the guard memory (stageEmptySince, stageFullNoted, promoted, onStage, served).
// Returns { actions: [{ op:'stage.set', on:true } | { op:'stage.grant', person_id, on }], note, log, thanks }.
export function planStage(view, mem, now, policy) {
  const out = { actions: [], note: '', log: null, thanks: null };
  if (!policy || policy.stage !== true || !view || !view.ok || !mem) return out;
  const on = view.on_stage || [];
  const people = view.people || [];
  const meOn = !!view.me_on;
  mem.onStage = meOn;
  const botThere = meOn || on.some((s) => s && s.bot === true);
  const free = on.length < view.seats;

  if (botThere) {
    mem.stageEmptySince = null;
    mem.stageFullNoted = false;
    out.note = meOn ? 'on stage' : 'a bot holds the stage';
  } else if (free) {
    mem.stageFullNoted = false;
    if (mem.stageEmptySince == null) mem.stageEmptySince = now;
    const waitMs = (Number.isFinite(policy.stage_takeover_s) ? policy.stage_takeover_s : defaultTakeoverS(policy.rank)) * 1000;
    if (now - mem.stageEmptySince >= waitMs) {
      out.actions.push({ op: 'stage.set', on: true });
      out.note = 'taking a free stage spot';
    } else out.note = 'waiting to take the stage';
  } else {
    // Every spot is a human. Say so once for this stretch, and try again when one frees.
    mem.stageEmptySince = null;
    out.note = 'stage full of humans';
    if (!mem.stageFullNoted) { mem.stageFullNoted = true; out.log = 'stage full of humans'; }
  }

  // Only the bot that is up promotes, and only once it can grant (it holds the room).
  if (!meOn || view.am_admin === false) return out;

  if (mem.promoted) {
    const why = doneWhy(mem.promoted, view, now, policy);
    if (why) {
      const finished = mem.promoted.id;
      const person = findPerson(people, finished);
      // They still count as a spot until their own page steps down. Calling the next
      // hand in that same read can fill the stage and drop the next person (the 20 s no-show).
      const stillUp = on.some((s) => idsMatch(s.id, finished));
      out.actions.push({ op: 'stage.grant', person_id: finished, on: false });
      out.thanks = thanksLine(mem.promoted.name);
      mem.served = { id: finished, hand: person && typeof person.hand === 'number' ? person.hand : null };
      mem.promoted = null;
      out.note = why;
      if (stillUp) return out;
    }
  }
  if (mem.promoted) return out;
  if (on.length >= view.seats) return out;
  const next = queueHands(people, { me: view.me, on, served: mem.served })[0];
  if (!next) return out;
  out.actions.push({ op: 'stage.grant', person_id: next.id, on: true });
  mem.promoted = { id: next.id, name: next.name, since: now, lastSpoke: now, spoke: false, arrived: false, saidDone: false };
  if (!out.note) out.note = 'promoting';
  return out;
}
