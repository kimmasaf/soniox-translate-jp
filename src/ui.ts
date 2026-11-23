// Companion phone UI (runs in the Even app's WebView).
// Standard mobile layout: a caption screen + a separate settings screen made of
// grouped list rows (iOS/Android settings style). Japanese UI, large type.
// Font scale: --base in injectStyles() sizes everything; --main-scale and
// --settings-scale shrink/grow the caption and settings screens relative to it.
import { LANGUAGES, langName } from './languages'
import { type AppSettings, type DisplayMode, DISPLAY_MODES, hasOriginalPane } from './settings'
import type { PairView } from './paired'
import { type SessionMeta, type SessionRecord, exportText, fmtDateTime, fmtTime } from './history'

const MODE_LABEL: Record<DisplayMode, string> = {
  split: '上下分割(原文 2 行)',
  split37: '上下分割(原文 3:翻訳 7)',
  paired: '対訳(Bilingual Paired)',
  translation: '翻訳のみ(全画面)',
}

type Status = 'connecting' | 'listening' | 'error' | 'setup' | 'reconnecting' | 'paused'

const STATUS_LABEL: Record<Status, string> = {
  paused: '一時停止中',
  connecting: '接続中',
  listening: '翻訳中',
  reconnecting: '再接続中',
  error: 'エラー',
  setup: '要設定',
}

/** Speaker label used in the phone transcript (the glasses never show it). */
export const formatSpeaker = (i: number) => `話者${i + 1}: `
const SPEAKER_RE = /^(話者\d+): /

const PHONE_TAIL = 6000 // chars rendered per pane (full text kept for Copy)

let statusEl: HTMLElement
let statusTextEl: HTMLElement
let txBodyEl: HTMLElement
let tlBodyEl: HTMLElement
let tlLabelEl: HTMLElement
let secondaryEl: HTMLElement
let primaryEl: HTMLElement
let pairedEl: HTMLElement
let pairedBodyEl: HTMLElement
let tlFull = ''
let pairedFull: PairView[] = []

export interface HistoryHandlers {
  list(): Promise<SessionMeta[]>
  get(id: number): Promise<SessionRecord | null>
  remove(id: number): Promise<void>
  removeAll(): Promise<void>
  /** Id of the session being recorded right now (shown as 記録中). */
  currentId(): number | null
}

export interface UiHandlers {
  settings: AppSettings
  onSave: (next: AppSettings) => void
  history: HistoryHandlers
}

const opt = (v: string | number, label: string, sel: string | number) =>
  `<option value="${v}"${String(v) === String(sel) ? ' selected' : ''}>${label}</option>`

function selectRow(id: string, label: string, options: string) {
  return `<label class="row" for="${id}"><span class="row-label">${label}</span>
    <select id="${id}" class="row-select">${options}</select></label>`
}
function switchRow(id: string, label: string, checked: boolean, sub = '') {
  return `<label class="row" for="${id}"><span class="row-text"><span class="row-label">${label}</span>${
    sub ? `<span class="row-sub">${sub}</span>` : ''
  }</span><input id="${id}" type="checkbox" class="switch"${checked ? ' checked' : ''}/></label>`
}

