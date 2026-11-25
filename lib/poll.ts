// getUpdates loop with retry, shared by both modes.

import { GrammyError, type Bot } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'

// Retry polling with backoff on any error. Previously only 409 was retried —
// a single ETIMEDOUT/ECONNRESET/DNS failure rejected bot.start(), the catch
// returned, and polling stopped permanently while the process stayed alive
// (MCP stdin keeps it running). Outbound tools kept working but the bot was
// deaf to inbound messages until a full restart.
export async function runPolling(bot: Bot, opts: {
  onStart: (info: UserFromGetMe) => void
  shuttingDown: () => boolean
  log: (msg: string) => void
  /** Give up after this many consecutive 409s. Undefined = retry forever. */
  max409?: number
}): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          attempt = 0
          opts.onStart(info)
        },
      })
      return // bot.stop() was called — clean exit from the loop
    } catch (err) {
      if (opts.shuttingDown()) return
      // bot.stop() mid-setup rejects with grammy's "Aborted delay" — expected, not an error.
      if (err instanceof Error && err.message === 'Aborted delay') return
      const is409 = err instanceof GrammyError && err.error_code === 409
      if (is409 && opts.max409 != null && attempt >= opts.max409) {
        opts.log(
          `409 Conflict persists after ${attempt} attempts — ` +
          `another poller is holding the bot token (stray 'bun server.ts' process, a second session, or the topic manager). Exiting.`,
        )
        return
      }
      const delay = Math.min(1000 * attempt, 15000)
      const detail = is409
        ? `409 Conflict${attempt === 1 ? ' — another instance is polling (zombie session, or a second Claude Code running?)' : ''}`
        : `polling error: ${err}`
      opts.log(`${detail}, retrying in ${delay / 1000}s`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
}
