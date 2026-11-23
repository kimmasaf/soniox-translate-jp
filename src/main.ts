import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'
import { startSttStream, type SttClient } from './asr/stt'
import { mountUi, setStatus, setTranscript, setTranslation, setPaired, setTargetLangLabel, formatSpeaker } from './ui'
import type { SttSnapshot } from './asr/stt'

// Glasses placeholders (the G2 font has kana/kanji but not symbols like ⚙).
const PH_LISTEN = '聞き取り中…'
const PH_TRANSLATE = '翻訳を待っています…'
const PH_PAUSED = '一時停止中'
const PH_PAUSED_START = '一時停止中です。\nタップすると聞き取りを開始します。'
const PH_PAUSED_FOOTER = '- 一時停止中(タップで再開) -'
import { type AppSettings, type DisplayMode, DISPLAY_MODES, SETTINGS_KEY, mergeSettings, hasOriginalPane } from './settings'
import { type Pair, PAIR_LINE, withInterim, pairedGlassesText } from './paired'
import { History, type SessionRecord } from './history'

const bridge = await waitForEvenAppBridge()

// ── Serial bridge queue ──────────────────────────────────────────────────────
// The SDK can crash the BLE link if bridge calls overlap, and a flaky hop can
// hang ~30s. Funnel every mutation through one FIFO chain with a per-call
// timeout so calls never overlap and never hang the pipeline.
let bridgeChain: Promise<unknown> = Promise.resolve()
function serial<T>(label: string, fn: () => Promise<T>, ms = 4000): Promise<T> {
  const run = bridgeChain.then(() =>
    Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        window.setTimeout(() => reject(new Error(`bridge.${label} timed out (${ms}ms)`)), ms),
      ),
    ]),
  )
  bridgeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// ── Settings (per-user, persisted via the SDK) ───────────────────────────────
async function loadSettings(): Promise<AppSettings> {
  let raw = ''
  try {
    raw = await bridge.getLocalStorage(SETTINGS_KEY)
  } catch {
    /* first run */
  }
  const s = mergeSettings(raw)
  if (!s.apiKey && import.meta.env.DEV) {
    const devKey = (import.meta.env.VITE_STT_API_KEY as string) || ''
    if (devKey) s.apiKey = devKey
  }
  // Dev-only URL overrides (used by sim/run.sh): `?target=ja&speakers=1&mode=paired`.
  if (import.meta.env.DEV) {
    const q = new URLSearchParams(location.search)
    const t = q.get('target')
    if (t !== null) s.targetLang = t
    if (q.get('speakers') !== null) s.speakerLabels = q.get('speakers') === '1'
    const m = q.get('mode') as DisplayMode | null
    if (m && DISPLAY_MODES.includes(m)) s.displayMode = m
  }
  return s
}

let settings = await loadSettings()

// ── History (Bilingual Paired sessions, saved on the phone via the SDK) ──────
const history = new History({
  get: key => serial('history.get', () => bridge.getLocalStorage(key)),
  set: (key, value) => serial('history.set', () => bridge.setLocalStorage(key, value)),
})
let session: SessionRecord | null = null
let sessionDirty = false
let autosaveTimer: number | null = null
const AUTOSAVE_MS = 5000

function startSession() {
  session = { id: Date.now(), start: Date.now(), end: Date.now(), targetLang: settings.targetLang, count: 0, preview: '', pairs: [] }
  sessionDirty = false
}
function updateSession(pairs: Pair[]) {
  if (!session) return
  session.pairs = pairs
  session.end = Date.now()
  sessionDirty = true
  if (autosaveTimer === null) autosaveTimer = window.setTimeout(() => void flushSession(), AUTOSAVE_MS)
}
/** Save the current session now (no-op when nothing changed or it is empty). */
async function flushSession() {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  if (!session || !sessionDirty) return
  sessionDirty = false
  const snapshot: SessionRecord = { ...session, pairs: session.pairs.map(p => ({ ...p })) }
  try {
    await history.save(snapshot)
  } catch (err) {
    sessionDirty = true
    console.warn('[history] save failed:', (err as Error)?.message ?? err)
  }
}

