/* Meeting Bot UI. Commands are structured chat on the admin meeting only.
 * Contract version 2 adds voice. Version 1 methods keep their names. */
(function () {
  var DUP = BotProto.DUP;
  var state = {
    phase: 'idle',
    name: '',
    admin: null,
    adminId: '',
    probeId: '',
    instance: 'in_' + Math.random().toString(36).slice(2),
    meetings: {},
    lines: {},
    chats: {},
    probeBeat: null,
    warned: {},
    ctrlItems: [],
    people: {},
    respond: false,
    speak: false,
    listen: false,
    aiReady: { smartest: false, tts: false, stt: false },
    controls: {},
    recentSpoken: [],
    transcriptListeners: [],
    speaking: false,
    speakingId: '',
    speakGen: 0,
    replying: false,
    commands: [],
    errors: []
  };

  var warnEl = document.getElementById('warn');
  var suggestEl = document.getElementById('suggest');
  var phaseEl = document.getElementById('phase');
  var logEl = document.getElementById('log');
  var ignoredEl = document.getElementById('ignored');
  var rulesEl = document.getElementById('rules');

  function warn(text) {
    warnEl.textContent = text || '';
    warnEl.classList.toggle('show', !!text);
  }
  function log(line) {
    logEl.textContent += (logEl.textContent ? '\n' : '') + line;
  }
  function noteIgnored() {
    ignoredEl.textContent = 'Ignored command-like chat outside the admin meeting.';
  }
  function noteCommand(op, detail) {
    state.commands.push({ at: Date.now(), op: op, detail: detail || '' });
    if (state.commands.length > 12) state.commands.shift();
  }
  function noteError(text) {
    var msg = String(text || '').trim();
    if (!msg) return;
    state.errors.push({ at: Date.now(), text: msg });
    if (state.errors.length > 8) state.errors.shift();
  }
  function workMeetings() {
    return Object.keys(state.meetings).filter(function (id) { return !state.meetings[id].control; }).map(function (id) {
      var m = state.meetings[id];
      var people = (state.people[id] || []).filter(function (x) { return x && !x.me; });
      var c = state.controls[id] || { hand: false, mic: false, camera: false };
      return {
        id: m.meetingId, room: m.room || '', link: m.link || '', rec: !!m.rec, cc: !!m.cc,
        created: !!m.created, people: people.map(function (x) { return x.name || ''; }),
        hand: !!c.hand, mic: !!c.mic, camera: !!c.camera, watch: !!c.watch
      };
    });
  }
  function listeningNow() {
    var works = workMeetings();
    for (var i = 0; i < works.length; i++) if (works[i].cc) return true;
    return false;
  }
  function clearNode(el) {
    if (!el) return;
    el.textContent = '';
    if (el.innerHTML != null) el.innerHTML = '';
  }
  function addText(parent, tag, text, className) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text;
    parent.appendChild(el);
    return el;
  }
  function paintOps() {
    var box = document.getElementById('ops-meetings');
    clearNode(box);
    var works = workMeetings();
    if (!works.length) addText(box, 'p', 'Not in a work meeting yet.', 'muted');
    works.forEach(function (m) {
      var card = document.createElement('div');
      card.className = 'meet';
      card.dataset.id = m.id;
      addText(card, 'div', m.id);
      addText(card, 'div', m.link || m.room || '', 'muted');
      var flags = (m.rec ? '⏺ recording  ' : '') + (m.cc ? '📝 transcribing' : '');
      if (flags) addText(card, 'div', flags, 'chips');
      var people = state.people[m.id] || [];
      var row = document.createElement('div');
      if (!people.length) addText(row, 'span', 'No one else is here yet.', 'muted');
      people.forEach(function (p) {
        var label = (p.name || 'Someone') + (p.me ? ' (this bot)' : '') + (p.bot && !p.me ? ' · bot' : '');
        addText(row, 'span', label, 'person');
      });
      card.appendChild(row);
      var c = state.controls[m.id] || { hand: false, mic: false, camera: false };
      var flags2 = (c.hand ? 'Hand up  ' : '') + (c.mic ? 'Mic on  ' : '') + (c.camera ? 'Camera on' : '');
      if (flags2) addText(card, 'div', flags2.trim(), 'chips');
      var actions = document.createElement('div');
      function act(label, fn) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.onclick = fn;
        actions.appendChild(b);
      }
      act(c.hand ? 'Lower hand' : 'Raise hand', function () {
        ops.raiseHand(m.id, !c.hand).catch(function (e) { noteError(e && e.message || e); paint(); });
      });
      act(c.mic ? 'Mic off' : 'Mic on', function () {
        ops.setMic(m.id, !c.mic).catch(function (e) { noteError(e && e.message || e); paint(); });
      });
      act(c.camera ? 'Camera off' : 'Camera on', function () {
        ops.setCamera(m.id, !c.camera).catch(function (e) { noteError(e && e.message || e); paint(); });
      });
      act(c.watch ? 'Close watch' : 'Watch', function () {
        ops.watch(m.id, !c.watch).catch(function (e) { noteError(e && e.message || e); paint(); });
      });
      card.appendChild(actions);
      box.appendChild(card);
    });
    var cmd = document.getElementById('ops-commands');
    cmd.textContent = state.respond ? 'On' : 'Off';
    cmd.setAttribute('aria-pressed', state.respond ? 'true' : 'false');
    var speakBtn = document.getElementById('ops-speak');
    if (speakBtn) {
      speakBtn.textContent = state.speak ? 'On' : 'Off';
      speakBtn.setAttribute('aria-pressed', state.speak ? 'true' : 'false');
    }
    var listenBtn = document.getElementById('ops-listen');
    if (listenBtn) {
      listenBtn.textContent = state.listen ? 'On' : 'Off';
      listenBtn.setAttribute('aria-pressed', state.listen ? 'true' : 'false');
    }
    var prov = document.getElementById('ops-providers');
    prov.textContent = 'Conversation uses Smartest. ' +
      (state.aiReady.smartest ? 'Smartest is set.' : 'Smartest is not set.') + ' ' +
      (state.aiReady.tts ? 'Text to speech is set.' : 'Text to speech is not set.');
    var ear = document.getElementById('ops-ear');
    var earText = state.speaking ? 'Speaking' : (state.listen ? 'Listening' : 'Quiet');
    ear.textContent = earText;
    ear.classList.toggle('speaking', earText === 'Speaking');
    ear.classList.toggle('listening', earText === 'Listening');
    var tail = document.getElementById('ops-tail');
    clearNode(tail);
    var anyLine = false;
    works.forEach(function (m) {
      var lines = state.lines[m.id] || [];
      var slice = lines.slice(-6);
      if (!slice.length) return;
      anyLine = true;
      addText(tail, 'div', m.id, 'muted');
      var ol = document.createElement('ol');
      ol.className = 'tail';
      slice.forEach(function (l) {
        addText(ol, 'li', (l.by || 'Someone') + ': ' + (l.text || ''));
      });
      tail.appendChild(ol);
    });
    if (!anyLine) addText(tail, 'p', 'No lines yet.', 'muted');
    var chatBox = document.getElementById('ops-chat');
    if (chatBox) {
      clearNode(chatBox);
      var anyChat = false;
      works.forEach(function (m) {
        var chats = (state.chats[m.id] || []).slice(-6);
        if (!chats.length) return;
        anyChat = true;
        addText(chatBox, 'div', m.id, 'muted');
        var ol = document.createElement('ol');
        ol.className = 'tail';
        chats.forEach(function (l) { addText(ol, 'li', (l.by || 'Someone') + ': ' + (l.text || '')); });
        chatBox.appendChild(ol);
      });
      if (!anyChat) addText(chatBox, 'p', 'No chat yet.', 'muted');
    }
    var cmds = document.getElementById('ops-cmds');
    clearNode(cmds);
    if (!state.commands.length) addText(cmds, 'li', 'No commands yet.', 'muted');
    state.commands.slice(-8).forEach(function (c) {
      addText(cmds, 'li', c.op + (c.detail ? ' — ' + c.detail : ''));
    });
    var errs = document.getElementById('ops-errors');
    clearNode(errs);
    if (!state.errors.length) addText(errs, 'p', 'No errors.', 'muted');
    state.errors.slice(-6).forEach(function (e) { addText(errs, 'p', e.text); });
    var stop = document.getElementById('ops-stop');
    stop.disabled = !state.speaking;
    stop.textContent = state.speaking ? 'Stop speaking' : 'Stop speaking';
  }
  function paint() {
    var label = { idle: '', probe: 'Checking whether this bot is already running…', run: 'Running', control: 'Controlling' };
    phaseEl.textContent = label[state.phase] || state.phase;
    if (document.body && document.body.dataset) document.body.dataset.phase = state.phase;
    document.getElementById('runbox').hidden = state.phase !== 'run';
    document.getElementById('ctrl').hidden = state.phase !== 'control';
    document.getElementById('rules-label').hidden = document.getElementById('mode-control').checked && state.phase === 'idle';
    var ul = document.getElementById('run-meetings');
    ul.innerHTML = '';
    workMeetings().forEach(function (m) {
      var li = document.createElement('li');
      li.dataset.id = m.id;
      li.textContent = m.id + '  ' + (m.link || m.room) + (m.rec ? '  ⏺ recording' : '') + (m.cc ? '  📝 transcribing' : '') +
        (m.people.length ? '  with ' + m.people.join(', ') : '');
      ul.appendChild(li);
    });
    if (state.phase === 'control') renderCtrl(state.ctrlItems);
    if (state.phase === 'run') paintOps();
  }
  function renderCtrl(items) {
    state.ctrlItems = items || [];
    var box = document.getElementById('ctrl-meetings');
    box.innerHTML = '';
    if (!state.ctrlItems.length) {
      var empty = document.createElement('p');
      empty.textContent = 'No work meetings yet.';
      box.appendChild(empty);
      return;
    }
    state.ctrlItems.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'meet';
      row.dataset.id = m.id;
      var title = document.createElement('div');
      title.innerHTML = '<b></b>';
      title.querySelector('b').textContent = m.id;
      var sub = document.createElement('div');
      sub.className = 'link';
      sub.textContent = (m.link || m.room || '') + (m.people && m.people.length ? '  with ' + m.people.join(', ') : '');
      var flags = document.createElement('div');
      flags.className = 'chips';
      flags.textContent = (m.rec ? '⏺ recording  ' : '') + (m.cc ? '📝 transcribing' : '');
      var rec = document.createElement('button');
      rec.type = 'button';
      rec.textContent = m.rec ? 'Record off' : 'Record on';
      rec.onclick = function () { sendCtrl({ op: 'record', meetingId: m.id, on: !m.rec, id: qid() }); };
      var tr = document.createElement('button');
      tr.type = 'button';
      tr.textContent = m.cc ? 'Transcribe off' : 'Transcribe on';
      tr.onclick = function () { sendCtrl({ op: 'transcribe', meetingId: m.id, on: !m.cc, id: qid() }); };
      var say = document.createElement('input');
      say.type = 'text';
      say.placeholder = 'Send into this meeting';
      var sayGo = document.createElement('button');
      sayGo.type = 'button';
      sayGo.textContent = 'Send';
      sayGo.onclick = function () { sendCtrl({ op: 'say', meetingId: m.id, text: say.value, id: qid() }); say.value = ''; };
      var dl = document.createElement('button');
      dl.type = 'button';
      dl.textContent = 'Download transcript';
      dl.onclick = function () { sendCtrl({ op: 'transcript', meetingId: m.id, id: qid() }); };
      var dlr = document.createElement('button');
      dlr.type = 'button';
      dlr.textContent = 'Download recording';
      dlr.onclick = function () { sendCtrl({ op: 'recording', meetingId: m.id, id: qid() }); };
      var leave = document.createElement('button');
      leave.type = 'button';
      leave.className = 'ghost';
      leave.textContent = 'Leave';
      leave.onclick = function () { sendCtrl({ op: 'leave', meetingId: m.id, id: qid() }); };
      var voice = document.createElement('button');
      voice.type = 'button';
      voice.textContent = state.speak ? 'Speak on' : 'Speak off';
      voice.onclick = function () { sendCtrl({ op: 'set_voice', speak: !state.speak, id: qid() }); };
      var eye = document.createElement('button');
      eye.type = 'button';
      eye.textContent = m.watch ? 'Close watch' : 'Watch';
      eye.onclick = function () { sendCtrl({ op: 'watch', meetingId: m.id, on: !m.watch, id: qid() }); };
      var chatDl = document.createElement('button');
      chatDl.type = 'button';
      chatDl.textContent = 'Download chat';
      chatDl.onclick = function () { sendCtrl({ op: 'chat', meetingId: m.id, id: qid() }); };
      var resp = document.createElement('button');
      resp.type = 'button';
      resp.textContent = state.respond ? 'Commands on' : 'Commands off';
      resp.onclick = function () { sendCtrl({ op: 'set_voice', respond_to_command: !state.respond, id: qid() }); };
      var speak = document.createElement('button');
      speak.type = 'button';
      speak.textContent = 'Speak';
      speak.onclick = function () { sendCtrl({ op: 'interject', meetingId: m.id, text: say.value, id: qid() }); say.value = ''; };
      var stop = document.createElement('button');
      stop.type = 'button';
      stop.textContent = 'Stop speaking';
      stop.onclick = function () { sendCtrl({ op: 'stop_speaking', meetingId: m.id, id: qid() }); };
      var hand = document.createElement('button');
      hand.type = 'button';
      hand.textContent = m.hand ? 'Lower hand' : 'Raise hand';
      hand.onclick = function () { sendCtrl({ op: 'raise_hand', meetingId: m.id, on: !m.hand, id: qid() }); };
      var mic = document.createElement('button');
      mic.type = 'button';
      mic.textContent = m.mic ? 'Mic off' : 'Mic on';
      mic.onclick = function () { sendCtrl({ op: 'set_mic', meetingId: m.id, on: !m.mic, id: qid() }); };
      var cam = document.createElement('button');
      cam.type = 'button';
      cam.textContent = m.camera ? 'Camera off' : 'Camera on';
      cam.onclick = function () { sendCtrl({ op: 'set_camera', meetingId: m.id, on: !m.camera, id: qid() }); };
      var shot = document.createElement('button');
      shot.type = 'button';
      shot.textContent = 'Snapshot';
      shot.onclick = function () { sendCtrl({ op: 'snapshot', meetingId: m.id, id: qid() }); };
      row.appendChild(title);
      row.appendChild(sub);
      row.appendChild(flags);
      [rec, tr, say, sayGo, speak, hand, mic, cam, shot, eye, dl, chatDl, dlr, voice, resp, stop, leave].forEach(function (el) { row.appendChild(el); });
      box.appendChild(row);
    });
  }
  function qid() { return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function adminEvent(ev) {
    if (!ev || !ev.control) return false;
    if (state.phase === 'probe') return ev.meetingId === state.probeId;
    return !!state.adminId && ev.meetingId === state.adminId;
  }

  function reply(extra) {
    var msg = Object.assign({ v: 1, role: 'bot', instance: state.instance, id: qid() }, extra || {});
    return gifos.meet.sendChat(state.adminId, BotProto.encode(msg));
  }
  // Resolves true when the command went out; a failure is said in the log.
  function sendCtrl(msg) {
    msg = Object.assign({ v: 1, role: 'controller', instance: state.instance }, msg || {});
    if (!msg.id) msg.id = qid();
    if (!state.adminId) {
      log('! ' + msg.op + ': not connected to the admin meeting yet.');
      return Promise.resolve(false);
    }
    var secrets = [];
    if (msg.llm && msg.llm.key) secrets.push(String(msg.llm.key));
    if (msg.tts && msg.tts.url) secrets.push(String(msg.tts.url));
    if (msg.stt && msg.stt.url) secrets.push(String(msg.stt.url));
    log('→ ' + msg.op + (msg.meetingId ? ' ' + msg.meetingId : ''));
    return gifos.meet.sendChat(state.adminId, BotProto.encode(msg)).then(function () {
      secrets.length = 0;
      return true;
    }, function (e) {
      log('! ' + msg.op + ': ' + scrubSecrets(e && e.message || e, secrets));
      secrets.length = 0;
      return false;
    });
  }
  function sendXferRetry(id, name, mime, bytes, left) {
    return gifos.meet.sendXfer(state.adminId, { id: id, name: name, mime: mime, bytes: bytes }).catch(function (e) {
      if (left > 1 && /data channel/i.test(String(e && e.message || e))) {
        return new Promise(function (res) { setTimeout(res, 1000); }).then(function () {
          return sendXferRetry(id, name, mime, bytes, left - 1);
        });
      }
      throw e;
    });
  }
  function remember(sess, link, control) {
    state.meetings[sess.meetingId] = {
      meetingId: sess.meetingId, room: sess.room || '', link: link || sess.link || '', control: !!control, rec: false, cc: false
    };
    state.lines[sess.meetingId] = state.lines[sess.meetingId] || [];
    state.chats[sess.meetingId] = state.chats[sess.meetingId] || [];
  }
  function needWork(id) {
    var m = state.meetings[id];
    if (!m || m.control) throw new Error('No such meeting: ' + id);
    return m;
  }
  function freshRoom() {
    var abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var u = new Uint8Array(16);
    crypto.getRandomValues(u);
    var out = '';
    for (var i = 0; i < u.length; i++) out += abc[u[i] % abc.length];
    return out;
  }
  function transcriptText(id) {
    return (state.lines[id] || []).map(function (l) { return (l.by || '') + ': ' + (l.text || ''); }).join('\n');
  }
  function scrubSecrets(text, secrets) {
    var s = String(text == null ? '' : text);
    (secrets || []).forEach(function (sec) { s = BotVoice.scrub(s, sec); });
    return s;
  }
  function collectSecrets(settings) {
    var out = [];
    if (settings && settings.llm && settings.llm.key) out.push(String(settings.llm.key));
    if (settings && settings.tts && settings.tts.url) out.push(String(settings.tts.url));
    if (settings && settings.stt && settings.stt.url) out.push(String(settings.stt.url));
    return out;
  }
  function voicePublic() {
    return BotVoice.publicSettings({
      respond_to_command: state.respond,
      speak: state.speak,
      listen: state.listen
    });
  }
  function refreshAi() {
    var fn = gifos.ai && gifos.ai.models;
    if (!fn) return Promise.resolve(state.aiReady);
    return Promise.resolve().then(function () { return fn(); }).then(function (m) {
      var list = (m && m.available) || [];
      state.aiReady = {
        smartest: list.indexOf('smartest') >= 0,
        tts: list.indexOf('tts') >= 0,
        stt: list.indexOf('stt') >= 0
      };
      return state.aiReady;
    }, function () { return state.aiReady; });
  }
  function keepChat(id, line) {
    if (!id || !line) return null;
    var by = line.by || '';
    var text = line.text || '';
    var at = line.at || Date.now();
    var lines = state.chats[id] = state.chats[id] || [];
    var norm = BotVoice.norm(text);
    if (norm) {
      var start = Math.max(0, lines.length - 20);
      for (var i = lines.length - 1; i >= start; i--) {
        if (lines[i].by === by && BotVoice.norm(lines[i].text) === norm) return null;
      }
    }
    var row = { by: by, text: text, at: at };
    lines.push(row);
    return row;
  }
  function ensureControls(id) {
    if (!state.controls[id]) state.controls[id] = { hand: false, mic: false, camera: false };
    return state.controls[id];
  }
  function peopleOf(id) {
    return (state.people[id] || []).map(function (p) {
      return { id: p.id || '', name: p.name || '', bot: !!p.bot, me: !!p.me };
    });
  }
  function roomControl(id, op, on, field) {
    try { needWork(id); } catch (e) { return Promise.reject(e); }
    var fn = meetCall(op);
    if (!fn) return Promise.reject(new Error('This meeting cannot change ' + field + '.'));
    var flag = !!on;
    return Promise.resolve().then(function () { return fn(id, flag); }).then(function () {
      ensureControls(id)[field] = flag;
      noteCommand(op, flag ? 'on' : 'off');
      paint();
      var out = { id: id };
      out[field] = flag;
      return out;
    });
  }
  function rememberSpoken(text) {
    var t = String(text || '').trim();
    if (!t) return;
    state.recentSpoken.push(t);
    if (state.recentSpoken.length > 20) state.recentSpoken.shift();
  }
  function ownVoice(line) {
    if (!line) return false;
    if (line.self || line.bot || line.me) return true;
    var by = String(line.by || '').trim().toLowerCase();
    if (state.name && by === state.name.toLowerCase()) return true;
    var text = BotVoice.norm(line.text);
    if (!text) return false;
    for (var i = 0; i < state.recentSpoken.length; i++) {
      if (BotVoice.norm(state.recentSpoken[i]) === text) return true;
    }
    return false;
  }
  // Spoken lines stay in the transcript, credited to the bot. A repeat of one
  // of the last 20 of those lines is the same utterance coming back, so it is
  // not stored a second time. The bot still does not answer its own lines.
  function keepLine(id, line) {
    if (!id || !line) return null;
    var own = ownVoice(line);
    var by = own ? (state.name || line.by || 'Bot') : (line.by || '');
    var text = line.text || '';
    var at = line.at || Date.now();
    var lines = state.lines[id] = state.lines[id] || [];
    var norm = BotVoice.norm(text);
    if (own && norm) {
      var start = Math.max(0, lines.length - 20);
      for (var i = lines.length - 1; i >= start; i--) {
        if (lines[i].by === by && BotVoice.norm(lines[i].text) === norm) return null;
      }
    }
    var row = { by: by, text: text, at: at };
    lines.push(row);
    return row;
  }
  function emitTranscript(id, line) {
    var ev = { id: id, by: line.by || '', text: line.text || '', at: line.at || Date.now() };
    state.transcriptListeners.forEach(function (fn) {
      try { fn(ev); } catch (e) {}
    });
    if (state.phase === 'run' && state.adminId) {
      reply({ op: 'transcript', meetingId: id, by: ev.by, text: ev.text, at: ev.at }).catch(function () {});
    }
  }
  function onTranscript(fn) {
    if (typeof fn !== 'function') return function () {};
    state.transcriptListeners.push(fn);
    return function () {
      state.transcriptListeners = state.transcriptListeners.filter(function (x) { return x !== fn; });
    };
  }
  function meetCall(name) {
    var fn = gifos.meet && gifos.meet[name];
    return typeof fn === 'function' ? fn : null;
  }
  function hostStop(id) {
    var fn = meetCall('stopSpeaking');
    if (!fn) return Promise.resolve({ id: id, stopped: true });
    return Promise.resolve().then(function () { return fn(id); }).then(function () { return { id: id, stopped: true }; }, function () { return { id: id, stopped: true }; });
  }
  function aborted(e) {
    return !!(e && (e.name === 'AbortError' || /abort/i.test(String(e && e.message || e))));
  }
  // The bot's operations. RUN answers them for the admin meeting (handleCommand)
  // and for whoever drives this page directly (window.MeetingBot). Each one
  // resolves with a plain result or rejects with an Error.
  var ops = {
    list: function () { return Promise.resolve(workMeetings()); },
    join: function (link, password) {
      if (!link) return Promise.reject(new Error('join needs a meeting link.'));
      return gifos.meet.join(link, password || '', state.name, { bot: true }).then(function (sess) {
        var shown = /[:\/#]/.test(link) ? link : (sess.link || link);
        remember(sess, shown, false);
        paint();
        log('joined ' + sess.meetingId);
        noteCommand('join', sess.meetingId);
        return { id: sess.meetingId, room: sess.room || '', link: shown };
      });
    },
    create: function () {
      return ops.join(freshRoom(), '').then(function (r) {
        state.meetings[r.id].created = true;
        paint();
        return r;
      });
    },
    leave: function (id) {
      try { needWork(id); } catch (e) { return Promise.reject(e); }
      return gifos.meet.leave(id).then(function () {
        delete state.meetings[id];
        delete state.people[id];
        delete state.controls[id];
        if (state.speakingId === id) { state.speaking = false; state.speakingId = ''; }
        paint();
        return { id: id, left: true };
      });
    },
    record: function (id, on) {
      try { needWork(id); } catch (e) { return Promise.reject(e); }
      var call = on ? gifos.meet.startRecording(id) : gifos.meet.stopRecording(id);
      return call.then(function () {
        if (state.meetings[id]) state.meetings[id].rec = !!on;
        paint();
        return { id: id, rec: !!on };
      });
    },
    transcribe: function (id, on) {
      try { needWork(id); } catch (e) { return Promise.reject(e); }
      return gifos.meet.transcribe(id, !!on).then(function (r) {
        if (r && r.ok === false) throw new Error(r.error || 'Transcribing did not start.');
        if (state.meetings[id]) state.meetings[id].cc = !!on;
        paint();
        return { id: id, cc: !!on };
      });
    },
    // Version 1: chat only. Speech is interject.
    say: function (id, text) {
      try { needWork(id); } catch (e) { return Promise.reject(e); }
      var body = String(text == null ? '' : text).slice(0, 2000);
      if (!body.trim()) return Promise.reject(new Error('Nothing to say.'));
      return gifos.meet.sendChat(id, body).then(function () {
        keepChat(id, { by: state.name, text: body.trim(), at: Date.now(), self: true });
        noteCommand('say', 'chat');
        paint();
        return { id: id, sent: true };
      });
    },
    setVoice: function (settings) {
      settings = settings || {};
      var secrets = collectSecrets(settings);
      try { BotVoice.publicSettings(settings); }
      catch (e) { return Promise.reject(new Error(scrubSecrets(e && e.message || e, secrets))); }
      if (settings.respond_to_command != null) state.respond = !!settings.respond_to_command;
      if (settings.speak != null) state.speak = !!settings.speak;
      if (settings.listen != null) state.listen = !!settings.listen;
      secrets.length = 0;
      var turns = [];
      if (settings.listen != null) {
        workMeetings().forEach(function (m) {
          turns.push(ops.transcribe(m.id, state.listen).catch(function () {}));
        });
      }
      noteCommand('set_voice', (state.speak ? 'speak' : 'quiet') + (state.listen ? ' listen' : ''));
      return refreshAi().then(function () { return Promise.all(turns); }).then(function () {
        paint();
        return voicePublic();
      });
    },
    interject: function (id, text) {
      try { needWork(id); } catch (e) { return Promise.reject(e); }
      var body = String(text == null ? '' : text).trim().slice(0, 2000);
      if (!body) return Promise.reject(new Error('Nothing to say.'));
      var tts = gifos.ai && gifos.ai.tts;
      var play = meetCall('speak');
      if (typeof tts !== 'function' || !play) return Promise.reject(new Error('This meeting cannot play the bot microphone.'));
      state.speakGen++;
      var gen = state.speakGen;
      state.speaking = true;
      state.speakingId = id;
      rememberSpoken(body);
      noteCommand('interject', 'mic');
      paint();
      return Promise.resolve().then(function () { return tts({ text: body }); }).then(function (audio) {
        if (gen !== state.speakGen) return Promise.reject(new Error('Stopped.'));
        var bytes = audio && audio.bytes;
        var mime = (audio && audio.mime) || 'audio/wav';
        return play.length >= 2 ? play(id, { bytes: bytes, mime: mime, text: body }) : play({ meetingId: id, bytes: bytes, mime: mime, text: body });
      }).then(function (r) {
        if (r && r.text) rememberSpoken(r.text);
        var stopped = gen !== state.speakGen;
        if (!stopped) { state.speaking = false; state.speakingId = ''; }
        if (stopped || (r && r.spoken === false)) { paint(); return Promise.reject(new Error('Stopped.')); }
        var said = (r && r.text) || body;
        var kept = keepLine(id, { by: state.name, text: said, at: Date.now(), bot: true });
        if (kept) emitTranscript(id, kept);
        paint();
        return { id: id, spoken: true };
      }, function (e) {
        if (gen === state.speakGen) { state.speaking = false; state.speakingId = ''; }
        if (!aborted(e)) noteError(BotVoice.scrub(e && e.message || e, ''));
        paint();
        throw e;
      });
    },
    stopSpeaking: function (id) {
      if (id) { try { needWork(id); } catch (e) { return Promise.reject(e); } }
      state.speakGen++;
      state.speaking = false;
      var target = id || state.speakingId;
      state.speakingId = '';
      noteCommand('stop_speaking', target || '');
      paint();
      if (!target) return Promise.resolve({ stopped: true });
      return hostStop(target).then(function () { return { id: target, stopped: true }; });
    },
    raiseHand: function (id, on) { return roomControl(id, 'raiseHand', on, 'hand'); },
    setMic: function (id, on) { return roomControl(id, 'setMic', on, 'mic'); },
    setCamera: function (id, on) { return roomControl(id, 'setCamera', on, 'camera'); },
    meetingState: function (id) {
      try { needWork(id); } catch (e) { return Promise.reject(e); }
      var local = ensureControls(id);
      var base = { id: id, hand: !!local.hand, mic: !!local.mic, camera: !!local.camera, people: peopleOf(id) };
      var fn = meetCall('meetingState');
      if (!fn) return Promise.resolve(base);
      return Promise.resolve().then(function () { return fn(id); }).then(function (r) {
        if (r && typeof r === 'object') {
          if ('hand' in r) base.hand = !!r.hand;
          if ('mic' in r) base.mic = !!r.mic;
          if ('camera' in r) base.camera = !!r.camera;
          if (r.people) base.people = r.people;
          local.hand = base.hand;
          local.mic = base.mic;
          local.camera = base.camera;
        }
        return base;
      }, function () { return base; });
    },
    snapshot: function (id) {
      return ops.meetingState(id).then(function (row) {
        return { id: row.id, hand: row.hand, mic: row.mic, camera: row.camera, people: row.people };
      });
    },
    people: function (id) {
      try { needWork(id); } catch (e) { return Promise.reject(e); }
      return Promise.resolve(peopleOf(id));
    },
    transcript: function (id) {
      if (!state.lines[id]) return Promise.reject(new Error('No such meeting: ' + id));
      var lines = state.lines[id].map(function (l) { return { by: l.by, text: l.text, at: l.at }; });
      return Promise.resolve({ id: id, lines: lines, text: transcriptText(id) });
    },
    chatFile: function (id) {
      if (!state.meetings[id] || state.meetings[id].control) return Promise.reject(new Error('No such meeting: ' + id));
      var lines = (state.chats[id] || []).map(function (l) { return { by: l.by, text: l.text, at: l.at }; });
      var text = lines.map(function (l) { return (l.by || '') + ': ' + (l.text || ''); }).join('\n');
      return Promise.resolve({ id: id, name: 'chat-' + id + '.txt', mime: 'text/plain', lines: lines, text: text });
    },
    watch: function (id, on) {
      try { needWork(id); } catch (e) { return Promise.reject(e); }
      var fn = meetCall('watch');
      if (!fn) return Promise.reject(new Error('This meeting cannot open a watch tile.'));
      var flag = !!on;
      return Promise.resolve().then(function () { return fn(id, flag); }).then(function () {
        ensureControls(id).watch = flag;
        noteCommand('watch', flag ? 'open' : 'closed');
        paint();
        return { id: id, watch: flag };
      });
    },
    recording: function (id) {
      try { needWork(id); } catch (e) { return Promise.reject(e); }
      return gifos.meet.stopRecording(id).catch(function () { return null; }).then(function () {
        if (state.meetings[id]) state.meetings[id].rec = false;
        paint();
        return gifos.meet.getRecording(id);
      }).then(function (rec) {
        return {
          id: id,
          name: (rec && rec.name) || ('recording-' + id + '.webm'),
          mime: (rec && rec.mime) || 'video/webm',
          bytes: (rec && rec.bytes) || new ArrayBuffer(0)
        };
      });
    }
  };

  function maybeReply(id, line) {
    if (!line || ownVoice(line) || !state.speak || state.replying) return;
    var text = line.text || '';
    var command = BotVoice.isCommand(text, state.name);
    if (command && !state.respond) return;
    if (!command && !BotVoice.isConversation(text, state.name)) return;
    var chat = gifos.ai && gifos.ai.chat;
    var tts = gifos.ai && gifos.ai.tts;
    var play = meetCall('speak');
    if (typeof chat !== 'function' || typeof tts !== 'function' || !play) {
      noteError('Conversation needs Smartest and Text to speech in GifOS Settings.');
      return;
    }
    state.replying = true;
    noteCommand(command ? 'command' : 'conversation', line.by || 'Someone');
    paint();
    Promise.resolve().then(function () {
      return chat({
        model: 'smartest',
        messages: [
          { role: 'system', content: 'You are ' + (state.name || 'the bot') + ' in a meeting. Answer in one or two sentences.' },
          { role: 'user', content: (line.by || 'Someone') + ': ' + text }
        ]
      });
    }).then(function (r) {
      var said = String(r && r.text || '').trim();
      if (!said) return null;
      return tts({ text: said }).then(function (audio) {
        var bytes = audio && audio.bytes;
        var mime = (audio && audio.mime) || 'audio/wav';
        return Promise.resolve(play.length >= 2 ? play(id, { bytes: bytes, mime: mime, text: said }) : play({ meetingId: id, bytes: bytes, mime: mime, text: said })).then(function () { return said; });
      });
    }).then(function (said) {
      if (!said) return;
      rememberSpoken(said);
      var kept = keepLine(id, { by: state.name, text: said, at: Date.now(), bot: true });
      if (kept) emitTranscript(id, kept);
    }).catch(function (e) {
      if (!aborted(e)) noteError(scrubSecrets(e && e.message || e, []));
    }).then(function () {
      state.replying = false;
      paint();
    });
  }

  function handleCommand(msg) {
    var ref = msg.id || '';
    var fail = function (e) { return reply({ op: 'err', ref: ref, text: String(e && e.message || e) }); };
    var okItems = function (text) { return function () { return reply({ op: 'ok', ref: ref, text: text, items: workMeetings() }); }; };
    var id = msg.meetingId;
    if (msg.op === 'list' || msg.op === 'status') {
      var pub = voicePublic();
      return reply({
        op: 'meetings', ref: ref, items: workMeetings(),
        respond_to_command: pub.respond_to_command, speak: pub.speak, listen: pub.listen, text_role: pub.text_role,
        speaking: !!state.speaking, listening: !!state.listen && !state.speaking
      });
    }
    if (msg.op === 'create') {
      return ops.create().then(function (r) {
        return reply({ op: 'ok', ref: ref, text: 'created ' + r.id, meetingId: r.id, link: r.link, room: r.room, items: workMeetings() });
      }).catch(fail);
    }
    if (msg.op === 'join' && msg.link) {
      return ops.join(msg.link, msg.password).then(function (r) {
        return reply({ op: 'ok', ref: ref, text: 'joined ' + r.id, meetingId: r.id, link: r.link, room: r.room, items: workMeetings() });
      }).catch(fail);
    }
    if ((msg.op === 'leave' || msg.op === 'end') && id) return ops.leave(id).then(okItems('left ' + id)).catch(fail);
    if (msg.op === 'record' && id) return ops.record(id, !!msg.on).then(okItems('record ' + (msg.on ? 'on' : 'off'))).catch(fail);
    if (msg.op === 'transcribe' && id) return ops.transcribe(id, !!msg.on).then(okItems('transcribe ' + (msg.on ? 'on' : 'off'))).catch(fail);
    if (msg.op === 'say' && id) {
      return ops.say(id, msg.text).then(function () {
        return reply({ op: 'ok', ref: ref, text: 'sent' });
      }).catch(fail);
    }
    if (msg.op === 'interject' && id) {
      return ops.interject(id, msg.text).then(function () {
        return reply({ op: 'ok', ref: ref, text: 'spoken', spoken: true });
      }).catch(fail);
    }
    if (msg.op === 'stop_speaking' || msg.op === 'stopSpeaking') {
      return ops.stopSpeaking(id).then(function () { return reply({ op: 'ok', ref: ref, text: 'stopped' }); }).catch(fail);
    }
    if (msg.op === 'set_voice' || msg.op === 'setVoice') {
      var settings = {};
      if (msg.respond_to_command != null) settings.respond_to_command = msg.respond_to_command;
      if (msg.speak != null) settings.speak = msg.speak;
      if (msg.listen != null) settings.listen = msg.listen;
      if (msg.conversation_voice != null) settings.conversation_voice = msg.conversation_voice;
      if (msg.llm) settings.llm = { url: msg.llm.url, model: msg.llm.model, key: msg.llm.key };
      if (msg.tts) settings.tts = { engine: msg.tts.engine, app: msg.tts.app, voice: msg.tts.voice, url: msg.tts.url };
      if (msg.stt) settings.stt = { url: msg.stt.url };
      var secrets = collectSecrets(settings);
      return ops.setVoice(settings).then(function (r) {
        secrets.length = 0;
        return reply(Object.assign({ op: 'ok', ref: ref, text: 'set_voice' }, r));
      }, function (e) {
        var text = scrubSecrets(e && e.message || e, secrets);
        secrets.length = 0;
        return reply({ op: 'err', ref: ref, text: text });
      });
    }
    if ((msg.op === 'raise_hand' || msg.op === 'raiseHand') && id) {
      return ops.raiseHand(id, !!msg.on).then(function (r) {
        return reply({ op: 'ok', ref: ref, text: r.hand ? 'hand up' : 'hand down', hand: r.hand, items: workMeetings() });
      }).catch(fail);
    }
    if ((msg.op === 'set_mic' || msg.op === 'setMic') && id) {
      return ops.setMic(id, !!msg.on).then(function (r) {
        return reply({ op: 'ok', ref: ref, text: r.mic ? 'mic on' : 'mic off', mic: r.mic, items: workMeetings() });
      }).catch(fail);
    }
    if ((msg.op === 'set_camera' || msg.op === 'setCamera') && id) {
      return ops.setCamera(id, !!msg.on).then(function (r) {
        return reply({ op: 'ok', ref: ref, text: r.camera ? 'camera on' : 'camera off', camera: r.camera, items: workMeetings() });
      }).catch(fail);
    }
    if ((msg.op === 'meeting_state' || msg.op === 'meetingState') && id) {
      return ops.meetingState(id).then(function (r) {
        return reply({ op: 'meeting_state', ref: ref, meetingId: id, hand: r.hand, mic: r.mic, camera: r.camera, people: r.people });
      }).catch(fail);
    }
    if (msg.op === 'snapshot' && id) {
      return ops.snapshot(id).then(function (r) {
        return reply({ op: 'snapshot', ref: ref, meetingId: id, hand: r.hand, mic: r.mic, camera: r.camera, people: r.people });
      }).catch(fail);
    }
    if (msg.op === 'people' && id) {
      return ops.people(id).then(function (people) { return reply({ op: 'people', ref: ref, meetingId: id, people: people }); }).catch(fail);
    }
    if (msg.op === 'chat' && id) {
      return ops.chatFile(id).then(function (t) {
        var bytes = new TextEncoder().encode(t.text);
        var xid = 'xc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        return sendXferRetry(xid, t.name, 'text/plain', bytes.buffer, 6).then(function () {
          return reply({ op: 'xfer', ref: ref, xferId: xid, name: t.name, mime: 'text/plain', meetingId: id, lines: t.lines.length });
        });
      }).catch(fail);
    }
    if ((msg.op === 'watch') && id) {
      return ops.watch(id, !!msg.on).then(function (r) {
        return reply({ op: 'ok', ref: ref, text: r.watch ? 'watching' : 'closed', watch: r.watch, items: workMeetings() });
      }).catch(fail);
    }
    if (msg.op === 'transcript' && id) {
      return ops.transcript(id).then(function (t) {
        var bytes = new TextEncoder().encode(t.text);
        var xid = 'xf' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        var fname = 'transcript-' + id + '.txt';
        return sendXferRetry(xid, fname, 'text/plain', bytes.buffer, 6).then(function () {
          return reply({ op: 'xfer', ref: ref, xferId: xid, name: fname, mime: 'text/plain', meetingId: id, lines: t.lines.length });
        });
      }).catch(fail);
    }
    if (msg.op === 'recording' && id) {
      return ops.recording(id).then(function (rec) {
        var xid = 'xr' + Date.now().toString(36);
        return sendXferRetry(xid, rec.name, rec.mime, rec.bytes, 6).then(function () {
          return reply({ op: 'xfer', ref: ref, xferId: xid, name: rec.name, mime: rec.mime, meetingId: id });
        });
      }).catch(fail);
    }
    return reply({ op: 'err', ref: ref, text: 'Unknown command.' });
  }
  function handleBotReply(msg) {
    if (msg.op === 'warn') warn(msg.text || DUP);
    if ((msg.op === 'beat' || msg.op === 'meetings' || msg.op === 'ok') && (msg.meetings || msg.items)) {
      renderCtrl(msg.meetings || msg.items);
    }
    if (msg.op === 'ok' || msg.op === 'err' || msg.op === 'meetings') log('← ' + (msg.text || msg.op) + (msg.link ? '  ' + msg.link : ''));
    if (msg.speak != null) state.speak = !!msg.speak;
    if (msg.listen != null) state.listen = !!msg.listen;
    if (msg.text_role) { /* Smartest is the only conversation role. */ }
    if (msg.respond_to_command != null) state.respond = !!msg.respond_to_command;
    if (msg.speaking != null) state.speaking = !!msg.speaking;
    if (msg.op === 'beat' && msg.instance && state.instance && msg.role === 'bot') {
      /* A controller just displays what the bot reports. */
    }
    if (state.phase === 'control') paint();
  }

  gifos.meet.onParticipants(function (ev) {
    if (!ev || !ev.meetingId) return;
    var people = ev.people || [];
    if (state.meetings[ev.meetingId]) {
      state.people[ev.meetingId] = people.slice();
      paint();
    }
    if (state.phase !== 'probe' || ev.meetingId !== state.probeId) return;
    for (var i = 0; i < people.length; i++) {
      if (people[i] && people[i].bot && !people[i].me) state.probeBeat = state.probeBeat || { role: 'bot', op: 'beat' };
    }
  });
  gifos.meet.onChat(function (ev) {
    var text = String((ev && ev.text) || '');
    if (!adminEvent(ev)) {
      if (BotProto.looksLikeCommand(text) || BotProto.decode(text)) noteIgnored();
      if (ev && ev.meetingId && state.meetings[ev.meetingId] && !state.meetings[ev.meetingId].control) {
        if (text && !BotProto.decode(text)) keepChat(ev.meetingId, { by: ev.by || '', text: text, at: ev.at || Date.now(), self: !!ev.self });
        maybeReply(ev.meetingId, { by: ev.by || '', text: text, self: ev.self, bot: ev.bot, me: ev.me });
        paint();
      }
      return;
    }
    var msg = BotProto.decode(text);
    if (!msg) return;
    if (state.phase === 'probe') {
      if (msg.role === 'bot' && msg.op === 'beat') state.probeBeat = msg;
      return;
    }
    if (state.phase === 'run') {
      if (msg.role === 'bot' && msg.op === 'beat' && msg.instance && msg.instance !== state.instance) {
        warn(DUP);
        if (!state.warned[msg.instance]) {
          state.warned[msg.instance] = true;
          reply({ op: 'warn', text: DUP, instance: state.instance });
        }
        return;
      }
      if (msg.role === 'controller') handleCommand(msg);
      return;
    }
    if (state.phase === 'control' && msg.role === 'bot') handleBotReply(msg);
  });
  gifos.meet.onTranscriptLine(function (ev) {
    if (!ev || !ev.meetingId || ev.meetingId === state.adminId) return;
    var line = ev.line || {};
    var row = { by: line.by || '', text: line.text || '', at: line.at || Date.now(), self: !!(line.self || ev.self), bot: !!(line.bot || ev.bot), me: !!(line.me || ev.me) };
    var kept = keepLine(ev.meetingId, row);
    if (!kept) return;
    row = kept;
    emitTranscript(ev.meetingId, row);
    var n = state.lines[ev.meetingId].length;
    var slot = document.getElementById('tr-' + ev.meetingId);
    if (!slot) {
      slot = document.createElement('div');
      slot.id = 'tr-' + ev.meetingId;
      logEl.appendChild(slot);
    }
    slot.textContent = ev.meetingId + ' transcript lines: ' + n + (line.text ? '  last: ' + line.text : '');
    maybeReply(ev.meetingId, row);
    paint();
  });
  gifos.meet.onXfer(function (ev) {
    if (state.phase !== 'control' || !ev || ev.meetingId !== state.adminId) return;
    var bytes = ev.bytes ? new Uint8Array(ev.bytes) : new Uint8Array(0);
    var text = '';
    try { text = new TextDecoder().decode(bytes); } catch (e) { text = ''; }
    var box = document.getElementById('xfer');
    box.dataset.name = ev.name || '';
    box.dataset.bytes = String(bytes.length);
    box.textContent = (ev.name || 'download') + ' (' + bytes.length + ' bytes)\n' + text;
    try {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: ev.mime || 'application/octet-stream' }));
      a.download = ev.name || 'download';
      a.click();
    } catch (e) {}
  });

  function beat() {
    if (state.phase !== 'run' || !state.adminId) return;
    gifos.meet.sendChat(state.adminId, BotProto.encode({
      v: 1, role: 'bot', op: 'beat', instance: state.instance, meetings: workMeetings(),
      respond_to_command: !!state.respond, speak: !!state.speak, listen: !!state.listen, text_role: 'smartest',
      speaking: !!state.speaking, listening: !!state.listen && !state.speaking
    })).catch(function () {});
  }
  function autoJoin() {
    var links = String(rulesEl.value || '').split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var chain = Promise.resolve();
    links.forEach(function (link) {
      chain = chain.then(function () {
        return gifos.meet.join(link, '', state.name, { bot: true }).then(function (sess) {
          remember(sess, link, false);
          paint();
          log('joined ' + sess.meetingId);
        });
      });
    });
    return chain;
  }
  function becomeBot(sawOther) {
    return gifos.meet.join(state.admin.room, state.admin.password, state.name, { bot: true, control: true }).then(function (sess) {
      state.phase = 'run';
      state.adminId = sess.meetingId;
      remember(sess, sess.link, true);
      if (sawOther) warn(DUP);
      paint();
      beat();
      state.beatTimer = setInterval(beat, 3000);
      return autoJoin();
    });
  }
  function startRun() {
    state.phase = 'probe';
    state.probeBeat = null;
    warn('');
    paint();
    return gifos.meet.join(state.admin.room, state.admin.password, state.name + ' probe', { bot: false, control: true }).then(function (sess) {
      state.probeId = sess.meetingId;
      return new Promise(function (res) { setTimeout(res, 4500); });
    }).then(function () {
      var beatSeen = state.probeBeat;
      var id = state.probeId;
      state.probeId = '';
      return gifos.meet.leave(id).then(function () {
        if (beatSeen && !document.getElementById('override').checked) {
          state.phase = 'idle';
          warn(DUP);
          paint();
          return;
        }
        return becomeBot(!!beatSeen);
      });
    });
  }
  function startControl() {
    state.phase = 'control';
    warn('');
    paint();
    return gifos.meet.join(state.admin.room, state.admin.password, state.name + ' remote', { bot: false, control: true }).then(function (sess) {
      state.adminId = sess.meetingId;
      paint();
      setTimeout(function () { sendCtrl({ op: 'list', id: qid() }); }, 1200);
    });
  }

  document.getElementById('fill').onclick = function () {
    var s = BotProto.suggest();
    var guard = 0;
    while (!BotProto.strength(s.name, s.password).ok && guard++ < 8) s = BotProto.suggest();
    document.getElementById('bot-name').value = s.name;
    document.getElementById('bot-pass').value = s.password;
    suggestEl.textContent = 'Suggestion: ' + s.name + ' / ' + s.password;
  };
  document.getElementById('mode-run').onchange = paint;
  document.getElementById('mode-control').onchange = paint;
  document.getElementById('ops-commands').onclick = function () {
    ops.setVoice({ respond_to_command: !state.respond }).catch(function (e) { noteError(e && e.message || e); paint(); });
  };
  document.getElementById('ops-speak').onclick = function () {
    ops.setVoice({ speak: !state.speak }).catch(function (e) { noteError(e && e.message || e); paint(); });
  };
  document.getElementById('ops-listen').onclick = function () {
    ops.setVoice({ listen: !state.listen }).catch(function (e) { noteError(e && e.message || e); paint(); });
  };
  var aiBtn = document.getElementById('ops-ai');
  if (aiBtn) aiBtn.onclick = function () {
    var role = state.aiReady.smartest ? 'tts' : 'smartest';
    var fn = gifos.aiSetup;
    if (typeof fn === 'function') fn(role, 'Meeting Bot uses this to talk.').catch(function () {});
  };
  document.getElementById('ops-stop').onclick = function () {
    ops.stopSpeaking(state.speakingId).catch(function (e) { noteError(e && e.message || e); paint(); });
  };
  function start(opts) {
    opts = opts || {};
    if (opts.name != null) document.getElementById('bot-name').value = String(opts.name);
    if (opts.password != null) document.getElementById('bot-pass').value = String(opts.password);
    if (opts.mode === 'control') document.getElementById('mode-control').checked = true;
    if (opts.mode === 'run') document.getElementById('mode-run').checked = true;
    if (opts.override != null) document.getElementById('override').checked = !!opts.override;
    if (opts.rules != null) rulesEl.value = String(opts.rules);
    if (opts.respond_to_command != null) state.respond = !!opts.respond_to_command;
    if (opts.respond_to_commands != null) state.respond = !!opts.respond_to_commands;
    if (opts.speak != null) state.speak = !!opts.speak;
    if (opts.listen != null) state.listen = !!opts.listen;
    if (state.phase !== 'idle') return Promise.reject(new Error('Already started (' + state.phase + ').'));
    var name = document.getElementById('bot-name').value.trim();
    var password = document.getElementById('bot-pass').value;
    var chk = BotProto.strength(name, password);
    if (!chk.ok) {
      warn(chk.reason);
      var s = BotProto.suggest();
      var guard = 0;
      while (!BotProto.strength(s.name, s.password).ok && guard++ < 8) s = BotProto.suggest();
      suggestEl.textContent = 'Suggestion: ' + s.name + ' / ' + s.password;
      return Promise.reject(new Error(chk.reason));
    }
    suggestEl.textContent = '';
    warn('');
    var mode = document.getElementById('mode-control').checked ? 'control' : 'run';
    document.getElementById('start').disabled = true;
    try { gifos.db('rules').put({ id: 'autojoin', text: rulesEl.value || '' }); } catch (e) {}
    return BotProto.derive(name, password).then(function (admin) {
      state.name = name;
      state.admin = admin;
      return mode === 'control' ? startControl() : startRun();
    }).then(function () {
      document.getElementById('start').disabled = false;
      if (state.phase === 'idle') throw new Error(warnEl.textContent || 'Did not start.');
      return status();
    }, function (e) {
      warn(String(e && e.message || e));
      state.phase = 'idle';
      paint();
      document.getElementById('start').disabled = false;
      throw e;
    });
  }
  function status() {
    return {
      phase: state.phase, connected: !!state.adminId, name: state.name,
      meetings: state.phase === 'run' ? workMeetings() : state.ctrlItems.slice(), warning: warnEl.textContent || '',
      respond_to_command: !!state.respond,
      speak: !!state.speak,
      listen: !!state.listen,
      text_role: 'smartest',
      speaking: !!state.speaking,
      listening: !!state.listen && !state.speaking,
      commands: state.commands.slice(-8),
      errors: state.errors.slice(-8)
    };
  }
  document.getElementById('start').onclick = function () { start().catch(function () {}); };
  document.getElementById('list-go').onclick = function () { sendCtrl({ op: 'list', id: qid() }); };
  document.getElementById('create-go').onclick = function () { sendCtrl({ op: 'create', id: qid() }); };
  document.getElementById('join-go').onclick = function () {
    var link = document.getElementById('join-link').value.trim();
    if (!link) return;
    sendCtrl({ op: 'join', link: link, id: qid() });
  };

  try {
    gifos.db('rules').get('autojoin').then(function (row) {
      if (row && row.text && !rulesEl.value) rulesEl.value = row.text;
    }).catch(function () {});
  } catch (e) {}
  gifos.launch().then(function (args) {
    if (!args) return;
    if (args.name) document.getElementById('bot-name').value = args.name;
    if (args.password) document.getElementById('bot-pass').value = args.password;
    if (args.mode === 'control') document.getElementById('mode-control').checked = true;
    if (args.mode === 'run') document.getElementById('mode-run').checked = true;
    if (args.speak === '1' || args.speak === 'on') state.speak = true;
    if (args.listen === '1' || args.listen === 'on') state.listen = true;
    if (args.respond_to_command === '1' || args.respond_to_command === 'on' || args.respond_to_commands === '1' || args.respond_to_commands === 'on') state.respond = true;
    paint();
    if (args.start === '1' || args.start === 'true') start().catch(function () {});
  }).catch(function () {});
  function running() { if (state.phase !== 'run') throw new Error('The bot is not running. Call start({ mode: "run", ... }) first.'); }
  function guard(fn) {
    return function () {
      var args = arguments;
      try { running(); } catch (e) { return Promise.reject(e); }
      return fn.apply(null, args);
    };
  }
  window.MeetingBot = {
    version: 2,
    compatibleWith: function (v) { return v === 1 || v === 2; },
    start: start,
    status: status,
    list: guard(ops.list),
    create: guard(ops.create),
    join: guard(ops.join),
    leave: guard(ops.leave),
    end: guard(ops.leave),
    record: guard(ops.record),
    transcribe: guard(ops.transcribe),
    say: guard(ops.say),
    chatFile: guard(ops.chatFile),
    setVoice: ops.setVoice,
    interject: guard(ops.interject),
    stopSpeaking: guard(ops.stopSpeaking),
    stop_speaking: guard(ops.stopSpeaking),
    raiseHand: guard(ops.raiseHand),
    setMic: guard(ops.setMic),
    setCamera: guard(ops.setCamera),
    meetingState: guard(ops.meetingState),
    snapshot: guard(ops.snapshot),
    watch: guard(ops.watch),
    people: guard(ops.people),
    transcript: guard(ops.transcript),
    recording: guard(ops.recording),
    onTranscript: onTranscript
  };
  paint();
})();
