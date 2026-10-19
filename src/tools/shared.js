// The tools both GifOS MCP servers have: transcripts and lines, speaking and
// chat, who is here, leaving, the join schedule, events and capacity, and
// the live transcript resource. Each server adds its own tools next to
// these (meetings in gifos-meet-mcp, broadcasts in gifos-broadcast-mcp).
import fs from 'node:fs';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { publicView, roomFromLink } from '../meetings.js';
import { CONTROLS_GAP, INTERJECT_GAP, SNAPSHOT_GAP, scrub } from '../voice/settings.js';
import { WAKE_RE, QUESTION_RE } from '../voice/wake.js';
import { publicOrder, capacityAt, withInstructions, INSTRUCTIONS_MAX } from '../schedule.js';
import { credentialProblem } from '../config.js';
import { pictureFromFile, savePicture, saveName } from '../profile.js';

// Each server names only the tools it actually has.
export function meetingIdFor(serverName) {
  const via = serverName === 'gifos-broadcast-mcp'
    ? 'create_broadcast or join_broadcast'
    : 'create_meeting or join_meeting';
  return z.string().min(3).max(40).describe('The meeting_id of the room (from ' + via + ').');
}

export const meetingId = meetingIdFor('gifos-meet-mcp');

const sinceSeq = z.number().int().min(0).optional().describe('Return lines with a seq greater than this. Omit or pass 0 to read from the start.');
// The owner's goal and instructions for a meeting. Kept and handed back to
// the agent that drives the bot; never run by this server.
export const instructionsField = z.string().max(INSTRUCTIONS_MAX).optional().describe('The owner\'s goal and instructions for the bot in this meeting (for example the questions of a daily check-in), plain text up to ' + INSTRUCTIONS_MAX + ' characters. Stored and handed back to you in list_schedule, meeting_status and the schedule.due and meeting.joined events; this server never runs it. Omit for the default: the bot only transcribes. Do not put passwords or other secrets here.');

const lineKinds = z.array(z.enum(['speech', 'chat', 'spoken'])).optional().describe('Which lines to return: speech (someone in the room), chat (a chat post), spoken (a line this bot said). Omit for all three.');

