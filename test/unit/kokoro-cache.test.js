// Kokoro's weights on disk. Weights come from a local stand-in for the
// Hugging Face layout (GIFOS_KOKORO_URL), so nothing here downloads the
// real 90 MB model. Every home is removed after its test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { weightsCache, KOKORO_REVISION } from '../../src/voice/kokoro.js';
import { tmpHome } from './fixtures/tmp-home.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'fixtures', 'kokoro-child.js');
const BIN = path.join(HERE, 'fixtures', 'server-bin.js');
const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const MODEL = 'onnx/model_quantized.onnx';
const CONFIG = JSON.stringify({ model_type: 'style_text_to_speech_2' });

// files: name -> Buffer (served whole, or from a Range start) | { partial,
// total, bytes? } (sends the first partial bytes of total, then stalls) |
// missing (stalls with no answer). ranges lists each request's Range and
// If-Range headers. Like the Hugging Face CDN, every answer carries a strong
// ETag (the sha256 of the bytes, or `etag`; null sends none) and If-Range
// is ignored.
const shaOf = (b) => crypto.createHash('sha256').update(b).digest('hex');
// The stand-in files are not the real weights: tests that read them through
// the cache name their own hashes.
const pinned = (b) => ({ [MODEL]: shaOf(b) });
const tagOf = (b) => '"' + crypto.createHash('sha256').update(b).digest('hex') + '"';
async function weightsServer(t, files, { etag } = {}) {
  const asked = [];
  const ranges = [];
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    const m = new RegExp('^/' + REPO.replace('/', '\\/') + '/resolve/[^/]+/(.+)$').exec(req.url);
    const name = m ? decodeURIComponent(m[1]) : req.url;
    asked.push(name);
    ranges.push({ name, range: req.headers.range || null, ifRange: req.headers['if-range'] || null });
    const f = files[name];
    const whole = Buffer.isBuffer(f) ? f : f && f.bytes;
    const tag = etag !== undefined ? etag : whole ? tagOf(whole) : null;
    if (tag) res.setHeader('etag', tag);
    const from = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    if (Buffer.isBuffer(f) && from && Number(from[1]) < f.length) {
      const start = Number(from[1]);
      res.writeHead(206, { 'content-length': f.length - start, 'content-range': 'bytes ' + start + '-' + (f.length - 1) + '/' + f.length });
      res.end(f.subarray(start));
      return;
    }
    if (Buffer.isBuffer(f)) { res.writeHead(200, { 'content-length': f.length }); res.end(f); return; }
    if (f && f.partial) {
      res.writeHead(200, { 'content-length': f.total });
      res.write(f.bytes ? f.bytes.subarray(0, f.partial) : Buffer.alloc(f.partial, 7));
      return;
    }
    // Stall: the model's own fetch stays in flight until the test ends.
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { host: 'http://127.0.0.1:' + server.address().port, asked, ranges, paths };
}

