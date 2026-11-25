// Shared paths and .env loading for server.ts (channel) and manager.ts.

import { readFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'telegram')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const PID_FILE = join(STATE_DIR, 'bot.pid')
export const MANAGER_SOCKET = join(STATE_DIR, 'manager.sock')
export const MANAGER_PID_FILE = join(STATE_DIR, 'manager.pid')
export const TOPICS_FILE = join(STATE_DIR, 'topics.json')
export const MANAGER_CONFIG_FILE = join(STATE_DIR, 'manager.json')
export const SESSIONS_DIR = join(STATE_DIR, 'sessions')

// Load ~/.claude/channels/telegram/.env into process.env. Real env wins.
// Plugin-spawned servers don't get an env block — this is where the token lives
// (and YANDEX_API_KEY for voice, if you keep it here).
export function loadEnvFile(): void {
  try {
    // Token is a credential — lock to owner. No-op on Windows (would need ACLs).
    chmodSync(ENV_FILE, 0o600)
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
}

/** Bot API base URL: TELEGRAM_API_ROOT for a self-hosted Bot API server (or tests). */
export function apiRoot(): string {
  return (process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org').replace(/\/+$/, '')
}

export function log(prefix: string, msg: string): void {
  process.stderr.write(`${prefix}: ${msg}\n`)
}
