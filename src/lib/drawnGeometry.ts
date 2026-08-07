import type { Bbox } from './detailImagery'
import { tileCols, tileRows, tileSpanDeg } from './tilePyramid'

/**
 * The vector world the drawn map is rendered from: Natural Earth TopoJSON,
 * decoded once and pre-indexed so that drawing one 512² tile touches only the
 * geometry near it.
 *
 * The decoder is here rather than `topojson-client` for the same reason the
 * data is in `public/data/map/` rather than in `node_modules`: what a quantised
 * topology *is* — delta-coded integers, a scale and a translate, arcs
 * referenced forwards or (as `~i`) backwards — is forty lines, and shipping a
 * general-purpose library to the browser to read three files of a shape we
 * control is a dependency bought for nothing. `scripts/vendor-map-data.mjs` is
 * where topojson-client would have been useful and is not needed either.
 *
 * Two decisions in the data model, both about the rasterizer's inner loop:
 *
 *  · **One shape per feature, rings flattened.** A MultiPolygon's islands and
 *    its holes are one point array with ring boundaries, so a fill is one path
 *    with `evenodd` and a stroke is one walk. Winding order in Natural Earth is
 *    not reliably consistent between outer rings and holes, and `evenodd` does
 *    not care.
 *  · **Float64Array of degrees, never objects.** 50m land is 1.4 M numbers; as
 *    `{x, y}` pairs that is 700 k allocations to walk per level built.
 *
 * The bucket index is the whole of "clipped rendering": every shape is listed
 * in each cell of a coarse tile grid its bounding box touches, so a tile at z=9
 * asks one or two cells instead of testing 1420 bounding boxes. It is a
 * *bounding-box* index, so Eurasia is in a hundred cells and gets drawn for
 * every tile that names one of them — which is correct, and is why the paths
 * are cached per level rather than rebuilt per tile (see lib/drawnTile.ts).
 */

/** One feature: a set of rings (closed) or lines (open) in degrees. */
export interface Shape {
  /** lng, lat, lng, lat … for every ring end to end. */
  pts: Float64Array
  /** Start index of each ring, in POINTS, with a terminator: length = rings+1. */
  rings: Uint32Array
  /** minLng, minLat, maxLng, maxLat. */
  bbox: [number, number, number, number]
  /**
   * Which edges are the ANTIMERIDIAN'S rather than the coast's.
   *
   * 1 at point `i` means the edge leaving `i` — or, at a ring's last point, the
   * edge that closes it — was inserted by `splitAtSeam` and is not a line
   * anybody drew. A fill needs those edges (they are what makes the piece a
   * polygon); a pen must not follow them, or a reader at the Bering Strait gets
   * a coastline with shoreline wash down the 180th meridian. Absent on the
   * shapes that never met the seam, which is all but four of 1427.
   */
  seam?: Uint8Array
}

/** A named layer plus the bucket index over it. */
export interface Layer {
  shapes: Shape[]
  closed: boolean
  /** Shape indices per bucket cell, row-major over BUCKET_Z's grid. */
  buckets: Uint32Array[]
}

/**
 * The level the bucket grid is cut at: 16×8 cells of 22.5°.
 *
 * Coarse on purpose. The index exists to keep a tile from testing every shape
 * in the world, and one cell already narrows 50m land from 1420 features to
 * about 30. Finer cells would cost more memory per shape listed (a big
 * coastline lands in every cell it spans) to save a bounding-box test that is
 * four comparisons.
 */
export const BUCKET_Z = 4

const BUCKET_COLS = tileCols(BUCKET_Z)
const BUCKET_ROWS = tileRows(BUCKET_Z)

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Cells of the bucket grid a box touches, row-major. Longitude does not wrap here. */
export function bucketsCovering(b: Bbox): number[] {
  const span = tileSpanDeg(BUCKET_Z)
  const x0 = clamp(Math.floor((b.minLng + 180) / span), 0, BUCKET_COLS - 1)
  const x1 = clamp(Math.floor((b.maxLng + 180) / span), 0, BUCKET_COLS - 1)
  const y0 = clamp(Math.floor((90 - b.maxLat) / span), 0, BUCKET_ROWS - 1)
  const y1 = clamp(Math.floor((90 - b.minLat) / span), 0, BUCKET_ROWS - 1)
  const out: number[] = []
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(y * BUCKET_COLS + x)
  return out
}

