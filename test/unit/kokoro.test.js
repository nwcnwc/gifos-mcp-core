// Install downloads the pinned Kokoro once. The host binding then answers
// tts with that audio, and stt through a stand-in. There is no text model:
// a model row in the page's settings is dropped, and the page never fetches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installKokoro, KOKORO_MODEL, KOKORO_FILES } from '../../src/voice/kokoro.js';
import { MCP_TTS_APP } from '../../src/voice/settings.js';
import { bridgeScript, HOST_BINDING, speakAsTts } from '../../src/voice/providers.js';
import { packHostResult, serveHost } from '../../src/voice/host.js';

// The weights (~90 MB) are kept between runs in the user's cache, not under
// TMPDIR: a fresh TMPDIR per run would download them again into the /tmp quota.
const HOME = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'gifos-mcp-test-kokoro');
const LINE = 'Hello.';
const KEY = 'sk-test-key-which-must-stay-here';

function wavInfo(buf) {
  const b = Buffer.from(buf);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.toString('ascii', 8, 12), 'WAVE');
  const rate = b.readUInt32LE(24);
  const channels = b.readUInt16LE(22);
  const data = b.readUInt32LE(40);
  let energy = 0;
  const n = Math.min(data, b.length - 44) / 2;
  for (let i = 0; i < n; i++) energy += Math.abs(b.readInt16LE(44 + i * 2));
  return { rate, channels, samples: n, mean: n ? energy / n : 0 };
}

test('install leads to Kokoro, captions, and the model through the host binding', async () => {
  const engine = await installKokoro({ home: HOME, voice: 'af_heart' });
  assert.equal(engine.appId, MCP_TTS_APP);
  assert.equal(engine.voice, 'af_heart');
  const spoken = await speakAsTts(engine, { text: LINE, voice: 'af_heart' });
  assert.equal(spoken.role, 'tts');
  assert.equal(spoken.mime, 'audio/wav');
  const info = wavInfo(spoken.bytes);
  assert.equal(info.rate, 24000);
  assert.equal(info.channels, 1);
  assert.ok(info.samples > 24000 * 0.2, 'the line is longer than a fifth of a second');
  assert.ok(info.mean > 100, 'the waveform is not silence');

  const fetches = [];
  let handed = null;
  const services = {
    kokoro: engine,
    stt: { url: 'https://stt.example.test/captions' },
  };
  function mockFetch(url, init) {
    fetches.push({ url: String(url), init });
    const u = String(url);
    if (u.includes('captions')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ text: 'heard the line' }),
      });
    }
    return Promise.reject(new Error('unexpected host fetch ' + u));
  }

  let pageFetched = false;
  const stored = {
    gifos_ai_config: JSON.stringify({
      // What an earlier version left: a host row for the model, no key.
      smartest: { url: 'gifos-provider://smartest', model: 'provider' },
      tts: { url: 'http://127.0.0.1:9/voice', key: KEY },
      stt: { url: 'https://stt.example.test/captions' },
    }),
  };
  const sandbox = {
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    localStorage: {
      getItem(k) { return stored[k] || null; },
      setItem(k, v) { stored[k] = String(v); },
    },
    location: { protocol: 'https:', origin: 'https://gifos.app', href: 'https://gifos.app/run.html' },
    fetch() { pageFetched = true; throw new Error('the page fetched'); },
    setTimeout() { throw new Error('the provider was not registered during install'); },
  };
  sandbox.window = sandbox;
  sandbox[HOST_BINDING] = (role, payload) => serveHost(services, role, JSON.parse(payload), mockFetch).then((out) => {
    if (out.bytes) handed = Buffer.from(out.bytes);
    const packed = packHostResult(out);
    assert.equal(packed.includes(KEY), false);
    return packed;
  });
  sandbox.GifOS = {
    providers: {
      call(role) { return Promise.reject(new Error('store provider was called for ' + role)); },
      assigned() { return null; },
    },
  };
  vm.createContext(sandbox);
  const script = bridgeScript({ hostRoles: ['tts', 'smartest', 'stt'] }); // smartest is refused
  assert.equal(script.includes('__gifosMcpSpeak'), false);
  assert.equal(script.includes(KEY), false);
  vm.runInContext(script, sandbox);

  assert.equal(stored.gifos_ai_config.includes(KEY), false, 'a hosted role is removed from the page settings');
  const assigned = sandbox.GifOS.providers.assigned('tts');
  assert.equal(assigned.host, true);
  assert.equal(assigned.name, 'gifos-mcp');
  assert.equal(assigned.appId, undefined);
  assert.equal(assigned.fileId, undefined);
  assert.equal((sandbox.GifOS.providers.assigned('smartest') || {}).host, undefined, 'no text model is hosted');
  assert.equal(sandbox.GifOS.providers.assigned('stt').host, true);

  const audio = await sandbox.GifOS.providers.call('tts', { text: LINE, voice: 'af_heart' });
  assert.equal(audio.mime, 'audio/wav');
  assert.ok(Buffer.from(audio.bytes).equals(handed), 'the tts role returns the WAV this call produced');
  const through = wavInfo(audio.bytes);
  assert.equal(through.rate, 24000);
  assert.ok(through.mean > 100, 'the role spoke');
  assert.equal(pageFetched, false);

  const clip = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
  const heard = await sandbox.GifOS.providers.call('stt', { audio: clip, mime: 'audio/wav' });
  assert.equal(heard.text, 'heard the line');
  assert.equal(Buffer.from(fetches.find((f) => f.url.includes('captions')).init.body).toString('binary'), Buffer.from(clip).toString('binary'));

  const seen = [];
  sandbox.HostVoice = {
    create(opts) {
      return {
        opts,
        setVoice(next) { seen.push(next); return next; },
      };
    },
  };
  const eng = sandbox.HostVoice.create({ fetch: sandbox.fetch });
  eng.setVoice({
    llm: { provider: 'smartest', url: 'https://api.example.test/v1', key: KEY, model: 'local-model' },
    tts: { provider: 'tts', engine: 'http', url: 'http://127.0.0.1:9/voice', voice: 'af_heart' },
    stt: { provider: 'stt', url: 'https://stt.example.test/captions' },
  });
  assert.equal('llm' in seen[0], false, 'a model row is dropped, key and all');
  assert.equal(seen[0].tts.engine, 'kokoro');
  assert.equal('url' in seen[0].tts, false);
  assert.equal(JSON.stringify(seen).includes(KEY), false);
  assert.equal(fetches.some((f) => f.url.includes('api.example.test')), false, 'nothing reached a model');
  assert.equal(pageFetched, false);

  const other = await sandbox.GifOS.providers.call('cheapest', { op: 'chat' }).then(() => null, (e) => e);
  assert.match(other.message, /store provider was called for cheapest/);
});

