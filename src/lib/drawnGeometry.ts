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

/**
 * An edge that runs ALONG ±180 is the clip's, whoever made it.
 *
 * Round 51 marked the closures this file inserts. The 10m data brought the
 * other half of the same fact: Natural Earth's own ring for Afro-Eurasia
 * carries vertices exactly ON the meridian — its 10m edition walks 68.98° N
 * down to 65.07° N along −180 before it comes back — because that is how a
 * dataset clipped at the antimeridian describes the cut. Unmarked, that is
 * 3.9° of coastline ink with 22 px of shoreline wash beside it, drawn down the
 * middle of the Bering Sea: the round-51 defect, arriving as data instead of as
 * a `closePath`.
 *
 * The rule is the one already in force here — a segment with both ends on the
 * meridian is a fact about the projection, not about a coast — and it is safe
 * in the only direction that matters: a real coastline that ran exactly along
 * ±180 for any distance would lose a hairline in open ocean, and none does.
 * (50m has fourteen such edges and every one of them is zero-length, which is
 * why this never showed before.)
 */
function markMeridian(run: number[], flags: number[]): void {
  const n = run.length / 2
  for (let i = 0; i < n; i++) {
    const x = run[i * 2]
    if (Math.abs(x) === 180 && run[((i + 1) % n) * 2] === x) flags[i] = 1
  }
}

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
  const out = splitPieces(run, closed)
  for (const piece of out) markMeridian(piece.run, piece.seam)
  return out
}

function splitPieces(run: number[], closed: boolean): { run: number[]; seam: number[] }[] {
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

/* --------------------------------------------------------------- the chunker */

/**
 * SIX SHAPES HOLD HALF THE WORLD, and at 10m that is what a tile costs.
 *
 * The bucket index narrows a tile to the features near it, but a feature is
 * indexed by its BOUNDING BOX and Afro-Eurasia's box is a hemisphere: every
 * tile from Lisbon to Kamchatka names it, and drawing it means walking — and
 * stroking, five times over — the whole of its 84 118 points. At 50m that ring
 * is 11 033 points and the bill is 2 ms; at 10m it is 7.6× longer and the bill
 * is 11–29 ms against a budget of 8. Measured with the six shapes over 5 000
 * points removed, the same tiles cost 0.35 ms — so the cost is not the data, it
 * is the six.
 *
 * So the 10m layer is CUT INTO CELLS at decode, and a cell of Siberia's coast is
 * a shape of a few hundred points with a bounding box a few degrees across. The
 * cut is a polygon clip, not a break: a piece is a closed ring that can be
 * filled, and the edges the clip inserted along the cell wall are marked in
 * `Shape.seam` — the same flag, meaning the same thing, as the antimeridian's.
 * The fill needs them; the pen must not follow them, or the map grows a grid of
 * coastline down every cell wall.
 *
 * Two details that are not decoration:
 *
 *  · **A cell in the middle of a continent contains no coastline at all.**
 *    Clipping Eurasia to a cell of the Gobi gives nothing back, and nothing
 *    back means an unfilled hole in Asia. So a cell that no ring reaches, but
 *    whose centre is INSIDE the ring, becomes the cell rectangle itself — all
 *    of it seam, none of it drawn, all of it filled.
 *  · **The cells overlap by `CHUNK_PAD`.** Two fills that share an exact edge
 *    each cover half of the pixels on it, and half plus half is 75% of a
 *    colour, not 100% — a pale hairline of sea down every cell wall. A pad of
 *    0.003° is over half a tile pixel at level 7 (the coarsest level this layer
 *    is drawn at) and the seam closes. What the overlap costs is a sliver of
 *    coast inked twice, which is invisible: the coast pen and the wash are
 *    opaque, so drawing them twice is drawing them once.
 */
export const CHUNK_DEG = 360 / 64
export const CHUNK_PAD = 0.003
/**
 * Shapes below this are left whole. The cut costs points (every crossing gains
 * a vertex) and shapes (every cell gains an entry), and buys nothing on a
 * feature the bucket index can already exclude: measured, 6 720 of the 10m
 * layer's 6 753 shapes are under 1 000 points and together are cheaper to draw
 * than one continent.
 */
export const CHUNK_MIN_PTS = 2000

/** A ring as the clipper works on it: points, and the seam flag of each edge. */
interface Run {
  run: number[]
  seam: number[]
  /** Cached bounds; a ring that misses a cell is neither clipped nor tested. */
  box?: [number, number, number, number]
}

function boundsOf(r: Run): [number, number, number, number] {
  if (r.box) return r.box
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (let i = 0; i < r.run.length; i += 2) {
    if (r.run[i] < w) w = r.run[i]
    if (r.run[i] > e) e = r.run[i]
    if (r.run[i + 1] < s) s = r.run[i + 1]
    if (r.run[i + 1] > n) n = r.run[i + 1]
  }
  return (r.box = [w, s, e, n])
}

/**
 * Sutherland–Hodgman against one edge of the cell, carrying the seam flags.
 *
 * The flag rule is the whole reason this is not a library call. A vertex is
 * emitted with the flag of the edge LEAVING it, so:
 *
 *  · an edge with both ends inside keeps whatever it was (a coast stays a
 *    coast, an antimeridian closure stays a closure);
 *  · an edge leaving the cell contributes its real part, and the crossing
 *    vertex then leads along the cell wall until the ring comes back — that
 *    stretch is the clip's own and is marked 1;
 *  · an edge coming back in contributes its real part, flag intact.
 *
 * Which is why a coastline that cuts a cell CORNER — in through one wall, out
 * through the next, with no vertex between — keeps its ink: each wall clips it
 * as a real edge, and only the connector between an exit and a re-entry is ever
 * marked. A "both ends lie on the wall, so it must be the wall" test would have
 * silently erased those segments.
 */
function clipHalf(r: Run, keep: (x: number, y: number) => boolean, meet: (ax: number, ay: number, bx: number, by: number) => [number, number]): Run {
  const n = r.run.length / 2
  const run: number[] = []
  const seam: number[] = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const ax = r.run[i * 2]
    const ay = r.run[i * 2 + 1]
    const bx = r.run[j * 2]
    const by = r.run[j * 2 + 1]
    const f = r.seam[i]
    const ain = keep(ax, ay)
    const bin = keep(bx, by)
    if (ain) {
      run.push(ax, ay)
      seam.push(bin ? f : 1)
      if (!bin) {
        const [x, y] = meet(ax, ay, bx, by)
        run.push(x, y)
        seam.push(1)
      }
    } else if (bin) {
      const [x, y] = meet(ax, ay, bx, by)
      run.push(x, y)
      seam.push(f)
    }
  }
  // …and the edge that was cut leaves the crossing vertex, so the flag written
  // when it was emitted (1, "along the wall") is right for every case but one:
  // a ring that never left has no crossing at all, and is returned untouched.
  return { run, seam }
}

