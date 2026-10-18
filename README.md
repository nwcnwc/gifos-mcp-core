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
- **No text model.** The assistant calling the tools is the brain. Meet Bot is handed
  `{ respond_to_command: false, speak: false }` on every join, so it answers nothing on its own; it speaks
  exactly the lines `say` gives it. No model URL, model name or API key is read anywhere.
- **Fast lines.** `wait_lines` returns the moment a new line lands (or after `timeout_ms`), with
  `to_bot: true` on lines addressed to the bot. Captions are copied from Meet Bot every 300 ms
  (`GIFOS_TRANSCRIPT_POLL_MS`).
- **Speech: Kokoro** ([kokoro-js](https://github.com/hexgrad/kokoro) 1.2.1, an exact-pinned normal dependency)
  with its default voice `af_heart`. `say` takes an optional `voice` for one line. See *Endpoints*.
- **Speech to text: GifOS Whisper** (the Offline Captions app from the GifOS store), in the headless browser.
- **Links** (`src/links.js`). Room links are minted here. A host's room carries only the verifier of the host
  key, derived as GifOS does (PBKDF2-SHA256 310000 rounds → Ed25519 → SHA-256); the password never leaves
  the process.
- **Invite details** (`src/invite.js`, [docs/INVITE.md](docs/INVITE.md)): title, start and end with time zone,
  link, description, how people get in, who does what, and ready-to-send text. Nothing is sent and no
  calendar file is written.

## The browser

The servers drive the browser already on this computer: `GIFOS_CHROME` if set, else Google Chrome, else
Microsoft Edge, else a Chromium that `npx playwright install chromium` installed earlier. They never download
or install a browser. With none of these the server stops with a message saying what to install.

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

MIT. GifOS, Meeting Bot and Kokoro are separate projects with their own licenses.
