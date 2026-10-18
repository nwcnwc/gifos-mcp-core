// Host-layer provider. This process embeds the headless GifOS page, so it
// answers tts (and stt, when a stand-in URL is set) itself. The page calls
// one Playwright binding. It does not fetch, and no sandboxed provider GIF
// is mounted. There is no text model here: the assistant calling the MCP
// tools writes every word the bot says.
import { speakAsTts } from './providers.js';
import { nativeVoice } from './voices.js';
import { heardText } from './hallucination.js';

async function readError(res) {
  const status = res && res.status ? res.status : 0;
  return new Error('The host provider call failed (' + status + ').');
}

export async function serveHost(services, role, req, fetchImpl) {
  const work = () => serveHostOnce(services, role, req, fetchImpl);
  if (services && services.queue) return services.queue.run(role, req, work);
  return work();
}

async function serveHostOnce(services, role, req, fetchImpl) {
  const s = services || {};
  const fetchFn = fetchImpl || fetch;
  if (role === 'tts') {
    const asked = typeof s.lineVoice === 'function' ? s.lineVoice() : '';
    if (asked) req = { ...(req || {}), voice: asked };
    if (s.kokoro) return speakAsTts(s.kokoro, req);
    if (s.tts && s.tts.url) return fetchSpeech(s.tts, req, fetchFn);
    throw new Error('Kokoro is not available on this computer.');
  }
  if (role === 'stt') return fetchCaptions(s.stt, req, fetchFn);
  throw new Error('The host does not serve ' + role + '.');
}

async function fetchSpeech(tts, req, fetchFn) {
  const text = String((req && req.text) || '');
  const configured = String((tts && tts.voice) || '');
  const known = configured ? (name) => name === configured : null;
  const voice = nativeVoice((req && req.voice) || '', configured, known);
  const res = await fetchFn(tts.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice }),
  });
  if (!res.ok) throw await readError(res);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('The speech stand-in did not return a WAV.');
  return { role: 'tts', mime: 'audio/wav', bytes: buf, voice };
}

function audioBytes(req) {
  const raw = req && (req.audio || req.bytes);
  if (!raw) return Buffer.alloc(0);
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return Buffer.from(raw);
  return Buffer.from(String(raw), 'base64');
}

async function fetchCaptions(stt, req, fetchFn) {
  if (!stt || !stt.url) throw new Error('Speech-to-text is not configured.');
  const body = audioBytes(req);
  const res = await fetchFn(stt.url, {
    method: 'POST',
    headers: { 'content-type': (req && req.mime) || 'audio/wav' },
    body,
  });
  if (!res.ok) throw await readError(res);
  const ct = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
  let text = '';
  if (ct.includes('json') || typeof res.text !== 'function') {
    const data = await res.json();
    text = String((data && (data.text || data.transcript)) || '');
  } else {
    text = String(await res.text());
  }
  return { role: 'stt', text: heardText(text, body) };
}

export function packHostResult(out) {
  const body = { role: out.role || '', text: out.text || '', mime: out.mime || '' };
  if (out.bytes) body.audio = Buffer.from(out.bytes).toString('base64');
  return JSON.stringify(body);
}
