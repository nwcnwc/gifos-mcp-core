// Stage B: what the supervisor does when a worker stops (or, with one worker,
// when the bot's browser is lost: driver.js onLost). Its meetings are
// no longer seated. They go back to scheduled with no session, the way a
// restart leaves them, and the next clock tick rejoins every order still in
// its window on a worker that is up, with the stored room password. A
// meeting with no order (joined by hand with no password, or start_meeting)
// is marked reseat, and the same tick brings it back.

export function dropLostMeetings({ meetings, events, captions }) {
  return (sessionIds, _why, worker) => {
    const ids = new Set((sessionIds || []).map(String));
    for (const m of meetings.all()) {
      if (m.state !== 'live' || !ids.has(String(m.session_id))) continue;
      if (captions && typeof captions.stop === 'function') captions.stop(m.meeting_id);
      meetings.update(m.meeting_id, { state: 'scheduled', session_id: null, transcribing: false, thinking: false, reseat: true });
      if (events) events.append({ type: 'meeting.disconnected', meeting_id: m.meeting_id, data: { state: 'scheduled', reason: worker === undefined ? 'browser' : 'worker', worker } });
    }
  };
}
