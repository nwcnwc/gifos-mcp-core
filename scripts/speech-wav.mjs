// Write a speech WAV with Kokoro fp32. q8 is corrupt on some CPUs, so the
// clip an end-to-end run plays into a meeting is generated here, not from q8.
//
//   node scripts/speech-wav.mjs out.wav 'The budget meeting is Friday morning.'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installKokoro } from '../src/voice/kokoro.js';

const out = process.argv[2];
const line = process.argv[3] || 'The budget meeting is Friday morning.';
if (!out) {
  console.error('usage: node scripts/speech-wav.mjs <out.wav> [words]');
  process.exit(2);
}
const home = process.env.GIFOS_MCP_HOME || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'gifos-mcp-test-kokoro');
const engine = await installKokoro({ home, dtype: 'fp32' });
const wav = await engine.speak(line);
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, wav);
console.log('wrote ' + path.resolve(out) + ' (' + wav.length + ' bytes) from fp32: ' + line);
