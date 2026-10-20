// The live transcript the user's assistant tails. Lines are Meet Bot's
// captions (MeetingBot.transcript), not a second listener. The file is mode
// 0600. Callers scrub secrets before append.
import fs from 'node:fs';
import path from 'node:path';
import { isCaptionHallucination } from './hallucination.js';
import { log } from '../log.js';

const ID_RE = /^m_[0-9a-f]+$/;

function splitLines(text) {
  return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

function endsLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (!size) return true;
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    return b[0] === 10;
  } catch (e) { return e.code === 'ENOENT'; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// One chat line's identity: who posted it, when, and what. The same words
// posted twice are two lines, so the time is part of it.
function chatSource(l) {
  return String((l && l.by) || '') + '\u0000' + String((l && l.at) || '') + '\u0000' + String((l && l.text) || '');
}

export function publicLine(row) {
  return { seq: row.seq, ts: row.ts, speaker: row.speaker, text: row.text, kind: row.kind };
}

export class LiveTranscript {
  constructor(home) {
    this.lines = [];
    this.seq = 0;
    this.snapshots = new Map();
    this.chatCounts = new Map();   // per meeting: chat lines already taken
    this.listeners = new Set();
    this.unsaved = [];        // rows in memory whose append to disk failed
    this.torn = new Set();    // files whose last write may have stopped mid-line
    this.failing = false;
    this.dir = home ? path.join(home, 'transcripts') : '';
    this.load();
  }

  load() {
    if (!this.dir || !fs.existsSync(this.dir)) return;
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (e) { return; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      let raw = '';
      try { raw = fs.readFileSync(path.join(this.dir, name), 'utf8'); } catch (e) { continue; }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (!row || !row.meeting_id || !row.kind) continue;
          this.lines.push(row);
          if (row.seq > this.seq) this.seq = row.seq;
        } catch (e) { /* skip a torn line */ }
      }
      // A process killed (or a disk filled) mid-append leaves a last line
      // with no newline; end it, or the next append is glued onto it.
      if (raw && !raw.endsWith('\n')) this.torn.add(path.join(this.dir, name));
    }
  }

  onLine(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  append(entry) {
    const row = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      meeting_id: entry.meeting_id,
      speaker: String(entry.speaker || ''),
      text: String(entry.text || ''),
      kind: entry.kind,
    };
    if (entry.source) row.source = entry.source;
    this.lines.push(row);
    this.unsaved.push(row);
    this.flush();
    for (const fn of this.listeners) {
      try { fn(row); } catch (e) { /* a subscriber must not break the meeting */ }
    }
    return row;
  }

  // The row is already in memory and Meet Bot already showed or sent it.
  // A failed append (disk full) must not throw at the caller: the rest of a
  // caption snapshot would be lost, and a sent chat would read as failed.
  // Kept rows are written first, in seq order, once a write works again.
  flush() {
    while (this.unsaved.length) {
      try { this.persist(this.unsaved[0]); }
      catch (e) {
        if (!this.failing) log('transcript not saved (' + e.message + '); lines are kept in memory until a write works.');
        this.failing = true;
        return;
      }
      this.unsaved.shift();
      if (this.failing) log('transcript saved again.');
      this.failing = false;
    }
  }

  persist(row) {
    if (!this.dir || !ID_RE.test(row.meeting_id)) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, row.meeting_id + '.jsonl');
    const fresh = !fs.existsSync(file);
    let text = JSON.stringify(row) + '\n';
    if (this.torn.has(file) && !endsLine(file)) text = '\n' + text;
    try { fs.appendFileSync(file, text, { mode: 0o600 }); }
    catch (e) { this.torn.add(file); throw e; }
    this.torn.delete(file);
    if (fresh) fs.chmodSync(file, 0o600);
  }

  // Captions only grow during a meeting. A restart has no snapshot, so lines
  // already stored are not appended again.
  // botName may be a list: in stage B each worker's bot has its own name.
  ingestCaption(meetingId, text, botName) {
    const raw = splitLines(text);
    const prev = this.snapshots.get(meetingId);
    let fresh = raw;
    if (prev === text) return [];
    if (typeof prev === 'string' && text.startsWith(prev)) {
      fresh = raw.slice(splitLines(prev).length);
    } else if (prev !== undefined) {
      const have = this.seenSources(meetingId);
      fresh = raw.filter((line) => !have.has(line));
    } else {
      const have = this.seenSources(meetingId);
      if (have.size) fresh = raw.filter((line) => !have.has(line));
    }
    this.snapshots.set(meetingId, String(text || ''));
    const added = [];
    const skip = new Set([].concat(botName || []).map((n) => String(n).toLowerCase()).filter(Boolean));
    for (const line of fresh) {
      const m = /^([^:]{1,80}):\s*(.*)$/.exec(line);
      if (!m) continue;
      const speaker = m[1].trim();
      const said = m[2].trim();
      if (!said) continue;
      if (isCaptionHallucination(said)) continue;
      const bot = skip.has(speaker.toLowerCase());
      if (bot) {
        const dup = this.lines.some((l) => l.meeting_id === meetingId && l.kind === 'spoken' && l.speaker.toLowerCase() === speaker.toLowerCase() && l.text === said);
        if (!dup) added.push(this.append({ meeting_id: meetingId, speaker, text: said, kind: 'spoken', source: line }));
        continue;
      }
      added.push(this.append({ meeting_id: meetingId, speaker, text: said, kind: 'speech', source: line }));
    }
    return added;
  }

  seenSources(meetingId) {
    return new Set(this.lines.filter((l) => l.meeting_id === meetingId && (l.kind === 'speech' || l.kind === 'spoken') && l.source).map((l) => l.source));
  }

  // Chat is the list Meet Bot keeps per meeting (chatFile): every line
  // anyone posted, the bot's own included, oldest first. It only grows while
  // the bot is seated, so the lines past the last count are new. A restart
  // (or a reseat, which starts the list again) has no count to trust; then
  // a line whose source is already stored is not appended again. The bot's
  // own post is already a row (send_chat appends it), so it is kept once.
  ingestChat(meetingId, lines, botName) {
    const list = Array.isArray(lines) ? lines : [];
    const prev = this.chatCounts.get(meetingId);
    let fresh;
    if (typeof prev === 'number' && list.length >= prev) {
      fresh = list.slice(prev);
    } else {
      const have = this.seenChat(meetingId);
      fresh = list.filter((l) => !have.has(chatSource(l)));
    }
    this.chatCounts.set(meetingId, list.length);
    const skip = new Set([].concat(botName || []).map((n) => String(n).toLowerCase()).filter(Boolean));
    const added = [];
    for (const l of fresh) {
      const speaker = String((l && l.by) || '').trim();
      const text = String((l && l.text) || '').trim();
      if (!speaker || !text) continue;
      if (skip.has(speaker.toLowerCase())) {
        const dup = this.lines.some((r) => r.meeting_id === meetingId && r.kind === 'chat' && r.speaker.toLowerCase() === speaker.toLowerCase() && r.text === text);
        if (dup) continue;
      }
      added.push(this.append({ meeting_id: meetingId, speaker, text, kind: 'chat', source: chatSource(l) }));
    }
    return added;
  }

  seenChat(meetingId) {
    return new Set(this.lines.filter((l) => l.meeting_id === meetingId && l.kind === 'chat' && l.source).map((l) => l.source));
  }

  tail(meetingId, since) {
    const n = Number(since) || 0;
    const lines = this.lines.filter((l) => l.meeting_id === meetingId && (l.kind === 'speech' || l.kind === 'spoken') && l.seq > n).map(publicLine);
    return { meeting_id: meetingId, lines, next: lines.length ? lines[lines.length - 1].seq : n };
  }

  query({ meetingId, since, kinds } = {}) {
    const n = Number(since) || 0;
    const allow = kinds && kinds.length ? new Set(kinds) : null;
    const lines = this.lines.filter((l) => l.seq > n && (!meetingId || l.meeting_id === meetingId) && (!allow || allow.has(l.kind)))
      .map((l) => ({ seq: l.seq, ts: l.ts, meeting_id: l.meeting_id, kind: l.kind, speaker: l.speaker, text: l.text }));
    return { since: n, next: lines.length ? lines[lines.length - 1].seq : n, lines };
  }

  ndjson(meetingId) {
    return this.lines.filter((l) => l.meeting_id === meetingId && l.kind === 'speech').map((l) => JSON.stringify(publicLine(l))).join('\n');
  }

  meetings() {
    return [...new Set(this.lines.map((l) => l.meeting_id))];
  }
}

