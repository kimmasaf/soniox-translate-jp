// Curated subset of Soniox's 60+ supported translation targets (any supported
// language can be a target). Extend freely — every code below is valid.
// Full list: https://soniox.com/docs/stt/concepts/supported-languages
export interface Language {
  code: string
  name: string
}

export const LANGUAGES: Language[] = [
  { code: '', name: 'なし(文字起こしのみ)' },
  { code: 'ja', name: '日本語' },
  { code: 'en', name: '英語' },
  { code: 'zh', name: '中国語' },
  { code: 'ko', name: '韓国語' },
  { code: 'es', name: 'スペイン語' },
  { code: 'fr', name: 'フランス語' },
  { code: 'de', name: 'ドイツ語' },
  { code: 'it', name: 'イタリア語' },
  { code: 'pt', name: 'ポルトガル語' },
  { code: 'ru', name: 'ロシア語' },
  { code: 'hi', name: 'ヒンディー語' },
  { code: 'ar', name: 'アラビア語' },
  { code: 'tr', name: 'トルコ語' },
  { code: 'vi', name: 'ベトナム語' },
  { code: 'th', name: 'タイ語' },
  { code: 'id', name: 'インドネシア語' },
  { code: 'pl', name: 'ポーランド語' },
  { code: 'uk', name: 'ウクライナ語' },
  { code: 'nl', name: 'オランダ語' },
  { code: 'sv', name: 'スウェーデン語' },
  { code: 'el', name: 'ギリシャ語' },
  { code: 'he', name: 'ヘブライ語' },
  { code: 'cs', name: 'チェコ語' },
  { code: 'ro', name: 'ルーマニア語' },
]

export function langName(code: string): string {
  return LANGUAGES.find(l => l.code === code)?.name ?? code.toUpperCase()
}
