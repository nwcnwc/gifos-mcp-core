// Tools for guarding a room (src/guard.js): the bot holds a room as its admin and keeps it the way the policy says.
import { z } from 'zod';
import { RoomGuard, normalizePolicy } from '../guard.js';
import { log } from '../log.js';

export function registerGuardTools(server, ctx) {
  const { ok, guarded } = ctx;
  const guards = ctx.guards || (ctx.guards = new Map());   // link -> RoomGuard (also the ones GIFOS_GUARD_CONFIG started)

  server.registerTool('guard_room', {
    title: 'Hold a room as its admin',
    description: 'The bot joins the room and holds it as its admin, so nobody else can take it or change its password (GifOS 0.9.26). An open room is held by capture: credentials is the path of a GifOS subscription file on the $5 or $10 plan (Settings > Subscription > download). A room with a host (mode admin) is held by signing in with host_password. password: omit to keep the room with no password (any password set is cleared at once); give a value to set it and keep it. blur_all presses Blur guests when the page offers it. greet posts a short welcome for newcomers. Removing someone means setting a password (GifOS keeps no ban list), so a room kept with no password removes nobody. rank orders sibling copies of this bot (same name, password and credentials on other computers; GIFOS_BOT_SIBLING=1 on each): all are admins, rank 0 leads. A handler module (onMessage) answers people; see the README. The credentials file is read here and never returned.',
    inputSchema: {
      link: z.string().url().max(2048).describe('The room link.'),
      mode: z.enum(['open', 'admin']).optional().describe('open (default): hold an open room by capture. admin: a room with a host.'),
      credentials: z.string().max(1024).optional().describe('Path of the subscription file (GifOS credentials GIF). Needed for an open room.'),
      host_password: z.string().min(1).max(200).optional().describe('mode admin: the host password. Used in the bot\'s browser only.'),
      password: z.string().max(200).optional().describe('The room password to keep. Omit to keep the room with none.'),
      blur_all: z.boolean().optional().describe('Press Blur guests when offered (default true).'),
      greet: z.union([z.boolean(), z.string().max(400)]).optional().describe('true (default), false, or a welcome text with {names}.'),
      rank: z.number().int().min(0).max(9).optional().describe('Sibling order: 0 leads.'),
      handler: z.string().max(1024).optional().describe('Path of a module exporting onMessage(message, room).'),
    },
  }, guarded(async (args) => {
    const policy = normalizePolicy(args);
    if (guards.has(policy.link)) return ok({ guarding: true, note: 'Already guarding this room.', ...guards.get(policy.link).status() });
    const g = await new RoomGuard(ctx, policy, { log }).start();
    guards.set(policy.link, g);
    return ok({ guarding: true, ...g.status() });
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
