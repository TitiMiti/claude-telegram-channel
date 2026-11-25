// Live drafts in private chats (Bot API sendMessageDraft, 9.3+, all bots since 9.5).
//
// A draft is an ephemeral, animated preview of a message that is "being
// typed". It lives ~30 s unless refreshed, and disappears when the bot sends a
// real message to the same chat/topic — so the final reply is always an
// ordinary sendMessage, the draft only covers the wait.
//
// Claude Code doesn't expose model tokens to MCP servers: the channel only
// sees finished tool calls. So "streaming" here is one of:
//   • thinking — empty draft ("Thinking…" placeholder) from the moment a
//     message is delivered until Claude replies, kept alive in the background;
//   • update   — Claude itself pushes partial text via the stream_reply tool;
//   • play     — optional cosmetic playback of a finished long reply.
// One draft_id per turn so thinking → partial text → final animates smoothly.

export type DraftApi = {
  sendMessageDraft(
    chat_id: number,
    draft_id: number,
    text: string,
    other?: { message_thread_id?: number; can_stop?: boolean },
  ): Promise<unknown>
}

export type Timers = {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
  sleep(ms: number): Promise<void>
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    ;(t as { unref?: () => void }).unref?.()
    return t
  },
  clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
}

export const DRAFT_MAX = 4096

type Turn = {
  chatId: number
  threadId?: number
  draftId: number
  text: string
  startedAt: number
  lastSent: number
  keepTimer?: unknown
  trailingTimer?: unknown
  dead: boolean
}

export type DraftOptions = {
  /** Re-send the draft this often so it doesn't expire (Telegram keeps it ~30 s). */
  keepAliveMs?: number
  /** Give up refreshing after this long without a reply. */
  maxTurnMs?: number
  /** Minimum gap between two draft updates. */
  throttleMs?: number
  /** Show Telegram's stop button on drafts (Bot API 10.3). */
  canStop?: boolean
  timers?: Timers
  log?: (msg: string) => void
  randomId?: () => number
}

export function draftKey(chatId: number | string, threadId?: number): string {
  return `${chatId}:${threadId ?? ''}`
}

/** Drafts only accept a private chat's integer id. */
export function isPrivateChatId(chatId: number | string): boolean {
  const n = Number(chatId)
  return Number.isSafeInteger(n) && n > 0
}

/** Drafts hold at most 4096 chars — show the newest part of a long text. */
export function draftText(text: string): string {
  if (text.length <= DRAFT_MAX) return text
  return '…' + text.slice(text.length - (DRAFT_MAX - 1))
}

/** Prefixes of `text` at word boundaries for cosmetic playback. */
export function playbackFrames(text: string, steps: number): string[] {
  const frames: string[] = []
  for (let i = 1; i <= steps; i++) {
    let cut = Math.round((text.length * i) / (steps + 1))
    const ws = text.slice(cut).search(/\s/)
    cut = ws < 0 ? text.length : cut + ws
    const frame = text.slice(0, cut).trimEnd()
    if (frame && frame !== frames[frames.length - 1] && frame.length < text.length) frames.push(frame)
  }
  return frames
}

export class DraftManager {
  private turns = new Map<string, Turn>()
  private disabled = false
  private readonly keepAliveMs: number
  private readonly maxTurnMs: number
  private readonly throttleMs: number
  private readonly timers: Timers

  constructor(private api: DraftApi, private opts: DraftOptions = {}) {
    this.keepAliveMs = opts.keepAliveMs ?? 20_000
    this.maxTurnMs = opts.maxTurnMs ?? 10 * 60_000
    this.throttleMs = opts.throttleMs ?? 1000
    this.timers = opts.timers ?? realTimers
  }

  /** Open (or refresh) the "Thinking…" placeholder for a chat/topic. */
  thinking(chatId: number | string, threadId?: number): void {
    if (!isPrivateChatId(chatId) || this.disabled) return
    const turn = this.turn(chatId, threadId)
    if (turn.text) return // already showing partial text — keep it
    this.sendNow(turn)
  }

  /** Replace the draft text (stream_reply). Throttled; the last call always lands. */
  update(chatId: number | string, threadId: number | undefined, text: string): boolean {
    if (!isPrivateChatId(chatId) || this.disabled) return false
    const turn = this.turn(chatId, threadId)
    turn.text = draftText(text)
    const wait = turn.lastSent + this.throttleMs - this.timers.now()
    if (wait <= 0) {
      this.sendNow(turn)
    } else if (turn.trailingTimer === undefined) {
      turn.trailingTimer = this.timers.setTimeout(() => {
        turn.trailingTimer = undefined
        if (this.turns.get(draftKey(turn.chatId, turn.threadId)) === turn) this.sendNow(turn)
      }, wait)
    }
    return true
  }

