#!/usr/bin/env node
// Builds the Even Hub store icon: 24x24 PNG, every pixel fully transparent or
// opaque #F4F4F4, lit pixels in raster-aligned 2x2 blocks (drawn on a 12x12
// grid and scaled 2x). Motif: speech bubble with caption lines (as icon.svg).
// Usage: node scripts/make-icon.mjs  ->  assets/icon-24.png (+ icon-24-preview.png, 10x)
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const GRID = [
  '............',
  '............',
  '..########..',
  '.#........#.',
  '.#.######.#.',
  '.#........#.',
  '.#.####...#.',
  '.#........#.',
  '..########..',
  '...##.......',
  '...#........',
  '............',
]

function png(size, scale, bg) {
  const w = size * scale
  const raw = Buffer.alloc((w * 4 + 1) * w)
  for (let y = 0; y < w; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter: none
    for (let x = 0; x < w; x++) {
      const lit = GRID[Math.floor(y / scale / 2)][Math.floor(x / scale / 2)] === '#'
      const o = y * (w * 4 + 1) + 1 + x * 4
      const c = lit ? [0xf4, 0xf4, 0xf4, 255] : bg
      raw.set(c, o)
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = buf => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(w, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

const out = new URL('../assets/', import.meta.url)
writeFileSync(new URL('icon-24.png', out), png(24, 1, [0, 0, 0, 0]))
writeFileSync(new URL('icon-24-preview.png', out), png(24, 10, [0x1d, 0x1d, 0x1d, 255]))
console.log('wrote assets/icon-24.png and assets/icon-24-preview.png')
