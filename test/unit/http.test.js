// HTTP-mode lifecycle and page-call deadlines (connector bug 13): a second server on a port in use exits at once with
// no browser and no stores; GIFOS_PARENT_PID ends the server when its parent is gone; a page call that never answers
// fails with a typed timeout instead of hanging the tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as M from '../../src/main.js';
import * as D from '../../src/driver.js';

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/main.js');
const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
// one server process: runMain with a do-nothing product, no browser (GIFOS_MCP_LAZY), no speech (GIFOS_TTS_ENGINE none)
function serve(home, port, extraEnv = {}) {
  const src = "import { runMain } from " + JSON.stringify(MAIN) + "; runMain({ name: 't', version: '0', httpPort: " + port + ", register() {} }, ['--http', '" + port + "']);";
  const child = spawn(process.execPath, ['--input-type=module', '-e', src], {
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, GIFOS_MCP_HOME: path.join(home, 'mcp'), GIFOS_MCP_LAZY: '1', GIFOS_TTS_ENGINE: 'none', GIFOS_BOT_NAME: 'Test Bot', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, out: () => out };
}
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('still running'), ms))]);
function home(t) { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-http-')); t.after(() => fs.rmSync(h, { recursive: true, force: true })); return h; }

test('listen(): a port in use rejects with EADDRINUSE', async () => {
  const a = http.createServer(); await M.listen(a, 0); const port = a.address().port;
  await assert.rejects(M.listen(http.createServer(), port), (e) => e.code === 'EADDRINUSE');
  a.close();
});

test('a second server on a port in use exits 1 within 2 s, before any store or browser', async (t) => {
  const port = await freePort(), h = home(t);
  const busy = http.createServer(); await M.listen(busy, port); t.after(() => busy.close());
  const s = serve(h, port);
  const code = await within(s.exited, 2000);
  if (code === 'still running') s.child.kill('SIGKILL');
  assert.equal(code, 1, s.out());
  assert.match(s.out(), /already in use/);
  assert.ok(!fs.existsSync(path.join(h, 'mcp', 'meetings')), 'the twin touched the stores: ' + s.out());
});

test('watchParent: onGone runs once the parent pid is gone', async () => {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  let gone = 0; const stop = M.watchParent(p.pid, () => { gone++; }, { intervalMs: 50 });
  await new Promise((r) => setTimeout(r, 200)); assert.equal(gone, 0);
  p.kill('SIGKILL'); await new Promise((r) => p.on('exit', r));
  await new Promise((r) => setTimeout(r, 300)); stop();
  assert.equal(gone, 1);
});

test('parentPid: from --parent-pid or GIFOS_PARENT_PID, else off', () => {
  assert.equal(M.parentPid(['--http', '1', '--parent-pid', '4242'], {}), 4242);
  assert.equal(M.parentPid([], { GIFOS_PARENT_PID: '777' }), 777);
  assert.equal(M.parentPid([], {}), 0);
  assert.equal(M.parentPid([], { GIFOS_PARENT_PID: '1' }), 0);
});

test('GIFOS_PARENT_PID: killing the parent ends the HTTP server within 5 s and frees its port', async (t) => {
  const port = await freePort(), h = home(t);
  const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { parent.kill('SIGKILL'); } catch (e) {} });
  const s = serve(h, port, { GIFOS_PARENT_PID: String(parent.pid) });
  for (let i = 0; i < 100 && !/listening on/.test(s.out()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(s.out(), /watching parent process/);
  parent.kill('SIGKILL');
  const code = await within(s.exited, 5000);
  if (code === 'still running') s.child.kill('SIGKILL');
  assert.equal(code, 0, s.out());
  const again = http.createServer(); await M.listen(again, port); again.close();
});

test('withDeadline: a page call that never answers fails with PAGE_TIMEOUT', async () => {
  await assert.rejects(D.withDeadline(new Promise(() => {}), 50, 'meetingState'), (e) => e.code === 'PAGE_TIMEOUT' && /meetingState/.test(e.message));
  assert.equal(await D.withDeadline(Promise.resolve(7), 50, 'x'), 7);
});

test('a wedged meeting page: get_meeting_state and people return a typed timeout, not a hang', async () => {
  const d = Object.create(D.MeetingBotDriver.prototype);
  d.cfg = { readDeadlineMs: 60, timeoutMs: 120 };
  d.ensureStarted = async () => {};
  let calls = 0;
  d.bot = { frame: { evaluate: (fn) => { calls++; return calls === 1 && String(fn).includes('typeof') ? Promise.resolve(true) : new Promise(() => {}); } } };
  const t0 = Date.now();
  await assert.rejects(d.meetingState('s1'), (e) => e.code === 'PAGE_TIMEOUT');
  await assert.rejects(d.people('s1'), (e) => e.code === 'PAGE_TIMEOUT');
  assert.ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + ' ms');
});
