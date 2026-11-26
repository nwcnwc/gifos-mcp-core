// Room links are minted on this computer. A host link carries only the
// verifier of the host key; the host password and the seed stay here. The
// vectors below were checked against GifOS's own derivation in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostKey, meetingLink, broadcastLink, roomFromLink, linkParams, cleanVisit, newRoom, isBroadcastLink, verifierFromLink } from '../../src/links.js';

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
  const admin = meetingLink('https://gifos.app/', room, { verifier: k.verifier });
  assert.equal(admin, 'https://gifos.app/meet#room=' + room + '&v=' + k.verifier);
  assert.equal(roomFromLink(admin), room);
  assert.equal(verifierFromLink(admin), k.verifier);
  assert.equal(admin.includes('admin-pass-1'), false);
  assert.equal(admin.includes(k.seedHex), false);
  // On gifos.app a relay rides on the shared form (every release's router carries it); a local site gets the page.
  const m = meetingLink('https://gifos.app/', room, { verifier: k.verifier, relay: 'wss://relay.example.test' });
  assert.match(m, /^https:\/\/gifos\.app\/meet#/);
  assert.match(meetingLink('http://127.0.0.1:8099', room, { relay: 'ws://127.0.0.1:1' }), /^http:\/\/127\.0\.0\.1:8099\/run\.html#room=/);
  assert.equal(roomFromLink(m), room);
  assert.equal(linkParams(m).get('room'), room);
  assert.equal(linkParams(m).get('v'), k.verifier);
  assert.equal(linkParams(m).get('av'), null);
  assert.equal(linkParams(m).get('relay'), 'wss://relay.example.test');
  assert.equal(m.includes('admin-pass-1'), false);
  assert.equal(m.includes(k.seedHex), false);
  // GifOS 0.9.26 has no town hall: an old townHall option changes nothing.
  assert.equal(meetingLink('https://gifos.app', room, { verifier: k.verifier, townHall: true }), admin);
  assert.equal(linkParams(meetingLink('https://gifos.app', room)).get('room'), room);
  assert.equal(linkParams(meetingLink('https://gifos.app', room)).get('v'), null);
  const at = Date.parse('2026-10-25T15:00:00Z');
  const b = broadcastLink('https://gifos.app', room, { verifier: k.verifier, startAt: at, visit: 'https://example.org/give', stream: true });
  assert.equal(b, 'https://gifos.app/cast#room=' + room + '&v=' + k.verifier + '&at=' + (at / 1000));
  const p = linkParams(b);
  assert.equal(p.get('room'), room);
  assert.equal(p.get('v'), k.verifier);
  assert.equal(p.get('at'), String(at / 1000));
  assert.equal(p.get('cast'), null);
  assert.equal(p.get('st'), null, 'no Stream to friends in 0.9.26');
  assert.equal(p.get('visit'), null, 'no Visit link in 0.9.26');
  assert.equal(isBroadcastLink(b), true);
  const cast = broadcastLink('https://gifos.app', room, { verifier: k.verifier });
  assert.equal(cast, 'https://gifos.app/cast#room=' + room + '&v=' + k.verifier);
  assert.equal(isBroadcastLink(cast), true);
  assert.equal(roomFromLink(cast), room);
  assert.equal(verifierFromLink(cast), k.verifier);
  assert.equal(verifierFromLink(b), k.verifier);
  assert.equal(isBroadcastLink(admin), false);
  assert.equal(isBroadcastLink('https://gifos.app/cast/' + room), false);
  assert.throws(() => broadcastLink('https://gifos.app', room, {}), /host key/);
  // A broadcast is its page, never a key: /cast#… on gifos.app (a relay rides along), cast.html#… on a local site.
  const relayCast = broadcastLink('https://gifos.app', room, { verifier: k.verifier, relay: 'wss://relay.example.test', startAt: at });
  assert.match(relayCast, /^https:\/\/gifos\.app\/cast#/);
  assert.equal(linkParams(relayCast).get('cast'), null);
  assert.equal(isBroadcastLink(relayCast), true);
  const localCast = broadcastLink('http://127.0.0.1:8099', room, { verifier: k.verifier, relay: 'ws://127.0.0.1:1' });
  assert.match(localCast, /^http:\/\/127\.0\.0\.1:8099\/cast\.html#room=/);
  assert.equal(linkParams(localCast).get('cast'), null);
  assert.equal(isBroadcastLink(localCast), true);
  assert.equal(linkParams(relayCast).get('room'), room);
  assert.equal(linkParams(relayCast).get('v'), k.verifier);
  assert.equal(linkParams(relayCast).get('av'), null);
  assert.equal(linkParams(relayCast).get('bc'), null);
  assert.equal(roomFromLink(relayCast), room);
});

test('every link builder emits the one grammar', () => {
  const room = 'abc123';
  const v = 'a'.repeat(24);
  const at = Date.parse('2026-10-25T15:00:00Z');
  const built = [
    [meetingLink('https://gifos.app', room), '/meet'],
    [meetingLink('https://gifos.app/', room, { verifier: v }), '/meet'],
    [broadcastLink('https://gifos.app', room, { verifier: v }), '/cast'],
    [broadcastLink('https://gifos.app', room, { verifier: v, startAt: at }), '/cast'],
    [meetingLink('https://gifos.app', room, { relay: 'ws://127.0.0.1:1' }), '/meet'],
    [meetingLink('https://gifos.app', room, { verifier: v, relay: 'ws://127.0.0.1:1' }), '/meet'],
    [broadcastLink('https://gifos.app', room, { verifier: v, relay: 'ws://127.0.0.1:1', startAt: at }), '/cast'],
    [meetingLink('http://127.0.0.1:8099', room, { verifier: v, relay: 'ws://127.0.0.1:1' }), '/run.html'],
    [broadcastLink('http://127.0.0.1:8099', room, { verifier: v, relay: 'ws://127.0.0.1:1' }), '/cast.html'],
  ];
  for (const [url, path] of built) {
    const u = new URL(url);
    assert.equal(u.pathname, path);
    assert.equal(u.pathname.includes(room), false);
    const h = new URLSearchParams(u.hash.replace(/^#/, ''));
    assert.equal(h.get('room'), room);
    for (const old of ['av', 'bc', 's', 'j', 'k', 'cast']) assert.equal(h.has(old), false, old);
    if (h.has('v')) assert.equal(h.get('v'), v);
  }
});

test('old path forms and the fragment form both name the room', () => {
  const R = 'Room42';
  const V = '3783bb03122c41d92d295bab';
  const rows = [
    ['https://gifos.app/meet/' + R, R, '', false],
    ['https://gifos.app/meet/' + R + '/', R, '', false],
    ['https://gifos.app/meet/' + R + '/' + V, R, V, false],
    ['https://gifos.app/meet/' + R + '/' + V + '/', R, V, false],
    ['https://gifos.app/cast/' + R + '/' + V, R, V, true],
    ['https://gifos.app/meet#room=' + R, R, '', false],
    ['https://gifos.app/meet#room=' + R + '&v=' + V, R, V, false],
    ['https://gifos.app/cast#room=' + R + '&v=' + V + '&at=1', R, V, true],
    ['https://gifos.app/run.html#room=' + R + '&v=' + V + '&cast=1', R, V, false],   // no key makes a broadcast: the page does
    ['https://gifos.app/run.html#room=' + R + '&v=' + V, R, V, false],
    ['https://gifos.app/versions/0.9.28/cast.html#room=' + R + '&v=' + V, R, V, true],
  ];
  for (const [link, room, ver, cast] of rows) {
    assert.equal(roomFromLink(link), room, link);
    assert.equal(verifierFromLink(link), ver, link);
    assert.equal(isBroadcastLink(link), cast, link);
  }
  assert.equal(isBroadcastLink('https://gifos.app/cast/' + R), false);
  // The old page-entry form and a v= without room= name no room.
  for (const old of ['https://gifos.app/run.html#v=' + R + '&av=' + V + '&bc=1', 'https://gifos.app/run.html#v=' + V, 'https://gifos.app/meet#v=' + V]) {
    assert.equal(roomFromLink(old), '', old);
    assert.equal(isBroadcastLink(old), false, old);
  }
});

test('a Visit link must be https', () => {
  assert.equal(cleanVisit('https://example.org/give'), 'https://example.org/give');
  assert.equal(cleanVisit(''), '');
  assert.throws(() => cleanVisit('http://example.org'), /https/);
  assert.throws(() => cleanVisit('javascript:alert(1)'), /https/);
  assert.throws(() => cleanVisit('not a url'), /not a URL/);
});