// Polls Meeting Bot's caption text while a meeting is live.
export function watchCaptions({ meetings, bot, live, intervalMs, botName, scrubText }) {
  const timers = new Map();
  // One transcript call per poll at a time: a slow page (or a stuck
  // worker's call limit) must not stack a call every interval. Keyed by
  // timer, so a restarted poll (reseat) does not wait on the old call.
  const busy = new Map();
  const gap = intervalMs > 0 ? intervalMs : 500;
  const hide = typeof scrubText === 'function' ? scrubText : (s) => s;
  async function poll(id, timer) {
    const m = meetings.get(id);
    if (!m || m.state !== 'live' || !m.session_id) return;
    const session = m.session_id;
    try {
      const text = hide(await bot.transcript(session));
      // Stopped, restarted or reseated while the call was out: drop it.
      const now = meetings.get(id);
      if (timers.get(id) !== timer || !now || now.state !== 'live' || now.session_id !== session) return;
      const names = typeof botName === 'function' ? botName() : botName;
      live.ingestCaption(id, text, names);
      // Chat rides a list of its own (Meet Bot keeps chat out of the
      // transcript), so a chat that names the bot is read here, or never.
      if (typeof bot.chat === 'function') {
        const lines = await bot.chat(session);
        const then = meetings.get(id);
        if (timers.get(id) !== timer || !then || then.state !== 'live' || then.session_id !== session) return;
        if (Array.isArray(lines)) live.ingestChat(id, lines.map((l) => ({ by: l && l.by, at: l && l.at, text: hide(String((l && l.text) || '')) })), names);
      }
    } catch (e) { /* the next poll retries */ }
  }
  function tick(id, timer) {
    if (busy.has(timer)) return busy.get(timer);
    const p = poll(id, timer).finally(() => busy.delete(timer));
    busy.set(timer, p);
    return p;
  }
  return {
    start(meeting) {
      const id = meeting.meeting_id;
      this.stop(id);
      const timer = setInterval(() => { tick(id, timer); }, gap);
      if (timer.unref) timer.unref();
      timers.set(id, timer);
      return tick(id, timer);
    },
    stop(id) {
      const timer = timers.get(id);
      if (timer) clearInterval(timer);
      timers.delete(id);
    },
    stopAll() {
      for (const id of [...timers.keys()]) this.stop(id);
    },
  };
}
