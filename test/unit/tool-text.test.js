// The shared tools' text, as each server lists it: it names only the tools
// that server has (create_broadcast on the broadcast server, create_meeting
// on the meet server), calls the app Meeting Bot, and does not assume which
// assistant is calling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { loadConfig } from '../../src/config.js';
import { MeetingStore } from '../../src/meetings.js';
import { SNAPSHOT_GAP } from '../../src/voice/settings.js';
import fs from 'node:fs';
import { tmpHome } from './fixtures/tmp-home.js';

// The tools each product adds itself (not in core).
const OWN = {
  'gifos-meet-mcp': ['create_meeting', 'join_meeting'],
  'gifos-broadcast-mcp': ['create_broadcast', 'join_broadcast'],
};

async function texts(name) {
  const home = tmpHome('gifos-mcp-core-text-');
  const cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:19510/', GIFOS_BOT_NAME: 'notes-test', GIFOS_BOT_PASSWORD: 'quiet-cedar-42' });
  const bot = { ensureStarted: async () => {}, info: async () => ({ state: 'ready' }) };
  const ctx = createContext({ cfg, meetings: new MeetingStore(home), bot, botName: 'notes-test', botPassword: 'quiet-cedar-42' });
  const server = createServer({ name, version: '0.0.0', ctx });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'unit', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  const out = [];
  for (const t of tools) {
    out.push([t.name, (t.title || '') + ' ' + (t.description || '')]);
    for (const [p, s] of Object.entries((t.inputSchema && t.inputSchema.properties) || {})) out.push([t.name + '.' + p, s.description || '']);
  }
  await client.close();
  fs.rmSync(home, { recursive: true, force: true });
  return { names: tools.map((t) => t.name).concat(OWN[name]), out };
}

for (const name of Object.keys(OWN)) {
  test(name + ': the shared tool text names only tools this server has', async () => {
    const { names, out } = await texts(name);
    const other = Object.entries(OWN).filter(([n]) => n !== name).flatMap(([, t]) => t);
    for (const [where, text] of out) {
      for (const tool of other) assert.equal(new RegExp('\\b' + tool + '\\b').test(text), false, where + ' names ' + tool + ': ' + text);
      for (const m of text.match(/\b(?:create|join)_[a-z]+\b/g) || []) assert.ok(names.includes(m), where + ' names ' + m);
    }
  });

  test(name + ': the shared tool text says Meeting Bot and names no particular assistant', async () => {
    const { out } = await texts(name);
    for (const [where, text] of out) {
      assert.equal(/Meet Bot/.test(text), false, where + ': ' + text);
      assert.equal(/Grok/.test(text), false, where + ': ' + text);
    }
  });
}

test('the snapshot gap names Meeting Bot', () => {
  assert.equal(/Meet Bot/.test(SNAPSHOT_GAP), false, SNAPSHOT_GAP);
});
