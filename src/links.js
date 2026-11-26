// GifOS room links, minted on this computer. Nothing here joins a room or
// calls a server: a link is a room name plus, for a room someone runs, the
// public verifier of that person's host key.
//
// The host key is derived the way GifOS derives it in the browser:
//   seed     = PBKDF2-SHA256(host password, "gifos-admin:" + room, 310000 rounds, 32 bytes)
//   key      = Ed25519 key pair from that seed
//   verifier = first 24 hex characters of SHA-256(raw public key)
// The link carries only the verifier (v= in the one link grammar). The password and the
// seed never leave this process and are never returned.
import crypto from 'node:crypto';

const ROOM_RE = /^[A-Za-z0-9-]{1,64}$/;
const PBKDF2_ROUNDS = 310000;
// DER header of a PKCS#8 Ed25519 private key; the 32-byte seed follows it.
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

export function newRoom() {
  // 120 random bits. The room name is what the meeting key derives from.
  const b = crypto.randomBytes(15);
  let n = BigInt('0x' + b.toString('hex'));
  let s = '';
  while (s.length < 24) { s += (n % 36n).toString(36); n /= 36n; }
  return s;
}

export function hostSeed(room, password) {
  if (!ROOM_RE.test(String(room || ''))) throw new Error('Room name is not valid.');
  if (!password) throw new Error('A host password is needed to make a host link.');
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(String(password), 'gifos-admin:' + room, PBKDF2_ROUNDS, 32, 'sha256', (e, key) => (e ? reject(e) : resolve(key)));
  });
}

export function verifierOfSeed(seed) {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const jwk = crypto.createPublicKey(priv).export({ format: 'jwk' });
  const raw = Buffer.from(jwk.x, 'base64url');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

// { verifier, seedHex }. seedHex is what a GifOS browser keeps as the host
// key for this room; only the booth (broadcast-mcp) ever needs it.
export async function hostKey(room, password) {
  const seed = await hostSeed(room, password);
  return { verifier: verifierOfSeed(seed), seedHex: seed.toString('hex') };
}

function base(gifosUrl) {
  return String(gifosUrl || '').replace(/\/+$/, '');
}

// gifos.app (and its subdomains) routes /meet and /cast; a local site serves only files.
function routed(gifosUrl) {
  try { return /(^|\.)gifos\.app$/i.test(new URL(base(gifosUrl)).hostname); } catch (e) { return false; }
}

// The one link grammar (GifOS docs/links.md): a link names only WHAT (room=, v=); the PAGE names how (/meet the
// meeting, /cast the broadcast). On gifos.app the link is the shared form, /meet#… or /cast#…, which every GifOS
// release's router reads (relay= and at= ride along); a local site has no router, so the link is the page itself:
// run.html#… (it forwards a room to its meeting page) or cast.html#….
function roomLink(gifosUrl, page, room, { relay, verifier, at } = {}) {
  const h = new URLSearchParams();
  h.set('room', room);
  if (verifier) h.set('v', verifier);
  if (at) h.set('at', String(at));
  if (relay) h.set('relay', relay);
  const file = routed(gifosUrl) || !relay ? '/' + page : (page === 'cast' ? '/cast.html' : '/run.html');
  return base(gifosUrl) + file + '#' + h.toString();
}

// A meeting link. verifier makes it a room the host runs (admin room).
// /meet#room=<room>[&v=<verifier>]: the room rides in the fragment, which a
// browser never sends, so no server or log reads which meeting it is. (GifOS
// 0.9.26 has no town hall: the meeting types are open, admin and join.)
export function meetingLink(gifosUrl, room, { relay, verifier } = {}) {
  return roomLink(gifosUrl, 'meet', room, { relay, verifier });
}

// The host part of a link the bot may join: the configured GIFOS_URL, any
// gifos.app host, or this computer (a local GifOS). Anything else is refused
// at once instead of loading a stranger's page and waiting for a meeting.
export function gifosHostAllowed(link, gifosUrl) {
  let u;
  try { u = new URL(String(link)); } catch (e) { return false; }
  let own = '';
  try { own = new URL(String(gifosUrl || '')).origin; } catch (e) { own = ''; }
  if (own && u.origin === own) return true;
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase();
  if (u.protocol === 'https:' && (h === 'gifos.app' || h.endsWith('.gifos.app'))) return true;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

// A broadcast link. The same link is the host's and the viewers': the host
// is whoever holds the host password. at = start (unix seconds).
// /cast#room=<room>&v=<verifier>[&at=<start>] (cast.html#… on a local site with a relay): the broadcast PAGE is the
// broadcast; no key says so. (GifOS 0.9.26 dropped the Visit link and Stream to friends.)
export function broadcastLink(gifosUrl, room, { relay, verifier, startAt } = {}) {
  if (!verifier) throw new Error('A broadcast needs a host key.');
  return roomLink(gifosUrl, 'cast', room, { relay, verifier, at: startAt ? Math.floor(Number(startAt) / 1000) : '' });
}

// The fields a meeting link names, whatever its form: the fragment link
// (/meet|cast#room=<room>[&v=<verifier>]), the path link shared before
// (/meet|cast/<room>[/<verifier>]), or the page's own hash
// (run.html|meet.html|cast.html#room=<room>[&v=<verifier>]). null when it names no room; the
// old run.html#v=<room>&av=<verifier>&bc=1 form is not read, and no key (cast=1) makes a broadcast: the page does.
function linkFields(link) {
  let u;
  try { u = new URL(String(link)); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = new URLSearchParams(u.hash.replace(/^#/, ''));
  const kind = /^\/(meet|cast)(?:\/|$)/i.exec(u.pathname);
  const path = /^\/(?:meet|cast)\/([A-Za-z0-9-]{1,64})(?:\/([a-fA-F0-9]{16,64}))?\/?$/.exec(u.pathname);
  let room = '', verifier = '', cast = !!kind && kind[1].toLowerCase() === 'cast';
  if (path) { room = path[1]; verifier = path[2] || ''; }
  else if (h.get('room')) { room = h.get('room'); verifier = h.get('v') || ''; if (!kind) cast = /\/cast\.html$/i.test(u.pathname); }
  if (!ROOM_RE.test(room)) return null;
  if (verifier && !/^[a-fA-F0-9]{16,64}$/.test(verifier)) verifier = '';
  return { room, verifier: verifier.toLowerCase(), cast };
}

// A broadcast link in any form: /cast#room=<room>&v=<verifier>, the older
// /cast/<room>/<verifier>, or the broadcast page's own address (cast.html#room=…).
export function isBroadcastLink(link) {
  const f = linkFields(link);
  return !!(f && f.cast && f.verifier);
}

// The verifier (host key check) in a link, in any form (see linkFields).
export function verifierFromLink(link) {
  const f = linkFields(link);
  return f ? f.verifier : '';
}

// The room in a link, in any form GifOS hands out or handed out before (see linkFields).
export function roomFromLink(link) {
  const f = linkFields(link);
  return f ? f.room : '';
}

export function linkParams(link) {
  try { return new URLSearchParams(new URL(String(link)).hash.replace(/^#/, '')); } catch (e) { return new URLSearchParams(); }
}

// A Visit link must be a plain https URL.
export function cleanVisit(url) {
  if (!url) return '';
  let u;
  try { u = new URL(String(url)); } catch (e) { throw new Error('visit_url is not a URL.'); }
  if (u.protocol !== 'https:') throw new Error('visit_url must start with https://');
  return u.toString();
}
