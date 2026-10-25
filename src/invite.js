// Invites carry a plain meeting link. A room password, when there is one,
// is a separate line the guest types. It is never placed inside the link.
// Paid one-click links that would log a guest in with the password already
// applied are not part of this release.
//
// This module only builds the words and fields of an invite. It never sends
// anything and never writes a calendar file: the assistant that called the
// tool sends the invite through its own mail or calendar.
import { assertZone, utcFromZoned, localStamp } from './schedule.js';

export const PASSWORD_LINK_NOTE = 'Paid one-click links that sign a guest in with the room password are not available. Send the plain link, and ask the guest to type the password.';

const PASSWORD_KEYS = ['password', 'pw', 'p', 'room_password', 'pass'];

export function plainLink(link, roomPassword) {
  let u;
  try { u = new URL(String(link)); } catch (e) { throw new Error('Meeting link is not a URL.'); }
  for (const k of PASSWORD_KEYS) u.searchParams.delete(k);
  const h = new URLSearchParams(u.hash.replace(/^#/, ''));
  for (const k of PASSWORD_KEYS) h.delete(k);
  const hs = h.toString();
  u.hash = hs || '';
  const out = u.toString();
  const secret = String(roomPassword || '');
  if (secret && (out.includes(secret) || out.includes(encodeURIComponent(secret)))) {
    throw new Error('The meeting link must not contain the room password. Send the plain link, and type the password separately.');
  }
  return out;
}

export function urlsOf(text) {
  return String(text || '').match(/https?:\/\/[^\s<>)"]+/g) || [];
}

export function formatInvite({ topic, link, roomPassword, startTime }) {
  const url = plainLink(link, roomPassword);
  const lines = [];
  lines.push(topic ? String(topic) : 'GifOS meeting');
  if (startTime) lines.push('When: ' + String(startTime));
  lines.push('');
  lines.push('Join: ' + url);
  lines.push('');
  if (roomPassword) {
    lines.push('Room password (type this yourself; it is not part of the link):');
    lines.push(String(roomPassword));
  } else {
    lines.push('This meeting has no room password.');
  }
  lines.push('');
  lines.push(PASSWORD_LINK_NOTE);
  const email = lines.join('\n');
  return {
    link: url,
    email,
    calendar: {
      summary: topic ? String(topic) : 'GifOS meeting',
      description: email,
      url,
      location: url,
    },
  };
}

// A time from a caller: an ISO time with an offset or Z, or a local wall
// time ("2026-10-20T17:00") read in timeZone. Returns epoch ms.
export function parseWhen(text, timeZone) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/(Z|[+-]\d\d:?\d\d)$/i.test(s)) {
    const p = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?)?/.exec(s);
    if (p) realParts(s, +p[1], +p[2], +p[3], +(p[4] || 0), +(p[5] || 0), +(p[6] || 0));
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) throw new Error('Not a time: ' + JSON.stringify(s));
    return ms;
  }
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d))?)?$/.exec(s);
  if (!m) throw new Error('Not a time: ' + JSON.stringify(s) + '. Use ISO, for example 2026-10-20T17:00 with a timezone.');
  realParts(s, +m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return utcFromZoned(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), assertZone(timeZone || 'UTC'));
}

// 2026-13-45T99:00 is not a time. Without this check it rolls over into a
// date months later.
function realParts(s, y, mo, d, hh, mm, ss) {
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > days || hh > 23 || mm > 59 || ss > 59) {
    throw new Error('Not a time: ' + JSON.stringify(s) + ' (no such date or time of day).');
  }
}

// A start this long ago is a typo or an old date, not a meeting now.
export const PAST_GRACE_MS = 15 * 60 * 1000;

// create_meeting and create_broadcast refuse a start that has already
// passed (more than PAST_GRACE_MS ago). The invite carries start.iso.
export function assertNotPast(invite, now = Date.now()) {
  const iso = invite && invite.start && invite.start.iso;
  if (!iso) return;
  if (Date.parse(iso) < now - PAST_GRACE_MS) {
    throw new Error('start ' + invite.start.local + ' (' + invite.start.timezone + ') is in the past. Give a future time, or leave start out for a meeting now.');
  }
}

function when(ms, timeZone) {
  if (ms == null) return null;
  const zone = timeZone || 'UTC';
  return { iso: new Date(ms).toISOString(), timezone: zone, local: localStamp(new Date(ms).toISOString(), zone) };
}

