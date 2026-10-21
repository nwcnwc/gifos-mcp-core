// What the bot reports when Meet Bot lacks a method, the Kokoro names, and
// scrub(). This module does not call a model and does not speak.

export const VOICE_GAP = 'Meeting Bot has no setVoice method (contract version 1). Its own replies cannot be switched off; update Meeting Bot from the store.';
// Before the first join nothing has been handed yet.
export const VOICE_PENDING = 'Voice switches are handed to Meeting Bot when the bot joins a meeting.';
export const INTERJECT_GAP = 'Meeting Bot has no interject method (contract version 1). say posts chat only. A spoken line from the assistant needs MeetingBot.interject.';
export const HAND_GAP = 'Meeting Bot has no raiseHand method (contract version 1). The hand stays as it is.';
export const MIC_GAP = 'Meeting Bot has no setMic method (contract version 1). The bot has no microphone until the app accepts the setting.';
export const CAMERA_GAP = 'Meeting Bot has no setCamera method (contract version 1). The bot has no camera until the app accepts the setting.';
export const CONTROLS_GAP = 'Meeting Bot has no meetingState method (contract version 1). Hand, microphone, and camera are not reported.';
export const SNAPSHOT_GAP = 'Meeting Bot has no snapshot method (contract version 1). A PNG of the Meeting Bot page is saved when that page is open.';

// The store app, used only when GIFOS_TTS_APP names one. The default voice
// is Kokoro in this process. MCP_TTS_APP is the label setVoice carries.
// The host answers the tts role. It does not mount that id as a GIF.
export const KOKORO_APP = 'offline-tts-kokoro';
export const MCP_TTS_APP = 'mcp-tts-kokoro';
export const KOKORO_VOICE = 'af_heart';

// One secret, or a list. Empty values are skipped. Used for the bot password
// and room passwords, so none lands in a tool result.
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
