// The browser is the one already on this computer: GIFOS_CHROME, then
// Chrome, then Edge, then a Playwright Chromium already installed. Nothing
// is downloaded. No real browser starts here: launch is a stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserCandidates, channelInstalled, launchInstalled, NO_BROWSER } from '../../src/browser.js';

const all = () => true;

const missing = (o) => new Error(o.channel ? "Chromium distribution '" + o.channel + "' is not found at /opt/x\nRun \"npx playwright install " + o.channel + '"' : "browserType.launch: Executable doesn't exist at " + o.executablePath);

test('the order is GIFOS_CHROME alone, else Chrome, Edge, then an installed Playwright Chromium', () => {
  assert.deepEqual(browserCandidates({ chrome: '/usr/bin/x' }, '/b/chrome'), [{ name: 'GIFOS_CHROME', executablePath: '/usr/bin/x' }]);
  assert.deepEqual(browserCandidates({}, '', all).map((c) => c.channel || c.executablePath), ['chrome', 'msedge']);
  assert.deepEqual(browserCandidates({}, '/b/chrome', all).map((c) => c.channel || c.executablePath), ['chrome', 'msedge', '/b/chrome']);
});

test('Chrome first; Edge when Chrome is missing; the bundled one last', async () => {
  const tried = [];
  const fake = (have) => async (o) => { tried.push(o.channel || o.executablePath); if (have.includes(o.channel || o.executablePath)) return { ok: o }; throw missing(o); };
  let r = await launchInstalled(fake(['chrome', 'msedge']), { headless: true }, {}, browserCandidates({}, '', all));
  assert.equal(r.used, 'Google Chrome');
  assert.equal(r.browser.ok.headless, true);
  tried.length = 0;
  r = await launchInstalled(fake(['msedge']), {}, {}, browserCandidates({}, '', all));
  assert.equal(r.used, 'Microsoft Edge');
  assert.deepEqual(tried, ['chrome', 'msedge']);
  r = await launchInstalled(fake(['/b/chrome']), {}, {}, browserCandidates({}, '/b/chrome', all));
  assert.equal(r.used, 'Playwright Chromium');
});

test('with no browser it fails with what to install, and never downloads one', async () => {
  const err = await launchInstalled(async (o) => { throw missing(o); }, {}, {}, browserCandidates({}, '', all)).then(() => null, (e) => e);
  assert.equal(err.message, NO_BROWSER);
  assert.match(err.message, /Install Google Chrome/);
  assert.match(err.message, /never downloads/);
});

test('a GIFOS_CHROME that does not start is reported, not silently replaced; other errors are not hidden', async () => {
  const bad = await launchInstalled(async () => { throw new Error('spawn EACCES'); }, {}, { chrome: '/x' }).then(() => null, (e) => e);
  assert.match(bad.message, /GIFOS_CHROME did not start \(spawn EACCES\)/);
  const crash = await launchInstalled(async () => { throw new Error('Target page crashed'); }, {}, {}, browserCandidates({}, '', all)).then(() => null, (e) => e);
  assert.equal(crash.message, 'Target page crashed');
});

test('no source file runs "playwright install" or downloads a browser', () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
  const files = fs.readdirSync(src, { recursive: true }).filter((f) => String(f).endsWith('.js'));
  for (const f of files) {
    const text = fs.readFileSync(path.join(src, String(f)), 'utf8');
    assert.equal(/spawnSync|execFileSync|\binstall', 'chromium'|cli\.js/.test(text), false, String(f));
  }
});

test('a channel that is not installed is skipped, not launched (a failed launch leaves temp folders behind)', async () => {
  const tried = [];
  const launch = async (o) => { tried.push(o.channel || o.executablePath); return { ok: o }; };
  const r = await launchInstalled(launch, {}, {}, browserCandidates({}, '/b/chrome', (ch) => ch === 'msedge'));
  assert.equal(r.used, 'Microsoft Edge');
  assert.deepEqual(tried, ['msedge']);
  tried.length = 0;
  const none = await launchInstalled(launch, {}, {}, browserCandidates({}, '', () => false)).then(() => null, (e) => e);
  assert.equal(none.message, NO_BROWSER);
  assert.deepEqual(tried, []);
});

test('channels are looked for where Playwright looks for them', () => {
  const at = (want) => (p) => p === want;
  assert.equal(channelInstalled('chrome', 'linux', {}, at('/opt/google/chrome/chrome')), true);
  assert.equal(channelInstalled('msedge', 'linux', {}, at('/opt/google/chrome/chrome')), false);
  assert.equal(channelInstalled('chrome', 'darwin', {}, at('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')), true);
  const win = { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files' };
  assert.equal(channelInstalled('msedge', 'win32', win, at('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')), true);
  assert.equal(channelInstalled('chrome', 'win32', win, at('C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')), true);
  assert.equal(channelInstalled('chrome', 'freebsd', {}, () => true), false);
});
