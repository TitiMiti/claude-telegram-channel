// Voice → text via Yandex SpeechKit STT v3, asynchronous mode.
//
// Same flow as the reference stt.py / fnl-stream client: audio goes inline as
// base64 (up to 10 MB — a minute of OggOpus is ~200 KB, no bucket needed),
// recognizeFileAsync returns an operation, we poll it, then getRecognition
// returns a stream of JSON objects (one per line) and deleteRecognition
// cleans up. Auth is `Authorization: Api-Key <key>` (service account key with
// the yc.ai.speechkitStt.execute scope).
//
// The key is a credential: it never goes into errors, logs or notifications.

import { spawn } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export const STT_URL = 'https://stt.api.cloud.yandex.net/stt/v3'
export const OPERATION_URL = 'https://operation.api.cloud.yandex.net/operations'
export const MAX_INLINE_BYTES = 10 * 1024 * 1024

export class SttError extends Error {}

export type SttOptions = {
  apiKey: string
  language?: string
  timeoutMs?: number
  pollMs?: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

/** Telegram voice notes are already OggOpus; everything else goes through ffmpeg. */
export function isOggOpus(mime: string | undefined, ext: string | undefined): boolean {
  if (mime === 'audio/ogg' || mime === 'audio/opus') return true
  const e = (ext ?? '').toLowerCase().replace(/^\./, '')
  return e === 'ogg' || e === 'oga' || e === 'opus'
}

export async function transcribe(audio: Uint8Array, opts: SttOptions): Promise<string> {
  const doFetch = opts.fetch ?? fetch
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const timeoutMs = opts.timeoutMs ?? 120_000
  const pollMs = opts.pollMs ?? 1000
  if (audio.byteLength > MAX_INLINE_BYTES) {
    throw new SttError(`audio is larger than ${MAX_INLINE_BYTES / 1024 / 1024} MB`)
  }
  const headers = {
    Authorization: `Api-Key ${opts.apiKey}`,
    'Content-Type': 'application/json',
    // Ask Yandex not to keep the audio/text for service improvement. Opt back in with YANDEX_DATA_LOGGING=1.
    ...(process.env.YANDEX_DATA_LOGGING === '1' ? {} : { 'x-data-logging-enabled': 'false' }),
  }

  async function call(method: string, url: string, body?: unknown): Promise<string> {
    const res = await doFetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    if (!res.ok) throw new SttError(`SpeechKit HTTP ${res.status}: ${text.slice(0, 300)}`)
    return text
  }

  const started = JSON.parse(await call('POST', `${STT_URL}/recognizeFileAsync`, {
    content: Buffer.from(audio).toString('base64'),
    recognitionModel: {
      model: 'general',
      audioFormat: { containerAudio: { containerAudioType: 'OGG_OPUS' } },
      textNormalization: {
        textNormalization: 'TEXT_NORMALIZATION_ENABLED',
        profanityFilter: false,
        literatureText: false,
      },
      languageRestriction: {
        restrictionType: 'WHITELIST',
        languageCode: [opts.language ?? 'ru-RU'],
      },
    },
  })) as { id?: string }
  const op = started.id
  if (!op) throw new SttError('SpeechKit returned no operation id')

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const st = JSON.parse(await call('GET', `${OPERATION_URL}/${encodeURIComponent(op)}`)) as {
      done?: boolean
      error?: { message?: string; code?: number }
    }
    if (st.error) throw new SttError(`SpeechKit: ${st.error.message ?? JSON.stringify(st.error)}`)
    if (st.done) break
    if (Date.now() >= deadline) throw new SttError(`recognition did not finish in ${timeoutMs / 1000}s`)
    await sleep(pollMs)
  }

  const raw = await call('GET', `${STT_URL}/getRecognition?operationId=${encodeURIComponent(op)}`)
  // Not critical: the result is already in hand.
  void call('DELETE', `${STT_URL}/deleteRecognition?operationId=${encodeURIComponent(op)}`).catch(() => {})
  return parseRecognitionStream(raw)
}

/**
 * getRecognition answers with one StreamingResponse JSON object per line.
 * Take `final` events; the `finalRefinement` with the same finalIndex comes
 * later and replaces it (numbers, punctuation — easier to read for humans and
 * models alike).
 */
export function parseRecognitionStream(raw: string): string {
  const finals = new Map<number, string>()
  const refined = new Map<number, string>()
  const order: number[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ev: any
    try {
      ev = JSON.parse(line)?.result ?? {}
    } catch {
      continue
    }
    if (ev.final) {
      const i = Number(ev.audioCursors?.finalIndex ?? order.length)
      const alt = ev.final.alternatives?.[0]
      if (alt) {
        if (!finals.has(i)) order.push(i)
        finals.set(i, alt.text ?? '')
      }
    } else if (ev.finalRefinement) {
      const r = ev.finalRefinement
      const alt = r.normalizedText?.alternatives?.[0]
      if (alt) refined.set(Number(r.finalIndex ?? 0), alt.text ?? '')
    }
  }
  return order
    .map(i => refined.get(i) || finals.get(i) || '')
    .filter(t => t.trim())
    .join(' ')
}

/**
 * Re-encode any audio ffmpeg understands into OggOpus. Goes through a temp
 * file, not a pipe: m4a/mp4 keep their index at the end and need seeking.
 */
export async function toOggOpus(input: Uint8Array): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), 'tg-stt-'))
  const src = join(dir, 'in')
  const dst = join(dir, 'out.ogg')
  try {
    writeFileSync(src, input)
    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-loglevel', 'error', '-y', '-i', src,
        '-vn', '-c:a', 'libopus', '-b:a', '32k', dst,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      ff.stderr.on('data', d => { err += d })
      ff.on('error', e => reject(new SttError(`ffmpeg: ${e.message}`)))
      ff.on('close', code => {
        if (code === 0) resolve()
        else reject(new SttError(`ffmpeg exited ${code}: ${err.trim().slice(0, 200)}`))
      })
    })
    return new Uint8Array(readFileSync(dst))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
