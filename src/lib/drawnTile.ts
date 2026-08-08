import type { DrawnWorld, Layer, Shape } from './drawnGeometry'
import { shapesNear } from './drawnGeometry'
import { TILE_PX, tileBbox } from './tilePyramid'

/**
 * The rasterizer: one plate carrée tile of a drawn atlas, from vector geometry,
 * with a 2D context and nothing else.
 *
 * It is the whole of the "drawn map" — the tile pyramid, the cache, the
 * scheduler, the atlas and the shader are the imagery pipeline's, unchanged,
 * because a tile source is a function from (z, x, y) to pixels and does not owe
 * anyone a network. What is here is the drawing.
 *
 * THE DETERMINISM RULE. Rendering the same tile twice yields identical bytes,
 * and rendering two adjacent tiles yields edges that agree. Everything that
 * could have been random is therefore a function of position in the WORLD, not
 * of the tile:
 *
 *  · the paper's fleck is placed on a world-aligned 16 px lattice, hashed from
 *    the lattice cell's own integer coordinates, so a fleck belongs to exactly
 *    one cell and one tile and the join is exact rather than merely plausible;
 *  · the hand-drawn line is TWO EXACT STROKES at a fixed sub-pixel offset, not
 *    a jittered one. Per-tile jitter is the obvious way to fake a pen and it is
 *    unusable here: two tiles would jitter the same coastline differently and
 *    every tile boundary would become a visible kink. The double line and the
 *    shoreline wash carry the same suggestion and are continuous by
 *    construction;
 *  · the geometry a level is drawn from is simplified by a tolerance that
 *    depends on the level alone, so the polyline crossing a tile edge is the
 *    same polyline on both sides of it.
 *
 * THE COST RULE. A tile is 8 ms of budget. What buys it is that nothing here is
 * per-tile except the drawing calls: the geometry is decoded once
 * (lib/drawnGeometry.ts), the bucket index narrows 1420 features to ~30, and
 * the simplified `Path2D` for a feature at a level is built once and then
 * *translated* into each tile that wants it. A coastline crossing sixteen tiles
 * is one path, sixteen `setTransform` calls.
 *
 * WHAT IS NOT HERE: political boundaries. The paper carries physical geography
 * only — coast, rivers, lakes, graticule — because the paper is the same sheet
 * in every year and a border is not. This globe already answers "who held this
 * ground" with the nations layer: 73 era-accurate polities, redrawn as the
 * reader moves through time and re-inked for parchment (`inkOnPaper`). An
 * earlier round also stroked Natural Earth's `countries` into the tiles, so a
 * reader at 1500 got a modern France printed under the polity that actually
 * held it — dashed, permanent, and contradicting the layer above it. Two
 * answers to one question is one too many, and the one that goes is the one
 * that does not know what year it is.
 */

/**
 * The palette. Low-contrast and deliberately not paper-white: the ink on top has
 * to be the darkest thing on screen, and the pins and battle-plan ink that land
 * over this have to read against it (see lib/present/ink.ts).
 *
 * TWO GROUNDS, TWO SUBSTANCES — round 52. The first build made the sea a darker
 * parchment, which is honest about one thing (it is the same sheet) and wrong
 * about another: reported as *"the sea is just another shade"*, and it was. Land
 * and sea differed by 26 of luminance and by nothing else, so at world view the
 * map read as one tone with the continents faintly embossed on it.
 *
 * The sea is now the aged atlas's own answer — a duck-egg wash, desaturated
 * blue-green leaning grey — and the land is untouched parchment. What that buys,
 * measured:
 *
 *                       rgb           luminance   chroma   b − r
 *     land          236,226,200          226        36      −36
 *     sea, before   211,200,168          200        43      −43
 *     sea, now      177,191,187          188        14      +10
 *
 * The separation is 38 of luminance instead of 26, and — the part that answers
 * the report — it is a separation of HUE as well: warm against cool, which is
 * two substances rather than two shades of one. And it is not a colour poster,
 * by the same measurement: the new sea is a *less* saturated colour than the one
 * it replaces (chroma 14 against 43). Only its direction changed.
 *
 * Four candidates were rendered through this rasterizer and compared at world,
 * continental and coastal zoom before this one was picked. `A-celadon-faint`
 * (luminance 196, b − r = −1) was still "another shade" — a neutral grey-green
 * that reads as dust on the paper rather than as water. `B-duck-egg` (193, +9)
 * reads as water but keeps most of the old value gap. `C-slate-duck-egg` (182,
 * +14) is the handsomer atlas and the bigger jump, and at world view its sea
 * starts to carry the picture instead of sitting under it. This one,
 * `B2-duck-egg-deep`, is the one that changes the reading without changing the
 * artifact.
 */
