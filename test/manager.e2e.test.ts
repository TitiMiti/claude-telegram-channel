// Manager end-to-end without Telegram or Claude: a fake Bot API server feeds
// updates, tmux runs test/fixtures/fake-claude.ts instead of `claude`, and we
// check that each topic's messages reach its own session (and folder) and
// that replies come back into the same topic.
//
// Needs tmux and unix sockets; skipped when tmux is missing.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')
const FAKE_CLAUDE = join(import.meta.dir, 'fixtures', 'fake-claude.ts')
const hasTmux = spawnSync('tmux', ['-V']).status === 0
const TOKEN = '123:TEST'
const OWNER = 42
const STRANGER = 77

type ApiCall = { method: string; body: any }

let calls: ApiCall[] = []
let updates: any[] = []
let updateId = 1
let msgId = 500
let threadSeq = 100
let server: ReturnType<typeof Bun.serve>
let manager: ChildProcess
let stateDir: string
let ws: string
let managerLog = ''
const tmuxSocket = `tg-e2e-${process.pid}`

function fakeBotApi() {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname)
      if (!m || m[1] !== TOKEN) return new Response('not found', { status: 404 })
      const method = m[2]
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
      if (method !== 'getUpdates') calls.push({ method, body })
      const ok = (result: unknown) => Response.json({ ok: true, result })
      switch (method) {
        case 'getMe':
          return ok({ id: 999, is_bot: true, first_name: 'T', username: 'testbot', has_topics_enabled: true })
        case 'getUpdates': {
          const offset = body.offset ?? 0
          for (let i = 0; i < 10; i++) {
            const ready = updates.filter(u => u.update_id >= offset)
            if (ready.length) return ok(ready)
            await Bun.sleep(50)
          }
          return ok([])
        }
        case 'createForumTopic':
          return ok({ message_thread_id: ++threadSeq, name: body.name, icon_color: 0 })
        case 'sendMessage':
          return ok({ message_id: ++msgId, date: 0, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text })
        default:
          return ok(true)
      }
    },
  })
}

function push(message: Record<string, unknown>) {
  const from = (message.from as any) ?? { id: OWNER, is_bot: false, first_name: 'Owner', username: 'owner' }
  updates.push({
    update_id: updateId++,
    message: {
      message_id: ++msgId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: from.id, type: 'private', first_name: from.first_name },
      from,
      ...message,
    },
  })
}

function command(text: string, thread?: number) {
  const cmd = text.split(' ')[0]
  push({
    text,
    entities: [{ type: 'bot_command', offset: 0, length: cmd.length }],
    ...(thread != null ? { message_thread_id: thread, is_topic_message: true } : {}),
  })
}

