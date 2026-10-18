// The meetings this server knows about, kept in GIFOS_MCP_HOME/meetings.json
// so a restart (or a 5 PM routine on a server started at boot) still finds
// the meeting created this morning.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readPrivate, writePrivate } from './private-file.js';
import { newRoom, roomFromLink } from './links.js';

export { newRoom, roomFromLink };

function stripSecrets(fields) {
  const out = { ...(fields || {}) };
  delete out.room_password;
  delete out.admin_password;
  delete out.password;
  return out;
}

export function linkFor(gifosUrl, room, relay) {
  return gifosUrl + '/run.html#v=' + room + (relay ? '&relay=' + encodeURIComponent(relay) : '');
}

export class MeetingStore {
  constructor(home) {
    this.file = path.join(home, 'meetings.json');
    this.home = home;
    // It may still hold the only copy of every transcript.
    const saved = readPrivate(this.file, 'starting with no meetings', (x) => x && Array.isArray(x.meetings || []));
    this.items = (saved && saved.meetings) || [];
  }

  save() {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    writePrivate(this.file, JSON.stringify({ meetings: this.items }, null, 2) + '\n');
  }

  get(id) { return this.items.find((m) => m.meeting_id === id) || null; }
  byRoom(room) { return this.items.find((m) => m.room === room && m.state !== 'ended') || null; }
  all() { return this.items.slice(); }

  add(fields) {
    const m = {
      meeting_id: 'm_' + crypto.randomBytes(5).toString('hex'),
      topic: '',
      start_time: null,
      link: '',
      room: '',
      state: 'scheduled',
      session_id: null,
      transcribing: false,
      muted: false,
      transcript: null,
      created_at: new Date().toISOString(),
      started_at: null,
      ended_at: null,
      thinking: false,
      ...stripSecrets(fields),
    };
    this.items.push(m);
    this.save();
    return m;
  }

  // A new process has a new browser, so no meeting is live any more. Each one
  // goes back to scheduled and start_meeting can bring the bot back.
  resetLive() {
    let n = 0;
    for (const m of this.items) {
      if (m.state !== 'live') continue;
      Object.assign(m, { state: 'scheduled', session_id: null, transcribing: false });
      n++;
    }
    if (n) this.save();
    return n;
  }

  update(id, fields) {
    const m = this.get(id);
    if (!m) return null;
    Object.assign(m, stripSecrets(fields));
    this.save();
    return m;
  }
}

// What a tool returns about a meeting: never the cached transcript body.
export function publicView(m) {
  return {
    meeting_id: m.meeting_id,
    topic: m.topic,
    start_time: m.start_time,
    link: m.link,
    state: m.state,
    transcribing: !!m.transcribing,
    muted: !!m.muted,
    thinking: !!m.thinking,
    created_at: m.created_at,
    started_at: m.started_at,
    ended_at: m.ended_at,
  };
}
