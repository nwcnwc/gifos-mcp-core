// GifOS room links, minted on this computer. Nothing here joins a room or
// calls a server: a link is a room name plus, for a room someone runs, the
// public verifier of that person's host key.
//
// The host key is derived the way GifOS derives it in the browser:
//   seed     = PBKDF2-SHA256(host password, "gifos-admin:" + room, 310000 rounds, 32 bytes)
//   key      = Ed25519 key pair from that seed
//   verifier = first 24 hex characters of SHA-256(raw public key)
// The link carries only the verifier (av=). The password and the seed never
// leave this process and are never returned.
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
export function meetingLink(gifosUrl, room, { relay, verifier, townHall } = {}) {
  const h = new URLSearchParams();
  h.set('v', room);
  if (verifier) h.set('av', verifier);
  if (townHall) h.set('th', '1');
  if (relay) h.set('relay', relay);
  return base(gifosUrl) + '/run.html#' + h.toString();
}

// A broadcast link. The same link is the host's and the viewers': the host
// is whoever holds the host password. at = start (unix seconds), visit = a
// https link painted on the picture. stream = "Stream to friends".
export function broadcastLink(gifosUrl, room, { relay, verifier, startAt, visit, stream } = {}) {
  if (!verifier) throw new Error('A broadcast needs a host key.');
  const h = new URLSearchParams();
  h.set('v', room);
  h.set('av', verifier);
  h.set('bc', '1');
  if (stream) h.set('st', '1');
  if (startAt) h.set('at', String(Math.floor(Number(startAt) / 1000)));
  if (visit) h.set('visit', visit);
  if (relay) h.set('relay', relay);
  return base(gifosUrl) + '/run.html#' + h.toString();
}

// Accepts the links GifOS hands out: /run.html#v=<room>[&...] and /meet/<room>.
export function roomFromLink(link) {
  let u;
  try { u = new URL(String(link)); } catch (e) { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  const pretty = /^\/(?:meet|cast)\/([A-Za-z0-9-]{1,64})\/?$/.exec(u.pathname);
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
