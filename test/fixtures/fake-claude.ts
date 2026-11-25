// Stand-in for `claude` in the manager e2e test. Understands just enough:
// shows the dev-channels prompt and waits for Enter (like Claude Code does),
// starts the channel from --mcp-config, speaks MCP to it, and answers every
// inbound message through the reply tool. Logs to ./fake-claude.log (cwd =
// the topic's folder).

import { spawn } from 'child_process'
import { appendFileSync, readFileSync } from 'fs'
import { basename } from 'path'
import { createInterface } from 'readline'

const argv = process.argv.slice(2)
const arg = (name: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const logLine = (o: unknown) => appendFileSync('fake-claude.log', JSON.stringify(o) + '\n')
logLine({ event: 'start', argv })

process.stdout.write('WARNING: Loading development channels\n❯ 1. I am using this for local development\n  2. Exit\n')
const rl = createInterface({ input: process.stdin })
await new Promise<void>(r => rl.once('line', () => r()))
process.stdout.write('\x1b[2J\x1b[H> ready\n')
logLine({ event: 'confirmed' })

const cfg = JSON.parse(readFileSync(arg('--mcp-config')!, 'utf8'))
const srv = cfg.mcpServers.telegram
const child = spawn(srv.command, srv.args, { env: { ...process.env, ...srv.env }, stdio: ['pipe', 'pipe', 'inherit'] })

let buf = ''
let id = 0
const pending = new Map<number, (m: any) => void>()
const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n')
const request = (method: string, params: unknown) =>
  new Promise<any>(resolve => {
    const myId = ++id
    pending.set(myId, resolve)
    send({ jsonrpc: '2.0', id: myId, method, params })
  })

child.stdout.on('data', d => {
  buf += d
  let nl: number
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.id != null && pending.has(m.id)) {
      pending.get(m.id)!(m)
      pending.delete(m.id)
    } else if (m.method === 'notifications/claude/channel') {
      logLine({ event: 'inbound', ...m.params })
      void request('tools/call', {
        name: 'reply',
        arguments: { chat_id: m.params.meta.chat_id, text: `echo from ${basename(process.cwd())}: ${m.params.content}` },
      }).then(r => logLine({ event: 'replied', result: r.result }))
    }
  }
})

const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } })
logLine({ event: 'initialized', instructions: init.result.instructions })
send({ jsonrpc: '2.0', method: 'notifications/initialized' })
await new Promise(() => {})