function freshHome(t) {
  const home = tmpHome('gifos-mcp-kokoro-cache-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const modelDir = (home) => path.join(home, 'kokoro', REPO);

// A running child renames part files under the folder while a test polls
// it, so a name readdir gave may be gone by the stat: skip it.
function statOf(p) {
  try { return fs.statSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const sizeOf = (p) => { const st = statOf(p); return st ? st.size : -1; };

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .map((rel) => path.join(dir, rel))
    .filter((p) => statOf(p)?.isFile());
}

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for ' + what);
}

function run(file, args, env) {
  const proc = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '', code: null };
  proc.stdout.on('data', (d) => { out.stdout += d; });
  proc.stderr.on('data', (d) => { out.stderr += d; });
  out.done = new Promise((r) => proc.on('exit', (code, signal) => { out.code = code; out.signal = signal; r(out); }));
  out.proc = proc;
  return out;
}

test('a download killed halfway leaves no model file that the next start would trust', async (t) => {
  const home = freshHome(t);
  const w = await weightsServer(t, {
    'config.json': Buffer.from(CONFIG),
    [MODEL]: { partial: 300000, total: 1000000 },
  });
  const child = run(CHILD, [home, w.host]);
  t.after(() => child.proc.kill('SIGKILL'));
  await until(() => filesUnder(modelDir(home)).some((p) => sizeOf(p) >= 300000), 20000, 'the partial model on disk');
  child.proc.kill('SIGKILL');
  await child.done;
  assert.equal(fs.existsSync(path.join(modelDir(home), MODEL)), false,
    'only a finished download may sit at the model path; found ' + JSON.stringify(filesUnder(modelDir(home)).map((p) => path.relative(home, p) + ' ' + sizeOf(p))));
});

test('a model file that is not the pinned one is never loaded: it is fetched again, at most twice, then the error is plain', async (t) => {
  const home = freshHome(t);
  // A half file from an older run that wrote straight to the model path.
  fs.mkdirSync(path.join(modelDir(home), 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(modelDir(home), 'config.json'), CONFIG);
  fs.writeFileSync(path.join(modelDir(home), MODEL), Buffer.alloc(4000, 7));
  const w = await weightsServer(t, {
    'config.json': Buffer.from(CONFIG),
    [MODEL]: Buffer.alloc(4000, 9),
  });
  const child = run(CHILD, [home, w.host]);
  t.after(() => child.proc.kill('SIGKILL'));
  const out = await Promise.race([child.done, new Promise((r) => setTimeout(() => r(null), 60000).unref())]);
  assert.ok(out, 'installKokoro settles; stderr: ' + child.stderr.slice(-2000));
  const asked = w.asked.filter((n) => n === MODEL).length;
  assert.ok(asked >= 1 && asked <= 2, 'the bad model is downloaded again, once per try; asked ' + JSON.stringify(w.asked));
  assert.equal(out.code, 1, 'the load fails as a rejection, not a crash; stderr: ' + out.stderr.slice(-2000));
  const line = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.equal(line.ok, false);
  assert.match(line.error, /Kokoro/);
  assert.equal(fs.existsSync(path.join(modelDir(home), MODEL)), false, 'a file that is not the pinned one is removed');
});

test('weights are asked for at the pinned revision, never a moving branch', async (t) => {
  const home = freshHome(t);
  const w = await weightsServer(t, { 'config.json': Buffer.from(CONFIG), [MODEL]: Buffer.alloc(64, 1) });
  const child = run(CHILD, [home, w.host]);
  t.after(() => child.proc.kill('SIGKILL'));
  await Promise.race([child.done, new Promise((r) => setTimeout(r, 60000).unref())]);
  assert.ok(w.paths.length > 0, 'the stand-in was asked');
  for (const p of w.paths) assert.match(p, new RegExp('/resolve/' + KOKORO_REVISION + '/'), p);
});

test('the server stays up and says Kokoro is not available when the weights will not load', async (t) => {
  const home = freshHome(t);
  fs.mkdirSync(path.join(modelDir(home), 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(modelDir(home), 'config.json'), CONFIG);
  fs.writeFileSync(path.join(modelDir(home), MODEL), Buffer.alloc(4000, 7));
  const w = await weightsServer(t, {
    'config.json': Buffer.from(CONFIG),
    [MODEL]: Buffer.alloc(4000, 9),
  });
  const bin = run(BIN, [], {
    GIFOS_MCP_HOME: home, GIFOS_MCP_LAZY: '1', GIFOS_KOKORO_URL: w.host, GIFOS_URL: 'https://gifos.app',
    GIFOS_VOICE: '0', GIFOS_LLM_URL: '', GIFOS_LLM_KEY: '', GIFOS_TTS_ENGINE: '', GIFOS_TTS_URL: '', GIFOS_TTS_APP: '', GIFOS_WORKERS: '1',
  });
  t.after(() => bin.proc.kill('SIGKILL'));
  const seen = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 20000);
    const look = () => {
      if (/Kokoro is not available/.test(bin.stderr) && /ready on stdio/.test(bin.stderr)) {
        clearTimeout(timer); resolve(true);
      }
    };
    bin.proc.stderr.on('data', look);
    bin.proc.on('exit', () => { clearTimeout(timer); resolve(false); });
    look();
  });
  assert.equal(bin.proc.exitCode, null, 'the server stays up; stderr: ' + bin.stderr.slice(-2000));
  assert.ok(seen, 'logged Kokoro is not available after ready; stderr: ' + bin.stderr.slice(-2000));
  assert.match(bin.stderr, /Kokoro is not available/);
  assert.equal(/var A=void 0/.test(bin.stderr), false, 'no minified phonemizer source in the log');
});

