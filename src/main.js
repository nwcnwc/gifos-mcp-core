// The process both GifOS MCP servers run: read the environment, set up
// Kokoro, the stores and the bot (one Chromium, or a supervisor with
// workers), then serve MCP over stdio or over HTTP on 127.0.0.1.
//
//   <bin>                 MCP over stdio (what Grok Bot launches)
//   <bin> --http [port]   MCP over streamable HTTP on 127.0.0.1
//
// product: { name, version, httpPort, readme, register(server, ctx), onStart?(ctx), onClose?(ctx) }
import http from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, botCredentials } from './config.js';
import { MeetingStore } from './meetings.js';
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
  'GIFOS_MAX_MEETINGS, GIFOS_CAPACITY_NEAR, GIFOS_SCHEDULE_HORIZON_MS, GIFOS_WORKERS, GIFOS_WORKER_ROOMS.\n' +
  'There is no model key: the assistant calling the tools writes every word the bot says.\n' +
  'Kokoro weights are downloaded once into GIFOS_MCP_HOME/kokoro from Hugging Face, revision ' + KOKORO_REVISION.slice(0, 12) + ', and checked by SHA-256.\n';

// Everything one process holds, shared by every MCP server it hands out.
export async function createRuntime(env = process.env) {
  const cfg = loadConfig(env);
  const creds = botCredentials(cfg);
  let kokoro = null;
  // With several workers, each worker loads its own Kokoro from the same weights.
  if (cfg.voice.tts.source === 'mcp' && cfg.workers === 1) {
    log('setting up Kokoro (weights, voice ' + cfg.voice.tts.voice + ')');
    kokoro = await installKokoro({ home: cfg.home, voice: cfg.voice.tts.voice, host: cfg.voice.tts.weights });
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
  const bot = cfg.workers > 1
    ? new WorkerPool(cfg, creds, { workers: cfg.workers, rooms: cfg.workerRooms, onThinking })
    : new MeetingBotDriver(cfg, creds, kokoro, { queue: new SpeechQueue({ onThinking }) });
  const live = new LiveTranscript(cfg.home);
  const hide = (text) => scrub(text, [creds.password]);
  const captions = watchCaptions({ meetings, bot, live, intervalMs: cfg.voice.pollMs, botName: typeof bot.botNames === 'function' ? bot.botNames() : creds.name, scrubText: hide });
  if (bot instanceof WorkerPool) bot.onLost(dropLostMeetings({ meetings, events, captions }));
  const ctx = createContext({ cfg, meetings, bot, live, captions, botName: creds.name, botPassword: creds.password, schedule, events });
  return { cfg, creds, ctx, bot, captions, hide };
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

  let rt;
  try {
    rt = await createRuntime(env);
  } catch (e) {
    log(String((e && e.message) || e));
    process.exit(1);
  }
  const { cfg, creds, ctx, bot, captions, hide } = rt;
  const make = () => createServer({ name, version, ctx, register: product.register });
  const boot = make();
  ctx.clock.start();
  if (typeof product.onStart === 'function') await product.onStart(ctx, rt);
  log(name + ' ' + version + ' · GifOS ' + cfg.gifosUrl + ' · bot "' + creds.name + '" (' + creds.source + ') · data ' + cfg.home);

  let closing = false;
  async function shutdown(code) {
    if (closing) return;
    closing = true;
    captions.stopAll();
    ctx.clock.stop();
    if (typeof product.onClose === 'function') await Promise.resolve(product.onClose(ctx)).catch(() => {});
    await bot.close().catch(() => {});
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  const httpAt = argv.indexOf('--http');
  if (httpAt >= 0) {
    const port = Number(argv[httpAt + 1]) || product.httpPort;
    const token = env.GIFOS_MCP_HTTP_TOKEN || '';
    const srv = http.createServer(async (req, res) => {
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
    });
    srv.listen(port, '127.0.0.1', () => log('listening on http://127.0.0.1:' + port + '/mcp'));
  } else {
    await boot.connect(new StdioServerTransport());
    process.stdin.on('close', () => shutdown(0));
    log('ready on stdio');
  }

  // Warm up so the first join does not wait for the browser.
  if (cfg.prewarm) bot.ensureStarted().catch(() => { /* reported by status and retried on the next tool call */ });
  return rt;
}
