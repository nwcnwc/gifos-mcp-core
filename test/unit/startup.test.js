// Startup speed (0.1.3): a profile that already granted Meet and Remote does
// not wait out the permission sheet, a first launch still answers it, and the
// browser is warmed at server start unless GIFOS_MCP_LAZY=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetOrReady } from '../../src/driver.js';
import { loadConfig } from '../../src/config.js';

function clock() { let t = 0; return { now: () => t, sleepFn: async (ms) => { t += ms; } }; }

test('granted profile: ready without the sheet, long before 8 s', async () => {
  const c = clock();
  const r = await sheetOrReady({ sheet: async () => false, ready: async () => c.now() >= 300, ...c });
  assert.equal(r, 'ready');
  assert.ok(c.now() < 1000, 'returned at ' + c.now() + ' ms');
});

test('first launch: the sheet wins and is reported', async () => {
  const c = clock();
  const r = await sheetOrReady({ sheet: async () => c.now() >= 500, ready: async () => false, ...c });
  assert.equal(r, 'sheet');
});

test('a sheet drawn just after the app is up is still caught', async () => {
  const c = clock();
  const r = await sheetOrReady({ sheet: async () => c.now() >= 100, ready: async () => true, ...c });
  assert.equal(r, 'sheet');
});

test('neither: times out at the old 8 s limit', async () => {
  const c = clock();
  const r = await sheetOrReady({ sheet: async () => false, ready: async () => false, timeoutMs: 8000, ...c });
  assert.equal(r, 'timeout');
  assert.ok(c.now() >= 8000 && c.now() < 8200);
});

test('prewarm is on by default and off with GIFOS_MCP_LAZY=1', () => {
  assert.equal(loadConfig({ GIFOS_MCP_HOME: '/tmp/x' }).prewarm, true);
  assert.equal(loadConfig({ GIFOS_MCP_HOME: '/tmp/x', GIFOS_MCP_LAZY: '1' }).prewarm, false);
});