/** Everything in the layer whose bounding box could reach `b`. Deduped, in load order. */
export function shapesNear(layer: Layer, b: Bbox): number[] {
  const seen = new Set<number>()
  for (const cell of bucketsCovering(b)) {
    const list = layer.buckets[cell]
    if (!list) continue
    for (const i of list) {
      const [w, s, e, n] = layer.shapes[i].bbox
      if (e < b.minLng || w > b.maxLng || n < b.minLat || s > b.maxLat) continue
      seen.add(i)
    }
  }
  return [...seen].sort((a, b2) => a - b2)
}

// --- TopoJSON, the little of it this needs -----------------------------------

interface Topology {
  transform: { scale: [number, number]; translate: [number, number] }
  arcs: number[][][]
  objects: Record<string, TopoGeometry>
}
interface TopoGeometry {
  type: string
  geometries?: TopoGeometry[]
  arcs?: unknown
}

/** Delta-coded quantised integers to absolute degrees, once per topology. */
function decodeArcs(topo: Topology): Float64Array[] {
  const [sx, sy] = topo.transform.scale
  const [tx, ty] = topo.transform.translate
  return topo.arcs.map((arc) => {
    const out = new Float64Array(arc.length * 2)
    let x = 0
    let y = 0
    for (let i = 0; i < arc.length; i++) {
      x += arc[i][0]
      y += arc[i][1]
      out[i * 2] = x * sx + tx
      out[i * 2 + 1] = y * sy + ty
    }
    return out
  })
}

/**
 * A geometry's parts, one entry per SHAPE, each a list of rings.
 *
 * The split matters more than it looks. `world-atlas`'s `land` is a single
 * MultiPolygon of 1429 rings, so treating a geometry as a shape gives the
 * bucket index one entry with a bounding box of the whole planet — every tile
 * then walks 60 835 points to draw an island off Norway, and the index buys
 * nothing. Split per polygon it is 1420 shapes with real bounding boxes, and a
 * tile of the North Sea touches about thirty of them.
 *
 * A polygon keeps its holes, because they are one fill.
 */
function partsOf(g: TopoGeometry, into: number[][][] = []): number[][][] {
  if (g.geometries) {
    for (const child of g.geometries) partsOf(child, into)
    return into
  }
  const a = g.arcs as unknown
  if (!Array.isArray(a) || !a.length) return into
  switch (g.type) {
    case 'Polygon':
      into.push(a as number[][])
      break
    case 'MultiPolygon':
      for (const poly of a as number[][][]) into.push(poly)
      break
    case 'LineString':
      into.push([a as number[]])
      break
    case 'MultiLineString':
      for (const line of a as number[][]) into.push([line])
      break
    default:
      // Unlabelled nesting: descend until the elements are arc indices.
      if (typeof a[0] === 'number') into.push([a as number[]])
      else for (const child of a) partsOf({ type: '', arcs: child }, into)
  }
  return into
}

/** Stitch one ring's arcs into a point run, dropping each shared joint once. */
function stitch(arcs: Float64Array[], ids: number[]): number[] {
  const out: number[] = []
  for (const id of ids) {
    const arc = arcs[id < 0 ? ~id : id]
    const n = arc.length / 2
    const skip = out.length ? 1 : 0
    if (id < 0) {
      for (let i = n - 1 - skip; i >= 0; i--) out.push(arc[i * 2], arc[i * 2 + 1])
    } else {
      for (let i = skip; i < n; i++) out.push(arc[i * 2], arc[i * 2 + 1])
    }
  }
  return out
}

/* ------------------------------------------------------------------ the seam */

