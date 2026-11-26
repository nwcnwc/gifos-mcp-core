// The site moves on under a bot that keeps its seat for hours. A GifOS deploy names a new live release in the site's
// version.json ("latest") and may raise the meet floor or change how links name a room; the bot's open page stays on
// the release it loaded, and after such a deploy it holds a room that fresh pages never reach (seen live 2026-11-26:
// both welcome bots sat on 0.9.28.35 pages while the site moved to .38, and /welcome read OFFLINE).
//
// createSiteWatch reads version.json every cfg.siteCheckMs (GIFOS_SITE_CHECK_MS, default 60 s; 0 never) through the
// SDK's watchSite. stale() says the bot's page runs another release than the live one. Who reloads:
//   - a guard (src/guard.js) claims the watch and picks its own moment, so siblings move one at a time;
//   - with no guard, a new release reloads the bot at once (refresh: its meetings are lost the usual way and the
//     clock seats them again on the new page).
import { watchSite } from '@gifos-app/agent/site';
import { log } from './log.js';

export function createSiteWatch({ cfg, bot, emit, watch = watchSite }) {
  let claimed = false;
  let floor = '';
  let loadedOn = '';   // the live release when the page was (re)loaded, for a driver that cannot read its page's own
  let w = null;
  const say = (type, data) => { try { if (emit) emit({ type, data }); } catch (e) { /* the log line still goes */ } log(type + ' ' + JSON.stringify(data)); };
  const site = {
    latest: () => (w ? w.latest() : ''),
    floor: () => floor,
    // The release the bot's page runs: its own address when the driver can read it (/versions/<v>/), else the live
    // release when it was loaded.
    pageVersion() {
      const v = typeof bot.pageVersion === 'function' ? bot.pageVersion() : '';
      if (v) return v;
      if (!loadedOn) loadedOn = site.latest();
      return loadedOn;
    },
    stale() { const l = site.latest(), p = site.pageVersion(); return !!l && !!p && l !== p; },
    // A guard decides when its bot reloads (one sibling at a time).
    claim() { claimed = true; },
    // Close the bot's page; the next call starts it fresh on the live release.
    async refresh(why) {
      const from = site.pageVersion();
      loadedOn = site.latest();
      say('site.reload', { from, to: loadedOn, why });
      if (typeof bot.refresh === 'function') await bot.refresh('the site moved to ' + loadedOn + (why ? ': ' + why : ''));
    },
    stop() { if (w) w.stop(); },
  };
  w = watch(cfg.gifosUrl, async (u) => {
    floor = u.floor || '';
    say('site.update', { from: u.from, to: u.to, floor: u.floor || null, page: site.pageVersion() });
    if (!claimed && site.stale()) await site.refresh('no guard holds a room here: reload at once').catch((e) => log('site reload failed: ' + String((e && e.message) || e)));
  }, { everyMs: cfg.siteCheckMs });
  // The first read names the release the page loaded (the bot starts with the process).
  Promise.resolve(w.check()).then(() => { if (!loadedOn) loadedOn = w.latest(); }, () => {});
  return site;
}