export function mountUi({ settings, onSave, history }: UiHandlers) {
  const app = document.querySelector<HTMLDivElement>('#app')!
  const langOptions = LANGUAGES.map(l => opt(l.code, l.name, settings.targetLang)).join('')

  app.innerHTML = `
    <div id="view-main" class="view">
      <header class="bar">
        <h1>Soniox 翻訳</h1>
        <span class="bar-actions">
          <button id="openHistory" type="button" class="bar-btn">履歴</button>
          <button id="openSettings" type="button" class="bar-btn" aria-label="設定">⚙︎ 設定</button>
        </span>
      </header>
      <div id="status" class="status status-connecting"><span class="dot"></span><span id="status-text">接続中</span></div>

      <section id="pane-paired" class="card card-primary" aria-live="polite" hidden>
        <div class="card-head">
          <span class="card-title">対訳</span>
          <button id="copyPaired" type="button" class="text-btn">コピー</button>
        </div>
        <div id="paired-body" class="card-body paired"></div>
      </section>
      <section id="pane-primary" class="card card-primary" aria-live="polite">
        <div class="card-head">
          <span id="tl-label" class="card-title"></span>
          <button id="copyTl" type="button" class="text-btn">コピー</button>
        </div>
        <div id="tl-body" class="card-body"></div>
      </section>
      <section id="pane-secondary" class="card card-secondary" aria-live="polite">
        <div class="card-head"><span class="card-title">原文</span></div>
        <div id="tx-body" class="card-body"></div>
      </section>
      <p class="footnote">メガネのテンプルをタップで開始/一時停止、ダブルタップで終了</p>
    </div>

    <div id="view-settings" class="view" hidden>
      <header class="bar">
        <button id="closeSettings" type="button" class="bar-btn">‹ 戻る</button>
        <h1>設定</h1>
        <span class="bar-spacer"></span>
      </header>

      <h2 class="section-title">Soniox</h2>
      <div class="group">
        <div class="row row-stack">
          <label class="row-label" for="apiKey">API キー</label>
          <div class="key-wrap">
            <input id="apiKey" type="password" autocomplete="off" autocapitalize="off"
              spellcheck="false" placeholder="Soniox の API キーを貼り付け" value="${escapeAttr(settings.apiKey)}" />
            <button id="revealKey" type="button" class="text-btn">表示</button>
          </div>
        </div>
      </div>
      <p class="section-foot">キーは <a href="https://console.soniox.com" target="_blank" rel="noreferrer">console.soniox.com</a>
        で無料で取得できます。このスマートフォン内にのみ保存されます。</p>

      <h2 class="section-title">翻訳</h2>
      <div class="group">
        ${selectRow('lang', '翻訳先', langOptions)}
        <div class="row row-stack">
          <label class="row-label" for="notranslate">翻訳しない言語</label>
          <input id="notranslate" type="text" autocapitalize="off" spellcheck="false"
            placeholder="例: en, zh" value="${escapeAttr(settings.noTranslateLangs.join(', '))}" />
        </div>
      </div>
      <p class="section-foot">言語コードをカンマ区切りで入力します。翻訳先と同じ言語の発話は、翻訳せずそのまま 1 回だけ表示します。</p>

      <h2 class="section-title">メガネの表示</h2>
      <div class="group">
        ${selectRow('mode', '表示モード', DISPLAY_MODES.map(m => opt(m, MODE_LABEL[m], settings.displayMode)).join(''))}
        ${switchRow('split', '文ごとに改行', settings.splitSentences)}
        ${selectRow('align', '文字の配置', opt('left', '左寄せ', settings.align) + opt('center', '中央', settings.align))}
        ${selectRow('valign', '表示の基準', opt('bottom', '下から', settings.vAlign) + opt('top', '上から', settings.vAlign))}
        ${selectRow('linegap', '行間', opt(0, '標準', settings.lineGap) + opt(1, 'やや広め', settings.lineGap) + opt(2, '広め', settings.lineGap))}
        ${selectRow('width', '表示幅', opt(100, '全幅', settings.widthPct) + opt(85, '広め', settings.widthPct) + opt(70, '中', settings.widthPct) + opt(55, '狭め', settings.widthPct))}
        ${selectRow('maxlines', '最大行数', [0, 1, 2, 3, 4, 5, 6, 8].map(n => opt(n, n === 0 ? '自動' : `${n} 行`, settings.maxLines)).join(''))}
      </div>

      <h2 class="section-title">スマートフォンの表示</h2>
      <div class="group">
        ${switchRow('speakers', '話者を識別', settings.speakerLabels, '「話者1」などのラベルはスマートフォンにだけ表示し、メガネには表示しません')}
      </div>

      <p class="section-foot">表示モードはスマートフォンの画面にも反映されます。対訳は、原文の次の行に「→」付きで翻訳を表示します。</p>

      <button id="save" type="button" class="primary">保存</button>
      <p id="saved" class="saved" role="status"></p>
    </div>

    <div id="view-history" class="view" hidden>
      <header class="bar">
        <button id="closeHistory" type="button" class="bar-btn">‹ 戻る</button>
        <h1>履歴</h1>
        <span class="bar-spacer"></span>
      </header>
      <p class="section-foot">会話は対訳の形でこのスマートフォンのアプリ内に自動保存されます(最新 50 件)。「コピー」で全文をクリップボードにコピーし、メモなどのアプリに貼り付けて保存できます。</p>
      <div id="history-list" class="history-list"></div>
      <button id="deleteAll" type="button" class="danger" hidden>すべて削除</button>
    </div>
  `

  const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!
  statusEl = $('#status')
  statusTextEl = $('#status-text')
  txBodyEl = $('#tx-body')
  tlBodyEl = $('#tl-body')
  tlLabelEl = $('#tl-label')
  secondaryEl = $('#pane-secondary')
  primaryEl = $('#pane-primary')
  pairedEl = $('#pane-paired')
  pairedBodyEl = $('#paired-body')

  const views = { main: $('#view-main'), settings: $('#view-settings'), history: $('#view-history') }
  const show = (name: keyof typeof views) => {
    for (const [k, el] of Object.entries(views)) el.hidden = k !== name
    window.scrollTo(0, 0)
  }
  const showSettings = (on: boolean) => show(on ? 'settings' : 'main')
  $('#openSettings').addEventListener('click', () => showSettings(true))
  $('#closeSettings').addEventListener('click', () => showSettings(false))
  $('#openHistory').addEventListener('click', () => {
    show('history')
    void renderHistory(history, $('#history-list'), $<HTMLButtonElement>('#deleteAll'))
  })
  $('#closeHistory').addEventListener('click', () => show('main'))
  const deleteAllEl = $<HTMLButtonElement>('#deleteAll')
  deleteAllEl.addEventListener('click', () =>
    confirmTap(deleteAllEl, 'もう一度押すとすべて削除', async () => {
      await history.removeAll()
      void renderHistory(history, $('#history-list'), deleteAllEl)
    }),
  )

  const copyPairedEl = $<HTMLButtonElement>('#copyPaired')
  copyPairedEl.addEventListener('click', () =>
    copyToClipboard(
      pairedFull
        .map(p => {
          const o = (p.orig + p.origInterim).trim()
          const t = (p.trans + p.transInterim).trim()
          return p.same || !o ? t : t ? `${o}\n→ ${t}` : o
        })
        .filter(Boolean)
        .join('\n\n'),
      copyPairedEl,
    ),
  )

  const apiKeyEl = $<HTMLInputElement>('#apiKey')
  const revealEl = $<HTMLButtonElement>('#revealKey')
  revealEl.addEventListener('click', () => {
    const show = apiKeyEl.type === 'password'
    apiKeyEl.type = show ? 'text' : 'password'
    revealEl.textContent = show ? '隠す' : '表示'
  })

  const copyEl = $<HTMLButtonElement>('#copyTl')
  copyEl.addEventListener('click', () => copyToClipboard(tlFull.trim(), copyEl))

  const savedEl = $('#saved')
  $('#save').addEventListener('click', () => {
    const val = (id: string) => $<HTMLSelectElement | HTMLInputElement>('#' + id).value
    const on = (id: string) => $<HTMLInputElement>('#' + id).checked
    const next: AppSettings = {
      apiKey: apiKeyEl.value.trim(),
      targetLang: val('lang'),
      displayMode: (DISPLAY_MODES as string[]).includes(val('mode')) ? (val('mode') as DisplayMode) : 'split',
      noTranslateLangs: parseCodes(val('notranslate')),
      splitSentences: on('split'),
      speakerLabels: on('speakers'),
      align: val('align') === 'center' ? 'center' : 'left',
      vAlign: val('valign') === 'top' ? 'top' : 'bottom',
      lineGap: parseInt(val('linegap'), 10) || 0,
      widthPct: parseInt(val('width'), 10) || 100,
      maxLines: parseInt(val('maxlines'), 10) || 0,
    }
    setTargetLangLabel(next.targetLang)
    applyMode(next.displayMode)
    savedEl.textContent = next.apiKey ? '保存しました' : '保存しました(API キーが未入力です)'
    setTimeout(() => (savedEl.textContent = ''), 2500)
    onSave(next)
    if (next.apiKey) showSettings(false)
  })

  setTargetLangLabel(settings.targetLang)
  applyMode(settings.displayMode)
  showSettings(!settings.apiKey)
  injectStyles()
}

