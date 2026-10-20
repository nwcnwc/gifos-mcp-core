// Stage B supervisor: several workers on one machine. Each worker is a child
// process with one Chromium and one Meet Bot (worker.js). This object has the
// same surface as MeetingBotDriver, so server.js and the clock do not change.
//
// - A join goes to the ready worker with the most free rooms, chosen when the
//   window opens, not at the start of the day.
// - The session id handed back is "w<index>:<worker session id>". The
//   meeting is sticky to that worker until it leaves. say, transcript, leave,
//   and every per-meeting call route by that prefix.
// - A worker that exits loses its rooms. onLost hears their session ids so
//   the meeting index can drop them, and the clock rejoins live orders on a
//   worker that is still up.
// - A worker that stops answering the heartbeat is killed and counts as lost.
//   So is one that says it is alive and then does not say up within bootMs
//   (a stalled boot would hold every join to it), and joins go to the next
//   worker. The clock starts at that alive message, not at fork: a short
//   join call budget must not kill a worker that is still starting.
// - A call that gets no answer within callMs (joinMs for a browser start or
//   a join) fails, but a worker that still answers the heartbeat stays up.
//   A join that timed out keeps its seat until it answers, since the bot
//   may still be walking into the room. One that lands is left at once.
//   Until that leave works the room keeps its seat, and it is left again
//   every leaveRetryMs, so the bot is not stranded in a room nobody can reach.
//   One that has not answered after lateJoinMs is checked against Meet Bot's
//   own room list: a room the pool does not hold is left, and the seat is
//   freed, so a join that never answers does not hold it until the worker dies.
// - A leave that fails or times out keeps the room on its worker, so the
//   seat stays taken and a second leave can still reach it. A late leave
//   that lands, or Meet Bot saying the room is gone, frees it. A leave that
//   has not answered after lateLeaveMs is checked against Meet Bot's room
//   list: a room it no longer lists is freed too. A leave of a room a late
//   leave already freed counts as left, so the meeting can end.
// - status and list ask every ready worker at once and wait at most infoMs,
//   so one stuck worker shows as an error row instead of holding status.
// - A worker that keeps dying waits longer before each restart (1s, 2s, 4s,
//   up to a minute), and joins go to another worker meanwhile.
// - A worker that is up but whose browser will not start waits the same way
//   before its next start, and the join that found it out tries the next
//   worker, so one broken Chromium does not fail every join.
// - A join whose worker dies under it goes to the next worker, once, and
//   fails with code worker_died if that one dies too.
// - Each worker runs with a TMPDIR of its own (workerTmpDir), emptied
//   before each start and removed when it exits, so what a crashed worker's
//   Chromium leaves there (playwright-artifacts-*) does not pile up in /tmp.
// - Voice settings go to every ready worker at once and again to any worker
//   that restarts or missed them, before its next join. A ready worker that
//   refused them is asked again every voiceRetryMs until it takes them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

const WORKER_SCRIPT = fileURLToPath(new URL('./worker.js', import.meta.url));
const SESSION_RE = /^w(\d+):(.+)$/;
// Calls that may start a browser or wait on a meeting page get joinMs.
const SLOW_METHODS = new Set(['ensureStarted', 'join']);
// Meet Bot's answer for a session it does not hold: already left.
const GONE_RE = /No such meeting/;

// Under the system TMPDIR, not the home: Chromium puts its singleton socket
// in TMPDIR, and a socket path is capped near 108 bytes. Named by the home,
// so the next start of the same home clears what a killed one left.
export function workerTmpDir(cfg, index) {
  const tag = crypto.createHash('sha256').update(path.resolve(cfg.home)).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), 'gifos-mcp-' + tag + '-w' + index);
}

function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { log('could not remove ' + dir + ': ' + ((e && e.message) || e)); }
}

// Worker 0 keeps the bot's own name and profile, so a one-worker machine
// that moves to several keeps its installed apps. Worker n is its own bot
// (open question 6): a second RUN with the same name and password would be
// refused as "already running".
export function workerIdentity(cfg, creds, index) {
  if (index === 0) return { profile: 'profile-bot', creds: { ...creds } };
  const tag = '-w' + index;
  return {
    profile: 'profile-bot' + tag,
    creds: { ...creds, name: String(creds.name).slice(0, 40 - tag.length) + tag },
  };
}

