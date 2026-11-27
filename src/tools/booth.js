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
    description: 'Plays video files from this computer into the broadcast with the page\'s own Rebroadcast button: everyone watching sees and hears them, marked Prerecorded. Give path (one file) or paths (a list, played in order); loop true plays the list again and again. The next file starts the moment one ends. What played before stops. With yield_to_people (filler mode) the booth gives the Stage to any person who takes it and carries on when they leave it. A file that stops well before its end (a bad spot) skips past the spot and plays on; a stuck video, a lost page or a new GifOS release reloads the page and carries on from the same second. start_at_s starts the first file later. clear true (default) picks No blur for the video where the room lets viewers see it clear.',
    inputSchema: {
      booth_id: boothId,
      path: z.string().min(1).max(4096).optional().describe('One video file (for example .webm or .mp4).'),
      paths: z.array(z.string().min(1).max(4096)).min(1).max(1000).optional().describe('Several video files, in play order.'),
      loop: z.boolean().optional().describe('Play the list again from the start when it ends (default false).'),
      start_at_s: z.number().min(0).max(86400).optional().describe('Start the first file at this second.'),
      clear: z.boolean().optional().describe('Pick No blur for the video when the room allows it (default true).'),
      yield_to_people: z.boolean().optional().describe('Filler mode (default false): when a person takes the Stage (a co-host, or someone the host let up), the video stops at once and the booth steps off the Stage without fighting for it; when the Stage is free of people again, the same video goes on from the same second. The gifos.tv listing stays live throughout.'),
    },
  }, guarded(async ({ booth_id, path: one, paths, loop, start_at_s, clear, yield_to_people }) => {
    if (!!one === !!(paths && paths.length)) throw new Error('Give path or paths.');
    const files = (paths || [one]).map((p) => path.resolve(String(p)));
    return ok({ booth_id, ...(await boothOf(booth_id).play(files, { loop, startAt: start_at_s || 0, clear, yieldToPeople: yield_to_people })) });
  }));

  server.registerTool('stop_video', {
    title: 'Stop the video',
    description: 'Stops what play_video plays and forgets its list. The broadcast stays open, off air.',
    inputSchema: { booth_id: boothId },
  }, guarded(async ({ booth_id }) => ok({ booth_id, ...(await boothOf(booth_id).stop()) })));

  // The tip address is not in the public listing: kept beside the booth's profile so an update keeps it.
  const tipFile = (id) => path.join(cfg.home, 'booth-' + id, 'tv-tip.txt');
  const keptTip = (id) => { try { return fs.readFileSync(tipFile(id), 'utf8').trim(); } catch (e) { return ''; } };
  const keepTip = (id, tip) => { try { fs.writeFileSync(tipFile(id), String(tip || '')); } catch (e) { /* the next update asks again */ } };
  const tipField = z.string().regex(/^0x[0-9a-fA-F]{40}$/).or(z.literal('')).optional().describe('A Base address for tips (0x and 40 hex), public, stored by gifos.tv for later (not shown yet). Empty string clears it.');
  const thumbFields = {
    thumbnail_path: z.string().max(4096).optional().describe('A picture file for the thumbnail (JPEG, PNG, WebP); it is drawn to 640x360 on the host page.'),
    thumbnail_from_stage: z.boolean().optional().describe('Take the thumbnail as a still of what is on the Stage now.'),
  };
  const thumbOf = (p) => (p ? readFile(path.resolve(String(p)), 'thumbnail').toString('base64') : '');

  server.registerTool('publish_to_tv', {
    title: 'List the broadcast on gifos.tv',
    description: 'Lists the broadcast whose booth is open (a room you host) on gifos.tv, the public directory of live GifOS broadcasts: the same signed listing as the /cast page\'s "Publish to GifOS.tv" button, signed with the room\'s host key on this computer. title and description are public; the thumbnail comes from thumbnail_path or a still of the Stage (the default when no file is given and something plays). pw_needed shows a "Password needed" badge. From then on the host page itself tells gifos.tv it is on air, sends a keep-alive every few minutes and goes off air when the host leaves; the booth\'s profile remembers the listing across restarts. Publishing again replaces the listing (use update_tv_listing to change only some fields). Everything given here is public.',
    inputSchema: {
      booth_id: boothId,
      title: z.string().min(1).max(80).describe('The public title.'),
      description: z.string().max(500).optional().describe('The public description (up to 500 characters).'),
      ...thumbFields,
      tip_address: tipField,
      pw_needed: z.boolean().optional().describe('Show "Password needed" (for a room with a password).'),
    },
  }, guarded(async ({ booth_id, title, description, thumbnail_path, thumbnail_from_stage, tip_address, pw_needed }) => {
    const b = boothOf(booth_id);
    const thumbB64 = thumbOf(thumbnail_path);
    const tip = tip_address || '';
    const r = await b.tvList({ title, desc: description || '', thumbB64, fromStage: !thumbB64 && thumbnail_from_stage !== false, tip, pw: !!pw_needed });
    keepTip(booth_id, tip);
    return ok({ booth_id, listed: true, url: r.url, listing: r.listing, note: 'The host page keeps this listing on air while the booth is open.' });
  }));

  server.registerTool('update_tv_listing', {
    title: 'Change the gifos.tv listing',
    description: 'Changes only the fields given of the gifos.tv listing of a broadcast whose booth is open: title, description, thumbnail (a file or a still of the Stage), tip address, password badge. The rest stays as listed. A listing on air stays on air.',
    inputSchema: {
      booth_id: boothId,
      title: z.string().min(1).max(80).optional(),
      description: z.string().max(500).optional(),
      ...thumbFields,
      tip_address: tipField,
      pw_needed: z.boolean().optional(),
    },
  }, guarded(async ({ booth_id, title, description, thumbnail_path, thumbnail_from_stage, tip_address, pw_needed }) => {
    const b = boothOf(booth_id);
    const now = await b.tvRead();
    if (!now) throw new Error('This broadcast is not listed on gifos.tv. Use publish_to_tv first.');
    const thumbB64 = thumbOf(thumbnail_path);
    const tip = tip_address === undefined ? keptTip(booth_id) : tip_address;
    const r = await b.tvList({
      title: title || now.title, desc: description === undefined ? (now.desc || '') : description,
      thumbB64, fromStage: !thumbB64 && thumbnail_from_stage === true, keepThumb: now.thumb || '',
      tip, pw: pw_needed === undefined ? !!now.pw : pw_needed,
    });
    keepTip(booth_id, tip);
    return ok({ booth_id, listed: true, url: r.url, listing: r.listing });
  }));

  server.registerTool('stop_tv_listing', {
    title: 'Take the broadcast off gifos.tv',
    description: 'Removes the gifos.tv listing of a broadcast whose booth is open (signed with its host key) and clears the host page\'s listed mark, so the page sends no more keep-alives. The broadcast itself goes on.',
    inputSchema: { booth_id: boothId },
  }, guarded(async ({ booth_id }) => ok({ booth_id, ...(await boothOf(booth_id).tvUnlist()) })));

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
