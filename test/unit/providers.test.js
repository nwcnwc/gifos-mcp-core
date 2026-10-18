// GifOS Settings → AI models is where speech-to-text and text-to-speech
// live. This process answers tts (Kokoro) and, with a stand-in, stt. It
// serves no text model and reads no model key. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadConfig } from '../../src/config.js';
import { bridgeScript, expandForHost, fetchPlan, hostRoles, installPlan } from '../../src/voice/providers.js';
import { packHostResult, serveHost } from '../../src/voice/host.js';

const KEY = 'sk-test-key-which-must-stay-here';

test('a fresh profile keeps Kokoro in this process and installs speech-to-text from the store', () => {
  const cfg = loadConfig({ GIFOS_MCP_HOME: '/x', GIFOS_STT_APP: 'offline-stt-whisper' });
  const steps = installPlan(cfg);
  assert.equal(cfg.voice.tts.source, 'mcp');
  assert.equal(cfg.voice.tts.app, 'mcp-tts-kokoro');
  assert.deepEqual(hostRoles(cfg), ['tts']);
  assert.deepEqual(steps.map((s) => s.role + ':' + (s.appId || 'endpoint')), ['stt:offline-stt-whisper']);
  assert.equal(steps.some((s) => s.role === 'tts'), false);
  assert.equal(steps.some((s) => s.endpoint), false);
  const named = loadConfig({ GIFOS_MCP_HOME: '/x', GIFOS_TTS_APP: 'tts-synthetic', GIFOS_STT_APP: 'stt-synthetic' });
  assert.equal(named.voice.tts.source, 'store');
  assert.deepEqual(hostRoles(named), []);
  assert.equal(installPlan(named).find((s) => s.role === 'tts').appId, 'tts-synthetic');
});

test('an HTTP stand-in is served by this process and is not written into Settings; model settings are ignored', () => {
  const cfg = loadConfig({
    GIFOS_MCP_HOME: '/x',
    GIFOS_TTS_URL: 'http://127.0.0.1:9/voice',
    GIFOS_STT_URL: 'http://127.0.0.1:11/captions',
    GIFOS_LLM_URL: 'http://127.0.0.1:10/v1',
    GIFOS_LLM_MODEL: 'local-model',
    GIFOS_LLM_KEY: KEY,
    GIFOS_STT_APP: 'none',
  });
  assert.deepEqual(hostRoles(cfg), ['tts', 'stt']);
  const steps = installPlan(cfg);
  assert.deepEqual(steps, []);
  assert.equal(JSON.stringify(cfg).includes(KEY), false);
  const expanded = expandForHost({ llm: { provider: 'smartest' }, tts: { provider: 'tts', engine: 'http' }, stt: { provider: 'stt' } }, {
    smartest: { url: 'http://127.0.0.1:10/v1', key: KEY, model: 'local-model' },
    tts: { url: cfg.voice.tts.url, voice: 'af_heart' },
    stt: { url: cfg.voice.sttUrl },
  }, hostRoles(cfg));
  assert.equal('llm' in expanded, false);
  assert.equal(expanded.tts.engine, 'kokoro');
  assert.equal('url' in expanded.tts, false);
  assert.equal(JSON.stringify(expanded).includes(KEY), false);
  assert.equal(JSON.stringify(expanded).includes('127.0.0.1'), false);
});

function tinyWav() {
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(24000, 24); hdr.writeUInt32LE(48000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(0, 40);
  return hdr;
}

test('the host answers speech and captions, refuses a text model, and a failure does not echo a secret', async () => {
  const wav = tinyWav();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    const u = String(url);
    if (u.includes('captions')) {
      return { ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => 'caption' };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'audio/wav' },
      arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
    };
  };
  const speech = await serveHost({ tts: { url: 'http://127.0.0.1:9/voice', voice: 'af_heart' } }, 'tts', { text: 'Hi', voice: 'af_heart' }, fetchImpl);
  assert.equal(speech.role, 'tts');
  assert.equal(speech.mime, 'audio/wav');
  assert.equal(Buffer.from(speech.bytes).toString('ascii', 0, 4), 'RIFF');
  const model = await serveHost({ llm: { url: 'https://api.example.test/v1/', key: KEY, model: 'm' } }, 'smartest', { messages: [{ role: 'user', content: 'hi' }] }, fetchImpl).then(() => null, (e) => e);
  assert.match(model.message, /does not serve smartest/);
  assert.equal(seen.length, 1, 'nothing was fetched for the model');
  const captions = await serveHost({ stt: { url: 'http://127.0.0.1:11/captions' } }, 'stt', { audio: Buffer.from('abc').toString('base64'), mime: 'audio/wav' }, fetchImpl);
  assert.equal(captions.text, 'caption');
  assert.equal(Buffer.from(seen.find((s) => s.url.includes('captions')).init.body).toString(), 'abc');
  const failed = await serveHost(
    { stt: { url: 'http://127.0.0.1:11/captions' } },
    'stt',
    { audio: '' },
    async () => ({ ok: false, status: 401, text: async () => KEY, json: async () => ({ error: KEY }) }),
  ).then(() => null, (e) => e);
  assert.match(failed.message, /failed \(401\)/);
  assert.equal(failed.message.includes(KEY), false);
  assert.equal(packHostResult(captions).includes(KEY), false);
});

