// Bilingual Paired view: each original utterance followed by its translation.
// Shared by the glasses renderer, the phone UI and the saved history export.

/** One utterance. `same` = spoken in the target (or a keep-as-is) language,
 *  so it has no separate original: the text lives in `trans` only. */
export interface Pair {
  /** Speaker index in order of appearance (only with speaker labels on). */
  speaker?: number
  /** When the utterance started (ms since epoch). */
  at?: number
  orig: string
  trans: string
  same: boolean
}

/** A pair plus the not-yet-final tail shown while speech is in progress. */
export interface PairView extends Pair {
  origInterim: string
  transInterim: string
}

/** Merge live interim text into the final pairs (does not mutate `pairs`). */
export function withInterim(
  pairs: Pair[],
  txInterim: string,
  tlInterim: string,
  sameInterim: string,
): PairView[] {
  const vm: PairView[] = pairs.map(p => ({ ...p, origInterim: '', transInterim: '' }))
  // Translation in progress belongs to the latest foreign-language pair.
  if (tlInterim) {
    for (let i = vm.length - 1; i >= 0; i--) {
      if (!vm[i].same) {
        vm[i].transInterim = tlInterim
        break
      }
    }
  }
  if (sameInterim) {
    const last = vm[vm.length - 1]
    if (last?.same) last.transInterim = sameInterim
    else vm.push({ orig: '', trans: '', same: true, origInterim: '', transInterim: sameInterim })
  }
  if (txInterim) {
    const last = vm[vm.length - 1]
    if (last && !last.same && !last.trans && !last.transInterim) last.origInterim = txInterim
    else vm.push({ orig: '', trans: '', same: false, origInterim: txInterim, transInterim: '' })
  }
  return vm
}

/** Line break inside one pair (no blank-line gap is inserted at this break). */
export const PAIR_LINE = '\u2028'
/** Prefix marking the translation line of a pair on the glasses / export. */
export const TRANS_MARK = '→ '

/** Glasses text: pairs separated by '\n', original and translation by PAIR_LINE. */
export function pairedGlassesText(vm: PairView[]): string {
  const out: string[] = []
  for (const p of vm) {
    const orig = (p.orig + p.origInterim).replace(/\s*\n\s*/g, ' ').trim()
    const trans = (p.trans + p.transInterim).replace(/\s*\n\s*/g, ' ').trim()
    if (p.same || !orig) {
      if (trans) out.push(trans)
    } else {
      out.push(trans ? orig + PAIR_LINE + TRANS_MARK + trans : orig)
    }
  }
  return out.join('\n')
}

const pad2 = (n: number) => String(n).padStart(2, '0')
/** HH:MM:SS (local time). */
export function fmtClock(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** Text lines of one pair: "[HH:MM:SS] [話者N] original" then "→ translation". */
export function pairLines(p: Pair & Partial<PairView>, formatSpeaker?: (i: number) => string): string[] {
  const orig = (p.orig + (p.origInterim ?? '')).replace(/\s*\n\s*/g, ' ').trim()
  const trans = (p.trans + (p.transInterim ?? '')).replace(/\s*\n\s*/g, ' ').trim()
  if (!orig && !trans) return []
  const time = p.at ? `[${fmtClock(p.at)}] ` : ''
  const spk = p.speaker !== undefined && formatSpeaker ? `[${formatSpeaker(p.speaker).replace(/[:\s]+$/, '')}] ` : ''
  if (p.same || !orig) return [time + spk + trans]
  return trans ? [time + spk + orig, TRANS_MARK + trans] : [time + spk + orig]
}

/** Plain-text export (Bilingual Paired): header, blank line, then pairs with no gaps. */
export function pairedExportText(
  pairs: (Pair & Partial<PairView>)[],
  header: string,
  formatSpeaker?: (i: number) => string,
): string {
  const lines = pairs.flatMap(p => pairLines(p, formatSpeaker))
  return (header ? [header, '', ...lines] : lines).join('\n') + '\n'
}
