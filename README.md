> **Fork** of the official Telegram channel plugin for Claude Code
> (`anthropics/claude-plugins-official`, `external_plugins/telegram` v0.0.7,
> Apache-2.0, see [NOTICE](./NOTICE)). What it adds:
>
> * **Topics → sessions.** An optional manager process gives every topic of
>   the bot DM its own Claude Code session with its own context and working
>   folder (`/new <name>`, `/sessions`, `/stop`).
> * **Voice.** Voice notes and audio files are transcribed with Yandex
>   SpeechKit STT v3 before they reach Claude.
> * **Live drafts.** "Thinking…" while Claude works, a `stream_reply` tool for
>   progressive answers (`sendMessageDraft`), then a normal message.
>
> Without the manager and without topics it behaves like upstream. Design and
> limitations: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md). Changes:
> [CHANGELOG.md](./CHANGELOG.md).

# Telegram

Connect a Telegram bot to your Claude Code with an MCP server.

The MCP server logs into Telegram as a bot and provides tools to Claude to reply, react, or edit messages. When you message the bot, the server forwards the message to your Claude Code session.

There are two ways to run it:

| | Single session (upstream mode) | Topic manager (this fork) |
| --- | --- | --- |
| Who polls Telegram | the plugin inside your `claude` session | `manager.ts`, a long-lived process |
| Sessions | the one you started | one per topic, started on demand in tmux |
| Start | `claude --dangerously-load-development-channels plugin:telegram@titimiti-telegram` | `bun manager.ts` (or the systemd unit) |
| Topics | replies go back to the topic a message came from | each topic = separate session + folder |

Both use the same `access.json`, pairing and allowlist. Don't run both on one
bot token at the same time — Telegram allows a single poller (a plugin session
started while the manager runs goes idle by itself).

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.
- For voice: `ffmpeg` (audio files other than voice notes are converted) and a Yandex Cloud service-account API key with the `yc.ai.speechkitStt.execute` scope.
- For the topic manager: `tmux`, and a bot with topics enabled in private chats (@BotFather → Bot Settings → Topics). Check with `getMe`: `has_topics_enabled: true`.

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | both | Bot token. Usually in `~/.claude/channels/telegram/.env` (written by `/telegram:configure`); the real environment wins. |
| `YANDEX_API_KEY` | both | SpeechKit API key. Unset → voice messages arrive untranscribed and the user is told once that voice isn't configured. Can live in the same `.env`. Never logged, never passed to sessions. |
| `YANDEX_LANGUAGE` | both | Recognition language, default `ru-RU`. |
| `TELEGRAM_STATE_DIR` | both | State dir, default `~/.claude/channels/telegram`. One per bot. Keep it short — the manager's unix socket lives there (~104-byte path limit). |
| `TELEGRAM_ACCESS_MODE` | both | `static` = read `access.json` once at start, never write it. |
| `TELEGRAM_WORKSPACE_ROOT` | manager | Overrides `workspaceRoot`. |
| `TELEGRAM_API_ROOT` | both | Bot API base URL (self-hosted Bot API server). Default `https://api.telegram.org`. |

## Quick Setup (single session)
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a bot with BotFather.**

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for two things:

- **Name** — the display name shown in chat headers (anything, can contain spaces)
- **Username** — a unique handle ending in `bot` (e.g. `my_assistant_bot`). This becomes your bot's link: `t.me/my_assistant_bot`.

BotFather replies with a token that looks like `123456789:AAHfiqksKZ8...` — that's the whole token, copy it including the leading number and colon.

**2. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

```
/plugin marketplace add TitiMiti/claude-telegram-channel
/plugin install telegram@titimiti-telegram
```

**3. Give the server the token.**

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

Writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence. Add `YANDEX_API_KEY=...` to the same file for voice.

> To run multiple bots on one machine (different tokens, separate allowlists), point `TELEGRAM_STATE_DIR` at a different directory per instance.

**4. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one. Claude Code only accepts channels from Anthropic's allowlist under `--channels`; a fork has to be loaded as a development channel (Claude Code asks you to confirm at start):

```sh
claude --dangerously-load-development-channels plugin:telegram@titimiti-telegram
```

(If your organization allowlists it via the `allowedChannelPlugins` managed setting, `claude --channels plugin:telegram@titimiti-telegram` works too.)

**5. Pair.**

With Claude Code running from the previous step, DM your bot on Telegram — it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with the channel flag. In your Claude Code session:

```
/telegram:access pair <code>
```

Your next DM reaches the assistant.

> Unlike Discord, there's no server invite step — Telegram bots accept DMs immediately. Pairing handles the user-ID lookup so you never touch numeric IDs.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/telegram:access policy allowlist` directly.