export function registerSharedTools(server, ctx, { name, version }) {
  const meetingId = meetingIdFor(name);
  const {
    cfg, meetings, bot, transcript, schedule, events, clock, secret, secrets, ok, fail, emit, guarded, need, needLive,
    holdSeat, depart, stopJoin, counts, thinkingOf, ourNames, nameIn, orderView, ensureMeeting, instructionsFor,
  } = ctx;
  server.registerTool('mute', {
    title: 'Mute the bot (stop listening)',
    description: 'Stops captions for this meeting. This tool only stops transcription.',
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
    description: 'Posts text into the meeting chat as the bot. Same chat channel as send_chat. It does not speak (say does that) and it does not share a screen.',
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

  server.registerTool('end_meeting', {
    title: 'End the meeting for the bot',
    description: 'The bot leaves and the transcript is saved. Same result as leave_meeting. Other participants stay; a GifOS meeting has no owner who can close it for everyone. A scheduled order still inside its window is marked left early.',
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
    description: 'Is the headless GifOS browser up, which GifOS it uses, and which rooms the bot is in right now.',
    inputSchema: {},
  }, guarded(async () => {
    const info = await bot.info();
    return ok({
      server: name,
      version,
      gifos_url: cfg.gifosUrl,
      stt_app: cfg.sttApp || null,
      live_meetings: meetings.all().filter((m) => m.state === 'live').map((m) => m.meeting_id),
      voice: { ...ctx.voiceState(), tts: info.tts_unavailable ? { engine: null, error: info.tts_unavailable } : (cfg.voice.tts.engine === 'none' ? null : { engine: cfg.voice.tts.engine, voice: cfg.voice.tts.voice || null }) },
      bot: info,
    });
  }));

  server.registerTool('tail_transcript', {
    title: 'Tail the live transcript',
    description: 'Speech and spoken lines for one meeting, with seq greater than since. kind is speech for someone in the room, and spoken for a line this bot said. Chat is not included: tail_lines returns chat as well, can filter by kinds, and can read every meeting at once. Works while the meeting is live and after it ends. The same speech and spoken lines are the gifos://meeting/{id}/transcript resource.',
    inputSchema: {
      meeting_id: meetingId,
      since: sinceSeq,
    },
  }, guarded(async ({ meeting_id, since }) => {
    need(meeting_id);
    return ok(transcript.tail(meeting_id, since || 0));
  }));

  server.registerTool('say', {
    title: 'Speak in the room',
    description: 'Meeting Bot says this line out loud in the room now, interrupting any line it is still saying. The words are yours: Meeting Bot answers nothing on its own. The audio is made on this computer by Kokoro. share_content and send_chat are chat, not speech.',
    inputSchema: {
      meeting_id: meetingId,
      text: z.string().min(1).max(2000).describe('What to say, in one or two sentences.'),
      voice: z.string().min(1).max(40).optional().describe('A Kokoro voice name for this line, for example af_heart (the default). Leave it out to keep the default voice.'),
    },
  }, guarded(async ({ meeting_id, text, voice }) => {
    const m = needLive(meeting_id);
    if (typeof bot.interject !== 'function') throw new Error(INTERJECT_GAP);
    const said = await bot.interject(m.session_id, text, voice ? { voice } : undefined);
    if (!said || said.applied === false) throw new Error((said && said.gap) || INTERJECT_GAP);
    const speaker = nameIn(m);
    const body = String(text).trim();
    const have = transcript.lines.some((l) => l.meeting_id === m.meeting_id && l.kind === 'spoken' && l.speaker === speaker && l.text === body);
    if (body && !have) transcript.append({ meeting_id: m.meeting_id, speaker, text: body, kind: 'spoken' });
    return ok({ meeting_id: m.meeting_id, spoken: true });
  }));

  server.registerTool('set_bot_profile', {
    title: 'Set how the bot looks in rooms',
    description: 'Sets the name everyone sees on the bot\'s tile, and its picture (a GIF, PNG, JPEG or WebP file on this computer, at most 256 KB). Both are kept for later starts. The picture applies to rooms the bot joins from now on. A new name restarts the bot, so it is refused while the bot is in a room: end_meeting first. GIFOS_BOT_NAME and GIFOS_BOT_PICTURE, when set, win again at the next start.',
    inputSchema: {
      name: z.string().min(3).max(40).optional().describe('The name people see, 3 to 40 characters.'),
      picture_path: z.string().min(1).max(4096).optional().describe('Path to an image file on this computer.'),
      clear_picture: z.boolean().optional().describe('true removes the picture (people see the first letter of the name).'),
    },
  }, guarded(async ({ name, picture_path, clear_picture }) => {
    if (!name && !picture_path && !clear_picture) throw new Error('Give a name, a picture_path, or clear_picture.');
    if (typeof bot.setLook !== 'function') throw new Error('With several workers (GIFOS_WORKERS > 1), set GIFOS_BOT_NAME and GIFOS_BOT_PICTURE and restart the server.');
    const password = secret[0];
    const current = ourNames()[0];
    if (name) {
      const bad = credentialProblem(name, password);
      if (bad) throw new Error(bad);
      if (name !== current && meetings.all().some((m) => m.state === 'live')) {
        throw new Error('The bot is in a room; its name can change when it is in none (end_meeting first).');
      }
    }
    let picture;
    if (clear_picture) picture = null;
    else if (picture_path) picture = pictureFromFile(picture_path);
    if (picture !== undefined) savePicture(cfg.home, picture);
    if (name && name !== current) saveName(cfg.home, name, password);
    const look = await bot.setLook({ name: name || undefined, picture });
    const notes = [];
    if (name && cfg.botName && cfg.botName !== name) notes.push('GIFOS_BOT_NAME is set, so the next start uses that name again.');
    if (picture !== undefined && cfg.botPicture) notes.push('GIFOS_BOT_PICTURE is set, so the next start uses that picture again.');
    return ok({ name: look.name, picture: look.picture, notes });
  }));

  server.registerTool('wait_lines', {
    title: 'Wait for the next lines (fast)',
    description: 'Returns as soon as there is a line with seq greater than since (speech, chat, or a line the bot spoke), or after timeout_ms with none. Use it in a loop to follow a live room with the least delay: pass the returned next as since. Lines addressed to the bot (its name, "bot", or a question) carry to_bot: true.',
    inputSchema: {
      meeting_id: meetingId.optional(),
      since: z.number().int().min(0).optional().describe('The next value from the previous call, or 0.'),
      timeout_ms: z.number().int().min(0).max(30000).optional().describe('How long to wait for a new line. Default 20000, at most 30000.'),
      kinds: lineKinds,
    },
  }, guarded(async ({ meeting_id, since, timeout_ms, kinds }) => {
    if (meeting_id) need(meeting_id);
    const from = since || 0;
    const read = () => markToBot(transcript.query({ meetingId: meeting_id, since: from, kinds }));
    let got = read();
    if (got.lines.length) return ok(got);
    const wait = timeout_ms == null ? 20000 : timeout_ms;
    if (wait > 0) {
      await new Promise((resolve) => {
        let off = () => {};
        const timer = setTimeout(() => { off(); resolve(); }, wait);
        off = transcript.onLine((row) => {
          if (!row || row.seq <= from) return;
          if (meeting_id && row.meeting_id !== meeting_id) return;
          if (kinds && kinds.length && !kinds.includes(row.kind)) return;
          clearTimeout(timer); off(); resolve();
        });
      });
      got = read();
    }
    return ok(got);
  }));

  // A line addressed to the bot: its name or "bot", or a question.
  function markToBot(window) {
    const names = ourNames().map((n) => String(n || '').toLowerCase()).filter(Boolean);
    for (const l of window.lines) {
      if (l.kind === 'spoken') continue;
      const t = String(l.text || '').toLowerCase();
      l.to_bot = WAKE_RE.test(t) || QUESTION_RE.test(t) || /\?\s*$/.test(t) || names.some((n) => t.includes(n));
    }
    return window;
  }

  server.registerTool('send_chat', {
    title: 'Send a chat message',
    description: 'Posts a chat line as the bot. Same chat channel as share_content. It does not speak (say does that).',
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

  server.registerTool('get_meeting_state', {
    title: 'Who is in the meeting',
    description: 'Who is in the room, plus hand, microphone, and camera when Meeting Bot reports them. This is the people list. snapshot is the same list plus a PNG of the page. Contract version 1 returns the people list only.',
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
    return ok(withInstructions({
      meeting_id: m.meeting_id,
      transcribing: !!m.transcribing,
      muted: !!m.muted,
      people,
      hand,
      mic,
      camera,
      controls_gap,
    }, instructionsFor(m)));
  }));

  server.registerTool('snapshot', {
    title: 'Snapshot of the Meeting Bot page',
    description: 'Who is in the room, and a PNG of the Meeting Bot page this server already has open, returned as image content. Read-only: it does not join another browser and it does not change the meeting. get_meeting_state is the same people list without the picture.',
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
    const body = ok({ meeting_id: m.meeting_id, people, png, snapshot: shot, gap });
    if (!png) return body;
    let bytes;
    try { bytes = fs.readFileSync(png); } catch (e) { return body; }
    if (!bytes.length) return body;
    return { content: body.content.concat([{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }]) };
  }));

  server.registerTool('leave_meeting', {
    title: 'Leave the meeting',
    description: 'The bot leaves and the transcript is saved. Same result as end_meeting. Call this when someone asks the bot to leave. Other participants stay. A scheduled order still inside its window is marked left early.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = need(meeting_id);
    const stopped = stopJoin(m);
    if (stopped) return stopped;
    if (m.state !== 'live' || !m.session_id) return ok({ ...publicView(m), note: 'The bot was not in this meeting.' });
    const left = await depart(m, 'manual');
    return ok({ ...publicView(left.done), transcript_lines: left.lines });
  }));

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
      instructions: instructionsField,
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
      schedule_id: z.string().min(3).max(80).describe('The schedule_id from schedule_meeting or list_schedule.'),
      occurrence: z.string().max(80).optional().describe('One occurrence id. Omit to change the whole future series.'),
      start: z.string().max(64).optional().describe('New start, as an ISO time.'),
      end: z.string().max(64).optional().describe('New end, as an ISO time.'),
      topic: z.string().max(200).optional().describe('New room name.'),
      room_password: z.string().min(1).max(200).optional().describe('Replaces the stored join password. Not returned.'),
      timezone: z.string().max(80).optional().describe('IANA time zone. Default UTC.'),
      recurrence: z.string().max(500).optional().describe('The calendar recurrence rule, stored as sent. An RRULE this process understands is expanded. Anything else is refused.'),
      early_margin: z.number().int().min(0).optional().describe('Milliseconds before start to join.'),
      instructions: z.string().max(INSTRUCTIONS_MAX).optional().describe('New goal and instructions for the bot, plain text up to ' + INSTRUCTIONS_MAX + ' characters. An empty string clears them (transcribe only). Never run by this server.'),
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
      schedule_id: z.string().min(3).max(80).describe('The schedule_id from schedule_meeting or list_schedule.'),
      occurrence: z.string().max(80).optional().describe('One occurrence id. Omit to cancel the whole series.'),
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
        link: z.string().url().max(2048).describe('The plain GifOS meeting link.'),
        room_password: z.string().min(1).max(200).describe('The room password guests type. Stored for rejoin. Not returned.'),
        start: z.string().min(1).max(64).describe('When the bot should be in the room, as an ISO time.'),
        end: z.string().max(64).optional().describe('When overrun starts. Omit for start plus 8 hours.'),
        timezone: z.string().max(80).optional().describe('IANA time zone. Default UTC.'),
        recurrence: z.string().max(500).optional().describe('The calendar recurrence rule, stored as sent.'),
        early_margin: z.number().int().min(0).optional().describe('Milliseconds before start to join. Default 60000.'),
        external_id: z.string().max(200).optional().describe('Caller id. A second write with the same id updates the order.'),
        topic: z.string().max(200).optional().describe('Room name.'),
        instructions: instructionsField,
      })).max(500).describe('Up to 500 schedule_meeting bodies.'),
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
    return ok(withInstructions({
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
    }, instructionsFor(m)));
  }));

  server.registerTool('tail_lines', {
    title: 'Tail speech, chat, and spoken lines',
    description: 'Every stored line with seq greater than since: speech, chat, and spoken. Filter with kinds. Omit meeting_id to read every meeting. tail_transcript is speech and spoken for one meeting only.',
    inputSchema: {
      meeting_id: meetingId.optional(),
      since: sinceSeq,
      kinds: lineKinds,
    },
  }, guarded(async ({ meeting_id, since, kinds }) => {
    if (meeting_id) need(meeting_id);
    return ok(transcript.query({ meetingId: meeting_id, since, kinds }));
  }));

  server.registerTool('meetings_report', {
    title: 'Cross-meeting lines',
    description: 'Rows a summary is built from. This is not the summary. Grok Bot writes the prose.',
    inputSchema: {
      since: sinceSeq,
      meeting_ids: z.array(meetingId).optional().describe('Meetings to include. Omit for every meeting this server knows.'),
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
    inputSchema: { since: z.number().int().min(0).optional().describe('Return events after this seq. Pass the previous next, or omit to read from the start.') },
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
      description: 'Newline-delimited JSON for one meeting, tailed from Meeting Bot. Each line is {seq, ts, speaker, text, kind}. Subscribe for updates while the meeting is live. After the meeting, read it and do the follow-up yourself.',
      mimeType: 'application/x-ndjson',
    },
    async (uri, vars) => {
      const id = vars && (vars.id || vars.meeting_id);
      const m = id && meetings.get(String(id));
      if (!m) throw new Error('Unknown meeting_id ' + JSON.stringify(id) + '.');
      return { contents: [{ uri: String(uri), mimeType: 'application/x-ndjson', text: transcript.ndjson(m.meeting_id) }] };
    },
  );

}
