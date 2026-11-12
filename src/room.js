// Meeting features that Meeting Bot's control API (window.MeetingBot) does
// not carry yet: the agenda, running an app in the meeting, the stage, and
// signing in as the host. GifOS 0.9.26 has them in the meeting page itself,
// so the bot's browser reaches them in the bot's own meeting frame
// (iframe[data-gifos-meet=<session>], same origin as the page that holds
// Meeting Bot). Everything here acts as the bot's own seat, with the same
// rights any person in that seat has: a guest cannot do what only a host may.
//
// roomPageOp runs INSIDE the browser (Playwright serializes it), so it must
// not use anything from this module's scope.

export const ROOM_OPS = [
  'agenda.get', 'agenda.add', 'agenda.next',
  'app.list', 'app.run', 'app.stop', 'app.state',
  'stage.get', 'stage.set', 'stage.grant',
  'host.signin', 'host.state',
];

export const OLD_SITE = 'This GifOS site does not have that yet (it needs GifOS 0.9.26 or newer).';

export async function roomPageOp({ id, op, args, oldSite, waitMs }) {
  const a = args || {};
  const frames = Array.from(document.querySelectorAll('iframe[data-gifos-meet]'));
  const f = frames.find((x) => x.getAttribute('data-gifos-meet') === String(id));
  if (!f) return { ok: false, error: 'The bot is not in that meeting any more.' };
  let w;
  try { w = f.contentWindow; if (!w || !w.document) throw new Error('no window'); }
  catch (e) { return { ok: false, error: 'The meeting page cannot be reached.' }; }
  const g = w.__gifosVideo || {};
  const has = (fn) => typeof fn === 'function';
  const status = () => { try { return has(g.statusText) ? String(g.statusText() || '').trim() : ''; } catch (e) { return ''; } };
  const why = (base) => { const s = status(); return s ? base + ' The meeting says: ' + s : base; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (test, ms) => { const end = Date.now() + ms; for (;;) { let v = false; try { v = await test(); } catch (e) { v = false; } if (v || Date.now() >= end) return !!v; await sleep(200); } };
  const admin = () => (has(g.amAdmin) ? !!g.amAdmin() : false);
  const agenda = () => { const c = has(w.__meetContent) ? w.__meetContent() : null; return c && c.agenda ? c.agenda : null; };
  const appState = () => ({
    running: has(g.appActive) ? !!g.appActive() : false,
    name: has(g.appName) && has(g.appActive) && g.appActive() ? String(g.appName() || '').trim() : '',
    started_by_bot: has(g.appIsHost) ? !!g.appIsHost() : false,
    bot_may_run_apps: has(g.canRunApp) ? !!g.canRunApp() : false,
  });
  const stageState = () => {
    const info = has(g.stageInfo) ? g.stageInfo() : null;
    return {
      bot_on_stage: has(g.onStage) ? !!g.onStage() : false,
      bot_may_step_up: has(g.canStageNow) ? !!g.canStageNow() : false,
      on_stage: info && Array.isArray(info.stagers) ? info.stagers.map((s) => ({ id: s.id, name: s.name || null, bot: !!s.me })) : [],
      seats: info && info.cap ? info.cap : null,
      bot_is_host: admin(),
    };
  };
  const apps = async () => {
    const st = w.GifOS && w.GifOS.store;
    if (!st || !has(st.allFileMeta)) return [];
    const files = (await st.allFileMeta()) || [];
    const system = { meet: 1, video: 1, broadcast: 1, appstore: 1 };
    return files.filter((x) => x && x.isApp && !system[x.appId])
      .map((x) => ({ app_id: x.appId || '', name: String(x.name || x.appId || 'App').replace(/\.gif$/i, ''), file_id: x.id }));
  };
  try {
    switch (op) {
      case 'agenda.get': {
        if (!has(w.__meetContent)) return { ok: true, v: { supported: false, note: oldSite } };
        return { ok: true, v: { supported: true, agenda: agenda() } };
      }
      case 'agenda.add': {
        const d = w.__meetContentDo;
        if (!d || !has(d.agendaAdd)) return { ok: false, error: oldSite };
        const now = agenda();
        if (now && !now.local && Array.isArray(now.items) && now.items.length && !a.append) {
          return { ok: false, error: 'This meeting already has an agenda (' + now.items.length + ' items). Pass append:true to add to it.' };
        }
        if (has(d.agendaOpen)) await d.agendaOpen();
        const added = [];
        for (const it of a.items || []) {
          const took = await d.agendaAdd(String(it.title), Math.max(0, Math.min(600, Math.round(Number(it.minutes) || 0))));
          if (!took) {
            return { ok: false, error: why((added.length ? 'Added ' + added.length + ' items, then ' : '') + 'GifOS did not take "' + it.title + '". In a room with a host only the host may change the agenda: sign the bot in with sign_in_as_host.') };
          }
          added.push(String(it.title));
        }
        return { ok: true, v: { added, agenda: agenda() } };
      }
      case 'agenda.next': {
        const d = w.__meetContentDo;
        if (!d || !has(d.agendaNext)) return { ok: false, error: oldSite };
        const before = agenda();
        if (!before || !before.n) return { ok: false, error: 'This meeting has no agenda yet. Use set_agenda first.' };
        const took = await d.agendaNext();
        if (!took) return { ok: false, error: why('GifOS did not move the agenda on. Only the person who shared it (or the host) may.') };
        return { ok: true, v: { agenda: agenda() } };
      }
      case 'app.list': return { ok: true, v: { apps: await apps(), ...appState() } };
      case 'app.state': return { ok: true, v: appState() };
      case 'app.run': {
        if (!has(g.runAppForTest)) return { ok: false, error: oldSite };
        if (has(g.canRunApp) && !g.canRunApp()) return { ok: false, error: why('The bot may not run apps in this meeting. In a room with a host, only the host and people the host allows may.') };
        const want = String(a.app || '').trim().toLowerCase();
        const list = await apps();
        const hit = list.find((x) => x.app_id.toLowerCase() === want) || list.find((x) => x.name.toLowerCase() === want)
          || list.find((x) => x.name.toLowerCase().replace(/\s+/g, '') === want.replace(/\s+/g, ''));
        if (!hit) return { ok: false, error: 'No app named "' + a.app + '" is installed for the bot. Installed: ' + list.map((x) => x.name).slice(0, 40).join(', ') + '.' };
        await g.runAppForTest(hit.file_id, hit.name);
        const up = await until(() => g.appActive(), waitMs || 15000);
        if (!up) return { ok: false, error: why(hit.name + ' did not start in the meeting.') };
        // The app's abilities sheet opens on the bot's own page too. The bot's
        // operator asked for this app, so it keeps the abilities the app
        // declares (checked by default) and closes the sheet with Confirm & Save.
        // A link's ask (#perm-go) is never accepted here.
        await until(() => { const d = w.document.querySelector('.perm-box button.done:not(#perm-go)'); if (d) d.click(); return !!d; }, 3000);
        return { ok: true, v: { started: hit.name, app_id: hit.app_id, ...appState() } };
      }
      case 'app.stop': {
        if (!has(g.stopAppForTest)) return { ok: false, error: oldSite };
        if (has(g.appActive) && !g.appActive()) return { ok: true, v: { stopped: false, note: 'No app is running.', ...appState() } };
        if (has(g.appIsHost) && !g.appIsHost()) return { ok: false, error: 'Someone else started this app; the bot can only stop an app it started.' };
        await g.stopAppForTest();
        await until(() => !g.appActive(), 5000);
        return { ok: true, v: { stopped: true, ...appState() } };
      }
      case 'stage.get': {
        if (!has(g.stageInfo)) return { ok: false, error: oldSite };
        return { ok: true, v: stageState() };
      }
      case 'stage.set': {
        if (!has(g.setStageForTest)) return { ok: false, error: oldSite };
        const on = !!a.on;
        if (on && has(g.canStageNow) && !g.canStageNow()) return { ok: false, error: why('The bot may not step on the stage here. In a room with a host, the host has to allow it (or sign the bot in as host).') };
        if (on && stageState().seats && stageState().on_stage.length >= stageState().seats && !stageState().bot_on_stage) return { ok: false, error: 'The stage is full. Someone has to step down first.' };
        await g.setStageForTest(on);
        await until(() => (has(g.onStage) ? !!g.onStage() === on : true), 5000);
        return { ok: true, v: stageState() };
      }
      case 'stage.grant': {
        if (!has(g.grantApp)) return { ok: false, error: oldSite };
        if (!admin()) return { ok: false, error: 'Only a host can allow someone on the stage. Sign the bot in with sign_in_as_host first.' };
        const pid = String(a.person_id || '');
        await g.grantApp(pid, !!a.on);
        return { ok: true, v: { person_id: pid, allowed: !!a.on, ...stageState() } };
      }
      case 'host.state': return { ok: true, v: { bot_is_host: admin(), host_room: !!(w.document.getElementById('admbtn') && w.document.getElementById('admbtn').style.display !== 'none') } };
      case 'host.signin': {
        if (admin()) return { ok: true, v: { bot_is_host: true, note: 'Already signed in as host.' } };
        const doc = w.document;
        const btn = doc.getElementById('admbtn');
        const pass = doc.getElementById('adm-pass');
        const go = doc.getElementById('adm-enable');
        if (!btn || !pass || !go) return { ok: false, error: oldSite };
        if (btn.style.display === 'none') return { ok: false, error: 'This meeting has no host (it is an open room), so there is nothing to sign in to.' };
        btn.click();
        pass.value = String(a.password || '');
        go.click();
        pass.value = '';
        const ok = await until(() => admin(), waitMs || 15000);
        const modal = doc.getElementById('adm-modal');
        if (modal) modal.style.display = 'none';
        if (!ok) return { ok: false, error: 'That host password did not sign the bot in.' };
        return { ok: true, v: { bot_is_host: true } };
      }
      default: return { ok: false, error: 'Unknown room op.' };
    }
  } catch (e) {
    return { ok: false, error: why(String((e && e.message) || e)) };
  }
}

// Take Turns (GifOS 0.9.26 Tools app) runs in a sandboxed frame inside the
// meeting page, with no API of its own: it is read and pressed the way a
// person does. turnsPageOp runs inside that app frame.
export const TURNS_OPS = ['turns.state', 'turns.next', 'turns.back', 'turns.pass', 'turns.restart', 'turns.shuffle', 'turns.timer'];

export function turnsPageOp({ op, args }) {
  const $ = (s) => document.querySelector(s);
  const txt = (s) => { const e = $(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; };
  const txtOf = (e) => (e ? e.textContent.replace(/\s+/g, ' ').trim() : '');
  const read = () => ({
    up_now: txt('#who') || null,
    up_next: txt('#upnext b') || null,
    item: txt('#item') || null,
    turn: txt('#turnno') || null,
    time_left: txt('#timeleft') || null,
    here: txt('#chip') || null,
    order: Array.from(document.querySelectorAll('#order li')).map((li) => ({ name: txtOf(li.querySelector('.nm')), current: li.classList.contains('cur') })),
    note: txt('#note') || txt('#stagenote') || null,
  });
  const press = (sel) => {
    const b = $(sel);
    if (!b || b.hidden || b.disabled) return false;
    b.click();
    return true;
  };
  if (!$('#who') && !$('#next')) return { ok: false, error: 'The app running in this meeting is not Take Turns.' };
  const sel = { 'turns.next': '#next', 'turns.back': '#back', 'turns.pass': '#pass', 'turns.restart': '#restart', 'turns.shuffle': '#shuffle' }[op];
  if (op === 'turns.state') return { ok: true, v: read() };
  if (op === 'turns.timer') {
    const secs = Math.round(Number(args && args.seconds) || 0);
    if (!press('#timers button[data-t="' + secs + '"]')) return { ok: false, error: 'Take Turns has timers of 0 (off), 60, 120, 180, 300 or 600 seconds.' };
    return { ok: true, v: read() };
  }
  if (!sel) return { ok: false, error: 'Unknown Take Turns op.' };
  if (!press(sel)) return { ok: false, error: 'That Take Turns button is not available to the bot right now. In a room with a host, the host leads Take Turns.' };
  return { ok: true, v: read() };
}
