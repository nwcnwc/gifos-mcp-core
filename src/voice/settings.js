// Voice settings to hand to Meet Bot. This module does not call a model
// and does not speak. See docs/MEETBOT-BRIDGE.md.

export const VOICE_GAP = 'Meeting Bot has no setVoice method (contract version 1). Conversation voice stays off until the app accepts the setting. See docs/MEETBOT-BRIDGE.md.';
// Before the first join nothing has been handed yet.
export const VOICE_PENDING = 'Voice switches are handed to Meeting Bot when the bot joins a meeting.';
export const INTERJECT_GAP = 'Meeting Bot has no interject method (contract version 1). say posts chat only. A spoken line from the assistant needs MeetingBot.interject. See docs/MEETBOT-BRIDGE.md.';
export const HAND_GAP = 'Meeting Bot has no raiseHand method (contract version 1). The hand stays as it is. See docs/MEETBOT-BRIDGE.md.';
export const MIC_GAP = 'Meeting Bot has no setMic method (contract version 1). The bot has no microphone until the app accepts the setting. See docs/MEETBOT-BRIDGE.md.';
export const CAMERA_GAP = 'Meeting Bot has no setCamera method (contract version 1). The bot has no camera until the app accepts the setting. See docs/MEETBOT-BRIDGE.md.';
export const CONTROLS_GAP = 'Meeting Bot has no meetingState method (contract version 1). Hand, microphone, and camera are not reported. See docs/MEETBOT-BRIDGE.md.';
export const SNAPSHOT_GAP = 'Meeting Bot has no snapshot method (contract version 1). A PNG of the Meet Bot page is saved when that page is open. See docs/MEETBOT-BRIDGE.md.';

// The store app, used only when GIFOS_TTS_APP names one. The default voice
// is Kokoro in this process. MCP_TTS_APP is the label setVoice carries.
// The host answers the tts role. It does not mount that id as a GIF.
export const KOKORO_APP = 'offline-tts-kokoro';
export const MCP_TTS_APP = 'mcp-tts-kokoro';
export const KOKORO_VOICE = 'af_heart';

// One secret, or a list. Empty values are skipped. Used for the model key
// and for the bot password, so neither lands in a tool result.
export function scrub(text, secret) {
  const keys = Array.isArray(secret) ? secret : [secret];
  let out = String(text == null ? '' : text);
  for (const key of keys) {
    const k = String(key || '');
    if (!k) continue;
    out = out.split(k).join('[redacted]');
  }
  return out;
}

// Kokoro unless the environment names an HTTP stand-in or turns speech off.
// Meet Bot only hears the role. The URL stays in this process.
function localTts(voice) {
  const t = (voice && voice.tts) || {};
  if (t.engine === 'http') return { provider: 'tts', engine: 'http' };
  if (t.engine === 'none') return { provider: 'tts', engine: 'none' };
  return { provider: 'tts', engine: 'kokoro', app: t.app || MCP_TTS_APP, voice: t.voice || KOKORO_VOICE };
}

function ttsPublic(voice) {
  if (!voice || voice.conversationVoice !== 'local') return null;
  const t = localTts(voice);
  if (t.engine === 'http') return { engine: 'http' };
  if (t.engine === 'none') return { engine: 'none' };
  return { engine: 'kokoro', app: t.app, voice: t.voice };
}

// The object passed to MeetingBot.setVoice. It names GifOS providers.
// It never includes llm.url, llm.key, tts.url, or stt.url. When this
// process hosts a role, it answers the call. A store app is still read
// from Settings.
export function voiceSettings(voice) {
  const settings = {
    respond_to_command: !!(voice && voice.respondToCommand),
    conversation_voice: (voice && voice.conversationVoice) || 'none',
  };
  if (voice && (voice.sttUrl || voice.sttApp)) settings.stt = { provider: 'stt' };
  if (settings.conversation_voice === 'local') {
    // Settings has no "llm" row. The smartest text model is the one Meet Bot uses.
    settings.llm = { provider: 'smartest' };
    settings.tts = localTts(voice);
  }
  return settings;
}

// The object passed to MeetingBot.setVoice (contract version 2). The app
// starts with speak and respond_to_command off and refuses the old fields
// (conversation_voice, llm, tts, stt). It speaks with the host's Smartest and
// Text to speech roles. listen is left out: transcription stays on mute and
// unmute.
export function meetBotVoice(voice) {
  const v = voice || {};
  return {
    respond_to_command: !!v.respondToCommand,
    speak: !!v.conversationVoice && v.conversationVoice !== 'none',
  };
}

export function voicePublic(voice, handoff) {
  const v = voice || {};
  const handed = !!(handoff && handoff.applied);
  return {
    respond_to_command: !!v.respondToCommand,
    conversation_voice: v.conversationVoice || 'none',
    model: v.conversationVoice === 'local' ? (v.model || null) : null,
    tts: ttsPublic(v),
    stt: (v.sttUrl || v.sttApp) ? 'configured' : null,
    handed,
    gap: handed ? null : ((handoff && handoff.gap) || VOICE_PENDING),
  };
}
