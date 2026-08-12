#!/usr/bin/env node
/**
 * The numbers the drawn map's constants are derived from, measured rather than
 * guessed — the same rule `maxLevel` follows for a WMS source.
 *
 *  1. LOD_Z / LOD_FINE_Z: the level at which each rung stops being able to say
 *     what a tile pixel could show, i.e. where the next file first survives the
 *     half-pixel filter with materially more segments.
 *  2. Z_MAX: where the data saturates (every vertex it owns already survives,
 *     so a finer level is the same polyline magnified) and how long a median
 *     facet is in tile pixels there — the two halves of the ceiling.
 *  3. The tile render budget, in milliseconds, at the levels people look at.
 *
 * Run: npx tsx scripts/measure-drawn.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, Path2D } from '@napi-rs/canvas'

// The rasterizer is written against the 2D API, not against a browser: node
// gets the same Path2D the worker has, and draws the same plate.
globalThis.Path2D = Path2D

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const { buildWorld, shapesNear } = await import('../src/lib/drawnGeometry.ts')
const { DrawnRenderer, MIN_SEG_PX, levelOf } = await import('../src/lib/drawnTile.ts')
const { tileBbox, TILE_PX } = await import('../src/lib/tilePyramid.ts')

const read = (f) => JSON.parse(readFileSync(join(root, 'public/data/map', f), 'utf8'))
const t0 = performance.now()
const world = buildWorld(
  read('land-110m.json'),
  read('land-50m.json'),
  read('water-50m.json'),
  read('land-10m.json'),
)
console.log(`decode: ${(performance.now() - t0).toFixed(0)} ms for all four files`)
const rungs = [
  ['110m', world.coarseLand],
  ['50m', world.land],
  ['10m', world.fineLand],
]

/** Segments a layer contributes at a level, after the half-pixel filter. */
function segments(layer, level) {
  const k = (TILE_PX * 2 ** level) / 360
  let kept = 0
  for (const shape of layer.shapes) {
    for (let r = 0; r + 1 < shape.rings.length; r++) {
      let lx = null
      let ly = null
      for (let i = shape.rings[r]; i < shape.rings[r + 1]; i++) {
        const x = shape.pts[i * 2] * k
        const y = shape.pts[i * 2 + 1] * k
        if (lx === null || Math.abs(x - lx) + Math.abs(y - ly) >= MIN_SEG_PX) {
          if (lx !== null) kept++
          lx = x
          ly = y
        }
      }
    }
  }
  return kept
}

console.log('\nlevel    110m segs     50m segs     10m segs   10m/50m')
for (let z = 3; z <= 13; z++) {
  const [a, b, c] = rungs.map(([, l]) => segments(l, z))
  console.log(
    `${String(z).padStart(5)} ${String(a).padStart(12)} ${String(b).padStart(12)} ` +
      `${String(c).padStart(12)} ${(c / b).toFixed(2).padStart(9)}`,
  )
}

// "stops adding segments": a level that recovers under 1% more of the data than
// the one below it is showing the same polyline, magnified. And the other half
// of the ceiling: how long the median facet is, in tile pixels, at that level.
console.log('\ndata   saturates   median seg    facet px at level…')
const facets = {}
for (const [name, layer] of rungs) {
  let sat = 3
  let prev = segments(layer, 3)
  for (let z = 4; z <= 15; z++) {
    const now = segments(layer, z)
    if (now / prev > 1.01) sat = z
    prev = now
  }
  const d = []
  for (const shape of layer.shapes)
    for (let r = 0; r + 1 < shape.rings.length; r++)
      for (let i = shape.rings[r]; i + 1 < shape.rings[r + 1]; i++) {
        if (shape.seam?.[i]) continue
        d.push(Math.hypot(shape.pts[i * 2 + 2] - shape.pts[i * 2], shape.pts[i * 2 + 3] - shape.pts[i * 2 + 1]))
      }
  d.sort((a, b) => a - b)
  const med = d[d.length >> 1]
  const px = (z) => (med * TILE_PX * 2 ** z) / 360
  facets[name] = px
  console.log(
    `${name.padEnd(6)} ${String(sat + 1).padStart(9)} ${med.toFixed(4)}°` +
      [7, 8, 9, 10, 11, 12].map((z) => `  z${z} ${px(z).toFixed(0)}`).join(''),
  )
}
console.log(
  '\nZ_MAX: the finest level whose median facet is under 50m-at-z9 (' +
    `${facets['50m'](9).toFixed(0)} px) — 10m reaches it at z` +
    `${[9, 10, 11, 12, 13].filter((z) => facets['10m'](z) < facets['50m'](9)).pop()}`,
)

// --- render budget ----------------------------------------------------------
const renderer = new DrawnRenderer(world, 8)
const canvas = createCanvas(TILE_PX, TILE_PX)
const ctx = canvas.getContext('2d')

/** A spread of tiles at a level: coast, interior, ocean — not one lucky tile. */
const sample = (z) => {
  const n = 2 ** z
  const m = 2 ** (z - 1)
  const at = [
    [0.53, 0.29], // western Europe
    [0.5175, 0.1583], // the Sognefjord — the worst case the 10m rung has
    [0.72, 0.36], // eastern China
    [0.28, 0.42], // the Caribbean
    [0.55, 0.62], // southern Africa
    [0.1, 0.5], // open Pacific
    [0.5, 0.05], // the Arctic
  ]
  return at.map(([u, v]) => ({ z, x: Math.floor(u * n), y: Math.floor(v * m) }))
}

console.log('\nlevel   tiles   mean ms    max ms   paths   shapes/tile')
for (let z = 4; z <= 12; z++) {
  const tiles = sample(z)
  // warm: the first tile of a level builds the paths every later tile reuses,
  // which is the whole point of the cache and would otherwise be charged to it
  for (const t of tiles) renderer.draw(ctx, t)
  const times = []
  for (let pass = 0; pass < 4; pass++) {
    for (const t of tiles) {
      const t0 = performance.now()
      renderer.draw(ctx, t)
      times.push(performance.now() - t0)
    }
  }
  const mean = times.reduce((a, b) => a + b, 0) / times.length
  const near = tiles.map((t) => {
    const b = tileBbox(t.z, t.x, t.y)
    const layer = levelOf(t) >= 7 ? world.fineLand : levelOf(t) >= 5 ? world.land : world.coarseLand
    return shapesNear(layer, b).length
  })
  console.log(
    `${String(z).padStart(5)} ${String(tiles.length).padStart(7)} ${mean.toFixed(2).padStart(9)} ${Math.max(...times).toFixed(2).padStart(9)} ${String(renderer.paths(z).size).padStart(7)} ${String(Math.max(...near)).padStart(13)}`,
  )
}

// cold: what the very first tile of a level costs, paths included
const cold = new DrawnRenderer(world, 3)
for (const z of [4, 6, 8, 10, 11]) {
  const t0 = performance.now()
  cold.draw(ctx, { z, x: Math.floor(0.53 * 2 ** z), y: Math.floor(0.29 * 2 ** (z - 1)) })
  console.log(`cold first tile at z=${z}: ${(performance.now() - t0).toFixed(2)} ms`)
}