export const PAPER = {
  /**
   * The sea: the deeper and the COOLER of the two grounds, so land reads as
   * raised *and* as a different material.
   */
  ocean: '#b1bfbb',
  /**
   * …and the shoreline wash over it, palest first, stepping about 6, 13 and 21
   * of luminance below the open sea — the same cadence the warm palette had,
   * with a point of chroma added at each step so the band deepens toward the
   * coast the way an engraver's does.
   */
  wash: ['#aab9b5', '#a3b2ae', '#9aaaa6'],
  land: '#ece2c8',
  /**
   * Coastline ink. Warm near-black — a brown-black pen, never a blue-black —
   * and it stays warm over the cool sea, because a drawn map is drawn with ONE
   * pen and the pen does not know what it is crossing.
   */
  ink: '#2e2519',
  /** The second, thinner pass that suggests a drawn rather than plotted line. */
  inkSoft: 'rgba(46, 37, 25, 0.34)',
  /**
   * River ink, unchanged: it was already a cool blue-grey, chosen against warm
   * paper, and it now agrees with the sea it runs into rather than contradicting
   * it. Contrast against the land it mostly crosses is 85 of luminance.
   */
  river: 'rgba(74, 92, 96, 0.62)',
  /** Inland water: the sea's tone, five of luminance lighter, as before. */
  lake: '#acbab6',
  /**
   * The graticule, unchanged, and that is a measurement rather than an
   * oversight: a warm hairline at this alpha loses 21 of luminance out of the
   * new sea's 188 and 26 out of the land's 226 — 11.2% and 11.7% Weber contrast,
   * against 10.7% and 11.7% on the old palette. It reads the same on both
   * grounds after the change as it did before, and it is the same pen as the
   * coast, which is why it is not re-tinted per ground.
   */
  graticule: 'rgba(70, 56, 36, 0.16)',
  /**
   * Paper fleck, dark and light. Alpha is applied per fleck from the hash.
   *
   * Warm on both grounds, deliberately: the fleck is the sheet's own fibre lying
   * in FRONT of the ink (step 6 below), so it is the one thing on the plate that
   * must not know whether it is over land or sea. It shows a little more over the
   * cool sea than it did over the warm one — 8 of luminance against 5.5 — which
   * is the aged-paper cue doing its job, not a defect.
   */
  fleckDark: '#8d7d5c',
  fleckLight: '#fbf3dc',
} as const

/**
 * The level at which 50m geometry takes over from 110m.
 *
 * BASE_LEVEL — the coarsest level anything is ever drawn at — because that is
 * what the measurement says. Over the whole world, segments surviving the
 * half-pixel filter (scripts/measure-drawn.mjs):
 *
 *     level      110m       50m
 *         3      4 992    55 055
 *         4      4 994    58 643
 *         6      4 994    59 374   ← 50m saturates; nothing finer adds vertices
 *
 * 110m is not a level of detail for this map, it is a *floor*: at every level
 * the drawn map exists at, it is throwing away ten times the geometry a tile
 * pixel could show. It is still shipped and still drawn — for the ~300 ms
 * between the 55 kB file parsing and the 841 kB one, and for any tile asked
 * for in that window (see `loadWorld`). So the switch is availability as much
 * as level, which is what `landAt` below expresses.
 */
export const LOD_Z = 3

/**
 * Where the water layers stop being honest.
 *
 * Rivers and lakes come quantised at 0.036° (~4 km) — the only reachable npm
 * source, see scripts/vendor-map-data.mjs — against 0.0036° for the coast. One
 * Chaikin pass at load turns that staircase into a curve, which holds up to
 * about 2 tile pixels of quantum: level 9 is 26 px per quantum, level 8 is 13,
 * level 6 is 3.3. So water fades across 7→9 and is gone above, which is also
 * where a drawn atlas would stop drawing every stream anyway.
 */
export const WATER_FADE = { from: 7, to: 9 } as const

/** Segments shorter than this contribute nothing a tile pixel can show. */
export const MIN_SEG_PX = 0.5

/** How far the shoreline wash reaches into the sea, in tile pixels. */
export const WASH_PX = 11

