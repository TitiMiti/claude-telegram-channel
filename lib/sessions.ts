// Claude Code sessions in tmux, one per topic, on a dedicated tmux socket.
// tmux gives every session a real terminal (Claude Code is interactive), lets
// the owner attach to watch or answer a prompt, and keeps sessions alive
// across manager restarts — the channel inside reconnects on its own.

import { spawn } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ManagerConfig, TopicEntry } from './topics.ts'

export type ExecResult = { code: number; stdout: string; stderr: string }
export type Exec = (cmd: string, args: string[], env?: Record<string, string>) => Promise<ExecResult>

export const realExec: Exec = (cmd, args, env) =>
  new Promise(resolve => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', d => { stdout += d })
    p.stderr.on('data', d => { stderr += d })
    p.on('error', e => resolve({ code: -1, stdout, stderr: String(e) }))
    p.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
  })

// Credentials the manager holds that sessions have no business seeing.
const SECRET_ENV = ['TELEGRAM_BOT_TOKEN', 'YANDEX_API_KEY']

/**
 * Environment for the tmux server and everything in it: the manager's own
 * env minus its secrets, plus TELEGRAM_MANAGED=1 so a telegram plugin that is
 * also installed in this Claude config stays idle instead of polling.
 */
export function sessionEnv(base: Record<string, string | undefined>, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !SECRET_ENV.includes(k)) env[k] = v
  }
  // Inside tmux, TMUX would make nested tmux calls target the wrong server.
  delete env.TMUX
  return { ...env, ...extra, TELEGRAM_MANAGED: '1' }
}

export const CHANNEL_SERVER_NAME = 'telegram'

/** What tells server.ts it is the channel of this particular topic session. */
export function bindingEnv(entry: TopicEntry, opts: { socket: string; stateDir: string }): Record<string, string> {
  return {
    TELEGRAM_STATE_DIR: opts.stateDir,
    TELEGRAM_MANAGER_SOCKET: opts.socket,
    TELEGRAM_SESSION_KEY: entry.key,
    TELEGRAM_SESSION_TOKEN: entry.token,
  }
}

/** --mcp-config file that runs this repo's server.ts as the session's channel. */
export function mcpConfig(entry: TopicEntry, opts: { bun: string; serverTs: string; socket: string; stateDir: string }) {
  return {
    mcpServers: {
      [CHANNEL_SERVER_NAME]: {
        type: 'stdio',
        command: opts.bun,
        args: [opts.serverTs],
        env: bindingEnv(entry, opts),
      },
    },
  }
}

export function usesPlugin(cfg: Pick<ManagerConfig, 'channel'>): boolean {
  return cfg.channel.startsWith('plugin:')
}

/**
 * Claude Code arguments for a topic session. `mcpConfigPath` is only used in
 * "server" channel mode; in plugin mode the installed plugin is the channel.
 */
export function claudeArgs(
  cfg: Pick<ManagerConfig, 'claudeArgs' | 'channel'>,
  entry: TopicEntry,
  mcpConfigPath: string | undefined,
  resume: boolean,
): string[] {
  const plugin = usesPlugin(cfg)
  // Order matters: --mcp-config and the channels flag are variadic, so each is
  // followed by another option rather than by a bare argument.
  return [
    ...cfg.claudeArgs,
    ...(!plugin && mcpConfigPath ? ['--mcp-config', mcpConfigPath] : []),
    '--dangerously-load-development-channels', plugin ? cfg.channel : `server:${CHANNEL_SERVER_NAME}`,
    ...(resume ? ['--resume', entry.claudeSessionId] : ['--session-id', entry.claudeSessionId]),
  ]
}

export type PaneState = 'dev-channels' | 'trust' | 'bypass' | 'none'

/** Startup prompts Claude Code may block on, recognised from the pane text. */
export function detectPrompt(pane: string): PaneState {
  if (/Loading development channels|I am using this for local development/.test(pane)) return 'dev-channels'
  if (/Yes, I trust this folder|Quick safety check/i.test(pane)) return 'trust'
  if (/Bypass Permissions mode/.test(pane) && /Yes, I accept/.test(pane)) return 'bypass'
  return 'none'
}

export class Tmux {
  constructor(
    private cfg: Pick<ManagerConfig, 'tmuxSocket'>,
    private env: Record<string, string>,
    private exec: Exec = realExec,
  ) {}

  private run(args: string[]): Promise<ExecResult> {
    return this.exec('tmux', ['-L', this.cfg.tmuxSocket, ...args], this.env)
  }

  async alive(name: string): Promise<boolean> {
    return (await this.run(['has-session', '-t', `=${name}`])).code === 0
  }

  async start(name: string, cwd: string, command: string[], env: Record<string, string> = {}): Promise<void> {
    mkdirSync(cwd, { recursive: true })
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    const r = await this.run(['new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', cwd, ...envArgs, ...command])
    if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim() || r.code}`)
  }

  async stop(name: string): Promise<void> {
    await this.run(['kill-session', '-t', `=${name}`])
  }

  async capture(name: string): Promise<string> {
    const r = await this.run(['capture-pane', '-p', '-t', `=${name}:`])
    return r.code === 0 ? r.stdout : ''
  }

  async sendKeys(name: string, ...keys: string[]): Promise<void> {
    await this.run(['send-keys', '-t', `=${name}:`, ...keys])
  }

  attachHint(name: string): string {
    return `tmux -L ${this.cfg.tmuxSocket} attach -t ${name}`
  }
}

export function writeMcpConfig(dir: string, entry: TopicEntry, config: unknown): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${entry.tmux}.mcp.json`)
  // Contains the session's socket token — owner-only.
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  return path
}