const between = (a: number, b: number, at: number) => (at - a) / (b - a || 1)

/** The four walls, as (keep, meet) pairs. `side` is which of them a cut is. */
export type Wall = 'w' | 'e' | 's' | 'n'
const wallAt = (side: Wall, at: number) =>
  ({
    w: [(x: number) => x >= at, (ax: number, ay: number, bx: number, by: number): [number, number] => [at, ay + (by - ay) * between(ax, bx, at)]],
    e: [(x: number) => x <= at, (ax: number, ay: number, bx: number, by: number): [number, number] => [at, ay + (by - ay) * between(ax, bx, at)]],
    s: [(_: number, y: number) => y >= at, (ax: number, ay: number, bx: number, by: number): [number, number] => [ax + (bx - ax) * between(ay, by, at), at]],
    n: [(_: number, y: number) => y <= at, (ax: number, ay: number, bx: number, by: number): [number, number] => [ax + (bx - ax) * between(ay, by, at), at]],
  })[side] as [(x: number, y: number) => boolean, (ax: number, ay: number, bx: number, by: number) => [number, number]]

/** One ring, clipped to `[w, s, e, n]`. Empty when the ring misses the box. */
function clipToBox(r: Run, w: number, s: number, e: number, n: number): Run | undefined {
  let out: Run = r
  for (const [side, at] of [['w', w], ['e', e], ['s', s], ['n', n]] as [Wall, number][]) {
    out = clipHalf(out, ...wallAt(side, at))
    if (!out.run.length) return undefined
  }
  return out.run.length >= 6 ? out : undefined
}