/** The 2D context subset this file uses. Browser, worker and node all satisfy it. */
export interface DrawCtx {
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  lineJoin: CanvasLineJoin
  lineCap: CanvasLineCap
  globalAlpha: number
  save(): void
  restore(): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  setLineDash(segments: number[]): void
  fillRect(x: number, y: number, w: number, h: number): void
  fill(path: Path2D, rule?: CanvasFillRule): void
  stroke(path: Path2D): void
}

/** What identifies a rendered plate: a pyramid tile, or the whole world at `px`. */
export interface TileRequest {
  z: number
  x: number
  y: number
  /** Pixels on a side. TILE_PX for a pyramid tile; 4096 for the world texture. */
  px?: number
}

/**
 * The pyramid level a plate is drawn AT, which is not always its `z`.
 *
 * The build-time world texture is one 4096×2048 request at z=0, and it is
 * level 3 — the level whose grid a 4096-wide world map exactly is. Every style
 * decision below reads this rather than `z`, which is what makes the base
 * texture and the tiles that sharpen it the same drawing at two scales.
 */
export const levelOf = (r: TileRequest): number =>
  r.z + Math.log2((r.px ?? TILE_PX) / TILE_PX)

/** Ink weights, in tile pixels; constant at every level, as a drawn map's are. */
const INK = { coast: 1.15, coastSoft: 0.7, river: 0.8, graticule: 0.5 } as const
/** The fixed offset of the second stroke. Sub-pixel, and never per tile. */
const INK_OFFSET = { x: 0.55, y: 0.4 } as const

const hash2 = (x: number, y: number, salt: number): number => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 2147483647)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * Simplified paths for one level, built lazily and reused across every tile of
 * that level.
 *
 * This is the difference between 8 ms and 80 ms. Without it every tile walks
 * the point arrays of every feature near it — Eurasia's 50m coastline is 12k
 * points and is near about sixty tiles of a continental view.
 */
export class LevelPaths {
  /** World width in pixels at this level; height is half of it. */
  readonly worldPx: number
  private paths = new Map<string, ShapePaths>()

  constructor(readonly level: number) {
    this.worldPx = TILE_PX * 2 ** level
  }

  /** …in world pixels, simplified to half a pixel, closed if the layer is. */
  path(layer: Layer, name: string, index: number): ShapePaths {
    const key = `${name}:${index}`
    const held = this.paths.get(key)
    if (held) return held
    const shape = layer.shapes[index]
    const fill = buildPath(shape, this.worldPx, layer.closed, false)
    // Same object where there is nothing to leave out, which is every shape but
    // the four that met the antimeridian: one path, one build, no extra memory.
    const built: ShapePaths = {
      fill,
      stroke: shape.seam ? buildPath(shape, this.worldPx, layer.closed, true) : fill,
    }
    this.paths.set(key, built)
    return built
  }

  get size(): number {
    return this.paths.size
  }
}

/**
 * One shape at one level, in the two forms the drawing needs.
 *
 * They differ only where a ring was clipped to the ±180 strip (`splitAtSeam` in
 * lib/drawnGeometry.ts): the fill wants the meridian edges that make the piece
 * a polygon, and the pen must not follow them — a shoreline wash down the 180th
 * meridian is a coast that does not exist. `stroke === fill` for every shape
 * that never met the seam.
 */
export interface ShapePaths {
  fill: Path2D
  stroke: Path2D
}

function buildPath(shape: Shape, worldPx: number, closed: boolean, penOnly: boolean): Path2D {
  const p = new Path2D()
  const k = worldPx / 360 // plate carrée: the same scale on both axes
  const { pts, rings, seam } = shape
  // Only the pen ever lifts, and only over an edge the projection put there.
  const cuts = penOnly ? seam : undefined
  for (let r = 0; r + 1 < rings.length; r++) {
    const from = rings[r]
    const to = rings[r + 1]
    if (to - from < 2) continue
    let lx = (pts[from * 2] + 180) * k
    let ly = (90 - pts[from * 2 + 1]) * k
    p.moveTo(lx, ly)
    // The half-pixel filter. Written as a Manhattan distance on purpose: it is
    // the same decision for every tile at this level (that is what makes the
    // joins agree), and a hypot per point over 1.4 M points is real time spent
    // to move the threshold by at most 40%.
    //
    // NO SEAM BRANCH. There used to be one here, and it is what drew the chord
    // from South Africa to Chukotka: it closed the subpath at a crossing, and
    // `closePath` closes to the last `moveTo` — the ring's first vertex — not
    // to the seam. Rings are now clipped to the strip at decode, so no segment
    // reaching this loop spans more than 180° of longitude, and the only long
    // ones left are the polar closures, which are `seam` and belong to the fill.
    for (let i = from + 1; i < to; i++) {
      const x = (pts[i * 2] + 180) * k
      const y = (90 - pts[i * 2 + 1]) * k
      if (cuts?.[i - 1]) {
        p.moveTo(x, y)
      } else if (
        i === to - 1 ||
        seam?.[i] ||
        seam?.[i - 1] ||
        Math.abs(x - lx) + Math.abs(y - ly) >= MIN_SEG_PX
      ) {
        p.lineTo(x, y)
      } else continue
      lx = x
      ly = y
    }
    if (closed && !cuts?.[to - 1]) p.closePath()
  }
  return p
}

