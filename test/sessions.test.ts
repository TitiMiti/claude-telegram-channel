import { describe, expect, test } from 'bun:test'
import { encode, LineDecoder, MAX_LINE } from '../lib/ipc.ts'
import { claudeArgs, sessionEnv, mcpConfig, detectPrompt, Tmux, type Exec } from '../lib/sessions.ts'
import { newEntry } from '../lib/topics.ts'

describe('ipc framing', () => {
  test('messages split across chunks, several per chunk', () => {
    const dec = new LineDecoder<any>()
    const wire = encode({ type: 'ready' }) + encode({ type: 'inbound', content: 'привет', meta: { chat_id: '1' } })
    const bytes = new TextEncoder().encode(wire)
    // Cut inside the multi-byte Cyrillic text.
    const cut = wire.indexOf('привет') + 3
    const a = dec.push(bytes.slice(0, cut))
    const b = dec.push(bytes.slice(cut))
    expect(a).toEqual([{ type: 'ready' }])
    expect(b).toEqual([{ type: 'inbound', content: 'привет', meta: { chat_id: '1' } }])
  })

  test('malformed lines are skipped', () => {
    const dec = new LineDecoder<any>()
    expect(dec.push('{bad\n\n{"type":"ready"}\n')).toEqual([{ type: 'ready' }])
  })

  test('an endless line is refused', () => {
    const dec = new LineDecoder<any>()
    expect(() => dec.push('x'.repeat(MAX_LINE + 1))).toThrow()
  })
})

describe('session launch', () => {
  const entry = newEntry('42', 7, 'alpha', '/w/alpha')

  test('first launch pins the session id, later ones resume it', () => {
    const first = claudeArgs({ claudeArgs: ['--dangerously-skip-permissions'], channel: 'server' }, entry, '/s/x.mcp.json', false)
    expect(first).toEqual([
      '--dangerously-skip-permissions',
      '--mcp-config', '/s/x.mcp.json',
      '--dangerously-load-development-channels', 'server:telegram',
      '--session-id', entry.claudeSessionId,
    ])
    const again = claudeArgs({ claudeArgs: [], channel: 'server' }, entry, '/s/x.mcp.json', true)
    expect(again.slice(-2)).toEqual(['--resume', entry.claudeSessionId])
  })

  test('plugin channel mode: no --mcp-config, the plugin is the dev channel', () => {
    const args = claudeArgs({ claudeArgs: [], channel: 'plugin:telegram@titimiti-telegram' }, entry, undefined, false)
    expect(args).toEqual([
      '--dangerously-load-development-channels', 'plugin:telegram@titimiti-telegram',
      '--session-id', entry.claudeSessionId,
    ])
  })

  test('mcp config runs server.ts with the session binding', () => {
    const c = mcpConfig(entry, { bun: '/bin/bun', serverTs: '/repo/server.ts', socket: '/st/manager.sock', stateDir: '/st' })
    expect(c.mcpServers.telegram.command).toBe('/bin/bun')
    expect(c.mcpServers.telegram.args).toEqual(['/repo/server.ts'])
    expect(c.mcpServers.telegram.env).toEqual({
      TELEGRAM_STATE_DIR: '/st',
      TELEGRAM_MANAGER_SOCKET: '/st/manager.sock',
      TELEGRAM_SESSION_KEY: '42:7',
      TELEGRAM_SESSION_TOKEN: entry.token,
    })
  })

  test('sessions never inherit the bot token or the Yandex key', () => {
    const env = sessionEnv(
      { PATH: '/bin', HOME: '/h', TELEGRAM_BOT_TOKEN: '1:x', YANDEX_API_KEY: 'y', TMUX: '/tmp/t,1,0' },
      { FOO: 'bar' },
    )
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', FOO: 'bar', TELEGRAM_MANAGED: '1' })
  })

  test('startup prompts are recognised', () => {
    expect(detectPrompt('WARNING: Loading development channels\n❯ 1. I am using this for local development')).toBe('dev-channels')
    expect(detectPrompt('Quick safety check: Is this a project you created or one you trust?\n Yes, I trust this folder')).toBe('trust')
    expect(detectPrompt('In Bypass Permissions mode, Claude Code will not ask...\n 2. Yes, I accept')).toBe('bypass')
    expect(detectPrompt('╭───╮\n│ > │\n╰───╯')).toBe('none')
  })

  test('tmux commands go to the dedicated socket with the clean env', async () => {
    const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = []
    const exec: Exec = async (cmd, args, env) => {
      calls.push({ cmd, args, env })
      return { code: args.includes('has-session') ? 1 : 0, stdout: 'pane text', stderr: '' }
    }
    const t = new Tmux({ tmuxSocket: 'sock' }, { TELEGRAM_MANAGED: '1' }, exec)
    expect(await t.alive('tg-42-7')).toBe(false)
    await t.start('tg-42-7', '/tmp', ['claude', '--x'], { A: '1' })
    expect(await t.capture('tg-42-7')).toBe('pane text')
    await t.sendKeys('tg-42-7', 'Enter')
    await t.stop('tg-42-7')
    expect(calls.map(c => c.args)).toEqual([
      ['-L', 'sock', 'has-session', '-t', '=tg-42-7'],
      ['-L', 'sock', 'new-session', '-d', '-s', 'tg-42-7', '-x', '200', '-y', '50', '-c', '/tmp', '-e', 'A=1', 'claude', '--x'],
      ['-L', 'sock', 'capture-pane', '-p', '-t', '=tg-42-7:'],
      ['-L', 'sock', 'send-keys', '-t', '=tg-42-7:', 'Enter'],
      ['-L', 'sock', 'kill-session', '-t', '=tg-42-7'],
    ])
    expect(calls.every(c => c.cmd === 'tmux' && c.env?.TELEGRAM_MANAGED === '1')).toBe(true)
    expect(t.attachHint('tg-42-7')).toBe('tmux -L sock attach -t tg-42-7')
  })
})
