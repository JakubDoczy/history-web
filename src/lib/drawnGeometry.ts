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

function shapeOf(arcs: Float64Array[], part: number[][]): Shape | undefined {
  const runs = part.map((ids) => stitch(arcs, ids)).filter((r) => r.length >= 4)
  if (!runs.length) return undefined
  const total = runs.reduce((n, r) => n + r.length, 0)
  const pts = new Float64Array(total)
  const rings = new Uint32Array(runs.length + 1)
  let at = 0
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  runs.forEach((run, i) => {
    rings[i] = at / 2
    pts.set(run, at)
    at += run.length
    for (let k = 0; k < run.length; k += 2) {
      if (run[k] < w) w = run[k]
      if (run[k] > e) e = run[k]
      if (run[k + 1] < s) s = run[k + 1]
      if (run[k + 1] > n) n = run[k + 1]
    }
  })
  rings[runs.length] = at / 2
  return { pts, rings, bbox: [w, s, e, n] }
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
    const shape = shapeOf(arcs, part)
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
 * from; the rest is 50m and 1.05 MB, and replaces it the moment it has parsed.
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
  countries?: Layer
  rivers?: Layer
  lakes?: Layer
}

/** Build the world from already-parsed topologies. Pure; the tests use it. */
export function buildWorld(coarse: Topology, fine?: Topology, water?: Topology): DrawnWorld {
  return {
    coarseLand: layerOf(coarse, 'land', true),
    land: fine && layerOf(fine, 'land', true),
    countries: fine && layerOf(fine, 'countries', true),
    rivers: water && layerOf(water, 'rivers', false, true),
    lakes: water && layerOf(water, 'lakes', true, true),
  }
}

/** Where the vendored files live, relative to the app's base URL. */
export const MAP_DATA = {
  coarse: 'land-110m.json',
  fine: 'world-50m.json',
  water: 'water-50m.json',
} as const

/**
 * Fetch and decode, coarse first.
 *
 * The promise resolves on 55 kB, so the drawn map can start rendering tiles
 * about 300 ms before the 1.05 MB of 50m geometry has been parsed into typed
 * arrays; `onFine` fires when it has, and the caller re-renders. Nothing waits
 * on the second stage and nothing breaks if it never arrives.
 */
export async function loadWorld(base = '/', onFine?: (w: DrawnWorld) => void): Promise<DrawnWorld> {
  const get = (f: string) => fetch(`${base}data/map/${f}`).then((r) => r.json() as Promise<Topology>)
  const rest = Promise.all([get(MAP_DATA.fine), get(MAP_DATA.water)])
  const world = buildWorld(await get(MAP_DATA.coarse))
  void rest.then(([fine, water]) => {
    world.land = layerOf(fine, 'land', true)
    world.countries = layerOf(fine, 'countries', true)
    world.rivers = layerOf(water, 'rivers', false, true)
    world.lakes = layerOf(water, 'lakes', true, true)
    onFine?.(world)
  })
  return world
}
