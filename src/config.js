// Settings come from environment variables only, so a Grok Bot MCP config
// (command + args + env) is the whole setup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { KOKORO_VOICE, MCP_TTS_APP } from './voice/settings.js';
import { readPrivate, writePrivate } from './private-file.js';

export const DEFAULT_GIFOS_URL = 'https://gifos.app';
export const DEFAULT_STT_APP = 'offline-stt-whisper';

function cleanBase(u, name) {
  const s = String(u || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\/[^/\s]+/.test(s)) throw new Error(name + ' must be an http(s) URL, got: ' + JSON.stringify(u));
  return s;
}

function cleanUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(s)) throw new Error('GIFOS_URL must be an http(s) URL, got: ' + JSON.stringify(u));
  return s;
}

export function loadConfig(env = process.env) {
  const home = env.GIFOS_MCP_HOME || path.join(os.homedir(), '.gifos-mcp');
  const stt = env.GIFOS_STT_APP === undefined ? DEFAULT_STT_APP : String(env.GIFOS_STT_APP).trim();
  return {
    home,
    gifosUrl: cleanUrl(env.GIFOS_URL || DEFAULT_GIFOS_URL),
    relay: String(env.GIFOS_RELAY || '').trim(),
    botName: String(env.GIFOS_BOT_NAME || '').trim(),
    botPassword: String(env.GIFOS_BOT_PASSWORD || ''),
    // The bot's picture in rooms: a GIF, PNG, JPEG or WebP file, at most 256 KB.
    botPicture: String(env.GIFOS_BOT_PICTURE || '').trim(),
    sttApp: stt === 'none' ? '' : stt,
    headless: env.GIFOS_HEADLESS !== '0',
    chrome: String(env.GIFOS_CHROME || '').trim(),
    botAudio: env.GIFOS_BOT_AUDIO ? path.resolve(String(env.GIFOS_BOT_AUDIO).trim()) : '', // Chromium needs an absolute path
    shotsDir: String(env.GIFOS_MCP_SHOTS || '').trim(),
    timeoutMs: Number(env.GIFOS_TIMEOUT_MS) > 0 ? Number(env.GIFOS_TIMEOUT_MS) : 120000,
    prewarm: env.GIFOS_MCP_LAZY !== '1',
    debug: env.GIFOS_MCP_DEBUG === '1',
    maxMeetings: positiveInt(env.GIFOS_MAX_MEETINGS, 4, 'GIFOS_MAX_MEETINGS'),
    capacityNear: nearCount(env),
    horizonMs: positiveInt(env.GIFOS_SCHEDULE_HORIZON_MS, 24 * 60 * 60 * 1000, 'GIFOS_SCHEDULE_HORIZON_MS'),
    // Stage B: more than one worker runs each Meet Bot in its own child
    // process and Chromium. Rooms per worker defaults to an even share of the cap.
    workers: positiveInt(env.GIFOS_WORKERS, 1, 'GIFOS_WORKERS'),
    workerRooms: workerRooms(env),
    voice: voiceConfig(env),
  };
}

// Provisional until a machine is measured. Stage A needs an explicit cap.
function positiveInt(raw, fallback, name) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(name + ' must be a positive integer.');
  return n;
}

function nearCount(env) {
  const cap = positiveInt(env.GIFOS_MAX_MEETINGS, 4, 'GIFOS_MAX_MEETINGS');
  if (env.GIFOS_CAPACITY_NEAR == null || String(env.GIFOS_CAPACITY_NEAR).trim() === '') return Math.max(1, cap - 1);
  const near = positiveInt(env.GIFOS_CAPACITY_NEAR, 1, 'GIFOS_CAPACITY_NEAR');
  if (near > cap) throw new Error('GIFOS_CAPACITY_NEAR cannot be above GIFOS_MAX_MEETINGS.');
  return near;
}

function workerRooms(env) {
  const cap = positiveInt(env.GIFOS_MAX_MEETINGS, 4, 'GIFOS_MAX_MEETINGS');
  const workers = positiveInt(env.GIFOS_WORKERS, 1, 'GIFOS_WORKERS');
  const rooms = positiveInt(env.GIFOS_WORKER_ROOMS, Math.ceil(cap / workers), 'GIFOS_WORKER_ROOMS');
  if (rooms * workers < cap) throw new Error('GIFOS_WORKERS x GIFOS_WORKER_ROOMS must cover GIFOS_MAX_MEETINGS.');
  return rooms;
}

// Speech and captions for the bot. There is no text model: the assistant
// calling the tools writes every line the bot says.
export function voiceConfig(env = process.env) {
  const sttRaw = env.GIFOS_STT_APP === undefined ? DEFAULT_STT_APP : String(env.GIFOS_STT_APP).trim();
  const pollRaw = Number(env.GIFOS_TRANSCRIPT_POLL_MS);
  return {
    // How often captions are copied from Meet Bot into the lines that
    // wait_lines and tail_lines return.
    pollMs: pollRaw > 0 ? pollRaw : 300,
    tts: ttsConfig(env),
    sttUrl: sttUrl(env),
    sttApp: sttRaw === 'none' ? '' : sttRaw,
  };
}

