// Kokoro runs in this process, on the machine that runs the MCP server.
// The first call downloads the pinned weights (KOKORO_REVISION, checked
// against KOKORO_FILES) into GIFOS_MCP_HOME/kokoro; the af_heart voice
// ships inside the kokoro-js package. Nothing here is a provider GIF, and nothing
// listens on the network. The headless harness turns speak() into the
// bytes for the tts role.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MCP_TTS_APP, KOKORO_VOICE } from './settings.js';
import { nativeVoice } from './voices.js';
import { log } from '../log.js';

export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_DTYPE = 'q8';
// The weights are fetched from this commit of the model repository, never
// from a moving branch, and every file is checked against its SHA-256
// before it is used. About 92 MB in all. The voices ship inside the
// kokoro-js package itself.
export const KOKORO_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const KOKORO_FILES = Object.freeze({
  'config.json': 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
  'tokenizer.json': '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
  'tokenizer_config.json': 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
  'onnx/model_quantized.onnx': 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
  // fp32 is the fallback when q8 audio is corrupt (AVX-512). Same revision.
  'onnx/model.onnx': '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb',
});

// q8 on an AVX-512 CPU has come back as NaN or peaks like 1.5e15. A real
// waveform stays inside -1..1. Empty is not corrupt: there was nothing to say.
export function kokoroAudioCorrupt(samples) {
  if (!samples || typeof samples.length !== 'number') return true;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!Number.isFinite(s) || s > 1 || s < -1) return true;
  }
  return false;
}

// The SHA-256 a weights file must have, by its path inside the model.
export function expectedHash(relPath) {
  return KOKORO_FILES[String(relPath).split(path.sep).join('/')] || null;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (b) => hash.update(b)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

// A file that is not the pinned one is removed, never loaded.
const checked = new Set();
async function verifyFile(file, rel, hashes = KOKORO_FILES) {
  const want = hashes[String(rel).split(path.sep).join('/')] || null;
  if (!want) throw new Error('Kokoro: ' + rel + ' is not one of the pinned weights files.');
  if (checked.has(file)) return;
  const got = await sha256File(file);
  if (got !== want) {
    await fs.promises.rm(file, { force: true });
    throw new Error('Kokoro: ' + rel + ' does not match its pinned SHA-256 (got ' + got.slice(0, 12) + '…); it was removed.');
  }
  checked.add(file);
}

const loads = new Map();

export const KOKORO_HOST = 'https://huggingface.co';

// host is a mirror of the Hugging Face layout (GIFOS_KOKORO_URL); empty means huggingface.co.
export function installKokoro({ home, voice, host, dtype } = {}) {
  if (!home) throw new Error('Kokoro needs a directory to keep its weights.');
  const dir = path.join(home, 'kokoro');
  const kind = dtype || KOKORO_DTYPE;
  const key = dir + '\n' + kind;
  let pending = loads.get(key);
  if (!pending) {
    pending = load(dir, voice || KOKORO_VOICE, host || KOKORO_HOST, kind).catch((e) => {
      loads.delete(key);
      throw e;
    });
    loads.set(key, pending);
  }
  return pending;
}

// transformers.js writes a download straight to its final path, so a run
// killed halfway leaves a short file it trusts on every later start. This
// cache writes <file>.<pid>.part and renames it into place when the bytes
// are all there. Several workers can fetch the same file at once: each
// writes its own part file and the last rename wins with a whole file.
// Keys are the remote URLs; files keep the old <model>/<file> layout, so
// weights downloaded before this change are still found.
// A part file left by a process that died (a worker killed when its boot
// ran out of time) is kept: the next match() claims it and asks only for
// the missing bytes, so a slow link gets further on each start instead of
// starting from zero. The part keeps the ETag its bytes came with in
// <part>.tag; a part with no strong ETag, or whose file has a different
// ETag now, is dropped rather than joined to bytes of another version.
// hashes: path in the model -> SHA-256 (the pinned KOKORO_FILES unless a
// test hands its own stand-in files).
export function weightsCache(dir, host, hashes = KOKORO_FILES) {
  const base = String(host).replace(/\/+$/, '') + '/';
  const where = (key) => {
    const k = String(key);
    if (!k.startsWith(base)) return null;
    const m = /^([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(decodeURIComponent(k.slice(base.length)));
    if (!m) return null;
    const file = path.resolve(dir, m[1], m[2]);
    return file.startsWith(path.resolve(dir) + path.sep) ? { file, rel: m[2] } : null;
  };
  return {
    async match(key) {
      const at = where(key);
      if (!at) return undefined;
      if (!fs.existsSync(at.file) && !(await resume(key, at.file))) return undefined;
      await verifyFile(at.file, at.rel, hashes);
      const bytes = await fs.promises.readFile(at.file);
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    },
    async put(key, response, progress) {
      const at = where(key);
      if (!at) return;
      await fs.promises.mkdir(path.dirname(at.file), { recursive: true });
      const total = parseInt(response.headers.get('content-length') || '0', 10);
      await writePart(at.file, response, 0, total, progress);
      await verifyFile(at.file, at.rel, hashes);
    },
  };
}

// Streams response into <file>.<pid>.part from byte `from` on, then renames
// it into place. A failure removes the part; a kill leaves it for resume().
// A fresh part records the response's ETag; a resumed one keeps its own.
async function writePart(file, response, from, total, progress) {
  const part = file + '.' + process.pid + '.part';
  if (!from) {
    const tag = strongTag(response);
    if (tag) await fs.promises.writeFile(part + '.tag', tag);
    else await fs.promises.rm(part + '.tag', { force: true });
  }
  const out = fs.createWriteStream(part, from ? { flags: 'a' } : {});
  try {
    const reader = response.body.getReader();
    let loaded = from;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise((resolve, reject) => out.write(value, (e) => (e ? reject(e) : resolve())));
      loaded += value.length;
      if (progress) progress({ progress: total ? (loaded / total) * 100 : 0, loaded, total });
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (total && loaded !== total) throw new Error('Kokoro: ' + path.basename(file) + ' ended at ' + loaded + ' of ' + total + ' bytes.');
    await fs.promises.rename(part, file);
    await fs.promises.rm(part + '.tag', { force: true });
  } catch (e) {
    out.destroy();
    await rmPart(part);
    throw e;
  }
}

// If-Range needs a strong ETag; a weak one (W/"...") cannot vouch for bytes.
function strongTag(response) {
  const tag = response.headers.get('etag');
  return tag && /^"[^"]*"$/.test(tag) ? tag : null;
}

function rmPart(part) {
  return Promise.all([part, part + '.tag'].map((p) => fs.promises.rm(p, { force: true })));
}

// Part files of `file` whose process is gone, biggest first.
function deadParts(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) return [];
  const name = path.basename(file);
  const found = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(name + '.')) continue;
    const m = /^\.(\d+)\.part$/.exec(entry.slice(name.length));
    if (!m || Number(m[1]) === process.pid || alive(Number(m[1]))) continue;
    const p = path.join(dir, entry);
    try { found.push({ path: p, size: fs.statSync(p).size }); } catch { /* gone meanwhile */ }
  }
  return found.sort((a, b) => b.size - a.size);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Finishes the biggest dead part of file with a Range request. Several
