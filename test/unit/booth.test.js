// The booth's loop (src/booth.js): the next file the moment one ends, a loop, a bad-spot early end that starts the
// same file again past the spot, a stuck video and a new release that reload, and the tools' argument checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Booth, BoothPool } from '../../src/booth.js';
import { registerBoothTools } from '../../src/tools/booth.js';

function fakeBooth(files, { loop = true, latest = '' } = {}) {
  const site = { v: latest, latest() { return this.v; } };
  const pool = new BoothPool({ home: '/nonexistent', gifosUrl: 'https://gifos.app' }, { site });
  const b = new Booth(pool, { room: 'tv-test', verifier: 'a'.repeat(24), seedHex: '00', name: 'TV' });
  const model = { host: true, relay: true, hooks: true, rb: null, skips: 0, others: [] };
  const started = [], reloads = [];
  b.read = async () => ({ ...model });
  b.startFile = async (file, at) => { started.push([file, Math.round(at || 0)]); model.rb = { pos: at || 0, len: 100, paused: false, sending: true }; return { ok: true, pos: at || 0, len: 100 }; };
  b.reload = async (why) => { reloads.push(why); if (b.playing) b.resume = { i: b.playing.i, file: b.playing.file, pos: b.playing.pos }; b.playing = null; model.rb = null; b.loadedOn = site.latest(); };
  b.page = { evaluate: async () => {}, waitForFunction: async () => {} };
  b.pickNoBlur = async () => {};
  b.trace = async () => [];
  b.list = { files, loop, i: -1, clear: true, yieldToPeople: true };
  b.stopNow = async () => { model.rb = null; };
  b.loadedOn = latest;
  return { b, model, started, reloads, site };
}

test('plays the list in order and loops', async () => {
  const { b, model, started } = fakeBooth(['/a.webm', '/b.webm']);
  await b.tick();
  model.rb.pos = 100; await b.tick();          // playing, at its end
  model.rb = null; await b.tick();             // ended at its length: next file
  model.rb.pos = 99; await b.tick();
  model.rb = null; await b.tick();             // ended: the list starts again
  assert.deepEqual(started.map((s) => s[0]), ['/a.webm', '/b.webm', '/a.webm']);
  assert.equal(b.counts.early, 0);
});

test('a list without loop stops after its last file', async () => {
  const { b, model, started } = fakeBooth(['/a.webm'], { loop: false });
  await b.tick();
  model.rb.pos = 100; await b.tick();
  model.rb = null; await b.tick();
  assert.equal(started.length, 1);
  assert.equal(b.list, null);
});

test('an early end starts the same file past the spot, five times at most, then the next file', async () => {
  const { b, model, started } = fakeBooth(['/a.webm', '/b.webm']);
  await b.tick();
  for (let n = 1; n <= 6; n++) {
    model.rb.pos = 40; await b.tick();
    model.rb = null; await b.tick();
  }
  assert.deepEqual(started.slice(0, 6).map((s) => s[0]), Array(6).fill('/a.webm'));
  assert.deepEqual(started.slice(1, 6).map((s) => s[1]), [43, 46, 49, 52, 55]);
  assert.equal(started[6][0], '/b.webm', 'the sixth early end at the same place moves on');
  assert.equal(b.counts.early, 6);
});

test('a video that stands still reloads the page and carries on from the same second', async () => {
  const { b, model, started, reloads } = fakeBooth(['/a.webm']);
  await b.tick();
  model.rb.pos = 30; await b.tick();
  b.playing.movedAt = Date.now() - 25000;
  await b.tick();
  assert.equal(reloads.length, 1);
  assert.match(reloads[0], /stood still/);
  await b.tick();
  assert.deepEqual(started[1], ['/a.webm', 30]);
});

test('a new live release reloads in place and resumes', async () => {
  const { b, model, started, reloads, site } = fakeBooth(['/a.webm'], { latest: '0.9.28.57' });
  await b.tick();
  model.rb.pos = 12; await b.tick();
  site.v = '0.9.28.58';
  await b.tick();
  assert.match(reloads[0], /0\.9\.28\.58/);
  await b.tick();
  assert.deepEqual(started[1], ['/a.webm', 12]);
});