export function setStatus(kind: Status, text: string) {
  if (!statusEl) return
  statusEl.className = `status status-${kind}`
  statusTextEl.textContent =
    kind === 'connecting' ? STATUS_LABEL[kind] : kind === 'error' || kind === 'setup' ? `${STATUS_LABEL[kind]}: ${text}` : `${STATUS_LABEL[kind]}(${text})`
  statusEl.title = text
}

export function setTranscript(finalText: string, interimText: string) {
  if (txBodyEl) renderPane(txBodyEl, finalText, interimText)
}

export function setTranslation(finalText: string, interimText: string) {
  tlFull = finalText + interimText
  if (tlBodyEl) renderPane(tlBodyEl, finalText, interimText)
}

export function setTargetLangLabel(code: string) {
  if (!tlLabelEl) return
  tlLabelEl.textContent = code ? `翻訳(${langName(code)})` : '文字起こし'
}

// Phone layout follows the glasses display mode.
function applyMode(mode: DisplayMode) {
  if (!secondaryEl) return
  const paired = mode === 'paired'
  pairedEl.hidden = !paired
  primaryEl.hidden = paired
  secondaryEl.hidden = paired || !hasOriginalPane(mode)
  secondaryEl.classList.toggle('card-37', mode === 'split37')
  if (paired) setPaired(pairedFull)
}