const DEFAULT_LENGTH_MS = 60 * 60 * 1000;

// Everything an invite needs, as fields and as ready-to-send text, for a
// meeting. The admin (host) password is never an input here.
export function meetingInvite({ title, link, start, end, timezone, description, roomPassword, hostName, townHall }) {
  const zone = assertZone(timezone || 'UTC');
  const startMs = parseWhen(start, zone);
  let endMs = parseWhen(end, zone);
  if (startMs != null && endMs == null) endMs = startMs + DEFAULT_LENGTH_MS;
  if (startMs != null && endMs != null && endMs <= startMs) throw new Error('end must be after start.');
  const url = plainLink(link, roomPassword);
  const name = String(title || (townHall ? 'GifOS town hall' : 'GifOS meeting'));
  const admit = roomPassword
    ? { how: 'password', note: 'Guests open the link and type the room password. It is not part of the link.', room_password: String(roomPassword) }
    : { how: 'link', note: 'Anyone with the link can join. Share it only with the people you invite.' };
  const roles = {
    host: (hostName ? hostName + ' runs' : 'The host runs') + ' the room with their own host password, which is never sent in an invite.',
    guests: townHall ? 'Guests watch and listen; the host brings people up to speak.' : 'Guests join muted with the camera off and turn them on when they want.',
    notes: 'The meeting is written down while people speak; every screen shows 📝 Transcribing.',
  };
  const text = [
    name,
    startMs != null ? 'When: ' + when(startMs, zone).local + ' – ' + when(endMs, zone).local.slice(11) + ' (' + zone + ')' : '',
    description ? '\n' + String(description) : '',
    '',
    'Join: ' + url,
    '',
    roomPassword ? 'Room password (type it yourself; it is not part of the link): ' + roomPassword : 'No room password: anyone with the link can join.',
    roles.notes,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n').trim();
  return {
    kind: townHall ? 'town_hall' : 'meeting',
    title: name,
    start: when(startMs, zone),
    end: when(endMs, zone),
    timezone: zone,
    join_url: url,
    description: description ? String(description) : '',
    admit,
    roles,
    text,
    calendar: { summary: name, description: text, location: url, url },
  };
}

// The same for a broadcast: viewers watch the link, the host goes live
// from it with the host password.
export function broadcastInvite({ title, link, start, end, timezone, description, visit, stream, hostName }) {
  const zone = assertZone(timezone || 'UTC');
  const startMs = parseWhen(start, zone);
  let endMs = parseWhen(end, zone);
  if (startMs != null && endMs == null) endMs = startMs + DEFAULT_LENGTH_MS;
  if (startMs != null && endMs != null && endMs <= startMs) throw new Error('end must be after start.');
  const noun = stream ? 'stream' : 'service';
  const name = String(title || (stream ? 'GifOS stream' : 'GifOS broadcast'));
  const roles = {
    host: (hostName ? hostName + ' goes' : 'The host goes') + ' live from the same link with the host password, which is never sent in an invite.',
    viewers: 'Viewers open the link to watch. Nobody needs an account, and a viewer\'s camera and microphone stay off. A viewer can raise a hand; the host can bring them on stage.',
    early: startMs != null ? 'Anyone who opens the link early sees when the ' + noun + ' starts, a countdown, and Add to calendar.' : '',
    after: 'Anyone who opens the link after it ends sees "The stage is clear."',
    notes: 'The ' + noun + ' is written down while people speak; every screen shows 📝 Transcribing.',
  };
  const text = [
    name,
    startMs != null ? 'Starts: ' + when(startMs, zone).local + ' (' + zone + ')' : '',
    description ? '\n' + String(description) : '',
    '',
    'Watch: ' + link,
    visit ? 'Visit: ' + visit : '',
    '',
    'No account or password needed to watch.',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n').trim();
  return {
    kind: stream ? 'stream' : 'broadcast',
    title: name,
    start: when(startMs, zone),
    end: when(endMs, zone),
    timezone: zone,
    watch_url: link,
    visit_url: visit || '',
    description: description ? String(description) : '',
    admit: { how: 'link', note: 'Anyone with the link can watch. Only the host password can go live.' },
    roles,
    text,
    calendar: { summary: name, description: text, location: link, url: link },
  };
}