test('not the host for two minutes reloads; the page away for 45 s reloads', async () => {
  const { b, model, reloads } = fakeBooth(['/a.webm']);
  model.host = false;
  await b.tick();
  assert.equal(reloads.length, 0);
  b.notHostSince = Date.now() - 121000;
  await b.tick();
  assert.match(reloads[0], /not the host/);
  model.host = true; model.hooks = false;
  await b.tick();
  b.goneSince = Date.now() - 46000;
  await b.tick();
  assert.match(reloads[1], /went away/);
});

test('filler mode: a person on the Stage stops the video at once; the Stage free again resumes the same second', async () => {
  const { b, model, started } = fakeBooth(['/a.webm', '/b.webm']);
  await b.tick();
  model.rb.pos = 50; await b.tick();
  model.others = ['Ada']; model.rb.pos = 51;
  await b.tick();
  assert.equal(model.rb, null, 'the video stopped');
  assert.deepEqual(b.yielded.to, ['Ada']);
  await b.tick(); await b.tick();
  assert.equal(started.length, 1, 'nothing starts while a person has the Stage');
  assert.equal(b.counts.early, 0, 'a yield is not an early end');
  model.others = [];
  await b.tick();
  assert.equal(started.length, 1, 'waits a moment after the Stage is free');
  b.yielded.clearSince = Date.now() - 2000;
  await b.tick();
  assert.deepEqual(started[1], ['/a.webm', 51]);
  assert.equal(b.yielded, null);
  assert.equal(b.counts.yields, 1);
});

test('tools: path or paths, and a host password never comes back in an error', async () => {
  const tools = new Map();
  const server = { registerTool: (name, def, fn) => tools.set(name, { def, fn }) };
  const ctx = {
    cfg: { home: '/nonexistent' }, secrets: () => [],
    ok: (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] }),
    guarded: (fn) => async (a) => { try { return await fn(a); } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e.message) }] }; } },
  };
  registerBoothTools(server, ctx);
  assert.deepEqual([...tools.keys()].sort(), ['booth_status', 'close_booth', 'open_booth', 'play_video', 'publish_to_tv', 'stop_tv_listing', 'stop_video', 'update_tv_listing']);
  const r1 = await tools.get('play_video').fn({ booth_id: 'x', path: '/a', paths: ['/b'] });
  assert.ok(r1.isError && /path or paths/.test(r1.content[0].text));
  const r2 = await tools.get('play_video').fn({ booth_id: 'x', path: '/a' });
  assert.ok(r2.isError && /open_booth/.test(r2.content[0].text));
  const pw = 'secret-host-pw-123';
  const r3 = await tools.get('open_booth').fn({ link: 'https://gifos.app/cast#room=tv&v=' + 'b'.repeat(24), host_password: pw });
  assert.ok(r3.isError);
  assert.ok(!r3.content[0].text.includes(pw));
});

test('a credentials file is taken once, and again when the file changes (a new pass replaces the old)', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cred-'));
  try {
    const pool = new BoothPool({ home, gifosUrl: 'https://gifos.app' });
    fs.mkdirSync(path.join(home, 'booth-tv-test'));
    const used = [];
    const mk = (b64) => {
      const b = new Booth(pool, { room: 'tv-test', verifier: 'a'.repeat(24), seedHex: '00', name: 'TV', credentialsB64: b64 });
      b.page = { goto: async () => {}, waitForFunction: async () => true, evaluate: async (fn, arg) => { used.push(arg); return { loaded: true, added: 1, in_use: true, passes: used.length }; } };
      return b;
    };
    await mk('QUFB').loadCredentials();
    await mk('QUFB').loadCredentials();          // the same file: not loaded again
    assert.deepEqual(used, ['QUFB']);
    await mk('QkJC').loadCredentials();          // a new file: taken
    assert.deepEqual(used, ['QUFB', 'QkJC']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
