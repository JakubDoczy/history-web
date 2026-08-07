import type { Bbox } from './detailImagery'

/**
 * A fixed pyramid of plate carrée tiles, and the set arithmetic that says which
 * of them a view wants.
 *
 * The arbitrary-bbox streamer this replaces asked for one rectangle per settled
 * view, cut to the camera and to nothing else. Every URL was therefore unique:
 * the browser's HTTP cache never hit, the service's never hit, and a pan of five
 * degrees paid again for ground it already held. An aligned grid makes every
 * request canonical — the same tile is the same URL forever — and reduces "what
 * does this view need" to integer arithmetic that can be unit-tested away from a
 * camera.
 *
 * Plate carrée, matching the shader's own lat/lng parameterisation, so there is
 * no reprojection anywhere in the pipeline. Level z cuts longitude into 2^z
 * columns and latitude into 2^(z-1) rows, which makes every tile square in
 * degrees: 360/2^z on a side. Row 0 is the north pole, because canvas y and
 * every other tile scheme in the world run that way and a second convention is a
 * second sign error waiting to happen.
 */

/**
 * One tile, in pixels.
 *
 * 512 rather than 256: the pyramid is streamed over HTTP/2 where a request costs
 * little, but each one still costs a decode, a cache entry and a draw call, and
 * 256 would quadruple all three for the same ground. Rather than 1024 because
 * the wanted set has to be granular enough that a pan reuses most of it.
 */
export const TILE_PX = 512

/** Bytes a decoded tile holds. The cache budget is expressed in these. */
export const TILE_BYTES = TILE_PX * TILE_PX * 4

