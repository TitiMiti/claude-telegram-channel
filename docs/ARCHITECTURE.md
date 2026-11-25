# Architecture

This fork adds three things to the upstream Telegram channel: one Claude Code
session per Telegram topic, built-in voice transcription, and live drafts
("streaming"). This document explains how they work and why they are built
this way.

## Upstream, in one paragraph

`server.ts` is an MCP server that Claude Code starts inside **one** session
(`claude --channels plugin:telegram@…`). It long-polls `getUpdates` itself,
gates every sender against `access.json`, pushes allowed messages into the
session as `notifications/claude/channel`, and exposes `reply` / `react` /
`edit_message` / `download_attachment` tools. Telegram allows exactly one
`getUpdates` consumer per bot token — a second poller gets `409 Conflict` — so
one bot means one session.

## Topics: one session per topic

Bot API 9.3/9.4 brought forum topics to private chats: messages carry
`message_thread_id`, bots can `createForumTopic`, and `getMe` reports
`has_topics_enabled`. We want each topic to be a separate Claude Code session
with its own context and working folder.

Since only one process may poll, polling moves out of the sessions into a
long-lived **manager**:

```
                 Telegram Bot API
                        │ getUpdates (the only poller)
                ┌───────┴────────┐
                │   manager.ts   │  access gate, pairing, commands,
                │                │  voice → text, drafts, topics.json
                └──┬──────┬───┬──┘
      unix socket  │      │   │   (state dir, 0700; per-session token)
   ┌───────────────┘      │   └───────────────┐
┌──┴───────────────┐ ┌────┴─────────────┐ ┌───┴──────────────┐
│ tmux: tg-42-101  │ │ tmux: tg-42-102  │ │ tmux: tg-42-main │
│ claude (cwd      │ │ claude (cwd      │ │ claude (cwd      │
│  ~/workspace/A)  │ │  ~/workspace/B)  │ │  ~/workspace)    │
│  └ server.ts     │ │  └ server.ts     │ │  └ server.ts     │
│    (topic mode)  │ │    (topic mode)  │ │    (topic mode)  │
└──────────────────┘ └──────────────────┘ └──────────────────┘
```

* **manager.ts** — polls, runs exactly the same gate as upstream (shared code
  in `lib/access.ts`), and routes every delivered message by
  `(chat_id, message_thread_id)` to the session for that topic, starting the
  session on demand. It executes all Telegram calls on the sessions' behalf.
* **server.ts in topic mode** — inside each session, started with
  `TELEGRAM_MANAGER_SOCKET` set. It never talks to Telegram: tool calls go to
  the manager over the socket, inbound messages and permission answers come
  back as channel notifications. The manager pins every call to the session's
  chat and topic (`Binding` in `lib/outbound.ts`), so a session can't post
  into another topic or chat even if asked to.
* **server.ts in single-session mode** — no socket, no manager: behaves as
  upstream (plus voice and drafts). Without topics nothing changes.

### Decisions

* **Separate process, same repo.** The manager is its own entry point
  (`manager.ts`) rather than a mode of the plugin's MCP server: it must
  outlive sessions, start them, and survive their restarts, which an MCP
  server owned by one session cannot do. Everything Telegram-facing is shared
  in `lib/`, so both modes have the same gate, tools and voice/draft code.
* **tmux for sessions.** Claude Code channels need an interactive session.
  tmux gives each one a terminal, lets the owner attach to watch it or answer
  a prompt (`tmux -L claude-telegram attach -t tg-<chat>-<thread>`), and keeps
  sessions alive when the manager restarts — their channels just reconnect.
  Sessions live on a dedicated tmux socket (`tmuxSocket`, default
  `claude-telegram`).
* **Channel via `--mcp-config` (default).** Each session gets
  `--mcp-config <state>/sessions/<name>.mcp.json` that runs *this checkout's*
  `server.ts`, so manager and channel are always the same version. Its env
  block carries the binding (`TELEGRAM_MANAGER_SOCKET`, session key, token).
  Alternative: `"channel": "plugin:telegram@titimiti-telegram"` in
  `manager.json` loads the installed plugin instead and passes the binding
  through the session environment.
* **`--dangerously-load-development-channels`.** Claude Code only accepts
  channels from Anthropic's allowlist (or an org's `allowedChannelPlugins`
  managed setting) under `--channels`; a fork is neither, so sessions use the
  development-channels flag. It shows a confirmation prompt at every start;
  the manager watches the tmux pane and presses Enter on that one prompt
  (`autoConfirmDevChannels`, default on). Other startup prompts — folder trust,
  first-time bypass-permissions consent — are **not** answered automatically;
  the manager posts an attach hint into the topic instead.
* **Idle plugin copy.** If the telegram plugin is also installed in that
  Claude config, its own server.ts starts in every session too. Sessions run
  with `TELEGRAM_MANAGED=1`, which makes that copy start idle (no tools, no
  polling). A plain `claude --channels plugin:telegram@…` started while a
  manager is running also goes idle instead of fighting it for `getUpdates`.
* **Same conversation across restarts.** The first launch passes
  `--session-id <uuid>`; later launches (after `/stop`, a crash, a reboot)
  pass `--resume <uuid>`. If resume fails right away, the manager starts a new
  conversation and says so in the topic.
* **Secrets stay in the manager.** The tmux server is started with the
  manager's environment minus `TELEGRAM_BOT_TOKEN` and `YANDEX_API_KEY`.
  Socket tokens live in `topics.json` / `sessions/*.mcp.json`, both `0600` in
  the `0700` state dir.

### Routing