/** Ray cast against a closed run. Used only to ask "is this cell interior land". */
function contains(r: Run, x: number, y: number): boolean {
  const n = r.run.length / 2
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = r.run[i * 2]
    const ay = r.run[i * 2 + 1]
    const bx = r.run[j * 2]
    const by = r.run[j * 2 + 1]
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
  }
  return inside
}

/** The cell itself, as a ring nobody draws. */
const boxRun = (w: number, s: number, e: number, n: number): Run => ({
  run: [w, s, e, s, e, n, w, n],
  seam: [1, 1, 1, 1],
})

/**
 * Every ring against one child box: clipped, or substituted, or dropped.
 *
 * `side` is the ONE wall this step introduced. The rings coming in were already
 * clipped to the parent box, whose other three walls the child shares, so
 * clipping against all four would be three no-ops out of four passes — and at
 * eleven levels of recursion that is most of the decode. Only the root gets the
 * whole box, and only because it is the one step where nothing is known yet.
 */
function clipRings(rings: Run[], w: number, s: number, e: number, n: number, side?: Wall): Run[] {
  const out: Run[] = []
  let real = 0
  let filled = 0
  const wall = side && wallAt(side, { w, e, s, n }[side])
  for (const r of rings) {
    const [rw, rs, re, rn] = boundsOf(r)
    // A ring that misses the box cannot be clipped to it and cannot contain its
    // centre either, so it is not this cell's business at all.
    if (re < w || rw > e || rn < s || rs > n) continue
    const one = wall && clipHalf(r, ...wall)
    const cut = wall ? (one!.run.length >= 6 ? one : undefined) : clipToBox(r, w, s, e, n)
    if (cut) {
      out.push(cut)
      real++
    } else if (contains(r, (w + e) / 2, (s + n) / 2)) {
      out.push(boxRun(w, s, e, n))
      filled++
    }
  }
  // Interior: the cell is inside an odd number of rings, so it is land, and one
  // rectangle says so. Inside an even number it is a hole in the hole, and
  // saying it twice with `evenodd` says nothing at all — drop the cell.
  if (!real && filled) return filled % 2 ? [out[0]] : []
  return out
}

const runsOf = (shape: Shape): Run[] => {
  const out: Run[] = []
  for (let r = 0; r + 1 < shape.rings.length; r++) {
    const from = shape.rings[r]
    const to = shape.rings[r + 1]
    const run: number[] = []
    const seam: number[] = []
    for (let i = from; i < to; i++) {
      run.push(shape.pts[i * 2], shape.pts[i * 2 + 1])
      seam.push(shape.seam?.[i] ?? 0)
    }
    out.push({ run, seam })
  }
  return out
}

/**
 * One shape, cut to the chunk grid — BY HALVES, not cell by cell.
 *
 * Clipping Eurasia against each of the ~1 300 cells its bounding box touches is
 * 84 118 points × 1 300, and the obvious repair (rows, then columns within a
 * row) is still points × rows + points × cells-in-row. Splitting the cell RANGE
 * in half instead, and clipping the halves rather than the whole, costs
 * points × log₂(cells) — 84 118 × 11 — and lands on exactly the same leaves,
 * because every cut is on a grid line. Measured over the six chunked features:
 * 1 570 ms cell-by-cell, 250 ms by halves.
 *
 * It also disposes of continental interiors for free. The Gobi is inside the
 * ring but reaches none of it, so the rectangle substitution happens at some
 * node high in the recursion, and everything below that node is subdividing a
 * four-point rectangle.
 */