// workers may start at once: the rename claims a part for one of them, and
// the rest download as usual. Returns true when file is in place.
// The Hugging Face CDN answers 206 even when If-Range does not match, so
// the 206's own ETag must be the one the kept bytes came with.
async function resume(key, file) {
  const parts = deadParts(file);
  const mine = file + '.' + process.pid + '.part';
  let from = -1;
  let tag = null;
  for (const p of parts) {
    if (from < 0) {
      try { await fs.promises.rename(p.path, mine); from = p.size; } catch { continue; }
      tag = await fs.promises.readFile(p.path + '.tag', 'utf8').catch(() => null);
      await fs.promises.rm(p.path + '.tag', { force: true });
      if (tag) await fs.promises.writeFile(mine + '.tag', tag);
      continue;
    }
    await rmPart(p.path);
  }
  if (from < 0) return false;
  try {
    const res = from > 0 && tag ? await fetch(key, { headers: { Range: 'bytes=' + from + '-', 'If-Range': tag } }) : null;
    const range = res && res.status === 206 && res.headers.get('etag') === tag
      && /^bytes (\d+)-\d+\/(\d+)$/.exec(res.headers.get('content-range') || '');
    if (range && Number(range[1]) === from) {
      log('Kokoro: resuming ' + path.basename(file) + ' at ' + from + ' of ' + range[2] + ' bytes');
      await writePart(file, res, from, Number(range[2]));
      return true;
    }
    if (res && res.status === 200) {
      // No Range support: this answer is the whole file.
      await writePart(file, res, 0, parseInt(res.headers.get('content-length') || '0', 10));
      return true;
    }
    if (res && res.body) await res.body.cancel().catch(() => {});
    if (from > 0) log('Kokoro: ' + path.basename(file) + (tag ? ' changed since its kept bytes' : ' has no version tag for its kept bytes') + '; downloading it again');
  } catch (e) {
    log('Kokoro: could not resume ' + path.basename(file) + ' (' + oneLine(e) + '); downloading it again');
  }
  await rmPart(mine);
  return false;
}

// Part files left by a process that was killed while downloading: the
// biggest of each file is kept for resume(), the rest are dropped, and so
// is any part of a file that is already whole, and any tag whose part is gone.
function dropDeadParts(dir) {
  if (!fs.existsSync(dir)) return;
  const kept = new Set();
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    const t = /^(.+\.(\d+)\.part)\.tag$/.exec(String(rel));
    if (t && !alive(Number(t[2])) && !fs.existsSync(path.join(dir, t[1]))) fs.rmSync(path.join(dir, String(rel)), { force: true });
    const m = /^(.+)\.(\d+)\.part$/.exec(String(rel));
    if (!m) continue;
    const file = path.join(dir, m[1]);
    if (kept.has(file)) continue;
    kept.add(file);
    const parts = deadParts(file);
    const keep = fs.existsSync(file) ? 0 : 1;
    for (const p of parts.slice(keep)) for (const f of [p.path, p.path + '.tag']) fs.rmSync(f, { force: true });
  }
}

