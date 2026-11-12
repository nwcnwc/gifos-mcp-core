// Tools for what a GifOS 0.9.26 meeting can do beyond talk and transcript:
// the shared agenda, an app in the meeting (Take Turns among them), the
// stage, and signing the bot in as the host. Each acts as the bot's own seat
// with that seat's rights (src/room.js). On an older GifOS site each answers
// that the site does not have it yet.
import { z } from 'zod';
import { scrub } from '../voice/settings.js';
import { meetingIdFor } from './shared.js';

const TURNS_APP = 'taketurns';

export function registerRoomTools(server, ctx, { name } = {}) {
  const meetingId = meetingIdFor(name || 'gifos-meet-mcp');
  const { bot, ok, guarded, needLive, secrets } = ctx;
  const room = (m, op, args) => {
    if (typeof bot.room !== 'function') throw new Error('This bot cannot reach the meeting page.');
    return bot.room(m.session_id, op, args || {});
  };

  server.registerTool('set_agenda', {
    title: 'Share an agenda in the meeting',
    description: 'Shares an agenda in the meeting\'s content area (GifOS 0.9.26): a list of items, each with minutes for timekeeping. Everyone sees it in the Agenda tab with the time left on the current item. The agenda starts at the first item when you call next_agenda_item. In a room with a host only the host may change it, so sign the bot in first (sign_in_as_host). If the meeting already has an agenda, pass append:true to add to it.',
    inputSchema: {
      meeting_id: meetingId,
      items: z.array(z.object({
        title: z.string().min(1).max(120).describe('The item, up to 120 characters.'),
        minutes: z.number().int().min(0).max(600).optional().describe('Minutes for this item (0 or omitted: untimed).'),
      })).min(1).max(40).describe('The agenda items in order (up to 40).'),
      append: z.boolean().optional().describe('Add to an agenda the meeting already has.'),
    },
  }, guarded(async ({ meeting_id, items, append }) => {
    const m = needLive(meeting_id);
    return ok({ meeting_id: m.meeting_id, ...(await room(m, 'agenda.add', { items, append: !!append })) });
  }));

  server.registerTool('next_agenda_item', {
    title: 'Move the agenda to the next item',
    description: 'Moves the meeting\'s agenda on to the next item and restarts its clock; the first call starts the agenda at item 1. Same rights as set_agenda.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = needLive(meeting_id);
    return ok({ meeting_id: m.meeting_id, ...(await room(m, 'agenda.next')) });
  }));

  server.registerTool('get_agenda', {
    title: 'The agenda, the current item and the time left',
    description: 'Read-only: the meeting\'s shared agenda as the bot\'s page shows it: the items, which one is current (cur, from 0; -1 = not started), and clock = the time left on the current item as m:ss (or +m:ss when it runs over). agenda is null when nobody has shared one.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = needLive(meeting_id);
    const v = await room(m, 'agenda.get');
    const a = v && v.agenda;
    const current = a && Array.isArray(a.items) && a.cur >= 0 ? (a.items[a.cur] || null) : null;
    return ok({ meeting_id: m.meeting_id, ...v, current_item: current, time_left: a ? (a.clock || null) : null });
  }));

  server.registerTool('list_apps', {
    title: 'Apps the bot can run in the meeting',
    description: 'Read-only: the GifOS apps installed in the bot\'s browser that it can run in this meeting for everyone (for example Take Turns), and the app running now, if any.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = needLive(meeting_id);
    return ok({ meeting_id: m.meeting_id, ...(await room(m, 'app.list')) });
  }));

  server.registerTool('run_app', {
    title: 'Run an app in the meeting',
    description: 'Runs a GifOS app in the meeting for everyone, from the bot\'s seat, the way a person taps Run app: it opens in the meeting\'s App tab. app is its name or app id from list_apps. In a room with a host only the host and people the host allows may run apps. One app at a time; stop_app stops the one the bot started.',
    inputSchema: {
      meeting_id: meetingId,
      app: z.string().min(1).max(80).describe('The app\'s name or app id, for example "Take Turns" or taketurns.'),
    },
  }, guarded(async ({ meeting_id, app }) => {
    const m = needLive(meeting_id);
    return ok({ meeting_id: m.meeting_id, ...(await room(m, 'app.run', { app })) });
  }));

  server.registerTool('stop_app', {
    title: 'Stop the app the bot started',
    description: 'Stops the app the bot is running in the meeting. An app someone else started is theirs to stop.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const m = needLive(meeting_id);
    return ok({ meeting_id: m.meeting_id, ...(await room(m, 'app.stop')) });
  }));

  server.registerTool('take_turns', {
    title: 'Take Turns: start, who is up, next',
    description: 'Drives the Take Turns app (GifOS 0.9.26) in the meeting. action start runs it for everyone (like run_app); state says who is up now, who is up next, the time left and the order; next, back and pass move the turn; restart starts over; shuffle mixes the order; timer sets seconds per turn (0, 60, 120, 180, 300 or 600). Take Turns asks the person whose turn it is onto the stage on each person\'s own page; it never turns on a camera or microphone. In a room with a host, the host leads it.',
    inputSchema: {
      meeting_id: meetingId,
      action: z.enum(['start', 'state', 'next', 'back', 'pass', 'restart', 'shuffle', 'timer']).describe('What to do.'),
      seconds: z.number().int().min(0).max(600).optional().describe('For action timer: seconds per turn.'),
    },
  }, guarded(async ({ meeting_id, action, seconds }) => {
    const m = needLive(meeting_id);
    if (action === 'start') {
      const st = await room(m, 'app.state');
      let started = null;
      if (!st.running) started = await room(m, 'app.run', { app: TURNS_APP });
      else if (!/take turns/i.test(st.name || '')) throw new Error('Another app (' + (st.name || 'an app') + ') is running in this meeting. Stop it first.');
      // The app frame needs a moment to draw its first turn.
      let view = null;
      for (let i = 0; i < 25; i++) {
        try { view = await room(m, 'turns.state'); if (view && view.up_now) break; } catch (e) { view = null; }
        await new Promise((r) => setTimeout(r, 400));
      }
      return ok({ meeting_id: m.meeting_id, started: !!started, turns: view });
    }
    const op = action === 'state' ? 'turns.state' : 'turns.' + action;
    return ok({ meeting_id: m.meeting_id, turns: await room(m, op, { seconds }) });
  }));

  server.registerTool('stage', {
    title: 'The stage: who is on, step on or off, allow someone',
    description: 'The meeting\'s stage (GifOS 0.9.26), within the bot\'s own rights. action state lists who is on the stage and how many seats it has; step_on and step_off move the bot itself (like its Stage button; it never turns on its camera); allow and disallow give or take back a person\'s right to take the stage in a room with a host, which only a host may do (sign_in_as_host first). person_id comes from get_meeting_state.',
    inputSchema: {
      meeting_id: meetingId,
      action: z.enum(['state', 'step_on', 'step_off', 'allow', 'disallow']).describe('What to do.'),
      person_id: z.string().min(1).max(80).optional().describe('For allow and disallow: the person\'s id from get_meeting_state.'),
    },
  }, guarded(async ({ meeting_id, action, person_id }) => {
    const m = needLive(meeting_id);
    if (action === 'state') return ok({ meeting_id: m.meeting_id, ...(await room(m, 'stage.get')) });
    if (action === 'step_on' || action === 'step_off') return ok({ meeting_id: m.meeting_id, ...(await room(m, 'stage.set', { on: action === 'step_on' })) });
    if (!person_id) throw new Error('allow and disallow need person_id (from get_meeting_state).');
    return ok({ meeting_id: m.meeting_id, ...(await room(m, 'stage.grant', { person_id, on: action === 'allow' })) });
  }));

  server.registerTool('sign_in_as_host', {
    title: 'Sign the bot in as the host',
    description: 'In a room with a host (made with type admin), signs the bot in with the host password, the way a person uses Admin > Sign in: the bot then has the host controls (agenda, apps, letting people on the stage). The password is used for this call only and never stored, logged or returned; the bot\'s browser keeps the room\'s host key until the bot leaves the meeting.',
    inputSchema: {
      meeting_id: meetingId,
      host_password: z.string().min(1).max(200).describe('The host password of this room.'),
    },
  }, async ({ meeting_id, host_password }) => {
    const hide = () => secrets().concat(host_password);
    try {
      const m = needLive(meeting_id);
      const v = await room(m, 'host.signin', { password: host_password });
      return { content: [{ type: 'text', text: scrub(JSON.stringify({ meeting_id: m.meeting_id, ...v }, null, 2), hide()) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: scrub(String((e && e.message) || e), hide()) }] };
    }
  });
}
