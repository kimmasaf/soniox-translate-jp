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
