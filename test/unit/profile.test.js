// The operator chooses how the bot looks: a name (GIFOS_BOT_NAME alone keeps
// the stored password) and a picture (GIFOS_BOT_PICTURE, or set_bot_profile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { loadConfig, botCredentials } from '../../src/config.js';
import { pictureFromBytes, pictureFromFile, botPicture, savePicture, savedPicture, PICTURE_MAX } from '../../src/profile.js';
import { tmpHome } from './fixtures/tmp-home.js';

// A real 2x2 PNG.
export function tinyPng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 0]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('GIFOS_BOT_NAME alone sets the name and keeps the stored password', () => {
  const home = tmpHome('gifos-mcp-profile-');
  const first = botCredentials(loadConfig({ GIFOS_MCP_HOME: home }));
  const named = botCredentials(loadConfig({ GIFOS_MCP_HOME: home, GIFOS_BOT_NAME: 'Ada’s notes' }));
  assert.equal(named.name, 'Ada’s notes');
  assert.equal(named.password, first.password, 'the secret half does not change with the name');
  const fresh = botCredentials(loadConfig({ GIFOS_MCP_HOME: tmpHome('gifos-mcp-profile-'), GIFOS_BOT_NAME: 'Harbor notes' }));
  assert.equal(fresh.name, 'Harbor notes');
  assert.ok(fresh.password.length >= 20, 'a strong password is made when none is stored');
  assert.throws(() => botCredentials(loadConfig({ GIFOS_MCP_HOME: home, GIFOS_BOT_NAME: 'ab' })), /GIFOS_BOT_NAME: Bot name needs at least 3 characters/);
  const both = botCredentials(loadConfig({ GIFOS_MCP_HOME: home, GIFOS_BOT_NAME: 'harbor-maple', GIFOS_BOT_PASSWORD: 'quiet-cedar-42' }));
  assert.equal(both.password, 'quiet-cedar-42');
});

test('a picture is a GIF, PNG, JPEG or WebP of at most 256 KB, stored as GifOS stores a person’s', () => {
  const png = tinyPng();
  const rec = pictureFromBytes(png);
  assert.equal(rec.mime, 'image/png');
  assert.match(rec.hash, /^[0-9a-f]{64}$/);
  assert.equal(Buffer.from(rec.b64, 'base64').equals(png), true);
  assert.equal(pictureFromBytes(Buffer.from('GIF89a......')).mime, 'image/gif');
  assert.equal(pictureFromBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])).mime, 'image/jpeg');
  assert.throws(() => pictureFromBytes(Buffer.from('<svg/>')), /GIF, PNG, JPEG or WebP/);
  assert.throws(() => pictureFromBytes(Buffer.concat([png, Buffer.alloc(PICTURE_MAX)])), /at most 256 KB/);
  assert.throws(() => pictureFromFile('/no/such/file.png'), /Cannot read the picture/);
  const home = tmpHome('gifos-mcp-profile-');
  const f = path.join(home, 'me.png'); fs.writeFileSync(f, png);
  assert.equal(botPicture(loadConfig({ GIFOS_MCP_HOME: home, GIFOS_BOT_PICTURE: f })).hash, rec.hash);
  assert.equal(botPicture(loadConfig({ GIFOS_MCP_HOME: home })), null);
  savePicture(home, rec);
  assert.equal(savedPicture(home).hash, rec.hash);
  assert.equal(botPicture(loadConfig({ GIFOS_MCP_HOME: home })).hash, rec.hash);
  savePicture(home, null);
  assert.equal(savedPicture(home), null);
});