/** Longitude offsets that can bring a shape onto this tile: the seam, handled. */
function shiftsFor(bbox: readonly number[], worldPx: number, x0: number, x1: number): number[] {
  const k = worldPx / 360
  const w = (bbox[0] + 180) * k
  const e = (bbox[2] + 180) * k
  const out: number[] = []
  for (const shift of [-worldPx, 0, worldPx]) {
    if (e + shift >= x0 && w + shift <= x1) out.push(shift)
  }
  return out
}

/** One pass over a layer: `draw` is called with the tile-space transform set. */
function eachShape(
  ctx: DrawCtx,
  paths: LevelPaths,
  layer: Layer,
  name: string,
  near: number[],
  originX: number,
  originY: number,
  px: number,
  bleed: number,
  which: 'fill' | 'stroke',
  draw: (path: Path2D) => void,
) {
  for (const i of near) {
    const shape = layer.shapes[i]
    const path = paths.path(layer, name, i)[which]
    for (const shift of shiftsFor(shape.bbox, paths.worldPx, originX - bleed, originX + px + bleed)) {
      ctx.setTransform(1, 0, 0, 1, shift - originX, -originY)
      draw(path)
    }
  }
}

/**
 * Paper: a flat warm ground and a fleck lattice over it.
 *
 * The lattice is world-aligned at `CELL` pixels and each cell's fleck is hashed
 * from the cell's own integer coordinates, so the pattern is a property of the
 * world rather than of the tile: two tiles that meet produce one continuous
 * field, and the same tile twice produces the same field. That is strictly
 * stronger than the seeded-per-tile noise the design asked for, and it costs
 * the same — one hash and one 1 px rect per cell, ~1024 of each per tile.
 */
const CELL = 16
/** Cells that get a dark fleck, and (above it) cells that get a light one. */
const FLECK = { dark: 0.19, light: 0.34 } as const
function grain(ctx: DrawCtx, originX: number, originY: number, px: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const cx0 = Math.floor(originX / CELL)
  const cy0 = Math.floor(originY / CELL)
  const n = Math.ceil(px / CELL)
  // TWO PASSES, not one loop with a style per fleck. Measured at 512²: 1024
  // flecks each setting fillStyle and globalAlpha cost 1.10 ms — nearly a sixth
  // of the whole tile budget — against 0.33 ms for the same flecks drawn in two
  // runs of one state each. The fleck's weight is carried by its SIZE, which is
  // free, rather than by its alpha, which is not.
  for (const dark of [true, false]) {
    ctx.fillStyle = dark ? PAPER.fleckDark : PAPER.fleckLight
    ctx.globalAlpha = dark ? 0.11 : 0.14
    for (let cy = cy0; cy < cy0 + n; cy++) {
      for (let cx = cx0; cx < cx0 + n; cx++) {
        const t = hash2(cx, cy, 3)
        // two thirds of the cells get nothing: a fleck in every cell reads as a
        // screen door, a sparse scatter reads as fibre
        if (dark ? t >= FLECK.dark : t < FLECK.dark || t >= FLECK.light) continue
        const s = dark ? 0.8 + t * 4 : 1.4
        ctx.fillRect(
          cx * CELL - originX + hash2(cx, cy, 1) * CELL,
          cy * CELL - originY + hash2(cx, cy, 2) * CELL,
          s,
          s,
        )
      }
    }
  }
  ctx.globalAlpha = 1
}

