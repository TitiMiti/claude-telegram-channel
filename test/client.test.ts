// End-to-end over real pipes: spawn server.ts the way Claude Code would and
// drive it with MCP JSON-RPC on stdio, with a fake manager on the unix socket.

import { describe, expect, test, afterEach } from 'bun:test'
import { createServer, type Server as NetServer, type Socket } from 'net'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { encode, LineDecoder, type ClientMessage } from '../lib/ipc.ts'

const SERVER = join(import.meta.dir, '..', 'server.ts')
const children: ChildProcess[] = []
const servers: NetServer[] = []

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
  for (const s of servers.splice(0)) s.close()
})

/** MCP client over the child's stdio. */
function mcpClient(child: ChildProcess) {
  const dec = new LineDecoder<any>()
  const inbox: any[] = []
  const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = []
  child.stdout!.on('data', d => {
    for (const m of dec.push(d)) {
      const w = waiters.findIndex(w => w.pred(m))
      if (w >= 0) waiters.splice(w, 1)[0].resolve(m)
      else inbox.push(m)
    }
  })
  const send = (m: unknown) => child.stdin!.write(JSON.stringify(m) + '\n')
  const waitFor = (pred: (m: any) => boolean, ms = 5000) =>
    new Promise<any>((resolve, reject) => {
      const i = inbox.findIndex(pred)
      if (i >= 0) return resolve(inbox.splice(i, 1)[0])
      waiters.push({ pred, resolve })
      setTimeout(() => reject(new Error('timeout waiting for MCP message')), ms)
    })
  let id = 0
  const request = async (method: string, params: unknown) => {
    const myId = ++id
    send({ jsonrpc: '2.0', id: myId, method, params })
    return waitFor(m => m.id === myId)
  }
  const initialize = async () => {
    const r = await request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return r
  }
  return { send, request, waitFor, initialize }
}

function spawnServer(env: Record<string, string>) {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-state-'))
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH ?? '', HOME: stateDir, TELEGRAM_STATE_DIR: stateDir, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  let stderr = ''
  child.stderr!.on('data', d => { stderr += d })
  return { child, stderr: () => stderr }
}

describe('idle mode', () => {
  test('plugin copy inside a manager session exposes no tools and never polls', async () => {
    const { child, stderr } = spawnServer({ TELEGRAM_MANAGED: '1', TELEGRAM_BOT_TOKEN: '1:fake' })
    const mcp = mcpClient(child)
    await mcp.initialize()
    const tools = await mcp.request('tools/list', {})
    expect(tools.result.tools).toEqual([])
    expect(stderr()).toContain('idle')
  })
})

describe('single-session mode', () => {
  test('without a token it explains where to put it and exits', async () => {
    const { child, stderr } = spawnServer({})
    const code = await new Promise(r => child.on('exit', r))
    expect(code).toBe(1)
    expect(stderr()).toContain('TELEGRAM_BOT_TOKEN required')
  })
})

describe('topic session ⇄ manager socket', () => {
  test('hello/ready handshake, tool calls relayed, inbound becomes a channel notification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgc-'))
    let sock = join(dir, 's')
    // unix socket paths max out around 104–108 bytes
    if (sock.length > 100) sock = relative(process.cwd(), sock)

    const got: ClientMessage[] = []
    let peer: Socket | undefined
    const connected = new Promise<void>(resolve => {
      const srv = createServer(s => {
        peer = s
        const dec = new LineDecoder<ClientMessage>()
        s.on('data', d => {
          for (const m of dec.push(d)) {
            got.push(m)
            if (m.type === 'hello') {
              s.write(encode({ type: 'welcome', topic: { name: 'alpha', cwd: '/w/alpha' } }))
              resolve()
            }
            if (m.type === 'call') {
              s.write(encode({ type: 'result', id: m.id, ok: true, text: `did ${m.tool} with ${JSON.stringify(m.args)}` }))
            }
          }
        })
      })
      srv.listen(sock)
      servers.push(srv)
    })

    const { child } = spawnServer({
      TELEGRAM_MANAGER_SOCKET: sock,
      TELEGRAM_SESSION_KEY: '42:7',
      TELEGRAM_SESSION_TOKEN: 'tok',
      TELEGRAM_MANAGED: '1',
    })
    const mcp = mcpClient(child)
    await connected
    expect(got[0]).toMatchObject({ type: 'hello', key: '42:7', token: 'tok' })

    const init = await mcp.initialize()
    expect(init.result.capabilities.experimental['claude/channel']).toEqual({})
    expect(init.result.instructions).toContain('"alpha"')

    // ready only after the MCP handshake
    for (let i = 0; i < 50 && !got.some(m => m.type === 'ready'); i++) await Bun.sleep(20)
    expect(got.some(m => m.type === 'ready')).toBe(true)

    const tools = await mcp.request('tools/list', {})
    expect(tools.result.tools.map((t: any) => t.name)).toContain('stream_reply')

    const res = await mcp.request('tools/call', { name: 'reply', arguments: { chat_id: '42', text: 'hi' } })
    expect(res.result.content[0].text).toBe('did reply with {"chat_id":"42","text":"hi"}')

    peer!.write(encode({ type: 'inbound', content: 'привет', meta: { chat_id: '42', message_id: '5', topic: 'alpha' } }))
    const note = await mcp.waitFor(m => m.method === 'notifications/claude/channel')
    expect(note.params).toEqual({ content: 'привет', meta: { chat_id: '42', message_id: '5', topic: 'alpha' } })

    peer!.write(encode({ type: 'permission', request_id: 'abcde', behavior: 'allow' }))
    const perm = await mcp.waitFor(m => m.method === 'notifications/claude/channel/permission')
    expect(perm.params).toEqual({ request_id: 'abcde', behavior: 'allow' })

    // Claude Code asks for permission → relayed to the manager
    mcp.send({
      jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request',
      params: { request_id: 'fghij', tool_name: 'Bash', description: 'run ls', input_preview: '{}' },
    })
    for (let i = 0; i < 50 && !got.some(m => m.type === 'permission_request'); i++) await Bun.sleep(20)
    expect(got.find(m => m.type === 'permission_request')).toMatchObject({ request_id: 'fghij', tool_name: 'Bash' })

    // Manager goes away: calls fail fast instead of hanging.
    peer!.destroy()
    servers.splice(0).forEach(s => s.close())
    await Bun.sleep(100)
    const down = await mcp.request('tools/call', { name: 'reply', arguments: { chat_id: '42', text: 'x' } })
    expect(down.result.isError).toBe(true)
    expect(down.result.content[0].text).toContain('not reachable')
  }, 15_000)
})
