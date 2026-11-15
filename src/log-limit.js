// A bound on every log line a stranger can drive (a visitor flood, a chat flood): logs must not be an attack vector.
// The same shape as the GifOS servers' limiter: one limiter per guard; each KIND (a code-chosen name, never data from
// the room) gets at most LOG_PER_WINDOW lines per LOG_WINDOW_MS. What is held back is counted, never lost: the kind's
// first line in its next window carries the count (" [+N suppressed]").
//
// LOG_PER_WINDOW: the guard looks at its room once per tick (3 s), so a kind that fires on every tick writes 20 lines a
// minute and is shown in full; anything faster (one line per chat line or per visitor) is a flood and is held.
// It matches the GifOS servers' limit (20 per 60 s).
export const LOG_WINDOW_MS = 60000;
export const LOG_PER_WINDOW = LOG_WINDOW_MS / 3000;
export const LOG_KINDS_MAX = 64;   // kinds come from code; the bound keeps a bug that made them from data from growing the map

export function makeLimiter(opts) {
  const o = opts || {};
  const windowMs = o.windowMs != null ? o.windowMs : LOG_WINDOW_MS;
  const per = o.perWindow != null ? o.perWindow : LOG_PER_WINDOW;
  const now = o.now || (() => Date.now());
  const kinds = new Map();   // kind -> { start, n, held }
  function take(kind) {
    const t = now();
    let k = kinds.get(kind);
    if (!k || t - k.start >= windowMs) {
      const held = k ? k.held : 0;
      if (k) kinds.delete(kind);
      k = { start: t, n: 1, held: 0 };
      kinds.set(kind, k);
      if (kinds.size > LOG_KINDS_MAX) kinds.delete(kinds.keys().next().value);
      return { ok: true, suppressed: held };
    }
    if (k.n < per) { k.n++; return { ok: true, suppressed: 0 }; }
    k.held++;
    return { ok: false, suppressed: 0 };
  }
  const held = (kind) => { const k = kinds.get(kind); return k ? k.held : 0; };
  return { take, held };
}

export const suffix = (r) => (r && r.suppressed ? ' [+' + r.suppressed + ' suppressed]' : '');
