// Per-user app settings, persisted via the SDK's localStorage (survives app
// restarts; stored per-user in the Even companion app). Each user supplies
// their OWN Soniox API key so they're billed for their own usage.

/**
 * Glasses (and phone) layout:
 *  - split:       original strip on top (2 lines) + translation below
 *  - split37:     original 3 : translation 7 (3 lines + 7 lines)
 *  - paired:      Bilingual Paired — each original followed by its translation
 *  - translation: translation only, full screen
 */
export type DisplayMode = 'split' | 'split37' | 'paired' | 'translation'
export const DISPLAY_MODES: DisplayMode[] = ['split', 'split37', 'paired', 'translation']

export interface AppSettings {
  /** User's Soniox API key. Empty until they set it in the phone UI. */
  apiKey: string
  /** Translation target language code ('' = transcript only). */
  targetLang: string
  /** Screen layout (see DisplayMode). */
  displayMode: DisplayMode
  /** Language codes to keep as-is / NOT translate (the target is always kept). */
  noTranslateLangs: string[]
  /** Soniox language_hints: languages likely to be spoken (bias only, others still recognized). */
  languageHints: string[]
  /** Soniox context (sent once per stream; improves names/terms and controls translations). */
  ctxTopic: string
  /** Terms to recognize/spell as written (one per line or comma separated). */
  ctxTerms: string
  /** Fixed translations, one "source=target" per line (map a name to itself to keep it). */
  ctxTranslationTerms: string
  /** Longer background text (description, agenda, notes). */
  ctxText: string
  /** Newline per sentence (at . ? ! + Soniox pauses). */
  splitSentences: boolean
  /** Speaker diarization; labels are shown on the phone only (never on the glasses). */
  speakerLabels: boolean
  /** Horizontal text alignment on the glasses ('center' is faked via space padding). */
  align: 'left' | 'center'
  /** Vertical anchor: 'bottom' pins the newest line to the pane bottom (grows up); 'top' fills from the top. */
  vAlign: 'top' | 'bottom'
  /** Blank lines inserted between content lines (0 = normal, 1 = relaxed, 2 = loose). */
  lineGap: number
  /** Text column width as a percent of the 576px display (100 = full, centered when narrower). */
  widthPct: number
  /** Max visible lines in the main pane (0 = auto / fill the pane). */
  maxLines: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  targetLang: 'ja',
  displayMode: 'split',
  noTranslateLangs: [],
  languageHints: ['ja', 'en'],
  ctxTopic: '',
  ctxTerms: '',
  ctxTranslationTerms: '',
  ctxText: '',
  splitSentences: true,
  speakerLabels: false,
  align: 'left',
  vAlign: 'bottom',
  lineGap: 0,
  widthPct: 100,
  maxLines: 0,
}

/** Whether the layout has a separate original-language pane. */
export function hasOriginalPane(mode: DisplayMode): boolean {
  return mode === 'split' || mode === 'split37'
}

/** Soniox context size limit is ~8,000 tokens (about 10,000 characters). */
export const CONTEXT_MAX_CHARS = 9000

export interface SonioxContext {
  general?: { key: string; value: string }[]
  text?: string
  terms?: string[]
  translation_terms?: { source: string; target: string }[]
}

/** Build the Soniox `context` object from settings (undefined when empty). */
export function buildContext(s: AppSettings): SonioxContext | undefined {
  const ctx: SonioxContext = {}
  const topic = s.ctxTopic.trim()
  if (topic) ctx.general = [{ key: 'topic', value: topic }]
  const terms = s.ctxTerms.split(/[\n,、]+/).map(t => t.trim()).filter(Boolean)
  if (terms.length) ctx.terms = terms
  const tt = s.ctxTranslationTerms
    .split('\n')
    .map(line => line.split(/\s*(?:=|→|->)\s*/))
    .filter(p => p.length === 2 && p[0].trim() && p[1].trim())
    .map(([source, target]) => ({ source: source.trim(), target: target.trim() }))
  if (tt.length) ctx.translation_terms = tt
  const text = s.ctxText.trim()
  if (text) ctx.text = text.slice(0, CONTEXT_MAX_CHARS)
  // Keep the whole context under the API limit (an oversize context is rejected).
  const over = JSON.stringify(ctx).length - CONTEXT_MAX_CHARS
  if (over > 0 && ctx.text) ctx.text = ctx.text.slice(0, Math.max(0, ctx.text.length - over)) || undefined
  return Object.keys(ctx).some(k => ctx[k as keyof SonioxContext] !== undefined) ? ctx : undefined
}

// Single localStorage key holding the JSON-serialized settings.
export const SETTINGS_KEY = 'soniox.settings.v1'

export function mergeSettings(raw: string | null | undefined): AppSettings {
  if (!raw) return { ...DEFAULT_SETTINGS }
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings> & { showTranscript?: boolean }
    const s = { ...DEFAULT_SETTINGS, ...parsed }
    // Migrate the old on/off "show original transcript" switch.
    if (!parsed.displayMode && parsed.showTranscript === false) s.displayMode = 'translation'
    if (!DISPLAY_MODES.includes(s.displayMode)) s.displayMode = DEFAULT_SETTINGS.displayMode
    delete (s as { showTranscript?: boolean }).showTranscript
    return s
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}
