// The guard's journal is bounded: a visitor or chat flood writes at most LOG_PER_WINDOW lines a minute per event kind,
// and the next window's first line says how many were held. A mutant limiter that never holds must fail the same check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomGuard, normalizePolicy } from '../../src/guard.js';
import { makeLimiter, LOG_PER_WINDOW, LOG_WINDOW_MS } from '../../src/log-limit.js';

const policy = normalizePolicy({ link: 'https://gifos.app/meet/r/abc', mode: 'admin', host_password: 'host-pw' }, '/');

// Flood one guard with 500 greetings and 500 handler errors inside one minute, then one more of each a minute later.
function flood(makeLim) {
  let t = 1000;
  const lines = [];
  const g = new RoomGuard({ emit() {} }, policy, { log: (l) => lines.push(l), logLimiter: makeLim({ now: () => t }) });
  for (let i = 0; i < 500; i++) { t += 100; g.note('guard.greeted', { n: 1 }); g.note('guard.handler_error', { text: 'x' + i }); }
  const inFlood = lines.length;
  t += LOG_WINDOW_MS;
  g.note('guard.greeted', { n: 1 });
  g.note('guard.handler_error', { text: 'after' });
  return { inFlood, lines };
}

function checkBounded({ inFlood, lines }) {
  assert.equal(LOG_PER_WINDOW, 20, 'one line per 3 s guard tick');
  // 500 x 100 ms = 50 s: one window per kind, so 20 lines each.
  assert.equal(inFlood, 2 * LOG_PER_WINDOW, 'a flood writes at most LOG_PER_WINDOW lines per kind');
  const after = lines.slice(inFlood);
  assert.equal(after.length, 2);
  assert.match(after[0], /^guard\.greeted .* \[\+480 suppressed\]$/);
  assert.match(after[1], /^guard\.handler_error .* \[\+480 suppressed\]$/);
}

test('a flood of greetings and handler errors writes 20 lines a minute per kind, then the held count', () => {
  checkBounded(flood(makeLimiter));
});

test('mutant: a limiter that never holds fails the flood check', () => {
  const never = () => ({ take: () => ({ ok: true, suppressed: 0 }), held: () => 0 });
  assert.throws(() => checkBounded(flood(never)), /at most LOG_PER_WINDOW/);
});

test('kinds are separate and a quiet kind is never held', () => {
  let t = 0;
  const lim = makeLimiter({ now: () => t });
  for (let i = 0; i < 25; i++) lim.take('a');
  assert.equal(lim.held('a'), 5);
  assert.deepEqual(lim.take('b'), { ok: true, suppressed: 0 });
  t = 59999; assert.equal(lim.take('a').ok, false);
  t = 60000; assert.deepEqual(lim.take('a'), { ok: true, suppressed: 6 });
});