// Bytes that differ along the file, so a resume that lands at the wrong
// offset gives a different file.
const pattern = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + (i >> 9)) % 251));

async function deadPid() {
  const p = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => p.on('exit', r));
  return p.pid;
}

test('a start after a download was killed asks only for the bytes it does not have', async (t) => {
  const home = freshHome(t);
  const whole = pattern(1000000);
  const first = await weightsServer(t, {
    'config.json': Buffer.from(CONFIG),
    [MODEL]: { partial: 300000, total: whole.length, bytes: whole },
  });
  const child = run(CHILD, [home, first.host]);
  t.after(() => child.proc.kill('SIGKILL'));
  await until(() => filesUnder(modelDir(home)).some((p) => p.endsWith('.part') && sizeOf(p) >= 300000), 20000, 'the partial model on disk');
  child.proc.kill('SIGKILL');
  await child.done;
  const kept = filesUnder(modelDir(home)).filter((p) => p.endsWith('.part')).map((p) => sizeOf(p));
  // The next start (a worker restarted after its boot ran out of time).
  const second = await weightsServer(t, { 'config.json': Buffer.from(CONFIG), [MODEL]: whole });
  const again = run(CHILD, [home, second.host]);
  t.after(() => again.proc.kill('SIGKILL'));
  await Promise.race([again.done, new Promise((r) => setTimeout(r, 60000).unref())]);
  const asks = second.ranges.filter((r) => r.name === MODEL);
  assert.ok(asks.length >= 1, 'the model is asked for; asked ' + JSON.stringify(second.ranges));
  assert.equal(asks[0].range, 'bytes=' + kept[0] + '-',
    'the first ask for the model resumes from the ' + JSON.stringify(kept) + ' bytes kept; asks ' + JSON.stringify(asks));
});

test('a resumed download puts the kept bytes and the rest together in order', async (t) => {
  const home = freshHome(t);
  const whole = pattern(1000000);
  await killedPart(t, home, whole, 300000);
  const w = await weightsServer(t, { [MODEL]: whole });
  const dir = path.join(home, 'kokoro');
  const file = path.join(dir, REPO, MODEL);
  const cache = weightsCache(dir, w.host, pinned(whole));
  const res = await cache.match(w.host + '/' + REPO + '/resolve/main/' + MODEL);
  assert.equal(res, undefined, 'the finished file is left on disk for the local read');
  assert.ok(fs.readFileSync(file).equals(whole), 'the file on disk is the whole file');
  assert.deepEqual(w.ranges, [{ name: MODEL, range: 'bytes=300000-', ifRange: tagOf(whole) }]);
  assert.deepEqual(filesUnder(path.dirname(file)), [file], 'no part file (or its tag) is left');
});

test('a server that ignores Range gives the whole file, not the kept bytes twice', async (t) => {
  const home = freshHome(t);
  const whole = pattern(500000);
  await killedPart(t, home, whole, 200000);
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-length': whole.length, etag: tagOf(whole) }); res.end(whole); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const host = 'http://127.0.0.1:' + server.address().port;
  const dir = path.join(home, 'kokoro');
  const file = path.join(dir, REPO, MODEL);
  await weightsCache(dir, host, pinned(whole)).match(host + '/' + REPO + '/resolve/main/' + MODEL);
  assert.ok(fs.readFileSync(file).equals(whole), 'the file on disk is the whole file');
});

// A part file the way a real start leaves it: a child downloading `whole`
// is killed after `partial` bytes. etag is what that server sent (null: none).
async function killedPart(t, home, whole, partial, etag) {
  const w = await weightsServer(t, {
    'config.json': Buffer.from(CONFIG),
    [MODEL]: { partial, total: whole.length, bytes: whole },
  }, { etag });
  const child = run(CHILD, [home, w.host]);
  t.after(() => child.proc.kill('SIGKILL'));
  await until(() => filesUnder(modelDir(home)).some((p) => p.endsWith('.part') && sizeOf(p) >= partial), 20000, 'the partial model on disk');
  child.proc.kill('SIGKILL');
  await child.done;
}