mountUi({
  settings,
  onSave: handleSave,
  history: {
    list: async () => {
      await flushSession()
      return history.list()
    },
    get: id => history.get(id),
    remove: id => history.remove(id),
    removeAll: () => history.removeAll(),
    currentId: () => session?.id ?? null,
  },
})

// ── Render state ─────────────────────────────────────────────────────────────
let curTranscript = '起動中…'
let curTranslation = '…'
let lastTranscript = ''
let lastTranslation = ''
let rawTx = ''
let rawTl = ''
let rawPaired = ''

// ── Layout / geometry (borderless; width-aware; split or full-screen) ────────
const PAD = 3
const LINE_H = 27
const spaceW = Math.max(1, getTextWidth('a a') - getTextWidth('aa'))

let hasTranscript = hasOriginalPane(settings.displayMode)
let transcriptLines = 0
let translationLines = 0
let paneW = 576
let paneX = 0
let innerW = 570

function mkPane(id: number, name: string, y: number, h: number, capture: boolean, content: string) {
  return new TextContainerProperty({
    xPosition: paneX, yPosition: y, width: paneW, height: h,
    borderWidth: 0, paddingLength: PAD,
    containerID: id, containerName: name, content, isEventCapture: capture ? 1 : 0,
  })
}

function buildLayout() {
  hasTranscript = hasOriginalPane(settings.displayMode)
  paneW = Math.round((576 * (settings.widthPct || 100)) / 100)
  paneX = Math.round((576 - paneW) / 2)
  innerW = paneW - 2 * PAD
  if (hasTranscript) {
    // split: 2 lines of original; split37: 3 lines original : 7 lines translation.
    const TOP_H = settings.displayMode === 'split37' ? 3 * LINE_H + 2 * PAD : 62
    const BOT_H = 288 - TOP_H
    transcriptLines = Math.floor((TOP_H - 2 * PAD) / LINE_H)
    translationLines = Math.floor((BOT_H - 2 * PAD) / LINE_H)
    return {
      containerTotalNum: 2,
      textObject: [
        mkPane(1, 'transcript', 0, TOP_H, false, curTranscript),
        mkPane(2, 'translation', TOP_H, BOT_H, true, curTranslation),
      ],
    }
  }
  transcriptLines = 0
  translationLines = Math.floor((288 - 2 * PAD) / LINE_H)
  return { containerTotalNum: 1, textObject: [mkPane(2, 'translation', 0, 288, true, curTranslation)] }
}

const created = await serial('createStartUpPage', () =>
  bridge.createStartUpPageContainer(new CreateStartUpPageContainer(buildLayout())),
)
if (created !== 0) {
  setStatus('error', `createStartUpPageContainer failed: ${created}`)
  console.error('Failed to create startup page')
}

async function applyLayout() {
  await serial('rebuild', () => bridge.rebuildPageContainer(new RebuildPageContainer(buildLayout())))
}

// ── Text fitting: wrap, align, sentence-spacing, keep last N (autoscroll) ────
function wrapToLines(text: string, maxW: number): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      if (word === '') continue
      const cand = line ? line + ' ' + word : word
      if (getTextWidth(cand) <= maxW) {
        line = cand
      } else {
        if (line) lines.push(line)
        if (getTextWidth(word) > maxW) {
          let chunk = ''
          for (const ch of word) {
            if (getTextWidth(chunk + ch) <= maxW) chunk += ch
            else {
              if (chunk) lines.push(chunk)
              chunk = ch
            }
          }
          line = chunk
        } else {
          line = word
        }
      }
    }
    lines.push(line)
  }
  return lines
}