async function until<T>(what: string, fn: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timeout: ${what}\n--- manager log ---\n${managerLog}`)
    await Bun.sleep(100)
  }
}

const sent = (pred: (b: any) => boolean) => calls.find(c => c.method === 'sendMessage' && pred(c.body))
const fakeLog = (dir: string) =>
  existsSync(join(dir, 'fake-claude.log'))
    ? readFileSync(join(dir, 'fake-claude.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    : []

describe.skipIf(!hasTmux)('manager e2e (fake Bot API + fake claude in tmux)', () => {
  beforeAll(() => {
    server = fakeBotApi()
    stateDir = mkdtempSync(join(tmpdir(), 'tgm-'))
    ws = join(stateDir, 'ws')
    writeFileSync(join(stateDir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(OWNER)], groups: {}, pending: {} }))
    writeFileSync(join(stateDir, 'manager.json'), JSON.stringify({
      workspaceRoot: ws,
      claudeCommand: process.execPath,
      claudeArgs: [FAKE_CLAUDE],
      tmuxSocket,
    }))
    manager = spawn(process.execPath, [join(ROOT, 'manager.ts')], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: stateDir,
        TELEGRAM_STATE_DIR: stateDir,
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_API_ROOT: `http://127.0.0.1:${server.port}`,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    manager.stderr!.on('data', d => { managerLog += d })
  })

  afterAll(() => {
    manager?.kill('SIGTERM')
    spawnSync('tmux', ['-L', tmuxSocket, 'kill-server'])
    // kill-server can leave the socket file behind
    const dir = process.env.TMUX_TMPDIR || '/tmp'
    rmSync(join(dir, `tmux-${process.getuid!()}`, tmuxSocket), { force: true })
    server?.stop(true)
  })

  test('routes by message_thread_id to one session per topic', async () => {
    await until('polling', () => managerLog.includes('polling as @testbot'))

    // /new Alpha → topic + folder + session
    command('/new Alpha')
    const created = await until('createForumTopic', () => calls.find(c => c.method === 'createForumTopic'))
    expect(created.body).toMatchObject({ chat_id: String(OWNER), name: 'Alpha' })
    const alphaThread = 101
    await until('session notice in topic', () => sent(b => b.message_thread_id === alphaThread && b.text.includes('Alpha')))

    // fake claude shows the dev-channels prompt; the manager presses Enter
    const alphaDir = join(ws, 'Alpha')
    await until('alpha confirmed', () => fakeLog(alphaDir).some(e => e.event === 'confirmed'))
    const start = fakeLog(alphaDir).find(e => e.event === 'start')
    expect(start.argv).toContain('--session-id')
    expect(start.argv).toContain('server:telegram')

    push({ text: 'hello alpha', message_thread_id: alphaThread, is_topic_message: true })
    const echoA = await until('alpha echo', () => sent(b => b.text === 'echo from Alpha: hello alpha'))
    expect(echoA.body.message_thread_id).toBe(alphaThread)
    const inboundA = fakeLog(alphaDir).find(e => e.event === 'inbound')
    expect(inboundA.meta).toMatchObject({ chat_id: String(OWNER), topic: 'Alpha', user: 'owner' })
    expect(fakeLog(alphaDir).find(e => e.event === 'initialized').instructions).toContain('"Alpha"')
    // thinking draft went to the right topic
    expect(calls.some(c => c.method === 'sendMessageDraft' && c.body.message_thread_id === alphaThread && c.body.text === '')).toBe(true)

    // second topic, its own session and folder
    command('/new Beta')
    const betaThread = 102
    await until('beta notice', () => sent(b => b.message_thread_id === betaThread))
    push({ text: 'hello beta', message_thread_id: betaThread, is_topic_message: true })
    const echoB = await until('beta echo', () => sent(b => b.text === 'echo from Beta: hello beta'))
    expect(echoB.body.message_thread_id).toBe(betaThread)
    // Alpha's session never saw Beta's message
    expect(fakeLog(alphaDir).filter(e => e.event === 'inbound').map(e => e.content)).toEqual(['hello alpha'])

    // a topic created in the Telegram UI: session on first message, named after it
    push({
      text: 'hi gamma',
      message_thread_id: 103,
      is_topic_message: true,
      reply_to_message: {
        message_id: 1, date: 0, chat: { id: OWNER, type: 'private' },
        forum_topic_created: { name: 'Gamma', icon_color: 0 }, message_thread_id: 103,
      },
    })
    // a second message right behind the first lands in the same session (one start)
    push({ text: 'hi again', message_thread_id: 103, is_topic_message: true })
    const echoG = await until('gamma echo', () => sent(b => b.text === 'echo from Gamma: hi gamma'))
    expect(echoG.body.message_thread_id).toBe(103)
    await until('gamma second echo', () => sent(b => b.text === 'echo from Gamma: hi again'))
    expect(fakeLog(join(ws, 'Gamma')).filter(e => e.event === 'start').length).toBe(1)

    // voice without YANDEX_API_KEY: user is told once, Claude gets voice_error
    push({ voice: { file_id: 'v1', file_unique_id: 'u1', duration: 2, mime_type: 'audio/ogg' }, message_thread_id: alphaThread, is_topic_message: true })
    await until('voice notice', () => sent(b => b.message_thread_id === alphaThread && b.text.includes('YANDEX_API_KEY')))
    const voiceIn = await until('voice inbound', () => fakeLog(alphaDir).find(e => e.event === 'inbound' && e.meta.attachment_kind === 'voice'))
    expect(voiceIn.meta.voice_error).toContain('not configured')

    // strangers are dropped silently (allowlist policy)
    const before = calls.length
    push({ text: 'let me in', from: { id: STRANGER, is_bot: false, first_name: 'X' } })
    await Bun.sleep(1000)
    expect(calls.slice(before).filter(c => String(c.body.chat_id) === String(STRANGER))).toEqual([])

    // /sessions lists them
    command('/sessions', alphaThread)
    const list = await until('sessions list', () => sent(b => b.text.includes('Alpha') && b.text.includes('Beta') && b.text.includes('Gamma') && b.text.includes('running')))
    expect(list.body.message_thread_id).toBe(alphaThread)

    // /stop in Beta stops only Beta
    command('/stop', betaThread)
    await until('stop ack', () => sent(b => b.message_thread_id === betaThread && b.text.includes('Stopped')))
    const alive = (name: string) => spawnSync('tmux', ['-L', tmuxSocket, 'has-session', '-t', `=${name}`]).status === 0
    expect(alive(`tg-${OWNER}-${betaThread}`)).toBe(false)
    expect(alive(`tg-${OWNER}-${alphaThread}`)).toBe(true)

    // next message in Beta resumes the same conversation
    push({ text: 'back', message_thread_id: betaThread, is_topic_message: true })
    await until('beta resumed echo', () => sent(b => b.text === 'echo from Beta: back'))
    const starts = fakeLog(join(ws, 'Beta')).filter(e => e.event === 'start')
    expect(starts.length).toBe(2)
    expect(starts[1].argv).toContain('--resume')
    expect(starts[1].argv[starts[1].argv.indexOf('--resume') + 1]).toBe(starts[0].argv[starts[0].argv.indexOf('--session-id') + 1])

    // the state file maps topics to folders
    const state = JSON.parse(readFileSync(join(stateDir, 'topics.json'), 'utf8'))
    expect(Object.keys(state.topics).sort()).toEqual([`${OWNER}:101`, `${OWNER}:102`, `${OWNER}:103`])
    expect(state.topics[`${OWNER}:101`].cwd).toBe(alphaDir)
  }, 90_000)
})
