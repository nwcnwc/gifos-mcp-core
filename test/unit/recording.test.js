import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveRecording, writeRecording } from '../../src/driver.js';

const homes = [];
const home = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-rec-')); homes.push(h); return h; };
after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

test('saveRecording writes the bytes under recordings and reports size', () => {
  const h = home();
  const r = saveRecording(h, 's1', { b64: Buffer.from('webmdata').toString('base64'), name: 'rec ../x.webm', mime: 'video/webm' }, () => 42);
  assert.equal(r.size, 8);
  assert.equal(r.mime, 'video/webm');
  assert.equal(path.dirname(r.path), path.join(h, 'recordings'));
  assert.equal(path.basename(r.path), '42-rec_.._x.webm');
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'webmdata');
});

test('saveRecording defaults the name and mime, and refuses an empty file', () => {
  const h = home();
  const r = saveRecording(h, 's2', { b64: Buffer.from('a').toString('base64') }, () => 1);
  assert.equal(r.name, 'recording-s2.webm');
  assert.equal(r.mime, 'video/webm');
  assert.throws(() => saveRecording(h, 's2', { b64: '' }), /no recording/);
});

test('writeRecording appends slices to disk and names the file', async () => {
  const h = home();
  async function* gen() { yield Buffer.from('ab'); yield Buffer.from('cd'); }
  const r = await writeRecording(path.join(h, 'm'), 's3', { size: 4, mime: 'video/webm', name: 'x.webm' }, gen(), { file: 'recording-001.webm' });
  assert.equal(r.size, 4);
  assert.equal(r.path, path.join(h, 'm', 'recording-001.webm'));
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'abcd');
  assert.equal(fs.existsSync(r.path + '.part'), false);
  await assert.rejects(writeRecording(h, 's3', { size: 0 }, []), /no recording/);
});
