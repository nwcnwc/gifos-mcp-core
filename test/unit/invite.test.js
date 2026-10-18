// Invite details: the room password is listed for the guest to type and is
// never inside a link. The host password is never an input. Nothing here
// sends anything or writes a calendar file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatInvite, plainLink, urlsOf, PASSWORD_LINK_NOTE, meetingInvite, broadcastInvite, parseWhen } from '../../src/invite.js';

const ADMIN = 'HarborNorth77';
const ROOM = 'guest-ticket-9';

function urlsContain(text, secret) {
  return urlsOf(text).some((u) => u.includes(secret));
}

test('an invite lists the room password beside a plain link', () => {
  const link = 'https://gifos.app/run.html#v=demoroom123&password=' + ROOM + '&pw=' + ROOM;
  const invite = formatInvite({ topic: 'Demo', link, roomPassword: ROOM, startTime: '17:00' });
  assert.equal(urlsContain(invite.email, ROOM), false);
  assert.equal(urlsContain(JSON.stringify(invite.calendar), ROOM), false);
  assert.match(invite.email, new RegExp(ROOM));
  assert.match(invite.calendar.description, new RegExp(ROOM));
  assert.equal(invite.calendar.url.includes(ROOM), false);
  assert.equal(invite.link.includes('password='), false);
  assert.match(invite.email, /type this yourself/);
  assert.match(invite.email, /Paid one-click links/);
  assert.equal(invite.email.includes(ADMIN), false);
  assert.equal(JSON.stringify(invite).includes(ADMIN), false);
  assert.equal(PASSWORD_LINK_NOTE.includes('http'), false);
});

test('a link that is the password itself is refused', () => {
  assert.throws(() => plainLink('https://gifos.app/run.html#v=' + ROOM, ROOM), /must not contain the room password/);
});

test('a local time is read in its time zone; an ISO time with an offset is as written', () => {
  assert.equal(new Date(parseWhen('2026-10-20T17:00', 'America/Los_Angeles')).toISOString(), '2026-10-21T00:00:00.000Z');
  assert.equal(new Date(parseWhen('2026-03-08T03:30', 'America/New_York')).toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(new Date(parseWhen('2026-10-20T17:00:00-04:00', 'Asia/Tokyo')).toISOString(), '2026-10-20T21:00:00.000Z');
  assert.equal(parseWhen('', 'UTC'), null);
  assert.throws(() => parseWhen('next tuesday', 'UTC'), /Not a time/);
  assert.throws(() => parseWhen('2026-10-20T17:00', 'Mars/Olympus'), /Unknown time zone/);
});

test('a meeting invite has every detail an invite needs, as fields and as text', () => {
  const link = 'https://gifos.app/run.html#v=demoroom123&av=3783bb03122c41d92d295bab';
  const inv = meetingInvite({ title: 'Budget review', link, start: '2026-10-20T17:00', end: '2026-10-20T18:30', timezone: 'America/Los_Angeles', description: 'Q4 numbers.', roomPassword: ROOM, hostName: 'Ada' });
  assert.equal(inv.kind, 'meeting');
  assert.equal(inv.title, 'Budget review');
  assert.deepEqual(inv.start, { iso: '2026-10-21T00:00:00.000Z', timezone: 'America/Los_Angeles', local: '2026-10-20 17:00' });
  assert.equal(inv.end.local, '2026-10-20 18:30');
  assert.equal(inv.join_url, link);
  assert.equal(inv.description, 'Q4 numbers.');
  assert.equal(inv.admit.how, 'password');
  assert.equal(inv.admit.room_password, ROOM);
  assert.match(inv.roles.host, /Ada/);
  assert.match(inv.roles.notes, /Transcribing/);
  for (const piece of ['Budget review', '2026-10-20 17:00', 'America/Los_Angeles', 'Q4 numbers.', link, ROOM]) assert.ok(inv.text.includes(piece), piece);
  assert.equal(urlsContain(inv.text, ROOM), false);
  assert.equal(inv.calendar.location, link);
  assert.equal(JSON.stringify(inv).includes('BEGIN:VCALENDAR'), false, 'no calendar file is made');
  const open = meetingInvite({ title: 'Stand-up', link: 'https://gifos.app/run.html#v=abc', start: '2026-10-20T09:00Z' });
  assert.equal(open.admit.how, 'link');
  assert.equal(open.end.iso, '2026-10-20T10:00:00.000Z', 'an hour by default');
  assert.equal(open.timezone, 'UTC');
  assert.equal(meetingInvite({ title: 'Later', link: 'https://gifos.app/run.html#v=abc' }).start, null);
  assert.equal(meetingInvite({ link: 'https://gifos.app/run.html#v=abc', townHall: true }).kind, 'town_hall');
  assert.throws(() => meetingInvite({ link: 'https://gifos.app/run.html#v=abc', start: '2026-10-20T10:00Z', end: '2026-10-20T09:00Z' }), /end must be after start/);
});

test('a broadcast invite says how to watch, when it starts, and where Visit goes', () => {
  const link = 'https://gifos.app/run.html#v=svc&av=3783bb03122c41d92d295bab&bc=1&at=1792540800';
  const inv = broadcastInvite({ title: 'Sunday service', link, start: '2026-10-25T10:00', timezone: 'America/Chicago', visit: 'https://example.org/give', description: 'Live from the hall.' });
  assert.equal(inv.kind, 'broadcast');
  assert.equal(inv.watch_url, link);
  assert.equal(inv.visit_url, 'https://example.org/give');
  assert.equal(inv.start.local, '2026-10-25 10:00');
  assert.match(inv.roles.early, /countdown/);
  assert.match(inv.roles.after, /ended/);
  assert.match(inv.text, /Watch: /);
  assert.match(inv.text, /Visit: https:\/\/example.org\/give/);
  assert.equal(broadcastInvite({ link, stream: true }).kind, 'stream');
});
