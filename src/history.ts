// Conversation history: each listening session is saved in Bilingual Paired
// form via the SDK's per-user storage (kept inside the Even app on the phone),
// and can be exported to the phone later as a text file.
//
// Layout: one small index key + one key per session, so autosaving the
// current session never rewrites the whole history.
import type { Pair } from './paired'
import { pairedExportText } from './paired'
import { langName } from './languages'

export interface SessionMeta {
  id: number // = start time (ms)
  start: number
  end: number
  targetLang: string
  count: number
  preview: string
}

export interface SessionRecord extends SessionMeta {
  pairs: Pair[]
}

export interface KV {
  get(key: string): Promise<string>
  set(key: string, value: string): Promise<unknown>
}

const INDEX_KEY = 'soniox.history.index.v1'
const sessionKey = (id: number) => `soniox.history.s.${id}`
export const MAX_SESSIONS = 50

export class History {
  constructor(private kv: KV) {}

  async list(): Promise<SessionMeta[]> {
    try {
      const raw = await this.kv.get(INDEX_KEY)
      const arr = raw ? (JSON.parse(raw) as SessionMeta[]) : []
      return Array.isArray(arr) ? arr.sort((a, b) => b.start - a.start) : []
    } catch {
      return []
    }
  }

  async get(id: number): Promise<SessionRecord | null> {
    try {
      const raw = await this.kv.get(sessionKey(id))
      return raw ? (JSON.parse(raw) as SessionRecord) : null
    } catch {
      return null
    }
  }

  /** Insert or update a session (no-op for empty sessions). */
  async save(rec: SessionRecord): Promise<void> {
    const pairs = rec.pairs.filter(p => (p.orig + p.trans).trim())
    if (!pairs.length) return
    const meta: SessionMeta = {
      id: rec.id, start: rec.start, end: rec.end, targetLang: rec.targetLang,
      count: pairs.length, preview: previewOf(pairs),
    }
    await this.kv.set(sessionKey(rec.id), JSON.stringify({ ...meta, pairs }))
    const list = (await this.list()).filter(m => m.id !== rec.id)
    list.unshift(meta)
    const dropped = list.splice(MAX_SESSIONS)
    await this.kv.set(INDEX_KEY, JSON.stringify(list))
    for (const d of dropped) await this.kv.set(sessionKey(d.id), '') // SDK has no delete; blank it
  }

  async remove(id: number): Promise<void> {
    const list = (await this.list()).filter(m => m.id !== id)
    await this.kv.set(INDEX_KEY, JSON.stringify(list))
    await this.kv.set(sessionKey(id), '')
  }

  async removeAll(): Promise<void> {
    const list = await this.list()
    await this.kv.set(INDEX_KEY, '[]')
    for (const m of list) await this.kv.set(sessionKey(m.id), '')
  }
}

function previewOf(pairs: Pair[]): string {
  const p = pairs.find(x => x.trans.trim()) ?? pairs[0]
  const t = (p.trans || p.orig).replace(/\s+/g, ' ').trim()
  return t.length > 60 ? t.slice(0, 60) + '…' : t
}

const pad = (n: number) => String(n).padStart(2, '0')
export function fmtDateTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function exportFileName(rec: SessionMeta): string {
  const d = new Date(rec.start)
  return `soniox_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.txt`
}

export function exportText(rec: SessionRecord, formatSpeaker?: (i: number) => string): string {
  const target = rec.targetLang ? `翻訳先: ${langName(rec.targetLang)}` : '文字起こしのみ'
  const header = `Soniox 翻訳 — ${fmtDateTime(rec.start)}〜${fmtTime(rec.end)}(${target})`
  return pairedExportText(rec.pairs, header, formatSpeaker)
}
