// Score a guard-siblings.sh run: node guard-siblings-score.js <out dir>
// PASS: from 300 s (rank 0's clock) to the end, at every moment exactly one sibling leads, the lead holds its ticket and
// the room's capture; the observer seat saw the greeting; each browser joined only the guarded room with the plan; and
// no ticket was refused as moved.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return ''; } };
// STATE lines: "  12.3s [r0] STATE role=lead cap=mine ticket=held/pass". r1 starts 60 s after r0: shift its clock.
const states = [];
for (const [f, shift] of [['r0.log', 0], ['r1.log', 60]]) {
  for (const l of read(f).split('\n')) {
    const m = l.match(/^\s*([\d.]+)s \[r(\d)\] STATE role=(\S+) cap=(\S+) ticket=(\S+)/);
    if (m) states.push({ t: Number(m[1]) + shift, r: Number(m[2]), role: m[3], cap: m[4], ticket: m[5] });
  }
}
states.sort((a, b) => a.t - b.t);
// STATE lines print only on a change, so the run's end is its FINAL line (each sibling prints one when it stops).
const finals = [];
for (const [f, shift] of [['r0.log', 0], ['r1.log', 60]]) { const m = read(f).match(/^\s*([\d.]+)s \[r\d\] FINAL /m); if (m) finals.push(Number(m[1]) + shift); }
const end = finals.length === 2 ? Math.min(...finals) : 0;
const cur = {};
const bad = [];
let i = 0;
for (let t = 0; t <= end + 1; t += 1) {
  while (i < states.length && states[i].t <= t) { cur[states[i].r] = states[i]; i++; }
  if (t < 300) continue;
  const leads = Object.values(cur).filter((s) => s.role === 'lead');
  if (leads.length !== 1) bad.push(t + 's: ' + leads.length + ' leads (' + Object.values(cur).map((s) => 'r' + s.r + '=' + s.role + '/' + s.ticket + '/' + s.cap).join(' ') + ')');
  else if (!/^held/.test(leads[0].ticket) || leads[0].cap !== 'mine') bad.push(t + 's: the lead r' + leads[0].r + ' has ticket ' + leads[0].ticket + ' cap ' + leads[0].cap);
}
const obs = read('observer.log');
const greeted = /Welcome, [^!]*Observer/.test(obs);
const moves = (read('r0.log') + read('r1.log')).split('\n').filter((l) => / MOVED/.test(l));
// The meetings each sibling's browser joined with the plan: the guarded room only (one tag, shared by both).
const tags = {};
for (const f of ['r0.log', 'r1.log']) for (const l of read(f).split('\n')) { const m = l.match(/net \w+\/join mtg:(\w+)/); if (m) (tags[f] = tags[f] || new Set()).add(m[1]); }
const tagSets = Object.values(tags).map((t) => [...t].sort().join(','));
const oneMeeting = tagSets.length > 0 && tagSets.every((t) => t === tagSets[0] && !t.includes(','));
console.log('meetings joined with the plan: ' + Object.entries(tags).map(([f, t]) => f + '=' + [...t].join(',')).join(' ') + (oneMeeting ? ' (only the guarded room)' : ' (MORE THAN THE GUARDED ROOM)'));
console.log('one lead from 300 s: ' + (bad.length ? 'NO (' + bad.length + ' s bad; first ' + bad[0] + '; last ' + bad[bad.length - 1] + ')' : 'yes'));
console.log('observer greeted: ' + (greeted ? 'yes' : 'NO'));
console.log('ticket moves: ' + moves.length + (moves.length ? '\n  ' + moves.slice(0, 12).join('\n  ') : ''));
const scored = end > 300;
if (!scored) console.log('a sibling stopped before 300 s (no FINAL line past it): nothing to score');
// move mode: another session took the pass on purpose, so moves are expected; the siblings must have taken it back.
const moveMode = / move$/.test(read('run.txt').trim());
const retakes = (read('r0.log') + read('r1.log')).split('\n').filter((l) => /event guard.retake/.test(l)).length;
if (moveMode) console.log('move mode: ' + retakes + ' retake(s) by the siblings');
const ok = scored && !bad.length && greeted && oneMeeting && (moveMode ? moves.length > 0 && retakes > 0 : !moves.length);
console.log('VERDICT ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
