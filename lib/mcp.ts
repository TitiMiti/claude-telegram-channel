// The MCP side of a channel: server capabilities, instructions, the
// permission_request notification schema, and stdin-EOF shutdown wiring.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { z } from 'zod'
import { instructions, type Mode } from './outbound.ts'

export function createChannelServer(mode: Mode, topic?: { name: string; cwd: string }): Server {
  return new Server(
    { name: 'telegram', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
          // Permission-relay opt-in (anthropics/claude-cli-internal#23061).
          // Declaring this asserts we authenticate the replier — which we do:
          // gate()/access.allowFrom already drops non-allowlisted senders before
          // handleInbound runs (in topic mode the manager runs the same gate).
          // A server that can't authenticate the replier should NOT declare this.
          'claude/channel/permission': {},
        },
      },
      instructions: instructions(mode, topic),
    },
  )
}

export const PermissionRequestNotification = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

// When Claude Code closes the MCP connection, stdin gets EOF. Without this
// the process keeps running forever as a zombie (in single-session mode it
// would keep holding the bot token and block the next session with 409).
export function onStdinClose(shutdown: () => void): void {
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGHUP', shutdown)

  // Orphan watchdog: belt-and-suspenders for the stdin 'end'/'close' handlers
  // above. Stdin is the MCP transport pipe inherited straight from the CLI; the
  // kernel closes it on any CLI death (clean, crash, SIGKILL, OOM) regardless of
  // intermediate wrappers. A ppid-change check used to live here but it
  // false-fires when the bun-run/shell wrapper exits or execs during normal
  // startup and we get reparented to init.
  setInterval(() => {
    if (process.stdin.destroyed || process.stdin.readableEnded) shutdown()
  }, 5000).unref()
}
