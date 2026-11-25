import { describe, expect, test } from 'bun:test'
import { DraftManager, draftText, playbackFrames, isPrivateChatId, DRAFT_MAX, type Timers } from '../lib/drafts.ts'

// Manual clock: timers fire only when the test advances time.
function fakeTimers() {
  let now = 1_000_000
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq
      pending.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: t => { pending.delete(t as number) },
    sleep: async ms => { now += ms },
  }
  function advance(ms: number) {
    const end = now + ms
    for (;;) {
      const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > end) break
      pending.delete(next[0])
      now = next[1].at
      next[1].fn()
    }
    now = end
  }
  return { timers, advance, pending }
}

type Sent = { chat: number; draft: number; text: string; other?: Record<string, unknown> }

function setup(opts: { fail?: Error; canStop?: boolean } = {}) {
  const sent: Sent[] = []
  const t = fakeTimers()
  const logs: string[] = []
  const api = {
    sendMessageDraft: async (chat: number, draft: number, text: string, other?: Record<string, unknown>) => {
      sent.push({ chat, draft, text, other })
      if (opts.fail) throw opts.fail
      return true
    },
  }
  let id = 100
  const dm = new DraftManager(api, {
    timers: t.timers, keepAliveMs: 20_000, maxTurnMs: 60_000, throttleMs: 1000,
    randomId: () => ++id, log: m => logs.push(m), canStop: opts.canStop,
  })
  return { dm, sent, ...t, logs }
}

describe('thinking draft', () => {
  test('empty text ("Thinking…") in the right topic, refreshed until finish', () => {
    const { dm, sent, advance } = setup()
    dm.thinking('42', 7)
    expect(sent).toEqual([{ chat: 42, draft: 101, text: '', other: { message_thread_id: 7 } }])
    advance(20_000)
    expect(sent.length).toBe(2)
    expect(sent[1].draft).toBe(101) // same draft → animated, not replaced
    dm.finish('42', 7)
    advance(100_000)
    expect(sent.length).toBe(2)
  })

  test('gives up after maxTurnMs', () => {
    const { dm, sent, advance } = setup()
    dm.thinking(42)
    advance(10 * 60_000)
    // 0, 20, 40, 60 s → stops refreshing at the 60 s cap
    expect(sent.length).toBe(4)
    expect(dm.active(42)).toBeUndefined()
  })

  test('groups and channels never get drafts', () => {
    const { dm, sent } = setup()
    dm.thinking('-100123', 3)
    expect(dm.update('-100123', 3, 'x')).toBe(false)
    expect(sent).toEqual([])
    expect(isPrivateChatId('@name')).toBe(false)
  })

  test('topics are independent; finishChat ends them all', () => {
    const { dm, advance, sent } = setup()
    dm.thinking(42, 1)
    dm.thinking(42, 2)
    expect(new Set(sent.map(s => s.draft)).size).toBe(2)
    dm.finish(42, 1)
    expect(dm.active(42, 1)).toBeUndefined()
    expect(dm.active(42, 2)).toBeDefined()
    dm.finishChat(42)
    expect(dm.active(42, 2)).toBeUndefined()
    advance(60_000)
    expect(sent.length).toBe(2)
  })

  test('stop button flag', () => {
    const { dm, sent } = setup({ canStop: true })
    dm.thinking(42)
    expect(sent[0].other).toEqual({ can_stop: true })
  })
})

describe('stream updates', () => {
  test('throttled, the last text always lands, same draft id as thinking', () => {
    const { dm, sent, advance } = setup()
    dm.thinking(42)
    dm.update(42, undefined, 'a')       // within 1 s of thinking → deferred
    dm.update(42, undefined, 'ab')
    dm.update(42, undefined, 'abc')
    expect(sent.map(s => s.text)).toEqual([''])
    advance(1000)
    expect(sent.map(s => s.text)).toEqual(['', 'abc'])
    advance(1500)
    dm.update(42, undefined, 'abcd')    // throttle window passed → immediate
    expect(sent.map(s => s.text)).toEqual(['', 'abc', 'abcd'])
    expect(new Set(sent.map(s => s.draft))).toEqual(new Set([101]))
  })

  test('keep-alive re-sends the latest text', () => {
    const { dm, sent, advance } = setup()
    dm.update(42, 5, 'partial answer')
    advance(20_000)
    expect(sent.map(s => s.text)).toEqual(['partial answer', 'partial answer'])
  })

  test('thinking does not wipe partial text', () => {
    const { dm, sent } = setup()
    dm.update(42, undefined, 'partial')
    dm.thinking(42)
    expect(sent.map(s => s.text)).toEqual(['partial'])
  })

  test('finish cancels a pending trailing update', () => {
    const { dm, sent, advance } = setup()
    dm.update(42, undefined, 'a')
    dm.update(42, undefined, 'ab')
    dm.finish(42)
    advance(5000)
    expect(sent.map(s => s.text)).toEqual(['a'])
  })

  test('a failed draft kills the turn; "not found" disables drafts', async () => {
    const { dm, sent, advance, logs } = setup({ fail: new Error('Call to sendMessageDraft failed! (404: Not Found: method not found)') })
    dm.thinking(42)
    await Bun.sleep(0)
    advance(60_000)
    expect(sent.length).toBe(1)
    expect(logs[0]).toContain('drafts disabled')
    expect(dm.update(42, undefined, 'x')).toBe(false)
  })

  test('stopped() matches chat, topic and draft id', () => {
    const { dm } = setup()
    dm.thinking(42, 3)
    expect(dm.stopped(42, 3, 999)).toBe(false)
    expect(dm.stopped(42, undefined, 101)).toBe(false)
    expect(dm.stopped(42, 3, 101)).toBe(true)
    expect(dm.active(42, 3)).toBeUndefined()
  })
})

describe('helpers', () => {
  test('long text shows its tail within the 4096 limit', () => {
    const long = 'x'.repeat(5000) + 'END'
    const d = draftText(long)
    expect(d.length).toBe(DRAFT_MAX)
    expect(d.startsWith('…')).toBe(true)
    expect(d.endsWith('END')).toBe(true)
    expect(draftText('short')).toBe('short')
  })

  test('playback frames grow at word boundaries and never equal the full text', () => {
    const text = 'one two three four five six seven eight nine ten'
    const frames = playbackFrames(text, 4)
    expect(frames.length).toBeGreaterThan(1)
    for (let i = 1; i < frames.length; i++) expect(frames[i].length).toBeGreaterThan(frames[i - 1].length)
    for (const f of frames) {
      expect(text.startsWith(f)).toBe(true)
      expect(f).not.toBe(text)
      expect(f.endsWith(' ')).toBe(false)
    }
  })

  test('play() sends frames on the turn draft', async () => {
    const { dm, sent } = setup()
    await dm.play(42, 9, 'alpha beta gamma delta epsilon zeta eta theta', 100, 3)
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every(s => s.other?.message_thread_id === 9 && s.draft === 101)).toBe(true)
  })
})
