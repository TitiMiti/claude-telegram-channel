// Topic-session channel: the MCP server inside one Claude Code session that
// the manager started for a Telegram topic. It never talks to Telegram — it
// relays tool calls to the manager over the unix socket and turns the
// manager's pushes (inbound messages, permission answers) into channel
// notifications. Reconnects on its own when the manager restarts.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createConnection, type Socket } from 'net'
import { encode, LineDecoder, type ClientMessage, type ManagerMessage } from './ipc.ts'
import { toolDefs } from './outbound.ts'
import { createChannelServer, PermissionRequestNotification, onStdinClose } from './mcp.ts'

const CALL_TIMEOUT_MS = 5 * 60_000

export async function runTopicClient(opts: {
  socketPath: string
  key: string
  token: string
  log: (msg: string) => void
}): Promise<void> {
  const { log } = opts
  let sock: Socket | null = null
  let rejected = false
  let shuttingDown = false
  let mcpReady = false
  let nextId = 1
  const calls = new Map<number, { resolve: (r: { ok: boolean; text: string }) => void; timer: ReturnType<typeof setTimeout> }>()
  // Pushes that arrive before Claude Code finished the MCP handshake.
  const early: ManagerMessage[] = []
  let topic: { name: string; cwd: string } | undefined
  let gotWelcome: () => void = () => {}
  const welcomed = new Promise<void>(r => { gotWelcome = r })

  function send(msg: ClientMessage): boolean {
    if (!sock || sock.destroyed) return false
    sock.write(encode(msg))
    return true
  }

  function connect(): void {
    if (shuttingDown) return
    const s = createConnection({ path: opts.socketPath })
    const dec = new LineDecoder<ManagerMessage>()
    s.on('connect', () => {
      sock = s
      send({ type: 'hello', key: opts.key, token: opts.token, pid: process.pid })
      if (mcpReady) send({ type: 'ready' })
    })
    s.on('data', d => {
      let msgs: ManagerMessage[]
      try {
        msgs = dec.push(d)
      } catch {
        s.destroy()
        return
      }
      for (const m of msgs) handle(m)
    })
    s.on('error', () => {}) // 'close' follows and schedules the retry
    s.on('close', () => {
      if (sock === s) sock = null
      for (const [id, c] of calls) {
        clearTimeout(c.timer)
        c.resolve({ ok: false, text: 'connection to the telegram manager was lost' })
        calls.delete(id)
      }
      // A rejected token won't get better quickly — back off hard.
      if (!shuttingDown) setTimeout(connect, rejected ? 60_000 : 2000).unref()
    })
  }

  function handle(m: ManagerMessage): void {
    switch (m.type) {
      case 'welcome':
        rejected = false
        topic = m.topic
        gotWelcome()
        return
      case 'reject':
        rejected = true
        log(`manager rejected this session: ${m.reason}`)
        gotWelcome()
        return
      case 'result': {
        const c = calls.get(m.id)
        if (!c) return
        clearTimeout(c.timer)
        calls.delete(m.id)
        c.resolve({ ok: m.ok, text: m.text })
        return
      }
      case 'inbound':
      case 'permission':
        if (!mcpReady) early.push(m)
        else push(m)
        return
    }
  }

  function push(m: ManagerMessage): void {
    if (m.type === 'inbound') {
      mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: m.content, meta: m.meta },
      }).catch(err => log(`failed to deliver inbound to Claude: ${err}`))
    } else if (m.type === 'permission') {
      void mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: m.request_id, behavior: m.behavior },
      })
    }
  }

  connect()
  // Topic name and folder go into the instructions; don't hold startup hostage.
  await Promise.race([welcomed, new Promise(r => setTimeout(r, 3000))])

  const mcp = createChannelServer('topic', topic)

  mcp.setNotificationHandler(PermissionRequestNotification, async ({ params }) => {
    send({ type: 'permission_request', ...params })
  })

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefs('topic') }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const name = req.params.name
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    const id = nextId++
    const result = await new Promise<{ ok: boolean; text: string }>(resolve => {
      const timer = setTimeout(() => {
        calls.delete(id)
        resolve({ ok: false, text: 'telegram manager did not answer in time' })
      }, CALL_TIMEOUT_MS)
      calls.set(id, { resolve, timer })
      if (!send({ type: 'call', id, tool: name, args })) {
        clearTimeout(timer)
        calls.delete(id)
        resolve({ ok: false, text: 'telegram manager is not reachable (restarting?) — try again shortly' })
      }
    })
    return result.ok
      ? { content: [{ type: 'text', text: result.text }] }
      : { content: [{ type: 'text', text: `${name} failed: ${result.text}` }], isError: true }
  })

  mcp.oninitialized = () => {
    mcpReady = true
    send({ type: 'ready' })
    for (const m of early.splice(0)) push(m)
  }

  await mcp.connect(new StdioServerTransport())

  onStdinClose(() => {
    if (shuttingDown) return
    shuttingDown = true
    log('shutting down')
    sock?.destroy()
    setTimeout(() => process.exit(0), 200)
  })
}
