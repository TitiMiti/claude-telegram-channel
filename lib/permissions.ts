// Permission relay: Claude Code asks "may I run X?", we post it to Telegram
// with Allow/Deny buttons, the answer goes back as a structured event.
// The caller decides where prompts go and where answers are routed (the
// single session, or the topic session that asked).

import { InlineKeyboard, type Bot } from 'grammy'
import type { AccessStore } from './access.ts'

export type PermissionRequest = {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export type Behavior = 'allow' | 'deny'

export function createPermissions(deps: {
  bot: Bot
  access: AccessStore
  log: (msg: string) => void
  /** An allowlisted user pressed Allow/Deny. `owner` is what request() was given. */
  onDecision: (request_id: string, behavior: Behavior, owner: string | undefined) => void
}) {
  const { bot } = deps
  // Stores full permission details for "See more" expansion keyed by request_id.
  const pending = new Map<string, PermissionRequest & { owner?: string }>()

  function request(
    req: PermissionRequest,
    targets: Array<{ chatId: string; threadId?: number }>,
    owner?: string,
  ): void {
    pending.set(req.request_id, { ...req, owner })
    const text = `🔐 Permission: ${req.tool_name}`
    const keyboard = new InlineKeyboard()
      .text('See more', `perm:more:${req.request_id}`)
      .text('✅ Allow', `perm:allow:${req.request_id}`)
      .text('❌ Deny', `perm:deny:${req.request_id}`)
    for (const t of targets) {
      void bot.api.sendMessage(t.chatId, text, {
        reply_markup: keyboard,
        ...(t.threadId != null ? { message_thread_id: t.threadId } : {}),
      }).catch(e => {
        deps.log(`permission_request send to ${t.chatId} failed: ${e}`)
      })
    }
  }

  function ownerOf(request_id: string): string | undefined {
    return pending.get(request_id)?.owner
  }

  function forget(request_id: string): void {
    pending.delete(request_id)
  }

  // Inline-button handler for permission requests. Callback data is
  // `perm:allow:<id>`, `perm:deny:<id>`, or `perm:more:<id>`.
  // Security mirrors the text-reply path: allowFrom must contain the sender.
  bot.on('callback_query:data', async ctx => {
    const data = ctx.callbackQuery.data
    const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
    if (!m) {
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    const access = deps.access.loadAccess()
    const senderId = String(ctx.from.id)
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const [, behavior, request_id] = m

    if (behavior === 'more') {
      const details = pending.get(request_id)
      if (!details) {
        await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
        return
      }
      const { tool_name, description, input_preview } = details
      let prettyInput: string
      try {
        prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
      } catch {
        prettyInput = input_preview
      }
      const expanded =
        `🔐 Permission: ${tool_name}\n\n` +
        `tool_name: ${tool_name}\n` +
        `description: ${description}\n` +
        `input_preview:\n${prettyInput}`
      const keyboard = new InlineKeyboard()
        .text('✅ Allow', `perm:allow:${request_id}`)
        .text('❌ Deny', `perm:deny:${request_id}`)
      await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    const owner = ownerOf(request_id)
    deps.onDecision(request_id, behavior as Behavior, owner)
    pending.delete(request_id)
    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    await ctx.answerCallbackQuery({ text: label }).catch(() => {})
    // Replace buttons with the outcome so the same request can't be answered
    // twice and the chat history shows what was chosen.
    const msg = ctx.callbackQuery.message
    if (msg && 'text' in msg && msg.text) {
      await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
    }
  })

  return { request, ownerOf, forget }
}
