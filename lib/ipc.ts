// Manager ⇄ topic-session wire protocol: newline-delimited JSON over a unix
// socket in the (0700) state dir. One connection per Claude session.

import type { PermissionRequest, Behavior } from './permissions.ts'

/** session → manager */
export type ClientMessage =
  | { type: 'hello'; key: string; token: string; pid: number }
  /** The MCP handshake with Claude Code is done — inbound can flow. */
  | { type: 'ready' }
  | { type: 'call'; id: number; tool: string; args: Record<string, unknown> }
  | ({ type: 'permission_request' } & PermissionRequest)

/** manager → session */
export type ManagerMessage =
  | { type: 'welcome'; topic: { name: string; cwd: string } }
  | { type: 'reject'; reason: string }
  | { type: 'result'; id: number; ok: boolean; text: string }
  | { type: 'inbound'; content: string; meta: Record<string, string> }
  | { type: 'permission'; request_id: string; behavior: Behavior }

export function encode(msg: ClientMessage | ManagerMessage): string {
  return JSON.stringify(msg) + '\n'
}

// Lines larger than this are a bug or an attack — drop the connection.
export const MAX_LINE = 4 * 1024 * 1024

/** Splits a byte stream into JSON messages. Partial lines are kept for the next chunk. */
export class LineDecoder<T> {
  private buf = ''
  // Streaming decoder: a multi-byte char may be split across two chunks.
  private dec = new TextDecoder()
  push(chunk: string | Uint8Array): T[] {
    this.buf += typeof chunk === 'string' ? chunk : this.dec.decode(chunk, { stream: true })
    const out: T[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as T)
      } catch {
        // Malformed line — skip it, keep the stream.
      }
    }
    if (this.buf.length > MAX_LINE) throw new Error('ipc line too long')
    return out
  }
}
