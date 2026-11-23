// The two kinds of GifOS meeting. The code, the links and the API say open / admin; the GifOS lobby's tabs say
// "Open" (a public open-floor meeting) and "Host" (admin: a private, hosted meeting; "Host a private meeting" on
// the Invite sheet; older pages said "Start a public open-floor meeting").
// "public" and "open-floor" name one kind, "private" and "hosted" the other; there are only these two.
// roomKind maps the screen words and the older ones to open / admin, and leaves anything else (a phrase that mixes
// the two kinds, or another word) as it is, so the enum refuses it.
import { z } from 'zod';

const OPEN = new Set(['open', 'public', 'floor']);
const ADMIN = new Set(['admin', 'private', 'hosted', 'host']);
const FILLER = new Set(['a', 'an', 'the', 'start', 'meeting', 'room', 'call', 'kind', 'type']);

export function roomKind(v) {
  if (typeof v !== 'string') return v;
  const words = v.toLowerCase().split(/[^a-z]+/).filter((w) => w && !FILLER.has(w));
  if (!words.length) return v;
  if (words.every((w) => OPEN.has(w))) return 'open';
  if (words.every((w) => ADMIN.has(w))) return 'admin';
  return v;
}

// A kind field: optional, the values stay 'open' and 'admin', and the screen words are accepted for them.
export function kindField(description) {
  return z.preprocess(roomKind, z.enum(['open', 'admin']).optional()).describe(description);
}
