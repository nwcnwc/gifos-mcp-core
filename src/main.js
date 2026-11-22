// The process both GifOS MCP servers run: read the environment, set up
// Kokoro, the stores and the bot (one Chromium, or a supervisor with
// workers), then serve MCP over stdio or over HTTP on 127.0.0.1.
//
//   <bin>                 MCP over stdio (what Grok Bot launches)
//   <bin> --http [port]   MCP over streamable HTTP on 127.0.0.1
//
// HTTP mode binds its port FIRST: a second copy on a port in use exits at once (code 1) with no browser and no stores
// touched, so a leftover server is never joined by a twin. GIFOS_PARENT_PID (or --parent-pid N), when given, ends the
// server and its browser when that process is gone (opt-in: a daemon started on purpose has no parent to watch).
//
// product: { name, version, httpPort, readme, register(server, ctx), onStart?(ctx), onClose?(ctx) }
import http from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, botCredentials } from './config.js';
import { MeetingStore } from './meetings.js';
import { CoreBotDriver } from './core-driver.js';
import { MeetingBotDriver } from './driver.js';
import { WorkerPool } from './pool.js';
import { dropLostMeetings } from './supervisor.js';
import { ScheduleStore } from './schedule.js';
import { EventLog } from './events.js';
import { SpeechQueue } from './voice/queue.js';
import { createContext } from './context.js';
import { createServer } from './server.js';
import { LiveTranscript, watchCaptions } from './voice/live.js';
import { scrub } from './voice/settings.js';
import { installKokoro, KOKORO_REVISION } from './voice/kokoro.js';
import { log } from './log.js';

export const ENV_HELP = 'Environment: GIFOS_URL, GIFOS_RELAY, GIFOS_BOT_NAME, GIFOS_BOT_PASSWORD, GIFOS_STT_APP,\n' +
  'GIFOS_MCP_HOME, GIFOS_HEADLESS, GIFOS_CHROME, GIFOS_TIMEOUT_MS, GIFOS_MCP_HTTP_TOKEN, GIFOS_MCP_LAZY,\n' +
  'GIFOS_TRANSCRIPT_POLL_MS, GIFOS_TTS_ENGINE, GIFOS_TTS_APP, GIFOS_TTS_URL, GIFOS_TTS_VOICE, GIFOS_KOKORO_URL, GIFOS_STT_URL,\n' +
  'GIFOS_MAX_MEETINGS, GIFOS_CAPACITY_NEAR, GIFOS_SCHEDULE_HORIZON_MS, GIFOS_WORKERS, GIFOS_WORKER_ROOMS, GIFOS_BOT_MODE (core: no browser).\n' +
  'There is no model key: the assistant calling the tools writes every word the bot says.\n' +
  'Kokoro weights are downloaded once into GIFOS_MCP_HOME/kokoro from Hugging Face, revision ' + KOKORO_REVISION.slice(0, 12) + ', and checked by SHA-256.\n';

// Everything one process holds, shared by every MCP server it hands out.
export async function createRuntime(env = process.env) {
  const cfg = loadConfig(env);
  const creds = botCredentials(cfg);
  // Kokoro loads in the background. A stalled or failed download must not
  // keep the server from answering: scheduling tools do not need speech.
  // say() reports a clear error if the weights never become ready.
  let kokoroPromise = null;
  if (cfg.voice.tts.source === 'mcp' && cfg.workers === 1) {
    log('loading Kokoro in the background (weights, voice ' + cfg.voice.tts.voice + ')');
    kokoroPromise = installKokoro({ home: cfg.home, voice: cfg.voice.tts.voice, host: cfg.voice.tts.weights })
      .catch((e) => { log('Kokoro is not available: ' + String((e && e.message) || e)); return null; });
  }
  const meetings = new MeetingStore(cfg.home);
  const schedule = new ScheduleStore(cfg.home);
  const events = new EventLog(cfg.home);
  const reset = meetings.resetLive();
  if (reset) log(reset + ' meeting(s) were live in the last run; they are back to scheduled');
  function onThinking(id, on) {
    const m = meetings.all().find((row) => row.meeting_id === id || row.session_id === id);
    if (!m) return;
    meetings.update(m.meeting_id, { thinking: !!on });
    events.append({ type: 'meeting.state', meeting_id: m.meeting_id, data: { thinking: !!on, transcribing: !!m.transcribing } });
  }
  // One worker: the Meet Bot runs in this process. Several: this process is
  // the supervisor and each worker is a child with its own browser.
  const bot = cfg.botMode === 'core'
    ? new CoreBotDriver(cfg, creds)
    : cfg.workers > 1
    ? new WorkerPool(cfg, creds, { workers: cfg.workers, rooms: cfg.workerRooms, onThinking })
    : new MeetingBotDriver(cfg, creds, null, { queue: new SpeechQueue({ onThinking }), kokoroPromise });
  const live = new LiveTranscript(cfg.home);
  const hide = (text) => scrub(text, [creds.password]);
  const captions = watchCaptions({ meetings, bot, live, intervalMs: cfg.voice.pollMs, botName: () => (typeof bot.botNames === 'function' ? bot.botNames() : creds.name), scrubText: hide });
  if (bot instanceof WorkerPool) bot.onLost(dropLostMeetings({ meetings, events, captions }));
  const ctx = createContext({ cfg, meetings, bot, live, captions, botName: creds.name, botPassword: creds.password, schedule, events });
  return { cfg, creds, ctx, bot, captions, hide };
}

