# Meet Bot bridge

gifos-mcp does not take part in a meeting. The only AI in the room is the signed **Meeting Bot** app from the GifOS app store, running in the headless browser this server already launches. This process starts that app, keeps it running, and passes commands through. It does not open a second participant and it does not play audio into the meeting. It is the host that embeds that GifOS, so it answers the `tts`, `stt`, and `smartest` provider calls itself.

The published pattern for "the real meeting page plus the app" is `js/meet-host.js` in [gifos-app](https://github.com/nwcnwc/gifos-app) (branch `meet-bot`). The host page fetches `run.html`, stamps `window.__gifosMb = "1"`, and loads that document in a same-origin session iframe. Meeting Bot never touches WebRTC. A search of the published gifos-app branch tips did not find `test/swarm/meet.js`. The host file above is the drive this server relies on.

Meeting Bot's own source and contract are [gifos-apps-source `meeting-bot/`](https://github.com/nwcnwc/gifos-apps-source/tree/meet-bot/meeting-bot), contract `window.MeetingBot.version === 1`, written up in that folder's `CONTROL.md`.

## Audit: what this branch duplicated

These pieces were added on `cursor/meeting-voice-streaming` and repeat work that belongs to Meet Bot (or to the meeting page it already drives):

| Piece | What it did | Why it does not belong here |
|---|---|---|
| `src/voice/talk.js` | Waited out a pause, sent the transcript to a chat model, and decided when the bot speaks. | Turn-taking and conversation are Meet Bot modes. |
| `src/voice/llm.js` | Called `POST /chat/completions` on an OpenAI-compatible host, with the user's key, and decided the reply. | Turn-taking stays in Meet Bot. The host injection below answers a provider call. It does not choose when to speak. |
| `src/voice/speech.js` | Called `/audio/speech` or `/tts` and played the reply into the meeting. | Playback stays in Meet Bot. Kokoro below only returns WAV bytes for the `tts` role. |
| `src/voice/clauses.js` | Split the model stream so the first words could play early. | That is part of speaking, which this server does not do. |
| `src/voice/mouth.js` | Replaced the meeting page microphone and played audio into the session. | The meeting page is driven by Meet Bot through `GifOS.meetHost`, not by a script this server injects. |
| `MeetingBotDriver.playEncoded` / `quiet` | Pushed that audio into `iframe[data-gifos-meet]`. | Same duplication. The driver may only call `window.MeetingBot`. |
| `say` speaking in the Node process | The assistant's line was synthesized here and played into the meeting. | `say` is a command this server passes through. |

Those files are not in this tree. `set_voice` calls `MeetingBot.setVoice` with the object below, and `say` calls `MeetingBot.interject`. If either method is missing, the tool reports the gap and does nothing else.

What stays, because it is management rather than participation:

- Launching headless Chromium, installing Meeting Bot and the speech-to-text and text-to-speech provider apps from the store, and calling `window.MeetingBot` (`src/driver.js`).
- Meeting links, mute of transcription, chat via `share_content`, and `end_meeting` (`src/server.js`).
- A live tail of `MeetingBot.transcript` for the assistant (`tail_transcript` and `gifos://meeting/{id}/transcript`). The tail only reads lines the app already stored.

## Two pipes

```
assistant  --MCP-->  gifos-mcp  --window.MeetingBot-->  Meeting Bot app
                                                          |
                                                          | gifos.meet  (postMessage, ns "gifos")
                                                          v
                                                       GifOS host page
                                                          |
                                                          | ns "gifos-meet"
                                                          v
                                                       real run.html session
```

The app frame is sandboxed. `connect-src 'none'` (see `APP_CSP` in gifos-app `js/runtime.js`). Meeting Bot's own tests refuse `fetch` and `WebSocket` in `app.js`. The app cannot call an LLM. The meeting runs on the GifOS host page. This Node process embeds that page. Kokoro and the hosted model and caption calls run here, and the page receives the result through one Playwright binding. The page does not fetch them.

### 1. App to host (`gifos.meet`)

Injected into the app by the runtime. Each call is `postMessage` `{ ns: "gifos", type: "meet", op, ... }` and comes back as `{ ns: "gifos", type: "reply", id, ok, result }`.

| `gifos.meet` | Host op | What the published host does |
|---|---|---|
| `join(room, passwordOrLink, name, opts)` | `join` | `GifOS.meetHost.join`. `opts.bot` defaults true. `opts.control` marks the admin meeting (`capabilities.remote`). |
| `leave(id)` | `leave` | Leaves and drops the session iframe. |
| `sendChat(id, text)` | `sendChat` | Chat line in that session. |
| `transcribe(id, on)` | `transcribe` | `setTranscribe`. The bot tile shows the transcribing chip. |
| `startRecording` / `stopRecording` / `getRecording` | same names | Recording on the session. |
| `sendXfer(id, file)` | `sendXfer` | Data-channel file toward the admin meeting. |
| `list()` | `list` | Sessions on this page. |
| `setControl(id)` | `setControl` | Which session's chat may carry remote commands. |
| `onTranscriptLine` / `onParticipants` / `onChat` / `onXfer` | events | Host posts `{ ns: "gifos", type: "meet-event", event }` to the app window. |

Unknown `op` values get `Unknown meet op.` There is no voice op.

### 2. Host to the real meeting page (`gifos-meet`)

`GifOS.meetHost.join` creates `iframe[data-gifos-meet]`, loads `run.html` as srcdoc, and speaks `postMessage` with `ns: "gifos-meet"`:

| Direction | `op` | Meaning |
|---|---|---|
| session → host | `ready` | Page is up. Host then sends `join`. |
| host → session | `join` | `room`, `link`, `password`, `name`, `bot`, `control`. |
| session → host | `joined` | `room`, `link`. Host resolves `meetingId`. |
| host → session | `leave`, `sendChat`, `transcribe`, `startRecording`, `stopRecording`, `getRecording`, `sendXfer` | One call, with `ref`. |
| session → host | `result` | `{ ref, result }`. |
| session → host | `error` | `{ ref, error }` or a failed join. |
| session → host | `event` | Forwarded to the app as a meet-event. `type: "chat"` is tagged `control` only for the admin session. |

There is no voice op on this pipe either.

### 3. Local control API (`window.MeetingBot`, version 1)

This is the only API gifos-mcp calls. It lives on the app frame (`#appmount iframe`), not on the meeting session. Methods return Promises. `start` and `status` work before RUN mode. The rest reject with "The bot is not running" until `start({ mode: "run", name, password })` has connected.

| Method | This server uses it for |
|---|---|
| `start({ mode: "run", name, password })` | Bring the bot up. |
| `status()` | `status` tool. |
| `join(link, password?)` | `start_meeting`, `join_meeting`. Returns `{ id, room, link }`. |
| `transcribe(id, on)` | `mute` / `unmute`. |
| `say(id, text)` | `share_content`. This posts **chat**, up to 2000 characters. It does not speak. |
| `transcript(id)` | `get_transcript` and the live tail. `{ id, lines: [{ by, text, at }], text }`. |
| `end(id)` / `leave(id)` | `end_meeting`. The bot leaves. Everyone else stays. |
| `list`, `people`, `create`, `record`, `recording` | Present on the app. This server does not need them for voice. |

Remote control (a second copy of the app in CONTROL mode, `gb1 ` JSON on the admin meeting) mirrors those ops. gifos-mcp does not use it. The bot name and password stay in `GIFOS_MCP_HOME/bot.json` and are not a tool result.

## Where the models live

GifOS holds the models. Settings → AI models writes `gifos_ai_config` in the computer's localStorage (not in a shareable backup). The rows are `smartest` and `cheapest` for text (there is no row named `llm`), plus `tts`, `stt`, `image`, `image_to_video`, and `video`. Each row is one of two shapes:

- A provider app: `{ app: fileId, appId, appName }`, written by `GifOS.providers.assign(role, { fileId, appId, name })`.
- An endpoint: `{ url, key, model }`, the "your own address and key" fields in that same Settings panel. The host page's AI broker fetches it. The key stays in that localStorage.

## What a provider is

A provider is an ordinary App GIF whose manifest lists roles:

```json
{
  "gifos": "1.0",
  "appId": "offline-tts-kokoro",
  "name": "Offline Neural TTS (Kokoro, GPU)",
  "entry": "index.html",
  "capabilities": { "wasm": true, "gpu": true },
  "provides": { "ai": ["tts"] }
}
```

The signed providers in the store are Kokoro, Kitten, and eSpeak for `tts`; Whisper for `stt`; and BitNet, Gemma, and Gemma 4 for `cheapest`. Each one runs the model inside the GIF. None of them declares `capabilities.network` or `capabilities.api`.

Meet Bot's conversation text role is `smartest`. This server assigns the endpoint, or `GIFOS_LLM_APP`, to that row only. `cheapest` stays the row the offline models provide. `setVoice` names `llm: { provider: "smartest" }`.

## The host injects itself

gifos-mcp is the program that embeds the headless GifOS, the same way a test harness embeds a page. It is not a provider GIF. A provider GIF is sandboxed with `connect-src 'none'`, so it cannot ask this process for audio, captions, or a model reply. `GifOS.providers.place` and `configure` are the wrong tool for that: a placed GIF still cannot reach this process, and an endpoint URL on an https page is mixed content.

The injection is one Playwright binding, `__gifosHostCall(role, json)`, installed with `exposeBinding` before the page loads. Route handlers were not used, because those would make the page fetch. The page does not fetch, and the key never enters the page.

`GifOS.providers.assigned(role)` for a hosted role returns `{ host: true, role, name: "gifos-mcp" }`. That is enough for `meet-host.js`, which only checks that `assigned('tts')` is set. There is no `fileId` and no GIF. `call(role, req)` sends the request to the binding. The binding returns JSON. Speech comes back as base64 WAV, which the page turns into `{ bytes, mime: "audio/wav" }`. Text comes back as `{ text }`.

Which roles this process serves:

| Role | When |
|---|---|
| `tts` | Default. Kokoro (`kokoro-js`, q8 weights, voice `af_heart`) runs in this process. `installKokoro` downloads the weights and the voice into `GIFOS_MCP_HOME/kokoro` on first start. There is no manual step and no extra system package. `GIFOS_TTS_URL` is also served here: this process fetches the stand-in and returns the WAV. |
| `smartest` | `GIFOS_LLM_URL` or `GIFOS_LLM_KEY` is set, and `GIFOS_LLM_APP` is empty. This process posts one non-streaming chat completion. The page only sees `gifos-provider://smartest`. |
| `stt` | `GIFOS_STT_URL` is set and `GIFOS_STT_APP=none`. This process posts the audio bytes to that URL. The default Whisper app stays in the browser, because this process does not run Whisper. |

`GIFOS_TTS_APP` and `GIFOS_LLM_APP` install store providers and leave those roles off this path, so a synthetic provider in a test still runs inside GifOS. `GIFOS_TTS_ENGINE=none` does not serve speech.

Hosted roles are not written into `gifos_ai_config`. If an older profile still has a URL or a key on that row, the init script deletes the row. `setVoice` still names the role and still carries no URL and no key:

```js
tts: { provider: "tts", engine: "kokoro", app: "mcp-tts-kokoro", voice: "af_heart" }
```

`mcp-tts-kokoro` is a label in that object. It is not an installed app. On the page, a hosted `tts` row is stored as engine `kokoro` with no URL, so `host-voice.js` calls `opts.tts` instead of fetching `tts.url`. The public status still reports the real engine (`kokoro` or `http`).

### GifOS changes this does not require

No change in gifos-app or gifos-apps-source is required for the audio to flow.

- **gifos-app.** `meet-host.js` already calls `GifOS.providers.call('tts')` when `assigned('tts')` is set, and plays `{ bytes, mime }`. Keep provider CSP at `connect-src 'none'`. Do not add `capabilities.network` to a TTS provider. The optional small API, if the wrap should become a real call, is `GifOS.providers.serve(role, fn)` on the host page: it answers `call` and `assigned` without a GIF and without a network capability. Until that exists, the harness wraps those two methods.
- **gifos-apps-source.** Meeting Bot should keep speaking through the `tts` role and should not download Kokoro weights. `setVoice` already forwards `tts.app`. CONTROL.md should say the app id is whoever is assigned to `tts`, and the store Kokoro GIF is not required when this host answers the role. The app code does not need a change as long as it keeps forwarding `app` and `voice`.

Registration is `gifos.provider.serve({ tts: fn, smartest: fn, ... })` in the app. When the computer calls that role, the runtime mounts the GIF in a hidden sandboxed iframe and posts `{ ns: "gifos", type: "provider-request", role, req }`. The handler is keyed by role. It returns `{ text }` for chat and speech-to-text, or `{ bytes, mime }` for speech. The iframe's CSP is `connect-src 'none'`. The mount refuses every bridge call except the provider request, asset reads, and `info`.

Three checks, in `js/runtime.js`, decide whether that mount is allowed:

1. `provides.ai` lists the role.
2. The manifest does not declare `capabilities.network` or `capabilities.api`. A provider that could fetch would be an exfiltration path for every prompt, so the runtime refuses it. `wasm` and `gpu` are allowed. Kokoro uses both.
3. The icon sits directly in the Providers folder (`sys_providers`). Anywhere else the desktop paints a red ✕ and `GifOS.providers.call` refuses with `PROVIDER_NOT_IN_FOLDER`.

`GifOS.providers` on the host page is the whole program-facing surface today:

| Call | What it does |
|---|---|
| `scan()` | Provider apps whose icons are in `sys_providers`. |
| `assigned(role)` | The stored `{ app, appId, appName }`, or null. An endpoint row has no `app`, so this returns null. |
| `assign(role, { fileId, appId, name })` | Writes the provider-app row. This is what Settings writes when the picker chooses an app. |
| `install(slug)` | Downloads `/apps/<slug>/app.json` and the GIF, checks the catalog sha256, checks the signature when the listing claims one, enforces the two manifest rules, and files the icon into Providers. |
| `call(role, req)` | Runs the assigned app. |
| `stop(role)` | Unloads it. |

`install` only accepts a store slug. It has no argument for files this program composed.

## How a provider is packaged and signed

`GifOS.gif.encode(files, { accent })` packs `manifest.json`, `index.html`, and the rest into an App GIF. That is the same encoder the desktop uses when someone drops a zip or pastes HTML (`createAppFromFiles` in `js/desktop.js`).

A signature is a `GIFOSSIG` extension block (`js/gifos-sign.js`). It is authorship, the way DKIM is authorship. It is not an install permission.

- Domain identity: Ed25519. The public key is fetched from `https://<domain>/gifos.key`. `GifOS.sign.signDomain` writes the block. The statement covers the picture and every file except `.state/`, `.lock/`, and hash-pinned `.assets/` entries.
- Email identity: a detached OpenPGP signature, checked against keys.openpgp.org.
- Stripping the block leaves a working unsigned app. Changing a signed file makes verification report `tampered`.

The store checks a signature only when the listing's `app.json` has a `signature` field, and it checks `sha256` against the catalog bytes. A listing with no signature still installs. A GIF dropped on the Home Screen is not checked against the catalog at all. Unsigned dropped apps run.

Default store apps that the Home Screen seeds by itself (Whisper, today) are a tighter list: the comment in `js/gifos-install.js` says to add one only when gifos.app has signed it.

## How a provider gets into the Providers folder

Two supported arrivals land directly in `sys_providers`:

1. **Store install.** The store page, `GifOS.providers.install(slug)`, and the lazy seed. After the download is verified, `handlePlaceParam` in `js/desktop.js` (and `installProvider` in `js/runtime.js`) sees `provides.ai` and sets the icon's parent to `sys_providers`.
2. **The person already has the file.** There is no second writer.

A drop, and `createAppFromFiles`, set the icon's parent to whatever folder is open. A provider dropped on the Home Screen shows the red ✕ until a person drags it into Providers. `createAppFromFiles` is inside the desktop closure. It is not on `GifOS`.

Settings assigns only after that. The picker lists apps `scan()` found in the folder. Choosing one calls `assign`. Choosing "your own address and key" writes `{ url, key, model }` and does not create a GIF.

## An endpoint is not a provider app

An OpenAI-compatible URL is the endpoint row. The broker in `js/runtime.js` (`brokerAI`) reads `gifos_ai_config`, attaches the key, and fetches from the host page. A provider app cannot do that job. The sandbox cannot fetch, and a manifest that declared network access would be refused at install and again at `call`. BitNet's own manifest says the usable assistant is a hosted endpoint on the Settings row, and the offline GIF is the on-device alternative.

So "a provider that wraps an OpenAI-compatible endpoint" does not exist in this model. The endpoint row is the wrap. The GIF form is for an engine that runs on the computer, such as Kokoro.

## What gifos-mcp can do today

This server can install a slug the store already lists (`offline-stt-whisper`, or `GIFOS_TTS_APP` / `GIFOS_STT_APP` / `GIFOS_LLM_APP`) and call `assign`. Kokoro is not one of those slugs. This process runs it and the host binding answers `tts`. A hosted `smartest` or `stt` endpoint is also answered here. The URL and the key are not written into `gifos_ai_config` for a role this process serves. That is host injection, not a published app and not a GIF this program composed.

Kokoro's first spoken line waits on the weight download in this process, into `GIFOS_MCP_HOME/kokoro`. Later lines use the files already there.

## What is missing

Hosting `tts`, `stt`, and `smartest` does not need a new GifOS call. This process wraps `assigned` and `call` because it embeds the page. The gap below is only for an outside program that wants to file a GIF it composed.

There is no supported call that lets an outside program hand GifOS a provider it composed and have that provider filed into `sys_providers`.

`GifOS.providers.install` requires a catalog listing on the GifOS origin. gifos-mcp cannot publish one to gifos.app. `assign` requires a `fileId` that is already in the folder. `createAppFromFiles` builds a GIF from files, then leaves it in the open folder, and a program cannot call it. Writing `store.putFile` and an item row from the driver would skip both the store checks and the desktop's own create path. This server does not do that.

The smallest change is one function beside `install`, in `js/runtime.js`, reusing the folder filing `installProvider` already has:

```js
GifOS.providers.place(files) -> Promise<{ fileId, appId, name, roles }>
```

`files` is the map `GifOS.gif.encode` already accepts (`manifest.json`, `index.html`, and anything else the app needs). `place` then:

1. Reads the manifest. `provides.ai` must be a non-empty list. `capabilities.network` and `capabilities.api` must be absent. Same refusal `fetchApp` already uses when `opts.provider` is set.
2. Encodes with `GifOS.gif.encode`. No catalog sha256, because the bytes were not in a catalog. A `GIFOSSIG` block is left intact if the caller signed the bytes first; an unsigned GIF is accepted, because a GIF dropped on the Home Screen is unsigned and still runs.
3. `store.putFile`, then the same `ensureProvidersFolder` and `putItem(..., parent: 'sys_providers')` path `installProvider` uses.
4. Returns the identity `assign` already takes. It does not assign. The caller calls `assign(role, { fileId, appId, name })`.

A second function, the same size, is the program form of the Settings endpoint fields. The panel writes them and nothing else does:

```js
GifOS.providers.configure(role, { url, key, model }) -> Promise<{ url, model }>
```

It writes `{ url, key, model }` for that role, omitting empty fields, the way `saveAi` in `js/desktop.js` does. The key stays in `gifos_ai_config`. The return value omits the key. `configure` is how gifos-mcp would register an OpenAI-compatible LLM, an HTTP speech stand-in, or an HTTP caption stand-in. `place` is how it would register an engine it actually authored, once that engine can serve the role without a network.

This server does not call `place` or `configure`. A hosted role never becomes a GIF, and the key never becomes a Settings field the page can read. `place` would still not let a GIF fetch Kokoro. Speech-to-text stays `install` plus `assign` for the signed store app, unless `GIFOS_STT_URL` is set with `GIFOS_STT_APP=none`, in which case this process serves `stt`. `MeetingBot.setVoice` keeps naming the roles.

`MeetingBot.setVoice` (contract version 2) receives two switches and nothing else:

```js
MeetingBot.setVoice({
  respond_to_command: true, // answer "Hey bot" commands it hears
  speak: true               // false when conversation_voice is "none"
})
```

Meet Bot v2 starts with both switches off and refuses the version 1 fields (`conversation_voice`, `llm`, `tts`, `stt`). It speaks with the host's Smartest and Text to speech roles, which this process registers and answers. `start_meeting`, `join_meeting` and `set_voice` hand the switches again on every join, so a restarted app does not stay quiet. `status.voice.handed` is true once the app takes them; a refusal is reported as `status.voice.gap`. The object never carries a URL, a model or a key.

The published host (`js/host-voice.js` on gifos-app `cursor/meetbot-host-ops`) still stores a raw URL and fetches it from the host page. Meeting Bot v2 (`gifos-apps-source` `cursor/meetbot-voice-control`) copies `llm.url`, `llm.model`, and `llm.key` into the host and drops any other field. The driver adds an init script on the GifOS host page that wraps `HostVoice` after `host-voice.js` assigns it, and that wraps `GifOS.providers` for the roles this process serves:

- A hosted `smartest` becomes `gifos-provider://smartest` with no key. The wrapped fetch calls `GifOS.providers.call`, which the binding answers. The reply is one server-sent-event chunk. The page does not post the chat completion.
- A hosted `tts` is stored as engine `kokoro` with no URL, so speech goes through `providers.call('tts')` and the binding, not through `fetch(tts.url)`.
- A store provider app stays on the original `call`. It becomes `gifos-provider://<role>` (no key). The synthetic apps used in the browser test take this path.
- An https page never fetches an http URL itself. A call the page still makes goes to `https://cors-proxy.gifos.app/` with header `x-gifos-target`. An https endpoint is fetched directly. An http page talking to localhost stays direct. Hosted roles do not take this path, so their key does not transit the proxy.

The init script does not contain a model client. `src/voice/host.js` is the client, and it runs in this process.

## Voice settings to hand over

Meet Bot is specified to have two switches. gifos-mcp only stores them and passes them in. It does not act on them.

| Switch | Values | Env on this server |
|---|---|---|
| Respond to commands | on or off | `GIFOS_RESPOND_TO_COMMAND` (`0` off, anything else on) |
| Conversation voice | `none`, `grok` (Grok Voice), `local` (local LLM, then Kokoro) | `GIFOS_CONVERSATION_VOICE`. If unset: `local` when `GIFOS_LLM_KEY` or `GIFOS_LLM_URL` is set, otherwise `none`. `GIFOS_VOICE=0` forces `none`. |

Local LLM settings, suggested default xAI Grok:

| Field | Env | Suggested value |
|---|---|---|
| OpenAI-compatible base URL | `GIFOS_LLM_URL` | `https://api.x.ai/v1` when a key is set and the URL is empty |
| Model | `GIFOS_LLM_MODEL` | `grok-4.20-0309-non-reasoning` on that host. Set it yourself for any other host. |
| Key | `GIFOS_LLM_KEY` | No default. The user's own key. |

The chat call this process makes for a hosted `smartest` is one `POST {url}/chat/completions` with `model`, `messages`, and `stream: false`. No tools and no function calls. The key travels only as `Authorization: Bearer`, and only from this process. The page sees one chunk of the reply. Grok Voice (`"grok"`) is Meet Bot's own speech path. Kokoro is the default text-to-speech voice and it runs in this process, voice `af_heart`. `GIFOS_TTS_APP` names a store provider instead. `GIFOS_TTS_URL` is an HTTP stand-in this process fetches. `setVoice` says `{ provider: "tts", engine: "http" }` and does not include the URL. `GIFOS_TTS_ENGINE=none` turns speech off. This server does not run Piper.

The key is not logged and not written into a tool result. A missing `setVoice` is reported as a gap. The page is left untouched.

Spoken `say` from the assistant, distinct from chat `share_content`:

```js
MeetingBot.interject(meetingId, text) // Promise<{ id, spoken: true }>
```

That line is the assistant cutting in. Meet Bot speaks it and it takes priority over conversation voice. This server returns WAV only when Meet Bot asks the `tts` provider. It does not play the audio.

`set_voice` on the MCP side only changes the two switches. The URL, model, key, Kokoro choice, and speech or caption stand-ins always come from the environment, so a tool call cannot carry the key. Tool results name the engine (`kokoro`, `http`, or `none`) and, for Kokoro, the voice. They do not include `llm.url`, `llm.key`, `tts.url`, or `stt.url`.

| Env | Effect on the object above |
|---|---|
| `GIFOS_TTS_ENGINE` | `auto` or `kokoro` (the default) runs Kokoro in this process and the host binding answers `tts`. `none` does not serve speech and wins over `GIFOS_TTS_URL`. Any other value is refused. |
| `GIFOS_TTS_APP` | A store provider app for `tts`, instead of Kokoro in this process. The host binding leaves `tts` alone. |
| `GIFOS_TTS_VOICE` | Replaces `af_heart` when the engine is Kokoro. |
| `GIFOS_TTS_URL` | An HTTP speech stand-in. This process fetches it when Meet Bot asks `tts`. `setVoice` says `{ provider: "tts", engine: "http" }` and does not include the URL. The URL is not written into Settings. |
| `GIFOS_STT_URL` | An HTTP caption stand-in, served by this process, and only when `GIFOS_STT_APP=none`. `setVoice` says `{ provider: "stt" }` and does not include the URL. The default Whisper app stays a store install. |
| `GIFOS_LLM_APP` | A store provider app assigned to `smartest`, instead of this process calling an OpenAI-compatible URL. Conversation voice `local` does not then require a URL. |

## Decisions

- **Conversation text role is `smartest`.** Settings also has `cheapest`, which is what BitNet, Gemma, and Gemma 4 provide. Meet Bot's conversation uses `smartest` only. This server does not assign `cheapest`.
- **Meeting control is a declared GifOS capability.** Hand, microphone, camera, and the rest of in-room control are built by the gifos-apps-source agent, on Meeting Bot. This repository does not declare that capability and does not implement it. `raise_hand`, `set_mic`, `set_camera`, `get_meeting_state`, and `snapshot` only forward `window.MeetingBot`. When the method is missing they report the gap and leave the meeting as it is.

## Questions still open

1. Decided. An OpenAI-compatible URL is not a `configure` row when this process hosts `smartest`. The key stays here. `configure` would put it in the page.
2. Decided. `place` is not how this host adds `tts`, `stt`, or `smartest`. A placed GIF cannot reach this process. The binding is the injection.
3. Decided. This server does not install the Kokoro store slug. It runs Kokoro. Whisper stays the store app unless `GIFOS_STT_URL` is set with `GIFOS_STT_APP=none`.
4. Still open for a future `place`, which this server does not call. A dropped GIF runs unsigned. A seeded default must be signed by gifos.app.
5. Hosted roles do not use the proxy, so their key does not transit it. A call the page still makes sends an http endpoint through `https://cors-proxy.gifos.app` when the page is https. An https endpoint is fetched directly. May an http endpoint's key transit that proxy when the role is not hosted?
6. CONTROL.md v2 still documents raw URLs on `setVoice`, and `meet-host.js` still pushes an STT URL into the session. Should `cursor/meetbot-host-ops` read `gifos_ai_config` itself?
7. The first `say` after a fresh install waits on Kokoro's weight download in this process (`GIFOS_MCP_HOME/kokoro`), not on a provider GIF. Later starts reuse the files. Is that the expected pause?

## Gaps Meet Bot must gain

Contract v1 does not have these. Until it does, `set_voice` and `say` report the gap and do not imitate the feature.

1. **`window.MeetingBot.setVoice(settings)`** as specified above. Reject unknown `conversation_voice` values. Do not echo `llm.key` in the resolved value or in `status()`.
2. **`window.MeetingBot.interject(id, text)`** for a spoken line from the assistant. `say` stays chat.
3. **Respond-to-commands switch.** When on, a command heard in the room is answered by Meet Bot. When off, conversation may continue but commands get no spoken reply. gifos-mcp does not decide what a command is.
4. **Conversation voice `none`.** Meet Bot stays quiet. Transcription can still be on.
5. **Conversation voice `grok`.** Grok Voice, inside the meeting page Meet Bot already hosts. Not a socket from this Node process.
6. **Conversation voice `local`.** Meet Bot asks `smartest`, then speaks with the `tts` role. When this process hosts those roles, it performs the chat call and returns the WAV. The app frame still must not `fetch` (`connect-src 'none'`). The reply today is one chunk, not a token stream, so the first audio does not start mid-sentence. Playback stays in the meeting page Meet Bot already hosts.
7. **Do not write the bot's own voice into the transcript.** v1 already refuses the bot machine's microphone. Spoken voice has to keep that property, or the model will answer itself.
8. **Optional: push new transcript lines.** v1 only returns `transcript(id)` when asked. This server polls that. A `meet-event` of type `transcript` would remove the poll. It is not required for the handoff.
9. **`raiseHand(id, on)`**, **`setMic(id, on)`**, **`setCamera(id, on)`**. These are the meeting-control capability, built in gifos-apps-source, not here. v1 has no hand, microphone, or camera. Until these exist, the matching tool reports the gap and does not click the meeting page.
10. **`meetingState(id)`** returning `{ hand, mic, camera }` (and people, if the app already has them). Same capability. v1 `people(id)` still answers who is in the room.
11. **`snapshot(id)`**. Same capability, optional. This server also saves a PNG of the Meet Bot page it already has open. It does not open a second browser to take the picture.

No other voice stack should be added to gifos-mcp to paper over these gaps.

## What this branch removed

Compared with `cc-mcp-participant`, this branch deletes the second participant and the voice pipeline that played into the meeting. That removal is the design: Meet Bot is the only participant. This process answers provider calls. It does not play audio into the meeting.

Kept, because they are management rather than participation: meeting links, `send_chat`, `raise_hand`, `set_mic`, `set_camera`, `get_meeting_state`, `snapshot`, and `leave_meeting`. `create_meeting` still mints the link. Its plain-link invite (`invite_email`, `invite_calendar`, room password beside the link) was deleted in the same pass and is restored. It was not part of the voice stack.

Dropped on purpose, and not restored:

| Area | What it was |
|---|---|
| `src/participant/`, `test/participant/`, `docs/PARTICIPANT.md` | A second browser that joined as its own tile, with its own microphone. |
| `join_meeting_as_participant`, `get_new_utterances` | The tools for that second tile. |
| `src/audio/`, `src/providers/`, `src/voice/sidecar.py`, `src/voice/client.js`, `src/transcript/lanes.js`, `scripts/stt-bench.js` | In-process speech-to-text, text-to-speech, the chat model, and the Python sidecar. |
| `src/admin/` | The `gb1` controller that drove Meet Bot from a second copy of the app. This server calls `window.MeetingBot` instead. |
| `set_switches`, `stop_speaking` | Switches and barge-in for the voice pipeline this process no longer runs. `set_voice` is the handoff. Stopping speech belongs to the meeting-control capability. |
| `docs/PROVIDERS.md`, `docs/STT-BENCH.md` | The old "this process is the provider machine" notes. |
| `publicView` fields `mode` and `display_name` | Those marked a participant session. This server has no participant sessions. |

`room_password` stays on the meeting record and on tool results, as its own field. It is not put back into the link.

## Non-voice tools

These ride the same `window.MeetingBot` call. They do not open a participant browser, and they do not speak. Hand, microphone, camera, and snapshot of the room wait on the meeting-control capability. Until that capability lands, the tool reports the gap.

| Tool | Meeting Bot | When the method is missing |
|---|---|---|
| `send_chat` | `say(id, text)` — chat, the same call as `share_content` | v1 has `say`. |
| `leave_meeting` | `end(id)`. The transcript is saved first. Same result as `end_meeting`. | v1 has `end`. |
| `get_meeting_state` | `people(id)`, then `meetingState(id)` when it exists | People come from v1. Hand, microphone, and camera are a gap. |
| `raise_hand` | `raiseHand(id, on)` | Gap. The hand is left as it is. |
| `set_mic` | `setMic(id, on)` | Gap. v1 says the bot has no microphone. |
| `set_camera` | `setCamera(id, on)` | Gap. v1 says the bot has no camera. |
| `snapshot` | `snapshot(id)` when it exists, plus a PNG of the Meet Bot page | The PNG is still saved from the page this server already runs. The missing method is reported. The meeting is not changed. |