| Message arrives in… | Goes to |
| --- | --- |
| a topic listed in `topics.json` | that topic's session (started if not running) |
| a topic the manager hasn't seen (created in the Telegram UI) | a new session in `<workspaceRoot>/<topic name>` (`autoCreateSessions`, default on); the name comes from the `forum_topic_created` service message |
| no topic (plain DM) | the `main` session in `workspaceRoot` (`mainSession`, default on) |

The key is `<chat_id>:<message_thread_id>` (or `<chat_id>:main`). Messages
that arrive while a session is starting are queued (`queueLimit`, default 50)
and flushed once its channel has finished the MCP handshake and no startup
prompt is on screen.

### Commands (allowlisted users, DMs only)

| Command | Effect |
| --- | --- |
| `/new <name> [folder]` | Create a topic and its session. Folder defaults to `<workspaceRoot>/<name>` (an existing folder with the same name in any case is reused); a last word starting with `/`, `~`, `./` or `../` is taken as the folder. |
| `/sessions` | List sessions with state and folder. |
| `/stop [name]` | Stop this topic's session (or the named one). The next message resumes it. |
| `/restart [name]` | Stop and start again (same conversation). |
| `/start`, `/help`, `/status` | As upstream. |

Pairing-pending users get none of these — only `/start`, `/help`, `/status`.

### State files (in `~/.claude/channels/telegram/`, or `TELEGRAM_STATE_DIR`)

| File | What |
| --- | --- |
| `access.json` | Shared with single-session mode, unchanged format (+2 optional keys). |
| `manager.json` | Optional manager config (see README). |
| `topics.json` | `key → {name, cwd, tmux, claudeSessionId, token, …}` |
| `sessions/*.mcp.json` | Per-session channel config. |
| `manager.sock`, `manager.pid` | Socket and single-instance guard. Keep the state dir path short: unix socket paths are limited to ~104 bytes. |

### Socket protocol (`lib/ipc.ts`)

Newline-delimited JSON. Session → manager: `hello {key, token}`, `ready`
(after the MCP handshake), `call {id, tool, args}`, `permission_request`.
Manager → session: `welcome {topic}`, `reject`, `result {id, ok, text}`,
`inbound {content, meta}`, `permission {request_id, behavior}`.

## Voice

Voice notes and audio files are transcribed where updates are received (the
manager, or server.ts in single-session mode), after the gate — nobody can
make us burn SpeechKit quota without being allowlisted.

* Yandex SpeechKit STT v3, asynchronous: `recognizeFileAsync` with the audio
  inline as base64 (≤ 10 MB), poll `operations/<id>`, read `getRecognition`
  (one JSON object per line; `finalRefinement` replaces its `final`), then
  `deleteRecognition`. Same flow as the owner's `stt.py`.
* Telegram voice notes are already OggOpus; other audio goes through `ffmpeg`
  first.
* Auth: `Authorization: Api-Key $YANDEX_API_KEY` (service-account key with
  `yc.ai.speechkitStt.execute`). Language: `YANDEX_LANGUAGE`, default `ru-RU`.
* Claude receives the transcript as the message text with `voice="true"`;
  attachment meta is kept, so the original file can still be downloaded.
* No key → the user gets a one-time notice in the chat ("voice recognition is
  not configured"), Claude gets the placeholder text plus `voice_error`.
  Failures are reported the same way. The key never appears in errors or logs.

## Streaming

`sendMessageDraft` (Bot API 9.3, all bots since 9.5) shows an ephemeral,
animated draft in a private chat. A draft lives ~30 s unless refreshed and
disappears when the bot sends a real message; a final `sendMessage` is always
what persists the answer.

**The honest limitation:** Claude Code does not stream model tokens to MCP
servers. A channel only sees finished tool calls — `reply` arrives with the
whole text at once. Token-by-token streaming of Claude's answer is therefore
not possible from a channel. What we do instead:

1. **Thinking draft** (`thinkingDraft`, default off). As soon as a message is
   delivered, the chat shows Telegram's "Thinking…" placeholder (draft with
   empty text) in the right topic, refreshed every 20 s until Claude replies
   (max 10 min). It replaces the 5-second typing indicator. In manager mode
   the draft has Telegram's stop button (Bot API 10.3 `can_stop`); pressing it
   sends Esc to that session's terminal, i.e. interrupts Claude.
2. **`stream_reply` tool.** Claude can push its answer-so-far as a live draft
   during long work (throttled to 1 update/s, kept alive, tail shown if over
   4096 chars) and finish with `done: true` or a normal `reply`. Real
   progressive output — but only as often as Claude chooses to call it.
   Outside DMs (no drafts in groups) it posts one message and edits it in
   place.
3. **Playback** (`streamReplies`, default off). Long finished replies are
   played into the draft in a few steps before being sent. Cosmetic; it delays
   the real message by ~1.5 s, hence off.

Plain `sendMessageDraft` is used, not `sendRichMessageDraft` (10.1): replies
are plain text or MarkdownV2, and MarkdownV2 escapes would render literally in
a half-finished draft, so formatting is applied only by the final message.
If the Bot API server doesn't know `sendMessageDraft`, drafts switch off for
the process lifetime after the first failure; nothing else is affected.

## What is verified and what isn't

`bun test` covers routing by `message_thread_id`, the state file, folder
naming, SpeechKit request/response handling (mocked HTTP) and ffmpeg
conversion, draft lifecycle and throttling, the outbound binding, the
socket protocol, server.ts in topic and idle modes over real stdio/socket, and
a manager end-to-end run against a fake Bot API server with a fake `claude` in
tmux (topics, auto-created topics, voice without a key, strangers dropped,
`/sessions`, `/stop`, resume).

Not verified against the real services: the real Telegram Bot API (topics in
DMs, drafts, the stop button), real Claude Code with
`--dangerously-load-development-channels server:telegram` + `--mcp-config`
(including how its startup prompts look on screen), and real SpeechKit.