## Topic manager (one session per topic)

Pair first (steps 1–6 above, or put your numeric ID into `access.json` by
hand), then stop that single session — the manager takes over polling.

```sh
git clone https://github.com/TitiMiti/claude-telegram-channel ~/claude-telegram-channel
cd ~/claude-telegram-channel && bun install
bun manager.ts            # foreground; Ctrl-C to stop
```

As a service: [`contrib/claude-telegram-manager.service`](./contrib/claude-telegram-manager.service)
(systemd user unit; set `WorkingDirectory`, `HOME` and `PATH`, then
`systemctl --user enable --now claude-telegram-manager`).

In Telegram:

- `/new Website` — creates the topic "Website" and a Claude Code session in `~/workspace/Website` (an existing folder with that name, in any case, is reused).
- `/new Infra ~/servers/infra` — same, with an explicit folder.
- Topics you create in the Telegram app work too: the first message starts a session in `~/workspace/<topic name>`.
- Messages outside topics go to the `main` session in `~/workspace`.
- `/sessions` lists them, `/stop` stops this topic's session (the next message resumes the same conversation), `/restart` restarts it.

Sessions run in tmux on their own socket and survive manager restarts. To look
at one: `tmux -L claude-telegram attach -t tg-<chat id>-<topic id>` (the
manager posts this hint when a session needs you, e.g. to trust a new folder).
To stop all of them: `tmux -L claude-telegram kill-server`.

### `manager.json`

Optional, in the state dir. All keys optional — see
[`contrib/manager.example.json`](./contrib/manager.example.json).

| Key | Default | Meaning |
| --- | --- | --- |
| `workspaceRoot` | `~/workspace` | Parent folder for topic folders; cwd of the `main` session. |
| `claudeCommand` | `claude` | Claude Code executable (absolute path if not on the unit's `PATH`). |
| `claudeArgs` | `["--dangerously-skip-permissions"]` | Extra arguments for every session. Remove the flag to get permission prompts in Telegram (Allow/Deny buttons) instead. |
| `channel` | `server` | `server`: sessions load this checkout's `server.ts` via `--mcp-config`. Or an installed plugin, e.g. `plugin:telegram@titimiti-telegram`. |
| `autoConfirmDevChannels` | `true` | Press Enter on Claude Code's "Loading development channels" prompt. |
| `autoCreateSessions` | `true` | Start sessions for topics created in the Telegram app. |
| `mainSession` | `true` | Route messages outside topics to a session in `workspaceRoot`. |
| `tmuxSocket` | `claude-telegram` | `tmux -L` socket name. |
| `sessionEnv` | `{}` | Extra environment for sessions. |
| `queueLimit` | `50` | Messages kept per session while it starts. |

State: `topics.json` (topic → folder, tmux session, Claude session id),
`sessions/*.mcp.json`, `manager.sock`, `manager.pid` — all in the state dir.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist. Manager commands (`/new`, `/sessions`, `/stop`, `/restart`) only work for allowlisted users in DMs.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). In single-session mode, `message_thread_id` sends into a topic; topic sessions are pinned to their topic. |
| `stream_reply` | Live draft of the answer so far (DMs: `sendMessageDraft`; groups: one message edited in place). Call with the full text each time; `done: true` sends it as a normal message. |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |
| `download_attachment` | Fetch a file the user sent (documents, original voice/audio, video) into the inbox and return its path. |

Inbound messages trigger a typing indicator and, in DMs, Telegram's animated
"Thinking…" draft that stays until the reply (`thinkingDraft`, see ACCESS.md).
In topic sessions the draft has a stop button that interrupts Claude.

## Voice

Voice notes and audio files from allowlisted senders are transcribed with
Yandex SpeechKit STT v3 (async API, audio inline up to 10 MB) before they
reach Claude: the message text is the transcript and the `<channel>` tag has
`voice="true"`. Without `YANDEX_API_KEY` (or when recognition fails) Claude
gets `voice_error` instead, and the sender is told once that voice isn't
configured.

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the
local path is included in the `<channel>` notification so the assistant can
`Read` it. Telegram compresses photos — if you need the original file, send it
as a document instead (long-press → Send as File).

## No history or search

Telegram's Bot API exposes **neither** message history nor search. The bot
only sees messages as they arrive — no `fetch_messages` tool exists. If the
assistant needs earlier context, it will ask you to paste or summarize.

Attachments other than photos are fetched on demand with
`download_attachment` while Telegram still serves them (bots can download
files up to 20MB).

## Development

```sh
bun install
bun test        # unit tests + topic/manager end-to-end tests (need tmux)
```
