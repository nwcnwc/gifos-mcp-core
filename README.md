<p align="center"><img src="assets/logo-512.png" width="128" height="128" alt="gifos-mcp logo"></p>

# gifos-mcp: GifOS Meet connector for Grok Bot

`gifos-mcp` is an [MCP](https://modelcontextprotocol.io) server that lets Grok Bot (or any MCP client) create
[GifOS](https://gifos.app) meetings, put a note-taking bot in them, and read back the transcript.

It runs **on your own computer**. It starts a headless Chromium running GifOS, installs the **Meeting Bot** app
from the GifOS app store, and drives it. Meetings stay peer to peer between the people in them. Transcripts stay
on your computer. No GifOS account or API key is involved.

> **Requires GifOS 0.9.23 or newer**, the release that ships the Meeting Bot store app. Until it is live on
> gifos.app, point `GIFOS_URL` at a GifOS 0.9.23 site (see [Testing](#testing-instructions-for-marketplace-reviewers)).

## How it works

```
Grok Bot ──MCP (stdio)──▶ gifos-mcp ──▶ headless Chromium (one profile in ~/.gifos-mcp)
                                         └─ GifOS desktop
                                              ├─ Meeting Bot, running as the bot (RUN mode)
                                              │    driven through its local control API, window.MeetingBot v1
                                              └─ Offline Captions (Whisper), the speech-to-text provider
```

- `create_meeting` only mints a meeting link. Nothing joins yet.
- `start_meeting` or `join_meeting` sends the bot into the meeting. Everyone in the meeting sees it as a tile
  labelled **🤖 bot** with a **📝 transcribing** chip. The bot has no camera.
- Spoken lines are Kokoro, running in this process. This process is the host of the headless GifOS, so it
  injects itself as the `tts` provider (and as `stt` and `smartest` when those are endpoints). The first start
  downloads the weights and the `af_heart` voice. This process does not play the audio into the meeting; Meet Bot does.
- Speech is turned into text on your computer by the Offline Captions (Whisper) app from the GifOS store. The bot
  writes down each participant who is unmuted, credited by name. It never writes down its own machine's
  microphone.
- `get_transcript` reads the transcript straight from the bot. Meeting Bot's
  [control contract](https://github.com/nwcnwc/gifos-apps-source/blob/meet-bot/meeting-bot/CONTROL.md) (version 1)
  is the only interface this server relies on. The voice handoff is written up in
  [docs/MEETBOT-BRIDGE.md](docs/MEETBOT-BRIDGE.md).

**The only AI in the meeting is Meet Bot.** This server launches the signed Meeting Bot app from the GifOS store
in a headless browser and passes commands through `window.MeetingBot`. It does not join as a second participant.
Meet Bot has two switches: respond to commands (on or off) and conversation voice
(`none`, Grok Voice, or a local LLM with Kokoro). A local LLM is any OpenAI-compatible endpoint, with your own
key, or a provider app. The suggested default is xAI Grok (`grok-4.20-0309-non-reasoning`). On startup this
server sets up Kokoro and installs the speech-to-text provider. When it hosts `smartest`, `tts`, or `stt`, it
answers those provider calls itself. The page does not fetch them, and the key stays in this process.
`set_voice` names the providers. It does not send the URL or the key. Until the app accepts the setting,
the tool reports the gap and this server does not imitate speech.

Your own assistant tails the live transcript (`gifos://meeting/{id}/transcript`, or `tail_transcript`) and can
cut in with `say`, which Meet Bot speaks. After the meeting, that assistant does the notes, mail, and calendar
work.

**Grok Bot does the timing and the invites.** A Grok Bot routine calls `start_meeting` at meeting time. Invites
go out through your own email or calendar connector in Grok Bot, and you approve each send. This server never
sends email or calendar invites.

**The server must be running at meeting time.** If the machine is asleep or the server is stopped when the
routine fires, the bot is not in the meeting. Run it on a machine that is always on. The always-on box that
already runs Grok Bot is the best place.

## Install

You need **Node.js 20 or newer**. The first start downloads Chromium for Playwright (about 150 MB), and the
first transcription downloads the Whisper model (about 77 MB).

Run it straight from GitHub:

```sh
npx -y github:nwcnwc/gifos-mcp
```

`npx gifos-mcp` works the same once the package is published to npm.

Or from a clone:

```sh
git clone https://github.com/nwcnwc/gifos-mcp.git
cd gifos-mcp
npm install
npx playwright install chromium
node bin/gifos-mcp.js            # stdio
node bin/gifos-mcp.js --http     # or streamable HTTP on http://127.0.0.1:19520/mcp
```

If Chromium is missing, the server runs `playwright install chromium` by itself on first start. Set
`GIFOS_MCP_NO_INSTALL=1` to turn that off.

## Grok Bot setup

Add a local (stdio) MCP server in Grok Bot's MCP / connector settings. The configuration is the standard
`mcpServers` JSON:

```json
{
  "mcpServers": {
    "gifos-meet": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:nwcnwc/gifos-mcp"],
      "env": {
        "GIFOS_URL": "https://gifos.app",
        "GIFOS_LLM_KEY": "your-key"
      }
    }
  }
}
```

From a clone, use `"command": "node"` and `"args": ["/path/to/gifos-mcp/bin/gifos-mcp.js"]`.

The server warms up in the background as soon as Grok Bot starts it, so the first `start_meeting` doesn't wait
for the browser. A cold start takes about 10 seconds, plus downloads on the very first run.

If your client can only reach MCP over HTTP, run `gifos-mcp --http [port]`. It listens on `127.0.0.1` only. Set
`GIFOS_MCP_HTTP_TOKEN` to require `Authorization: Bearer <token>`.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `GIFOS_URL` | `https://gifos.app` | The GifOS site to use. It must be 0.9.23 or newer with Meeting Bot in its store. |
| `GIFOS_RELAY` | GifOS default | A custom relay (`wss://…`) for self-hosted GifOS. It is added to meeting links. |
| `GIFOS_BOT_NAME`, `GIFOS_BOT_PASSWORD` | generated | The Meeting Bot name and password. They derive the bot's secret admin meeting. The name is what participants see. If unset, a strong pair is generated once and kept in `GIFOS_MCP_HOME/bot.json` (mode 0600). A `bot.json` that cannot be read at start is kept as `bot.json.bad-<ms>` (mode 0600, logged) and a new pair is generated; it is not overwritten, so the old pair can be put back by hand. |
| `GIFOS_STT_APP` | `offline-stt-whisper` | The store app that turns speech into text. `none` turns transcription off. |
| `GIFOS_MCP_HOME` | `~/.gifos-mcp` | The browser profile, the bot credential, and `meetings.json`. |
| `GIFOS_HEADLESS` | `1` | `0` shows the browser windows, which helps when debugging. |
| `GIFOS_CHROME` | Playwright's Chromium | Path to another Chromium or Chrome binary. |
| `GIFOS_TIMEOUT_MS` | `120000` | How long to wait for GifOS steps such as joining. |
| `GIFOS_MCP_HTTP_TOKEN` | none | A bearer token for `--http`. |
| `GIFOS_MCP_LAZY` | `0` | `1` starts the browser on the first tool call instead of at launch. |
| `GIFOS_MCP_DEBUG` | `0` | `1` logs the GifOS console to stderr and adds per-meeting caption state to `status`. |
| `GIFOS_MCP_SHOTS` | none | A folder for screenshots of the bot's screens (for debugging). |
| `GIFOS_LLM_KEY` | none | Your key for the text model. It stays in this process. It is not written into the page, not logged, not put in a tool result, and not passed to `MeetingBot.setVoice`. Leave it unset and conversation voice stays off unless you set `GIFOS_CONVERSATION_VOICE` or `GIFOS_LLM_APP`. |
| `GIFOS_LLM_URL` | `https://api.x.ai/v1` when a key is set and `GIFOS_LLM_APP` is empty | OpenAI-compatible base URL. When this process hosts `smartest`, it calls that URL. The page does not. |
| `GIFOS_LLM_MODEL` | `grok-4.20-0309-non-reasoning` on that host | Model name stored with that endpoint. Required when the URL is not xAI, conversation voice is `local`, and `GIFOS_LLM_APP` is empty. |
| `GIFOS_LLM_APP` | empty | A store provider app assigned to `smartest` instead of a URL. |
| `GIFOS_CONVERSATION_VOICE` | `local` when a key or URL is set, otherwise `none` | `none`, `grok` (Grok Voice), or `local` (the configured LLM, then Kokoro). Meet Bot owns the voice. |
| `GIFOS_RESPOND_TO_COMMAND` | on | `0` tells Meet Bot not to answer commands it hears. |
| `GIFOS_VOICE` | follows the settings above | `0` forces conversation voice `none`. Tailing the transcript still works. |
| `GIFOS_TRANSCRIPT_POLL_MS` | `500` | How often captions are copied from Meet Bot into the live transcript. A room waits for its last copy to answer before asking again. |
| `GIFOS_TTS_ENGINE` | `kokoro` | `auto` and `kokoro` run Kokoro in this process (voice `af_heart`) and the host binding answers the GifOS `tts` role. The first start downloads the weights into `GIFOS_MCP_HOME/kokoro`. `none` does not. |
| `GIFOS_TTS_APP` | empty | A store provider app to install and assign for speech instead of Kokoro in this process. |
| `GIFOS_TTS_VOICE` | `af_heart` | Kokoro voice name, passed through with local voice. |
| `GIFOS_KOKORO_URL` | `https://huggingface.co` | Where the Kokoro weights are downloaded from: a mirror with the Hugging Face layout (`<model>/resolve/main/<file>`). Each file is written as `<file>.<pid>.part` and renamed into place when complete, so a start killed mid-download (or several workers downloading at once) never leaves a short file at the model path. The part file of a start that was killed is kept, and the next start asks the mirror only for the bytes after it (an HTTP Range request; a mirror that ignores Range sends the whole file). The kept bytes are resumed only when the mirror's ETag for the file is still the one they came with (sent as If-Range and checked on the answer, since the Hugging Face CDN ignores If-Range); a part with no strong ETag, or of a file that changed, is dropped and downloaded again. So a worker killed because its boot ran out of time gets further on each restart instead of starting from zero. If the weights on disk still do not load, they are deleted and downloaded once more; if that fails too, the process logs one `Kokoro could not load …` line and exits 1 (a worker exits and is restarted with backoff). |
| `GIFOS_TTS_URL` | empty | HTTP speech stand-in. This process fetches it and answers `tts`. Replaces the Kokoro install. The page does not request it. `GIFOS_TTS_ENGINE=none` wins. |
| `GIFOS_STT_URL` | empty | HTTP caption stand-in. This process posts the audio when `GIFOS_STT_APP=none`. Not passed to Meet Bot as a URL. |
| `GIFOS_MAX_MEETINGS` | `4` | Provisional cap on seated meetings until a machine is measured. A manual join over the cap is refused. A scheduled join waits. |
| `GIFOS_WORKERS` | `1` | Stage B. More than 1 makes this process a supervisor and runs each Meet Bot in its own child process and Chromium. Worker 0 keeps the bot name and `profile-bot`. Worker n is its own bot, named `<name>-wn`, with `profile-bot-wn`. Lines that bot speaks in its room are stored as the bot's `spoken` lines under that name, not as speech from a person. A meeting stays on the worker that joined it. If a worker stops, its meetings go back to `scheduled` and the clock rejoins any order still in its window. A meeting with no order (`join_meeting` with no password, or `start_meeting`) is rejoined on the next clock tick too, unless `end_meeting` is called on it first. A room is joined once at a time: a clock tick and a `start_meeting` for the same room share one join, and `end_meeting` during that join leaves the seat as soon as it lands; if that leave fails, the meeting is `live` again on that seat with `transcribing: false` and raises one `meeting.error` ("The bot could not leave the room; call end_meeting again."), so a second `end_meeting` reaches it. A join that lands but whose transcription will not start leaves that room again and fails (the clock tries again on its next tick), so the bot is never seated twice in one room; if that leave fails too, the meeting stays `live` with `transcribing: false` and raises one `meeting.error`, and `unmute` or `end_meeting` reaches that seat. A worker that stops answering a heartbeat for 30s is killed and handled the same way, and so is one that has not finished booting (for example a stalled first download of the Kokoro weights, which the restart resumes) within 5 × `GIFOS_TIMEOUT_MS`; the join waiting on it goes to the next worker. A worker that keeps dying waits 1s, 2s, 4s, up to a minute before each restart, and joins (and the browser warm-up) go to another worker meanwhile; `status` shows `restart_in_ms` on that worker. A worker that is running but whose browser will not start is treated the same way: the join that found it out goes to the next worker, joins skip it for 1s, 2s, 4s, up to a minute before it is tried again, and `status` shows `start_retry_in_ms` and the start error on its row. A worker process that dies during a join (its browser goes with it) does not fail that join: it goes to the next worker with a free seat, once, so a room that takes down every worker it reaches costs at most two workers a restart. The clock does not join such a room again at once: it raises one `meeting.error` ("The room crashed the bot; trying again in N min.", with `retry_in_ms`) and waits 1 minute, then 2, 4, up to 30 between tries while the order is in its window, so the meetings it knocked off get their seats back and keep them. A `start_meeting` or `join_meeting` by hand waits on the same clock: on a room in its wait it fails at once ("The room crashed the bot; it can be tried again in N min.") without walking in, and a hand join that takes down every worker it reaches starts that wait too. The wait is kept in `crashes.json` under `GIFOS_MCP_HOME` (mode 0600), so a supervisor restarted within it still waits; an unreadable `crashes.json` is moved aside like `schedule.json`. While no worker has a free seat, an order due to join waits: it goes to `waiting_for_capacity` and raises one `schedule.waiting` event with `reason: "worker"` (`"capacity"` when the cap is reached), not an error every clock tick; if no seat frees before its end it is `missed` for capacity. A call to a worker that is still alive fails after 60s with no answer (a browser start or a join after 5 × `GIFOS_TIMEOUT_MS`); a join that ran out of time keeps its seat until the worker answers it (the bot may still be walking into the room; `status` shows `late_joins` on that row), so the worker is not given more rooms than its budget; one that lands after that is left at once, so no seat is held that nobody can reach, and one that fails frees the seat. A join that still has not answered one more join window later is checked against the worker's own Meet Bot room list: a room the supervisor does not hold is left (as above), and the seat is freed, so a join that never answers does not hold a seat until the worker dies. If the leave of a join that landed late fails, the room keeps its seat and is left again every 10s until it works; `status` shows `stray_rooms` on that worker's row meanwhile. A `leave_meeting` or `end_meeting` whose leave fails or runs out of time keeps the meeting `live` on its worker (the bot may still be in the room), so calling it again reaches the room; a late leave that lands, or Meet Bot answering that it no longer holds the room, frees the seat. A leave that still has not answered one more call window later is checked against the worker's Meet Bot room list: if the room is gone, the seat is freed; if the bot is still listed there, the seat stays taken. After a late leave landed or that check freed the seat, the next `leave_meeting` or `end_meeting` on that meeting ends it. `status` asks every worker at once and waits at most 3s for each; a worker that does not answer in time shows `error` on its row while the rest of `status` comes back. If the supervisor itself dies without shutting down (SIGKILL, out of memory), each worker sees its channel close, closes its Chromium, and exits, so no bot is left in a room that nothing can reach; a worker still booting (for example fetching the Kokoro weights) exits at once too, and so does one told to close while booting, keeping its part file for the next start. Each worker runs with a `TMPDIR` of its own, `gifos-mcp-<tag>-w<n>` under the supervisor's (the tag is named by `GIFOS_MCP_HOME`), emptied before each start and removed when the worker exits or `close` ends it, so the `playwright-artifacts-*` folder a worker killed under its Chromium could not remove does not pile up in `/tmp`; a worker leaving because its supervisor died removes its own. `set_voice` goes to every running worker at once; a worker that refuses it, misses it, or restarts gets the same settings again before its next join, and a running worker that refused is asked again every 10s until it takes them; meanwhile `status` shows `voice: "pending"` on its row. |
| `GIFOS_WORKER_ROOMS` | cap / workers, rounded up | Rooms per worker. Workers times rooms must cover `GIFOS_MAX_MEETINGS`. |

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `create_meeting` | `name`, `admin_password` | `{ link }`. Mints the room. `admin_password` is the human's password for this call only. It is not stored, not logged, and not returned. Grok Bot invents the room password and sends the invite. |
| `start_meeting` | `meeting_id` | The bot joins and starts transcribing. |
| `join_meeting` | `link`, `password?`, `topic?` | The bot joins someone else's GifOS meeting (`…/run.html#v=…` or `…/meet/…`). Returns a `meeting_id`. |
| `mute` | `meeting_id` | The bot stops transcribing, and the transcribing chip goes away. The bot never sends audio, so this is the only mute it has. |
| `unmute` | `meeting_id` | The bot transcribes again. |
| `share_content` | `meeting_id`, `text` | Posts text or a link (up to 2000 characters) into the meeting chat as the bot. There is no screen sharing, because the bot has no screen. This is chat, not speech. |
| `get_transcript` | `meeting_id` | Plain text, one `speaker: words` line per caption. Works while the meeting is live and after `end_meeting`. |
| `tail_transcript` | `meeting_id`, `since?` | New caption lines since `since` (a `seq` from the previous tail). Each line is `{seq, ts, speaker, text, kind}` and `kind` is `speech`. Lines come from Meet Bot. Works while the meeting is live and after `end_meeting`. |
| `set_voice` | `respond_to_command?`, `conversation_voice?` | Turns Meet Bot's spoken answers on or off (`none` is quiet; `grok` or `local` speaks). Meet Bot gets only `{ respond_to_command, speak }`, on this call and on every join. The URL, model, and key always come from the environment. The key is not an argument and is not returned. |
| `say` | `meeting_id`, `text` | Passes a spoken line to Meet Bot (`MeetingBot.interject`), ahead of conversation voice. Meet Bot asks the `tts` provider, which this process answers when it hosts that role. This server does not play the audio. Errors until Meet Bot grows that method. |
| `send_chat` | `meeting_id`, `text` | Posts chat through Meet Bot (`MeetingBot.say`), the same channel as `share_content`. |
| `raise_hand` | `meeting_id`, `on` | `MeetingBot.raiseHand`. Reports the gap on contract version 1. |
| `set_mic` | `meeting_id`, `on` | `MeetingBot.setMic`. Reports the gap on contract version 1, which gives the bot no microphone. |
| `set_camera` | `meeting_id`, `on` | `MeetingBot.setCamera`. Reports the gap on contract version 1, which gives the bot no camera. |
| `get_meeting_state` | `meeting_id` | Who is here (`people`). Hand, microphone, and camera when Meet Bot reports them. |
| `snapshot` | `meeting_id` | Read-only. People, plus a PNG of the Meet Bot page this server already runs. |
| `leave_meeting` | `meeting_id` | Saves the transcript, then the bot leaves. Same outcome as `end_meeting`. |
| `end_meeting` | `meeting_id` | Saves the transcript, then the bot leaves. Everyone else can stay, because GifOS meetings have no owner who can close them. If Meet Bot already left the room on its own (ended from its page or the admin meeting), the meeting is ended here too. If the leave fails for any other reason the meeting stays `live`, so calling it again reaches the room. |
| `list_meetings` | none | Every meeting this server created or joined, with its state (`scheduled`, `live` or `ended`). |
| `status` | none | Browser state, bot name, the bot's live sessions, and whether the voice setting was handed over. The endpoint and the key are not included. |
| `schedule_meeting` | `link`, `room_password`, `start`, `end?` | Stores the join order, including the room password, in `schedule.json` (mode 0600, written to a temp file then renamed, so a save cut short keeps the last good file; a file that cannot be read at start is kept as `schedule.json.bad-<ms>` and not overwritten). The bot joins one minute before `start`. A join that fails (not a crash, not a full pool) is tried again on every clock tick while the window is open, and raises one `meeting.error` ("The room could not be entered; trying again.") and one `schedule.due` for that order, not one per tick; after a join works, the next failure raises one again. Those events, and `schedule.waiting`, are once per window: an order moved to a new `start` or `end` (an order waiting for capacity goes back to `upcoming`) raises them again in its new window. `end` defaults to `start` plus 8 hours. The password is not returned. |
| `list_schedule` | `from?`, `to?`, `timezone?`, `phase?`, `flag_overlaps?` | Orders in the window. No passwords. |
| `update_schedule` | `schedule_id`, `occurrence?`, patch | No occurrence changes the whole future series. An occurrence id changes only that one. |
| `cancel_schedule` | `schedule_id`, `occurrence?`, `leave_if_live?` | Cancels one occurrence or the series. Leaves a live one unless asked not to. |
| `import_schedule` | `orders` | Bulk calendar import. A recurrence rule this process cannot expand is reported and not stored. |
| `meeting_status` | `meeting_id` | One meeting: phase, people, thinking, line counts. No passwords. |
| `tail_lines` | `meeting_id?`, `since?`, `kinds?` | Speech, chat, and spoken lines. |
| `meetings_report` | `since?`, `meeting_ids?` | Raw rows across meetings. Not a written summary. |
| `tail_events` | `since?` | Connector events, including `capacity.near`, `capacity.reached`, and `capacity.cleared`. They are appended to `GIFOS_MCP_HOME/events.jsonl` (mode 0600); a torn last line left by a process killed mid-write is skipped and ended at the next start, so later events stay readable and no `seq` is handed out twice. |
| `capacity_status` | none | Who is seated, who is waiting, and future clashes inside the horizon. |

The resource `gifos://meeting/{id}/transcript` is the same live transcript as `tail_transcript`, as newline-delimited JSON tailed from Meet Bot. A client can subscribe and receive `notifications/resources/updated`.

Errors come back as MCP tool errors with a readable message, for example `Unknown meeting_id …` or
`Meeting m_… is scheduled. Call start_meeting first.`

## Example: a 5 PM meeting

The user tells Grok Bot: *"Set up a demo meeting with Alice and Bob at 5 PM, take notes, and send me a summary."*

1. **Mint the room.** Grok Bot calls `create_meeting({name: "Demo meeting", admin_password})`. The admin
   password comes from Grok Bot's secrets store for this call only. The response is a plain `link`.
2. **Invite.** Grok Bot makes up a room password and invites Alice and Bob, from its own email or the human's,
   with the link and that room password. It never sends the admin password.
3. **Schedule.** Grok Bot calls `schedule_meeting({link, room_password, start, end})`. The bot joins one minute
   before `start`. The room password is stored on the schedule so a restart can rejoin. The admin password is not.
4. **Meeting (17:00 onward).** Alice and Bob open the link and see the 🤖 bot tile with the transcribing chip.
   While the bot is working out a reply, that tile shows a thinking animation.
   If the voice setting was handed over, Meet Bot talks (Grok Voice, or the local LLM). Grok Bot tails
   `gifos://meeting/{id}/transcript` (or calls `tail_transcript`) and can `say` a line of its own. Grok Bot can
   `share_content` the agenda. When the meeting is over (a second routine, or the user saying so),
   Grok Bot calls `end_meeting`, reads the transcript, writes the summary, and drafts it to the user.
   This server does not send that mail.

## Privacy and security

- **Everything runs locally.** The browser, the bot, one shared speech-to-text engine, and the
  transcripts are all on your machine. Media goes peer to peer between participants. GifOS's relay only helps
  peers find each other.
- **Consent is visible.** The bot is labelled 🤖 bot and shows 📝 transcribing whenever it listens. `mute`
  removes the chip.
- **The bot never uses your microphone or camera.** It joins with no camera, Meeting Bot never transcribes its
  own machine's microphone, and its browser is fed a silent fake microphone anyway.
- **Only one secret.** The bot name and password derive Meeting Bot's secret admin meeting, which can command
  the bot from another device (Meeting Bot's CONTROL mode). Keep
  `GIFOS_MCP_HOME/bot.json` private (it is mode 0600), or pass the pair through environment variables. Anyone
  with the pair can command the bot.
- **Meeting links are capabilities.** Anyone with a link can join that meeting, so share links only with the
  people you invite.
- **Transcripts are stored** in `GIFOS_MCP_HOME/meetings.json` (mode 0600) so they survive restarts. Delete the
  file to forget them. It is written to a temp file then renamed, so a save cut short keeps the last good file;
  a file that cannot be read at start is kept as `meetings.json.bad-<ms>` (mode 0600, logged) and not
  overwritten. Delete any `*.bad-*` file too (a `bot.json.bad-*` holds an old bot password). A join
  whose save fails (disk nearly full) still holds its seat and reads its captions; the failure is
  logged and the next save writes it. The same holds for `schedule.json`: a clock tick whose save fails
  still seats, waits and ends its orders, logs the failure once until a save works, and the next save
  writes their phases. An `end_meeting` (or a clock leave) whose saves fail still reports the leave,
  raises `meeting.left`, and keeps the meeting ended and its order `left_early` or `ended` in memory, so no
  tick seats the bot again. A `join_meeting` with a password whose `schedule.json` save fails still reports
  the join and raises `meeting.joined`; its order (with the room password) is kept `live` in memory and the
  next save writes it. A `mute`, `unmute` or `get_transcript` whose `meetings.json` save fails still
  answers with what the bot did (muted, listening, the transcript); memory keeps it and the next save writes it.
  A transcript line whose append to `transcripts/<id>.jsonl` fails keeps every caption line of that snapshot
  (and its `line.*` event), `send_chat` and `say` still report what Meet Bot sent, and the kept lines are
  written in order at the next append that works. A file whose last line was torn is ended before the next line.
- **The key stays in this process.** When this server hosts `smartest`, it calls the model. The page does
  not, and `GIFOS_LLM_KEY` is not written into Settings. `MeetingBot.setVoice` receives only
  `{ respond_to_command, speak }`, never the URL or the key. Leave the key unset and conversation voice stays `none` unless
  you ask for Grok Voice or name a provider app with `GIFOS_LLM_APP`.
- **No outgoing messages.** The server never sends email, calendar invites or anything else. Grok Bot does that
  through your own connectors, and you approve each send. Follow-up after the meeting is Grok Bot's job.
- **HTTP mode** binds to 127.0.0.1, checks the `Host` header (DNS-rebinding protection), and can require a
  bearer token.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `The GifOS store at … has no "meeting-bot" app` | That GifOS is older than 0.9.23. Set `GIFOS_URL` to a 0.9.23 or newer site. |
| `The store refused to install meeting-bot: Needs a newer GifOS` | Same cause: the site's build is older than the one Meeting Bot needs. |
| `Meeting Bot did not start: A bot with this name and password is already running…` | Another `gifos-mcp` (or a Meeting Bot window) uses the same name and password. Stop it, or give this one its own `GIFOS_MCP_HOME` or `GIFOS_BOT_NAME`/`GIFOS_BOT_PASSWORD`. |
| `get_transcript` stays at `(no transcript lines yet)` | Somebody has to speak with their mic on. The first transcription downloads the Whisper model (about 77 MB), which takes a minute. Run with `GIFOS_MCP_DEBUG=1` and call `status` to see each meeting's caption state. |
| `This Meeting Bot has no local control API` | The store's Meeting Bot is older than the control contract v1. Update it from the store (the server presses Update when the store offers it). |
| `Chromium for Playwright is missing` | Run `npx playwright install chromium`. On Linux you may also need `npx playwright install-deps chromium`. |
| The routine's `start_meeting` failed | The server wasn't running, or the machine was asleep. Keep it on an always-on machine. |
| Tool calls time out in the client | The first call after launch can take about 10 seconds while the browser starts. Leave `GIFOS_MCP_LAZY` unset so it warms up at launch. |
| Anything else | `GIFOS_HEADLESS=0` shows the browser windows. `GIFOS_MCP_SHOTS=/tmp/shots` saves screenshots of each step. |

## Testing instructions for marketplace reviewers

**1. Unit tests (no network, no browser, under a minute).**

```sh
git clone https://github.com/nwcnwc/gifos-mcp.git && cd gifos-mcp
npm install
npm test
```

These run the tools over a real MCP client/server pair with a fake bot, plus the `--http` transport through
the real binary. Voice tests check that the local-LLM setting is handed to Meet Bot without the key, and
that a hosted model call stays in this process.
`npm test` runs them with `TMPDIR` set to a fresh folder and fails if a test leaves anything in it. The
Kokoro test keeps its ~90 MB of weights in `~/.cache/gifos-mcp-test-kokoro` between runs.

**2. Try it live (needs GifOS 0.9.23 or newer on gifos.app).**

1. Add the server to Grok Bot with the config above, or run `npx -y github:nwcnwc/gifos-mcp` under any MCP
   client.
2. Ask: *"Create a GifOS meeting called Demo meeting and start it."* You get a link back.
3. Open the link in a normal browser, allow the microphone, turn your mic on, and say a sentence or two. You
   should see a tile labelled 🤖 bot with 📝 transcribing.
4. Ask: *"Share 'Hello from Grok' in the meeting."* It appears in the meeting chat.
5. After about 30 seconds (longer the first time, while the Whisper model downloads), ask: *"Get the transcript."*
   Your words come back as `YourName: …` lines.
6. Ask: *"End the meeting."* The bot tile disappears. `get_transcript` still returns the saved text.

**3. Full end-to-end test against a local GifOS** (what the maintainers run; see [PROOF.md](PROOF.md)).

```sh
git clone -b release/0.9.23 https://github.com/nwcnwc/gifos-app.git ../gifos-app
git clone -b meet-bot https://github.com/nwcnwc/gifos-apps-source.git ../gifos-apps-source
GIFOS_APP_DIR=../gifos-app \
MEETING_BOT_SRC=../gifos-apps-source/meeting-bot \
E2E_RELAY=wss://your-gifos-0.9.23-relay \
E2E_SPEECH_WAV=/path/to/someone-speaking.wav \
npm run test:e2e
```

It serves the GifOS checkout on `127.0.0.1:19510`, adds Meeting Bot to that site's store (from
`MEETING_BOT_SRC`; leave it unset when the checkout already lists `apps/meeting-bot`), and spawns
`gifos-mcp` over stdio. Then it runs `create_meeting` → `start_meeting`. A second headless browser joins as
"Alice" and plays the WAV. The test checks that `get_transcript` returns Alice's words, then runs
`share_content`, `mute`/`unmute`, `list_meetings` and `end_meeting`. Screenshots go to `.e2e/proof/`.
Variants:

- `E2E_STT=synthetic` swaps Whisper for a tiny test provider, so no WAV and no model download are needed.
- `RELAY_SCRIPT=<path>` starts a local GifOS relay on `127.0.0.1:19511` instead of using `E2E_RELAY`.
- `npm run test:e2e:load` (`E2E_ROOMS=1,4,8`) measures one Chromium and Meeting Bot holding more and more rooms,
  the bot alone and with one person talking in each, and checks every room is still heard. Results go to
  `.e2e/proof-load/load.json`; see [PROOF.md](PROOF.md). It uses the synthetic provider unless `E2E_STT=whisper`,
  which needs `E2E_SPEECH_WAV` (each person's mic plays it) and counts a room heard when its person's line
  matches `E2E_EXPECT`.
- Each runner works in a folder under `TMPDIR` and removes it however it exits: a failed setup, a failed check,
  Ctrl-C or SIGTERM.

## License

MIT. GifOS and Meeting Bot are separate projects with their own licenses.
