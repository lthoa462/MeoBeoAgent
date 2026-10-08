#!/usr/bin/env node
/**
 * Draws the two Teams app icons with nothing but node:zlib, so the repo needs
 * no image tooling and the PNGs can always be regenerated:
 *
 *   color.png    192×192  a fat cat face on the accent color (full bleed)
 *   outline.png   32×32   white cat silhouette on transparent (Teams requires
 *                         white + transparency only)
 *
 * Shapes live in unit coordinates (x right, y down) and are tested at 4×4
 * sub-samples per pixel, which is all the anti-aliasing an icon needs.
 *
 *   node apps/teams-app/scripts/make-icons.mjs
 */

import { writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

/** Keep in sync with `accentColor` in manifest.template.json. */
const ACCENT = '#F0803C'
const FUR = '#FFF8F0'
const INK = '#2E2A3A'
const PINK = '#F2708F'
const SUBSAMPLES = 4

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// --- geometry -------------------------------------------------------------

const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1

function triangle(a, b, c) {
  const side = (p, q, x, y) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])
  return (x, y) => {
    const d1 = side(a, b, x, y)
    const d2 = side(b, c, x, y)
    const d3 = side(c, a, x, y)
    return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)
  }
}

/** A round-capped stroke from a to b. */
function segment(a, b, width) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const lengthSq = dx * dx + dy * dy
  return (x, y) => {
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSq))
    return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)) <= width / 2
  }
}

/** Lower half of a ring: one bump of the "ω" mouth. */
const smile = (cx, cy, r, width) => (x, y) => y >= cy && Math.abs(Math.hypot(x - cx, y - cy) - r) <= width / 2

const any = (...shapes) => (x, y) => shapes.some(shape => shape(x, y))
const mirror = (point) => [1 - point[0], point[1]]

/** The same triangle pulled toward its centroid (inner ear). */
function shrink(points, factor) {
  const cx = (points[0][0] + points[1][0] + points[2][0]) / 3
  const cy = (points[0][1] + points[1][1] + points[2][1]) / 3
  return points.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor])
}

/** Scale a shape about the icon center, so the face keeps a safe margin. */
const scaled = (shape, scale) => (x, y) => shape(0.5 + (x - 0.5) / scale, 0.5 + (y - 0.5) / scale)

// --- the cat --------------------------------------------------------------

const EAR = [[0.17, 0.47], [0.22, 0.13], [0.45, 0.31]]
const ears = any(triangle(...EAR), triangle(...EAR.map(mirror)))
const innerEars = any(triangle(...shrink(EAR, 0.55)), triangle(...shrink(EAR, 0.55).map(mirror)))
const head = ellipse(0.5, 0.58, 0.36, 0.3)
const eyes = (rx, ry) => any(ellipse(0.37, 0.56, rx, ry), ellipse(0.63, 0.56, rx, ry))

/** Layers painted bottom to top; `erase` punches transparent holes. */
function colorLayers() {
  const whisker = (a, b) => any(segment(a, b, 0.012), segment(mirror(a), mirror(b), 0.012))
  return [
    { shape: () => true, color: ACCENT },
    { shape: ears, color: FUR },
    { shape: innerEars, color: PINK, alpha: 0.75 },
    { shape: head, color: FUR },
    { shape: any(ellipse(0.27, 0.68, 0.055, 0.035), ellipse(0.73, 0.68, 0.055, 0.035)), color: PINK, alpha: 0.35 },
    { shape: any(whisker([0.06, 0.6], [0.24, 0.64]), whisker([0.06, 0.71], [0.24, 0.685])), color: INK, alpha: 0.6 },
    { shape: eyes(0.042, 0.058), color: INK },
    { shape: any(ellipse(0.383, 0.537, 0.016, 0.016), ellipse(0.643, 0.537, 0.016, 0.016)), color: '#FFFFFF' },
    { shape: triangle([0.462, 0.64], [0.538, 0.64], [0.5, 0.688]), color: PINK },
    { shape: any(smile(0.465, 0.688, 0.035, 0.014), smile(0.535, 0.688, 0.035, 0.014)), color: INK },
  ].map(layer => layer.color === ACCENT ? layer : { ...layer, shape: scaled(layer.shape, 0.8) })
}

function outlineLayers() {
  // Larger eyes than the color icon: at 32 px anything smaller disappears.
  return [
    { shape: any(ears, head), color: '#FFFFFF' },
    { shape: eyes(0.06, 0.08), erase: true },
  ]
}

// --- raster + PNG ---------------------------------------------------------

function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(channel => channel / 255)
}

/** Composite layers per sub-sample in premultiplied RGBA, average, write 8-bit RGBA. */
function render(size, layers) {
  const prepared = layers.map(layer => ({ ...layer, rgb: layer.erase ? [0, 0, 0] : rgb(layer.color), alpha: layer.alpha ?? 1 }))
  const pixels = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0, 0]
      for (let sy = 0; sy < SUBSAMPLES; sy++) {
        for (let sx = 0; sx < SUBSAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SUBSAMPLES) / size
          const y = (py + (sy + 0.5) / SUBSAMPLES) / size
          let out = [0, 0, 0, 0]
          for (const layer of prepared) {
            if (!layer.shape(x, y)) continue
            if (layer.erase) {
              out = [0, 0, 0, 0]
              continue
            }
            const a = layer.alpha
            out = [...layer.rgb.map((c, i) => c * a + out[i] * (1 - a)), a + out[3] * (1 - a)]
          }
          for (let i = 0; i < 4; i++) sum[i] += out[i]
        }
      }
      const samples = SUBSAMPLES * SUBSAMPLES
      const alpha = sum[3] / samples
      const offset = (py * size + px) * 4
      for (let i = 0; i < 3; i++) pixels[offset + i] = alpha === 0 ? 0 : Math.round((sum[i] / samples / alpha) * 255)
      pixels[offset + 3] = Math.round(alpha * 255)
    }
  }
  return pixels
}

function chunk(type, data) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(data, crc32(header.subarray(4))))
  return Buffer.concat([header, data, crc])
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA; compression, filter and interlace stay 0
  const stride = size * 4
  // Every scanline starts with filter type 0 (None); deflate does the rest.
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const [file, size, layers] of [['color.png', 192, colorLayers()], ['outline.png', 32, outlineLayers()]]) {
  const target = resolve(appDir, file)
  const png = encodePng(size, render(size, layers))
  writeFileSync(target, png)
  console.log(`${relative(process.cwd(), target) || file}  ${size}×${size}  ${png.length} bytes`)
}