/**
 * THE ANTIMERIDIAN, and the defect it caused.
 *
 * Natural Earth carries a handful of rings with vertices on both sides of ±180
 * — Afro-Eurasia (because Chukotka reaches past it), Antarctica, Fiji, Wrangel
 * — and in a plate carrée picture a straight segment between two of them is a
 * line drawn across the whole world. An earlier round answered that in the path
 * builder by breaking the subpath at the jump and calling `closePath()` first.
 * `closePath` does not close along the seam: it closes back to the last
 * `moveTo`, which for the first piece of a ring is *the ring's own first
 * vertex*. Afro-Eurasia's ring starts at 16.45° E, 28.62° S — the mouth of the
 * Orange River — and crosses the seam twice, so the pen drew two chords from
 * South Africa to Chukotka. That is the streak the reader reported: "from a
 * point in South Africa … through Ceylon, South Korea … north of Kamchatka".
 *
 * The answer is to clip the ring to the ±180 strip HERE, once, at decode:
 *
 *  · the crossing is given its own vertex, interpolated onto the meridian, on
 *    both sides of it, so no segment ever spans the seam;
 *  · the ring is rotated to begin at a crossing, so each piece both starts and
 *    ends on a meridian and closing it runs *down the meridian* — which is
 *    where the data was clipped in the first place and is the correct fill;
 *  · a piece whose two ends are on OPPOSITE meridians — a polar cap, where the
 *    coast crosses the seam an odd number of times — is closed around the near
 *    pole instead, so Antarctica fills to 90° S rather than being sealed with a
 *    bar across the Pacific;
 *  · every edge inserted here is marked in `Shape.seam`, because it is a fact
 *    about the projection and not about the coast: the fill uses it, the pen
 *    steps over it (lib/drawnTile.ts).
 *
 * After this no shape in the world has a segment longer than 180° of longitude,
 * which is the invariant the regression test asserts.
 */
const seamMeet = (ax: number, ay: number, bx: number, by: number): [number, number] => {
  const exit = ax > 0 ? 180 : -180
  const d = bx + (exit > 0 ? 360 : -360) - ax
  const t = d === 0 ? 0 : (exit - ax) / d
  return [exit, ay + t * (by - ay)]
}

/** True where the step from a to b is the seam rather than 359° of ground. */
const jumpsSeam = (a: number, b: number) => Math.abs(b - a) > 180

/** One piece, sealed: down the meridian if it can be, around the pole if not. */
function sealPiece(run: number[], flags: number[]): void {
  const x0 = run[0]
  const xn = run[run.length - 2]
  if (x0 === xn) {
    // both ends on the same meridian: the closing edge IS the meridian
    flags[flags.length - 1] = 1
    return
  }
  // …and where they are not, the ring wrapped a pole. Round it: down this
  // meridian, across the top (or bottom) of the world, back up the other.
  const pole = (run[1] + run[run.length - 1]) / 2 >= 0 ? 90 : -90
  flags[flags.length - 1] = 1
  run.push(xn, pole)
  flags.push(1)
  run.push(x0, pole)
  flags.push(1)
}

/**
 * A stitched run, clipped to the ±180 strip. Returns the pieces and, for each,
 * the per-point "the edge leaving this point is the seam's" flags.
 */
export function splitAtSeam(run: number[], closed: boolean): { run: number[]; seam: number[] }[] {
  const m = run.length / 2
  if (m < 2) return [{ run, seam: new Array(m).fill(0) }]
  if (!closed) {
    const out: { run: number[]; seam: number[] }[] = []
    let cur = [run[0], run[1]]
    let flags = [0]
    for (let i = 1; i < m; i++) {
      if (jumpsSeam(run[(i - 1) * 2], run[i * 2])) {
        const [x, y] = seamMeet(run[(i - 1) * 2], run[(i - 1) * 2 + 1], run[i * 2], run[i * 2 + 1])
        cur.push(x, y)
        flags.push(0)
        out.push({ run: cur, seam: flags })
        cur = [-x, y]
        flags = [0]
      }
      cur.push(run[i * 2], run[i * 2 + 1])
      flags.push(0)
    }
    out.push({ run: cur, seam: flags })
    return out
  }
  // A closed ring is cyclic, so the repeated last vertex is dropped and the
  // walk starts at the first crossing — which is what turns the ring's opening
  // fragment and its closing fragment back into the one piece they are.
  const n = run[0] === run[(m - 1) * 2] && run[1] === run[(m - 1) * 2 + 1] ? m - 1 : m
  if (n < 2) return [{ run, seam: new Array(m).fill(0) }]
  const cut = (i: number) => jumpsSeam(run[i * 2], run[((i + 1) % n) * 2])
  let first = -1
  for (let i = 0; i < n && first < 0; i++) if (cut(i)) first = i
  if (first < 0) return [{ run, seam: new Array(m).fill(0) }]
  const meet = (i: number) =>
    seamMeet(run[i * 2], run[i * 2 + 1], run[((i + 1) % n) * 2], run[((i + 1) % n) * 2 + 1])
  const out: { run: number[]; seam: number[] }[] = []
  let cur: number[] = []
  let flags: number[] = []
  const enter = (i: number) => {
    const [x, y] = meet(i)
    cur.push(-x, y)
    flags.push(0)
  }
  enter(first)
  for (let s = 1; s <= n; s++) {
    const i = (first + s) % n
    cur.push(run[i * 2], run[i * 2 + 1])
    flags.push(0)
    if (!cut(i)) continue
    const [x, y] = meet(i)
    cur.push(x, y)
    flags.push(0)
    sealPiece(cur, flags)
    if (cur.length >= 6) out.push({ run: cur, seam: flags })
    cur = []
    flags = []
    if (s < n) enter(i)
  }
  return out
}

