/**
 * Pixel diff between two screenshot directories, for the one claim this round
 * has to make about appearance: NOTHING AT REST CHANGED.
 *
 * The levers are all about what a gesture costs — which level is streamed while
 * the camera moves, how far the rasterizer may run ahead of the atlas, and
 * whether a texel nobody samples is uploaded. Every one of them is defined to
 * converge on the same resting picture, so a settled frame before and a settled
 * frame after must be the same frame. This is what says so, per pixel.
 *
 * Usage: node tests/e2e/shotDiff.mjs <dirA> <dirB> [names…]
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const [a, b, ...only] = process.argv.slice(2)
if (!a || !b) {
  console.error('usage: node tests/e2e/shotDiff.mjs <dirA> <dirB> [names…]')
  process.exit(2)
}

const pixels = async (file) => {
  const img = await loadImage(file)
  const c = createCanvas(img.width, img.height)
  c.getContext('2d').drawImage(img, 0, 0)
  return { w: img.width, h: img.height, d: c.getContext('2d').getImageData(0, 0, img.width, img.height).data }
}

const names = (only.length ? only : readdirSync(a)).filter((f) => f.endsWith('.png'))
let worstName = ''
let worst = 0
for (const name of names.sort()) {
  const fa = join(a, name)
  const fb = join(b, name)
  if (!existsSync(fa) || !existsSync(fb)) {
    console.log(`  ---- ${name}: missing on one side`)
    continue
  }
  const pa = await pixels(fa)
  const pb = await pixels(fb)
  if (pa.w !== pb.w || pa.h !== pb.h) {
    console.log(`  ---- ${name}: ${pa.w}x${pa.h} vs ${pb.w}x${pb.h}`)
    continue
  }
  let differing = 0
  let maxChannel = 0
  let sum = 0
  for (let i = 0; i < pa.d.length; i += 4) {
    const dr = Math.abs(pa.d[i] - pb.d[i])
    const dg = Math.abs(pa.d[i + 1] - pb.d[i + 1])
    const db = Math.abs(pa.d[i + 2] - pb.d[i + 2])
    const m = Math.max(dr, dg, db)
    if (m === 0) continue
    differing++
    sum += m
    maxChannel = Math.max(maxChannel, m)
  }
  const total = (pa.d.length / 4) | 0
  const pct = (differing / total) * 100
  if (pct > worst) {
    worst = pct
    worstName = name
  }
  console.log(
    `  ${name}: ${differing}/${total} pixels differ (${pct.toFixed(3)}%), ` +
      `worst channel ${maxChannel}, mean over differing ${differing ? (sum / differing).toFixed(2) : '0'}`,
  )
}
console.log(`worst: ${worstName || '—'} at ${worst.toFixed(3)}% of pixels`)
