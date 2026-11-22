// Bilingual Paired view: each original utterance followed by its translation.
// Shared by the glasses renderer, the phone UI and the saved history export.

/** One utterance. `same` = spoken in the target (or a keep-as-is) language,
 *  so it has no separate original: the text lives in `trans` only. */
export interface Pair {
  /** Speaker index in order of appearance (only with speaker labels on). */
  speaker?: number
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

/** Plain-text export (Bilingual Paired). */
export function pairedExportText(
  pairs: Pair[],
  header: string,
  formatSpeaker?: (i: number) => string,
): string {
  const lines: string[] = [header, '']
  for (const p of pairs) {
    const orig = p.orig.replace(/\s*\n\s*/g, ' ').trim()
    const trans = p.trans.replace(/\s*\n\s*/g, ' ').trim()
    if (!orig && !trans) continue
    const spk = p.speaker !== undefined && formatSpeaker ? `[${formatSpeaker(p.speaker).replace(/[:\s]+$/, '')}] ` : ''
    if (p.same || !orig) {
      lines.push(spk + trans)
    } else {
      lines.push(spk + orig)
      if (trans) lines.push(TRANS_MARK + trans)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}