  /**
   * Cosmetic playback of a finished reply before it is sent for real.
   * Resolves when the last frame went out; the caller then sends the message.
   */
  async play(chatId: number | string, threadId: number | undefined, text: string, durationMs = 1500, steps = 5): Promise<void> {
    if (!isPrivateChatId(chatId) || this.disabled) return
    const frames = playbackFrames(text, steps)
    for (const f of frames) {
      const turn = this.turn(chatId, threadId)
      turn.text = draftText(f)
      this.sendNow(turn)
      await this.timers.sleep(Math.max(1, Math.floor(durationMs / frames.length)))
    }
  }

  /** Stop refreshing — called right before the real message goes out. */
  finish(chatId: number | string, threadId?: number): void {
    const key = draftKey(chatId, threadId)
    const turn = this.turns.get(key)
    if (!turn) return
    this.clear(turn)
    this.turns.delete(key)
  }

  /** End every turn in a chat, whatever the topic. */
  finishChat(chatId: number | string): void {
    for (const t of [...this.turns.values()]) {
      if (t.chatId === Number(chatId)) this.finish(t.chatId, t.threadId)
    }
  }

  /** stopped_message_generation: is this our draft? Ends the turn if so. */
  stopped(chatId: number | string, threadId: number | undefined, draftId: number): boolean {
    const turn = this.turns.get(draftKey(chatId, threadId))
    if (!turn || turn.draftId !== draftId) return false
    this.finish(chatId, threadId)
    return true
  }

  active(chatId: number | string, threadId?: number): { draftId: number; text: string } | undefined {
    const t = this.turns.get(draftKey(chatId, threadId))
    return t && !t.dead ? { draftId: t.draftId, text: t.text } : undefined
  }

  private turn(chatId: number | string, threadId?: number): Turn {
    const key = draftKey(chatId, threadId)
    let t = this.turns.get(key)
    if (!t) {
      const now = this.timers.now()
      t = {
        chatId: Number(chatId),
        threadId,
        draftId: this.opts.randomId?.() ?? 1 + Math.floor(Math.random() * 0x7ffffffe),
        text: '',
        startedAt: now,
        lastSent: 0,
        dead: false,
      }
      this.turns.set(key, t)
    }
    return t
  }

  private clear(turn: Turn): void {
    if (turn.keepTimer !== undefined) this.timers.clearTimeout(turn.keepTimer)
    if (turn.trailingTimer !== undefined) this.timers.clearTimeout(turn.trailingTimer)
    turn.keepTimer = turn.trailingTimer = undefined
  }

  private sendNow(turn: Turn): void {
    if (turn.dead) return
    turn.lastSent = this.timers.now()
    void this.api.sendMessageDraft(turn.chatId, turn.draftId, turn.text, {
      ...(turn.threadId != null ? { message_thread_id: turn.threadId } : {}),
      ...(this.opts.canStop ? { can_stop: true } : {}),
    }).catch(err => {
      // One failure kills the turn (no retry storm). "method not found" means
      // the Bot API server is too old — stop trying for the process lifetime.
      turn.dead = true
      this.clear(turn)
      const msg = err instanceof Error ? err.message : String(err)
      if (/not found|404/i.test(msg)) this.disabled = true
      this.opts.log?.(`draft failed (${msg})${this.disabled ? ' — drafts disabled' : ''}`)
    })
    this.scheduleKeepAlive(turn)
  }

  private scheduleKeepAlive(turn: Turn): void {
    if (turn.keepTimer !== undefined) this.timers.clearTimeout(turn.keepTimer)
    turn.keepTimer = undefined
    if (this.timers.now() - turn.startedAt >= this.maxTurnMs) {
      // Waited long enough — let the draft expire on its own.
      this.turns.delete(draftKey(turn.chatId, turn.threadId))
      return
    }
    turn.keepTimer = this.timers.setTimeout(() => {
      turn.keepTimer = undefined
      if (this.turns.get(draftKey(turn.chatId, turn.threadId)) === turn) this.sendNow(turn)
    }, this.keepAliveMs)
  }
}