function shapeOf(arcs: Float64Array[], part: number[][], closed: boolean): Shape | undefined {
  const runs = part
    .flatMap((ids) => splitAtSeam(stitch(arcs, ids), closed))
    .filter((r) => r.run.length >= 4)
  if (!runs.length) return undefined
  const total = runs.reduce((n, r) => n + r.run.length, 0)
  const pts = new Float64Array(total)
  const rings = new Uint32Array(runs.length + 1)
  const seam = new Uint8Array(total / 2)
  let seamed = false
  let at = 0
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  runs.forEach(({ run, seam: flags }, i) => {
    rings[i] = at / 2
    pts.set(run, at)
    for (let k = 0; k < flags.length; k++) {
      if (!flags[k]) continue
      seam[at / 2 + k] = 1
      seamed = true
    }
    at += run.length
    for (let k = 0; k < run.length; k += 2) {
      if (run[k] < w) w = run[k]
      if (run[k] > e) e = run[k]
      if (run[k + 1] < s) s = run[k + 1]
      if (run[k + 1] > n) n = run[k + 1]
    }
  })
  rings[runs.length] = at / 2
  return { pts, rings, bbox: [w, s, e, n], ...(seamed ? { seam } : {}) }
}

/**
 * One Chaikin corner-cut, in place of the staircase quantisation leaves.
 *
 * Only the water layers need it and only because of where they come from: the
 * one reachable npm source for Natural Earth rivers and lakes quantises at
 * 0.036° (~4 km) against the coastline's 0.0036°, so at regional zoom a river
 * is a flight of 26-pixel steps. A single Chaikin pass replaces each interior
 * vertex with the two points a quarter of the way along its neighbours, which
 * turns the staircase into a curve through the same corridor — the shape the
 * data actually asserts, drawn as a drawn map would draw it. Run once at load,
 * so it costs nothing per tile and cannot make two tiles disagree.
 */
function chaikin(shape: Shape, closed: boolean): Shape {
  // A corner cut across a seam closure would pull the ring off the meridian and
  // leave a gap there. No river or lake in the vendored data crosses ±180 (the
  // decode asserts it in tests/drawnMap.test.ts), so the honest answer is to
  // leave a split shape exactly as the clipper left it rather than to invent a
  // rule for a case that does not occur.
  if (shape.seam) return shape
  const out: number[] = []
  const rings = new Uint32Array(shape.rings.length)
  for (let r = 0; r + 1 < shape.rings.length; r++) {
    const from = shape.rings[r]
    const to = shape.rings[r + 1]
    rings[r] = out.length / 2
    const n = to - from
    if (n < 3) {
      for (let i = from; i < to; i++) out.push(shape.pts[i * 2], shape.pts[i * 2 + 1])
      continue
    }
    if (!closed) out.push(shape.pts[from * 2], shape.pts[from * 2 + 1])
    for (let i = from; i < to - 1; i++) {
      const ax = shape.pts[i * 2]
      const ay = shape.pts[i * 2 + 1]
      const bx = shape.pts[i * 2 + 2]
      const by = shape.pts[i * 2 + 3]
      out.push(ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25)
      out.push(ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75)
    }
    if (!closed) out.push(shape.pts[(to - 1) * 2], shape.pts[(to - 1) * 2 + 1])
    else out.push(out[rings[r] * 2], out[rings[r] * 2 + 1])
  }
  rings[shape.rings.length - 1] = out.length / 2
  return { pts: Float64Array.from(out), rings, bbox: shape.bbox }
}

