// The MCP tools. Everything that touches a browser goes through `bot` (the
// MeetingBotDriver in driver.js, or a fake in the unit tests).
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { z } from 'zod';
import { newRoom, linkFor, roomFromLink, publicView } from './meetings.js';
import { plainLink } from './invite.js';
import { LiveTranscript } from './voice/live.js';
import { CAMERA_GAP, CONTROLS_GAP, HAND_GAP, INTERJECT_GAP, MIC_GAP, SNAPSHOT_GAP, VOICE_GAP, meetBotVoice, scrub, voicePublic } from './voice/settings.js';
import { ScheduleStore, publicOrder, capacityAt, localStamp, DEFAULT_SPAN_MS } from './schedule.js';
import { EventLog } from './events.js';
import { createClock } from './clock.js';
import { log } from './log.js';

export const VERSION = '0.4.1';

// Meet Bot's answer for a room it no longer holds (ended from its own page
// or the admin meeting): the bot is already out.
const GONE_RE = /No such meeting/;
const meetingId = z.string().min(3).max(40).describe('The meeting_id returned by create_meeting or join_meeting.');

export function createServer({ cfg, meetings, bot, live, captions, botName, botPassword, schedule: scheduleIn, events: eventsIn }) {
  const server = new McpServer({ name: 'gifos-mcp', version: VERSION });
  const transcript = live || new LiveTranscript(cfg.home);
  const schedule = scheduleIn || new ScheduleStore(cfg.home);
  const events = eventsIn || new EventLog(cfg.home);
  const secret = [(cfg.voice && cfg.voice.key) || '', botPassword || ''];
  const choice = {
    respondToCommand: cfg.voice.respondToCommand,
    conversationVoice: cfg.voice.conversationVoice,
  };
  let handed = null;
  const currentVoice = () => ({ ...cfg.voice, respondToCommand: choice.respondToCommand, conversationVoice: choice.conversationVoice });
  async function applyVoice() {
    const settings = meetBotVoice(currentVoice());
    if (typeof bot.setVoice !== 'function') {
      handed = { applied: false, gap: VOICE_GAP };
      return handed;
    }
    try {
      handed = await bot.setVoice(settings);
      // Version 2 resolves with the switches it now holds. Report what it took.
      const took = handed && handed.result;
      if (handed && handed.applied && took && typeof took.speak === 'boolean' && took.speak !== settings.speak) {
        handed = { applied: false, gap: 'Meeting Bot did not turn speak ' + (settings.speak ? 'on' : 'off') + '.' };
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
    // Meet Bot starts quiet. Its words come from the host-injected Smartest
    // and Text to speech roles, but it answers only after setVoice turns
    // speak (and respond_to_command) on. Each join hands them again, so a
    // restarted app does not stay quiet.
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

  server.registerTool('create_meeting', {
    title: 'Create a GifOS meeting',
    description: 'Mints a GifOS room and returns its link. name is the room name. admin_password is the human\'s password from Grok Bot\'s secrets store, used for this call only. It is not stored, not logged, and not returned. Nothing joins yet. Grok Bot invents the room password, invites people with the link and that room password, then calls schedule_meeting.',
    inputSchema: {
      name: z.string().min(1).max(200).describe('Room name, the topic of the meeting.'),
      admin_password: z.string().min(1).max(200).describe('The human\'s admin password for this room. Passed for this call only. Never stored.'),
    },
  }, async ({ name, admin_password }) => {
    try {
      const room = newRoom();
      const link = plainLink(linkFor(cfg.gifosUrl, room, cfg.relay), '');
      meetings.add({ topic: name, room, link });
      const body = JSON.stringify({ link }, null, 2);
      return { content: [{ type: 'text', text: scrub(body, secrets().concat(admin_password || '')) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: scrub(String((e && e.message) || e), secrets().concat(admin_password || '')) }] };
    }
  });

  server.registerTool('start_meeting', {
    title: 'Start a meeting (the bot joins and transcribes)',
    description: 'The headless Meeting Bot joins the meeting created with create_meeting and starts transcribing. Participants see a 🤖 bot badge and a transcribing chip.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = need(meeting_id);
    if (m.state === 'live') return ok({ ...publicView(m), note: 'Already live.' });
    return ok(publicView(await enterByHand(m)));
  }));

  server.registerTool('join_meeting', {
    title: 'Join an existing GifOS meeting by link',
    description: 'The Meeting Bot joins a GifOS meeting now and starts transcribing. A scheduled join is schedule_meeting, not this tool. The room password is stored on the schedule when one is passed.',
    inputSchema: {
      link: z.string().url().max(2048).describe('The GifOS meeting link.'),
      password: z.string().max(200).optional().describe('The room password guests type, if the meeting has one.'),
      topic: z.string().max(200).optional(),
    },
  }, guarded(async ({ link, password, topic }) => {
    const room = roomFromLink(link);
    if (!room) return fail('That is not a GifOS meeting link (expected …/run.html#v=<room> or …/meet/<room>).');
    const clean = plainLink(link, password || '');
    let m = meetings.byRoom(room);
    if (m && m.state === 'live') return ok({ ...publicView(m), note: 'Already in this meeting.' });
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
      return fail('The meeting bot is at capacity.');
    }
    if (!m) m = meetings.add({ topic: topic || '', room, link: clean });
    else if (m.link !== clean) meetings.update(m.meeting_id, { link: clean, topic: topic || m.topic });
    const joined = await enterByHand(meetings.get(m.meeting_id), password);
    if (password) rememberJoin(joined, password, topic);
    emit({ type: 'meeting.joined', meeting_id: joined.meeting_id, data: { topic: joined.topic, link: joined.link, state: 'live' } });
    return ok(publicView(joined));
  }));

  server.registerTool('mute', {
    title: 'Mute the bot (stop listening)',
    description: 'Stops the bot transcribing this meeting; the transcribing chip goes away. The bot never sends audio, so this is the only kind of mute it has.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = needLive(meeting_id);
    await bot.transcribe(m.session_id, false);
    return ok(publicView(holdSeat(m.meeting_id, { transcribing: false, muted: true })));
  }));

  server.registerTool('unmute', {
    title: 'Unmute the bot (listen again)',
    description: 'Turns transcription back on for this meeting.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = needLive(meeting_id);
    await bot.transcribe(m.session_id, true);
    return ok(publicView(holdSeat(m.meeting_id, { transcribing: true, muted: false })));
  }));

  server.registerTool('share_content', {
    title: 'Share text or a link into the meeting',
    description: 'Posts text (an agenda, a link, a summary) into the meeting chat as the bot. Screen sharing is not available: the bot has no screen or camera.',
    inputSchema: {
      meeting_id: meetingId,
      text: z.string().min(1).max(2000).describe('What to post into the meeting chat (up to 2000 characters).'),
    },
  }, guarded(async ({ meeting_id, text }) => {
    const m = needLive(meeting_id);
    await bot.say(m.session_id, text);
    return ok({ meeting_id: m.meeting_id, shared: true, chars: text.length });
  }));

  server.registerTool('get_transcript', {
    title: 'Get the meeting transcript',
    description: 'Returns the transcript as plain text, one "speaker: words" line per caption. Works while the meeting is live and after end_meeting.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = need(meeting_id);
    if (m.state === 'live' && m.session_id) {
      const text = scrub(await bot.transcript(m.session_id), secret);
      holdSeat(m.meeting_id, { transcript: text });
      transcript.ingestCaption(m.meeting_id, text, ourNames());
      return ok(text || '(no transcript lines yet)');
    }
    if (m.transcript != null) return ok(m.transcript || '(the transcript is empty)');
    return fail('Meeting ' + meeting_id + ' has not started, so there is no transcript.');
  }));

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

  server.registerTool('end_meeting', {
    title: 'End the meeting for the bot',
    description: 'Saves the transcript, then the bot leaves. Other participants can stay; GifOS meetings have no owner who can close them for everyone.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = need(meeting_id);
    const stopped = stopJoin(m);
    if (stopped) return stopped;
    if (m.state !== 'live' || !m.session_id) return ok({ ...publicView(m), note: 'The bot was not in this meeting.' });
    const left = await depart(m);
    return ok({ ...publicView(left.done), transcript_lines: left.lines });
  }));

  server.registerTool('list_meetings', {
    title: 'List meetings',
    description: 'Meetings this server created or joined, newest first, with their state (scheduled, live, ended).',
    inputSchema: {},
  }, guarded(async () => {
    return ok({ meetings: meetings.all().reverse().map(publicView) });
  }));

  server.registerTool('status', {
    title: 'Connector status',
    description: 'Is the headless GifOS browser up, which GifOS it uses, and which meetings the bot is in right now.',
    inputSchema: {},
  }, guarded(async () => {
    const info = await bot.info();
    return ok({
      version: VERSION,
      gifos_url: cfg.gifosUrl,
      stt_app: cfg.sttApp || null,
      live_meetings: meetings.all().filter((m) => m.state === 'live').map((m) => m.meeting_id),
      voice: voicePublic(currentVoice(), handed),
      bot: info,
    });
  }));

  server.registerTool('set_voice', {
    title: 'Hand Meet Bot its voice switches',
    description: 'Turns Meet Bot\'s spoken answers on or off in every meeting it is in. respond_to_command lets it answer "Hey bot" commands it hears. conversation_voice none keeps it quiet; grok or local turns speech on (local uses the configured model, then Kokoro). Meet Bot gets only { respond_to_command, speak }; the model key is never an argument and is never returned.',
    inputSchema: {
      respond_to_command: z.boolean().optional().describe('When true, Meet Bot may answer commands it hears. When false, it does not.'),
      conversation_voice: z.enum(['none', 'grok', 'local']).optional().describe('none, grok (Grok Voice), or local (the configured LLM, then Kokoro).'),
    },
  }, guarded(async ({ respond_to_command, conversation_voice }) => {
    if (conversation_voice === 'local' && !cfg.voice.llmApp && (!cfg.voice.url || !cfg.voice.model)) {
      throw new Error('conversation_voice local needs GIFOS_LLM_URL and GIFOS_LLM_MODEL, or GIFOS_LLM_APP. A GIFOS_LLM_KEY alone selects the suggested xAI endpoint.');
    }
    if (respond_to_command !== undefined) choice.respondToCommand = !!respond_to_command;
    if (conversation_voice) choice.conversationVoice = conversation_voice;
    return ok(voicePublic(currentVoice(), await applyVoice()));
  }));

  server.registerTool('tail_transcript', {
    title: 'Tail the live transcript',
    description: 'New lines since `since` (the seq from the previous tail, or 0). Each line is {seq, ts, speaker, text, kind}. kind is speech for someone in the room, and spoken for a line this bot said. Lines come from Meet Bot. Works while the meeting is live and after it ends. The same bytes are the gifos://meeting/{id}/transcript resource.',
    inputSchema: {
      meeting_id: meetingId,
      since: z.number().int().min(0).optional().describe('Return lines with a seq greater than this. Omit or pass 0 to read from the start.'),
    },
  }, guarded(async ({ meeting_id, since }) => {
    need(meeting_id);
    return ok(transcript.tail(meeting_id, since || 0));
  }));

  server.registerTool('say', {
    title: 'Speak in the meeting',
    description: 'Passes a spoken line through to Meet Bot (MeetingBot.interject), ahead of conversation voice. Meet Bot asks the tts provider. When this process hosts that role, it returns the audio and does not play it into the meeting. share_content remains chat.',
    inputSchema: {
      meeting_id: meetingId,
      text: z.string().min(1).max(2000).describe('What Meet Bot should say, in one or two sentences.'),
    },
  }, guarded(async ({ meeting_id, text }) => {
    const m = needLive(meeting_id);
    if (typeof bot.interject !== 'function') throw new Error(INTERJECT_GAP);
    const said = await bot.interject(m.session_id, text);
    if (!said || said.applied === false) throw new Error((said && said.gap) || INTERJECT_GAP);
    const speaker = nameIn(m);
    const body = String(text).trim();
    const have = transcript.lines.some((l) => l.meeting_id === m.meeting_id && l.kind === 'spoken' && l.speaker === speaker && l.text === body);
    if (body && !have) transcript.append({ meeting_id: m.meeting_id, speaker, text: body, kind: 'spoken' });
    return ok({ meeting_id: m.meeting_id, spoken: true });
  }));

  // Hand, microphone, camera, and room state are a GifOS meeting-control
  // capability. The gifos-apps-source agent builds it on Meeting Bot.
  // These tools only forward window.MeetingBot and report a gap until then.
  async function control(name, gap, fn) {
    if (typeof bot[name] !== 'function') throw new Error(gap);
    const out = await fn();
    if (!out || out.applied === false) throw new Error((out && out.gap) || gap);
    return out;
  }

  server.registerTool('send_chat', {
    title: 'Send a chat message',
    description: 'Posts a chat line through Meet Bot (MeetingBot.say). This is the same chat channel as share_content. It does not speak.',
    inputSchema: {
      meeting_id: meetingId,
      text: z.string().min(1).max(2000).describe('The chat message, up to 2000 characters.'),
    },
  }, guarded(async ({ meeting_id, text }) => {
    const m = needLive(meeting_id);
    await bot.say(m.session_id, text);
    transcript.append({ meeting_id: m.meeting_id, speaker: nameIn(m), text, kind: 'chat' });
    return ok({ meeting_id: m.meeting_id, sent: true, chars: text.length });
  }));

  server.registerTool('raise_hand', {
    title: 'Raise or lower the bot hand',
    description: 'Asks Meet Bot to raise its hand when on is true, and to lower it when on is false. Contract version 1 has no hand control, and then this reports the gap.',
    inputSchema: {
      meeting_id: meetingId,
      on: z.boolean().describe('true to raise, false to lower.'),
    },
  }, guarded(async ({ meeting_id, on }) => {
    const m = needLive(meeting_id);
    const raised = await control('raiseHand', HAND_GAP, () => bot.raiseHand(m.session_id, on));
    return ok({ meeting_id: m.meeting_id, hand: !!on, result: raised.result == null ? null : raised.result });
  }));

  server.registerTool('set_mic', {
    title: 'Turn the Meet Bot microphone on or off',
    description: 'Asks Meet Bot to unmute its microphone when on is true. Contract version 1 gives the bot no microphone, and then this reports the gap.',
    inputSchema: {
      meeting_id: meetingId,
      on: z.boolean().describe('true to unmute, false to mute.'),
    },
  }, guarded(async ({ meeting_id, on }) => {
    const m = needLive(meeting_id);
    const mic = await control('setMic', MIC_GAP, () => bot.setMic(m.session_id, on));
    return ok({ meeting_id: m.meeting_id, mic: !!on, result: mic.result == null ? null : mic.result });
  }));

  server.registerTool('set_camera', {
    title: 'Turn the Meet Bot camera on or off',
    description: 'Asks Meet Bot to show its camera when on is true, and to turn it off when on is false. Contract version 1 has no camera, and then this reports the gap.',
    inputSchema: {
      meeting_id: meetingId,
      on: z.boolean().describe('true to show the camera, false to turn it off.'),
    },
  }, guarded(async ({ meeting_id, on }) => {
    const m = needLive(meeting_id);
    const cam = await control('setCamera', CAMERA_GAP, () => bot.setCamera(m.session_id, on));
    return ok({ meeting_id: m.meeting_id, camera: !!on, result: cam.result == null ? null : cam.result });
  }));

  server.registerTool('get_meeting_state', {
    title: 'Who is in the meeting',
    description: 'Participants from Meet Bot, plus hand, microphone, and camera when the app reports them. Contract version 1 returns the people list only.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = needLive(meeting_id);
    const people = typeof bot.people === 'function' ? await bot.people(m.session_id) : null;
    let hand = null;
    let mic = null;
    let camera = null;
    let controls_gap = CONTROLS_GAP;
    if (typeof bot.meetingState === 'function') {
      const extra = await bot.meetingState(m.session_id);
      if (extra && extra.applied && extra.result) {
        const row = extra.result;
        controls_gap = null;
        if ('hand' in row) hand = !!row.hand;
        if ('mic' in row) mic = !!row.mic;
        if ('camera' in row) camera = !!row.camera;
      } else {
        controls_gap = (extra && extra.gap) || CONTROLS_GAP;
      }
    }
    return ok({
      meeting_id: m.meeting_id,
      transcribing: !!m.transcribing,
      muted: !!m.muted,
      people,
      hand,
      mic,
      camera,
      controls_gap,
    });
  }));

  server.registerTool('snapshot', {
    title: 'Snapshot of the Meet Bot page',
    description: 'Read-only. Returns who is in the meeting and, when the browser is up, a PNG of the Meet Bot page this server already runs. It does not join a second browser and it does not change the meeting.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = needLive(meeting_id);
    const people = typeof bot.people === 'function' ? await bot.people(m.session_id) : null;
    let png = null;
    let gap = SNAPSHOT_GAP;
    let shot = null;
    if (typeof bot.snapshot === 'function') {
      const taken = await bot.snapshot(m.session_id);
      png = (taken && taken.png) || null;
      gap = taken && taken.applied ? null : ((taken && taken.gap) || SNAPSHOT_GAP);
      shot = taken && taken.applied ? (taken.result == null ? null : taken.result) : null;
    }
    return ok({ meeting_id: m.meeting_id, people, png, snapshot: shot, gap });
  }));

  server.registerTool('leave_meeting', {
    title: 'Leave the meeting',
    description: 'Saves the transcript, then Meet Bot leaves. Call this when someone asks the bot to leave. Other participants can stay.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = need(meeting_id);
    const stopped = stopJoin(m);
    if (stopped) return stopped;
    if (m.state !== 'live' || !m.session_id) return ok({ ...publicView(m), note: 'The bot was not in this meeting.' });
    const left = await depart(m, 'manual');
    return ok({ ...publicView(left.done), transcript_lines: left.lines });
  }));

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
  server.clock = clock;

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

  server.registerTool('schedule_meeting', {
    title: 'Schedule the bot to join a meeting',
    description: 'Stores a join order for a link that already exists. room_password is the password Grok Bot put in the invite. The bot joins one minute before start unless early_margin says otherwise. end may be omitted; the stored end is then start plus 8 hours. This call does not join yet and does not send mail. The room password is kept on the schedule and is not returned.',
    inputSchema: {
      link: z.string().url().max(2048).describe('The plain GifOS meeting link from create_meeting.'),
      room_password: z.string().min(1).max(200).describe('The room password guests type. Stored for rejoin. Not returned.'),
      start: z.string().min(1).max(64).describe('When the bot should be in the room, as an ISO time.'),
      end: z.string().max(64).optional().describe('When overrun starts. Omit for start plus 8 hours.'),
      timezone: z.string().max(80).optional().describe('IANA time zone. Default UTC.'),
      recurrence: z.string().max(500).optional().describe('The calendar recurrence rule, stored as sent. An RRULE this process understands is expanded. Anything else is refused.'),
      early_margin: z.number().int().min(0).optional().describe('Milliseconds before start to join. Default 60000.'),
      external_id: z.string().max(200).optional().describe('Caller id from a calendar import. A second write with the same id updates the order.'),
      topic: z.string().max(200).optional().describe('Room name. Defaults to the name from create_meeting.'),
    },
  }, guarded(async (args) => {
    const room = roomFromLink(args.link);
    if (!room) throw new Error('That is not a GifOS meeting link.');
    const known = meetings.byRoom(room);
    const added = schedule.add({
      ...args,
      topic: args.topic || (known && known.topic) || '',
      meeting_id: known ? known.meeting_id : '',
    });
    const order = added.order;
    const meeting = ensureMeeting(order);
    if (!order.meeting_id) schedule.setPhase(order.occurrence_id || order.schedule_id, { meeting_id: meeting.meeting_id });
    const stored = schedule.get(order.occurrence_id || order.schedule_id) || order;
    const capacity = capacityAt(schedule.all(), Date.parse(stored.start), cfg.maxMeetings);
    emit({ type: added.updated ? 'schedule.updated' : 'schedule.created', data: { ...publicOrder(stored), capacity: { cap: capacity.cap, seated_at_start: capacity.seated_at_start, over_by: capacity.over_by } } });
    await clock.emitCapacity(Date.now(), false);
    const next = stored.phase === 'series'
      ? schedule.all().find((o) => o.series_id === stored.schedule_id && o.phase === 'upcoming')
      : null;
    return ok({
      ...orderView(stored),
      meeting_id: meeting.meeting_id,
      duplicate: !!added.duplicate,
      next: next ? orderView(next) : null,
      capacity: { cap: capacity.cap, seated_at_start: capacity.seated_at_start, over_by: capacity.over_by },
    });
  }));

  server.registerTool('list_schedule', {
    title: 'List scheduled meetings',
    description: 'Orders in the window, soonest first. Recurrence is expanded inside the window. Rows do not include the room password or the admin password. conflicts lists instants where more orders overlap than the cap.',
    inputSchema: {
      from: z.string().max(64).optional().describe('ISO start of the window.'),
      to: z.string().max(64).optional().describe('ISO end of the window.'),
      timezone: z.string().max(80).optional().describe('IANA zone used to add local_start and local_end.'),
      phase: z.string().max(40).optional().describe('Only rows in this phase.'),
      flag_overlaps: z.boolean().optional().describe('When true, also list overlaps that are still under the cap.'),
    },
  }, guarded(async ({ from, to, timezone, phase, flag_overlaps }) => {
    const fromMs = from ? Date.parse(from) : null;
    const toMs = to ? Date.parse(to) : null;
    if (from && !Number.isFinite(fromMs)) throw new Error('from must be a time.');
    if (to && !Number.isFinite(toMs)) throw new Error('to must be a time.');
    let rows = schedule.all().filter((o) => o.phase !== 'series');
    if (phase) rows = rows.filter((o) => o.phase === phase);
    if (fromMs != null) rows = rows.filter((o) => Date.parse(o.end) > fromMs);
    if (toMs != null) rows = rows.filter((o) => Date.parse(o.start) < toMs);
    rows.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const conflicts = [];
    const overlaps = [];
    const seen = new Set();
    for (const row of rows) {
      const at = Date.parse(row.start);
      const picture = capacityAt(schedule.all(), at, cfg.maxMeetings);
      const key = row.start;
      if (seen.has(key)) continue;
      seen.add(key);
      if (picture.over_by > 0) conflicts.push({ at: row.start, ...picture });
      else if (flag_overlaps && picture.affected.length > 1) overlaps.push({ at: row.start, schedule_ids: picture.affected.map((o) => o.schedule_id) });
    }
    return ok({ orders: rows.map((row) => orderView(row, timezone)), conflicts, ...(flag_overlaps ? { overlaps } : {}) });
  }));

  server.registerTool('update_schedule', {
    title: 'Update a scheduled meeting',
    description: 'When occurrence is omitted, the change applies to the rule and the whole future series. When occurrence is set, only that occurrence changes. A transcript that already exists is not rewritten. The admin password is not accepted.',
    inputSchema: {
      schedule_id: z.string().min(3).max(80),
      occurrence: z.string().max(80).optional().describe('One occurrence id. Omit to change the whole future series.'),
      start: z.string().max(64).optional(),
      end: z.string().max(64).optional(),
      topic: z.string().max(200).optional(),
      room_password: z.string().min(1).max(200).optional().describe('Replaces the stored join password. Not returned.'),
      timezone: z.string().max(80).optional(),
      recurrence: z.string().max(500).optional(),
      early_margin: z.number().int().min(0).optional(),
    },
  }, guarded(async (args) => {
    const { schedule_id, occurrence, ...patch } = args;
    const order = schedule.update(schedule_id, occurrence, patch);
    emit({ type: 'schedule.updated', data: publicOrder(order) });
    await clock.emitCapacity(Date.now(), false);
    return ok(orderView(order));
  }));

  server.registerTool('cancel_schedule', {
    title: 'Cancel a scheduled meeting',
    description: 'Cancels one occurrence, or the series when occurrence is omitted. Leaves a live occurrence unless leave_if_live is false.',
    inputSchema: {
      schedule_id: z.string().min(3).max(80),
      occurrence: z.string().max(80).optional(),
      leave_if_live: z.boolean().optional().describe('Default true. Leave if that occurrence is live or in overrun.'),
    },
  }, guarded(async ({ schedule_id, occurrence, leave_if_live }) => {
    const before = schedule.all().filter((o) => o.schedule_id === schedule_id || o.occurrence_id === occurrence);
    const live = before.filter((o) => (o.phase === 'live' || o.phase === 'overrun') && (!occurrence || o.occurrence_id === occurrence));
    const touched = schedule.cancel(schedule_id, occurrence);
    if (leave_if_live !== false) {
      for (const order of live) {
        const m = order.meeting_id && meetings.get(order.meeting_id);
        if (m && m.state === 'live') await depart(m, 'cancel');
      }
    }
    for (const order of touched) emit({ type: 'schedule.cancelled', data: publicOrder(order) });
    await clock.emitCapacity(Date.now(), false);
    return ok({ cancelled: touched.map(publicOrder) });
  }));

  server.registerTool('import_schedule', {
    title: 'Import schedule orders',
    description: 'Bulk path for a calendar Grok Bot has already read. Each item is a schedule_meeting body plus external_id. This process does not call a calendar. A recurrence rule it cannot expand is reported and not stored. Over capacity is stored and listed in conflicts.',
    inputSchema: {
      orders: z.array(z.object({
        link: z.string().url().max(2048),
        room_password: z.string().min(1).max(200),
        start: z.string().min(1).max(64),
        end: z.string().max(64).optional(),
        timezone: z.string().max(80).optional(),
        recurrence: z.string().max(500).optional(),
        early_margin: z.number().int().min(0).optional(),
        external_id: z.string().max(200).optional(),
        topic: z.string().max(200).optional(),
      })).max(500),
    },
  }, guarded(async ({ orders }) => {
    const created = [];
    const updated = [];
    const unchanged = [];
    const conflicts = [];
    for (const item of orders) {
      try {
        const added = schedule.add(item);
        const id = added.order.schedule_id;
        if (added.updated) updated.push(id);
        else if (added.duplicate) unchanged.push(id);
        else created.push(id);
        const meeting = ensureMeeting(schedule.get(added.order.occurrence_id || id) || added.order);
        const capacity = capacityAt(schedule.all(), Date.parse(added.order.start), cfg.maxMeetings);
        if (capacity.over_by > 0) conflicts.push({ external_id: item.external_id || '', schedule_id: id, over_by: capacity.over_by, reason: 'capacity' });
        if (!added.order.meeting_id) schedule.setPhase(added.order.occurrence_id || id, { meeting_id: meeting.meeting_id });
      } catch (e) {
        conflicts.push({ external_id: item.external_id || '', reason: 'rule', error: String((e && e.message) || e) });
      }
    }
    await clock.emitCapacity(Date.now(), false);
    return ok({ created, updated, unchanged, conflicts });
  }));

  server.registerTool('meeting_status', {
    title: 'Status of one meeting',
    description: 'One meeting, one object: phase, people, whether the bot is thinking, speaking, or listening, and line counts. No room password, admin password, bot password, or model key.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = need(meeting_id);
    const order = schedule.all().find((o) => o.meeting_id === meeting_id && o.phase !== 'series') || null;
    let people = null;
    let hand = null;
    let mic = null;
    let camera = null;
    if (m.state === 'live' && m.session_id && typeof bot.people === 'function') people = await bot.people(m.session_id);
    if (m.state === 'live' && m.session_id && typeof bot.meetingState === 'function') {
      const extra = await bot.meetingState(m.session_id);
      if (extra && extra.applied && extra.result) {
        if ('hand' in extra.result) hand = !!extra.result.hand;
        if ('mic' in extra.result) mic = !!extra.result.mic;
        if ('camera' in extra.result) camera = !!extra.result.camera;
      }
    }
    return ok({
      meeting_id: m.meeting_id,
      topic: m.topic,
      state: m.state,
      phase: order ? order.phase : m.state,
      link: m.link,
      people,
      transcribing: !!m.transcribing,
      thinking: thinkingOf(m),
      speaking: !!(bot.queue && typeof bot.queue.isSpeaking === 'function' && (bot.queue.isSpeaking(m.meeting_id) || bot.queue.isSpeaking(m.session_id))),
      listening: !!m.transcribing && !m.muted,
      hand,
      mic,
      camera,
      eyes: false,
      counts: counts(m.meeting_id),
      last_error: '',
      started_at: m.started_at,
      ended_at: m.ended_at,
      schedule_id: order ? order.schedule_id : '',
      start: order ? order.start : null,
      end: order ? order.end : null,
    });
  }));

  server.registerTool('tail_lines', {
    title: 'Tail speech, chat, and spoken lines',
    description: 'Lines with seq greater than since. kinds may be speech, chat, or spoken. Omit meeting_id to read every meeting. Lines are raw.',
    inputSchema: {
      meeting_id: meetingId.optional(),
      since: z.number().int().min(0).optional(),
      kinds: z.array(z.enum(['speech', 'chat', 'spoken'])).optional(),
    },
  }, guarded(async ({ meeting_id, since, kinds }) => {
    if (meeting_id) need(meeting_id);
    return ok(transcript.query({ meetingId: meeting_id, since, kinds }));
  }));

  server.registerTool('meetings_report', {
    title: 'Cross-meeting lines',
    description: 'Rows a summary is built from. This is not the summary. Grok Bot writes the prose.',
    inputSchema: {
      since: z.number().int().min(0).optional(),
      meeting_ids: z.array(meetingId).optional(),
    },
  }, guarded(async ({ since, meeting_ids }) => {
    const wanted = meeting_ids && meeting_ids.length ? meeting_ids : meetings.all().map((m) => m.meeting_id);
    const window = transcript.query({ since, kinds: ['speech', 'chat', 'spoken'] });
    return ok({
      since: window.since,
      next: window.next,
      meetings: wanted.map((id) => {
        const m = meetings.get(id);
        if (!m) return null;
        return {
          meeting_id: id,
          topic: m.topic,
          state: m.state,
          counts: counts(id),
          lines: window.lines.filter((l) => l.meeting_id === id),
        };
      }).filter(Boolean),
    });
  }));

  server.registerTool('tail_events', {
    title: 'Tail connector events',
    description: 'Ordered events for the whole connector, including capacity.near, capacity.reached, and capacity.cleared. Pass next back as since.',
    inputSchema: { since: z.number().int().min(0).optional() },
  }, guarded(async ({ since }) => ok(events.tail(since || 0))));

  server.registerTool('capacity_status', {
    title: 'Capacity of the meeting bot',
    description: 'The latest capacity picture: level ok, near, or reached, who is seated, who is waiting, and future clashes inside the horizon. Grok Bot calls this on connect and when the human asks.',
    inputSchema: {},
  }, guarded(async () => ok(clock.picture(Date.now()))));

  const subs = new Set();
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    if (request && request.params && request.params.uri) subs.add(String(request.params.uri));
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    if (request && request.params && request.params.uri) subs.delete(String(request.params.uri));
    return {};
  });
  const off = transcript.onLine((row) => {
    if (!row || !row.meeting_id || row._evented) return;
    row._evented = true;
    emit({ type: 'line.' + row.kind, meeting_id: row.meeting_id, data: { seq: row.seq, speaker: row.speaker, text: row.text, kind: row.kind } });
    const uri = 'gifos://meeting/' + row.meeting_id + '/transcript';
    if (!subs.has(uri)) return;
    server.server.sendResourceUpdated({ uri }).catch(() => {});
  });
  const origClose = server.close.bind(server);
  server.close = async () => { off(); return origClose(); };

  server.registerResource(
    'meeting-transcript',
    new ResourceTemplate('gifos://meeting/{id}/transcript', {
      list: async () => {
        const ids = new Set(transcript.meetings());
        for (const m of meetings.all()) {
          if (m.state === 'live' || ids.has(m.meeting_id)) ids.add(m.meeting_id);
        }
        return {
          resources: [...ids].filter((id) => /^m_[0-9a-f]+$/.test(id)).map((id) => ({
            uri: 'gifos://meeting/' + id + '/transcript',
            name: 'meeting-transcript',
            mimeType: 'application/x-ndjson',
          })),
        };
      },
    }),
    {
      title: 'Live meeting transcript',
      description: 'Newline-delimited JSON for one meeting, tailed from Meet Bot. Each line is {seq, ts, speaker, text, kind}. Subscribe for updates while the meeting is live. After the meeting, read it and do the follow-up yourself.',
      mimeType: 'application/x-ndjson',
    },
    async (uri, vars) => {
      const id = vars && (vars.id || vars.meeting_id);
      const m = id && meetings.get(String(id));
      if (!m) throw new Error('Unknown meeting_id ' + JSON.stringify(id) + '.');
      return { contents: [{ uri: String(uri), mimeType: 'application/x-ndjson', text: transcript.ndjson(m.meeting_id) }] };
    },
  );

  return server;
}
