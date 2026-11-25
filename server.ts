#!/usr/bin/env bun
/**
 * Telegram channel for Claude Code.
 *
 * Self-contained MCP server with full access control: pairing, allowlists,
 * group support with mention-triggering. State lives in
 * ~/.claude/channels/telegram/access.json — managed by the /telegram:access skill.
 *
 * Telegram's Bot API has no history or search. Reply-only tools.
 *
 * Three ways this process runs:
 *   • single-session (default, as upstream) — polls Telegram itself and
 *     serves the one Claude Code session that started it;
 *   • topic session — TELEGRAM_MANAGER_SOCKET is set: the session was
 *     started by manager.ts for one Telegram topic; tools and inbound go
 *     through the manager (see docs/ARCHITECTURE.md);
 *   • idle — TELEGRAM_MANAGED=1 without a socket (the plugin copy inside a
 *     manager-started session), or a manager is already polling this token:
 *     no tools, no polling, so we never fight the manager for getUpdates.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Bot } from 'grammy'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import {
  STATE_DIR, ENV_FILE, INBOX_DIR, PID_FILE, APPROVED_DIR, MANAGER_PID_FILE, loadEnvFile, apiRoot, log as logTo,
} from './lib/env.ts'
import { createAccessStore } from './lib/access.ts'
import { DraftManager } from './lib/drafts.ts'
import { createOutbound, toolDefs } from './lib/outbound.ts'
import { registerInbound } from './lib/inbound.ts'
import { createPermissions } from './lib/permissions.ts'
import { registerBasicCommands, checkApprovals } from './lib/commands.ts'
import { createChannelServer, PermissionRequestNotification, onStdinClose } from './lib/mcp.ts'
import { runPolling } from './lib/poll.ts'
import { runTopicClient } from './lib/client.ts'

const log = (msg: string) => logTo('telegram channel', msg)

// Last-resort safety net — without these the process dies silently on any
// unhandled promise rejection. With them it logs and keeps serving tools.
process.on('unhandledRejection', err => {
  log(`unhandled rejection: ${err}`)
})
process.on('uncaughtException', err => {
  log(`uncaught exception: ${err}`)
})

/** Is manager.ts polling this bot token right now? */
function managerRunning(): boolean {
  try {
    const pid = parseInt(readFileSync(MANAGER_PID_FILE, 'utf8'), 10)
    if (!(pid > 1)) return false
    process.kill(pid, 0)
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return cmd.includes('manager.ts')
  } catch {
    return false
  }
}

if (process.env.TELEGRAM_MANAGER_SOCKET) {
  await runTopicClient({
    socketPath: process.env.TELEGRAM_MANAGER_SOCKET,
    key: process.env.TELEGRAM_SESSION_KEY ?? '',
    token: process.env.TELEGRAM_SESSION_TOKEN ?? '',
    log,
  })
} else if (process.env.TELEGRAM_MANAGED === '1' || managerRunning()) {
  await runIdle()
} else {
  await runSingleSession()
}

// A connected MCP server with no tools. Exiting instead would show up as a
// failed MCP server in Claude Code.
async function runIdle(): Promise<void> {
  log(
    process.env.TELEGRAM_MANAGED === '1'
      ? 'idle — this session was started by the topic manager, which provides the channel'
      : 'idle — the topic manager (manager.ts) is polling this bot; start sessions from Telegram with /new',
  )
  const mcp = new Server({ name: 'telegram', version: '1.0.0' }, { capabilities: { tools: {} } })
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
  await mcp.connect(new StdioServerTransport())
  onStdinClose(() => process.exit(0))
}