export interface Tile {
  z: number
  x: number
  y: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Columns and rows at a level; the ratio is 2:1, as the world is. */
export const tileCols = (z: number) => 2 ** z
export const tileRows = (z: number) => 2 ** (z - 1)

/** Degrees on a side. Square, on both axes, at every level. */
export const tileSpanDeg = (z: number) => 360 / 2 ** z

/** Effective resolution of a level, in pixels per degree. */
export const levelPxPerDeg = (z: number) => (TILE_PX * 2 ** z) / 360

/**
 * The level the bundled 4096-wide world texture already is.
 *
 * Not a constant anyone chose: 4096 px across 360 degrees is 512 * 2^3, so the
 * base map *is* level 3 and streaming starts at 4. Written as the division so
 * that changing either number moves the floor with it.
 */
export const BASE_LEVEL = Math.log2(4096 / TILE_PX)

/**
 * The finest level a source can honestly serve.
 *
 * Past it the server is upsampling its own pixels and charging us a request for
 * blur — the same mistake `imageSize` used to guard against when requests were
 * arbitrary rectangles. Derived from what the source declares rather than
 * guessed: Sentinel-2 at 11100 px/deg tops out at level 12 (5825 px/deg), Blue
 * Marble at 222 px/deg at level 7 (182 px/deg).
 */
export const maxLevel = (src: { pxPerDeg: number }): number =>
  Math.floor(Math.log2((src.pxPerDeg * 360) / TILE_PX))

/**
 * The level to stream, given how many base-map texels the screen is getting per
 * device pixel.
 *
 * The argument is `baseTexelsPerScreenPx` — the same number that decides whether
 * to stream at all — so the two questions cannot drift apart. Below 1 the base
 * map is being magnified, and each halving of it is one more level: 0.5 texels
 * per pixel wants level 4, 0.25 wants level 5, and so on. Rounded up, never
 * down, because the display rule is that the imagery must not be blurrier than
 * the screen it is on; the cost of rounding up is at most a 2x oversample per
 * axis, which is what a power-of-two pyramid charges for that guarantee.
 */
export const targetLevel = (baseTexelsPerScreenPx: number, zMax: number): number =>
  clamp(
    BASE_LEVEL + Math.ceil(-Math.log2(Math.max(baseTexelsPerScreenPx, 1e-9))),
    BASE_LEVEL + 1,
    zMax,
  )

/** The ground a tile covers. Latitude runs down from the pole as y runs up. */
export function tileBbox(z: number, x: number, y: number): Bbox {
  const span = tileSpanDeg(z)
  const minLng = -180 + x * span
  const maxLat = 90 - y * span
  return { minLng, maxLng: minLng + span, minLat: maxLat - span, maxLat }
}

/** …by tile, for the many callers that hold one. */
export const bboxOf = (t: Tile): Bbox => tileBbox(t.z, t.x, t.y)

/**
 * Every tile of a level that touches a rectangle.
 *
 * Longitude wraps and latitude clamps, because those are the two things the
 * sphere does and the integers do not. This wrapped from the day it was
 * written and, until round 51, nothing ever handed it a box that made it: the
 * phase-1 note here read "nothing in the current pipeline hands this a wrapping
 * box — `viewBbox` clamps to -180..180", and that clamp was the antimeridian
 * seam the field reported. `viewBbox` now returns unclamped degrees and this
 * line is live; what had to change with it is everything that turns a column
 * into a cell of a fixed grid (`gridOf`, `buildIndex`, the surface shader).
 */
export function tilesCovering(b: Bbox, z: number): Tile[] {
  const span = tileSpanDeg(z)
  const n = tileCols(z)
  const m = tileRows(z)
  const x0 = Math.floor((b.minLng + 180) / span)
  const x1 = Math.max(x0, Math.ceil((b.maxLng + 180) / span) - 1)
  const y0 = clamp(Math.floor((90 - b.maxLat) / span), 0, m - 1)
  const y1 = clamp(Math.max(y0, Math.ceil((90 - b.minLat) / span) - 1), 0, m - 1)
  const across = Math.min(x1 - x0 + 1, n) // a box wider than the world is the world
  const out: Tile[] = []
  for (let y = y0; y <= y1; y++) {
    for (let i = 0; i < across; i++) {
      out.push({ z, x: (((x0 + i) % n) + n) % n, y })
    }
  }
  return out
}

/** The tile one level coarser that contains this one. */
export const parentOf = (t: Tile): Tile => ({ z: t.z - 1, x: t.x >> 1, y: t.y >> 1 })

/** The four tiles one level finer that fill this one. */
export const childrenOf = (t: Tile): Tile[] => [
  { z: t.z + 1, x: t.x * 2, y: t.y * 2 },
  { z: t.z + 1, x: t.x * 2 + 1, y: t.y * 2 },
  { z: t.z + 1, x: t.x * 2, y: t.y * 2 + 1 },
  { z: t.z + 1, x: t.x * 2 + 1, y: t.y * 2 + 1 },
]

/** Cache identity: the ground, the level, and which sensor drew it. */
export const tileKey = (t: Tile, source: string) => `${t.z}/${t.x}/${t.y}/${source}`

/**
 * What a view wants, in the order it is worth asking for.
 *
 * Three sets, and the split is the whole point of the pyramid:
 *
 *  - `fallback`, one level coarser, is what guarantees there is never bare base
 *    map under the frame. It is four times cheaper than the target level and
 *    essentially permanent near the current view, so it is asked for first and
 *    evicted last. Once it is resident, a pan or a zoom shows coarse imagery
 *    rather than a hole — which is the Maps trade, and the right one.
 *  - `level` is the sharp picture, ordered outward from the centre of the frame
 *    because that is where the eye is and where a partial arrival reads best.
 *  - `ring` is one tile of prefetch beyond the frame, and it is spent only when
 *    the camera is still: during a gesture every byte belongs to ground that is
 *    on screen now.
 */
export interface TilePlan {
  z: number
  fallback: Tile[]
  level: Tile[]
  ring: Tile[]
}

/**
 * Centre-out, so a partial arrival fills the middle of the frame first.
 *
 * The column distance is taken the short way round the world. A view centred on
 * the antimeridian has a centre column of `n` (or of -0.5), and read plainly the
 * tile right beside it at column 0 is then the FURTHEST tile in the plan —
 * so the seam's own ground, which is the middle of the frame, was asked for last
 * and arrived last.
 */
const centreFirst = (tiles: Tile[], view: Bbox, z: number): Tile[] => {
  const span = tileSpanDeg(z)
  const n = tileCols(z)
  const cx = ((view.minLng + view.maxLng) / 2 + 180) / span
  const cy = (90 - (view.minLat + view.maxLat) / 2) / span
  const wrap = (d: number) => d - n * Math.round(d / n)
  const far = (t: Tile) => wrap(t.x + 0.5 - cx) ** 2 + (t.y + 0.5 - cy) ** 2
  return [...tiles].sort((a, b) => far(a) - far(b))
}

export function tilePlan(view: Bbox, z: number): TilePlan {
  const level = centreFirst(tilesCovering(view, z), view, z)
  const span = tileSpanDeg(z)
  const grown: Bbox = {
    minLat: Math.max(-90, view.minLat - span),
    maxLat: Math.min(90, view.maxLat + span),
    minLng: view.minLng - span,
    maxLng: view.maxLng + span,
  }
  const inside = new Set(level.map((t) => tileKey(t, '')))
  const ring = centreFirst(
    tilesCovering(grown, z).filter((t) => !inside.has(tileKey(t, ''))),
    view,
    z,
  )
  return { z, fallback: centreFirst(tilesCovering(view, z - 1), view, z - 1), level, ring }
}

/**
 * Where a tile lands on a canvas cut to exactly `target`.
 *
 * Latitude runs up and canvas y runs down, which is the one sign error this
 * whole file exists to get right in a single tested place.
 */
export function placeOnCanvas(
  target: Bbox,
  patch: Bbox,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const lngSpan = Math.max(target.maxLng - target.minLng, 1e-9)
  const latSpan = Math.max(target.maxLat - target.minLat, 1e-9)
  return {
    x: ((patch.minLng - target.minLng) / lngSpan) * width,
    y: ((target.maxLat - patch.maxLat) / latSpan) * height,
    w: ((patch.maxLng - patch.minLng) / lngSpan) * width,
    h: ((patch.maxLat - patch.minLat) / latSpan) * height,
  }
}

/**
 * How much decoded imagery the pyramid may hold, in bytes.
 *
 * 192 MB is ~180 tiles. The first cut inherited 96 MB from the patch cache
 * this replaces, where it bounded four full-screen patches — but the scripted
 * pan+zoom route wants 134 distinct tiles, so at 96 MB every tile of the
 * second pass (81 of 81) was a URL already paid for, evicted and re-fetched.
 * Doubling it holds a route's worth with headroom; the memory only exists
 * while the camera is inside streaming range at all.
 */
export const TILE_MEMORY_BUDGET = 192 * 1024 * 1024

/**
 * Decoded tiles, bounded by bytes, in least-recently-wanted order.
 *
 * Recency is not tracked on reads. The composite reads every wanted tile on
 * every frame it draws, so a read-touched LRU would say nothing that the wanted
 * set does not already say — and the wanted set is recomputed from the camera
 * every frame anyway. So `pin` is both the "do not evict these" mark and the
 * "these are the newest" touch, and there is exactly one notion of use.
 *
 * The pin is honoured absolutely, so the budget is a target and not a hard
 * ceiling: on a very large display one view's own tiles can exceed it, and
 * evicting a tile the composite is about to draw would be a hole on screen paid
 * for with a refetch. Memory yields to correctness, and the overshoot is bounded
 * by the frame rather than unbounded by time.
 */
export class TileCache<T> {
  private held = new Map<string, T>()
  private pinned = new Set<string>()

