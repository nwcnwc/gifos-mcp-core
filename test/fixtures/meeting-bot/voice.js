/* Voice rules for Meeting Bot. No network. Speech uses the GifOS AI
 * roles (Smartest, Text to speech). This file never returns a key or a URL. */
(function (root) {
  var TEXT_ROLE = 'smartest';

  function engineFields(s) {
    return !!(s && (s.conversation_voice != null || s.llm || s.tts || s.stt));
  }

  function scrub(text, secret) {
    var s = String(text == null ? '' : text);
    var key = String(secret || '');
    if (!key) return s;
    return s.split(key).join('[redacted]');
  }

  function addressedToBot(text, name) {
    var t = String(text || '').trim().toLowerCase();
    if (!t) return false;
    var n = String(name || '').trim().toLowerCase();
    if (n && t.indexOf(n) >= 0) return true;
    return /^(hey |ok |hi |hello )?bot\b/.test(t);
  }

  // A command is aimed at the bot. Ordinary talk is not.
  function isCommand(text, name) {
    var t = String(text || '').trim();
    if (!t) return false;
    if (addressedToBot(t, name)) return true;
    if (/^(join|leave|list|record|transcribe|status|send)\b/i.test(t)) return true;
    if (/^\s*[\/!]/.test(t)) return true;
    return false;
  }

  // Conversation is room talk the voice may answer. Commands are separate.
  function isConversation(text, name) {
    var t = String(text || '').trim();
    if (!t || isCommand(t, name)) return false;
    if (/\?\s*$/.test(t)) return true;
    return t.length >= 24;
  }

  function norm(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // Settings safe to resolve, log, and put on screen.
  // An engine name, a model URL, or a key is refused.
  function publicSettings(s) {
    s = s || {};
    if (engineFields(s)) throw new Error('Voice uses the GifOS AI settings (Smartest and Text to speech).');
    return {
      respond_to_command: !!s.respond_to_command,
      speak: !!s.speak,
      listen: !!s.listen,
      text_role: TEXT_ROLE
    };
  }

  root.BotVoice = {
    TEXT_ROLE: TEXT_ROLE,
    scrub: scrub,
    addressedToBot: addressedToBot,
    isCommand: isCommand,
    isConversation: isConversation,
    norm: norm,
    publicSettings: publicSettings
  };
})(typeof window !== 'undefined' ? window : globalThis);
