// Every password the server holds is masked: the guard's journal (its log lines) never carries the room or host password
// it holds, the same as its events; a password handed to holdSecret is masked in ok()/fail() answers like the bot's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomGuard, normalizePolicy } from '../../src/guard.js';
import { createContext } from '../../src/context.js';
import { loadConfig } from '../../src/config.js';
import { MeetingStore } from '../../src/meetings.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('the guard journal masks the room and host passwords it holds', () => {
  const policy = normalizePolicy({ link: 'https://gifos.app/meet/r/abc', mode: 'admin', host_password: 'host-pw-9f2', password: 'room-pw-7k1' }, '/');
  const lines = [], events = [];
  const g = new RoomGuard({ emit: (e) => events.push(e) }, policy, { log: (l) => lines.push(l) });
  g.note('guard.join_failed', { text: 'door said: room-pw-7k1 was refused; host-pw-9f2 too' });
  assert.equal(lines.length, 1);
  assert.equal(/room-pw-7k1|host-pw-9f2/.test(lines[0]), false, lines[0]);
  assert.match(lines[0], /\[redacted\]/);
});

test('holdSecret masks a password in every answer', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mask-'));
  const cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:19510/' });
  const ctx = createContext({ cfg, meetings: new MeetingStore(home), bot: {}, botName: 'b', botPassword: 'bot-secret-1' });
  assert.equal(typeof ctx.holdSecret, 'function');
  ctx.holdSecret('given-host-pw-3');
  let kept = ['kept-host-pw-4']; ctx.holdSecret(() => kept);
  const out = ctx.ok({ said: 'given-host-pw-3 and kept-host-pw-4 and bot-secret-1' }).content[0].text;
  assert.equal(/given-host-pw-3|kept-host-pw-4|bot-secret-1/.test(out), false, out);
  kept = ['kept-host-pw-5'];
  assert.equal(ctx.fail('x kept-host-pw-5 y').content[0].text.includes('kept-host-pw-5'), false);
  fs.rmSync(home, { recursive: true, force: true });
});