/** Bilingual Paired phone view: original (dim) then translation, per utterance. */
export function setPaired(vm: PairView[]) {
  pairedFull = vm
  if (!pairedBodyEl || pairedEl.hidden) return
  const el = pairedBodyEl
  const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  const frag = document.createDocumentFragment()
  for (const p of vm.slice(-200)) {
    const orig = p.orig + p.origInterim
    const trans = p.trans + p.transInterim
    if (!orig.trim() && !trans.trim()) continue
    const item = document.createElement('div')
    item.className = 'pair'
    if (p.speaker !== undefined) {
      const chip = document.createElement('span')
      chip.className = 'speaker'
      chip.textContent = formatSpeaker(p.speaker).replace(/[:\s]+$/, '')
      item.append(chip)
    }
    if (!p.same && orig.trim()) {
      const o = document.createElement('div')
      o.className = 'pair-orig'
      o.append(p.orig)
      if (p.origInterim) o.append(interimSpan(p.origInterim))
      item.append(o)
    }
    if (trans.trim()) {
      const t = document.createElement('div')
      t.className = p.same ? 'pair-trans pair-same' : 'pair-trans'
      t.append(p.trans)
      if (p.transInterim) t.append(interimSpan(p.transInterim))
      item.append(t)
    }
    frag.append(item)
  }
  el.replaceChildren(frag)
  if (stick) el.scrollTop = el.scrollHeight
}

function interimSpan(text: string) {
  const s = document.createElement('span')
  s.className = 'interim'
  s.textContent = text
  return s
}

