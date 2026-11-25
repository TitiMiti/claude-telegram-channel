# Changelog

## 0.1.1 — 2026-11-25

### Changed
- The "Thinking…" draft (`thinkingDraft`) is now **off by default**: drafts showed up
  late and unevenly. Opt in with `"thinkingDraft": true` in `access.json`.
- Voice: audio is sent to SpeechKit with `x-data-logging-enabled: false` (asks Yandex
  not to keep it for service improvement). `YANDEX_DATA_LOGGING=1` turns that off.

## 0.1.0 — 2026-11-25

First fork release on top of upstream v0.0.7.

### Added
- **Topic manager** (`manager.ts`): one long-lived poller that routes messages
  by `message_thread_id` to one Claude Code session per topic (tmux, own
  working folder, same conversation across restarts via `--session-id` /
  `--resume`). Commands `/new <name> [folder]`, `/sessions`, `/stop [name]`,
  `/restart [name]`. Topics created in the Telegram app get sessions on the
  first message; messages outside topics go to a `main` session. Config in
  `manager.json`, state in `topics.json`. systemd user unit in `contrib/`.
- `server.ts` topic mode (`TELEGRAM_MANAGER_SOCKET`): the session's channel
  relays tools and notifications through the manager's unix socket; idle mode
  (`TELEGRAM_MANAGED=1`, or a running manager) so a second copy never polls.
- **Voice**: voice notes and audio are transcribed with Yandex SpeechKit STT
  v3 (`YANDEX_API_KEY`, `YANDEX_LANGUAGE`, default `ru-RU`); Claude gets the
  text with `voice="true"`, or `voice_error`.
- **Drafts**: animated "Thinking…" draft in DMs until the reply
  (`thinkingDraft`, default on; stop button interrupts the session in manager
  mode), `stream_reply` tool for progressive answers, optional cosmetic
  playback of long replies (`streamReplies`, default off).
- Single-session mode: inbound `message_thread_id` meta and a
  `message_thread_id` parameter on `reply` / `stream_reply`, so answers land
  in the topic they came from.
- `TELEGRAM_API_ROOT` for self-hosted Bot API servers.
- Tests (`bun test`), docs/ARCHITECTURE.md.

### Changed
- Code split into `lib/` modules shared by both modes; behavior of the
  upstream single-session mode is unchanged apart from the additions above.
- grammy ≥ 1.41 (Bot API 9.3+ types: `sendMessageDraft`, topics in DMs).
- Plugin version 0.1.0; installation via
  `/plugin marketplace add TitiMiti/claude-telegram-channel` and
  `/plugin install telegram@titimiti-telegram`.
