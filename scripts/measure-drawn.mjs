#!/usr/bin/env node
/**
 * The three numbers the drawn map's constants are derived from, measured rather
 * than guessed — the same rule `maxLevel` follows for a WMS source.
 *
 *  1. LOD_Z: the level at which 110m stops being able to say what a tile pixel
 *     could show, i.e. where 50m first survives the half-pixel filter with
 *     materially more segments.
 *  2. Z_MAX: the level at which 50m stops adding segments. Past it every vertex
 *     the data has already survives, so a finer level is the same polyline
 *     magnified — which is exactly what the pyramid's coarse-level fallback
 *     does for free.
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
const world = buildWorld(read('land-110m.json'), read('world-50m.json'), read('water-50m.json'))

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

console.log('level   110m segs    50m segs   50m gain')
let zMax = 4
let prev = 0
for (let z = 3; z <= 13; z++) {
  const a = segments(world.coarseLand, z)
  const b = segments(world.land, z)
  const gain = prev ? b / prev : 0
  console.log(
    `${String(z).padStart(5)} ${String(a).padStart(11)} ${String(b).padStart(11)} ${gain.toFixed(4).padStart(10)}`,
  )
  // "stops adding segments": a level that recovers under 1% more of the data
  // than the one below it is showing the same polyline, magnified.
  if (prev && gain > 1.01) zMax = z
  prev = b
}
console.log(`\nZ_MAX (last level 50m still adds >1% segments): ${zMax}`)

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
    [0.72, 0.36], // eastern China
    [0.28, 0.42], // the Caribbean
    [0.55, 0.62], // southern Africa
    [0.1, 0.5], // open Pacific
    [0.5, 0.05], // the Arctic
  ]
  return at.map(([u, v]) => ({ z, x: Math.floor(u * n), y: Math.floor(v * m) }))
}

console.log('\nlevel   tiles   mean ms    max ms   paths   shapes/tile')
for (let z = 4; z <= 13; z++) {
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
    const layer = levelOf(t) >= 5 ? world.land : world.coarseLand
    return shapesNear(layer, b).length
  })
  console.log(
    `${String(z).padStart(5)} ${String(tiles.length).padStart(7)} ${mean.toFixed(2).padStart(9)} ${Math.max(...times).toFixed(2).padStart(9)} ${String(renderer.paths(z).size).padStart(7)} ${String(Math.max(...near)).padStart(13)}`,
  )
}

// cold: what the very first tile of a level costs, paths included
const cold = new DrawnRenderer(world, 3)
for (const z of [4, 6, 8, 10]) {
  const t0 = performance.now()
  cold.draw(ctx, { z, x: Math.floor(0.53 * 2 ** z), y: Math.floor(0.29 * 2 ** (z - 1)) })
  console.log(`cold first tile at z=${z}: ${(performance.now() - t0).toFixed(2)} ms`)
}
