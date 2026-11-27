# gifos-mcp-core

Shared core of the two GifOS MCP servers for Grok Bot (or any MCP client):

- [gifos-meet-mcp](https://github.com/nwcnwc/gifos-meet-mcp): meetings, a note-taking bot, transcripts.
- [gifos-broadcast-mcp](https://github.com/nwcnwc/gifos-broadcast-mcp): broadcasts, invite details and a producer.

This package is not an MCP server by itself and is not installed on its own. Each server depends on it,
pinned to an exact commit. Everything runs on your own computer; there is no hosted MCP URL.

## What is in it

- **The shared bot** (`src/context.js`, `src/tools/shared.js`). It starts a headless Chromium running GifOS,
  installs the signed **Meeting Bot** app from the GifOS store and drives it through `window.MeetingBot`
  ([control contract](https://github.com/nwcnwc/gifos-apps-source/blob/main/meeting-bot/CONTROL.md), version 2).
  It also keeps the transcript lines, the join schedule, events and capacity. Both servers get the same
  tools for transcripts (`get_transcript`, `tail_transcript`, `tail_lines`, `wait_lines`), speaking and chat
  (`say`, `send_chat`, `share_content`), how the bot looks (`set_bot_profile`), the room (`get_meeting_state`, `snapshot`, `mute`, `unmute`,
  `leave_meeting`, `end_meeting`), the schedule and status.
- **GifOS 0.9.26 meeting tools** (`src/room.js`, `src/tools/room.js`, `registerRoomTools`): the shared
  agenda (`set_agenda`, `next_agenda_item`, `get_agenda`), apps in the meeting (`list_apps`, `run_app`,
  `stop_app`, `take_turns`), the stage (`stage`) and `sign_in_as_host`. Meeting Bot's control API has no
  methods for these yet, so they act in the bot's own meeting frame with that seat's rights (a guest cannot do
  what only a host may). On an older GifOS site they answer that the site does not have them yet.
- **No text model.** The assistant calling the tools is the brain. Meet Bot is handed
  `{ respond_to_command: false, speak: false }` on every join, so it answers nothing on its own; it speaks
  exactly the lines `say` gives it. No model URL, model name or API key is read anywhere.
- **Fast lines.** `wait_lines` returns the moment a new line lands (or after `timeout_ms`), with
  `to_bot: true` on lines addressed to the bot. Captions are copied from Meet Bot every 300 ms
  (`GIFOS_TRANSCRIPT_POLL_MS`).
- **Speech: Kokoro** ([kokoro-js](https://github.com/hexgrad/kokoro) 1.2.1, an exact-pinned normal dependency)
  with its default voice `af_heart`. `say` takes an optional `voice` for one line. See *Endpoints*.
- **Speech to text: GifOS Whisper** (the Offline Captions app from the GifOS store), in the headless browser.
- **The booth** (`src/booth.js`, `src/tools/booth.js`, `registerBoothTools`): a broadcast's host seat (the `/cast`
  page) in its own headless browser and profile: `open_booth`, `play_video` (one file, a list, a loop; bad spots skipped;
  a stuck video, a lost page or a new GifOS release reloads and resumes the same second; filler mode
  `yield_to_people` gives the Stage to any person who takes it and resumes when they leave), `stop_video`,
  `publish_to_tv` / `update_tv_listing` / `stop_tv_listing` (the signed gifos.tv listing the /cast page's "Publish to
  GifOS.tv" button makes, signed with the room's host key in the host page; the page then keeps it live),
  `booth_status`, `close_booth`. gifos-meet-mcp registers them; its examples/channel runs a 24/7 channel with them.
- **Links** (`src/links.js`). Room links are minted here. A host's room carries only the verifier of the host
  key, derived as GifOS does (PBKDF2-SHA256 310000 rounds → Ed25519 → SHA-256); the password never leaves
  the process. The room name rides in the part after #, which browsers never send to a server, so it never reaches GifOS's servers or logs. The simple public forms, gifos.app/meet/<room> and gifos.app/meet/<room>/<verifier> (hosted), work forever and are fine for links you write by hand, like gifos.app/meet/welcome; they put the room name in the address a server sees.
- **Invite details** (`src/invite.js`, [docs/INVITE.md](docs/INVITE.md)): title, start and end with time zone,
  link, description, how people get in, who does what, and ready-to-send text. Nothing is sent and no
  calendar file is written.

## The browser

The servers drive the browser already on this computer: `GIFOS_CHROME` if set, else Google Chrome, else
Microsoft Edge, else a Chromium that `npx playwright install chromium` installed earlier. They never download
or install a browser. With none of these the server stops with a message saying what to install.

`GIFOS_BOT_MODE=core` needs no browser, and `GIFOS_CORE_MODE=1` while core mode is opt-in in `@gifos-app/agent`
(without it a core join is refused; under `auto` that falls back to the browser). The bot (src/core-driver.js) runs each meeting on the meeting's own core,
through `@gifos-app/agent`, over WebRTC data channels; Node 22 or later. It reads people, chat and the
captions people share, posts chat and raises a hand. It speaks when Kokoro is loaded in this process (the same
engine the browser bot uses); camera, recording and room actions (the agenda, apps, the stage, host sign-in, a
guard holding a room) answer that they need the browser bot, since no GifOS site signs those agent actions yet.
A meeting link is untrusted: only a core signed by GifOS runs, in a child process that cannot write
files, start programs or read this server's environment (`@gifos-app/agent` docs/core-trust.md). `GIFOS_CORE_KEYS`
(comma-separated base64 Ed25519 public keys) trusts your own signing key instead, for a core you built yourself.

`GIFOS_BOT_MODE=auto` (src/switch-driver.js) tries the core first and keeps the browser for later: a process
whose meetings all join on the core never starts a browser. A join falls back to the browser when the core
cannot do it (core mode off in the SDK, a site with no signed core, a join timeout). A guard (src/guard.js, which
needs room ops) checks the core's `host.state` right after joining; a core with no room actions yet leaves that
seat and joins with the browser instead, so a held room is never stuck on a path that cannot drive it.
The `status` tool (or any `info()` caller) tags each live meeting `core` or `browser`.

## Endpoints and downloads

| What | Where | When | Size |
|---|---|---|---|
| GifOS site (`GIFOS_URL`) | `https://gifos.app` by default | every start | — |
| GifOS relay | GifOS's default, or `GIFOS_RELAY` | while in a room | — |
| Kokoro weights | `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX`, revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231` (or the mirror in `GIFOS_KOKORO_URL`) | first start, kept in `GIFOS_MCP_HOME/kokoro` | about 92 MB; every file is checked against its SHA-256 (`KOKORO_FILES` in `src/voice/kokoro.js`) before use |
| Kokoro voices | inside the kokoro-js npm package | install | — |
| Whisper model | GifOS store app, through the GifOS site | first transcription | about 77 MB |

No telemetry. The only credential is the bot's own name and password (`GIFOS_MCP_HOME/bot.json`, mode 0600, or
`GIFOS_BOT_NAME`/`GIFOS_BOT_PASSWORD`). A host password passed to a tool is used for that call only.

**How the bot looks** (`src/profile.js`). `GIFOS_BOT_NAME` alone sets the name people see and keeps the stored
password. `GIFOS_BOT_PICTURE` is a GIF, PNG, JPEG or WebP file of at most 256 KB, kept in
`GIFOS_MCP_HOME/bot-picture.json` (mode 0600) and sent to rooms like any person's picture. The `set_bot_profile` tool
(`name?`, `picture_path?`, `clear_picture?`) changes both; a new name is refused while the bot is in a room, and the
picture applies to rooms joined afterwards.

## Install scripts

This package has none. Some dependencies of kokoro-js do: `onnxruntime-node` would download CUDA libraries
from GitHub on Linux x64, `sharp` checks for a system libvips, and `protobufjs` checks its version. None of
them is needed: the CPU build of ONNX Runtime and sharp's prebuilt binary come with the packages. Install
with scripts off:

```sh
npm install --ignore-scripts
```

The servers' `.mcp.json` sets `npm_config_ignore_scripts=true` and `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`.

## Tests

```sh
npm install --ignore-scripts
npm test
```

Unit tests need no network and no browser, except the Kokoro test, which keeps the pinned weights in
`~/.cache/gifos-mcp-test-kokoro` between runs.

## License

MIT License. Copyright (c) 2026 Crowd Concepts, Inc. See [LICENSE](LICENSE). GifOS, Meeting Bot and Kokoro are separate projects with their own licenses.
