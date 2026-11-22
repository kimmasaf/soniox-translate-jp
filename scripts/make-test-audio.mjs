#!/usr/bin/env node
// Generates English + Japanese test speech with Soniox Text-to-Speech, in the
// G2 mic's native format (PCM s16le, 16 kHz, mono), saved as WAV.
//
// Usage:  node scripts/make-test-audio.mjs
// Output: test-audio/en.wav, test-audio/ja.wav
// Key:    $SONIOX_API_KEY, else VITE_STT_API_KEY from .env.local
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'

const TTS_URL = 'https://tts-rt.soniox.com/tts'
const MODEL = process.env.SONIOX_TTS_MODEL || 'tts-rt-v2'
const VOICE = process.env.SONIOX_TTS_VOICE || 'Daniel'
const OUT_DIR = new URL('../test-audio/', import.meta.url)

const CLIPS = [
  {
    name: 'en',
    language: 'en',
    text:
      "Hi, thanks for coming today. Let me walk you through the plan. " +
      "We'll start with a short demo, then talk about pricing, and finish with questions. " +
      "Does that work for you?",
  },
  {
    name: 'ja',
    language: 'ja',
    text:
      'こんにちは、本日はお越しいただきありがとうございます。' +
      'まず簡単なデモをお見せして、そのあと料金についてご説明します。' +
      '最後に質問の時間を設けますが、よろしいでしょうか。',
  },
]

function loadKey() {
  if (process.env.SONIOX_API_KEY) return process.env.SONIOX_API_KEY.trim()
  const envPath = new URL('../.env.local', import.meta.url)
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, 'utf8').match(/(?:VITE_STT_API_KEY|SONIOX_API_KEY)\s*=\s*(\S+)/)
    if (m) return m[1].trim()
  }
  return null
}

function wavFromPcm(pcm, sampleRate = 16000) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

const key = loadKey()
if (!key) { console.error('No Soniox key (set SONIOX_API_KEY or .env.local)'); process.exit(1) }
mkdirSync(OUT_DIR, { recursive: true })

for (const c of CLIPS) {
  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, language: c.language, voice: VOICE,
      audio_format: 'pcm_s16le', sample_rate: 16000, text: c.text,
    }),
  })
  if (!res.ok) {
    console.error(`${c.name}: HTTP ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const pcm = Buffer.from(await res.arrayBuffer())
  const file = new URL(`${c.name}.wav`, OUT_DIR)
  writeFileSync(file, wavFromPcm(pcm))
  console.log(`${c.name}: ${(pcm.length / 32000).toFixed(1)}s → ${file.pathname}`)
}
