// Inbound side: grammy handlers for every message kind, the gate, pairing
// replies, permission-reply intercept, ack/typing/draft feedback, photo
// download and voice transcription. What happens to a delivered message is up
// to the caller: server.ts notifies its own Claude session, manager.ts routes
// it to the session of the topic it came from.

import type { Bot, Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AccessStore } from './access.ts'
import type { DraftManager } from './drafts.ts'
import type { Outbound } from './outbound.ts'
import { transcribe, toOggOpus, isOggOpus } from './stt.ts'

// Permission-reply spec from anthropics/claude-cli-internal
// src/services/mcp/channelPermissions.ts — inlined (no CC repo dep).
// 5 lowercase letters a-z minus 'l'. Case-insensitive for phone autocorrect.
// Strict: no bare yes/no (conversational), no prefix/suffix chatter.
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

export type Inbound = {
  ctx: Context
  chatId: string
  threadId?: number
  content: string
  meta: Record<string, string>
}

export type InboundDeps = {
  bot: Bot
  access: AccessStore
  drafts: DraftManager
  outbound: Outbound
  inboxDir: string
  log: (msg: string) => void
  /** Hand a gated, prepared message to Claude. */
  deliver: (msg: Inbound) => void | Promise<void>
  /** "yes abcde" / "no abcde" typed in a chat — answer a permission prompt. */
  onPermissionReply: (msg: { chatId: string; threadId?: number; request_id: string; behavior: 'allow' | 'deny' }) => void
}

// Filenames and titles are uploader-controlled. They land inside the <channel>
// notification — delimiter chars would let the uploader break out of the tag
// or forge a second meta entry.
export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

/** Topic of a message: forum topics in groups and topics in bot DMs (Bot API 9.3+). */
export function threadOf(ctx: Context): number | undefined {
  const m = ctx.message ?? ctx.callbackQuery?.message
  if (!m || m.message_thread_id == null) return undefined
  if ((m as { is_topic_message?: boolean }).is_topic_message) return m.message_thread_id
  // In bot DMs with topics every thread is a topic.
  if (m.chat.type === 'private') return m.message_thread_id
  return undefined
}

