// Tools for guarding a room (src/guard.js): the bot holds a room as its admin and keeps it the way the policy says.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RoomGuard, normalizePolicy } from '../guard.js';
import { kindField } from '../kind.js';
import { roomFromLink } from '../links.js';
import { log } from '../log.js';

export function registerGuardTools(server, ctx) {
  const { ok, guarded } = ctx;
  const guards = ctx.guards || (ctx.guards = new Map());   // link -> RoomGuard (also the ones GIFOS_GUARD_CONFIG started)

  server.registerTool('guard_room', {
    title: 'Hold a meeting for the user',
    description: 'The bot joins the meeting and holds it (as the host of a private meeting, or by taking charge of a public open-floor meeting), so nobody else can take it or change its password (GifOS 0.9.26). There are two kinds of meeting, as the GifOS screens name them: mode open is a public open-floor meeting ("Start a public open-floor meeting"), mode admin a private meeting ("Host a private meeting"; a private, hosted meeting). A public open-floor meeting is held by capture: credentials is the path of a GifOS credentials GIF that may capture: a subscription file on a $5+ plan (Settings > Subscription > download) or a staff pass. A private meeting (mode admin) is held by signing in with host_password (omit it for a room this server made: it uses the one it keeps). password: omit to keep the room with no password (any password set is cleared at once); give a value to set it and keep it. blur_all presses Blur guests when the page offers it. greet posts a short welcome for newcomers: omit it for the neutral default (it adds "Clear video is disabled." only when blur_all is on), false for none, or your own text containing {names}, e.g. "Hi {names}! Tonight we play chess." For a plain request like "greet people with ...", pass that text with {names} in it. Removing someone means setting a password (GifOS keeps no ban list), so a room kept with no password removes nobody. rank orders sibling copies of this guard on other computers (the same credentials or host password; each may have its own name): all hold the meeting together, rank 0 leads. A sibling is known by that shared key, never by its name. A handler module (onMessage) answers people; see the README. The credentials file is read here and never returned.',
    inputSchema: {
      link: z.string().url().max(2048).describe('The room link.'),
      mode: kindField('open (default): a public open-floor meeting, held by capture. admin: a private meeting (it has a host), held as its host. Also takes the screen words: public or open floor for open, private or hosted for admin.'),
      credentials: z.string().max(1024).optional().describe('Path of the GifOS credentials GIF (a $5+ subscription file or a staff pass). Needed for a public open-floor meeting (mode open).'),
      host_password: z.string().min(1).max(200).optional().describe('mode admin: the host password (omit for a room this server made). Used in the bot\'s browser only. Keep it in a secrets vault or other safe storage, never in chat, notes or logs, and read it from there into this argument.'),
      password: z.string().max(200).optional().describe('The room password to keep. Omit to keep the room with none. Keep it in a secrets vault or other safe storage, never in chat, notes or logs, and read it from there into this argument.'),
      blur_all: z.boolean().optional().describe('Press Blur guests when offered (default true).'),
      greet: z.union([z.boolean(), z.string().max(400)]).optional().describe('true (default text), false (no welcome), or your own welcome text; it must contain {names}, which becomes the newcomers\' names.'),
      rank: z.number().int().min(0).max(9).optional().describe('Sibling order: 0 leads.'),
      handler: z.string().max(1024).optional().describe('Path of a module exporting onMessage(message, room).'),
    },
  }, guarded(async (args) => {
    // A room this server made keeps its host password (the product's ctx.hostPasswordFor): mode admin needs no host_password then.
    if (args.mode === 'admin' && !args.host_password && typeof ctx.hostPasswordFor === 'function') {
      const kept = ctx.hostPasswordFor(roomFromLink(args.link));
      if (kept) args = { ...args, host_password: kept };
    }
    const policy = normalizePolicy(args);
    if (guards.has(policy.link)) return ok({ guarding: true, note: 'Already guarding this room.', ...guards.get(policy.link).status() });
    const g = await new RoomGuard(ctx, policy, { log }).start();
    guards.set(policy.link, g);
    return ok({ guarding: true, ...g.status() });
  }));

  server.registerTool('use_credentials', {
    title: 'Use a GifOS credentials file',
    description: 'Gives the bot the user\'s GifOS credentials GIF (a subscription file from Settings > Subscription, or a pass), so the bot joins meetings with that plan: a paid room plan, TURN when a network blocks direct links, and taking charge of a public open-floor meeting (the page\'s "Make me host" button) when the plan may capture. Give path (a file on the computer this server runs on) or gif_b64 (the file\'s bytes, base64). The file is read once and kept in memory; its bytes go only into the bot\'s own browser (its profile keeps it). It is never logged, returned or stored elsewhere. Meetings the bot is in now take it at once when their page allows, else at their next join; every later join uses it. GIFOS_CREDENTIALS=<path> does the same at start. A plan works in one meeting at a time: the bot\'s newest meeting holds it.',
    inputSchema: {
      path: z.string().min(1).max(1024).optional().describe('Path of the credentials GIF on this computer.'),
      gif_b64: z.string().min(16).max(8_000_000).optional().describe('The credentials GIF itself, base64.'),
    },
  }, guarded(async ({ path: file, gif_b64: b64 }) => {
    if (!!file === !!b64) throw new Error('Give either path or gif_b64.');
    let bytes;
    if (file) {
      try { bytes = fs.readFileSync(path.resolve(String(file))); }
      catch (e) { throw new Error('That file could not be read (' + ((e && e.code) || 'error') + ').'); }
    } else bytes = Buffer.from(String(b64), 'base64');
    if (bytes.length < 16 || bytes.subarray(0, 4).toString('latin1') !== 'GIF8') throw new Error('That is not a GIF: a GifOS credentials file is a GIF.');
    ctx.credentials.set(bytes.toString('base64'));
    let loaded = 0;
    for (const m of ctx.meetings.all()) if (m.state === 'live' && (await ctx.credentials.load(m))) loaded++;
    return ok({ ok: true, loaded_in: loaded, note: 'The bot joins every meeting with these credentials from now on.' });
  }));

  server.registerTool('guard_status', {
    title: 'The rooms the bot is guarding',
    description: 'Read-only: each guarded room, the bot\'s role there (lead, coadmin, taking, held-by-other, waiting), whether it holds the room, the password state and the people count.',
    inputSchema: {},
  }, guarded(async () => ok({ guards: Array.from(guards.values()).map((g) => g.status()) })));

  server.registerTool('stop_guard', {
    title: 'Stop guarding a room',
    description: 'Stops the guard loop for that room. The bot stays in the room until leave_meeting.',
    inputSchema: { link: z.string().url().max(2048) },
  }, guarded(async ({ link }) => {
    const g = guards.get(link); if (!g) return ok({ guarding: false, note: 'Not guarding that room.' });
    g.stop(); guards.delete(link);
    return ok({ guarding: false });
  }));
}