// ── History screen ───────────────────────────────────────────────────────────
async function renderHistory(h: HistoryHandlers, listEl: HTMLElement, deleteAllEl: HTMLButtonElement) {
  listEl.textContent = '読み込み中…'
  const items = await h.list()
  deleteAllEl.hidden = items.length === 0
  if (!items.length) {
    listEl.innerHTML = '<p class="empty">まだ保存された会話はありません。</p>'
    return
  }
  const cur = h.currentId()
  const frag = document.createDocumentFragment()
  for (const m of items) {
    const row = document.createElement('div')
    row.className = 'group history-item'
    const head = document.createElement('div')
    head.className = 'history-head'
    head.textContent = `${fmtDateTime(m.start)}〜${fmtTime(m.end)}・${m.targetLang ? langName(m.targetLang) : '文字起こし'}・${m.count} 件`
    if (m.id === cur) {
      const live = document.createElement('span')
      live.className = 'live-tag'
      live.textContent = '記録中'
      head.append(live)
    }
    const pv = document.createElement('div')
    pv.className = 'history-preview'
    pv.textContent = m.preview
    const actions = document.createElement('div')
    actions.className = 'history-actions'
    const copyBtn = button('コピー', async () => {
      const rec = await h.get(m.id)
      if (rec) await copyToClipboard(exportText(rec, formatSpeaker), copyBtn)
    })
    actions.append(copyBtn)
    if (m.id !== cur) {
      const delBtn: HTMLButtonElement = button(
        '削除',
        () =>
          confirmTap(delBtn, 'もう一度押すと削除', async () => {
            await h.remove(m.id)
            row.remove()
          }),
        'text-btn danger-text',
      )
      actions.append(delBtn)
    }
    row.append(head, pv, actions)
    frag.append(row)
  }
  listEl.replaceChildren(frag)
}

// Two-tap confirmation (window.confirm may be unavailable in the host WebView).
const armed = new WeakMap<HTMLButtonElement, { label: string; timer: number }>()
async function confirmTap(btn: HTMLButtonElement, prompt: string, action: () => Promise<void>) {
  const a = armed.get(btn)
  if (a) {
    clearTimeout(a.timer)
    armed.delete(btn)
    btn.textContent = a.label
    await action()
    return
  }
  const label = btn.textContent ?? ''
  btn.textContent = prompt
  armed.set(btn, {
    label,
    timer: window.setTimeout(() => {
      armed.delete(btn)
      btn.textContent = label
    }, 3000),
  })
}

function button(label: string, onClick: () => void | Promise<void>, cls = 'text-btn') {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.textContent = label
  b.addEventListener('click', () => void onClick())
  return b
}



// Render text into a pane: "話者N: " line prefixes become label chips, the
// interim (not yet final) tail is dimmed, and the pane sticks to the bottom.
function renderPane(el: HTMLElement, finalText: string, interimText: string) {
  const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  let text = finalText
  if (text.length > PHONE_TAIL) {
    text = text.slice(-PHONE_TAIL)
    const nl = text.indexOf('\n')
    if (nl >= 0) text = text.slice(nl + 1)
  }
  const frag = document.createDocumentFragment()
  text.split('\n').forEach((line, i) => {
    if (i > 0) frag.append('\n')
    const m = SPEAKER_RE.exec(line)
    if (m) {
      const chip = document.createElement('span')
      chip.className = 'speaker'
      chip.textContent = m[1]
      frag.append(chip, line.slice(m[0].length))
    } else {
      frag.append(line)
    }
  })
  if (interimText) {
    const s = document.createElement('span')
    s.className = 'interim'
    s.textContent = interimText
    frag.append(s)
  }
  el.replaceChildren(frag)
  if (stick) el.scrollTop = el.scrollHeight
}

function parseCodes(s: string): string[] {
  return s
    .split(/[\s,、]+/)
    .map(x => x.trim().toLowerCase())
    .filter(Boolean)
}