// A per-line voice (say with voice) reaches the speech engine for that line.
test('a voice asked for one line is the voice Kokoro speaks it in', async () => {
  const spoke = [];
  const kokoro = { voice: 'af_heart', hasVoice: (n) => n === 'af_heart' || n === 'am_michael', async speak(text, voice) { spoke.push(voice); return tinyWav(); } };
  await serveHost({ kokoro, lineVoice: () => 'am_michael' }, 'tts', { text: 'Hi', voice: 'af_heart' });
  await serveHost({ kokoro, lineVoice: () => '' }, 'tts', { text: 'Hi', voice: 'af_heart' });
  assert.deepEqual(spoke, ['am_michael', 'af_heart']);
});

test('https pages do not call an http model directly', () => {
  const plan = fetchPlan('http://127.0.0.1:9/v1/chat', 'https://gifos.app/run.html');
  assert.equal(plan.proxy, true);
  assert.equal(plan.url, 'https://cors-proxy.gifos.app/');
  assert.equal(plan.headers['x-gifos-target'], 'http://127.0.0.1:9/v1/chat');
  const same = fetchPlan('https://api.example.test/v1/chat', 'https://gifos.app/run.html');
  assert.equal(same.proxy, false);
  assert.equal(same.url, 'https://api.example.test/v1/chat');
  const local = fetchPlan('http://127.0.0.1:9/v1/chat', 'http://127.0.0.1:19510/run.html');
  assert.equal(local.proxy, false);
});

test('the host bridge reads Settings and does not put the key in the app', () => {
  const ai = {
    smartest: { app: 'file-llm', appId: 'llm-synthetic', appName: 'Synthetic LLM' },
    tts: { app: 'file-tts', appId: 'tts-synthetic', appName: 'Synthetic TTS' },
    stt: { app: 'file-stt', appId: 'stt-synthetic', appName: 'Synthetic STT' },
  };
  const expanded = expandForHost({
    conversation_voice: 'local',
    llm: { provider: 'smartest' },
    tts: { provider: 'tts', engine: 'kokoro', app: 'tts-synthetic', voice: 'af_heart' },
    stt: { provider: 'stt' },
  }, ai);
  assert.equal('llm' in expanded, false);
  assert.equal(expanded.tts.engine, 'kokoro');
  assert.equal('url' in (expanded.stt || {}), false);

  const calls = [];
  const sandbox = {
    localStorage: { data: { gifos_ai_config: JSON.stringify(ai) }, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = String(v); } },
    location: { protocol: 'https:', origin: 'https://gifos.app', href: 'https://gifos.app/run.html' },
    fetch() { throw new Error('the page fetched'); },
  };
  sandbox.window = sandbox;
  sandbox.GifOS = { providers: { call(role, req) { calls.push([role, req]); return Promise.resolve({ text: 'Round trip reply.', bytes: new Uint8Array([1, 2]), mime: 'audio/wav' }); }, assigned() { return true; } } };
  vm.createContext(sandbox);
  vm.runInContext(bridgeScript(), sandbox);
  const seen = [];
  sandbox.HostVoice = {
    create(opts) {
      return {
        opts,
        setVoice(next) { seen.push(next); return { conversation_voice: next.conversation_voice }; },
      };
    },
  };
  const eng = sandbox.HostVoice.create({ fetch: sandbox.fetch, tts() { throw new Error('raw tts'); } });
  const pub = eng.setVoice({ conversation_voice: 'local', llm: { provider: 'smartest' }, tts: { provider: 'tts', engine: 'kokoro', voice: 'af_heart' }, stt: { provider: 'stt' } });
  assert.equal(pub.conversation_voice, 'local');
  assert.equal('llm' in seen[0], false);
  assert.equal(JSON.stringify(seen).includes(KEY), false);
  return eng.opts.fetch('gifos-provider://smartest/extra', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) }).then((res) => {
    assert.equal(res.ok, true);
    assert.equal(calls[0][0], 'smartest');
    assert.equal(calls[0][1].messages[0].content, 'hello');
    return eng.opts.tts({ text: 'Hello from the bot', voice: 'af_heart' });
  }).then((audio) => {
    assert.equal(calls[1][0], 'tts');
    assert.equal(audio.mime, 'audio/wav');
  });
});
