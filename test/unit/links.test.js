// Room links are minted on this computer. A host link carries only the
// verifier of the host key; the host password and the seed stay here. The
// vectors below were checked against GifOS's own derivation in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostKey, meetingLink, broadcastLink, roomFromLink, linkParams, cleanVisit, newRoom } from '../../src/links.js';

test('the host key is derived the way GifOS derives it', async () => {
  const a = await hostKey('abc123room', 'admin-pass-1');
  assert.equal(a.verifier, '3783bb03122c41d92d295bab');
  assert.match(a.seedHex, /^[0-9a-f]{64}$/);
  const b = await hostKey('zz9-test', 'Ünïcode påss 🙂');
  assert.equal(b.verifier, 'c6707b849eea62c5eeb9e525');
  await assert.rejects(() => hostKey('bad room!', 'x'), /Room name/);
  await assert.rejects(() => hostKey('abc', ''), /host password/);
});

test('links carry the room, the verifier and the options, never a password', async () => {
  const room = newRoom();
  const k = await hostKey(room, 'admin-pass-1');
  const m = meetingLink('https://gifos.app/', room, { verifier: k.verifier, relay: 'wss://relay.example.test' });
  assert.equal(roomFromLink(m), room);
  assert.equal(linkParams(m).get('av'), k.verifier);
  assert.equal(linkParams(m).get('relay'), 'wss://relay.example.test');
  assert.equal(m.includes('admin-pass-1'), false);
  assert.equal(m.includes(k.seedHex), false);
  assert.equal(linkParams(meetingLink('https://gifos.app', room, { townHall: true })).get('th'), '1');
  assert.equal(linkParams(meetingLink('https://gifos.app', room)).get('av'), null);
  const at = Date.parse('2026-10-25T15:00:00Z');
  const b = broadcastLink('https://gifos.app', room, { verifier: k.verifier, startAt: at, visit: 'https://example.org/give', stream: true });
  const p = linkParams(b);
  assert.equal(p.get('bc'), '1');
  assert.equal(p.get('st'), '1');
  assert.equal(p.get('at'), String(at / 1000));
  assert.equal(p.get('visit'), 'https://example.org/give');
  assert.throws(() => broadcastLink('https://gifos.app', room, {}), /host key/);
});

test('a Visit link must be https', () => {
  assert.equal(cleanVisit('https://example.org/give'), 'https://example.org/give');
  assert.equal(cleanVisit(''), '');
  assert.throws(() => cleanVisit('http://example.org'), /https/);
  assert.throws(() => cleanVisit('javascript:alert(1)'), /https/);
  assert.throws(() => cleanVisit('not a url'), /not a URL/);
});
