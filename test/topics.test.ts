import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import {
  slugify, parseNewCommand, resolveCwd, route, TopicStore, newEntry, topicKey, tmuxName, loadConfig,
} from '../lib/topics.ts'
import { threadOf } from '../lib/inbound.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-topics-'))
})

describe('slugify', () => {
  test('keeps letters of any script, turns spaces into dashes', () => {
    expect(slugify('Мой проект 2')).toBe('Мой-проект-2')
    expect(slugify('  YouChip  ')).toBe('YouChip')
  })
  test('no path tricks', () => {
    expect(slugify('../../etc/passwd')).toBe('etcpasswd')
    expect(slugify('.hidden')).toBe('hidden')
    expect(slugify('a/b\\c')).toBe('abc')
  })
  test('falls back when nothing is left', () => {
    expect(slugify('🔥🔥')).toBe('topic')
    expect(slugify('')).toBe('topic')
  })
})

describe('parseNewCommand', () => {
  test('name only', () => {
    expect(parseNewCommand('Big refactor')).toEqual({ name: 'Big refactor', dir: undefined })
  })
  test('trailing path is the folder', () => {
    expect(parseNewCommand('ESSE site ~/workspace/ESSE')).toEqual({ name: 'ESSE site', dir: '~/workspace/ESSE' })
    expect(parseNewCommand('x /srv/app')).toEqual({ name: 'x', dir: '/srv/app' })
    expect(parseNewCommand('x ./sub')).toEqual({ name: 'x', dir: './sub' })
  })
  test('a lone path-looking word is a name', () => {
    expect(parseNewCommand('/srv')).toEqual({ name: '/srv', dir: undefined })
  })
  test('empty → usage', () => {
    expect('error' in parseNewCommand('   ')).toBe(true)
  })
})

describe('resolveCwd', () => {
  test('default is <root>/<slug>', () => {
    expect(resolveCwd(dir, 'New thing')).toBe(join(dir, 'New-thing'))
  })
  test('reuses an existing folder regardless of case', () => {
    mkdirSync(join(dir, 'YouChip'))
    expect(resolveCwd(dir, 'youchip')).toBe(join(dir, 'YouChip'))
  })
  test('explicit folder: absolute, ~ and relative to root', () => {
    expect(resolveCwd(dir, 'n', '/srv/x')).toBe('/srv/x')
    expect(resolveCwd(dir, 'n', '~/w')).toBe(join(homedir(), 'w'))
    expect(resolveCwd(dir, 'n', './a/b')).toBe(join(dir, 'a/b'))
  })
})

describe('route (message_thread_id → session)', () => {
  const cfg = { autoCreateSessions: true, mainSession: true }

  test('known topic goes to its session', () => {
    const store = new TopicStore(join(dir, 'topics.json'))
    const e = newEntry('42', 7, 'alpha', join(dir, 'alpha'))
    store.put(e)
    store.put(newEntry('42', 8, 'beta', join(dir, 'beta')))
    const r = route(store, cfg, '42', 7)
    expect(r.kind).toBe('session')
    expect(r.kind === 'session' && r.entry.name).toBe('alpha')
    const r2 = route(store, cfg, '42', 8)
    expect(r2.kind === 'session' && r2.entry.name).toBe('beta')
  })

  test('same thread id in another chat is a different session', () => {
    const store = new TopicStore(join(dir, 'topics.json'))
    store.put(newEntry('42', 7, 'alpha', dir))
    expect(route(store, cfg, '43', 7).kind).toBe('create')
  })

  test('unknown topic → create, named after the topic', () => {
    const store = new TopicStore(join(dir, 'topics.json'))
    expect(route(store, cfg, '42', 9, 'Ideas')).toEqual({ kind: 'create', name: 'Ideas', threadId: 9 })
    expect(route(store, cfg, '42', 9)).toEqual({ kind: 'create', name: 'topic-9', threadId: 9 })
  })

  test('unknown topic without auto-create → reject', () => {
    const store = new TopicStore(join(dir, 'topics.json'))
    expect(route(store, { ...cfg, autoCreateSessions: false }, '42', 9).kind).toBe('reject')
  })

  test('no topic → main session, unless disabled', () => {
    const store = new TopicStore(join(dir, 'topics.json'))
    expect(route(store, cfg, '42', undefined)).toEqual({ kind: 'create', name: 'main' })
    store.put(newEntry('42', undefined, 'main', dir))
    expect(route(store, cfg, '42', undefined).kind).toBe('session')
    const empty = new TopicStore(join(dir, 'other.json'))
    expect(route(empty, { ...cfg, mainSession: false }, '42', undefined).kind).toBe('reject')
  })
})

describe('TopicStore', () => {
  test('persists, owner-only, survives reload', () => {
    const file = join(dir, 'state', 'topics.json')
    const store = new TopicStore(file)
    const e = newEntry('42', 7, 'alpha', dir)
    store.put(e)
    store.update(e.key, { stopped: true })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const again = new TopicStore(file)
    expect(again.get(topicKey('42', 7))?.stopped).toBe(true)
    expect(again.byName('42', 'ALPHA')?.key).toBe('42:7')
    expect(again.byName('42', '7')?.key).toBe('42:7')
    again.remove(e.key)
    expect(new TopicStore(file).all()).toEqual([])
  })

  test('corrupt file is moved aside', () => {
    const file = join(dir, 'topics.json')
    writeFileSync(file, '{nope')
    expect(new TopicStore(file).all()).toEqual([])
  })

  test('entries get unique tokens and session ids, tmux-safe names', () => {
    const a = newEntry('-100123', 5, 'x', dir)
    const b = newEntry('-100123', 6, 'x', dir)
    expect(a.token).not.toBe(b.token)
    expect(a.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(a.tmux).toBe('tg--100123-5')
    expect(tmuxName('1', undefined)).toBe('tg-1-main')
  })
})

describe('loadConfig', () => {
  test('defaults, file overrides, env root wins', () => {
    const file = join(dir, 'manager.json')
    expect(loadConfig(file, {}).claudeArgs).toEqual(['--dangerously-skip-permissions'])
    writeFileSync(file, JSON.stringify({ workspaceRoot: '~/ws', mainSession: false, claudeArgs: [] }))
    const c = loadConfig(file, {})
    expect(c.workspaceRoot).toBe(join(homedir(), 'ws'))
    expect(c.mainSession).toBe(false)
    expect(c.claudeArgs).toEqual([])
    expect(loadConfig(file, { TELEGRAM_WORKSPACE_ROOT: '/srv/w' }).workspaceRoot).toBe('/srv/w')
  })
  test('broken file is an error, not silent defaults', () => {
    const file = join(dir, 'manager.json')
    writeFileSync(file, '{')
    expect(() => loadConfig(file, {})).toThrow()
  })
})

describe('threadOf', () => {
  const ctx = (m: Record<string, unknown>) => ({ message: m }) as never
  test('topic in a bot DM', () => {
    expect(threadOf(ctx({ message_thread_id: 12, is_topic_message: true, chat: { type: 'private' } }))).toBe(12)
    expect(threadOf(ctx({ message_thread_id: 12, chat: { type: 'private' } }))).toBe(12)
  })
  test('reply thread in a plain group is not a topic', () => {
    expect(threadOf(ctx({ message_thread_id: 12, chat: { type: 'supergroup' } }))).toBeUndefined()
    expect(threadOf(ctx({ message_thread_id: 12, is_topic_message: true, chat: { type: 'supergroup' } }))).toBe(12)
  })
  test('no thread', () => {
    expect(threadOf(ctx({ chat: { type: 'private' } }))).toBeUndefined()
  })
})
