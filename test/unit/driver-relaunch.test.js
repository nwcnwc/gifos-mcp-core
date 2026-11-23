// The bot's browser can lose Meeting Bot: a site deploy moves run.html to the new version (Meeting Bot's frame and
// every meeting frame go with the old document), the tab closes or crashes, or the browser dies. Seen live 2026-11-21:
// both welcome bots kept a dead Frame handle and failed every join for 45 h with "frame.evaluate: Target page, context
// or browser has been closed". The driver must notice every one of these, tell onLost which meetings went, and start a
// fresh browser on the next call. Driven here on stand-ins for Playwright's context, page and frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MeetingBotDriver, isDeadPage } from '../../src/driver.js';

const CLOSED = 'frame.evaluate: Target page, context or browser has been closed';

class FakeFrame {
  constructor(b) { this.b = b; this.detached = false; this.gone = false; }
  isDetached() { return this.detached; }
  async evaluate(_fn, arg) {
    if (this.gone || this.detached) throw new Error(CLOSED);
    if (arg && arg.method === 'join') return { ok: true, v: { id: 'mt_' + this.b.n + '_' + (++this.b.joins) } };
    if (arg && arg.method) return { ok: true, v: {} };
    return true;
  }
}
class FakePage extends EventEmitter {
  constructor() { super(); this.closed = false; }
  isClosed() { return this.closed; }
  async evaluate() { if (this.closed) throw new Error('page.evaluate: ' + CLOSED.split(': ')[1]); return { ok: true, v: {} }; }
  async close() { this.closed = true; this.emit('close'); }
}
class FakeCtx extends EventEmitter {
  constructor(b) { super(); this.b = b; this.closed = false; }
  async close() { if (this.closed) return; this.closed = true; this.b.closes++; this.emit('close'); }
}

