#!/usr/bin/env bun
/**
 * Topic manager: one long-lived process that polls the bot and gives every
 * Telegram topic of the DM its own Claude Code session (own context, own
 * working folder). Sessions run in tmux and load this repo's server.ts as
 * their channel; the two talk over a unix socket. See docs/ARCHITECTURE.md.
 *
 *   bun manager.ts            # run in the foreground (or as a systemd user unit)
 *
 * Same access.json, same gate, same pairing as the single-session channel.
 */

import { Bot, type Context } from 'grammy'
import { createServer, type Socket } from 'net'
import { timingSafeEqual, randomUUID } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import {
  STATE_DIR, ENV_FILE, INBOX_DIR, APPROVED_DIR, MANAGER_SOCKET, MANAGER_PID_FILE,
  TOPICS_FILE, MANAGER_CONFIG_FILE, SESSIONS_DIR, loadEnvFile, apiRoot, log as logTo,
} from './lib/env.ts'
import { createAccessStore } from './lib/access.ts'
import { DraftManager } from './lib/drafts.ts'
import { createOutbound } from './lib/outbound.ts'
import { registerInbound, threadOf, type Inbound } from './lib/inbound.ts'
import { createPermissions } from './lib/permissions.ts'
import { registerBasicCommands, checkApprovals, threadOpt } from './lib/commands.ts'
import { runPolling } from './lib/poll.ts'
import { encode, LineDecoder, type ClientMessage, type ManagerMessage } from './lib/ipc.ts'
import {
  TopicStore, loadConfig, route, resolveCwd, parseNewCommand, newEntry, topicKey, type TopicEntry,
} from './lib/topics.ts'
import {
  Tmux, sessionEnv, mcpConfig, bindingEnv, usesPlugin, claudeArgs, detectPrompt, writeMcpConfig,
} from './lib/sessions.ts'

const log = (msg: string) => logTo('telegram manager', msg)

process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', err => log(`uncaught exception: ${err}`))

