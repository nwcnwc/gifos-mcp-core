# Invites

The servers never send mail and never write a calendar file. They return everything an invite needs; the
assistant that called the tool sends it through its own (or the user's) mail or calendar, after the user approves.

`meetingInvite()` (gifos-meet-mcp `create_meeting`) and `broadcastInvite()` (gifos-broadcast-mcp
`create_broadcast`) return:

| Field | What it is |
|---|---|
| `kind` | `meeting`, `town_hall`, `broadcast` or `stream` |
| `title` | The title |
| `start`, `end` | `{ iso, timezone, local }`, or `null` when no time was given. `end` defaults to start plus one hour. |
| `timezone` | The IANA zone the local times are written in |
| `join_url` / `watch_url` | The plain link. It never contains a password. |
| `visit_url` | Broadcasts: the Visit link painted on the picture |
| `description` | The agenda or notes as given |
| `admit` | How people get in: `link`, or `password` with the `room_password` guests type |
| `roles` | Who does what: the host (with their own host password, never sent), guests or viewers, early and late viewers, and that the room is written down (📝 Transcribing) |
| `text` | A ready-to-send invite body with all of the above |
| `calendar` | `summary`, `description`, `location` and `url` for a calendar connector |

The host password, the bot password and the seed of the host key are never in any of these.

Paid one-click links that would open the room with the password already applied are not part of this release.