// Restarts on a home that already has the weights. Each start is its own
// process (fixtures/kokoro-child.js); the weights come from a stand-in
// that serves HOME's verified files and lists every ask.
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kokoro-child.js');
const Q8 = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
const modelDir = (home) => path.join(home, 'kokoro', ...KOKORO_MODEL.split('/'));

// A home beside HOME (not under TMPDIR: the weights are ~90 MB). links are
// files hard-linked to HOME's (copied when a link cannot be made); nothing
// writes into a weights file in place, so HOME's stay whole.
function homeBeside(t, links = []) {
  const home = fs.mkdtempSync(HOME + '-restart-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const rel of links) {
    const to = path.join(modelDir(home), rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.linkSync(path.join(modelDir(HOME), rel), to); } catch { fs.copyFileSync(path.join(modelDir(HOME), rel), to); }
  }
  return home;
}

async function weightsFromHome(t) {
  const asked = [];
  const server = http.createServer((req, res) => {
    const m = /^\/[^/]+\/[^/]+\/resolve\/[^/]+\/(.+)$/.exec(req.url);
    const rel = m ? decodeURIComponent(m[1]) : req.url;
    asked.push(rel);
    const file = path.join(modelDir(HOME), rel);
    if (!m || !KOKORO_FILES[rel] || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const bytes = fs.readFileSync(file);
    res.writeHead(200, { 'content-length': bytes.length, etag: '"' + KOKORO_FILES[rel] + '"' });
    res.end(bytes);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { host: 'http://127.0.0.1:' + server.address().port, asked };
}

function start(home, host) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CHILD, home, host], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = { stdout: '', stderr: '' };
    p.stdout.on('data', (d) => { out.stdout += d; });
    p.stderr.on('data', (d) => { out.stderr += d; });
    p.on('exit', (code) => resolve({ ...out, code }));
  });
}

const inodes = (home) => Q8.map((rel) => fs.statSync(path.join(modelDir(home), rel)).ino);

test('a restart with the weights already on disk loads them from there: nothing is downloaded or removed', async (t) => {
  await installKokoro({ home: HOME, voice: 'af_heart' });
  const home = homeBeside(t);
  const w = await weightsFromHome(t);
  const first = await start(home, w.host);
  assert.equal(first.code, 0, 'the first start downloads and loads; stderr: ' + first.stderr.slice(-2000));
  assert.ok(w.asked.includes('onnx/model_quantized.onnx'), 'the first start downloads the model; asked ' + JSON.stringify(w.asked));
  const kept = inodes(home);
  for (const n of [2, 3]) {
    const before = w.asked.length;
    const again = await start(home, w.host);
    assert.equal(again.code, 0, 'start ' + n + ' loads; stderr: ' + again.stderr.slice(-2000));
    assert.deepEqual(w.asked.slice(before), [], 'start ' + n + ' asks for nothing');
    assert.doesNotMatch(again.stderr, /did not load|Unable to get model file/, 'start ' + n + ' loads the kept weights');
    assert.deepEqual(inodes(home), kept, 'start ' + n + ' keeps the very same files');
  }
});

test('a short model file is fetched again on its own; the verified files beside it are kept', async (t) => {
  await installKokoro({ home: HOME, voice: 'af_heart' });
  const home = homeBeside(t, Q8.slice(0, 3));
  const model = path.join(modelDir(home), 'onnx/model_quantized.onnx');
  fs.mkdirSync(path.dirname(model), { recursive: true });
  fs.writeFileSync(model, fs.readFileSync(path.join(modelDir(HOME), 'onnx/model_quantized.onnx')).subarray(0, 1000000));
  const linked = inodes(HOME).slice(0, 3);
  const w = await weightsFromHome(t);
  const out = await start(home, w.host);
  assert.equal(out.code, 0, 'the start loads; stderr: ' + out.stderr.slice(-2000));
  assert.deepEqual(w.asked, ['onnx/model_quantized.onnx'], 'only the short file is asked for');
  assert.deepEqual(inodes(home).slice(0, 3), linked, 'the verified files are the same files as before');
  assert.equal(fs.statSync(model).size, fs.statSync(path.join(modelDir(HOME), 'onnx/model_quantized.onnx')).size, 'the model is whole again');
});