function closedError() {
  return new Error('The worker pool is closed.');
}

// No worker can take a room right now. The clock waits on this; it is not
// a broken room.
function noSeat(text) {
  const e = new Error(text);
  e.code = 'no_seat';
  return e;
}

export function splitSession(sessionId) {
  const m = SESSION_RE.exec(String(sessionId || ''));
  if (!m) return null;
  return { index: Number(m[1]), local: m[2] };
}

class Worker {
  constructor(pool, index) {
    this.pool = pool;
    this.index = index;
    this.child = null;
    this.state = 'stopped';
    this.error = '';
    this.seq = 0;
    this.pending = new Map();
    this.late = new Map();    // call id -> { method, args }, for calls that timed out
    this.rooms = new Set();   // local session ids seated on this worker
    this.stray = new Map();   // late joins still to leave: local id -> { timer, told }
    this.leftLate = new Set(); // rooms a leave that timed out did leave
    this.reserved = 0;        // joins in flight
    this.lateJoins = 0;       // joins that timed out and have not answered yet
    this.lateTimer = null;    // the next check of those joins against Meet Bot's list
    this.leaveTimer = null;   // the same check for leaves that timed out
    this.booting = null;
    this.voice = null;
    this.voicing = null;      // { settings, promise } for the push in flight
    this.voiceTimer = null;
    this.failures = 0;        // deaths in a row, for the restart backoff
    this.nextStartAt = 0;     // pool.now() before which spawn() refuses
    this.startFailures = 0;   // browser starts failed in a row on this process
    this.startRetryAt = 0;    // pool.now() before which joins skip this worker
    this.startError = '';
    this.upAt = 0;
    this.lastPong = 0;
    this.beat = null;
  }

  get used() { return this.rooms.size + this.stray.size + this.reserved + this.lateJoins; }

  restartInMs() {
    return this.state === 'lost' ? Math.max(0, this.nextStartAt - this.pool.now()) : 0;
  }

  startRetryInMs() {
    return this.startRetryAt && this.state !== 'lost' ? Math.max(0, this.startRetryAt - this.pool.now()) : 0;
  }

  // How long until a join may go to this worker.
  waitMs() {
    return Math.max(this.restartInMs(), this.startRetryInMs());
  }

  waitText() {
    if (this.restartInMs() === 0 && this.startRetryInMs() > 0) {
      return 'Worker ' + this.index + ' tries its browser again in ' + Math.ceil(this.startRetryInMs() / 1000) + 's (it would not start: ' + this.startError + ').';
    }
    return 'Worker ' + this.index + ' restarts in ' + Math.ceil(this.restartInMs() / 1000) + 's (it stopped: ' + this.error + ').';
  }

  waitError() {
    return noSeat(this.waitText());
  }

