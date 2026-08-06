#!/usr/bin/env node
/**
 * The drawn world texture: 4096×2048 equirectangular, from the same rasterizer
 * the tiles come from.
 *
 * Not "the same style" — the SAME CODE. This composes the thirty-two level-3
 * tiles of the pyramid (8 columns × 4 rows of 512) and writes the result out,
 * so the base texture is by construction the level the pyramid's own arithmetic
 * calls level 3 (`BASE_LEVEL` = log2(4096/512)). Two things follow, and both
 * are what the design asked for:
 *
 *  · the shader's sharp/blur ratio stays self-consistent. It divides a tile's
 *    sharp tap by that tile reduced to the base map's density and multiplies
 *    the base map by the result — and here the base map *is* that reduction,
 *    drawn by the same pen from the same vectors, so an unsharpened region and
 *    a sharpened one are the same picture at two resolutions rather than two
 *    pictures;
 *  · the joins in the texture are the joins in the pyramid. If a tile edge did
 *    not agree, it would show here as a seam across the world map.
 *
 * Run: npx tsx scripts/render-drawn-world.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { createCanvas, Path2D } from '@napi-rs/canvas'

// The rasterizer is written against the 2D API rather than against a browser,
// which is what lets node draw the identical plate. See lib/drawnTile.ts.
globalThis.Path2D = Path2D

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { buildWorld } = await import('../src/lib/drawnGeometry.ts')
const { DrawnRenderer } = await import('../src/lib/drawnTile.ts')
const { TILE_PX, BASE_LEVEL, tileCols, tileRows } = await import('../src/lib/tilePyramid.ts')

const read = (f) => JSON.parse(readFileSync(join(root, 'public/data/map', f), 'utf8'))
const world = buildWorld(read('land-110m.json'), read('world-50m.json'), read('water-50m.json'))

const z = BASE_LEVEL
const cols = tileCols(z)
const rows = tileRows(z)
const out = createCanvas(cols * TILE_PX, rows * TILE_PX)
const dst = out.getContext('2d')
const tile = createCanvas(TILE_PX, TILE_PX)
const ctx = tile.getContext('2d')
const renderer = new DrawnRenderer(world)

const t0 = performance.now()
for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    renderer.draw(ctx, { z, x, y })
    dst.drawImage(tile, x * TILE_PX, y * TILE_PX)
  }
}
const ms = performance.now() - t0

const dir = join(root, 'public/textures/map')
mkdirSync(dir, { recursive: true })
// Quality 88: the map is flat tone and fine ink, which is the case lossy WebP
// is neither best nor worst at. Below ~80 the double coastline stroke starts
// ringing; above ~92 the file doubles for tone nobody can see under a 4096
// texture sampled on a sphere.
const webp = await out.encode('webp', 88)
writeFileSync(join(dir, 'drawn-world.webp'), webp)
console.log(
  `drawn-world.webp: ${out.width}x${out.height}, ${(webp.length / 1024).toFixed(0)} kB, ` +
    `${cols * rows} tiles in ${ms.toFixed(0)} ms`,
)