function makeDriver() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-relaunch-'));
  const cfg = { gifosUrl: 'http://127.0.0.1:1', home, botAudio: path.join(home, 'a.wav'), voice: { tts: { engine: 'none' } }, timeoutMs: 2000 };
  const d = new MeetingBotDriver(cfg, { name: 'Gwen', password: 'pw-long-enough' }, null, { storeAppListing: async () => ({}) });
  const b = { n: 0, joins: 0, closes: 0, ctxs: [] };
  d.launch = async () => { b.n++; const c = new FakeCtx(b); b.ctxs.push(c); return c; };
  d.desktop = async () => new FakePage();
  d.applyProviders = async () => {};
  d.installFromStore = async () => 'f1';
  d.openApp = async () => { const app = new FakePage(); const frame = new FakeFrame(b); b.app = app; b.frame = frame; return { app, frame }; };
  d.startRun = async () => {};
  d.shot = async () => {};
  const lost = [];
  assert.equal(typeof d.onLost, 'function', 'the driver has onLost');
  d.onLost((ids, why) => lost.push({ ids, why }));
  return { d, b, lost, done: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('isDeadPage knows Playwright\'s closed, crashed and detached errors, and nothing else', () => {
  assert.ok(isDeadPage(new Error(CLOSED)));
  assert.ok(isDeadPage(new Error('frame.evaluate: Frame was detached')));
  assert.ok(isDeadPage(new Error('page.evaluate: Target crashed')));
  assert.ok(isDeadPage(new Error('frame.evaluate: Execution context was destroyed, most likely because of a navigation')));
  assert.ok(!isDeadPage(new Error('Meeting Bot: That room needs a password.')));
  assert.ok(!isDeadPage(new Error('The meeting page did not answer (join) within 120 s.')));
});

test('a site update (the old frame answers "Target ... closed", no event seen): the failed call drops the meeting, the next one relaunches', async () => {
  const { d, b, lost, done } = makeDriver();
  try {
    const s1 = await d.join('https://gifos.app/meet/welcome', '');
    assert.equal(s1, 'mt_1_1');
    b.frame.gone = true;   // the live case: the handle is dead but nothing said so
    await assert.rejects(d.join('https://gifos.app/meet/welcome', ''), /Target page, context or browser has been closed/);
    assert.equal(lost.length, 1, 'onLost heard it once');
    assert.deepEqual(lost[0].ids, ['mt_1_1'], 'with the meeting that went');
    const s2 = await d.join('https://gifos.app/meet/welcome', '');
    assert.equal(b.n, 2, 'a fresh browser was started');
    assert.equal(b.ctxs[0].closed, true, 'the old one was closed first (it holds the profile)');
    assert.equal(s2, 'mt_2_2');
    assert.equal(d.state, 'ready');
    // Several cycles in a row.
    for (let i = 3; i <= 5; i++) {
      b.frame.gone = true;
      await d.join('x', '').catch(() => {});
      await d.join('https://gifos.app/meet/welcome', '');
      assert.equal(b.n, i);
    }
    assert.equal(lost.length, 4);
  } finally { await d.close(); done(); }
});

test('the tab moved (framedetached on Meeting Bot\'s frame): lost at once, the next call relaunches without a failed call', async () => {
  const { d, b, lost, done } = makeDriver();
  try {
    await d.join('https://gifos.app/meet/welcome', '');
    b.frame.detached = true;
    b.app.emit('framedetached', b.frame);
    assert.equal(lost.length, 1);
    assert.match(lost[0].why, /frame is gone/);
    const s = await d.join('https://gifos.app/meet/welcome', '');
    assert.equal(b.n, 2);
    assert.equal(s, 'mt_2_2');
  } finally { await d.close(); done(); }
});

test('another frame detaching (a meeting frame) is not a loss', async () => {
  const { d, b, lost, done } = makeDriver();
  try {
    await d.ensureStarted();
    b.app.emit('framedetached', new FakeFrame(b));
    assert.equal(lost.length, 0);
    await d.join('x', '');
    assert.equal(b.n, 1);
  } finally { await d.close(); done(); }
});

test('the browser died (its context closed): lost, then relaunched', async () => {
  const { d, b, lost, done } = makeDriver();
  try {
    await d.join('https://gifos.app/meet/welcome', '');
    b.app.closed = true; b.frame.gone = true;
    b.ctxs[0].closed = true; b.ctxs[0].emit('close');
    assert.equal(lost.length, 1);
    assert.match(lost[0].why, /browser closed/);
    await d.join('https://gifos.app/meet/welcome', '');
    assert.equal(b.n, 2);
  } finally { await d.close(); done(); }
});

test('the tab crashed or closed: lost, then relaunched', async () => {
  const { d, b, lost, done } = makeDriver();
  try {
    await d.ensureStarted();
    b.app.emit('crash');
    assert.equal(lost.length, 1);
    assert.match(lost[0].why, /crashed/);
    await d.ensureStarted();
    assert.equal(b.n, 2);
    await b.app.close();
    assert.equal(lost.length, 2);
    assert.match(lost[1].why, /tab closed/);
    await d.ensureStarted();
    assert.equal(b.n, 3);
  } finally { await d.close(); done(); }
});

test('a closed tab nobody heard about is still caught by ensureStarted', async () => {
  const { d, b, lost, done } = makeDriver();
  try {
    await d.ensureStarted();
    b.app.closed = true;   // no event
    await d.ensureStarted();
    assert.equal(lost.length, 1);
    assert.equal(b.n, 2);
  } finally { await d.close(); done(); }
});

test('the driver\'s own close is not a loss, and an old browser\'s late events say nothing', async () => {
  const { d, b, lost, done } = makeDriver();
  try {
    await d.join('x', '');
    const oldCtx = b.ctxs[0], oldApp = b.app;
    await d.close();
    assert.equal(lost.length, 0, 'close() is not a loss');
    await d.ensureStarted();
    oldApp.emit('crash'); oldCtx.emit('close');
    assert.equal(lost.length, 0, 'events of the closed browser are ignored');
    assert.equal(d.state, 'ready');
  } finally { await d.close(); done(); }
});

test('a page error that is not a dead page leaves the browser alone', async () => {
  const { d, b, lost, done } = makeDriver();
  try {
    await d.ensureStarted();
    b.frame.evaluate = async () => ({ ok: false, error: 'That room needs a password.' });
    await assert.rejects(d.join('x', ''), /needs a password/);
    assert.equal(lost.length, 0);
    assert.equal(d.state, 'ready');
  } finally { await d.close(); done(); }
});

test('callers that arrive during a relaunch share it: one new browser, not one each', async () => {
  const { d, b, done } = makeDriver();
  try {
    await d.ensureStarted();
    b.app.emit('crash');
    await Promise.all([d.ensureStarted(), d.ensureStarted(), d.join('x', ''), d.ensureStarted()]);
    assert.equal(b.n, 2);
  } finally { await d.close(); done(); }
});

test('a relaunch that fails is closed before anyone tries again, and the next call tries again', async () => {
  const { d, b, done } = makeDriver();
  try {
    await d.ensureStarted();
    b.app.emit('crash');
    const realOpen = d.openApp;
    d.openApp = async () => { throw new Error('Meeting Bot did not start: store down'); };
    const first = d.ensureStarted();
    const second = d.ensureStarted();   // arrives while the failed start is closing
    await assert.rejects(first, /store down/);
    await assert.rejects(second, /store down/);
    assert.equal(b.n, 2, 'one failed launch, shared');
    assert.ok(b.ctxs[1].closed, 'the failed browser was closed');
    assert.equal(d.state, 'error');
    d.openApp = realOpen;
    await d.join('x', '');
    assert.equal(b.n, 3);
    assert.equal(d.state, 'ready');
  } finally { await d.close(); done(); }
});

test('room ops and method calls that hit a dead page mark the browser lost', async () => {
  const { d, b, lost, done } = makeDriver();
  try {
    await d.ensureStarted();
    b.app.closed = false;
    b.app.evaluate = async () => { throw new Error('page.evaluate: Target crashed'); };
    await assert.rejects(d.room('mt_1', 'guard.state', {}), /Target crashed/);
    assert.equal(lost.length, 1);
    await d.ensureStarted();
    b.frame.gone = true;
    await assert.rejects(d.raiseHand('mt_1', true), /Target page, context or browser has been closed/);
    assert.equal(lost.length, 2);
  } finally { await d.close(); done(); }
});

test('with relaunch off (a worker on its way out), a lost browser is not started again', async () => {
  const { d, b, done } = makeDriver();
  try {
    await d.ensureStarted();
    d.onLost(() => { d.relaunch = false; });
    b.app.emit('crash');
    await assert.rejects(d.ensureStarted(), /was lost/);
    assert.equal(b.n, 1);
  } finally { await d.close(); done(); }
});

test('a lost browser\'s meetings go back to scheduled for a reseat, reason browser', async () => {
  const { dropLostMeetings } = await import('../../src/supervisor.js');
  const rows = [{ meeting_id: 'm1', state: 'live', session_id: 'mt_1_1' }, { meeting_id: 'm2', state: 'live', session_id: 'other' }];
  const evs = [];
  const meetings = { all: () => rows, update: (id, f) => Object.assign(rows.find((r) => r.meeting_id === id), f) };
  dropLostMeetings({ meetings, events: { append: (e) => evs.push(e) } })(['mt_1_1'], 'the bot browser closed');
  assert.equal(rows[0].state, 'scheduled');
  assert.equal(rows[0].reseat, true);
  assert.equal(rows[1].state, 'live');
  assert.equal(evs[0].data.reason, 'browser');
});

test('a worker whose browser is lost refuses new calls and exits so the pool restarts it', async () => {
  const { serveWorker } = await import('../../src/worker.js');
  const sent = [];
  const channel = new EventEmitter();
  channel.send = (m) => sent.push(m);
  let hook = null, closed = 0;
  const fake = { onLost: (fn) => { hook = fn; }, close: async () => { closed++; }, join: async () => 'never' };
  const realExit = process.exit;
  let exitCode = null;
  process.exit = (c) => { exitCode = c; };
  try {
    serveWorker(channel, () => fake);
    hook(['s1'], 'the bot browser closed');
    assert.equal(fake.relaunch, false);
    channel.emit('message', { type: 'call', id: 7, method: 'join', args: ['x'] });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(sent.find((m) => m.id === 7), { id: 7, ok: false, error: 'The worker lost its browser and is restarting.' });
    assert.equal(closed, 1);
    assert.equal(exitCode, 1);
  } finally { process.exit = realExit; }
});