function splitSentences(text: string): string {
  return text
    .replace(/([.!?。！？])[ \t]+/g, '$1\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+/, '')
}

function centerLine(line: string): string {
  const w = getTextWidth(line)
  if (w >= innerW) return line
  const pad = Math.floor((innerW - w) / 2 / spaceW)
  return pad > 0 ? ' '.repeat(pad) + line : line
}

// `visibleLines` = how many content lines to show (most recent).
// `paneLines`    = physical rows in the pane; for bottom anchoring we pad the
//                  top so the newest line sits at the pane's bottom row.
// Paragraphs are separated by '\n' (line spacing applies between them); a
// PAIR_LINE inside a paragraph breaks the line without adding a gap (used to
// keep an original and its translation together in Bilingual Paired mode).
function fitTail(
  text: string, placeholder: string, visibleLines: number, paneLines: number,
  split = settings.splitSentences, footer = '',
): string {
  let t = text.trim()
  let lines: string[]
  if (!t) {
    lines = placeholder.split('\n')
  } else {
    if (split) t = splitSentences(t)
    const tail = t.length > 1400 ? t.slice(-1400) : t
    const gap = settings.lineGap || 0
    const out: string[] = []
    const paras = tail.split('\n')
    for (let i = 0; i < paras.length; i++) {
      if (i > 0) for (let g = 0; g < gap; g++) out.push('')
      let wl = paras[i].split(PAIR_LINE).flatMap(sub => wrapToLines(sub, innerW))
      if (settings.align === 'center') wl = wl.map(centerLine)
      out.push(...wl)
    }
    lines = out.slice(-visibleLines)
    while (lines.length && lines[0] === '') lines.shift() // no leading blank
  }
  if (footer) lines.push(settings.align === 'center' ? centerLine(footer) : footer)
  if (settings.vAlign === 'bottom') {
    // Pad with single-space rows (guaranteed to render) so content sticks to
    // the bottom — the newest line stays at a fixed position.
    const pad = Math.max(0, paneLines - lines.length)
    if (pad > 0) lines = new Array(pad).fill(' ').concat(lines)
  }
  return lines.join('\n')
}

function recomputeDisplay() {
  const phTop = paused ? PH_PAUSED : PH_LISTEN
  if (hasTranscript) curTranscript = fitTail(rawTx, phTop, transcriptLines, transcriptLines)
  const visible = settings.maxLines > 0 ? Math.min(translationLines, settings.maxLines) : translationLines
  const text = settings.displayMode === 'paired' ? rawPaired : settings.targetLang ? rawTl : rawTx
  const split = settings.displayMode === 'paired' ? false : settings.splitSentences
  if (paused) {
    // Paused: keep the latest text, with a status line as the bottom row.
    curTranslation = text.trim()
      ? fitTail(text, '', Math.max(1, visible - 1), translationLines, split, PH_PAUSED_FOOTER)
      : fitTail('', PH_PAUSED_START, visible, translationLines, split)
    return
  }
  const ph = settings.displayMode === 'paired' || !settings.targetLang ? PH_LISTEN : PH_TRANSLATE
  curTranslation = fitTail(text, ph, visible, translationLines, split)
}

// ── Glasses render (debounced + coalesced; never overlapping) ────────────────
let renderTimer: number | null = null
let renderDirty = false
let renderInFlight = false

function scheduleGlassesRender() {
  renderDirty = true
  if (renderInFlight || renderTimer !== null) return
  renderTimer = window.setTimeout(runRender, 120)
}

async function runRender() {
  renderTimer = null
  if (renderInFlight) return
  renderInFlight = true
  try {
    while (renderDirty) {
      renderDirty = false
      const tx = curTranscript
      const tl = curTranslation
      if (hasTranscript && tx !== lastTranscript) {
        await serial('upgrade.transcript', () =>
          bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'transcript', content: tx })),
        )
        lastTranscript = tx
      }
      if (tl !== lastTranslation) {
        await serial('upgrade.translation', () =>
          bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 2, containerName: 'translation', content: tl })),
        )
        lastTranslation = tl
      }
    }
  } catch (err) {
    // Leave last* unset on the failed pane so the next change retries it.
    console.warn('[render] upgrade failed:', (err as Error)?.message ?? err)
  } finally {
    renderInFlight = false
    if (renderDirty) scheduleGlassesRender()
  }
}