/** Hairlines every 10°, fading out once a tile stops containing any. */
function graticule(ctx: DrawCtx, level: number, originX: number, originY: number, px: number, worldPx: number) {
  const alpha = level >= 8 ? 0 : level >= 6 ? (8 - level) / 2 : 1
  if (alpha <= 0) return
  const step = (worldPx / 360) * 10
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = alpha
  ctx.strokeStyle = PAPER.graticule
  ctx.lineWidth = INK.graticule
  ctx.setLineDash([])
  const lines = new Path2D()
  for (let gx = Math.ceil(originX / step) * step; gx <= originX + px; gx += step) {
    lines.moveTo(gx - originX, 0)
    lines.lineTo(gx - originX, px)
  }
  for (let gy = Math.ceil(originY / step) * step; gy <= originY + px; gy += step) {
    lines.moveTo(0, gy - originY)
    lines.lineTo(px, gy - originY)
  }
  ctx.stroke(lines)
  ctx.globalAlpha = 1
}

/**
 * Which land layer answers a level, and under which cache name.
 *
 * The name is part of the answer because the path cache is keyed by it: when
 * the 50m data lands mid-session the paths already built from 110m must not be
 * handed out for it, and two names is how that is impossible rather than merely
 * unlikely.
 */
export const landAt = (world: DrawnWorld, level: number): [Layer, string] =>
  level >= LOD_Z && world.land ? [world.land, 'land'] : [world.coarseLand, 'coarse']

/** 0 below `from`, 1 at `from`, back to 0 at `to`: the water layers' visibility. */
export const waterAlpha = (level: number): number =>
  level < WATER_FADE.from
    ? 1
    : Math.max(0, 1 - (level - WATER_FADE.from) / (WATER_FADE.to - WATER_FADE.from))

/**
 * Draw one plate.
 *
 * The order is the whole style, and every step of it is there because the one
 * before it would otherwise show:
 *
 *  1. the sea, flat;
 *  2. the shoreline wash — three concentric strokes of the coast, palest and
 *     widest first — which at this point covers ground on BOTH sides of the
 *     coastline;
 *  3. the land, filled over it, which is what turns the wash into a band that
 *     hugs the coast from the outside only. No offsetting, no distance field:
 *     the land is its own mask;
 *  4. lakes, rivers and the graticule — everything that is drawn ON the map
 *     rather than being the map. Political boundaries are NOT among them: they
 *     are the nations layer's, because they are a function of the year;
 *  5. the coastline ink, last of the line work, so nothing crosses it;
 *  6. the fleck, over everything, because paper is in front of the ink.
 */
