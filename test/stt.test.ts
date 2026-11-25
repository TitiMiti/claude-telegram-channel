import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { parseRecognitionStream, transcribe, isOggOpus, toOggOpus, SttError, MAX_INLINE_BYTES, STT_URL, OPERATION_URL } from '../lib/stt.ts'

// Shape of a real getRecognition answer: one StreamingResponse per line,
// partials, finals, then the normalized finalRefinement for each final.
const STREAM = [
  { result: { partial: { alternatives: [{ text: 'привет' }] }, channelTag: '0' } },
  { result: { final: { alternatives: [{ text: 'привет как дела', startTimeMs: '0', endTimeMs: '1500' }] }, audioCursors: { finalIndex: '0' }, channelTag: '0' } },
  { result: { finalRefinement: { finalIndex: '0', normalizedText: { alternatives: [{ text: 'Привет, как дела?' }] } }, channelTag: '0' } },
  { result: { final: { alternatives: [{ text: 'созвон в пять' }] }, audioCursors: { finalIndex: '1' }, channelTag: '0' } },
  { result: { final: { alternatives: [] }, audioCursors: { finalIndex: '2' } } },
  { result: { final: { alternatives: [{ text: '   ' }] }, audioCursors: { finalIndex: '3' } } },
].map(o => JSON.stringify(o)).join('\n') + '\n'

describe('parseRecognitionStream', () => {
  test('finals in order, refinement replaces its final, blanks dropped', () => {
    expect(parseRecognitionStream(STREAM)).toBe('Привет, как дела? созвон в пять')
  })
  test('garbage lines are skipped', () => {
    const raw = 'not json\n' + JSON.stringify({ result: { final: { alternatives: [{ text: 'ok' }] }, audioCursors: { finalIndex: '0' } } })
    expect(parseRecognitionStream(raw)).toBe('ok')
  })
  test('empty stream → empty text', () => {
    expect(parseRecognitionStream('')).toBe('')
  })
})

describe('isOggOpus', () => {
  test('voice notes skip ffmpeg, mp3 does not', () => {
    expect(isOggOpus('audio/ogg', 'oga')).toBe(true)
    expect(isOggOpus(undefined, 'ogg')).toBe(true)
    expect(isOggOpus('audio/mpeg', 'mp3')).toBe(false)
    expect(isOggOpus(undefined, undefined)).toBe(false)
  })
})

type Call = { method: string; url: string; headers: Record<string, string>; body?: any }

function mockFetch(opts: { pendingPolls?: number; failStart?: number; opError?: boolean } = {}) {
  const calls: Call[] = []
  let polls = 0
  const f = (async (url: string, init: RequestInit) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    }
    calls.push(call)
    if (url.endsWith('/recognizeFileAsync')) {
      if (opts.failStart) return new Response('{"message":"bad key"}', { status: opts.failStart })
      return Response.json({ id: 'op-1', done: false })
    }
    if (url.startsWith(OPERATION_URL)) {
      if (opts.opError) return Response.json({ id: 'op-1', done: true, error: { code: 3, message: 'audio is broken' } })
      polls++
      return Response.json({ id: 'op-1', done: polls > (opts.pendingPolls ?? 0) })
    }
    if (url.includes('/getRecognition')) return new Response(STREAM)
    if (url.includes('/deleteRecognition')) return new Response('{}')
    return new Response('?', { status: 404 })
  }) as unknown as typeof fetch
  return { f, calls }
}

describe('transcribe (recognizeFileAsync → poll → getRecognition → delete)', () => {
  const audio = new Uint8Array([1, 2, 3, 4])

  test('happy path', async () => {
    const { f, calls } = mockFetch({ pendingPolls: 2 })
    const slept: number[] = []
    const text = await transcribe(audio, {
      apiKey: 'test-key', language: 'en-US', fetch: f, pollMs: 7, sleep: async ms => { slept.push(ms) },
    })
    expect(text).toBe('Привет, как дела? созвон в пять')

    const start = calls[0]
    expect(start.method).toBe('POST')
    expect(start.url).toBe(`${STT_URL}/recognizeFileAsync`)
    expect(start.headers.Authorization).toBe('Api-Key test-key')
    expect(start.body.content).toBe(Buffer.from(audio).toString('base64'))
    expect(start.body.recognitionModel.audioFormat.containerAudio.containerAudioType).toBe('OGG_OPUS')
    expect(start.body.recognitionModel.languageRestriction.languageCode).toEqual(['en-US'])

    const polls = calls.filter(c => c.url.startsWith(OPERATION_URL))
    expect(polls.length).toBe(3)
    expect(polls[0].url).toBe(`${OPERATION_URL}/op-1`)
    expect(slept).toEqual([7, 7])
    expect(calls.some(c => c.url === `${STT_URL}/getRecognition?operationId=op-1`)).toBe(true)
    await Bun.sleep(0)
    expect(calls.some(c => c.method === 'DELETE' && c.url === `${STT_URL}/deleteRecognition?operationId=op-1`)).toBe(true)
  })

  test('default language is ru-RU', async () => {
    const { f, calls } = mockFetch()
    await transcribe(audio, { apiKey: 'k', fetch: f, sleep: async () => {} })
    expect(calls[0].body.recognitionModel.languageRestriction.languageCode).toEqual(['ru-RU'])
  })

  test('HTTP error surfaces status but never the key', async () => {
    const { f } = mockFetch({ failStart: 401 })
    const err = await transcribe(audio, { apiKey: 'secret-key-123', fetch: f }).catch(e => e)
    expect(err).toBeInstanceOf(SttError)
    expect(err.message).toContain('401')
    expect(err.message).not.toContain('secret-key-123')
  })

  test('operation error', async () => {
    const { f } = mockFetch({ opError: true })
    await expect(transcribe(audio, { apiKey: 'k', fetch: f, sleep: async () => {} })).rejects.toThrow('audio is broken')
  })

  test('timeout', async () => {
    const { f } = mockFetch({ pendingPolls: 1e9 })
    await expect(transcribe(audio, { apiKey: 'k', fetch: f, timeoutMs: 0, sleep: async () => {} })).rejects.toThrow('did not finish')
  })

  test('over 10 MB is refused before any request', async () => {
    const { f, calls } = mockFetch()
    await expect(transcribe(new Uint8Array(MAX_INLINE_BYTES + 1), { apiKey: 'k', fetch: f })).rejects.toThrow('larger than')
    expect(calls.length).toBe(0)
  })
})

describe.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0)('toOggOpus', () => {
  test('mp3 in, OggOpus out', async () => {
    const mp3 = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'mp3', 'pipe:1'])
    expect(mp3.status).toBe(0)
    const ogg = await toOggOpus(new Uint8Array(mp3.stdout))
    expect(Buffer.from(ogg.slice(0, 4)).toString()).toBe('OggS')
    expect(Buffer.from(ogg).includes(Buffer.from('OpusHead'))).toBe(true)
  })
  test('garbage in → SttError', async () => {
    await expect(toOggOpus(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(SttError)
  })
})