  spawn() {
    if (this.booting) return this.booting;
    if (this.pool.closed) return Promise.reject(closedError());
    if (this.restartInMs() > 0) return Promise.reject(this.waitError());
    const id = workerIdentity(this.pool.cfg, this.pool.creds, this.index);
    const shots = this.pool.cfg.shotsDir || path.join(this.pool.cfg.home, 'shots');
    const cfg = { ...this.pool.cfg, profile: id.profile, shotsDir: this.index === 0 ? this.pool.cfg.shotsDir : path.join(shots, 'w' + this.index) };
    this.botName = id.creds.name;
    this.state = 'starting';
    this.error = '';
    const tmpDir = workerTmpDir(this.pool.cfg, this.index);
    removeDir(tmpDir);
    try { fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 }); } catch (e) { log('could not make ' + tmpDir + ': ' + ((e && e.message) || e)); }
    this.booting = new Promise((resolve, reject) => {
      const child = this.pool.forkWorker(this.index, { tmpDir });
      this.child = child;
      let up = false;
      // The heartbeat starts at up. bootMs starts when the child says it is
      // alive, not at fork, so time spent reaching that line is not a failed
      // boot. A child that never says up is still killed after bootMs.
      let boot = null;
      const armBoot = () => {
        clearTimeout(boot);
        boot = setTimeout(() => {
          if (up || this.child !== child) return;
          this.error = 'worker ' + this.index + ' did not boot within ' + this.pool.bootMs + 'ms';
          try { child.kill('SIGKILL'); } catch (e) { /* exit follows */ }
        }, this.pool.bootMs);
        boot.unref();
      };
      child.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.event === 'boot') { armBoot(); child.send({ type: 'boot', cfg, creds: id.creds, index: this.index }); return; }
        if (msg.event === 'up') { up = true; clearTimeout(boot); this.state = 'up'; this.upAt = this.pool.now(); this.heartbeat(child); resolve(); return; }
        if (msg.event === 'pong') { this.lastPong = Date.now(); return; }
        if (msg.event === 'thinking') { this.pool.thinkingFrom(this.index, msg.id, msg.on); return; }
        if (msg.id != null && this.late.has(msg.id)) { this.landedLate(msg); return; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.value);
          else p.reject(new Error(msg.error || 'The worker call failed.'));
        }
      });
      child.on('error', (e) => { this.error = String((e && e.message) || e); });
      child.on('exit', (code, signal) => {
        clearTimeout(boot);
        // A worker killed under its browser could not remove its own.
        removeDir(tmpDir);
        const why = this.error || ('worker ' + this.index + ' exited' + (signal ? ' (' + signal + ')' : ' (code ' + code + ')'));
        this.lost(why);
        if (!up) reject(new Error(why));
      });
    });
    return this.booting;
  }

  // A wedged event loop answers no call, so a ping that goes unanswered for
  // stuckMs kills the child. exit then runs lost() as for any crash.
  heartbeat(child) {
    this.lastPong = Date.now();
    this.beat = setInterval(() => {
      if (this.child !== child) return;
      const quiet = Date.now() - this.lastPong;
      if (quiet > this.pool.stuckMs) {
        this.error = 'worker ' + this.index + ' stopped answering (no heartbeat for ' + quiet + 'ms)';
        clearInterval(this.beat);
        try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
        return;
      }
      try { child.send({ type: 'ping' }); } catch (e) { /* exit follows */ }
    }, this.pool.heartbeatMs);
    this.beat.unref();
  }

  lost(why) {
    const was = this.state;
    clearInterval(this.beat);
    this.beat = null;
    if (was !== 'closing') {
      // A worker that stayed up for stableMs starts the backoff over.
      const now = this.pool.now();
      if (this.upAt && now - this.upAt >= this.pool.stableMs) this.failures = 0;
      this.failures++;
      this.nextStartAt = now + Math.min(this.pool.backoffMaxMs, this.pool.backoffMs * 2 ** (this.failures - 1));
    }
    this.upAt = 0;
    this.startFailures = 0;   // a new process gets a fresh browser start
    this.startRetryAt = 0;
    this.startError = '';
    this.state = was === 'closing' ? 'stopped' : 'lost';
    if (was !== 'closing') this.error = why;
    this.child = null;
    this.booting = null;
    this.voice = null;        // a new process starts with Meet Bot's defaults
    this.voicing = null;
    clearTimeout(this.voiceTimer);
    this.voiceTimer = null;
    this.late.clear();
    this.lateJoins = 0;
    clearTimeout(this.lateTimer);
    this.lateTimer = null;
    clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
    this.clearStray();        // the process and its browser are gone
    this.leftLate.clear();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Worker ' + this.index + ' stopped: ' + why)); }
    this.pending.clear();
    const gone = [...this.rooms].map((s) => 'w' + this.index + ':' + s);
    this.rooms.clear();
    if (was !== 'closing') {
      log('worker ' + this.index + ' lost: ' + why + (gone.length ? '; ' + gone.length + ' meeting(s) dropped' : ''));
      this.pool.lostFrom(this.index, gone, why);
    }
  }

  async call(method, ...args) {
    return this.callWithin(SLOW_METHODS.has(method) ? this.pool.joinMs : this.pool.callMs, method, ...args);
  }

  async callWithin(ms, method, ...args) {
    await this.spawn();
    if (!this.child) throw new Error('Worker ' + this.index + ' is not running.');
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.late.set(id, { method, args, settled: false });
        if (method === 'join') { this.lateJoins++; this.checkLate(); }
        if (method === 'leave') this.checkLateLeaves();
        reject(new Error('Worker ' + this.index + ' did not answer ' + method + ' within ' + ms + 'ms.'));
      }, ms);
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.child.send({ type: 'call', id, method, args }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  // A reply to a call that already timed out. Nobody holds the session id of
  // a late join, so leave it rather than keep a seat no one can reach. A
  // late leave that worked frees the seat it kept.
  landedLate(msg) {
    const { method, args, settled } = this.late.get(msg.id);
    this.late.delete(msg.id);
    if (method === 'join' && !settled) this.lateJoins--;
    if (method === 'leave' && (msg.ok || GONE_RE.test(msg.error || ''))) {
      const local = String(args[0]);
      if (this.rooms.delete(local)) this.leftLate.add(local);
      this.dropStray(local);
      return;
    }
    if (method !== 'join' || !msg.ok || msg.value == null) return;
    const local = String(msg.value);
    // The list check may have found this room already.
    if (this.rooms.has(local) || this.stray.has(local)) return;
    log('worker ' + this.index + ': a join landed after it timed out; leaving ' + local);
    this.stray.set(local, { timer: null, told: false });
    this.leaveStray(local);
  }

  // A late join holds its seat while the bot may still be walking in, but
  // not for good. After lateJoinMs, Meet Bot's list says where the bot sits:
  // a room the pool does not hold is a late join's, so it is left, and every
  // late join asked about stops holding a seat. A join still inside its own
  // time limit may already show in the list, so the check waits for it.
  checkLate() {
    if (this.lateTimer || ![...this.late.values()].some((l) => l.method === 'join' && !l.settled)) return;
    const child = this.child;
    this.lateTimer = setTimeout(async () => {
      const again = () => { this.lateTimer = null; if (this.child === child) this.checkLate(); };
      const joining = () => [...this.pending.values()].some((p) => p.method === 'join');
      if (this.child !== child) return;
      if (joining()) { again(); return; }
      const asked = [...this.late.values()].filter((l) => l.method === 'join' && !l.settled);
      let rows;
      try { rows = await this.callWithin(this.pool.infoMs, 'list'); }
      catch (e) { log('worker ' + this.index + ': could not check late joins: ' + ((e && e.message) || e)); again(); return; }
      if (this.child !== child) return;
      if (joining()) { again(); return; }
      for (const row of Array.isArray(rows) ? rows : []) {
        const local = String((row && row.id) || '');
        if (!local || this.rooms.has(local) || this.stray.has(local)) continue;
        log('worker ' + this.index + ': a join that never answered left the bot in ' + local + '; leaving it');
        this.stray.set(local, { timer: null, told: false });
        this.leaveStray(local);
      }
      for (const l of asked) { if (!l.settled) { l.settled = true; this.lateJoins--; } }
      again();
    }, this.pool.lateJoinMs);
    this.lateTimer.unref();
  }

  // A leave that never answers would keep its seat until someone leaves
  // again. Meet Bot's list says whether the bot is still in the room: one it
  // no longer lists is freed and counts as left. One it lists keeps its seat,
  // since the bot is there, and a late answer or a second leave frees it.
  checkLateLeaves() {
    if (this.leaveTimer || ![...this.late.values()].some((l) => l.method === 'leave' && !l.settled)) return;
    const child = this.child;
    this.leaveTimer = setTimeout(async () => {
      const again = () => { this.leaveTimer = null; if (this.child === child) this.checkLateLeaves(); };
      if (this.child !== child) return;
      const asked = [...this.late.values()].filter((l) => l.method === 'leave' && !l.settled);
      let rows;
      try { rows = await this.callWithin(this.pool.infoMs, 'list'); }
      catch (e) { log('worker ' + this.index + ': could not check late leaves: ' + ((e && e.message) || e)); again(); return; }
      if (this.child !== child) return;
      const listed = new Set((Array.isArray(rows) ? rows : []).map((row) => String((row && row.id) || '')));
      for (const l of asked) {
        l.settled = true;
        const local = String(l.args[0]);
        if (listed.has(local) || !this.rooms.delete(local)) continue;
        log('worker ' + this.index + ': a leave that never answered did leave ' + local + '; seat freed');
        this.leftLate.add(local);
      }
      again();
    }, this.pool.lateLeaveMs);
    this.leaveTimer.unref();
  }

  // One log line per stranded room, not one per retry.
  leaveStray(local) {
    const child = this.child;
    this.call('leave', local).then(() => this.dropStray(local), (e) => {
      const text = String((e && e.message) || e);
      if (GONE_RE.test(text)) { this.dropStray(local); return; }
      const s = this.stray.get(local);
      if (this.child !== child || !s || s.timer) return;
      if (!s.told) log('worker ' + this.index + ': late leave of ' + local + ' failed, trying again every ' + this.pool.leaveRetryMs + 'ms: ' + text);
      s.told = true;
      s.timer = setTimeout(() => {
        s.timer = null;
        if (this.child === child && this.stray.get(local) === s) this.leaveStray(local);
      }, this.pool.leaveRetryMs);
      s.timer.unref();
    });
  }

  dropStray(local) {
    const s = this.stray.get(local);
    if (s) clearTimeout(s.timer);
    this.stray.delete(local);
  }

  clearStray() {
    for (const s of this.stray.values()) clearTimeout(s.timer);
    this.stray.clear();
  }

  async ready() {
    const child = this.child;
    try { await this.call('ensureStarted'); }
    catch (e) {
      // A process that died is handled by lost(). One still up whose browser
      // failed (or timed out) backs off like a restart.
      if (this.child && (!child || this.child === child) && this.state !== 'closing') {
        this.startFailures++;
        this.startRetryAt = this.pool.now() + Math.min(this.pool.backoffMaxMs, this.pool.backoffMs * 2 ** (this.startFailures - 1));
        this.startError = String((e && e.message) || e);
        log('worker ' + this.index + ': browser did not start: ' + this.startError);
      }
      throw e;
    }
    this.startFailures = 0;
    this.startRetryAt = 0;
    this.startError = '';
    if (this.state === 'up') this.state = 'ready';
    if (this.pool.voice && this.voice !== this.pool.voice) await this.pushVoice(this.pool.voice).catch(() => {});
  }

  voicePending() {
    return !!this.pool.voice && this.voice !== this.pool.voice;
  }

  // Marked as carrying settings only once the worker took them. One that
  // refused or timed out is asked again on its next join and on a timer, so
  // the rooms it already holds do not keep the old voice. A retry, a join
  // and set_voice share one call per settings object.
  pushVoice(settings) {
    if (this.voicing && this.voicing.settings === settings) return this.voicing.promise;
    const child = this.child;
    const promise = this.call('setVoice', settings).then((r) => {
      if (this.child === child) this.voice = settings;
      return r;
    }).finally(() => {
      if (this.voicing && this.voicing.promise === promise) this.voicing = null;
      if (this.child === child) this.retryVoice();
    });
    this.voicing = { settings, promise };
    return promise;
  }

  retryVoice() {
    if (this.voiceTimer || !this.voicePending() || this.state !== 'ready') return;
    this.voiceTimer = setTimeout(() => {
      this.voiceTimer = null;
      if (!this.voicePending() || this.state !== 'ready') return;
      this.pushVoice(this.pool.voice).catch((e) => log('worker ' + this.index + ': setVoice retry failed: ' + ((e && e.message) || e)));
    }, this.pool.voiceRetryMs);
    this.voiceTimer.unref();
  }

  async close() {
    if (!this.child) { this.state = 'stopped'; return; }
    const child = this.child;
    this.state = 'closing';
    clearInterval(this.beat);
    clearTimeout(this.voiceTimer);
    this.voiceTimer = null;
    clearTimeout(this.lateTimer);
    this.lateTimer = null;
    clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
    this.clearStray();
    const exited = new Promise((r) => child.once('exit', r));
    try { child.send({ type: 'close' }); } catch (e) { /* already gone */ }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, this.pool.closeMs);
    await exited;
    clearTimeout(t);
  }
}

