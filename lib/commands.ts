// Bot commands shared by both modes (/start, /help, /status) and the pairing
// confirmation poller.

import type { Bot } from 'grammy'
import { readdirSync, rmSync } from 'fs'
import { join } from 'path'
import type { AccessStore } from './access.ts'
import { threadOf } from './inbound.ts'

// Commands are DM-only. Responding in groups would: (1) leak pairing codes via
// /status to other group members, (2) confirm bot presence in non-allowlisted
// groups, (3) spam channels the operator never approved. Silent drop matches
// the gate's behavior for unrecognized groups.

export function registerBasicCommands(bot: Bot, access: AccessStore, extraHelp = ''): void {
  bot.command('start', async ctx => {
    if (!access.dmCommandGate(ctx)) return
    await ctx.reply(
      `This bot bridges Telegram to a Claude Code session.\n\n` +
      `To pair:\n` +
      `1. DM me anything — you'll get a 6-char code\n` +
      `2. In Claude Code: /telegram:access pair <code>\n\n` +
      `After that, DMs here reach that session.`,
      threadOpt(threadOf(ctx)),
    )
  })

  bot.command('help', async ctx => {
    if (!access.dmCommandGate(ctx)) return
    await ctx.reply(
      `Messages you send here route to a paired Claude Code session. ` +
      `Text, photos and voice messages (transcribed) are forwarded; replies and reactions come back.\n\n` +
      `/start — pairing instructions\n` +
      `/status — check your pairing state` +
      extraHelp,
      threadOpt(threadOf(ctx)),
    )
  })

  bot.command('status', async ctx => {
    const gated = access.dmCommandGate(ctx)
    if (!gated) return
    const { access: a, senderId } = gated
    const opt = threadOpt(threadOf(ctx))

    if (a.allowFrom.includes(senderId)) {
      const name = ctx.from!.username ? `@${ctx.from!.username}` : senderId
      await ctx.reply(`Paired as ${name}.`, opt)
      return
    }

    for (const [code, p] of Object.entries(a.pending)) {
      if (p.senderId === senderId) {
        await ctx.reply(
          `Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}`,
          opt,
        )
        return
      }
    }

    await ctx.reply(`Not paired. Send me a message to get a pairing code.`, opt)
  })
}

export function threadOpt(threadId: number | undefined): { message_thread_id?: number } {
  return threadId != null ? { message_thread_id: threadId } : {}
}

// The /telegram:access skill drops a file at approved/<senderId> when it pairs
// someone. Poll for it, send confirmation, clean up. For Telegram DMs,
// chatId == senderId, so we can send directly without stashing chatId.

export function checkApprovals(bot: Bot, approvedDir: string, log: (msg: string) => void): void {
  let files: string[]
  try {
    files = readdirSync(approvedDir)
  } catch {
    return
  }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(approvedDir, senderId)
    void bot.api.sendMessage(senderId, "Paired! Say hi to Claude.").then(
      () => rmSync(file, { force: true }),
      err => {
        log(`failed to send approval confirm: ${err}`)
        // Remove anyway — don't loop on a broken send.
        rmSync(file, { force: true })
      },
    )
  }
}