async function runSingleSession(): Promise<void> {
  loadEnvFile()

  const TOKEN = process.env.TELEGRAM_BOT_TOKEN
  const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'

  if (!TOKEN) {
    process.stderr.write(
      `telegram channel: TELEGRAM_BOT_TOKEN required\n` +
      `  set in ${ENV_FILE}\n` +
      `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
    )
    process.exit(1)
  }

  // Telegram allows exactly one getUpdates consumer per token. If a previous
  // session crashed (SIGKILL, terminal closed) its server.ts grandchild can
  // survive as an orphan and hold the slot forever, so every new session sees
  // 409 Conflict. Kill any stale holder before we start polling.
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  try {
    const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
    if (stale > 1 && stale !== process.pid) {
      process.kill(stale, 0)
      // PID files race with OS PID recycling — verify the holder is actually a
      // server.ts process before SIGTERM. Otherwise a recycled PID can point at
      // our own bun-run wrapper (kills our stdin → immediate self-shutdown) or
      // an unrelated user process.
      const cmd = execFileSync('ps', ['-p', String(stale), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      if (cmd.includes('server.ts')) {
        log(`replacing stale poller pid=${stale}`)
        process.kill(stale, 'SIGTERM')
      }
    }
  } catch {}
  writeFileSync(PID_FILE, String(process.pid))

  const bot = new Bot(TOKEN, { client: { apiRoot: apiRoot() } })
  let botUsername = ''

  const access = createAccessStore({ stateDir: STATE_DIR, isStatic: STATIC, botUsername: () => botUsername, log })
  const drafts = new DraftManager(
    { sendMessageDraft: (c, d, t, o) => bot.api.sendMessageDraft(c, d, t, o as never) },
    { log },
  )
  const outbound = createOutbound({ api: bot.api, token: TOKEN, access, drafts, inboxDir: INBOX_DIR, apiRoot: apiRoot() })

  if (!STATIC) setInterval(() => checkApprovals(bot, APPROVED_DIR, log), 5000).unref()

  const mcp = createChannelServer('single')

  const permissions = createPermissions({
    bot,
    access,
    log,
    onDecision: (request_id, behavior) => {
      void mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id, behavior },
      })
    },
  })

  // Receive permission_request from CC → format → send to all allowlisted DMs.
  // Groups are intentionally excluded — the security thread resolution was
  // "single-user mode for official plugins." Anyone in access.allowFrom
  // already passed explicit pairing; group members haven't.
  mcp.setNotificationHandler(PermissionRequestNotification, async ({ params }) => {
    permissions.request(params, access.loadAccess().allowFrom.map(chatId => ({ chatId })))
  })

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefs('single') }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    try {
      const text = await outbound.call(req.params.name, args)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
        isError: true,
      }
    }
  })

  await mcp.connect(new StdioServerTransport())

  // When Claude Code closes the MCP connection, stdin gets EOF. Without this
  // the bot keeps polling forever as a zombie, holding the token and blocking
  // the next session with 409 Conflict.
  let shuttingDown = false
  onStdinClose(() => {
    if (shuttingDown) return
    shuttingDown = true
    log('shutting down')
    try {
      if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) rmSync(PID_FILE)
    } catch {}
    // bot.stop() signals the poll loop to end; the current getUpdates request
    // may take up to its long-poll timeout to return. Force-exit after 2s.
    setTimeout(() => process.exit(0), 2000)
    void Promise.resolve(bot.stop()).finally(() => process.exit(0))
  })

  registerBasicCommands(bot, access)

  registerInbound({
    bot,
    access,
    drafts,
    outbound,
    inboxDir: INBOX_DIR,
    log,
    onPermissionReply: ({ request_id, behavior }) => {
      void mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id, behavior },
      })
    },
    deliver: ({ content, meta, threadId }) => {
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: { ...meta, ...(threadId != null ? { message_thread_id: String(threadId) } : {}) },
        },
      }).catch(err => {
        log(`failed to deliver inbound to Claude: ${err}`)
      })
    },
  })

  // Without this, any throw in a message handler stops polling permanently
  // (grammy's default error handler calls bot.stop() and rethrows).
  bot.catch(err => {
    log(`handler error (polling continues): ${err.error}`)
  })

  void runPolling(bot, {
    log,
    max409: 8,
    shuttingDown: () => shuttingDown,
    onStart: info => {
      botUsername = info.username
      log(`polling as @${info.username}`)
      void bot.api.setMyCommands(
        [
          { command: 'start', description: 'Welcome and setup guide' },
          { command: 'help', description: 'What this bot can do' },
          { command: 'status', description: 'Check your pairing status' },
        ],
        { scope: { type: 'all_private_chats' } },
      ).catch(() => {})
    },
  })
}