// phonemizer (inside kokoro-js) installs process handlers that rethrow any
// uncaught error from inside the handler: the process then dies with exit 7
// and prints the minified phonemizer source. Keep Node's own handling.
async function importKokoro() {
  const kinds = ['uncaughtException', 'unhandledRejection'];
  const before = new Map(kinds.map((k) => [k, process.listeners(k)]));
  const mod = await import('kokoro-js');
  for (const k of kinds) {
    for (const fn of process.listeners(k)) if (!before.get(k).includes(fn)) process.removeListener(k, fn);
  }
  return mod;
}

async function load(dir, voice, host, dtype) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const transformers = await import('@huggingface/transformers');
  transformers.env.cacheDir = dir;
  transformers.env.remoteHost = String(host).replace(/\/+$/, '') + '/';
  transformers.env.remotePathTemplate = '{model}/resolve/' + KOKORO_REVISION + '/';
  transformers.env.useCustomCache = true;
  transformers.env.customCache = weightsCache(dir, host);
  const { KokoroTTS } = await importKokoro();
  const modelDir = path.join(dir, ...KOKORO_MODEL.split('/'));
  dropDeadParts(modelDir);
  const kind = dtype || KOKORO_DTYPE;
  log('Kokoro: loading ' + KOKORO_MODEL + ' (' + kind + ') into ' + dir);
  const seen = new Set();
  const open = (which) => KokoroTTS.from_pretrained(KOKORO_MODEL, {
    dtype: which,
    device: 'cpu',
    progress_callback: (p) => {
      if (!p || p.status !== 'progress' || p.progress == null) return;
      const n = Math.round(p.progress);
      if (n !== 0 && n !== 100) return;
      const name = String(p.file || p.name || 'weights');
      const key = name + ':' + n;
      if (seen.has(key)) return;
      seen.add(key);
      log('Kokoro: ' + name + ' ' + n + '%');
    },
  });
  let tts;
  try {
    tts = await open(kind);
  } catch (first) {
    // A short or corrupt file from an older run: fetch the weights once more.
    log('Kokoro: the weights in ' + modelDir + ' did not load (' + oneLine(first) + '); downloading them again');
    fs.rmSync(modelDir, { recursive: true, force: true });
    seen.clear();
    try {
      tts = await open(kind);
    } catch (again) {
      throw new Error('Kokoro could not load from ' + host + ' into ' + dir + ': ' + oneLine(again));
    }
  }
  if (!tts.voices || !tts.voices[voice]) {
    throw new Error('Kokoro has no voice ' + JSON.stringify(voice) + '.');
  }
  log('Kokoro is ready (' + voice + ')');
  const loaded = voice || KOKORO_VOICE;
  let fp32 = kind === 'fp32' ? tts : null;
  // q8 stays corrupt on this CPU. Remember it so the next line does not
  // generate the bad audio and then throw it away.
  let preferFp32 = kind === 'fp32';
  const engine = {
    appId: MCP_TTS_APP,
    voice: loaded,
    dir,
    hasVoice(name) { return !!(tts.voices && tts.voices[name]); },
    async speak(text, want) {
      const chosen = nativeVoice(want, loaded, (name) => engine.hasVoice(name));
      if (!tts.voices || !tts.voices[chosen]) throw new Error('Kokoro has no voice ' + JSON.stringify(chosen) + '.');
      const sayWith = (model) => model.generate(String(text || ''), { voice: chosen });
      const ensureFp32 = async () => {
        if (!fp32) {
          try { fp32 = await open('fp32'); }
          catch (first) {
            // Same recovery as the first load: a short file must not leave the line unspoken.
            log('Kokoro: fp32 weights in ' + modelDir + ' did not load (' + oneLine(first) + '); downloading them again');
            fs.rmSync(modelDir, { recursive: true, force: true });
            seen.clear();
            try { fp32 = await open('fp32'); }
            catch (again) { throw new Error('Kokoro produced corrupt audio and fp32 did not load: ' + oneLine(again)); }
          }
        }
        if (!fp32.voices || !fp32.voices[chosen]) throw new Error('Kokoro has no voice ' + JSON.stringify(chosen) + '.');
        return fp32;
      };
      let audio;
      if (preferFp32 && kind !== 'fp32') {
        audio = await sayWith(await ensureFp32());
      } else {
        audio = await sayWith(tts);
      }
      if (kokoroAudioCorrupt(audio && audio.audio)) {
        if (kind === 'fp32' || preferFp32) throw new Error('Kokoro produced corrupt audio.');
        preferFp32 = true;
        log('Kokoro: ' + kind + ' audio was corrupt; speaking again with fp32');
        audio = await sayWith(await ensureFp32());
        if (kokoroAudioCorrupt(audio && audio.audio)) throw new Error('Kokoro produced corrupt audio.');
      }
      return Buffer.from(audio.toWav());
    },
  };
  return engine;
}

function oneLine(e) {
  return String((e && e.message) || e).split('\n')[0].slice(0, 300);
}
