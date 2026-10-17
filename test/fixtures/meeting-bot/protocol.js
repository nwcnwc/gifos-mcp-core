/* Meeting Bot protocol. Shared by the app and by node tests.
 * Structured messages ride the admin meeting's chat. A KDF turns the
 * name and password into the room id and the room key. */
(function (root) {
  var ITER = 20000;
  var WEAK = ['bot', 'password', 'password1', '12345678', '123456789', 'admin', 'letmein', 'qwerty', 'gifos', 'secret', 'changeme'];
  var A = ['harbor', 'maple', 'cedar', 'lantern', 'pebble', 'orchid', 'quartz', 'willow'];
  var B = ['north', 'quiet', 'amber', 'silver', 'bright', 'steady', 'clear', 'kind'];

  function strength(name, password) {
    name = String(name || '').trim();
    password = String(password || '');
    var nl = name.toLowerCase();
    var pl = password.toLowerCase();
    if (nl.length < 3) return { ok: false, reason: 'Name needs at least 3 characters.' };
    if (WEAK.indexOf(nl) >= 0 && pl === nl) return { ok: false, reason: 'That name and password are too easy to guess.' };
    if (WEAK.indexOf(nl) >= 0) return { ok: false, reason: 'Pick a less obvious bot name.' };
    if (password.length < 10) return { ok: false, reason: 'Password needs at least 10 characters.' };
    if (pl === nl) return { ok: false, reason: 'Password must not be the name.' };
    if (WEAK.indexOf(pl) >= 0) return { ok: false, reason: 'That password is too easy to guess.' };
    var hasLetter = /[a-z]/i.test(password);
    var hasDigit = /[0-9]/.test(password);
    if (!(hasLetter && hasDigit) && password.length < 14) return { ok: false, reason: 'Use a letter and a digit, or a longer password.' };
    return { ok: true, reason: '' };
  }

  function suggest() {
    var name = A[Math.floor(Math.random() * A.length)] + '-' + B[Math.floor(Math.random() * B.length)];
    var password = B[Math.floor(Math.random() * B.length)] + '-' + A[Math.floor(Math.random() * A.length)] + '-' + String(10 + Math.floor(Math.random() * 89));
    return { name: name, password: password };
  }

  function derive(name, password) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']).then(function (key) {
      return crypto.subtle.deriveBits({
        name: 'PBKDF2',
        salt: enc.encode('gifos-meet-bot-v1|' + String(name).trim()),
        iterations: ITER,
        hash: 'SHA-256'
      }, key, 256);
    }).then(function (bits) {
      var u = new Uint8Array(bits);
      var hex = '';
      for (var i = 0; i < u.length; i++) hex += u[i].toString(16).padStart(2, '0');
      return { room: hex.slice(0, 32), password: hex.slice(32, 64) };
    });
  }

  function encode(msg) {
    var body = Object.assign({ v: 1 }, msg || {});
    return 'gb1 ' + JSON.stringify(body);
  }

  function decode(text) {
    if (typeof text !== 'string' || text.indexOf('gb1 ') !== 0) return null;
    var o;
    try { o = JSON.parse(text.slice(4)); } catch (e) { return null; }
    if (!o || o.v !== 1) return null;
    if (o.role !== 'bot' && o.role !== 'controller') return null;
    if (typeof o.op !== 'string' || !o.op) return null;
    return o;
  }

  function looksLikeCommand(text) {
    return /^(join|leave|list|record|transcribe|status|send)\b/i.test(String(text || '').trim());
  }

  root.BotProto = {
    strength: strength,
    suggest: suggest,
    derive: derive,
    encode: encode,
    decode: decode,
    looksLikeCommand: looksLikeCommand,
    DUP: 'A bot with this name and password is already running, so pick something unique or stop the other one.'
  };
})(typeof window !== 'undefined' ? window : globalThis);
