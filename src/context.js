// The shared bot: everything both GifOS MCP servers do with Meet Bot and the
// stores (meetings, schedule, transcript lines, events), without any MCP
// tool definitions. Tools in tools/shared.js and in each server call these.
// Everything that touches a browser goes through `bot` (the MeetingBotDriver
// in driver.js, the WorkerPool in pool.js, or a fake in the unit tests).
import path from 'node:path';
import { publicView, roomFromLink } from './meetings.js';
import { plainLink } from './invite.js';
import { LiveTranscript } from './voice/live.js';
import { VOICE_GAP, scrub } from './voice/settings.js';
import { ScheduleStore, publicOrder, localStamp, DEFAULT_SPAN_MS } from './schedule.js';
import { EventLog } from './events.js';
import { createClock } from './clock.js';
import { log } from './log.js';

// Meet Bot's answer for a room it no longer holds (ended from its own page
// or the admin meeting): the bot is already out.
export const GONE_RE = /No such meeting/;

export function createContext({ cfg, meetings, bot, live, captions, botName, botPassword, schedule: scheduleIn, events: eventsIn }) {
  const transcript = live || new LiveTranscript(cfg.home);
  const schedule = scheduleIn || new ScheduleStore(cfg.home);
  const events = eventsIn || new EventLog(cfg.home);
  const secret = [botPassword || ''];
  // Meet Bot never thinks for itself here: the assistant that calls these
  // tools is the brain. Each join hands Meet Bot both switches off, so it
  // answers nothing on its own; it speaks only the lines `say` gives it.
  const VOICE = { respond_to_command: false, speak: false };
  let handed = null;
  async function applyVoice() {
    if (typeof bot.setVoice !== 'function') {
      handed = { applied: false, gap: VOICE_GAP };
      return handed;
    }
    try {
      handed = await bot.setVoice({ ...VOICE });
      const took = handed && handed.result;
      if (handed && handed.applied && took && typeof took.speak === 'boolean' && took.speak !== VOICE.speak) {
        handed = { applied: false, gap: 'Meeting Bot did not turn speak off.' };
      }
    } catch (e) {
      handed = { applied: false, gap: scrub('Meeting Bot refused the voice switches: ' + String((e && e.message) || e), secret) };
    }
    return handed;
  }

  // The names the bot sits under, and the one in this meeting's room (stage
  // B: worker n is <name>-wn).
  const ourNames = () => (typeof bot.botNames === 'function' ? bot.botNames() : [botName]);
  const nameIn = (m) => (typeof bot.botNameFor === 'function' ? bot.botNameFor(m.session_id) : botName) || 'Meet Bot';

  function secrets() {
    return secret.concat(schedule.all().map((o) => o.room_password).filter(Boolean));
  }
  function ok(obj) {
    const raw = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    return { content: [{ type: 'text', text: scrub(raw, secrets()) }] };
  }
  function fail(message) {
    return { isError: true, content: [{ type: 'text', text: scrub(message, secrets()) }] };
  }
  function emit(event) {
    const data = JSON.parse(scrub(JSON.stringify((event && event.data) || {}), secrets()));
    return events.append({ type: event.type, meeting_id: event.meeting_id, data });
  }

  // Wraps a handler: known meeting, readable errors.
  const guarded = (fn) => async (args) => {
    try { return await fn(args); } catch (e) { return fail(String((e && e.message) || e)); }
  };
  const need = (id) => {
    const m = meetings.get(id);
    if (!m) throw new Error('Unknown meeting_id ' + JSON.stringify(id) + '. Use list_meetings to see known meetings.');
    return m;
  };
  const needLive = (id) => {
    const m = need(id);
    if (m.state !== 'live' || !m.session_id) throw new Error('Meeting ' + id + ' is ' + m.state + '. Call start_meeting first.');
    return m;
  };

  // One join per meeting at a time. A clock tick, a second tick and a
  // start_meeting for the same room share it instead of seating it twice.
  const entering = new Map();
  function enter(m, password) {
    const busy = entering.get(m.meeting_id);
    if (busy) return busy.promise;
    const job = { cancelled: false };
    job.promise = enterOnce(m, password, job).finally(() => entering.delete(m.meeting_id));
    entering.set(m.meeting_id, job);
    return job.promise;
  }

  // Once a join lands the bot holds a seat, and once a leave lands it does
  // not. A meetings.json save that fails then (disk nearly full: it holds
  // every transcript) must not lose that: the store already took the fields
  // in memory and its next save writes them. The same holds after a mute,
  // unmute or transcript read has landed.
  function holdSeat(id, fields) {
    try { return meetings.update(id, fields); }
    catch (e) {
      log('meetings.json not saved (' + e.message + '); the seat is kept in memory until the next save.');
      return meetings.get(id);
    }
  }

  // The same for an order's phase once the bot has joined or left: the
  // schedule store already took it in memory, so the clock sees it and the
  // next save writes it. Throwing here would hide a leave that happened.
  function holdPhase(order, fields) {
    try { return schedule.setPhase(order.occurrence_id || order.schedule_id, fields); }
    catch (e) {
      log('schedule.json not saved (' + e.message + '); the order is kept in memory until the next save.');
      return schedule.get(order.occurrence_id || order.schedule_id);
    }
  }

  async function enterOnce(m, password, job) {
    await bot.ensureStarted();
    const roomPassword = password || schedule.passwordFor(m.room) || '';
    const sessionId = await bot.join(plainLink(m.link, roomPassword), roomPassword);
    if (job.cancelled) {
      // Ended while the join was on its way. Leave the seat it just took.
      const stuck = await bot.leave(sessionId).then(() => null, (le) => (GONE_RE.test((le && le.message) || '') ? null : le));
      if (!stuck) return meetings.get(m.meeting_id);
      // It could not leave: the meeting holds the seat again, captions off,
      // so another end_meeting can reach it. Its order stays left_early.
      const kept = holdSeat(m.meeting_id, {
        state: 'live', session_id: sessionId, transcribing: false, muted: false, reseat: false, ended_at: null,
      });
      emit({ type: 'meeting.error', meeting_id: m.meeting_id, data: { text: 'The bot could not leave the room; call end_meeting again.' } });
      return kept;
    }
    try { await bot.transcribe(sessionId, true); }
    catch (e) {
      // The bot sits in the room, but no meeting holds its seat yet. Leave,
      // so the next try (the clock's next tick) does not seat it twice.
      const stuck = await bot.leave(sessionId).then(() => null, (le) => (GONE_RE.test((le && le.message) || '') ? null : le));
      if (!stuck) throw e;
      // It could not leave: keep the meeting live with captions off, so
      // unmute and end_meeting can still reach that seat.
      const kept = holdSeat(m.meeting_id, {
        state: 'live', session_id: sessionId, transcribing: false, muted: false, reseat: false,
        started_at: new Date().toISOString(), ended_at: null, transcript: null,
      });
      emit({ type: 'meeting.error', meeting_id: m.meeting_id, data: { text: 'Transcription could not be started; unmute to try again.' } });
      return kept;
    }
    const updated = holdSeat(m.meeting_id, {
      state: 'live', session_id: sessionId, transcribing: true, muted: false, reseat: false,
      started_at: new Date().toISOString(), ended_at: null, transcript: null,
    });
    // Each join hands Meet Bot its switches again, so a restarted app is
    // still quiet on its own and speaks only what `say` hands it.
    await applyVoice();
    if (captions) await captions.start(updated);
    return updated;
  }

  // A join by hand waits out the clock's wait on a room that crashed the
  // bot, and a crash it finds starts that wait, so asking again at once does
  // not take down the workers (and every meeting on them) a second time.
  async function enterByHand(m, password) {
    const left = clock.crashLeft(m.room, Date.now());
    if (left) throw new Error('The room crashed the bot; it can be tried again in ' + Math.ceil(left / 60000) + ' min.');
    try {
      const joined = await enter(m, password);
      if (joined && joined.state === 'live') clock.crashCleared(m.room);
      return joined;
    } catch (e) {
      if (!(e && e.code === 'worker_died')) throw e;
      const ms = clock.crashFound(m.room, Date.now());
      throw new Error('The room crashed the bot; it can be tried again in ' + Math.ceil(ms / 60000) + ' min.');
    }
  }

  function rememberJoin(meeting, password, topic) {
    const existing = schedule.all().find((o) => o.room === meeting.room && o.phase !== 'cancelled' && o.phase !== 'ended' && o.phase !== 'missed' && o.phase !== 'left_early' && o.phase !== 'series');
    if (existing) {
      holdPhase(existing, { room_password: password, meeting_id: meeting.meeting_id, phase: 'live', topic: topic || existing.topic || meeting.topic });
      return;
    }
    // The bot already sits in the room: a failed schedule.json save must not
    // turn the join into an error. add() took the order in memory first.
    const start = new Date();
    let added;
    try {
      added = schedule.add({
        link: meeting.link,
        room: meeting.room,
        room_password: password,
        topic: topic || meeting.topic,
        meeting_id: meeting.meeting_id,
        start: start.toISOString(),
        end: new Date(start.getTime() + DEFAULT_SPAN_MS).toISOString(),
      });
    } catch (e) {
      const kept = schedule.all().find((o) => o.meeting_id === meeting.meeting_id && o.room === meeting.room && o.phase !== 'cancelled');
      if (!kept) throw e;
      log('schedule.json not saved (' + e.message + '); the order is kept in memory until the next save.');
      added = { order: kept };
    }
    holdPhase(added.order, { phase: 'live', meeting_id: meeting.meeting_id });
  }

  function counts(meetingId) {
    const rows = transcript.lines.filter((l) => l.meeting_id === meetingId);
    return {
      speech: rows.filter((l) => l.kind === 'speech').length,
      chat: rows.filter((l) => l.kind === 'chat').length,
      spoken: rows.filter((l) => l.kind === 'spoken').length,
    };
  }

  function thinkingOf(m) {
    if (m.thinking) return true;
    if (bot.queue && typeof bot.queue.isThinking === 'function') return bot.queue.isThinking(m.meeting_id) || bot.queue.isThinking(m.session_id);
    return false;
  }

  function lastHumanAt(meetingId) {
    const rows = transcript.lines.filter((l) => l.meeting_id === meetingId && (l.kind === 'speech' || l.kind === 'chat'));
    if (!rows.length) return null;
    return Date.parse(rows[rows.length - 1].ts);
  }

  async function depart(m, reason) {
    if (captions) captions.stop(m.meeting_id);
    let text = scrub(m.transcript || '', secrets());
    try { text = scrub(await bot.transcript(m.session_id), secrets()); } catch (e) { /* keep the last copy */ }
    transcript.ingestCaption(m.meeting_id, text, ourNames());
    // Any other failure keeps the meeting live, so a retry can still reach it.
    await bot.leave(m.session_id).catch((e) => { if (!GONE_RE.test((e && e.message) || '')) throw e; });
    if (bot.queue && typeof bot.queue.leave === 'function') bot.queue.leave(m.meeting_id);
    const done = holdSeat(m.meeting_id, { state: 'ended', session_id: null, transcribing: false, thinking: false,
      transcript: text, ended_at: new Date().toISOString() });
    const order = schedule.forMeeting(m.meeting_id);
    const why = reason || 'manual';
    if (order) {
      const phase = (why === 'manual' || why === 'cancel') && Date.now() < Date.parse(order.end) ? 'left_early' : 'ended';
      holdPhase(order, { phase });
    }
    emit({ type: 'meeting.left', meeting_id: m.meeting_id, data: { state: 'ended', reason: why } });
    return { done, lines: text ? text.split('\n').length : 0 };
  }

  // end_meeting or leave_meeting on a room the bot is on its way into: a
  // join in flight, or a dropped room the clock would bring back. Do not.
  function stopJoin(m) {
    const pending = entering.get(m.meeting_id);
    if (m.state === 'live' || !(pending || (m.reseat && m.state === 'scheduled'))) return null;
    if (pending) pending.cancelled = true;
    const done = holdSeat(m.meeting_id, { state: 'ended', reseat: false, ended_at: new Date().toISOString() });
    const order = schedule.forMeeting(m.meeting_id);
    if (order) holdPhase(order, { phase: Date.now() < Date.parse(order.end) ? 'left_early' : 'ended' });
    emit({ type: 'meeting.left', meeting_id: m.meeting_id, data: { state: 'ended', reason: 'manual' } });
    return ok({ ...publicView(done), note: pending ? 'The bot was joining; it left again.' : 'The bot was waiting to rejoin; it will not.' });
  }

  // Hand, microphone, camera, and room state are a GifOS meeting-control
  // capability. The gifos-apps-source agent builds it on Meeting Bot.
  // These tools only forward window.MeetingBot and report a gap until then.
  async function control(name, gap, fn) {
    if (typeof bot[name] !== 'function') throw new Error(gap);
    const out = await fn();
    if (!out || out.applied === false) throw new Error((out && out.gap) || gap);
    return out;
  }

  const clock = createClock({
    schedule,
    crashFile: cfg.home ? path.join(cfg.home, 'crashes.json') : '',
    meetings,
    cap: cfg.maxMeetings,
    near: cfg.capacityNear,
    horizonMs: cfg.horizonMs,
    emit,
    join: async (order) => {
      let m = order.meeting_id && meetings.get(order.meeting_id);
      if (!m) m = meetings.byRoom(order.room);
      if (!m) m = meetings.add({ topic: order.topic || '', room: order.room, link: order.link });
      if (m.state === 'live') return m;
      return enter(m, order.room_password);
    },
    reseat: (m) => enter(m),
    // Stage B: a lost worker's rooms are not seats until it restarts.
    canSeat: () => (typeof bot.hasSeat === 'function' ? bot.hasSeat() : true),
    leave: (order, reason) => {
      const m = order.meeting_id && meetings.get(order.meeting_id);
      if (!m || m.state !== 'live') {
        holdPhase(order, { phase: 'ended' });
        return null;
      }
      return depart(m, reason);
    },
    people: async (meeting) => (typeof bot.people === 'function' ? bot.people(meeting.session_id) : null),
    lastHumanAt,
  });
  function orderView(order, zone) {
    const row = publicOrder(order);
    if (zone) {
      row.local_start = localStamp(order.start, zone);
      row.local_end = localStamp(order.end, zone);
    }
    return row;
  }

  function ensureMeeting(order) {
    let m = order.meeting_id && meetings.get(order.meeting_id);
    if (!m) m = meetings.byRoom(order.room);
    if (!m) m = meetings.add({ topic: order.topic || '', room: order.room, link: order.link });
    if (order.meeting_id !== m.meeting_id) schedule.setPhase(order.occurrence_id || order.schedule_id, { meeting_id: m.meeting_id });
    return meetings.get(m.meeting_id);
  }


  // The bot joins a room by its link now (join_meeting, join_broadcast).
  // A password, when given, is the room password guests type; it is kept on
  // the schedule for rejoins and never returned.
  async function joinByLink(link, password, topic) {
    const room = roomFromLink(link);
    if (!room) throw new Error('That is not a GifOS link (expected …/run.html#v=<room> or …/meet/<room>).');
    const clean = plainLink(link, password || '');
    let m = meetings.byRoom(room);
    if (m && m.state === 'live') return { meeting: m, note: 'Already in this room.' };
    const liveCount = meetings.all().filter((row) => row.state === 'live').length;
    if (liveCount >= cfg.maxMeetings) {
      emit({
        type: 'capacity.reached',
        data: {
          when: 'live', at: new Date().toISOString(), cap: cfg.maxMeetings, near: cfg.capacityNear, seated: liveCount,
          affected: meetings.all().filter((row) => row.state === 'live').map((row) => ({ meeting_id: row.meeting_id, topic: row.topic, phase: 'live' })),
          waiting: [{ topic: topic || '', link: clean, phase: 'refused' }],
        },
      });
      throw new Error('The meeting bot is at capacity.');
    }
    if (!m) m = meetings.add({ topic: topic || '', room, link: clean });
    else if (m.link !== clean) meetings.update(m.meeting_id, { link: clean, topic: topic || m.topic });
    const joined = await enterByHand(meetings.get(m.meeting_id), password);
    if (password) rememberJoin(joined, password, topic);
    emit({ type: 'meeting.joined', meeting_id: joined.meeting_id, data: { topic: joined.topic, link: joined.link, state: 'live' } });
    return { meeting: joined };
  }

  return {
    cfg, meetings, bot, captions, transcript, schedule, events, clock, botName,
    secret, secrets, ok, fail, emit, guarded, need, needLive,
    enter, enterByHand, joinByLink, rememberJoin, depart, stopJoin, holdSeat, holdPhase,
    counts, thinkingOf, lastHumanAt, ourNames, nameIn, control, orderView, ensureMeeting,
    applyVoice, voiceState: () => ({ ...VOICE, handed: !!(handed && handed.applied), gap: handed && !handed.applied ? handed.gap : null }),
  };
}