export function chunkShape(shape: Shape, cell = CHUNK_DEG, pad = CHUNK_PAD): Shape[] {
  const [w, s, e, n] = shape.bbox
  const x0 = Math.floor((w + 180) / cell)
  const x1 = Math.floor((e + 180) / cell)
  const y0 = Math.floor((s + 90) / cell)
  const y1 = Math.floor((n + 90) / cell)
  if (x0 === x1 && y0 === y1) return [shape]
  const out: Shape[] = []
  const box = (gx0: number, gx1: number, gy0: number, gy1: number) =>
    [
      gx0 * cell - 180 - pad,
      gy0 * cell - 90 - pad,
      (gx1 + 1) * cell - 180 + pad,
      (gy1 + 1) * cell - 90 + pad,
    ] as const
  const cut = (rings: Run[], gx0: number, gx1: number, gy0: number, gy1: number) => {
    if (!rings.length) return
    if (gx0 === gx1 && gy0 === gy1) {
      const built = shapeFromRuns(rings)
      if (built) out.push(built)
      return
    }
    if (gx1 - gx0 >= gy1 - gy0) {
      const mid = (gx0 + gx1) >> 1
      cut(clipRings(rings, ...box(gx0, mid, gy0, gy1), 'e'), gx0, mid, gy0, gy1)
      cut(clipRings(rings, ...box(mid + 1, gx1, gy0, gy1), 'w'), mid + 1, gx1, gy0, gy1)
    } else {
      const mid = (gy0 + gy1) >> 1
      cut(clipRings(rings, ...box(gx0, gx1, gy0, mid), 'n'), gx0, gx1, gy0, mid)
      cut(clipRings(rings, ...box(gx0, gx1, mid + 1, gy1), 's'), gx0, gx1, mid + 1, gy1)
    }
  }
  cut(clipRings(runsOf(shape), ...box(x0, x1, y0, y1)), x0, x1, y0, y1)
  return out.length ? out : [shape]
}

/* ------------------------------------------------------------------- shapes */

