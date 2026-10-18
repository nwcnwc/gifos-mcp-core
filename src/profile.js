// How the bot looks to people in a room: its name and its picture. Both are
// the operator's choice (GIFOS_BOT_NAME, GIFOS_BOT_PICTURE, or the
// set_bot_profile tool) and are kept in GIFOS_MCP_HOME.
//
// The name is public: everyone in a room sees it. The secret half of the
// bot's credential is its password, which stays in bot.json (mode 0600)
// when the name changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writePrivate, readPrivate } from './private-file.js';

// GifOS keeps a person's picture beside their name (gifos_avatar): GIF, PNG,
// JPEG or WebP, at most 256 KB.
export const PICTURE_MAX = 256 * 1024;
const MAGIC = [
  ['image/gif', (b) => b.slice(0, 6).toString('ascii') === 'GIF87a' || b.slice(0, 6).toString('ascii') === 'GIF89a'],
  ['image/png', (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP'],
];

// The picture record GifOS stores: { mime, hash, b64 }.
export function pictureFromBytes(bytes) {
  const b = Buffer.from(bytes);
  if (!b.length) throw new Error('The picture file is empty.');
  if (b.length > PICTURE_MAX) throw new Error('The picture is ' + Math.ceil(b.length / 1024) + ' KB; at most 256 KB.');
  const hit = MAGIC.find(([, test]) => test(b));
  if (!hit) throw new Error('The picture must be a GIF, PNG, JPEG or WebP image.');
  return { mime: hit[0], hash: crypto.createHash('sha256').update(b).digest('hex'), b64: b.toString('base64') };
}

export function pictureFromFile(file) {
  const p = path.resolve(String(file || ''));
  let bytes;
  try { bytes = fs.readFileSync(p); } catch (e) { throw new Error('Cannot read the picture at ' + p + '.'); }
  return pictureFromBytes(bytes);
}

const PICTURE_FILE = 'bot-picture.json';

export function savedPicture(home) {
  const rec = readPrivate(path.join(home, PICTURE_FILE), 'the bot has no picture', (x) => x && x.b64 && x.mime && /^[0-9a-f]{64}$/.test(x.hash || ''));
  return rec || null;
}

export function savePicture(home, rec) {
  const file = path.join(home, PICTURE_FILE);
  if (!rec) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  writePrivate(file, JSON.stringify(rec) + '\n');
}

// The name kept with the password in bot.json.
export function saveName(home, name, password) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  writePrivate(path.join(home, 'bot.json'), JSON.stringify({ name, password }, null, 2) + '\n');
}

// The picture to show: GIFOS_BOT_PICTURE wins over the saved one.
export function botPicture(cfg) {
  if (cfg.botPicture) return pictureFromFile(cfg.botPicture);
  return cfg.home ? savedPicture(cfg.home) : null;
}