function forceRender() {
  lastTranscript = ''
  lastTranslation = ''
  scheduleGlassesRender()
}

// ── STT lifecycle (with pause) ───────────────────────────────────────────────
// The app starts PAUSED. A single tap on the glasses toggles pause / listen.
// Pausing turns the mic off and closes the Soniox stream (no usage while
// paused). Resuming opens a new stream whose text is appended to what was
// already shown ("carry"), so captions and the saved conversation continue.
let stt: SttClient | null = null
let micOn = false
let paused = true

interface Carry { tx: string; tl: string; txLab: string; tlLab: string; pairs: Pair[] }
const emptyCarry = (): Carry => ({ tx: '', tl: '', txLab: '', tlLab: '', pairs: [] })
let carry = emptyCarry() // everything from earlier streams of this conversation
let live = emptyCarry() // carry + finals of the current stream

/** Append a stream's text to carried text; a new stream starts on a new line. */
function joinFinal(prev: string, final: string, interim: string): string {
  if (!prev || !(final || interim)) return prev + final
  return (prev.endsWith('\n') ? prev : prev + '\n') + final.replace(/^\s+/, '')
}

function onSnapshot(s: SttSnapshot) {
  live = {
    tx: joinFinal(carry.tx, s.transcriptFinal, s.transcriptInterim),
    tl: joinFinal(carry.tl, s.translationFinal, s.translationInterim),
    txLab: joinFinal(carry.txLab, s.transcriptLabeled, s.transcriptInterim),
    tlLab: joinFinal(carry.tlLab, s.translationLabeled, s.translationInterim),
    pairs: carry.pairs.concat(s.pairs),
  }
  // Glasses: unlabeled text. Phone: speaker-labeled text.
  rawTx = live.tx + s.transcriptInterim
  rawTl = live.tl + s.translationInterim
  const paired = withInterim(live.pairs, s.transcriptInterim, s.foreignTranslationInterim, s.sameInterim)
  rawPaired = pairedGlassesText(paired)
  recomputeDisplay()
  setTranscript(live.txLab, s.transcriptInterim)
  setTranslation(live.tlLab, s.translationInterim)
  setPaired(paired)
  scheduleGlassesRender()
  updateSession(live.pairs)
}

function onSttError(err: unknown) {
  setStatus('error', `音声認識: ${(err as Error)?.message ?? err}`)
  console.error('STT error:', err)
}

function stopStream() {
  if (micOn) {
    serial('audioOff', () => bridge.audioControl(false))
    micOn = false
  }
  stt?.close()
  stt = null
}

function startStream() {
  if (stt || !settings.apiKey) return
  try {
    // Ignore late snapshots from a stream we already closed (it may still
    // deliver its final "finished" message) so they don't leak into later text.
    let client: SttClient | null = null
    const onSnap = (s: SttSnapshot) => {
      if (client && stt === client) onSnapshot(s)
    }
    stt = client = startSttStream(
      {
        apiKey: settings.apiKey,
        targetLang: settings.targetLang,
        splitSentences: settings.splitSentences,
        speakerLabels: settings.speakerLabels,
        noTranslateLangs: settings.noTranslateLangs,
        formatSpeaker,
      },
      onSnap,
      onSttError,
      status => {
        if (paused) return
        if (status === 'live') setStatus('listening', 'タップで一時停止・ダブルタップで終了')
        else if (status === 'connecting') setStatus('connecting', 'Soniox に接続中…')
        else if (status === 'reconnecting') setStatus('reconnecting', '接続が切れたため再接続しています')
      },
    )
  } catch (err) {
    onSttError(err)
    return
  }
  if (!micOn) {
    serial('audioOn', () => bridge.audioControl(true))
    micOn = true
  }
}