  constructor(
    private budget = TILE_MEMORY_BUDGET,
    private release?: (value: T) => void,
  ) {}

  get size(): number {
    return this.held.size
  }

  get bytes(): number {
    return this.held.size * TILE_BYTES
  }

  has(key: string): boolean {
    return this.held.has(key)
  }

  get(key: string): T | undefined {
    return this.held.get(key)
  }

  set(key: string, value: T) {
    const old = this.held.get(key)
    if (old !== undefined && old !== value) this.release?.(old)
    this.held.delete(key) // re-inserting is what makes it the newest
    this.held.set(key, value)
    this.trim()
  }

  /** The current wanted set: never evicted, and the most recently used. */
  pin(keys: Iterable<string>) {
    this.pinned = new Set(keys)
    for (const key of this.pinned) {
      const held = this.held.get(key)
      if (held === undefined) continue
      this.held.delete(key)
      this.held.set(key, held)
    }
    this.trim()
  }

  private trim() {
    if (this.bytes <= this.budget) return
    for (const key of [...this.held.keys()]) {
      if (this.bytes <= this.budget) break
      if (this.pinned.has(key)) continue
      const value = this.held.get(key)!
      this.held.delete(key)
      this.release?.(value)
    }
  }

  clear() {
    for (const value of this.held.values()) this.release?.(value)
    this.held.clear()
    this.pinned.clear()
  }
}