async function copyToClipboard(text: string, btn: HTMLButtonElement) {
  const flash = (msg: string) => {
    const prev = btn.textContent
    btn.textContent = msg
    setTimeout(() => (btn.textContent = prev), 1500)
  }
  if (!text) return flash('まだありません')
  try {
    await navigator.clipboard.writeText(text)
    return flash('コピーしました')
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      return flash('コピーしました')
    } catch {
      return flash('コピー失敗')
    }
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function injectStyles() {
  const css = `
    :root {
      /* One knob for all text sizes (the old UI used 11-18px; this is ~2x). */
      --base: 24px;
      /* Settings screen text relative to --base (0.7 = 70%). */
      --settings-scale: 0.7em;
      /* Caption (main) screen text relative to --base (0.7 = 70%). */
      --main-scale: 0.7em;
      color-scheme: light dark;
      --bg: #f2f2f7; --card: #ffffff; --text: #1c1c1e; --sub: #6c6c70; --sep: #d1d1d6;
      --accent: #007aff; --ok: #34c759; --warn: #ff9500; --err: #ff3b30; --interim: #8e8e93;
      --chip-bg: rgba(0,122,255,0.12);
    }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #000000; --card: #1c1c1e; --text: #ffffff; --sub: #98989f; --sep: #38383a;
        --accent: #0a84ff; --ok: #30d158; --warn: #ff9f0a; --err: #ff453a; --interim: #8d8d93;
        --chip-bg: rgba(10,132,255,0.22); }
    }
    html { font-size: var(--base); }
    html, body { margin: 0; background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Noto Sans JP', system-ui, sans-serif;
      line-height: 1.5; -webkit-text-size-adjust: 100%; }
    [hidden] { display: none !important; }
    /* Sizes below are in em, so each screen can be scaled on its own. */
    #view-settings { font-size: var(--settings-scale); }
    #view-main { font-size: var(--main-scale); }
    .view { max-width: 720px; margin: 0 auto; padding: 0 0.75em 1.5em; box-sizing: border-box;
      display: flex; flex-direction: column; gap: 0.6em; min-height: 100vh; }

    .bar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between;
      gap: 0.5em; padding: 0.6em 0; background: var(--bg); }
    .bar h1 { font-size: 1.25em; font-weight: 700; margin: 0; }
    .bar-btn { background: none; border: 0; color: var(--accent); font: inherit; font-size: 1em;
      padding: 0.3em 0; cursor: pointer; min-height: 2em; }
    .bar-spacer { width: 3.5em; }

    .status { display: flex; align-items: center; gap: 0.4em; font-size: 0.9em; color: var(--sub); }
    .status .dot { width: 0.55em; height: 0.55em; border-radius: 50%; background: var(--sub); flex: none; }
    .status-listening .dot { background: var(--ok); }
    .status-listening { color: var(--ok); }
    .status-reconnecting .dot { background: var(--warn); } .status-reconnecting { color: var(--warn); }
    .status-setup .dot { background: var(--warn); } .status-setup { color: var(--warn); }
    .status-error .dot { background: var(--err); } .status-error { color: var(--err); }

    .card { background: var(--card); border-radius: 0.6em; padding: 0.6em 0.75em;
      display: flex; flex-direction: column; gap: 0.3em; min-height: 4.5em; }
    .card-primary { flex: 2.5; }
    .card-secondary { flex: 1; }
    .card-head { display: flex; align-items: center; justify-content: space-between; }
    .card-title { font-size: 0.9em; font-weight: 600; color: var(--sub); }
    .card-body { flex: 1; overflow: auto; max-height: 60vh; white-space: pre-wrap; word-break: break-word;
      font-size: 1.15em; line-height: 1.6; }
    .card-secondary .card-body { font-size: 1em; color: var(--sub); max-height: 30vh; }
    .interim { color: var(--interim); }
    .speaker { display: inline-block; font-size: 0.7em; font-weight: 600; color: var(--accent);
      background: var(--chip-bg); border-radius: 0.4em; padding: 0 0.35em; margin-right: 0.35em;
      vertical-align: 0.1em; line-height: 1.5; }
    .footnote { font-size: 0.85em; color: var(--sub); text-align: center; margin: 0.3em 0 0; }

    .section-title { font-size: 0.85em; font-weight: 400; color: var(--sub); margin: 0.9em 0.6em 0.1em; }
    .section-foot { font-size: 0.85em; color: var(--sub); margin: 0.1em 0.6em 0; }
    .section-foot a { color: var(--accent); }
    .group { background: var(--card); border-radius: 0.6em; overflow: hidden; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 0.75em;
      min-height: 2.4em; padding: 0.45em 0.75em; box-sizing: border-box; border-top: 1px solid var(--sep); }
    .group > .row:first-child { border-top: 0; }
    .row-stack { flex-direction: column; align-items: stretch; gap: 0.35em; }
    .row-text { display: flex; flex-direction: column; gap: 0.1em; min-width: 0; }
    .row-label { font-size: 1em; }
    .row-sub { font-size: 0.8em; color: var(--sub); }
    .row-select { -webkit-appearance: none; appearance: none; font: inherit; font-size: 1em; color: var(--sub);
      background: transparent url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='16' viewBox='0 0 10 16'%3E%3Cpath d='M2 2l6 6-6 6' fill='none' stroke='%238e8e93' stroke-width='2'/%3E%3C/svg%3E") no-repeat right center / 0.4em auto;
      border: 0; text-align: right; text-align-last: right; padding: 0.2em 0.75em 0.2em 0; max-width: 60%; cursor: pointer; }
    .row-select option { color: initial; }
    .row input[type=text], .row input[type=password] { font: inherit; font-size: 1em; color: var(--text);
      background: var(--bg); border: 1px solid var(--sep); border-radius: 0.4em; padding: 0.35em 0.5em;
      width: 100%; box-sizing: border-box; min-width: 0; }
    .key-wrap { display: flex; gap: 0.5em; align-items: center; }
    .text-btn { background: none; border: 0; color: var(--accent); font: inherit; font-size: 0.9em;
      padding: 0.2em 0.3em; cursor: pointer; white-space: nowrap; }

    /* iOS-style toggle switch on a checkbox */
    .switch { appearance: none; -webkit-appearance: none; flex: none; position: relative; margin: 0;
      width: 2.15em; height: 1.3em; border-radius: 1em; background: var(--sep); cursor: pointer;
      transition: background 0.2s; }
    .switch::after { content: ''; position: absolute; top: 0.1em; left: 0.1em; width: 1.1em; height: 1.1em;
      border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.3); transition: transform 0.2s; }
    .switch:checked { background: var(--ok); }
    .switch:checked::after { transform: translateX(0.85em); }
    @media (prefers-reduced-motion: reduce) { .switch, .switch::after { transition: none; } }

    .primary { margin-top: 1em; width: 100%; min-height: 2.3em; border: 0; border-radius: 0.6em;
      background: var(--accent); color: #fff; font: inherit; font-size: 1em; font-weight: 600; cursor: pointer; }
    .primary:active { opacity: 0.8; }
    .saved { min-height: 1.4em; font-size: 0.9em; color: var(--ok); text-align: center; margin: 0.3em 0 0; }

    .bar-actions { display: flex; gap: 0.9em; }
    /* split37: original pane 3 : translation 7 */
    .card-secondary.card-37 { flex: 1.07; }

    /* Bilingual Paired */
    .card-body.paired { white-space: normal; display: flex; flex-direction: column; gap: 0.7em; }
    .pair-orig { color: var(--sub); font-size: 0.85em; white-space: pre-wrap; }
    .pair-trans { white-space: pre-wrap; }
    .pair-trans:not(.pair-same)::before { content: '→ '; color: var(--sub); }
    .pair > .speaker { margin-bottom: 0.15em; }

    /* History */
    .history-list { display: flex; flex-direction: column; gap: 0.6em; margin-top: 0.4em; }
    .history-item { padding: 0.6em 0.75em; display: flex; flex-direction: column; gap: 0.25em; }
    .history-head { font-size: 0.85em; color: var(--sub); display: flex; align-items: center; gap: 0.5em; flex-wrap: wrap; }
    .history-preview { font-size: 1em; }
    .history-actions { display: flex; gap: 1em; margin-top: 0.2em; }
    .history-actions .text-btn { padding-left: 0; }
    .live-tag { font-size: 0.8em; color: #fff; background: var(--ok); border-radius: 0.4em; padding: 0 0.4em; }
    .danger-text { color: var(--err) !important; }
    .danger { margin-top: 1em; width: 100%; min-height: 2.3em; border: 0; border-radius: 0.6em;
      background: var(--card); color: var(--err); font: inherit; font-size: 1em; cursor: pointer; }
    .empty { color: var(--sub); text-align: center; margin: 2em 0; }
    #view-history { font-size: var(--settings-scale); }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