// listen(srv, port) -> resolves once srv holds 127.0.0.1:port; rejects with the listen error (EADDRINUSE: in use).
export function listen(srv, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const bad = (e) => { srv.off('listening', ok); reject(e); };
    const ok = () => { srv.off('error', bad); resolve(srv); };
    srv.once('error', bad); srv.once('listening', ok);
    srv.listen(port, host);
  });
}

// watchParent(pid, onGone): calls onGone once when process pid no longer exists. Returns a stop function.
export const PARENT_LOOK_MS = 2000;
export function watchParent(pid, onGone, { intervalMs = PARENT_LOOK_MS, alive = isAlive } = {}) {
  const t = setInterval(() => { if (!alive(pid)) { clearInterval(t); onGone(); } }, intervalMs);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export function parentPid(argv, env) {
  const at = argv.indexOf('--parent-pid');
  const v = Number(at >= 0 ? argv[at + 1] : env.GIFOS_PARENT_PID);
  return Number.isInteger(v) && v > 1 ? v : 0;
}

export async function runMain(product, argv = process.argv.slice(2), env = process.env) {
  const { name, version } = product;
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(name + ' ' + version + '\n\n' +
      '  ' + name + '                 MCP over stdio\n' +
      '  ' + name + ' --http [port]   MCP over streamable HTTP on 127.0.0.1 (default ' + product.httpPort + ')\n\n' +
      ENV_HELP + (product.readme ? 'See ' + product.readme + '\n' : ''));
    process.exit(0);
  }
  if (argv.includes('--version')) { process.stdout.write(version + '\n'); process.exit(0); }

  // HTTP: hold the port before anything else (no runtime, no browser yet); requests wait for the runtime with a 503
  const httpAt = argv.indexOf('--http');
  let srv = null, handle = null;
  const port = httpAt >= 0 ? (Number(argv[httpAt + 1]) || product.httpPort) : 0;
  if (httpAt >= 0) {
    srv = http.createServer((req, res) => {
      if (handle) return handle(req, res);
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '2' }).end('{"error":"starting"}');
    });
    try {
      await listen(srv, port);
    } catch (e) {
      log(e && e.code === 'EADDRINUSE'
        ? 'port ' + port + ' on 127.0.0.1 is already in use (another server is running there); this one exits without starting a browser'
        : 'cannot listen on 127.0.0.1:' + port + ': ' + String((e && e.message) || e));
      process.exit(1);
    }
  }

  let rt;
  try {
    rt = await createRuntime(env);
  } catch (e) {
    log(String((e && e.message) || e));
    process.exit(1);
  }
  const { cfg, creds, ctx, bot, captions, hide } = rt;
  const make = () => createServer({ name, version, ctx, register: product.register, instructions: product.instructions });
  const boot = make();
  ctx.clock.start();
  if (typeof product.onStart === 'function') await product.onStart(ctx, rt);
  // GIFOS_GUARD_CONFIG: rooms this bot holds as their admin from the start (src/guard.js).
  if (cfg.guardConfig) {
    try {
      const { startGuardsFromConfig } = await import('./guard.js');
      const list = await startGuardsFromConfig(ctx, cfg.guardConfig, { log });
      ctx.guards = ctx.guards || new Map();
      for (const g of list) ctx.guards.set(g.policy.link, g);
      log('guarding ' + list.length + ' room(s) from ' + cfg.guardConfig);
    } catch (e) { log('guard config not started: ' + String((e && e.message) || e)); process.exit(1); }
  }
  log(name + ' ' + version + ' · GifOS ' + cfg.gifosUrl + ' · bot "' + creds.name + '" (' + creds.source + ') · data ' + cfg.home);

  let closing = false;
  async function shutdown(code) {
    if (closing) return;
    closing = true;
    captions.stopAll();
    ctx.clock.stop();
    if (typeof product.onClose === 'function') await Promise.resolve(product.onClose(ctx)).catch(() => {});
    await bot.close().catch(() => {});
    if (srv) srv.close();
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  const parent = parentPid(argv, env);
  if (parent) {
    watchParent(parent, () => { log('parent process ' + parent + ' is gone; shutting down'); shutdown(0); });
    log('watching parent process ' + parent);
  }

  if (srv) {
    const token = env.GIFOS_MCP_HTTP_TOKEN || '';
    handle = async (req, res) => {
      if (token && req.headers.authorization !== 'Bearer ' + token) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
        return;
      }
      if (!req.url || !req.url.startsWith('/mcp')) { res.writeHead(404).end(); return; }
      // Stateless: a fresh MCP server per request, sharing one bot and one store.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableDnsRebindingProtection: true,
        allowedHosts: ['127.0.0.1:' + port, 'localhost:' + port],
      });
      const server = make();
      res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (e) {
        log('http request failed: ' + hide(e.message));
        if (!res.headersSent) res.writeHead(500).end();
      }
    };
    log('listening on http://127.0.0.1:' + port + '/mcp');
  } else {
    await boot.connect(new StdioServerTransport());
    process.stdin.on('close', () => shutdown(0));
    log('ready on stdio');
  }

  // Warm up so the first join does not wait for the browser.
  if (cfg.prewarm) bot.ensureStarted().catch(() => { /* reported by status and retried on the next tool call */ });
  return rt;
}
