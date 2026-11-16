// Which browser the servers drive: the one already on this computer. Never
// downloads or installs one.
//
// Order: GIFOS_CHROME (a path), then Google Chrome, then Microsoft Edge
// (Playwright channels "chrome" and "msedge"), then a Chromium that
// `npx playwright install chromium` put there earlier, if any. When none is
// found the error says what to install.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

export const NO_BROWSER = 'No Chrome or Edge on this computer. Install Google Chrome (https://www.google.com/chrome/), '
  + 'or run "npx playwright install chromium" once, or set GIFOS_CHROME to a Chrome or Chromium binary. '
  + 'This server never downloads a browser by itself.';

const MISSING_RE = /is not found at|Executable doesn't exist|ENOENT/i;

export function bundledChromium() {
  try {
    const exe = chromium.executablePath();
    return exe && fs.existsSync(exe) ? exe : '';
  } catch (e) {
    return '';
  }
}

// Where Playwright looks for the "chrome" and "msedge" channels (its
// registry). A launch of a channel that is not there still leaves a
// playwright-artifacts-* and a profile folder in the temp folder, so a
// channel that is not installed is skipped instead of tried.
const CHANNEL_AT = {
  chrome: { linux: '/opt/google/chrome/chrome', darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', win32: '\\Google\\Chrome\\Application\\chrome.exe' },
  msedge: { linux: '/opt/microsoft/msedge/msedge', darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', win32: '\\Microsoft\\Edge\\Application\\msedge.exe' },
};

export function channelInstalled(channel, platform = process.platform, env = process.env, exists = fs.existsSync) {
  const at = (CHANNEL_AT[channel] || {})[platform];
  if (!at) return false;
  const roots = platform === 'win32'
    ? [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.HOMEDRIVE && env.HOMEDRIVE + '\\Program Files', env.HOMEDRIVE && env.HOMEDRIVE + '\\Program Files (x86)'].filter(Boolean)
    : [''];
  return roots.some((r) => exists(platform === 'win32' ? path.win32.join(r, at) : at));
}

// The launch options to try, in order. cfg.chrome is GIFOS_CHROME.
export function browserCandidates(cfg, bundled = bundledChromium(), has = channelInstalled) {
  if (cfg && cfg.chrome) return [{ name: 'GIFOS_CHROME', executablePath: cfg.chrome }];
  const out = [{ name: 'Google Chrome', channel: 'chrome' }, { name: 'Microsoft Edge', channel: 'msedge' }]
    .map((c) => ({ ...c, present: Boolean(has(c.channel)) }));
  if (bundled) out.push({ name: 'Playwright Chromium', executablePath: bundled });
  return out;
}

// launch(opts) is chromium.launch or chromium.launchPersistentContext bound
// to its first argument. Returns { browser, used } with the one that started.
export async function launchInstalled(launch, opts, cfg, candidates) {
  const list = candidates || browserCandidates(cfg);
  let last = null;
  for (const c of list) {
    if (c.present === false) continue;
    const o = { ...opts };
    if (c.channel) o.channel = c.channel;
    if (c.executablePath) o.executablePath = c.executablePath;
    try {
      return { browser: await launch(o), used: c.name };
    } catch (e) {
      last = e;
      const msg = String((e && e.message) || e);
      // GIFOS_CHROME is what the user asked for: say why it did not start.
      if (c.name === 'GIFOS_CHROME') throw new Error('GIFOS_CHROME did not start (' + msg.split('\n')[0] + ').');
      if (!MISSING_RE.test(msg)) throw e;
    }
  }
  const e = new Error(NO_BROWSER);
  e.cause = last;
  throw e;
}

// Chrome refuses a second process on the same profile (SingletonLock).
// A lock whose pid is dead is removed so the next launch can use the
// profile. A lock a live process still holds is left alone, and the launch
// uses a per-process directory instead, so two connectors cannot break
// each other's joins.
export const CHROME_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

export function lockPid(target) {
  const m = /-(\d+)$/.exec(String(target || '').replace(/\0/g, '').trim());
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

// { dir, cleared, reason }. reason is free, stale, in-use, or unknown-lock.
export function profileDirForLaunch(dir, opts = {}) {
  const pid = opts.pid || process.pid;
  const exists = opts.exists || fs.existsSync;
  const readlink = opts.readlink || fs.readlinkSync;
  const unlink = opts.unlink || fs.unlinkSync;
  const alive = opts.pidAlive || pidAlive;
  const aside = path.join(path.dirname(dir), path.basename(dir) + '-p' + pid);
  const lock = path.join(dir, 'SingletonLock');
  if (!exists(lock)) return { dir, cleared: false, reason: 'free' };
  let target = '';
  try { target = readlink(lock); } catch (e) { target = ''; }
  const holder = lockPid(target);
  if (holder && alive(holder)) return { dir: aside, cleared: false, reason: 'in-use', holder };
  if (holder) {
    for (const name of CHROME_LOCK_FILES) {
      const p = path.join(dir, name);
      try { if (exists(p)) unlink(p); } catch (e) {}
    }
    return { dir, cleared: true, reason: 'stale', holder };
  }
  return { dir: aside, cleared: false, reason: 'unknown-lock' };
}

export { chromium };