/** Decode one named object of a topology into an indexed layer. */
export function layerOf(topo: Topology, name: string, closed: boolean, smooth = false): Layer {
  const arcs = decodeArcs(topo)
  const object = topo.objects[name]
  const shapes: Shape[] = []
  for (const part of object ? partsOf(object) : []) {
    const shape = shapeOf(arcs, part, closed)
    if (shape) shapes.push(smooth ? chaikin(shape, closed) : shape)
  }
  const lists: number[][] = []
  shapes.forEach((shape, i) => {
    const [minLng, minLat, maxLng, maxLat] = shape.bbox
    for (const cell of bucketsCovering({ minLng, minLat, maxLng, maxLat })) {
      ;(lists[cell] ??= []).push(i)
    }
  })
  return { shapes, closed, buckets: lists.map((l) => (l ? Uint32Array.from(l) : l)) }
}

/**
 * The whole vector world, in two stages.
 *
 * `coarseLand` is 110m — 55 kB — and is what the first drawn tile is drawn
 * from; the rest is 50m and 841 kB, and replaces it the moment it has parsed.
 * That is the only job 110m has left, and it is not the job the design expected
 * it to have: the measurement (scripts/measure-drawn.mjs) says 110m survives
 * the half-pixel filter with 4 992 segments at the BASE level against 50m's
 * 55 055, so it is already the coarser answer everywhere the drawn map is ever
 * drawn. Keeping it as a level-of-detail *floor* rather than as a level-of-
 * detail *choice* is what the numbers support: a coastline while the real one
 * loads, not a coastline anybody looks at.
 *
 * Water is only ever 50m — there is no 110m river worth drawing — and is its
 * own topology because it is quantised ten times more coarsely than the land it
 * runs through (see scripts/vendor-map-data.mjs).
 */
export interface DrawnWorld {
  coarseLand: Layer
  /** The 50m layers; absent until the second stage lands. */
  land?: Layer
  rivers?: Layer
  lakes?: Layer
}

/** Build the world from already-parsed topologies. Pure; the tests use it. */
export function buildWorld(coarse: Topology, fine?: Topology, water?: Topology): DrawnWorld {
  return {
    coarseLand: layerOf(coarse, 'land', true),
    land: fine && layerOf(fine, 'land', true),
    rivers: water && layerOf(water, 'rivers', false, true),
    lakes: water && layerOf(water, 'lakes', true, true),
  }
}

/**
 * Where the vendored files live, relative to the app's base URL.
 *
 * Physical geography only. `land-50m.json` was `world-50m.json` and carried a
 * `countries` object as well; the drawn map stopped drawing borders (they are
 * the time-aware nations layer's, see lib/drawnTile.ts) and the vendor script
 * stopped extracting them, which took the file from 746 kB to 538 kB: 362 arcs
 * that only ever described an interior boundary, plus the 736-feature object
 * that indexed them.
 */
export const MAP_DATA = {
  coarse: 'land-110m.json',
  fine: 'land-50m.json',
  water: 'water-50m.json',
} as const

/**
 * Fetch and decode, coarse first.
 *
 * The promise resolves on 55 kB, so the drawn map can start rendering tiles
 * about 300 ms before the 841 kB of 50m geometry has been parsed into typed
 * arrays; `onFine` fires when it has, and the caller re-renders. Nothing waits
 * on the second stage and nothing breaks if it never arrives.
 */
export async function loadWorld(base = '/', onFine?: (w: DrawnWorld) => void): Promise<DrawnWorld> {
  const get = (f: string) => fetch(`${base}data/map/${f}`).then((r) => r.json() as Promise<Topology>)
  const rest = Promise.all([get(MAP_DATA.fine), get(MAP_DATA.water)])
  const world = buildWorld(await get(MAP_DATA.coarse))
  void rest.then(([fine, water]) => {
    world.land = layerOf(fine, 'land', true)
    world.rivers = layerOf(water, 'rivers', false, true)
    world.lakes = layerOf(water, 'lakes', true, true)
    onFine?.(world)
  })
  return world
}
