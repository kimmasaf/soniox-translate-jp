// Soniox real-time speech-to-text + translation client for the G2 microphone.
//
// Streams the glasses mic (PCM s16le @ 16 kHz mono) to Soniox's real-time
// WebSocket API (pcm_s16le @ 16000 natively — no resampling). With one-way
// translation, Soniox returns original (translation_status "original") and
// translated ("translation") tokens; we split them into transcript + translation
// streams, route already-target-language speech to the translation stream only
// (shown once, not duplicated), and drop translations of keep-as-is languages
// (via source_language).
//
// Robustness:
//   • Auto-reconnect with exponential backoff on unexpected drops — the
//     accumulated transcript persists across reconnects.
//   • Stops reconnecting on FATAL errors (bad key / invalid config).
//   • Backpressure guard: drops frames when the socket buffer is backed up;
//     caps the pre-connect buffer — bounded memory + latency on slow networks.
//
// Docs: https://soniox.com/docs/stt/rt/real-time-transcription
//       https://soniox.com/docs/stt/rt/real-time-translation

import type { Pair } from '../paired'

const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
// Latest real-time model (Nov 2026). See https://docs.soniox.com/stt/models
const DEFAULT_MODEL = 'stt-rt-v6'
const SPEAKER_ICONS = ['●', '■', '★', '▲', '♦', '♥', '♣', '♠']
const MAX_PENDING_CHUNKS = 50 // ~5s of audio buffered while (re)connecting
const BACKPRESSURE_BYTES = 256_000 // ~8s of audio; drop frames past this
const RECONNECT_MAX_MS = 8000

export type SttStatus = 'connecting' | 'live' | 'reconnecting' | 'closed'

export interface SttOptions {
  apiKey: string
  /** Translation target language code; '' = transcript only. */
  targetLang: string
  /** Source language hints to improve accuracy; [] = auto-detect. */
  languageHints?: string[]
  /** Repurpose Soniox `<end>` pauses as line breaks. */
  splitSentences?: boolean
  /** Speaker diarization with per-speaker icons. */
  speakerLabels?: boolean
  /** Language codes to keep as-is (skip translation; the target is always kept). */
  noTranslateLangs?: string[]
  /** Soniox real-time model id. */
  model?: string
  /** Speaker label for the labeled stream (0-based order of appearance). */
  formatSpeaker?: (index: number) => string
  /** Soniox context object (general / text / terms / translation_terms). */
  context?: object
}

export interface SttSnapshot {
  /** Unlabeled text (glasses): a speaker change only starts a new line. */
  transcriptFinal: string
  transcriptInterim: string
  translationFinal: string
  translationInterim: string
  /** Same text with a speaker label at each speaker change (phone UI). */
  transcriptLabeled: string
  translationLabeled: string
  /** Final utterances as original/translation pairs (Bilingual Paired view + history). */
  pairs: Pair[]
  /** Interim same-language text (also included in translationInterim). */
  sameInterim: string
  /** Interim translation of foreign speech only (translationInterim minus sameInterim). */
  foreignTranslationInterim: string
  finished: boolean
}

export interface SttClient {
  sendPcm(chunk: Uint8Array): void
  close(): void
}

interface SonioxToken {
  text?: string
  is_final?: boolean
  speaker?: string
  language?: string
  source_language?: string
  translation_status?: string // "original" | "translation" | "none"
}

interface SonioxResponse {
  tokens?: SonioxToken[]
  finished?: boolean
  error_code?: number
  error_type?: string
  error_message?: string
}

function isControlToken(text: string): boolean {
  return /^<[a-z_]+>$/i.test(text)
}

// Errors we should NOT retry on — the request itself is bad, so reconnecting
// would just fail the same way (and could hammer the API).
function isFatalError(res: SonioxResponse): boolean {
  const code = res.error_code ?? 0
  const type = res.error_type ?? ''
  return code === 400 || code === 401 || code === 403 || type === 'unauthenticated' || type === 'invalid_request'
}

