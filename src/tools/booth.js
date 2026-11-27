// Tools for a broadcast's host seat (src/booth.js): open the booth, play video files into the broadcast (one, a list,
// or a list on a loop), list the broadcast on gifos.tv, read how it stands, close it. With these an assistant can run
// a channel: a broadcast that plays films around the clock and shows on gifos.tv.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BoothPool } from '../booth.js';
import { hostKey, roomFromLink, verifierFromLink } from '../links.js';
import { scrub } from '../voice/settings.js';

const boothId = z.string().min(1).max(64).describe('The booth_id from open_booth (the broadcast room\'s name).');

export function registerBoothTools(server, ctx) {
  const { cfg, ok, guarded, secrets } = ctx;
  const pool = ctx.booths || (ctx.booths = new BoothPool(cfg, { site: ctx.site }));
  const boothOf = (id) => {
    const b = pool.get(id);
    if (!b) throw new Error('No booth is open for ' + id + '. Call open_booth first.');
    return b;
  };
  const readFile = (p, what) => {
    try { return fs.readFileSync(path.resolve(String(p))); }
    catch (e) { throw new Error('The ' + what + ' could not be read (' + ((e && e.code) || 'error') + ').'); }
  };

  server.registerTool('open_booth', {
    title: 'Open the host seat of a broadcast',
    description: 'Opens the host\'s own seat of a GifOS broadcast (the /cast page) in a headless browser on this computer and waits until it is the host with its relay up. Give room (a name, a-z 0-9 -) or link (a broadcast link …/cast#room=…&v=…), and host_password: the broadcast belongs to whoever knows that password (its verifier is in the link). A room name used here for the first time becomes a new hosted broadcast with that password. credentials is the path of a GifOS credentials GIF (a plan or pass), loaded into the booth\'s own browser profile once. The booth keeps its own profile on this computer, so the host key, the credentials and a gifos.tv listing survive a restart. It opens off air: play_video puts video on the Stage.',
    inputSchema: {
      room: z.string().regex(/^[a-z0-9-]{1,64}$/).optional().describe('The broadcast room\'s name. Give room or link.'),
      link: z.string().url().max(2048).optional().describe('A broadcast link (…/cast#room=<room>&v=<verifier>).'),
      host_password: z.string().min(1).max(200).describe('The broadcast\'s host password. Used on this computer only, never returned or logged. Keep it in a secrets vault or other safe storage and read it from there into this argument.'),
      name: z.string().min(1).max(80).optional().describe('The name viewers see for the host (default Host).'),
      credentials: z.string().max(1024).optional().describe('Path of a GifOS credentials GIF on this computer (optional).'),
    },
  }, async ({ room, link, host_password, name, credentials }) => {
    const hide = () => secrets().concat([host_password]);
    if (typeof ctx.holdSecret === 'function') ctx.holdSecret(host_password);
    try {
      const r = room || (link ? roomFromLink(link) : '');
      if (!r || !/^[a-z0-9-]{1,64}$/.test(r)) throw new Error('Give room (a-z, 0-9, -) or a broadcast link.');
      const key = await hostKey(r, host_password);
      if (link && verifierFromLink(link) && verifierFromLink(link) !== key.verifier) throw new Error('That host password is not the one this broadcast link was made with.');
      let credentialsB64 = '';
      if (credentials) {
        const bytes = readFile(credentials, 'credentials file');
        if (bytes.subarray(0, 4).toString('latin1') !== 'GIF8') throw new Error('That is not a GIF: a GifOS credentials file is a GIF.');
        credentialsB64 = bytes.toString('base64');
      }
      const b = await pool.open({ room: r, verifier: key.verifier, seedHex: key.seedHex, name, credentialsB64 });
      return { content: [{ type: 'text', text: scrub(JSON.stringify({ booth_id: b.room, ...(await b.state()) }, null, 2), hide()) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: scrub(String((e && e.message) || e), hide()) }] };
    }
  });

  server.registerTool('play_video', {
    title: 'Play video files into the broadcast',
    description: 'Plays video files from this computer into the broadcast with the page\'s own Rebroadcast button: everyone watching sees and hears them, marked Prerecorded. Give path (one file) or paths (a list, played in order); loop true plays the list again and again. The next file starts the moment one ends. What played before stops. A file that stops well before its end (a bad spot) skips past the spot and plays on; a stuck video, a lost page or a new GifOS release reloads the page and carries on from the same second. start_at_s starts the first file later. clear true (default) picks No blur for the video where the room lets viewers see it clear.',
    inputSchema: {
      booth_id: boothId,
      path: z.string().min(1).max(4096).optional().describe('One video file (for example .webm or .mp4).'),
      paths: z.array(z.string().min(1).max(4096)).min(1).max(1000).optional().describe('Several video files, in play order.'),
      loop: z.boolean().optional().describe('Play the list again from the start when it ends (default false).'),
      start_at_s: z.number().min(0).max(86400).optional().describe('Start the first file at this second.'),
      clear: z.boolean().optional().describe('Pick No blur for the video when the room allows it (default true).'),
    },
  }, guarded(async ({ booth_id, path: one, paths, loop, start_at_s, clear }) => {
    if (!!one === !!(paths && paths.length)) throw new Error('Give path or paths.');
    const files = (paths || [one]).map((p) => path.resolve(String(p)));
    return ok({ booth_id, ...(await boothOf(booth_id).play(files, { loop, startAt: start_at_s || 0, clear })) });
  }));

  server.registerTool('stop_video', {
    title: 'Stop the video',
    description: 'Stops what play_video plays and forgets its list. The broadcast stays open, off air.',
    inputSchema: { booth_id: boothId },
  }, guarded(async ({ booth_id }) => ok({ booth_id, ...(await boothOf(booth_id).stop()) })));

  server.registerTool('publish_to_tv', {
    title: 'List the broadcast on gifos.tv',
    description: 'Lists the broadcast on gifos.tv, the public directory of live GifOS broadcasts, with the page\'s own "Publish to GifOS.tv" sheet: a public title, a public description and a thumbnail (thumbnail_path, a picture file; omit to take a still from the Stage). From then on the host page itself tells gifos.tv it is on air, sends a keep-alive every few minutes and goes off air when the host leaves; the booth\'s profile remembers the listing across restarts. A broadcast already listed answers already: true. Everything given here is public.',
    inputSchema: {
      booth_id: boothId,
      title: z.string().min(1).max(80).describe('The public title.'),
      description: z.string().max(500).optional().describe('The public description (up to 500 characters).'),
      thumbnail_path: z.string().max(4096).optional().describe('A picture file for the thumbnail (JPEG, PNG, WebP).'),
    },
  }, guarded(async ({ booth_id, title, description, thumbnail_path }) => {
    const thumb = thumbnail_path ? path.resolve(String(thumbnail_path)) : '';
    if (thumb) readFile(thumb, 'thumbnail');
    return ok({ booth_id, gifos_tv: await boothOf(booth_id).publish({ title, description, thumbnail: thumb }) });
  }));

  server.registerTool('booth_status', {
    title: 'How the broadcast stands',
    description: 'Read-only: for each open booth (or the one booth_id names): host and relay, on air, the video playing (file, second, length), the list, how many watch, the gifos.tv listing (listed, on air, next keep-alive), the GifOS release the page runs, counts (plays, ends, skips past bad spots, early ends, reloads), the last event and an error if the booth stopped.',
    inputSchema: { booth_id: boothId.optional() },
  }, guarded(async ({ booth_id }) => {
    const list = booth_id ? [boothOf(booth_id)] : pool.list();
    const out = [];
    for (const b of list) out.push({ booth_id: b.room, ...(await b.state()) });
    return ok({ booths: out });
  }));

  server.registerTool('close_booth', {
    title: 'Close the booth',
    description: 'Leaves the broadcast from this computer and closes the booth\'s browser. A gifos.tv listing goes off air (the page sends its off-air note) and comes back on air the next time the booth opens.',
    inputSchema: { booth_id: boothId },
  }, guarded(async ({ booth_id }) => {
    const b = pool.get(booth_id);
    if (b) await b.close();
    return ok({ booth_id, closed: true });
  }));
}
