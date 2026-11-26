// The two kinds of meeting, in the words the GifOS screens use: "Start a public open-floor meeting" is type/mode open,
// "Host a private meeting" (a private, hosted meeting) is admin. The API values stay open / admin. "public" and
// "open-floor" are one kind, "private" and "hosted" the other, and there are only two kinds: no tool text may put a
// word of one beside a word of the other. The kind fields take the screen words and the old ones as synonyms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { registerRoomTools } from '../../src/tools/room.js';
import { createContext } from '../../src/context.js';
import { loadConfig } from '../../src/config.js';
import { MeetingStore } from '../../src/meetings.js';
import { tmpHome } from './fixtures/tmp-home.js';

const PUB = '(?:public|open[- ]floor|majority[- ]rules)', PRIV = '(?:private|hosted)', GAP = '[\\s,;:/()–—-]*(?:and|or|&)?[\\s,;:/()–—-]*';
export const MIX = new RegExp('\\b' + PUB + GAP + PRIV + '\\b|\\b' + PRIV + GAP + PUB + '\\b', 'i');
const OLD = [/\bopen[- ]floor\b/i, /\bopen rooms?\b/i, /\bopen-room\b/i, /\badmin rooms?\b/i, /\ba room with a host\b/i];

async function tools() {
  const home = tmpHome('gifos-mcp-core-kind-');
  const cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:19510/', GIFOS_BOT_NAME: 'notes-test', GIFOS_BOT_PASSWORD: 'quiet-cedar-42' });
  const bot = { ensureStarted: async () => {}, info: async () => ({ state: 'ready' }) };
  const ctx = createContext({ cfg, meetings: new MeetingStore(home), bot, botName: 'notes-test', botPassword: 'quiet-cedar-42' });
  const server = createServer({ name: 'gifos-meet-mcp', version: '0.0.0', ctx, register: (sv, c) => registerRoomTools(sv, c, { name: 'gifos-meet-mcp' }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'unit', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools: list } = await client.listTools();
  await client.close();
  fs.rmSync(home, { recursive: true, force: true });
  assert.ok(list.some((t) => t.name === 'guard_room') && list.some((t) => t.name === 'sign_in_as_host'), 'the room and guard tools are listed');
  return list;
}
const textsOf = (list) => list.flatMap((t) => [[t.name, (t.title || '') + ' ' + (t.description || '')]]
  .concat(Object.entries((t.inputSchema && t.inputSchema.properties) || {}).map(([p, s]) => [t.name + '.' + p, s.description || ''])));

test('guard_room names both kinds the way the screens do, and mode keeps the values open and admin', async () => {
  const g = (await tools()).find((t) => t.name === 'guard_room');
  const all = g.description + ' ' + g.inputSchema.properties.mode.description;
  assert.match(all, /public majority-rules meeting \(open meeting\)/, 'names the open kind (first mention: majority-rules meeting (open meeting))');
  assert.match(all, /private meeting/, 'names the admin kind');
  assert.match(g.inputSchema.properties.mode.description, /open[^.]*public majority-rules meeting/);
  assert.match(g.inputSchema.properties.mode.description, /admin[^.]*private meeting/);
  assert.deepEqual(g.inputSchema.properties.mode.enum, ['open', 'admin'], 'the API values are unchanged');
});

test('no tool text uses an old room name (open-floor is retired: majority-rules meeting) or puts a public word beside a private/hosted word', async () => {
  for (const [where, text] of textsOf(await tools())) {
    for (const re of OLD) assert.equal(re.test(text), false, where + ' says ' + re + ': ' + text);
    assert.equal(MIX.test(text), false, where + ' mixes the two kinds: ' + text);
  }
  assert.ok(['a public hosted meeting', 'private open-floor', 'public or private meetings'].every((s) => MIX.test(s)));
  assert.ok(['a private, hosted meeting', 'a public majority-rules meeting'].every((s) => !MIX.test(s)));
});

test('the kind field takes the screen words and the old ones as synonyms, and refuses a mixed phrase', async () => {
  const { roomKind, kindField } = await import('../../src/kind.js');
  for (const w of ['open', 'public', 'Public', 'open floor', 'open-floor', 'Open floor', 'a public open-floor meeting', 'Start a public open-floor meeting', 'open room', 'public meeting', 'majority rules', 'majority-rules', 'a public majority-rules meeting', 'Majority-rules meeting']) assert.equal(roomKind(w), 'open', w);
  for (const w of ['admin', 'private', 'Private', 'hosted', 'private meeting', 'a private, hosted meeting', 'Host a private meeting', 'hosted meeting', 'admin room', 'private hosted meeting']) assert.equal(roomKind(w), 'admin', w);
  const s = z.object({ mode: kindField('kind') });
  assert.equal(s.parse({ mode: 'private' }).mode, 'admin');
  assert.equal(s.parse({ mode: 'open floor' }).mode, 'open');
  assert.equal(s.parse({}).mode, undefined, 'still optional');
  for (const w of ['public hosted', 'private open-floor', 'hosted public meeting', 'zoom']) assert.equal(s.safeParse({ mode: w }).success, false, w);
});

// The role is "host" wherever a person or an agent reads it; "admin" stays only as the API value (type / mode "admin",
// the enum, the admin_password parameter name) and in code. A public open-floor meeting can be taken over as host only with a GifOS staff pass.
const API_ADMIN = /\b(?:type|mode)[:=]?\s*["'`]?admin\b["'`]?|["'`]admin["'`]|\badmin_password\b|\badmin:|\bfor admin\b|\bopen \/ admin\b|\bopen or admin\b/gi;
const sayAdmin = (t) => /\badmins?\b|\bco-admins?\b|Make me admin/i.test(String(t).replace(API_ADMIN, ' '));
// Every string literal with a space in a source file, comment lines dropped: what the tools return or describe.
function literals(file) {
  const out = [];
  fs.readFileSync(new URL('../../src/' + file, import.meta.url), 'utf8').split('\n').forEach((ln, i) => {
    const t = ln.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    for (const m of ln.replace(/\s\/\/\s.*$/, '').matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const v = m[1] ?? m[2] ?? m[3];
      if (/\s/.test(v)) out.push([file + ':' + (i + 1), v]);
    }
  });
  return out;
}

test('the role is "host" in every tool text and returned message; admin only as the API value', async () => {
  for (const [where, text] of textsOf(await tools())) assert.equal(sayAdmin(text), false, where + ' says admin: ' + text);
  for (const f of ['room.js', 'guard.js', 'tools/room.js', 'tools/guard.js', 'tools/shared.js']) {
    for (const [where, v] of literals(f)) assert.equal(sayAdmin(v), false, where + ' says admin: ' + v);
  }
  assert.equal(sayAdmin('type "admin" and mode admin, admin_password'), false, 'API values pass');
  assert.equal(sayAdmin('hold it as its admin'), true, 'the role word fails');
});

test('the kind fields take "host" for admin too', async () => {
  const { roomKind } = await import('../../src/kind.js');
  for (const w of ['host', 'Host', 'a host meeting', 'hosted']) assert.equal(roomKind(w), 'admin', w);
  for (const w of ['public host', 'open-floor host meeting']) assert.notEqual(roomKind(w), 'admin', w);
});