export function startSttStream(
  opts: SttOptions,
  onSnapshot: (snap: SttSnapshot) => void,
  onError?: (err: unknown) => void,
  onStatus?: (status: SttStatus) => void,
): SttClient {
  const { apiKey, targetLang } = opts
  const model = opts.model || DEFAULT_MODEL
  const languageHints = opts.languageHints ?? []
  const splitSentences = opts.splitSentences ?? true
  const speakerLabels = opts.speakerLabels ?? false
  const noTranslate = opts.noTranslateLangs ?? []

  if (!apiKey) {
    onError?.(new Error('Soniox API key missing — set it in Settings'))
  }

  const formatSpeaker = opts.formatSpeaker ?? ((i: number) => SPEAKER_ICONS[i % SPEAKER_ICONS.length] + ' ')

  // Persistent across reconnects so the transcript continues uninterrupted.
  // Two parallel streams: plain (glasses) and labeled (phone).
  let transcriptFinal = ''
  let translationFinal = ''
  let transcriptLabeled = ''
  let translationLabeled = ''
  let lastSpkTx: string | null = null
  let lastSpkTl: string | null = null
  const spkOrder = new Map<string, number>()

  // Bilingual pairs. Soniox does not tag which translation belongs to which
  // original, so: an original starts a new pair once the current pair already
  // has translation (or the speaker changed); a translation attaches to the
  // latest foreign-language pair. If speech resumes before a translation
  // arrives, two utterances merge into one pair — never misaligned.
  const pairs: Pair[] = []
  const MAX_PAIRS = 3000
  function spkIndex(spk?: string): number | undefined {
    if (!speakerLabels || !spk) return undefined
    if (!spkOrder.has(spk)) spkOrder.set(spk, spkOrder.size)
    return spkOrder.get(spk)
  }
  function pairOrig(text: string, spk?: string) {
    const s = spkIndex(spk)
    const last = pairs[pairs.length - 1]
    if (!last || last.same || last.trans || (s !== undefined && last.orig && last.speaker !== s)) {
      pairs.push({ speaker: s, at: Date.now(), orig: text.trimStart(), trans: '', same: false })
    } else {
      last.orig += text
    }
  }
  function pairTrans(text: string) {
    for (let i = pairs.length - 1; i >= 0; i--) {
      if (!pairs[i].same) {
        pairs[i].trans += pairs[i].trans ? text : text.trimStart()
        return
      }
    }
    pairs.push({ at: Date.now(), orig: '', trans: text.trimStart(), same: false })
  }
  function pairSame(text: string, spk?: string) {
    const s = spkIndex(spk)
    const last = pairs[pairs.length - 1]
    if (!last || !last.same || (s !== undefined && last.speaker !== s)) {
      pairs.push({ speaker: s, at: Date.now(), orig: '', trans: text.trimStart(), same: true })
    } else {
      last.trans += text
    }
  }

  let ws: WebSocket | null = null
  let configSent = false
  let closedByUs = false
  let fatal = false
  let reconnectAttempts = 0
  let reconnectTimer: number | null = null
  const pending: Uint8Array[] = []

  function speakerLabel(spk: string): string {
    if (!spkOrder.has(spk)) spkOrder.set(spk, spkOrder.size)
    return formatSpeaker(spkOrder.get(spk)!)
  }
  const nl = (s: string) => (s && !s.endsWith('\n') ? s + '\n' : s)
  function appendTranscript(text: string, speaker?: string) {
    if (speakerLabels && speaker && speaker !== lastSpkTx) {
      transcriptFinal = nl(transcriptFinal)
      transcriptLabeled = nl(transcriptLabeled) + speakerLabel(speaker)
      lastSpkTx = speaker
    }
    transcriptFinal += text
    transcriptLabeled += text
  }
  function appendTranslation(text: string, speaker?: string) {
    if (speakerLabels && speaker && speaker !== lastSpkTl) {
      translationFinal = nl(translationFinal)
      translationLabeled = nl(translationLabeled) + speakerLabel(speaker)
      lastSpkTl = speaker
    }
    translationFinal += text
    translationLabeled += text
  }

  function buildConfig(): string {
    const config: Record<string, unknown> = {
      api_key: apiKey,
      model,
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
      enable_endpoint_detection: true,
    }
    if (languageHints.length) config.language_hints = languageHints
    if (opts.context) config.context = opts.context
    if (targetLang) {
      config.translation = { type: 'one_way', target_language: targetLang }
      config.enable_language_identification = true
    }
    if (speakerLabels) config.enable_speaker_diarization = true
    return JSON.stringify(config)
  }

  function handleMessage(ev: MessageEvent) {
    let res: SonioxResponse
    try {
      const raw = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)
      res = JSON.parse(raw)
    } catch {
      return
    }

    if (res.error_code) {
      if (isFatalError(res)) fatal = true
      onError?.(
        new Error(`Soniox ${res.error_code} ${res.error_type ?? ''}: ${res.error_message ?? 'error'}`.trim()),
      )
      return
    }

    let transcriptInterim = ''
    let translationInterim = ''
    let sameInterim = ''
    let foreignTranslationInterim = ''
    for (const t of res.tokens ?? []) {
      const text = t.text
      if (!text) continue
      const isTranslation = t.translation_status === 'translation'
      if (isControlToken(text)) {
        if (splitSentences && t.is_final && /^<(end|fin)>$/i.test(text)) {
          transcriptFinal = nl(transcriptFinal)
          transcriptLabeled = nl(transcriptLabeled)
        }
        continue
      }
      if (isTranslation) {
        if (noTranslate.includes(t.source_language ?? '')) continue
        if (t.is_final) {
          appendTranslation(text, t.speaker)
          pairTrans(text)
        } else {
          translationInterim += text
          foreignTranslationInterim += text
        }
      } else {
        // Speech already in the target language (or a keep-as-is language)
        // needs no translation: show it ONCE, in the translation stream only,
        // instead of duplicating it in the original-language stream.
        const keepAsIs = targetLang && (t.language === targetLang || noTranslate.includes(t.language ?? ''))
        if (keepAsIs) {
          if (t.is_final) {
            appendTranslation(text, t.speaker)
            pairSame(text, t.speaker)
          } else {
            translationInterim += text
            sameInterim += text
          }
        } else {
          if (t.is_final) {
            appendTranscript(text, t.speaker)
            // Transcript-only mode: record as single-line entries for history.
            if (targetLang) pairOrig(text, t.speaker)
            else pairSame(text, t.speaker)
          } else {
            transcriptInterim += text
          }
        }
      }
    }

    const cap = (s: string) => (s.length > 100_000 ? s.slice(-100_000) : s)
    transcriptFinal = cap(transcriptFinal)
    translationFinal = cap(translationFinal)
    transcriptLabeled = cap(transcriptLabeled)
    translationLabeled = cap(translationLabeled)

    if (pairs.length > MAX_PAIRS) pairs.splice(0, pairs.length - MAX_PAIRS)

    if (res.finished) console.info('[soniox] stream finished')
    onSnapshot({
      transcriptFinal, transcriptInterim, translationFinal, translationInterim,
      transcriptLabeled, translationLabeled,
      pairs, sameInterim, foreignTranslationInterim,
      finished: !!res.finished,
    })
  }

  function connect() {
    if (closedByUs || fatal) return
    onStatus?.(reconnectAttempts > 0 ? 'reconnecting' : 'connecting')
    configSent = false
    const sock = new WebSocket(SONIOX_WS_URL)
    sock.binaryType = 'arraybuffer'
    ws = sock

    sock.addEventListener('open', () => {
      if (ws !== sock) return // superseded
      reconnectAttempts = 0
      sock.send(buildConfig())
      configSent = true
      onStatus?.('live')
      console.info(
        `[soniox] connected — model ${model}` +
          (targetLang ? `, translate→${targetLang}` : '') +
          (speakerLabels ? ', diarization on' : '') +
          (languageHints.length ? `, hints ${languageHints.join('/')}` : '') +
          (opts.context ? `, context ${Object.keys(opts.context).join('/')}` : ''),
      )
      // Flush buffered audio captured during (re)connect.
      for (const chunk of pending) sock.send(chunk)
      pending.length = 0
    })

    sock.addEventListener('message', handleMessage)
    sock.addEventListener('error', () => {
      /* a 'close' event follows — reconnect is handled there */
    })
    sock.addEventListener('close', () => {
      if (ws !== sock) return
      configSent = false
      if (closedByUs || fatal) {
        onStatus?.('closed')
        return
      }
      scheduleReconnect()
    })
  }

  function scheduleReconnect() {
    if (closedByUs || fatal) return
    onStatus?.('reconnecting')
    const delay = Math.min(RECONNECT_MAX_MS, 500 * 2 ** reconnectAttempts)
    reconnectAttempts++
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    reconnectTimer = window.setTimeout(connect, delay)
  }

  connect()

  return {
    sendPcm(chunk: Uint8Array) {
      if (closedByUs || fatal) return
      if (ws && ws.readyState === WebSocket.OPEN && configSent) {
        if (ws.bufferedAmount > BACKPRESSURE_BYTES) return // network backed up → drop to bound latency
        ws.send(chunk)
      } else {
        // (re)connecting → buffer, capped so memory stays bounded.
        if (pending.length >= MAX_PENDING_CHUNKS) pending.shift()
        pending.push(chunk.slice())
      }
    },
    close() {
      closedByUs = true
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send('')
        else ws?.close()
      } catch {
        /* already closing */
      }
    },
  }
}