function shapeFromRuns(runs: { run: number[]; seam: number[] }[]): Shape | undefined {
  runs = runs.filter((r) => r.run.length >= 4)
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

function shapeOf(arcs: Float64Array[], part: number[][], closed: boolean): Shape | undefined {
  return shapeFromRuns(part.flatMap((ids) => splitAtSeam(stitch(arcs, ids), closed)))
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

/** How a layer wants to be decoded. Both default off; both are measured choices. */
export interface DecodeOptions {
  /** One Chaikin pass, for data quantised more coarsely than it is dense. */
  smooth?: boolean
  /** Cut features bigger than `CHUNK_MIN_PTS` to the chunk grid. 10m land only. */
  chunk?: boolean
}

/** Decode one named object of a topology into an indexed layer. */
export function layerOf(
  topo: Topology,
  name: string,
  closed: boolean,
  { smooth = false, chunk = false }: DecodeOptions = {},
): Layer {
  const arcs = decodeArcs(topo)
  const object = topo.objects[name]
  const shapes: Shape[] = []
  for (const part of object ? partsOf(object) : []) {
    const shape = shapeOf(arcs, part, closed)
    if (!shape) continue
    if (smooth) shapes.push(chaikin(shape, closed))
    else if (chunk && shape.pts.length / 2 > CHUNK_MIN_PTS) shapes.push(...chunkShape(shape))
    else shapes.push(shape)
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

/* ------------------------------------------------------- a layer, on the wire */

/**
 * A decoded layer FLATTENED INTO NINE TYPED ARRAYS, so it can be handed between
 * workers for the cost of nine pointers.
 *
 * This exists because of where the decode now happens. The 10m rung is 3.3 MB
 * of JSON and ~700 ms of parse-and-cut (measured in node; a phone is several
 * times that), and it used to run inside the ONE worker that also draws every
 * tile — so the moment a reader crossed level 7, every tile of the zoom they
 * were in the middle of queued behind it and the atlas starved for the whole
 * gesture. The decode is therefore done in its own worker (lib/drawnDecode.
 * worker.ts) and the result is sent to the renderer; what follows is the only
 * part of that which needed thought.
 *
 * A `Layer` is 7 701 shapes, each holding three or four typed arrays. Sent as
 * itself, structured clone walks ~30 000 objects and copies every buffer, twice
 * over if the message is relayed through the main thread — which would move the
 * stall rather than remove it. Packed, the whole layer is nine buffers, and
 * every one of them is TRANSFERRED: serialising is O(1), and the receiving side
 * rebuilds the shapes as `subarray` VIEWS onto the arrays it was given, so no
 * point is ever copied on either thread.
 *
 * The one thing to be careful about is `Shape.rings`, which indexes points
 * relative to the shape's own `pts`. Packing keeps each shape's ring array
 * verbatim and hands back a view of exactly its points, so the indices mean the
 * same thing on the other side and the drawing is identical byte for byte —
 * which the round-trip test asserts rather than assumes.
 */
export interface PackedLayer {
  closed: boolean
  /** How many shapes. Everything below is indexed by it. */
  n: number
  /** Every shape's points, end to end. */
  pts: Float64Array
  /** Where each shape's points start, in POINTS, with a terminator. */
  ptsAt: Uint32Array
  /** Every shape's ring table, end to end, each still relative to its shape. */
  rings: Uint32Array
  /** Where each shape's ring table starts, with a terminator. */
  ringsAt: Uint32Array
  /** Seam flags per point over the whole layer; zero where a shape has none. */
  seam: Uint8Array
  /** 1 where the shape carries seam flags at all — `Shape.seam` is optional. */
  hasSeam: Uint8Array
  /** minLng, minLat, maxLng, maxLat per shape. */
  bbox: Float64Array
  /** Bucket lists end to end… */
  buckets: Uint32Array
  /** …and where each cell's starts, with a terminator. */
  bucketsAt: Uint32Array
}

export function packLayer(layer: Layer): PackedLayer {
  const n = layer.shapes.length
  let totalPts = 0
  let totalRings = 0
  for (const s of layer.shapes) {
    totalPts += s.pts.length / 2
    totalRings += s.rings.length
  }
  const pts = new Float64Array(totalPts * 2)
  const ptsAt = new Uint32Array(n + 1)
  const rings = new Uint32Array(totalRings)
  const ringsAt = new Uint32Array(n + 1)
  const seam = new Uint8Array(totalPts)
  const hasSeam = new Uint8Array(n)
  const bbox = new Float64Array(n * 4)
  let p = 0
  let r = 0
  layer.shapes.forEach((s, i) => {
    ptsAt[i] = p
    ringsAt[i] = r
    pts.set(s.pts, p * 2)
    rings.set(s.rings, r)
    if (s.seam) {
      seam.set(s.seam, p)
      hasSeam[i] = 1
    }
    bbox.set(s.bbox, i * 4)
    p += s.pts.length / 2
    r += s.rings.length
  })
  ptsAt[n] = p
  ringsAt[n] = r
  // The bucket grid is a SPARSE array — `layerOf` only creates a cell a shape
  // lands in — and an empty cell must stay empty on the other side, so the
  // offsets are what carry the emptiness rather than a sentinel.
  const cells = layer.buckets.length
  const bucketsAt = new Uint32Array(cells + 1)
  let b = 0
  for (let c = 0; c < cells; c++) {
    bucketsAt[c] = b
    b += layer.buckets[c]?.length ?? 0
  }
  bucketsAt[cells] = b
  const buckets = new Uint32Array(b)
  let at = 0
  for (let c = 0; c < cells; c++) {
    const list = layer.buckets[c]
    if (!list) continue
    buckets.set(list, at)
    at += list.length
  }
  return { closed: layer.closed, n, pts, ptsAt, rings, ringsAt, seam, hasSeam, bbox, buckets, bucketsAt }
}

/** The layer again, as views onto the arrays that arrived. Nothing is copied. */
export function unpackLayer(p: PackedLayer): Layer {
  const shapes: Shape[] = new Array(p.n)
  for (let i = 0; i < p.n; i++) {
    const from = p.ptsAt[i]
    const to = p.ptsAt[i + 1]
    const shape: Shape = {
      pts: p.pts.subarray(from * 2, to * 2),
      rings: p.rings.subarray(p.ringsAt[i], p.ringsAt[i + 1]),
      bbox: [p.bbox[i * 4], p.bbox[i * 4 + 1], p.bbox[i * 4 + 2], p.bbox[i * 4 + 3]],
    }
    if (p.hasSeam[i]) shape.seam = p.seam.subarray(from, to)
    shapes[i] = shape
  }
  const buckets: Uint32Array[] = new Array(p.bucketsAt.length - 1)
  for (let c = 0; c + 1 < p.bucketsAt.length; c++) {
    const from = p.bucketsAt[c]
    const to = p.bucketsAt[c + 1]
    if (to > from) buckets[c] = p.buckets.subarray(from, to)
  }
  return { shapes, closed: p.closed, buckets }
}

/** The buffers to hand to `postMessage`'s transfer list: all of them. */
export const packedBuffers = (p: PackedLayer): ArrayBuffer[] =>
  [p.pts, p.ptsAt, p.rings, p.ringsAt, p.seam, p.hasSeam, p.bbox, p.buckets, p.bucketsAt].map(
    (a) => a.buffer as ArrayBuffer,
  )

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
  /**
   * 10m land — the third rung, and the only one that is never fetched unless a
   * reader asks for ground fine enough to need it (see `requestFine`).
   */
  fineLand?: Layer
  /**
   * "Somebody is drawing at a level 50m cannot answer."
   *
   * Called by the renderer, idempotent, and absent on a world built by
   * `buildWorld` — a topology handed in is a topology already paid for, so the
   * pure builder has nothing to go and get. This is the whole of the
   * progressive load: 851 kB gzipped that a world view never asks for.
   */
  requestFine?: () => void
}

/** Which file has landed. The tile cache is keyed by it; see `DRAWN_LABELS`. */
export type DrawnStage = '50m' | '10m'

/**
 * Build the world from already-parsed topologies. Pure; the tests use it.
 *
 * `finest` is 10m land and is chunked at decode (`chunkShape`); the other
 * layers are not, because nothing in them is big enough to pay for it.
 */
export function buildWorld(
  coarse: Topology,
  fine?: Topology,
  water?: Topology,
  finest?: Topology,
): DrawnWorld {
  return {
    coarseLand: layerOf(coarse, 'land', true),
    land: fine && layerOf(fine, 'land', true),
    rivers: water && layerOf(water, 'rivers', false, { smooth: true }),
    lakes: water && layerOf(water, 'lakes', true, { smooth: true }),
    fineLand: finest && layerOf(finest, 'land', true, { chunk: true }),
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
  finest: 'land-10m.json',
} as const

/**
 * Fetch and decode, coarse first — and 10m never, until it is asked for.
 *
 * The promise resolves on 55 kB, so the drawn map can start rendering tiles
 * about 300 ms before the 841 kB of 50m geometry has been parsed into typed
 * arrays; `onStage('50m')` fires when it has, and the caller re-renders.
 * Nothing waits on the second stage and nothing breaks if it never arrives.
 *
 * The third stage is 3.3 MB of JSON — 851 kB over the wire — and is fetched by
 * `requestFine`, which the renderer calls the first time it draws a plate at a
 * level 50m geometry has stopped being able to answer (`LOD_FINE_Z`, measured
 * in lib/drawnTile.ts). A reader who looks at the world and leaves never asks
 * for it; a reader who zooms to a coast asks for it once.
 *
 * `fine: false` REFUSES that third stage here, and it is what the tile worker
 * passes. The trigger is unchanged — a tile at level 7 is still what buys the
 * file — but the work is done in lib/drawnDecode.worker.ts and installed from
 * outside, because ~700 ms of parse and cut inside the thread that draws tiles
 * is 700 ms in which no tile can be drawn, and the thing that asks for it is a
 * reader in the middle of a zoom. See `DrawnTiles.requestFine`.
 *
 * The 50m stage stays here, and that is measured rather than assumed: it parses
 * and decodes in 17 ms against 10m's ~940, so moving it would buy a frame and
 * cost a second worker at load.
 */
export async function loadWorld(
  base = '/',
  onStage?: (stage: DrawnStage, w: DrawnWorld) => void,
  { fine = true }: { fine?: boolean } = {},
): Promise<DrawnWorld> {
  const get = (f: string) => fetch(`${base}data/map/${f}`).then((r) => r.json() as Promise<Topology>)
  const rest = Promise.all([get(MAP_DATA.fine), get(MAP_DATA.water)])
  const world = buildWorld(await get(MAP_DATA.coarse))
  let asked = false
  if (fine)
    world.requestFine = () => {
      if (asked) return
      asked = true
      void get(MAP_DATA.finest).then((finest) => {
        world.fineLand = layerOf(finest, 'land', true, { chunk: true })
        onStage?.('10m', world)
      })
    }
  void rest.then(([fine, water]) => {
    world.land = layerOf(fine, 'land', true)
    world.rivers = layerOf(water, 'rivers', false, { smooth: true })
    world.lakes = layerOf(water, 'lakes', true, { smooth: true })
    onStage?.('50m', world)
  })
  return world
}
