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

[Документация на русском](./README.ru.md)

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

## Installation, step by step

You need a Linux/macOS machine that stays on (a VPS is fine), [Bun](https://bun.sh),
`tmux`, `ffmpeg`, and [Claude Code](https://code.claude.com) (2.1.80+) logged in
(claude.ai subscription or Console API key; channels are a research preview).

1. **Create a bot** in [@BotFather](https://t.me/BotFather) (`/newbot`), copy the token.
   For topics: Bot Settings → Topics (Threaded Mode) → on.
2. **Install**
   ```sh
   git clone https://github.com/TitiMiti/claude-telegram-channel ~/claude-telegram-channel
   cd ~/claude-telegram-channel && bun install
   ```
3. **Put your secrets in `~/.claude/channels/telegram/.env`** (create the folder, `chmod 700` it and `chmod 600` the file):
   ```sh
   TELEGRAM_BOT_TOKEN=123456789:AAH...
   YANDEX_API_KEY=AQVN...          # optional, only for voice
   ```
4. **Get a Yandex SpeechKit key (for voice; skip it and voice notes just arrive untranscribed).**
   In [Yandex Cloud](https://console.yandex.cloud): create a billing account and a folder →
   Service accounts → create one (e.g. `tg-stt`) → open it → *Create new key* → **API key**,
   scope **`yc.ai.speechkitStt.execute`** (nothing else) → copy the key once (`AQVN...`).
   If your account asks for a role, grant `ai.speechkit-stt.user` on the folder (*Folder → Access bindings*).
   SpeechKit is billed per minute of audio; set a budget alert in the console.
5. **Allow yourself.** Write your numeric Telegram ID (ask [@userinfobot](https://t.me/userinfobot))
   into `~/.claude/channels/telegram/access.json`:
   ```json
   { "dmPolicy": "allowlist", "allowFrom": ["123456789"], "groups": {}, "pending": {} }
   ```
   (Or leave `dmPolicy: "pairing"` and approve the code the bot sends with `/telegram:access pair <code>`.)
6. **Run the topic manager** (one session per topic):
   ```sh
   bun manager.ts            # or the systemd unit in contrib/
   ```
   Then message the bot. `/new Website` makes a topic with its own Claude session.
   Sessions run in tmux (`tmux -L claude-telegram ls`); the first start in a new
   folder may need you to confirm "trust this folder" — the bot tells you how.

   Prefer a single session without topics? See *Quick Setup (single session)* below.

`manager.json` options (e.g. `claudeArgs`, workspace folder) are described in
*Topic manager* below. By default sessions get `--dangerously-skip-permissions`
only if you put it in `claudeArgs`: **decide that consciously**, see *Privacy and security*.

## Privacy and security

Read this before you point the bot at anything private.

- **Voice goes to a third party.** Every voice note or audio file from an allowlisted
  user is sent to Yandex Cloud SpeechKit and the transcript comes back. There is no
  end-to-end protection beyond HTTPS to Yandex's servers: Yandex receives the audio
  and the text. We do three things to limit it: only allowlisted senders are
  transcribed, the result is deleted on Yandex's side right after (`deleteRecognition`),
  and the request carries `x-data-logging-enabled: false` (asks Yandex not to keep
  the data for service improvement; whether that is honored is Yandex's side, not
  verifiable here). Don't dictate secrets. No key → nothing is sent anywhere.
- **Telegram itself.** Bot chats are not end-to-end encrypted: Telegram sees all
  messages, files and voice notes. Your replies from Claude pass through it too.
- **The bot is remote control of your machine.** Anyone who can message it (and
  anyone who gets into your Telegram account) can make Claude run commands as your
  user. Keep `dmPolicy` on `allowlist`/`pairing`, don't add groups casually, and run
  it as a separate OS user or in a container, not as your main account.
- **Prompt injection.** Text and files that reach Claude (messages, forwarded content,
  web pages it reads) can try to steer it. With `--dangerously-skip-permissions` nothing
  asks for confirmation. Use that only on a disposable machine with nothing valuable
  (no ssh keys to production, no cloud tokens, no payment access).
- **Secrets on disk.** The bot token and `YANDEX_API_KEY` live in `.env` (0600) in the state
  dir, never in the environment of Claude sessions and never logged. Use a Yandex key
  scoped to speech recognition only and set a spending limit.
- **Costs.** Claude usage (subscription limits or API tokens) and SpeechKit minutes are
  yours to watch; a runaway session can burn through them.

## Optional extras

### Telegram skills (recommended)

[serejaris/telegram-skills](https://github.com/serejaris/telegram-skills) (MIT) is a set of
Agent Skills that teach Claude the Telegram Bot API: rich messages and tables, streaming
replies, widgets, polls, Stars payments, Mini Apps, bot operations and a map of what a bot
can and cannot do. They are plain instructions (no hooks, no MCP servers; the helper
scripts only call `api.telegram.org`), and they are what Claude needs to use newer Bot API
features correctly. Install in the same Claude Code profile the sessions use:

```
/plugin marketplace add serejaris/telegram-skills
/plugin install telegram-skills@telegram-skills
```

(or `npx skills add serejaris/telegram-skills`). Sessions started by the topic manager use the
profile of the user/`HOME` the manager runs under, so install them there. The skills call the
Bot API directly with the bot token, so give the session `TELEGRAM_BOT_TOKEN` in its
`CLAUDE.md`/environment only if you accept that (this plugin deliberately keeps the token
out of sessions). Review any third-party skill before installing. Note: widgets (`sendWidget`)
are rolled out gradually and may be refused for your bot.

### Read all your chats (user account, not a bot)

A bot only sees messages sent to it: no history, no search, no other chats. To let Claude
read your whole Telegram (any chat, group or channel you see in the app, with history and
search) you need a **user-account** client over MTProto, not the Bot API. The usual way is a
Telethon-based MCP server added to the same Claude Code profile, for example
[chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp) (read-only mode and per-tool
switches), [jgalea/telegram-mcp](https://github.com/jgalea/telegram-mcp) (cached searchable
history), [Powellga/telegram-claude-link](https://github.com/Powellga/telegram-claude-link) or
[firepol-ai/telegram-mcp](https://github.com/firepol-ai/telegram-mcp) (hardened, read-only
option). Rough setup (we did not test these ourselves; follow each project's README):

1. Get `api_id` and `api_hash` at [my.telegram.org](https://my.telegram.org) → API development tools.
2. Install the server (on the same VPS) and log in once with your phone number, code and 2FA
   password; it stores a session string/file. Keep it `chmod 600`.
3. Register it: `claude mcp add ...` (see the project's README) in the profile your sessions use.
4. Prefer a **read-only** mode unless you really want Claude to write as you.

Know what you are giving away: the session is **full access to your account** (all chats,
secret-chat metadata excluded, contacts, sending messages as you). Anyone who gets the session
file or controls the Claude session can read everything and write in your name; a
prompt-injected message in any chat can try to steer the agent. Automating a user account is a
grey area in Telegram's terms: abuse (spam, mass actions) can get the account limited or banned.
Use it only for your own account, read-only when possible, and never on a shared machine.

## Run it on a VPS, not on your computer

The bot only works while the process runs. On a laptop it stops when the computer sleeps,
reboots or goes offline, and messages sent meanwhile are lost (Bot API keeps updates for a
limited time and Claude cannot read history). A small always-on VPS with the manager as a
systemd user unit (`loginctl enable-linger <user>` so it survives logouts and reboots) keeps the
bot answering 24/7. Use a separate OS user or container, because the sessions can run commands
on that machine.

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

### Install as a Claude Code plugin (single session, no topics)

If you don't need the topic manager, install the fork as a regular plugin from this repo's marketplace:

```
/plugin marketplace add TitiMiti/claude-telegram-channel
/plugin install telegram@titimiti-telegram
```

(or from a shell: `claude plugin marketplace add TitiMiti/claude-telegram-channel` and
`claude plugin install telegram@titimiti-telegram --scope user`). Then put the token in
`~/.claude/channels/telegram/.env` and your ID in `access.json` (steps 3 and 5 above) and start:

```sh
claude --dangerously-load-development-channels plugin:telegram@titimiti-telegram
```

The flag is needed because this fork is not on Anthropic's channel allowlist; Claude Code
asks to confirm on every start (on Team/Enterprise an admin can add the plugin to
`allowedChannelPlugins`). The topic manager does **not** need the plugin installed: it
loads the channel itself with `--mcp-config`.

**Do not enable the official `telegram@claude-plugins-official` at the same time**: both are
named `telegram` and both poll the bot, which gives `409 Conflict` and dropped messages.
Disable it with `claude plugin disable telegram@claude-plugins-official`.

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

Inbound messages trigger a typing indicator. Optionally (`thinkingDraft: true`, see
ACCESS.md) DMs also get Telegram's animated "Thinking…" draft until the reply; in
topic sessions that draft has a stop button that interrupts Claude. Off by default:
in practice drafts appear with delays and unevenly.

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