export function drawTile(ctx: DrawCtx, world: DrawnWorld, req: TileRequest, paths: LevelPaths) {
  const px = req.px ?? TILE_PX
  const level = levelOf(req)
  const originX = req.x * px
  const originY = req.y * px
  const bbox = tileBbox(req.z, req.x, req.y)
  // The wash and the widest stroke reach outside the tile, so the query grows
  // by that much of ground — otherwise a coast just off the tile leaves no
  // band on it and the join shows.
  const margin = ((WASH_PX + 2) / paths.worldPx) * 360
  const near: import('./detailImagery').Bbox = {
    minLng: bbox.minLng - margin,
    maxLng: bbox.maxLng + margin,
    minLat: Math.max(-90, bbox.minLat - margin),
    maxLat: Math.min(90, bbox.maxLat + margin),
  }
  const bleed = WASH_PX + 2
  const [landLayer, landName] = landAt(world, level)
  const landNear = shapesNear(landLayer, near)

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.setLineDash([])
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  // 1 — the sea
  ctx.fillStyle = PAPER.ocean
  ctx.fillRect(0, 0, px, px)

  // 2 — the wash, widest and palest first; each step is drawn over the last, so
  // what is left after the land goes on is a stepped band fading out to sea
  // TWO steps, not three, and the reason is measured: a stroke of this
  // coastline costs 0.52 ms whatever its width — the cost is the polyline, not
  // the pen — so every pass over it is a sixteenth of the tile's budget. Two
  // steps plus the tick below still read as a graded band; a third bought a
  // shade nobody could name for 0.5 ms a tile.
  const widths = [WASH_PX * 2, WASH_PX * 0.9]
  widths.forEach((w, i) => {
    ctx.strokeStyle = PAPER.wash[i]
    ctx.lineWidth = w
    eachShape(ctx, paths, landLayer, landName, landNear, originX, originY, px, bleed, 'stroke', (p) =>
      ctx.stroke(p),
    )
  })
  // …and the engraved tick: a wide dashed stroke reads as short bars across the
  // band, which is the stipple an engraver would have cut. Dash phase runs from
  // each ring's own first vertex, and the ring is identical at a level whatever
  // tile is asking, so the ticks land in the same places on both sides of a join.
  ctx.strokeStyle = PAPER.wash[2]
  ctx.lineWidth = WASH_PX * 1.6
  ctx.lineCap = 'butt'
  ctx.setLineDash([0.9, 3.6])
  eachShape(ctx, paths, landLayer, landName, landNear, originX, originY, px, bleed, 'stroke', (p) =>
    ctx.stroke(p),
  )
  ctx.setLineDash([])
  ctx.lineCap = 'round'

  // 3 — the land, which is also the wash's mask
  ctx.fillStyle = PAPER.land
  eachShape(ctx, paths, landLayer, landName, landNear, originX, originY, px, 0, 'fill', (p) =>
    ctx.fill(p, 'evenodd'),
  )

  // 4 — what is drawn on the map
  const water = waterAlpha(level)
  if (water > 0 && world.lakes && world.rivers) {
    ctx.globalAlpha = water
    const lakes = shapesNear(world.lakes, near)
    ctx.fillStyle = PAPER.lake
    eachShape(ctx, paths, world.lakes, 'lakes', lakes, originX, originY, px, 0, 'fill', (p) =>
      ctx.fill(p, 'evenodd'),
    )
    ctx.strokeStyle = PAPER.river
    ctx.lineWidth = INK.river * 0.8
    eachShape(ctx, paths, world.lakes, 'lakes', lakes, originX, originY, px, 2, 'stroke', (p) =>
      ctx.stroke(p),
    )
    ctx.lineWidth = INK.river
    eachShape(
      ctx,
      paths,
      world.rivers,
      'rivers',
      shapesNear(world.rivers, near),
      originX,
      originY,
      px,
      2,
      'stroke',
      (p) => ctx.stroke(p),
    )
    ctx.globalAlpha = 1
  }

  graticule(ctx, level, originX, originY, px, paths.worldPx)

  // 5 — the coastline, in two exact strokes: the confident one, and a thinner
  // pass at a fixed sub-pixel offset. NOT a jitter — see the determinism rule.
  ctx.strokeStyle = PAPER.inkSoft
  ctx.lineWidth = INK.coastSoft
  for (const i of landNear) {
    const shape = landLayer.shapes[i]
    const path = paths.path(landLayer, landName, i).stroke
    for (const shift of shiftsFor(shape.bbox, paths.worldPx, originX - bleed, originX + px + bleed)) {
      ctx.setTransform(1, 0, 0, 1, shift - originX + INK_OFFSET.x, -originY + INK_OFFSET.y)
      ctx.stroke(path)
    }
  }
  ctx.strokeStyle = PAPER.ink
  ctx.lineWidth = INK.coast
  eachShape(ctx, paths, landLayer, landName, landNear, originX, originY, px, bleed, 'stroke', (p) =>
    ctx.stroke(p),
  )

  // 6 — the paper itself, in front
  grain(ctx, originX, originY, px)

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.restore()
}

/**
 * Level path caches, bounded.
 *
 * Three levels resident covers the pyramid's own working set — a view streams
 * its target level and its parent, and a zoom adds the next one — and each is a
 * few hundred `Path2D` objects. A fourth would be a level the camera has left.
 *
 * "The level the camera has left" is a claim about RECENCY, so the map is kept
 * in recency order rather than in insertion order; see `paths`.
 */
export class DrawnRenderer {
  private levels = new Map<number, LevelPaths>()

  constructor(
    readonly world: DrawnWorld,
    private keep = 3,
  ) {}

  paths(level: number): LevelPaths {
    const held = this.levels.get(level)
    if (held) {
      // …and asking for a level is what makes it recent. Insertion order alone
      // said "age since first drawn", which is the wrong order for a camera
      // that goes back: a zoom out to a level still on screen, then in again,
      // evicted the level being drawn RIGHT NOW because it happened to be the
      // first of the three built. Every path of it is then rebuilt from the
      // point arrays, which is the 8–10 ms first-tile-of-a-level cost paid
      // again for geometry that was already there.
      this.levels.delete(level)
      this.levels.set(level, held)
      return held
    }
    const built = new LevelPaths(level)
    this.levels.set(level, built)
    while (this.levels.size > this.keep) {
      const oldest = this.levels.keys().next().value as number
      this.levels.delete(oldest)
    }
    return built
  }

  draw(ctx: DrawCtx, req: TileRequest) {
    drawTile(ctx, this.world, req, this.paths(levelOf(req)))
  }
}