export function registerInbound(deps: InboundDeps): void {
  const { bot } = deps
  const warnedNoVoice = new Set<string>()

  bot.on('message:text', async ctx => {
    await handleInbound(ctx, ctx.message.text, undefined)
  })

  bot.on('message:photo', async ctx => {
    const caption = ctx.message.caption ?? '(photo)'
    // Defer download until after the gate approves — any user can send photos,
    // and we don't want to burn API quota or fill the inbox for dropped messages.
    await handleInbound(ctx, caption, async () => {
      // Largest size is last in the array.
      const photos = ctx.message.photo
      const best = photos[photos.length - 1]
      try {
        const { buf, filePath } = await deps.outbound.fetchFile(best.file_id)
        const ext = filePath.split('.').pop() ?? 'jpg'
        const path = join(deps.inboxDir, `${Date.now()}-${best.file_unique_id}.${ext}`)
        mkdirSync(deps.inboxDir, { recursive: true })
        writeFileSync(path, buf)
        return path
      } catch (err) {
        deps.log(`photo download failed: ${err}`)
        return undefined
      }
    })
  })

  bot.on('message:document', async ctx => {
    const doc = ctx.message.document
    const name = safeName(doc.file_name)
    const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
    await handleInbound(ctx, text, undefined, {
      kind: 'document',
      file_id: doc.file_id,
      size: doc.file_size,
      mime: doc.mime_type,
      name,
    })
  })

  bot.on('message:voice', async ctx => {
    const voice = ctx.message.voice
    const text = ctx.message.caption ?? '(voice message)'
    await handleInbound(ctx, text, undefined, {
      kind: 'voice',
      file_id: voice.file_id,
      size: voice.file_size,
      mime: voice.mime_type,
    })
  })

  bot.on('message:audio', async ctx => {
    const audio = ctx.message.audio
    const name = safeName(audio.file_name)
    const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
    await handleInbound(ctx, text, undefined, {
      kind: 'audio',
      file_id: audio.file_id,
      size: audio.file_size,
      mime: audio.mime_type,
      name,
    })
  })

  bot.on('message:video', async ctx => {
    const video = ctx.message.video
    const text = ctx.message.caption ?? '(video)'
    await handleInbound(ctx, text, undefined, {
      kind: 'video',
      file_id: video.file_id,
      size: video.file_size,
      mime: video.mime_type,
      name: safeName(video.file_name),
    })
  })

  bot.on('message:video_note', async ctx => {
    const vn = ctx.message.video_note
    await handleInbound(ctx, '(video note)', undefined, {
      kind: 'video_note',
      file_id: vn.file_id,
      size: vn.file_size,
    })
  })

  bot.on('message:sticker', async ctx => {
    const sticker = ctx.message.sticker
    const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
    await handleInbound(ctx, `(sticker${emoji})`, undefined, {
      kind: 'sticker',
      file_id: sticker.file_id,
      size: sticker.file_size,
    })
  })

  // Voice/audio → text. Returns the transcript, or an error string for meta.
  async function voiceToText(
    attachment: AttachmentMeta,
    chat_id: string,
    threadId: number | undefined,
  ): Promise<{ text?: string; error?: string }> {
    const apiKey = process.env.YANDEX_API_KEY
    if (!apiKey) {
      // Tell the human once per chat; Claude learns from voice_error.
      if (!warnedNoVoice.has(chat_id)) {
        warnedNoVoice.add(chat_id)
        void bot.api.sendMessage(
          chat_id,
          '🎙 Voice messages are not transcribed: voice recognition is not configured on the server (YANDEX_API_KEY is not set).',
          threadId != null ? { message_thread_id: threadId } : {},
        ).catch(() => {})
      }
      return { error: 'voice recognition not configured (YANDEX_API_KEY is not set)' }
    }
    try {
      const { buf, filePath } = await deps.outbound.fetchFile(attachment.file_id)
      const ext = filePath.includes('.') ? filePath.split('.').pop() : undefined
      const audio = isOggOpus(attachment.mime, ext) ? new Uint8Array(buf) : await toOggOpus(new Uint8Array(buf))
      const text = await transcribe(audio, {
        apiKey,
        language: process.env.YANDEX_LANGUAGE || 'ru-RU',
      })
      if (!text.trim()) return { error: 'no speech recognized' }
      return { text }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.log(`voice transcription failed: ${msg}`)
      return { error: `transcription failed: ${msg}`.slice(0, 300) }
    }
  }

  async function handleInbound(
    ctx: Context,
    text: string,
    downloadImage: (() => Promise<string | undefined>) | undefined,
    attachment?: AttachmentMeta,
  ): Promise<void> {
    const result = deps.access.gate(ctx)

    if (result.action === 'drop') return

    const threadId = threadOf(ctx)
    const threadOpt = threadId != null ? { message_thread_id: threadId } : {}

    if (result.action === 'pair') {
      const lead = result.isResend ? 'Still pending' : 'Pairing required'
      await ctx.reply(
        `${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`,
        threadOpt,
      )
      return
    }

    const access = result.access
    const from = ctx.from!
    const chat_id = String(ctx.chat!.id)
    const msgId = ctx.message?.message_id

    // Permission-reply intercept: if this looks like "yes xxxxx" for a
    // pending permission request, emit the structured event instead of
    // relaying as chat. The sender is already gate()-approved at this point
    // (non-allowlisted senders were dropped above), so we trust the reply.
    const permMatch = PERMISSION_REPLY_RE.exec(text)
    if (permMatch) {
      const allow = permMatch[1]!.toLowerCase().startsWith('y')
      deps.onPermissionReply({
        chatId: chat_id,
        threadId,
        request_id: permMatch[2]!.toLowerCase(),
        behavior: allow ? 'allow' : 'deny',
      })
      if (msgId != null) {
        void bot.api.setMessageReaction(chat_id, msgId, [
          { type: 'emoji', emoji: (allow ? '✅' : '❌') as ReactionTypeEmoji['emoji'] },
        ]).catch(() => {})
      }
      return
    }

    // Typing indicator — signals "processing" until we reply (or ~5s elapses).
    void bot.api.sendChatAction(chat_id, 'typing', threadOpt).catch(() => {})
    // In DMs, the animated "Thinking…" draft lasts until the reply instead.
    if (access.thinkingDraft === true) deps.drafts.thinking(chat_id, threadId)

    // Ack reaction — lets the user know we're processing. Fire-and-forget.
    // Telegram only accepts a fixed emoji whitelist — if the user configures
    // something outside that set the API rejects it and we swallow.
    if (access.ackReaction && msgId != null) {
      void bot.api
        .setMessageReaction(chat_id, msgId, [
          { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
        ])
        .catch(() => {})
    }

    const imagePath = downloadImage ? await downloadImage() : undefined

    let content = text
    const voiceMeta: Record<string, string> = {}
    if (attachment && (attachment.kind === 'voice' || attachment.kind === 'audio')) {
      const v = await voiceToText(attachment, chat_id, threadId)
      if (v.text) {
        const caption = ctx.message?.caption
        content = caption ? `${caption}\n\n${v.text}` : v.text
        voiceMeta.voice = 'true'
      } else {
        voiceMeta.voice_error = v.error ?? 'unknown error'
      }
    }

    // image_path goes in meta only — an in-content "[image attached — read: PATH]"
    // annotation is forgeable by any allowlisted sender typing that string.
    await deps.deliver({
      ctx,
      chatId: chat_id,
      threadId,
      content,
      meta: {
        chat_id,
        ...(msgId != null ? { message_id: String(msgId) } : {}),
        user: from.username ?? String(from.id),
        user_id: String(from.id),
        ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
        ...(imagePath ? { image_path: imagePath } : {}),
        ...(attachment ? {
          attachment_kind: attachment.kind,
          attachment_file_id: attachment.file_id,
          ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
          ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
          ...(attachment.name ? { attachment_name: attachment.name } : {}),
        } : {}),
        ...voiceMeta,
      },
    })
  }
}
