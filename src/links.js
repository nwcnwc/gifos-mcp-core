// GifOS room links, minted on this computer. Nothing here joins a room or
// calls a server: a link is a room name plus, for a room someone runs, the
// public verifier of that person's host key.
//
// The host key is derived the way GifOS derives it in the browser:
//   seed     = PBKDF2-SHA256(host password, "gifos-admin:" + room, 310000 rounds, 32 bytes)
//   key      = Ed25519 key pair from that seed
//   verifier = first 24 hex characters of SHA-256(raw public key)
// The link carries only the verifier (a /meet/<room>/<verifier> segment, or
// av= when town hall or relay needs the hash form). The password and the
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

// A meeting link. verifier makes it a room the host runs (admin room).
// 404.html routes /meet/<room> and /meet/<room>/<verifier> to
// run.html#v=<room>[&av=<verifier>]. The hash form stays only when the link
// needs relay=, which that path does not carry. (GifOS 0.9.26 has no town
// hall: the meeting types are open, admin and join.)
export function meetingLink(gifosUrl, room, { relay, verifier } = {}) {
  if (!relay) {
    return base(gifosUrl) + '/meet/' + room + (verifier ? '/' + verifier : '');
  }
  const h = new URLSearchParams();
  h.set('v', room);
  if (verifier) h.set('av', verifier);
  h.set('relay', relay);
  return base(gifosUrl) + '/run.html#' + h.toString();
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
// is whoever holds the host password. at = start (unix seconds). /cast/<room>/<verifier>
// when nothing else rides along; the hash form for a start time or relay.
// (GifOS 0.9.26 dropped the Visit link and Stream to friends.)
export function broadcastLink(gifosUrl, room, { relay, verifier, startAt } = {}) {
  if (!verifier) throw new Error('A broadcast needs a host key.');
  if (!startAt && !relay) return base(gifosUrl) + '/cast/' + room + '/' + verifier;
  const h = new URLSearchParams();
  h.set('v', room);
  h.set('av', verifier);
  h.set('bc', '1');
  if (startAt) h.set('at', String(Math.floor(Number(startAt) / 1000)));
  if (relay) h.set('relay', relay);
  return base(gifosUrl) + '/run.html#' + h.toString();
}

// A broadcast link in either form: /cast/<room>/<verifier>, or a hash with bc.
export function isBroadcastLink(link) {
  let u;
  try { u = new URL(String(link)); } catch (e) { return false; }
  if (/^\/cast\/[A-Za-z0-9-]{1,64}\/[a-fA-F0-9]{16,64}\/?$/.test(u.pathname)) return true;
  const h = new URLSearchParams(u.hash.replace(/^#/, ''));
  return !!h.get('bc') && !!h.get('v');
}

// The verifier (host key check) in a link: /meet|cast/<room>/<verifier> or av=.
export function verifierFromLink(link) {
  let u;
  try { u = new URL(String(link)); } catch (e) { return ''; }
  const pretty = /^\/(?:meet|cast)\/[A-Za-z0-9-]{1,64}\/([a-fA-F0-9]{16,64})\/?$/.exec(u.pathname);
  if (pretty) return pretty[1].toLowerCase();
  return (new URLSearchParams(u.hash.replace(/^#/, '')).get('av') || '').toLowerCase();
}

// Accepts the links GifOS hands out: /run.html#v=<room>[&...], /meet/<room>,
// and /meet/<room>/<verifier> (404.html maps that to #v=<room>&av=<verifier>).
export function roomFromLink(link) {
  let u;
  try { u = new URL(String(link)); } catch (e) { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  const pretty = /^\/(?:meet|cast)\/([A-Za-z0-9-]{1,64})(?:\/([a-fA-F0-9]{16,64}))?\/?$/.exec(u.pathname);
  if (pretty) return pretty[1];
  const h = new URLSearchParams(u.hash.replace(/^#/, ''));
  const v = h.get('v') || '';
  return ROOM_RE.test(v) ? v : '';
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
