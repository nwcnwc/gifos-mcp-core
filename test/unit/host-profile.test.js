// A fresh bot profile has no GifOS AI rows. Meet Bot speaks with gifos.ai.tts,
// which throws NOT_CONFIGURED:ai:tts unless launch registered the host
// provider. Join no longer calls setVoice, so this registration is the path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { bridgeScript, HOST_BINDING } from '../../src/voice/providers.js';

const KEY = 'sk-test-key-which-must-stay-here';

// The check and the fetch in GifOS brokerAI (js/runtime.js). A role with
// neither url nor app is NOT_CONFIGURED. A url is fetched; an app is a GIF.
function brokerAI(sandbox, op, payload) {
  const cfg = JSON.parse(sandbox.localStorage.getItem('gifos_ai_config') || '{}');
  const role = op === 'chat' ? 'smartest' : op;
  const c = cfg[role];
  if (!c || (!c.url && !c.app)) throw new Error('NOT_CONFIGURED:ai:' + role);
  if (c.app) throw new Error('mounted a provider gif for ' + role);
  const paths = { chat: '/chat/completions', tts: '/audio/speech' };
  const base = String(c.url).replace(/\/+$/, '');
  const path = paths[op] || '';
  const url = path && base.slice(-path.length) === path ? base : base + path;
  const body = op === 'tts'
    ? { model: c.model || 'tts-1', input: String(payload.text || ''), voice: payload.voice || 'alloy' }
    : { model: c.model || 'gpt-4o-mini', messages: payload.messages || [], stream: false };
  return sandbox.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: c.key ? 'Bearer ' + c.key : '' },
    body: JSON.stringify(body),
  });
}

test('a fresh profile speaks through the host tts provider, and the host serves no text model', async () => {
  const stored = {};
  let pageFetched = false;
  const sandbox = {
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : null; },
      setItem(k, v) { stored[k] = String(v); },
    },
    location: { protocol: 'https:', origin: 'https://gifos.app', href: 'https://gifos.app/index.html' },
    fetch() { pageFetched = true; throw new Error('the page fetched'); },
    setTimeout() { throw new Error('providers were not registered at launch'); },
    GifOS: {
      providers: {
        call(role) { return Promise.reject(new Error('NOT_CONFIGURED:ai:' + role)); },
        assigned() { return null; },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox[HOST_BINDING] = (role, payload) => {
    const req = JSON.parse(payload);
    if (role === 'tts') {
      assert.equal(req.text, 'Hello from the room');
      assert.equal(req.voice, 'af_heart');
      const wav = Buffer.from('RIFF....WAVE');
      return JSON.stringify({ role: 'tts', mime: 'audio/wav', audio: wav.toString('base64'), text: '' });
    }
    return Promise.reject(new Error('unexpected role ' + role));
  };
  vm.createContext(sandbox);
  vm.runInContext(bridgeScript({ hostRoles: ['tts', 'smartest'] }), sandbox); // smartest is asked for and refused

  const audio = await brokerAI(sandbox, 'tts', { text: 'Hello from the room', voice: 'af_heart' });
  assert.equal(audio.ok, true);
  const bytes = Buffer.from(await audio.arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(pageFetched, false);

  // No text model: a chat request is not configured on this profile.
  assert.throws(() => brokerAI(sandbox, 'chat', { messages: [{ role: 'user', content: 'What did we decide?' }] }), /NOT_CONFIGURED:ai:smartest/);
  assert.equal(pageFetched, false);
  assert.equal(JSON.stringify(stored).includes(KEY), false);
});
