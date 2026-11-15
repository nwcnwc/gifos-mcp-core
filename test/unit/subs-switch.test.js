// The bot's plan rides only in meetings it joins, never in Meeting Bot's control meeting (driver.js SUBS_SWITCH).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SUBS_SWITCH, PLAN_MARK } from '../../src/driver.js';

// One frame of the bot's browser: its own Storage class (each frame has its own prototype), a shared store, a parent.
function frame(store, href = 'about:srcdoc') {
  class Storage { getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; } setItem(k, v) { store[k] = String(v); } }
  const listeners = [];
  const parent = {};
  const win = { Storage, parent, location: { href }, addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); } };
  win.window = win; win.localStorage = new Storage();
  vm.runInNewContext(SUBS_SWITCH, win);
  const post = (data, source = parent) => listeners.forEach((fn) => fn({ data, source }));
  return { win, post, flag: () => win.localStorage.getItem('gifos-subs') };
}

test('a meeting session frame has the switch on from its start while the bot holds a plan; the control meeting never', () => {
  const store = { 'gifos-subs': '1' };   // an old profile's origin-wide switch is ignored
  const meeting = frame(store), control = frame(store), desk = frame(store, 'https://gifos.app/');
  assert.equal(meeting.flag(), null, 'no plan yet');
  store[PLAN_MARK] = '1';
  assert.equal(meeting.flag(), '1', 'on at boot (DOMContentLoaded), before the host says which meeting');
  meeting.post({ ns: 'gifos-meet', op: 'join', control: false, link: 'https://gifos.app/meet/welcome' });
  control.post({ ns: 'gifos-meet', op: 'join', control: true });
  assert.equal(meeting.flag(), '1');
  assert.equal(control.flag(), null, 'the control meeting never carries the plan once its join says so');
  assert.equal(desk.flag(), null, 'a frame that is no meeting session');
  // A join message from anyone but the parent changes nothing.
  meeting.post({ op: 'join', control: true }, {});
  assert.equal(meeting.flag(), '1');
  store.x = 'y'; assert.equal(meeting.win.localStorage.getItem('x'), 'y');
});
