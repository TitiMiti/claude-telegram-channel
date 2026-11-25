// Topic → session bookkeeping for the manager: config, the topics.json state
// file, folder naming and the routing decision for an incoming message.

import { randomBytes, randomUUID } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, resolve } from 'path'

export type TopicEntry = {
  /** `${chatId}:${threadId}` or `${chatId}:main` for messages outside topics. */
  key: string
  chatId: string
  threadId?: number
  name: string
  cwd: string
  /** tmux session name on the manager's tmux socket. */
  tmux: string
  /** Claude Code session id: --session-id on first launch, --resume afterwards. */
  claudeSessionId: string
  launched: boolean
  /** Shared secret the session's channel presents on the socket. */
  token: string
  createdAt: number
  stopped?: boolean
}

export type ManagerConfig = {
  /** New topics get <workspaceRoot>/<topic name> unless /new names a folder. */
  workspaceRoot: string
  claudeCommand: string
  /** Extra args for every session, e.g. ["--dangerously-skip-permissions"]. */
  claudeArgs: string[]
  /**
   * Which channel the sessions load: "server" — this checkout's server.ts via
   * --mcp-config (default, always the manager's own version); or an installed
   * plugin, e.g. "plugin:telegram@titimiti-telegram".
   */
  channel: string
  /** Accept Claude Code's "Loading development channels" prompt automatically. */
  autoConfirmDevChannels: boolean
  /** A message in a topic the manager doesn't know yet starts a session for it. */
  autoCreateSessions: boolean
  /** Messages outside any topic go to a session in workspaceRoot. */
  mainSession: boolean
  /** tmux -L socket name; sessions live there and survive manager restarts. */
  tmuxSocket: string
  /** Extra environment for sessions. */
  sessionEnv: Record<string, string>
  /** Messages kept per session while it starts up / reconnects. */
  queueLimit: number
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

export function defaultConfig(): ManagerConfig {
  return {
    workspaceRoot: join(homedir(), 'workspace'),
    claudeCommand: 'claude',
    claudeArgs: ['--dangerously-skip-permissions'],
    channel: 'server',
    autoConfirmDevChannels: true,
    autoCreateSessions: true,
    mainSession: true,
    tmuxSocket: 'claude-telegram',
    sessionEnv: {},
    queueLimit: 50,
  }
}

/** manager.json (all keys optional) over defaults; TELEGRAM_WORKSPACE_ROOT wins for the root. */
export function loadConfig(file: string, env: Record<string, string | undefined> = process.env): ManagerConfig {
  const cfg = defaultConfig()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ManagerConfig>
    for (const k of Object.keys(cfg) as Array<keyof ManagerConfig>) {
      if (raw[k] !== undefined) (cfg as Record<string, unknown>)[k] = raw[k]
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`cannot read ${file}: ${err instanceof Error ? err.message : err}`)
    }
  }
  if (env.TELEGRAM_WORKSPACE_ROOT) cfg.workspaceRoot = env.TELEGRAM_WORKSPACE_ROOT
  cfg.workspaceRoot = resolve(expandHome(cfg.workspaceRoot))
  return cfg
}

export function topicKey(chatId: string | number, threadId?: number): string {
  return `${chatId}:${threadId ?? 'main'}`
}

/**
 * Folder name for a topic: keeps letters (any script), digits, - _ . ;
 * spaces become dashes; no path separators, no leading dots.
 */
export function slugify(name: string): string {
  const s = name
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 64)
  return s || 'topic'
}

/** Reuse an existing folder that differs only in case ("youchip" → YouChip). */
export function findExistingDir(root: string, slug: string): string | undefined {
  try {
    for (const e of readdirSync(root)) {
      if (e.toLowerCase() === slug.toLowerCase() && statSync(join(root, e)).isDirectory()) return join(root, e)
    }
  } catch {}
  return undefined
}

export function resolveCwd(root: string, name: string, dir?: string): string {
  if (dir) {
    const d = expandHome(dir)
    return isAbsolute(d) ? resolve(d) : resolve(root, d)
  }
  const slug = slugify(name)
  return findExistingDir(root, slug) ?? join(root, slug)
}

/**
 * `/new <name> [folder]` — the folder is the last word when it looks like a
 * path (starts with /, ~, ./ or ../).
 */
export function parseNewCommand(args: string): { name: string; dir?: string } | { error: string } {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { error: 'usage: /new <topic name> [folder]' }
  let dir: string | undefined
  const last = words[words.length - 1]
  if (words.length > 1 && /^(\/|~|\.\.?\/)/.test(last)) {
    dir = last
    words.pop()
  }
  const name = words.join(' ').slice(0, 128)
  return { name, dir }
}

export function tmuxName(chatId: string, threadId?: number): string {
  // tmux forbids '.' and ':' in session names.
  return `tg-${chatId}-${threadId ?? 'main'}`.replace(/[^A-Za-z0-9_-]/g, '_')
}

export function newEntry(chatId: string, threadId: number | undefined, name: string, cwd: string): TopicEntry {
  return {
    key: topicKey(chatId, threadId),
    chatId,
    ...(threadId != null ? { threadId } : {}),
    name,
    cwd,
    tmux: tmuxName(chatId, threadId),
    claudeSessionId: randomUUID(),
    launched: false,
    token: randomBytes(24).toString('hex'),
    createdAt: Date.now(),
  }
}

export class TopicStore {
  private topics: Record<string, TopicEntry> = {}

  constructor(private file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { topics?: Record<string, TopicEntry> }
      this.topics = raw.topics ?? {}
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      }
    }
  }

  get(key: string): TopicEntry | undefined {
    return this.topics[key]
  }

  all(): TopicEntry[] {
    return Object.values(this.topics).sort((a, b) => a.createdAt - b.createdAt)
  }

  byName(chatId: string, name: string): TopicEntry | undefined {
    const n = name.trim().toLowerCase()
    return this.all().find(t => t.chatId === chatId && (t.name.toLowerCase() === n || String(t.threadId) === n))
  }

  put(entry: TopicEntry): void {
    this.topics[entry.key] = entry
    this.save()
  }

  update(key: string, patch: Partial<TopicEntry>): TopicEntry | undefined {
    const t = this.topics[key]
    if (!t) return undefined
    Object.assign(t, patch)
    this.save()
    return t
  }

  remove(key: string): void {
    delete this.topics[key]
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = this.file + '.tmp'
    // Holds per-session socket tokens — owner-only.
    writeFileSync(tmp, JSON.stringify({ topics: this.topics }, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

export type Route =
  | { kind: 'session'; entry: TopicEntry }
  | { kind: 'create'; name: string; threadId?: number }
  | { kind: 'reject'; reason: string }

/**
 * Where does a delivered message go? Known topic → its session. Unknown topic
 * → a new session named after the topic (if autoCreateSessions). No topic →
 * the main session (if mainSession).
 */
export function route(
  store: TopicStore,
  cfg: Pick<ManagerConfig, 'autoCreateSessions' | 'mainSession'>,
  chatId: string,
  threadId: number | undefined,
  topicName?: string,
): Route {
  const entry = store.get(topicKey(chatId, threadId))
  if (entry) return { kind: 'session', entry }
  if (threadId == null) {
    return cfg.mainSession
      ? { kind: 'create', name: 'main' }
      : { kind: 'reject', reason: 'Messages outside topics are not routed. Create a topic with /new <name>.' }
  }
  if (!cfg.autoCreateSessions) {
    return { kind: 'reject', reason: 'This topic has no session. Create one with /new <name>.' }
  }
  return { kind: 'create', name: topicName?.trim() || `topic-${threadId}`, threadId }
}