test('a part of an older version of the model is not joined to the new one', async (t) => {
  const home = freshHome(t);
  const v1 = pattern(600000);
  const v2 = Buffer.from(v1.map((b) => (b + 1) % 251));
  await killedPart(t, home, v1, 200000);
  // The model changed upstream; the CDN still answers the Range with a 206.
  const w = await weightsServer(t, { [MODEL]: v2 });
  const dir = path.join(home, 'kokoro');
  const file = path.join(dir, REPO, MODEL);
  const res = await weightsCache(dir, w.host, pinned(v2)).match(w.host + '/' + REPO + '/resolve/main/' + MODEL);
  if (res) assert.ok(Buffer.from(await res.arrayBuffer()).equals(v2), 'an answer from the cache is the new file, not old bytes + new bytes');
  if (fs.existsSync(file)) assert.ok(fs.readFileSync(file).equals(v2), 'the file on disk is the new file, not old bytes + new bytes');
  assert.deepEqual(filesUnder(path.dirname(file)).filter((p) => p.endsWith('.part')), [], 'the old part is dropped');
});

test('a resume tells the server which version its kept bytes are from', async (t) => {
  const home = freshHome(t);
  const whole = pattern(600000);
  await killedPart(t, home, whole, 200000);
  const w = await weightsServer(t, { [MODEL]: whole });
  const dir = path.join(home, 'kokoro');
  await weightsCache(dir, w.host, pinned(whole)).match(w.host + '/' + REPO + '/resolve/main/' + MODEL);
  assert.ok(fs.readFileSync(path.join(dir, REPO, MODEL)).equals(whole), 'the same version is resumed into the whole file');
  const ask = w.ranges.find((r) => r.name === MODEL);
  assert.ok(ask && /^bytes=\d+-$/.test(ask.range), 'the model is asked for from the kept bytes on; asked ' + JSON.stringify(w.ranges));
  assert.equal(ask.ifRange, tagOf(whole), 'the Range is sent with If-Range: the ETag the kept bytes came with');
});

test('a part from a server that gave no version tag is downloaded again, not resumed', async (t) => {
  const home = freshHome(t);
  const whole = pattern(600000);
  await killedPart(t, home, whole, 200000, null);
  const w = await weightsServer(t, { [MODEL]: whole }, { etag: null });
  const dir = path.join(home, 'kokoro');
  await weightsCache(dir, w.host).match(w.host + '/' + REPO + '/resolve/main/' + MODEL);
  assert.deepEqual(w.ranges.filter((r) => r.range), [], 'no Range is asked for bytes nobody can vouch for; asked ' + JSON.stringify(w.ranges));
  assert.deepEqual(filesUnder(path.join(dir, REPO)).filter((p) => p.endsWith('.part')), [], 'the unvouched part is dropped');
});

// transformers.js cannot use a cache hit for a model file (it ends in "Unable
// to get model file path or buffer"), so a file on disk is read as a local model.
test('a file already on disk is checked and left to be read from disk; only the lookup after put() gets bytes', async (t) => {
  const home = freshHome(t);
  const whole = pattern(5000);
  const host = 'http://127.0.0.1:9';
  const dir = path.join(home, 'kokoro');
  const key = host + '/' + REPO + '/resolve/' + KOKORO_REVISION + '/' + MODEL;
  const cache = weightsCache(dir, host, pinned(whole));
  await cache.put(key, new Response(whole, { headers: { 'content-length': String(whole.length) } }));
  const res = await cache.match(key);
  assert.ok(res && Buffer.from(await res.arrayBuffer()).equals(whole), 'the lookup right after put() gets the bytes');
  assert.equal(await cache.match(key), undefined, 'a later lookup leaves the checked file to the local read');
  assert.equal(await weightsCache(dir, host, pinned(whole)).match(key), undefined, 'so does the next start');
  assert.ok(fs.readFileSync(path.join(dir, REPO, MODEL)).equals(whole), 'the file stays');
});

// A running child renames its part files (.part, .part.tag) while a test
// polls the folder; one gone between readdir and stat must not throw.
test('listing the model folder skips a file renamed away under it', (t) => {
  const home = freshHome(t);
  const dir = modelDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), CONFIG);
  const readdir = fs.readdirSync;
  // As if the child renamed config.json.1.part.tag right after readdir.
  fs.readdirSync = (...a) => [...readdir(...a), 'config.json.1.part.tag'];
  let found;
  try { found = filesUnder(dir); } finally { fs.readdirSync = readdir; }
  assert.deepEqual(found, [path.join(dir, 'config.json')]);
});