function showPaused() {
  setStatus('paused', 'メガネをタップすると聞き取りを開始します')
  recomputeDisplay()
  forceRender()
}

function pause() {
  if (paused) return
  paused = true
  carry = live
  stopStream()
  void flushSession()
  showPaused()
}

function resume() {
  if (!paused || !settings.apiKey) return
  paused = false
  live = carry
  recomputeDisplay()
  forceRender()
  startStream()
}

/** Start a new conversation with the current settings (keeps paused/listening). */
function restart() {
  stopStream()
  void flushSession() // the previous conversation goes to history
  session = null
  carry = emptyCarry()
  live = emptyCarry()
  setTargetLangLabel(settings.targetLang)

  if (!settings.apiKey) {
    curTranscript = '設定が必要です'
    curTranslation = 'スマートフォンでこのアプリを開き、設定画面で Soniox の API キーを入力してください。'
    forceRender()
    setStatus('setup', '設定画面で Soniox の API キーを入力してください')
    return
  }
  startSession()
  if (paused) showPaused()
  else startStream()
}

async function handleSave(next: AppSettings) {
  const prev = settings
  settings = next
  serial('saveSettings', () => bridge.setLocalStorage(SETTINGS_KEY, JSON.stringify(next))).catch(err =>
    console.error('Failed to persist settings:', err),
  )

  const needRebuild = next.displayMode !== prev.displayMode || next.widthPct !== prev.widthPct
  const needRestart =
    next.apiKey !== prev.apiKey ||
    next.targetLang !== prev.targetLang ||
    next.splitSentences !== prev.splitSentences ||
    next.speakerLabels !== prev.speakerLabels ||
    next.noTranslateLangs.join(',') !== prev.noTranslateLangs.join(',')

  if (needRestart) {
    rawTx = ''
    rawTl = ''
    rawPaired = ''
    recomputeDisplay()
    if (needRebuild) await applyLayout()
    else forceRender()
    restart()
  } else {
    if (needRebuild) await applyLayout()
    recomputeDisplay()
    forceRender()
  }
}

restart()

// ── Cleanup + event routing ──────────────────────────────────────────────────
let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  void flushSession()
  stopStream()
  unsubscribe()
}

let lastTapAt = 0
const unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) stt?.sendPcm(pcm)

  const sysType = event.sysEvent?.eventType ?? null
  const textType = event.textEvent?.eventType ?? null

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    // Save the conversation first, then show the system exit dialog.
    void flushSession().finally(() => serial('exit', () => bridge.shutDownPageContainer(1)))
    return
  }

  // Single tap → toggle pause / listen. CLICK_EVENT is 0, which protobuf/SDK
  // may drop, so a tap can arrive as a textEvent or sysEvent with no
  // eventType (the simulator sends {"sysEvent":{"eventSource":1}}).
  const isClick = (t: OsEventTypeList | undefined) => t === OsEventTypeList.CLICK_EVENT || t === undefined
  const isTap =
    (event.textEvent && isClick(event.textEvent.eventType)) ||
    (event.sysEvent && !event.sysEvent.imuData && isClick(event.sysEvent.eventType))
  if (isTap) {
    const now = Date.now()
    if (now - lastTapAt < 400) return // one physical tap may arrive on two channels
    lastTapAt = now
    if (paused) resume()
    else pause()
    return
  }

  // Lifecycle — survive the 5-minute locked-phone test cleanly. Leaving the
  // foreground stops the stream but keeps the listening state for return.
  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    if (!paused) carry = live
    stopStream()
    void flushSession()
    return
  }
  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    forceRender()
    if (!paused) startStream()
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)
