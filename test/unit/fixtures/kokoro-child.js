// Loads Kokoro in its own process so a test can kill it mid-download.
// argv: home, weights host. Prints one JSON line with the outcome.
import { installKokoro } from '../../../src/voice/kokoro.js';

const [home, host] = process.argv.slice(2);
installKokoro({ home, host, voice: 'af_heart', dtype: 'q8' }).then(
  () => { process.stdout.write(JSON.stringify({ ok: true }) + '\n'); process.exit(0); },
  (e) => { process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }) + '\n'); process.exit(1); },
);