// Speech for Meet Bot. Default Kokoro runs in this process
// (source "mcp"). The headless harness injects this process as the tts
// provider. GIFOS_TTS_APP names a store provider instead. GIFOS_TTS_URL is
// fetched by this process, not by the page.
const TTS_ENGINES = new Set(['', 'auto', 'kokoro', 'none']);

function ttsConfig(env) {
  const ask = String(env.GIFOS_TTS_ENGINE || '').trim().toLowerCase();
  if (!TTS_ENGINES.has(ask)) {
    throw new Error('GIFOS_TTS_ENGINE must be auto, kokoro, or none.');
  }
  const named = String(env.GIFOS_TTS_VOICE || '').trim();
  if (ask === 'none') return { engine: 'none' };
  const url = String(env.GIFOS_TTS_URL || '').trim();
  if (url) return { engine: 'http', url: cleanBase(url, 'GIFOS_TTS_URL'), voice: named };
  const app = String(env.GIFOS_TTS_APP || '').trim();
  if (app) return { engine: 'kokoro', app, voice: named || KOKORO_VOICE, source: 'store' };
  const weights = String(env.GIFOS_KOKORO_URL || '').trim();
  return { engine: 'kokoro', app: MCP_TTS_APP, voice: named || KOKORO_VOICE, source: 'mcp', weights: weights ? cleanBase(weights, 'GIFOS_KOKORO_URL') : '' };
}

function sttUrl(env) {
  const url = String(env.GIFOS_STT_URL || '').trim();
  return url ? cleanBase(url, 'GIFOS_STT_URL') : '';
}

// Mirrors the Meeting Bot's own strength rule (protocol.js), so a pair we
// generate or accept is never refused by the app.
const WEAK = ['bot', 'password', 'password1', '12345678', '123456789', 'admin', 'letmein', 'qwerty', 'gifos', 'secret', 'changeme'];
export function credentialProblem(name, password) {
  name = String(name || '').trim();
  password = String(password || '');
  const nl = name.toLowerCase();
  const pl = password.toLowerCase();
  if (nl.length < 3) return 'Bot name needs at least 3 characters.';
  if (name.length > 40) return 'Bot name is at most 40 characters.';
  if (WEAK.includes(nl)) return 'Pick a less obvious bot name.';
  if (password.length < 10) return 'Bot password needs at least 10 characters.';
  if (pl === nl) return 'Bot password must not be the name.';
  if (WEAK.includes(pl)) return 'That bot password is too easy to guess.';
  if (!(/[a-z]/i.test(password) && /[0-9]/.test(password)) && password.length < 14) return 'Use a letter and a digit in the bot password, or a longer one.';
  return '';
}

export function generateCredentials() {
  const name = 'notes-' + crypto.randomBytes(3).toString('hex');
  // 24 base64url chars plus a fixed digit: always a letter and a digit.
  const password = crypto.randomBytes(18).toString('base64url') + '7';
  return { name, password };
}

// The bot's name is what people see in a room; its password is the secret.
// Both live in GIFOS_MCP_HOME/bot.json (mode 0600). GIFOS_BOT_NAME alone sets
// the name and keeps the stored (or a new) password; GIFOS_BOT_PASSWORD may
// be given too. set_bot_profile changes the name in bot.json.
export function botCredentials(cfg) {
  const file = path.join(cfg.home, 'bot.json');
  // A file that cannot be read is kept aside: it is the bot's old identity.
  const saved = readPrivate(file, 'generating a new bot name and password', (x) => x && !credentialProblem(x.name, x.password));
  if (cfg.botName || cfg.botPassword) {
    const name = cfg.botName || (saved && saved.name) || generateCredentials().name;
    let password = cfg.botPassword;
    let source = 'env';
    if (!password) {
      password = saved && saved.password ? saved.password : generateCredentials().password;
      source = 'env name';
      if (!saved || saved.password !== password) {
        fs.mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
        writePrivate(file, JSON.stringify({ name, password }, null, 2) + '\n');
      }
    }
    const p = credentialProblem(name, password);
    if (p) throw new Error((cfg.botPassword ? 'GIFOS_BOT_NAME / GIFOS_BOT_PASSWORD: ' : 'GIFOS_BOT_NAME: ') + p);
    return { name, password, source };
  }
  if (saved) return { name: saved.name, password: saved.password, source: 'file' };
  const fresh = generateCredentials();
  fs.mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
  writePrivate(file, JSON.stringify(fresh, null, 2) + '\n');
  return { ...fresh, source: 'generated' };
}
