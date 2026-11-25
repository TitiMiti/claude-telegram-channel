// Access control: access.json, the inbound gate, the outbound chat check.
// Shared by the single-session channel (server.ts) and the topic manager
// (manager.ts) — both apply exactly the same policy.

import type { Context } from 'grammy'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from 'fs'
import { join, sep } from 'path'

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  // delivery/UX config — optional, defaults live in the reply handler
  /** Emoji to react with on receipt. Empty string disables. Telegram only accepts its fixed whitelist. */
  ackReaction?: string
  /** Which chunks get Telegram's reply reference when reply_to is passed. Default: 'first'. 'off' = never thread. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: 4096 (Telegram's hard cap). */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of hard char count. */
  chunkMode?: 'length' | 'newline'
  /** Show Telegram's animated "Thinking…" draft in DMs while Claude works. Default: true. */
  thinkingDraft?: boolean
  /** Play long replies into a draft before sending them (cosmetic streaming). Default: false. */
  streamReplies?: boolean
}

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

export type AccessStore = ReturnType<typeof createAccessStore>

export function createAccessStore(opts: {
  stateDir: string
  isStatic: boolean
  botUsername: () => string
  log: (msg: string) => void
}) {
  const { stateDir, isStatic } = opts
  const accessFile = join(stateDir, 'access.json')

  function readAccessFile(): Access {
    try {
      const raw = readFileSync(accessFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<Access>
      return {
        dmPolicy: parsed.dmPolicy ?? 'pairing',
        allowFrom: parsed.allowFrom ?? [],
        groups: parsed.groups ?? {},
        pending: parsed.pending ?? {},
        mentionPatterns: parsed.mentionPatterns,
        ackReaction: parsed.ackReaction,
        replyToMode: parsed.replyToMode,
        textChunkLimit: parsed.textChunkLimit,
        chunkMode: parsed.chunkMode,
        thinkingDraft: parsed.thinkingDraft,
        streamReplies: parsed.streamReplies,
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
      try {
        renameSync(accessFile, `${accessFile}.corrupt-${Date.now()}`)
      } catch {}
      opts.log('access.json is corrupt, moved aside. Starting fresh.')
      return defaultAccess()
    }
  }

  // In static mode, access is snapshotted at boot and never re-read or written.
  // Pairing requires runtime mutation, so it's downgraded to allowlist with a
  // startup warning — handing out codes that never get approved would be worse.
  const bootAccess: Access | null = isStatic
    ? (() => {
        const a = readAccessFile()
        if (a.dmPolicy === 'pairing') {
          opts.log('static mode — dmPolicy "pairing" downgraded to "allowlist"')
          a.dmPolicy = 'allowlist'
        }
        a.pending = {}
        return a
      })()
    : null

  function loadAccess(): Access {
    return bootAccess ?? readAccessFile()
  }

  function saveAccess(a: Access): void {
    if (isStatic) return
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const tmp = accessFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, accessFile)
  }

  // Outbound gate — reply/react/edit can only target chats the inbound gate
  // would deliver from. Telegram DM chat_id == user_id, so allowFrom covers DMs.
  function assertAllowedChat(chat_id: string): void {
    const access = loadAccess()
    if (access.allowFrom.includes(chat_id)) return
    if (chat_id in access.groups) return
    throw new Error(`chat ${chat_id} is not allowlisted — add via /telegram:access`)
  }

  // reply's files param takes any path. .env is ~60 bytes and ships as a
  // document. Claude can already Read+paste file contents, so this isn't a new
  // exfil channel for arbitrary paths — but the server's own state is the one
  // thing Claude has no reason to ever send.
  function assertSendable(f: string): void {
    let real, stateReal: string
    try {
      real = realpathSync(f)
      stateReal = realpathSync(stateDir)
    } catch { return } // statSync will fail properly; or STATE_DIR absent → nothing to leak
    const inbox = join(stateReal, 'inbox')
    if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
      throw new Error(`refusing to send channel state: ${f}`)
    }
  }

  function gate(ctx: Context): GateResult {
    const access = loadAccess()
    const pruned = pruneExpired(access)
    if (pruned) saveAccess(access)

    if (access.dmPolicy === 'disabled') return { action: 'drop' }

    const from = ctx.from
    if (!from) return { action: 'drop' }
    const senderId = String(from.id)
    const chatType = ctx.chat?.type

    if (chatType === 'private') {
      if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
      if (access.dmPolicy === 'allowlist') return { action: 'drop' }

      // pairing mode — check for existing non-expired code for this sender
      for (const [code, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          // Reply twice max (initial + one reminder), then go silent.
          if ((p.replies ?? 1) >= 2) return { action: 'drop' }
          p.replies = (p.replies ?? 1) + 1
          saveAccess(access)
          return { action: 'pair', code, isResend: true }
        }
      }
      // Cap pending at 3. Extra attempts are silently dropped.
      if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

      const code = randomBytes(3).toString('hex') // 6 hex chars
      const now = Date.now()
      access.pending[code] = {
        senderId,
        chatId: String(ctx.chat!.id),
        createdAt: now,
        expiresAt: now + 60 * 60 * 1000, // 1h
        replies: 1,
      }
      saveAccess(access)
      return { action: 'pair', code, isResend: false }
    }

    if (chatType === 'group' || chatType === 'supergroup') {
      const groupId = String(ctx.chat!.id)
      const policy = access.groups[groupId]
      if (!policy) return { action: 'drop' }
      const groupAllowFrom = policy.allowFrom ?? []
      const requireMention = policy.requireMention ?? true
      if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
        return { action: 'drop' }
      }
      if (requireMention && !isMentioned(ctx, opts.botUsername(), access.mentionPatterns)) {
        return { action: 'drop' }
      }
      return { action: 'deliver', access }
    }

    return { action: 'drop' }
  }

  // Like gate() but for bot commands: no pairing side effects, just allow/drop.
  function dmCommandGate(ctx: Context): { access: Access; senderId: string } | null {
    if (ctx.chat?.type !== 'private') return null
    if (!ctx.from) return null
    const senderId = String(ctx.from.id)
    const access = loadAccess()
    const pruned = pruneExpired(access)
    if (pruned) saveAccess(access)
    if (access.dmPolicy === 'disabled') return null
    if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) return null
    return { access, senderId }
  }

  return { loadAccess, saveAccess, assertAllowedChat, assertSendable, gate, dmCommandGate }
}

export function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

export function isMentioned(ctx: Context, botUsername: string, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) {
      return true
    }
  }

  // Reply to one of our messages counts as an implicit mention.
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true

  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {
      // Invalid user-supplied regex — skip it.
    }
  }
  return false
}