loadEnvFile()
const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'
if (!TOKEN) {
  process.stderr.write(
    `telegram manager: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

// One manager per state dir. Unlike server.ts we don't kill the other one —
// two managers would also fight over the socket, so refuse loudly.
try {
  const other = parseInt(readFileSync(MANAGER_PID_FILE, 'utf8'), 10)
  if (other > 1 && other !== process.pid) {
    process.kill(other, 0)
    const cmd = execFileSync('ps', ['-p', String(other), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (cmd.includes('manager.ts')) {
      log(`another manager is running (pid ${other}) — exiting`)
      process.exit(1)
    }
  }
} catch {}
writeFileSync(MANAGER_PID_FILE, String(process.pid))

const cfg = loadConfig(MANAGER_CONFIG_FILE)
const store = new TopicStore(TOPICS_FILE)
const tmux = new Tmux(cfg, sessionEnv(process.env, cfg.sessionEnv))
const SERVER_TS = join(import.meta.dir, 'server.ts')

const bot = new Bot(TOKEN, { client: { apiRoot: apiRoot() } })
let botUsername = ''
const access = createAccessStore({ stateDir: STATE_DIR, isStatic: STATIC, botUsername: () => botUsername, log })
const drafts = new DraftManager(
  { sendMessageDraft: (c, d, t, o) => bot.api.sendMessageDraft(c, d, t, o as never) },
  { log, canStop: true },
)
const outbound = createOutbound({ api: bot.api, token: TOKEN, access, drafts, inboxDir: INBOX_DIR, apiRoot: apiRoot() })

if (!STATIC) setInterval(() => checkApprovals(bot, APPROVED_DIR, log), 5000).unref()

// ---------------------------------------------------------------------------
// Sessions: connections, queues, startup

type Conn = { socket: Socket; key?: string; ready: boolean }
const conns = new Map<string, Conn>() // by topic key, authenticated only
const queues = new Map<string, Array<{ content: string; meta: Record<string, string> }>>()
// Keys whose startup watcher is running → its generation, so a relaunch's
// watcher isn't cancelled by the one it replaced.
const starting = new Map<string, number>()
let generation = 0
const topicNames = new Map<string, string>() // from forum_topic_created, until a session exists

function sendTo(key: string | undefined, msg: ManagerMessage): boolean {
  const c = key ? conns.get(key) : undefined
  if (!c || c.socket.destroyed) return false
  c.socket.write(encode(msg))
  return true
}

/** Tell the human something in the topic's own thread. */
function notify(entry: Pick<TopicEntry, 'chatId' | 'threadId'>, text: string): void {
  void bot.api.sendMessage(entry.chatId, text, threadOpt(entry.threadId)).catch(err => {
    log(`notify ${entry.chatId}/${entry.threadId ?? 'main'} failed: ${err}`)
  })
}

function enqueue(entry: TopicEntry, content: string, meta: Record<string, string>): void {
  let q = queues.get(entry.key)
  if (!q) queues.set(entry.key, (q = []))
  q.push({ content, meta })
  if (q.length > cfg.queueLimit) {
    q.shift()
    notify(entry, `⚠️ The session is not answering; the oldest queued message was dropped.`)
  }
  flush(entry.key)
}

function flush(key: string): void {
  const c = conns.get(key)
  if (!c?.ready || starting.has(key)) return
  const q = queues.get(key)
  while (q?.length) {
    const m = q.shift()!
    sendTo(key, { type: 'inbound', content: m.content, meta: m.meta })
  }
}

// grammy handles updates one at a time today, but /restart and inbound can
// overlap — never launch the same session twice.
const ensuring = new Map<string, Promise<void>>()

function ensureRunning(entry: TopicEntry): Promise<void> {
  let p = ensuring.get(entry.key)
  if (!p) {
    p = (async () => {
      if (starting.has(entry.key)) return
      if (await tmux.alive(entry.tmux)) {
        if (entry.stopped) store.update(entry.key, { stopped: false })
        return
      }
      await launch(entry)
    })().finally(() => ensuring.delete(entry.key))
    ensuring.set(entry.key, p)
  }
  return p
}

async function launch(entry: TopicEntry, freshAfterFailedResume = false): Promise<void> {
  const gen = ++generation
  starting.set(entry.key, gen)
  const resume = entry.launched && !freshAfterFailedResume
  try {
    // server mode: the binding rides in the --mcp-config env block. Plugin
    // mode: it has to be in the session's environment for the plugin to see.
    const plugin = usesPlugin(cfg)
    const binding = { socket: MANAGER_SOCKET, stateDir: STATE_DIR }
    const mcpPath = plugin
      ? undefined
      : writeMcpConfig(SESSIONS_DIR, entry, mcpConfig(entry, { bun: process.execPath, serverTs: SERVER_TS, ...binding }))
    await tmux.start(
      entry.tmux,
      entry.cwd,
      [cfg.claudeCommand, ...claudeArgs(cfg, entry, mcpPath, resume)],
      plugin ? bindingEnv(entry, binding) : {},
    )
    store.update(entry.key, { launched: true, stopped: false })
    log(`started ${entry.tmux} in ${entry.cwd}${resume ? ' (resume)' : ''}`)
  } catch (err) {
    if (starting.get(entry.key) === gen) starting.delete(entry.key)
    notify(entry, `❌ Could not start Claude Code: ${err instanceof Error ? err.message : err}`)
    return
  }
  void watchStartup(entry, resume, gen)
}

// Watch the fresh session's terminal until its channel is connected and no
// startup prompt is in the way. Answers the dev-channels prompt (our channel
// isn't on Anthropic's allowlist, so Claude Code asks every time); prompts
// that need a human (folder trust, bypass-permissions consent) are reported.
async function watchStartup(entry: TopicEntry, resumed: boolean, gen: number): Promise<void> {
  const started = Date.now()
  const reported = new Set<string>()
  let lastEnter = 0
  let clearPolls = 0
  try {
    while (Date.now() - started < 120_000) {
      await new Promise(r => setTimeout(r, 1000))
      if (!(await tmux.alive(entry.tmux))) {
        if (resumed && Date.now() - started < 30_000) {
          // --resume failed (conversation gone or unreadable): start fresh.
          notify(entry, '⚠️ Could not resume the previous conversation — starting a new one.')
          store.update(entry.key, { claudeSessionId: randomUUID(), launched: false })
          await launch(store.get(entry.key)!, true)
          return
        }
        notify(entry, `⚠️ Claude Code exited right after start. Check it by hand: cd ${entry.cwd} && ${cfg.claudeCommand}`)
        return
      }
      const prompt = detectPrompt(await tmux.capture(entry.tmux))
      if (prompt === 'dev-channels') {
        clearPolls = 0
        if (cfg.autoConfirmDevChannels) {
          if (Date.now() - lastEnter > 2500) {
            lastEnter = Date.now()
            await tmux.sendKeys(entry.tmux, 'Enter')
          }
        } else if (!reported.has(prompt)) {
          reported.add(prompt)
          notify(entry, `⏸ Claude Code asks to confirm the development channel. Attach and confirm:\n${tmux.attachHint(entry.tmux)}`)
        }
        continue
      }
      if (prompt === 'trust' || prompt === 'bypass') {
        clearPolls = 0
        if (!reported.has(prompt)) {
          reported.add(prompt)
          const what = prompt === 'trust' ? `to trust the folder ${entry.cwd}` : 'to accept --dangerously-skip-permissions'
          notify(entry, `⏸ Claude Code is waiting for you ${what}. Attach, answer, detach (Ctrl-b d):\n${tmux.attachHint(entry.tmux)}`)
        }
        continue
      }
      const c = conns.get(entry.key)
      if (c?.ready && ++clearPolls >= 2) return
    }
    notify(entry, `⚠️ The session did not connect within 2 minutes. Messages are queued. Look at it:\n${tmux.attachHint(entry.tmux)}`)
  } finally {
    if (starting.get(entry.key) === gen) {
      starting.delete(entry.key)
      flush(entry.key)
    }
  }
}

async function stopSession(entry: TopicEntry): Promise<void> {
  await tmux.stop(entry.tmux)
  conns.get(entry.key)?.socket.destroy()
  conns.delete(entry.key)
  drafts.finish(entry.chatId, entry.threadId)
  store.update(entry.key, { stopped: true })
}

function createEntry(chatId: string, threadId: number | undefined, name: string, dir?: string): TopicEntry {
  const cwd = threadId == null && !dir ? cfg.workspaceRoot : resolveCwd(cfg.workspaceRoot, name, dir)
  const entry = newEntry(chatId, threadId, name, cwd)
  store.put(entry)
  return entry
}

// ---------------------------------------------------------------------------
// Socket server for the sessions' channels

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function onClientMessage(conn: Conn, m: ClientMessage): void {
  if (m.type === 'hello') {
    const entry = store.get(m.key)
    if (!entry || !safeEqual(m.token ?? '', entry.token)) {
      conn.socket.end(encode({ type: 'reject', reason: 'unknown session or bad token' }))
      return
    }
    const prev = conns.get(m.key)
    if (prev && prev.socket !== conn.socket) prev.socket.destroy()
    conn.key = m.key
    conns.set(m.key, conn)
    sendTo(m.key, { type: 'welcome', topic: { name: entry.name, cwd: entry.cwd } })
    return
  }
  const key = conn.key
  const entry = key ? store.get(key) : undefined
  if (!key || !entry) return // not authenticated — ignore

  switch (m.type) {
    case 'ready':
      conn.ready = true
      flush(key)
      return
    case 'call':
      outbound.call(m.tool, m.args ?? {}, { chatId: entry.chatId, threadId: entry.threadId }).then(
        text => sendTo(key, { type: 'result', id: m.id, ok: true, text }),
        err => sendTo(key, { type: 'result', id: m.id, ok: false, text: err instanceof Error ? err.message : String(err) }),
      )
      return
    case 'permission_request': {
      // The topic's chat if it's an allowlisted DM; otherwise every
      // allowlisted DM, as in single-session mode. Never a group.
      const a = access.loadAccess()
      const targets = a.allowFrom.includes(entry.chatId)
        ? [{ chatId: entry.chatId, threadId: entry.threadId }]
        : a.allowFrom.map(chatId => ({ chatId }))
      permissions.request(
        { request_id: m.request_id, tool_name: m.tool_name, description: m.description, input_preview: m.input_preview },
        targets,
        key,
      )
      return
    }
  }
}

// A stale socket file from a crashed manager blocks listen(). The pid check
// above guarantees no live manager owns it.
rmSync(MANAGER_SOCKET, { force: true })
const ipc = createServer(socket => {
  const conn: Conn = { socket, ready: false }
  const dec = new LineDecoder<ClientMessage>()
  socket.on('data', d => {
    let msgs: ClientMessage[]
    try {
      msgs = dec.push(d)
    } catch {
      socket.destroy()
      return
    }
    for (const m of msgs) onClientMessage(conn, m)
  })
  socket.on('error', () => {})
  socket.on('close', () => {
    if (conn.key && conns.get(conn.key) === conn) conns.delete(conn.key)
  })
})
ipc.listen(MANAGER_SOCKET, () => {
  try { chmodSync(MANAGER_SOCKET, 0o600) } catch {}
  log(`listening on ${MANAGER_SOCKET}`)
})

// ---------------------------------------------------------------------------
// Telegram

const permissions = createPermissions({
  bot,
  access,
  log,
  onDecision: (request_id, behavior, owner) => {
    if (!sendTo(owner, { type: 'permission', request_id, behavior })) {
      log(`permission answer for ${request_id}: session ${owner ?? '?'} not connected`)
    }
  },
})

/** Session commands are for allowlisted users in DMs only — never pairing-pending ones. */
function ownerGate(ctx: Context): string | null {
  const gated = access.dmCommandGate(ctx)
  if (!gated || !gated.access.allowFrom.includes(gated.senderId)) return null
  return String(ctx.chat!.id)
}

registerBasicCommands(bot, access,
  `\n\nTopics — one Claude Code session each:\n` +
  `/new <name> [folder] — new topic + session (folder defaults to ${cfg.workspaceRoot}/<name>)\n` +
  `/sessions — list sessions\n` +
  `/stop [name] — stop this topic's session (or the named one)\n` +
  `/restart [name] — restart it`)

bot.command('new', async ctx => {
  const chatId = ownerGate(ctx)
  if (!chatId) return
  const here = threadOpt(threadOf(ctx))
  const parsed = parseNewCommand(ctx.match ?? '')
  if ('error' in parsed) {
    await ctx.reply(parsed.error, here)
    return
  }
  let threadId: number
  try {
    const topic = await bot.api.createForumTopic(chatId, parsed.name)
    threadId = topic.message_thread_id
  } catch (err) {
    await ctx.reply(`❌ Could not create the topic (are topics enabled for this bot in @BotFather?): ${err instanceof Error ? err.message : err}`, here)
    return
  }
  const entry = createEntry(chatId, threadId, parsed.name, parsed.dir)
  try {
    await bot.api.sendMessage(chatId, `🟢 Session “${entry.name}” in ${entry.cwd}\nStarting Claude Code — write here when you're ready.`, { message_thread_id: threadId })
  } catch (err) {
    // tdlib #905: a fresh topic can refuse every write. Don't keep a dead mapping.
    store.remove(entry.key)
    await ctx.reply(`❌ Telegram created the topic but won't accept messages in it (${err instanceof Error ? err.message : err}). Delete it and try /new again.`, here)
    return
  }
  await ensureRunning(entry)
})

bot.command('sessions', async ctx => {
  const chatId = ownerGate(ctx)
  if (!chatId) return
  const mine = store.all().filter(t => t.chatId === chatId)
  if (mine.length === 0) {
    await ctx.reply('No sessions yet. Create one with /new <name>.', threadOpt(threadOf(ctx)))
    return
  }
  const lines = await Promise.all(mine.map(async t => {
    const alive = await tmux.alive(t.tmux)
    const state = alive ? (conns.get(t.key)?.ready ? '🟢 running' : '🟡 starting') : '⚪ stopped'
    return `${state} — ${t.name} — ${t.cwd}`
  }))
  await ctx.reply(lines.join('\n'), threadOpt(threadOf(ctx)))
})

function targetEntry(ctx: Context, chatId: string): TopicEntry | undefined {
  const arg = String(ctx.match ?? '').trim()
  return arg ? store.byName(chatId, arg) : store.get(topicKey(chatId, threadOf(ctx)))
}

bot.command('stop', async ctx => {
  const chatId = ownerGate(ctx)
  if (!chatId) return
  const entry = targetEntry(ctx, chatId)
  const here = threadOpt(threadOf(ctx))
  if (!entry) {
    await ctx.reply('No session here. /sessions lists them; /stop <name> stops one by name.', here)
    return
  }
  await stopSession(entry)
  await ctx.reply(`⏹ Stopped “${entry.name}”. The next message here starts it again with the same conversation.`, here)
})

bot.command('restart', async ctx => {
  const chatId = ownerGate(ctx)
  if (!chatId) return
  const entry = targetEntry(ctx, chatId)
  const here = threadOpt(threadOf(ctx))
  if (!entry) {
    await ctx.reply('No session here. /sessions lists them.', here)
    return
  }
  await stopSession(entry)
  await ensureRunning(store.get(entry.key)!)
  await ctx.reply(`🔄 Restarting “${entry.name}”.`, here)
})

// Topics the user creates in the Telegram UI: remember the name so the
// session (started on the first real message) gets a sensible folder.
bot.on('message:forum_topic_created', async ctx => {
  const chatId = ownerGate(ctx)
  const threadId = threadOf(ctx)
  if (!chatId || threadId == null) return
  topicNames.set(topicKey(chatId, threadId), ctx.message.forum_topic_created.name)
})

bot.on('message:forum_topic_edited', async ctx => {
  const chatId = ownerGate(ctx)
  const threadId = threadOf(ctx)
  const name = ctx.message.forum_topic_edited.name
  if (!chatId || threadId == null || !name) return
  const key = topicKey(chatId, threadId)
  if (store.get(key)) store.update(key, { name })
  else topicNames.set(key, name)
})

// Stop button on the "Thinking…" draft (Bot API 10.3) → interrupt Claude
// (Esc in its terminal). grammy doesn't know this update type yet.
bot.use(async (ctx, next) => {
  const stop = (ctx.update as { stopped_message_generation?: { chat: { id: number }; message_thread_id?: number; draft_id: number } }).stopped_message_generation
  if (!stop) return next()
  const chatId = String(stop.chat.id)
  if (!access.loadAccess().allowFrom.includes(chatId)) return
  if (!drafts.stopped(chatId, stop.message_thread_id, stop.draft_id)) return
  const entry = store.get(topicKey(chatId, stop.message_thread_id))
  if (entry && await tmux.alive(entry.tmux)) await tmux.sendKeys(entry.tmux, 'Escape')
})

async function deliver(msg: Inbound): Promise<void> {
  const { chatId, threadId } = msg
  const name = topicNames.get(topicKey(chatId, threadId))
    ?? msg.ctx.message?.reply_to_message?.forum_topic_created?.name
  const r = route(store, cfg, chatId, threadId, name)
  if (r.kind === 'reject') {
    drafts.finish(chatId, threadId)
    notify({ chatId, threadId }, r.reason)
    return
  }
  // Group topics only get a session if the group itself is allowlisted —
  // which the gate already checked. Unknown topics get created on the fly.
  const entry = r.kind === 'session' ? r.entry : createEntry(chatId, threadId, r.name)
  if (r.kind === 'create') {
    topicNames.delete(entry.key)
    notify(entry, `🟢 New session “${entry.name}” in ${entry.cwd}. Starting Claude Code…`)
  }
  enqueue(entry, msg.content, { ...msg.meta, topic: entry.name })
  await ensureRunning(store.get(entry.key)!)
}

registerInbound({
  bot,
  access,
  drafts,
  outbound,
  inboxDir: INBOX_DIR,
  log,
  deliver,
  onPermissionReply: ({ chatId, threadId, request_id, behavior }) => {
    // Answer goes to the session that asked; fall back to this topic's session.
    const owner = permissions.ownerOf(request_id) ?? topicKey(chatId, threadId)
    sendTo(owner, { type: 'permission', request_id, behavior })
    permissions.forget(request_id)
  },
})

// Without this, any throw in a message handler stops polling permanently
// (grammy's default error handler calls bot.stop() and rethrows).
bot.catch(err => {
  log(`handler error (polling continues): ${err.error}`)
})

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down (sessions keep running in tmux)')
  ipc.close()
  rmSync(MANAGER_SOCKET, { force: true })
  try {
    if (parseInt(readFileSync(MANAGER_PID_FILE, 'utf8'), 10) === process.pid) rmSync(MANAGER_PID_FILE)
  } catch {}
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

if (!existsSync(cfg.workspaceRoot)) log(`workspace root ${cfg.workspaceRoot} does not exist yet — it will be created on first use`)

void runPolling(bot, {
  log,
  shuttingDown: () => shuttingDown,
  onStart: info => {
    botUsername = info.username
    log(`polling as @${info.username}; topics: ${store.all().length}; workspace: ${cfg.workspaceRoot}`)
    void bot.api.setMyCommands(
      [
        { command: 'new', description: 'New topic with its own Claude session' },
        { command: 'sessions', description: 'List sessions' },
        { command: 'stop', description: "Stop this topic's session" },
        { command: 'restart', description: "Restart this topic's session" },
        { command: 'status', description: 'Check your pairing status' },
        { command: 'help', description: 'What this bot can do' },
      ],
      { scope: { type: 'all_private_chats' } },
    ).catch(() => {})
  },
})
