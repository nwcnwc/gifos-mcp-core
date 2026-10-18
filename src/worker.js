// Stage B worker: one child process, one Chromium, one Meet Bot, a budget of
// rooms. The supervisor (pool.js) holds the MCP socket, the schedule, and
// the meeting index. It sends one call at a time per message over the IPC
// channel and routes by session id. A worker never sees the schedule file or
// a room password other than the one on the join it was handed.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SpeechQueue } from './voice/queue.js';

// What the supervisor may call. Anything else is refused, so a message can
// not reach close(), start(), or a private helper by name.
export const WORKER_METHODS = [
  'ensureStarted', 'join', 'leave', 'transcribe', 'say', 'people', 'list', 'transcript',
  'setVoice', 'interject', 'raiseHand', 'setMic', 'setCamera', 'meetingState', 'snapshot', 'info',
];

// The TMPDIR the pool made for this worker. With the supervisor gone nobody
// else removes it, so a worker leaving on disconnect takes it along.
function dropOwnTmp() {
  const dir = process.env.GIFOS_WORKER_TMP;
  if (dir && dir === process.env.TMPDIR) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* exiting anyway */ } }
}

function errorText(e) {
  return String((e && e.message) || e || 'The worker call failed.');
}

// channel: { send(msg), on('message', fn) }, normally `process`.
// makeDriver(queue) builds the driver once the queue exists, so thinking in
// this worker is reported to the supervisor under this worker's session ids.
export function serveWorker(channel, makeDriver, extra = [], closeMs = 10000) {
  const queue = new SpeechQueue({
    onThinking(id, on) { channel.send({ event: 'thinking', id: String(id), on: !!on }); },
  });
  const driver = makeDriver(queue);
  const allowed = new Set(WORKER_METHODS.concat(extra));
  let closing = null;
  const shut = () => {
    if (!closing) closing = Promise.resolve().then(() => (typeof driver.close === 'function' ? driver.close() : null)).catch(() => { /* exiting anyway */ });
    return closing;
  };
  // A supervisor that dies without sending close (SIGKILL, OOM) drops the
  // IPC channel. Chromium would keep this process and its seats alive with
  // nobody to route to them, so close the browser and go.
  channel.on('disconnect', () => {
    const t = setTimeout(() => { dropOwnTmp(); process.exit(1); }, closeMs);
    t.unref();
    shut().then(() => { dropOwnTmp(); process.exit(0); });
  });
  channel.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'close') {
      await shut();
      channel.send({ event: 'closed' });
      process.exit(0);
    }
    if (msg.type === 'ping') { channel.send({ event: 'pong' }); return; }
    if (msg.type !== 'call') return;
    const { id, method, args } = msg;
    if (method === 'leave' && args && args[0] != null) queue.leave(args[0]);
    if (!allowed.has(method) || typeof driver[method] !== 'function') {
      channel.send({ id, ok: false, error: 'The worker has no method ' + JSON.stringify(method) + '.' });
      return;
    }
    try {
      const value = await driver[method](...(Array.isArray(args) ? args : []));
      channel.send({ id, ok: true, value: value === undefined ? null : value });
    } catch (e) {
      channel.send({ id, ok: false, error: errorText(e) });
    }
  });
  channel.send({ event: 'up' });
  return { driver, queue };
}

// Started with child_process.fork. The supervisor passes its config and this
// worker's own profile and credentials in the first message, not in argv or
// the environment, so `ps` does not show the bot password.
async function main() {
  const [{ MeetingBotDriver }, { installKokoro }] = await Promise.all([
    import('./driver.js'),
    import('./voice/kokoro.js'),
  ]);
  // Until serveWorker takes over, nothing else listens. A boot can sit in a
  // stalled Kokoro download for good, and no browser is open yet, so a
  // supervisor that dies or closes ends it at once (the part file is kept
  // for the next start to resume).
  const onDisconnect = () => { dropOwnTmp(); process.exit(1); };
  const onClose = (msg) => { if (msg && msg.type === 'close') process.exit(0); };
  process.on('disconnect', onDisconnect);
  process.on('message', onClose);
  process.once('message', async (boot) => {
    const { cfg, creds } = boot || {};
    let kokoroPromise = null;
    if (cfg.voice && cfg.voice.tts && cfg.voice.tts.source === 'mcp') {
      kokoroPromise = installKokoro({ home: cfg.home, voice: cfg.voice.tts.voice, host: cfg.voice.tts.weights })
        .catch((e) => { process.stderr.write('Kokoro is not available: ' + String((e && e.message) || e) + '\n'); return null; });
    }
    process.removeListener('disconnect', onDisconnect);
    process.removeListener('message', onClose);
    if (!process.connected) process.exit(1);
    serveWorker(process, (queue) => new MeetingBotDriver(cfg, creds, null, { queue, kokoroPromise }));
  });
  process.send({ event: 'boot' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.send) main();