export class WorkerPool {
  // opts: { workers, rooms, onThinking(sessionId, on), onLost(sessionIds, why), forkWorker(index, { tmpDir }), closeMs,
  //         now(), heartbeatMs, stuckMs, backoffMs, backoffMaxMs, stableMs, callMs, joinMs, infoMs, voiceRetryMs,
  //         leaveRetryMs, lateJoinMs, lateLeaveMs, bootMs }
  constructor(cfg, creds, opts = {}) {
    this.cfg = cfg;
    this.creds = creds;
    this.size = opts.workers > 0 ? opts.workers : 1;
    this.rooms = opts.rooms > 0 ? opts.rooms : Math.max(1, Math.ceil((cfg.maxMeetings || 1) / this.size));
    this.onThinking = typeof opts.onThinking === 'function' ? opts.onThinking : () => {};
    this.lostHooks = [];
    if (typeof opts.onLost === 'function') this.lostHooks.push(opts.onLost);
    this.closeMs = opts.closeMs > 0 ? opts.closeMs : 10000;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.heartbeatMs = opts.heartbeatMs > 0 ? opts.heartbeatMs : 5000;
    this.stuckMs = opts.stuckMs > 0 ? opts.stuckMs : 30000;
    this.backoffMs = opts.backoffMs > 0 ? opts.backoffMs : 1000;
    this.backoffMaxMs = opts.backoffMaxMs > 0 ? opts.backoffMaxMs : 60000;
    this.stableMs = opts.stableMs > 0 ? opts.stableMs : 60000;
    // A browser start chains several page waits of cfg.timeoutMs each.
    this.callMs = opts.callMs > 0 ? opts.callMs : 60000;
    this.joinMs = opts.joinMs > 0 ? opts.joinMs : 5 * (cfg.timeoutMs || 120000);
    // A first boot may fetch the Kokoro weights; give it one join window.
    this.bootMs = opts.bootMs > 0 ? opts.bootMs : this.joinMs;
    this.infoMs = opts.infoMs > 0 ? opts.infoMs : 3000;
    this.voiceRetryMs = opts.voiceRetryMs > 0 ? opts.voiceRetryMs : 10000;
    this.leaveRetryMs = opts.leaveRetryMs > 0 ? opts.leaveRetryMs : 10000;
    // A late join gets one more join window to answer before the list check.
    this.lateJoinMs = opts.lateJoinMs > 0 ? opts.lateJoinMs : this.joinMs;
    // A late leave gets one more call window.
    this.lateLeaveMs = opts.lateLeaveMs > 0 ? opts.lateLeaveMs : this.callMs;
    const script = opts.workerScript || WORKER_SCRIPT;
    this.forkWorker = typeof opts.forkWorker === 'function'
      ? opts.forkWorker
      : (index, { tmpDir }) => fork(script, [], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, TMPDIR: tmpDir, GIFOS_WORKER_TMP: tmpDir },
      });
    this.workers = Array.from({ length: this.size }, (_, i) => new Worker(this, i));
    this.closed = false;
    this.thinking = new Set();
    this.voice = null;
    const pool = this;
    // What server.js reads as bot.queue: thinking per session, leave drops it.
    this.queue = {
      isThinking(id) { return pool.thinking.has(String(id || '')); },
      leave(id) { pool.setThinking(String(id || ''), false); },
    };
  }

  onLost(fn) {
    this.lostHooks.push(fn);
    return () => { this.lostHooks = this.lostHooks.filter((f) => f !== fn); };
  }

  setThinking(id, on) {
    if (!id) return;
    const prev = this.thinking.has(id);
    if (prev === !!on) return;
    if (on) this.thinking.add(id); else this.thinking.delete(id);
    try { this.onThinking(id, !!on); } catch (e) { /* the call still finishes */ }
  }

  thinkingFrom(index, local, on) {
    this.setThinking('w' + index + ':' + local, on);
  }

  lostFrom(index, sessionIds, why) {
    for (const id of sessionIds) this.setThinking(id, false);
    for (const fn of this.lostHooks) {
      try { fn(sessionIds, why, index); } catch (e) { log('lost hook: ' + ((e && e.message) || e)); }
    }
  }

  // Warm the worker the next join would pick, so it does not wait for a
  // browser. Worker 0 first, unless it is waiting out a restart.
  async ensureStarted() {
    const up = this.workers.find((w) => w.state === 'ready');
    if (up) return;
    const tried = new Set();
    let err = null;
    for (let w = this.pick(tried); w; w = this.pick(tried)) {
      if (this.closed) throw closedError();
      tried.add(w);
      try { await w.ready(); return; } catch (e) { err = err || e; }
    }
    if (this.closed) throw closedError();
    if (err) throw err;
    await this.workers[0].ready();
  }

  // Most free rooms first. A worker that is already up beats one that would
  // have to start, so the second room does not wait for a second browser.
  pick(skip = null) {
    const open = this.workers.filter((w) => w.used < this.rooms && w.waitMs() === 0 && !(skip && skip.has(w)));
    if (!open.length) return null;
    const warm = (w) => (w.state === 'ready' || w.state === 'up' ? 0 : 1);
    open.sort((a, b) => warm(a) - warm(b) || a.used - b.used || a.index - b.index);
    return open[0];
  }

  // Whether a join now would find a worker. A lost worker's rooms are not
  // seats until it restarts.
  hasSeat() {
    return !!this.pick();
  }

  // A worker whose browser fails to start is skipped for the next one. A
  // join that fails in the room is the room's fault and is not retried. A
  // worker process that dies mid-join took its browser with it, so the join
  // goes to the next worker, but only once: a room that kills every worker
  // it reaches should not take the whole pool down.
  async join(link, password) {
    const tried = new Set();
    let err = null;
    let died = false;
    for (let w = this.pick(tried); w; w = this.pick(tried)) {
      // A join that outlived close() must not start the next worker.
      if (this.closed) throw closedError();
      tried.add(w);
      w.reserved++;
      try {
        try { await w.ready(); } catch (e) { err = err || e; continue; }
        const child = w.child;
        let local;
        try { local = await w.call('join', link, password || ''); }
        catch (e) {
          if (this.closed || w.child === child) throw e;
          // The clock waits longer before it brings such a room back.
          e.code = 'worker_died';
          if (died) throw e;
          died = true;
          log('worker ' + w.index + ' died during a join; trying the next worker');
          err = e;
          continue;
        }
        w.rooms.add(String(local));
        w.leftLate.delete(String(local));
        return 'w' + w.index + ':' + local;
      } finally {
        w.reserved--;
      }
    }
    if (this.closed) throw closedError();
    if (err) throw err;
    const waiting = this.workers.find((x) => x.used < this.rooms && x.waitMs() > 0);
    if (waiting) throw waiting.waitError();
    throw noSeat('Every worker is full (' + this.size + ' workers, ' + this.rooms + ' rooms each).');
  }

  // Every name this machine's bots sit under. A caption from any of them is
  // the bot's own speech, whichever worker holds the room.
  botNames() {
    return this.workers.map((w) => workerIdentity(this.cfg, this.creds, w.index).creds.name);
  }

  botNameFor(sessionId) {
    const s = splitSession(sessionId);
    return s && this.workers[s.index] ? workerIdentity(this.cfg, this.creds, s.index).creds.name : this.creds.name;
  }

  route(sessionId) {
    const s = splitSession(sessionId);
    const w = s && this.workers[s.index];
    if (!w || !w.rooms.has(s.local)) throw new Error('No worker holds session ' + JSON.stringify(String(sessionId)) + '.');
    return { w, local: s.local };
  }

  async leave(sessionId) {
    const s = splitSession(sessionId);
    const left = s && this.workers[s.index];
    if (left && left.leftLate.delete(s.local)) { this.setThinking(String(sessionId), false); return; }
    const { w, local } = this.route(sessionId);
    this.setThinking(String(sessionId), false);
    try { await w.call('leave', local); }
    catch (e) {
      if (!GONE_RE.test((e && e.message) || '')) throw e;
    }
    w.rooms.delete(local);
    w.leftLate.delete(local);   // the list check may have freed it meanwhile
  }

  async transcribe(id, on) { const r = this.route(id); return r.w.call('transcribe', r.local, !!on); }
  async say(id, text) { const r = this.route(id); return r.w.call('say', r.local, String(text)); }
  async people(id) { const r = this.route(id); return r.w.call('people', r.local); }
  async transcript(id) { const r = this.route(id); return r.w.call('transcript', r.local); }
  async chat(id) { const r = this.route(id); return r.w.call('chat', r.local); }
  async interject(id, text, opts) { const r = this.route(id); return r.w.call('interject', r.local, String(text), opts && opts.voice ? { voice: String(opts.voice) } : undefined); }
  async raiseHand(id, on) { const r = this.route(id); return r.w.call('raiseHand', r.local, !!on); }
  async setMic(id, on) { const r = this.route(id); return r.w.call('setMic', r.local, !!on); }
  async setCamera(id, on) { const r = this.route(id); return r.w.call('setCamera', r.local, !!on); }
  async meetingState(id) { const r = this.route(id); return r.w.call('meetingState', r.local); }
  async snapshot(id) { const r = this.route(id); return r.w.call('snapshot', r.local); }

  async list() {
    const ready = this.workers.filter((w) => w.state === 'ready');
    const all = await Promise.all(ready.map((w) => w.callWithin(this.infoMs, 'list').catch(() => [])));
    const out = [];
    ready.forEach((w, i) => {
      for (const row of all[i] || []) out.push({ ...row, id: 'w' + w.index + ':' + row.id, worker: w.index });
    });
    return out;
  }

  // Voice switches stay global (open question 7). Every ready worker is
  // asked at once, so one that refuses or never answers does not keep the
  // rest on the old voice. A worker that starts later, restarts, or missed
  // this call gets the same settings in ready().
  async setVoice(settings) {
    this.voice = settings;
    const ready = this.workers.filter((w) => w.state === 'ready');
    const got = await Promise.all(ready.map((w) => w.pushVoice(settings).then((v) => ({ v }), (e) => ({ e }))));
    const first = got.find((g) => !g.e);
    got.forEach((g, i) => { if (g.e) log('worker ' + ready[i].index + ': setVoice failed: ' + ((g.e && g.e.message) || g.e)); });
    if (first) return first.v;
    if (got.length) throw got[0].e;
    return { applied: true, result: null };
  }

  async info() {
    const asked = this.workers.map((w) => (w.state === 'ready' ? w.callWithin(this.infoMs, 'info').then((v) => ({ v }), (e) => ({ e })) : null));
    const workers = [];
    const sessions = [];
    for (const [i, w] of this.workers.entries()) {
      const row = { worker: w.index, state: w.state, rooms: w.rooms.size, budget: this.rooms };
      if (w.botName) row.bot_name = w.botName;
      if (w.child && w.child.pid) row.pid = w.child.pid;
      if (w.error) row.error = w.error;
      if (w.restartInMs() > 0) row.restart_in_ms = w.restartInMs();
      if (w.startRetryInMs() > 0) { row.start_retry_in_ms = w.startRetryInMs(); row.error = w.startError; }
      if (w.state === 'ready' && w.voicePending()) row.voice = 'pending';
      if (w.stray.size) row.stray_rooms = w.stray.size;
      if (w.lateJoins) row.late_joins = w.lateJoins;
      const got = asked[i] && await asked[i];
      if (got && got.e) row.error = String((got.e && got.e.message) || got.e);
      else if (got) {
        const inf = got.v;
        row.connected = !!(inf && inf.connected);
        for (const s of (inf && inf.bot_sessions) || []) sessions.push({ ...s, session_id: 'w' + w.index + ':' + s.session_id, worker: w.index });
      }
      workers.push(row);
    }
    const ready = workers.filter((r) => r.state === 'ready').length;
    return {
      state: ready ? 'ready' : (workers.some((r) => r.state === 'starting' || r.state === 'up') ? 'starting' : 'stopped'),
      bot_name: this.creds.name,
      workers,
      bot_sessions: sessions,
    };
  }

  async close() {
    this.closed = true;
    await Promise.all(this.workers.map((w) => w.close()));
  }
}
