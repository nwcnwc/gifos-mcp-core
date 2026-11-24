// The bot's plan rides only in meetings it joins, never in Meeting Bot's own sessions (driver.js PLAN_GATE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { PLAN_GATE, PLAN_KEYS } from '../../src/driver.js';

// One frame of the bot's browser: its own Storage class (each frame has its own prototype), a shared store, a parent.
function frame(store, href = 'about:srcdoc') {
  class Storage { getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; } setItem(k, v) { store[k] = String(v); } }
  const listeners = [];
  const parent = {};
  const win = { Storage, parent, location: { href }, addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); } };
  win.window = win; win.localStorage = new Storage();
  vm.runInNewContext(PLAN_GATE, win);
  const post = (data, source = parent) => listeners.forEach((fn) => fn({ data, source }));
  return { win, post, plan: () => PLAN_KEYS.map((k) => win.localStorage.getItem(k)) };
}

test('the gate covers the page\'s copies of the credentials file: the subscription and the pass wallet', () => {
  assert.deepEqual(PLAN_KEYS, ['gifos-sub-cred', 'gifos-pass-wallet']);
});

test('a meeting the bot joins reads the plan; Meeting Bot\'s control, probe and remote sessions never do', () => {
  const store = { 'gifos-sub-cred': 'C', 'gifos-pass-wallet': 'W', other: 'x' };
  const meeting = frame(store), control = frame(store), probe = frame(store), desk = frame(store, 'https://gifos.app/');
  assert.deepEqual(meeting.plan(), [null, null], 'a session reads no plan before the host says which meeting it is');
  assert.deepEqual(control.plan(), [null, null]);
  assert.equal(meeting.win.localStorage.getItem('other'), 'x', 'other keys are untouched');
  meeting.post({ ns: 'gifos-meet', op: 'join', control: false, link: 'https://gifos.app/meet#room=welcome' });
  control.post({ ns: 'gifos-meet', op: 'join', control: true, room: 'abc' });
  probe.post({ ns: 'gifos-meet', op: 'join', control: true, room: 'abc' });
  assert.deepEqual(meeting.plan(), ['C', 'W'], 'the guarded (joined) meeting carries the plan');
  assert.deepEqual(control.plan(), [null, null], 'the control meeting never carries it: a one-meeting pass would move there');
  assert.deepEqual(probe.plan(), [null, null]);
  assert.deepEqual(desk.plan(), ['C', 'W'], 'a frame that is no meeting session reads it as it is');
  // Only the first join from the parent counts: a later message, or one from anyone else, changes nothing.
  control.post({ ns: 'gifos-meet', op: 'join', control: false });
  assert.deepEqual(control.plan(), [null, null]);
  meeting.post({ op: 'join', control: true });
  assert.deepEqual(meeting.plan(), ['C', 'W']);
  const other = frame(store);
  other.post({ op: 'join', control: false }, {});
  assert.deepEqual(other.plan(), [null, null], 'a join from a stranger window opens nothing');
  // Writes go through (the page saves the file it is handed in a joined meeting).
  meeting.win.localStorage.setItem('gifos-pass-wallet', 'W2');
  assert.equal(store['gifos-pass-wallet'], 'W2');
});
