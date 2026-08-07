/**
 * THE NATIONS PIPELINE, in pure functions — clip, resolve, classify, simplify,
 * validate. `scripts/clip-nations.mjs` is the CLI around it; tests/nations*.ts
 * import it directly, which is the reason it is a module of functions over
 * plain arrays rather than a script that reads and writes files.
 *
 * The two defects it exists to remove are named in docs/design/nations-rework.md:
 *
 *  1. a polity's hand-authored coastline is not the coastline the drawn map
 *     renders, so a fill juts into the sea or stops short of it;
 *  2. two concurrent polities claim the same region, because each was drawn
 *     without the other in front of the author.
 *
 * Both are answered by *construction* rather than by care. The coast is taken
 * from the same `land-50m.json` the map is drawn from, so agreement is not a
 * thing anybody can forget. The frontier between two polities is subtracted
 * from one of them, so a shared boundary is one line by arithmetic.
 *
 * Everything here is planar in degrees. That is not a projection choice, it is
 * the coordinate system the data is authored in, the one the clipper runs in
 * and the one the renderer reads; areas are therefore "square degrees" and are
 * only ever compared with each other.
 */

import polygonClipping from 'polygon-clipping'

/** Closed ring, [lng, lat], first point repeated last — the clipper's shape. */
/** Polygon: outer ring first, holes after. MultiPolygon: a list of those. */

/* ---------------------------------------------------------------- the land */

/**
 * The land, as a MultiPolygon the clipper can take, out of the decoded layer
 * the app itself renders (lib/drawnGeometry.ts).
 *
 * One subtlety, and it is the difference between this working and silently
 * clipping Mesopotamia away to nothing. `Shape.rings` is a flat list of rings
 * with NO outer/hole distinction — the rasterizer fills it with `evenodd` and
 * does not need one. Handed to the clipper as a Polygon, ring 0 is the exterior
 * and every other ring is a HOLE; and for the four shapes `splitAtSeam` cut in
 * two (Afro-Eurasia, Antarctica, Fiji, Wrangel) the second piece is not a hole,
 * it is the rest of the continent. Afro-Eurasia read that way is "the sliver
 * past 180° minus everything else", i.e. nothing, and every polity in the Old
 * World clipped to empty.
 *
 * `xor` is the even-odd rule spelled as a boolean op, so it is the same reading
 * the rasterizer takes: disjoint pieces union, a nested ring subtracts. It runs
 * only on the four multi-ring shapes; the other 1423 are one ring and are
 * already a polygon.
 */
export function landPolygons(landLayer) {
  const out = []
  for (const shape of landLayer.shapes) {
    const rings = []
    for (let r = 0; r + 1 < shape.rings.length; r++) {
      const ring = []
      for (let i = shape.rings[r]; i < shape.rings[r + 1]; i++)
        ring.push([shape.pts[i * 2], shape.pts[i * 2 + 1]])
      if (ring.length < 3) continue
      const [fx, fy] = ring[0]
      const [lx, ly] = ring[ring.length - 1]
      if (fx !== lx || fy !== ly) ring.push([fx, fy])
      rings.push(ring)
    }
    if (!rings.length) continue
    const parts = rings.length > 1 ? polygonClipping.xor(...rings.map((r) => [r])) : [rings]
    for (const poly of parts) out.push({ bbox: bboxOfPolygon(poly), poly, area: multiPolygonArea([poly]) })
  }
  return out
}

const bboxOfPolygon = (poly) => bboxOfRings(poly)

/**
 * A boolean op that survives its own arithmetic.
 *
 * `polygon-clipping` is a sweep-line over exact predicates, and on inputs with
 * many nearly-coincident points — which is exactly what "two hand-drawn extents
 * that were meant to share a frontier, both already cut against the same
 * coastline" produces — it can lose a segment out of its own tree and throw
 * ("Unable to find segment #… in SweepLine tree"). It is not our geometry that
 * is wrong; it is a tie the predicates cannot break.
 *
 * The standard answer, and the one here: snap the inputs to a coarser grid and
 * run it again. Each rung removes a decimal place of the coincidence that
 * caused the tie. The coarsest rung, 1e-6°, is 11 cm — four decimal places
 * below what `land-50m.json` can assert — so a result that needed it is not a
 * different answer, it is the same answer rounded past anything visible.
 */
const SNAP_LADDER = [0, 1e-9, 1e-8, 1e-7, 1e-6]

const snapGeom = (geom, q) =>
  q === 0 ? geom : geom.map((poly) => poly.map((ring) => ring.map(([x, y]) => [Math.round(x / q) * q, Math.round(y / q) * q])))

export function robustOp(op, a, b, label = '') {
  let last
  for (const q of SNAP_LADDER) {
    try {
      return polygonClipping[op](snapGeom(a, q), snapGeom(b, q))
    } catch (err) {
      last = err
    }
  }
  throw new Error(`${op} failed at every snap level${label ? ` (${label})` : ''}: ${last.message}`)
}

export function bboxOfRings(rings) {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const ring of rings)
    for (const [x, y] of ring) {
      if (x < w) w = x
      if (x > e) e = x
      if (y < s) s = y
      if (y > n) n = y
    }
  return [w, s, e, n]
}

const boxesMiss = (a, b) => a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]

/* ------------------------------------------------------------- the clipping */

/** An authored keyframe's open CW rings as a MultiPolygon, unioned. */
export function multiPolygonOf(rings) {
  const closed = rings.map((r) => [[...r.map((p) => [p[0], p[1]]), [r[0][0], r[0][1]]]])
  return closed.length === 1 ? closed : polygonClipping.union(...closed)
}

/** Signed planar area of one closed ring: negative is clockwise. */
export function signedArea(ring) {
  let s = 0
  for (let i = 0; i + 1 < ring.length; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  return s / 2
}

/** Area of a MultiPolygon with holes subtracted. Always >= 0 for valid input. */
export function multiPolygonArea(mp) {
  let a = 0
  for (const poly of mp)
    for (let i = 0; i < poly.length; i++) a += (i === 0 ? 1 : -1) * Math.abs(signedArea(poly[i]))
  return a
}

/**
 * WHEN AN ISLAND IS HELD WHOLE — the threshold, and why there is one at all.
 *
 * Clipping fixes an extent that overshoots into the sea. It cannot fix one that
 * UNDERSHOOTS, and the authored extents undershoot constantly, because they are
 * thirty-point polygons drawn around a coastline that has ten thousand: Japan's
 * 1880 ring runs inside the shore of Honshu for most of its length, so the
 * intersection's boundary is 43% the author's line and only 57% the coast. Ink
 * only the non-coastal edges of that and Japan gets a "frontier" scribbled
 * across its own islands, which is a worse defect than the one being fixed.
 *
 * The reading that resolves it is that an authored extent is a claim about
 * WHICH LAND a polity holds, not a survey of where its beaches are. So for each
 * separate piece of land the extent touches, one question: all of it, or part
 * of it? Cover four fifths of an island and you hold the island.
 *
 * The number is measured, not chosen. Over the whole corpus the deliberately
 * partial holdings top out at 0.76 — Roman Britain at 0.63 (Hadrian's Wall),
 * Greek Sicily at 0.64 against Punic Sicily's 0.47, British New Guinea at 0.76
 * — and the extents that plainly mean the whole island start at 0.81 (Sakhalin)
 * and run to 0.99. Nothing in the corpus lands between them.
 *
 * It cannot swallow a continent by accident, and that is structural rather than
 * lucky: Afro-Eurasia is ONE piece of land, so Iberia, Anatolia and Korea are
 * never candidates. Only real islands are.
 */
export const ISLAND_ABSORB = 0.8

/**
 * A polity keyframe intersected with the land near it, piece by piece.
 *
 * Per piece rather than against one big MultiPolygon because the absorption
 * question is per piece — and because the pieces are disjoint, so the results
 * concatenate into a valid MultiPolygon without a union.
 */
export function clipToLand(mp, land, absorb = ISLAND_ABSORB) {
  const bb = bboxOfRings(mp.flat())
  const out = []
  for (const piece of land) {
    if (boxesMiss(piece.bbox, bb)) continue
    const part = robustOp('intersection', mp, [piece.poly], 'clip to land')
    if (!part.length) continue
    if (absorb > 0 && multiPolygonArea(part) >= absorb * piece.area) out.push(piece.poly)
    else out.push(...part)
  }
  return out
}

/* -------------------------------------------------- coastal classification */

/**
 * A grid over the land's boundary SEGMENTS, so "is this edge the coast?" is a
 * dozen distance tests rather than sixty thousand.
 *
 * Cell size is a degree: coarse enough that the index is small, fine enough
 * that a cell holds a handful of segments even in the Norwegian fjords.
 */
export function coastIndex(land, cell = 1) {
  const grid = new Map()
  const key = (ix, iy) => ix * 100000 + iy
  const add = (ix, iy, seg) => {
    const k = key(ix, iy)
    let list = grid.get(k)
    if (!list) grid.set(k, (list = []))
    list.push(seg)
  }
  for (const piece of land)
    for (const ring of piece.poly)
      for (let i = 0; i + 1 < ring.length; i++) {
        const seg = [ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]]
        const x0 = Math.floor(Math.min(seg[0], seg[2]) / cell)
        const x1 = Math.floor(Math.max(seg[0], seg[2]) / cell)
        const y0 = Math.floor(Math.min(seg[1], seg[3]) / cell)
        const y1 = Math.floor(Math.max(seg[1], seg[3]) / cell)
        for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) add(ix, iy, seg)
      }
  return { grid, cell }
}

/** Squared distance from a point to a segment, in degrees². */
function distSqToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const qx = ax + t * dx
  const qy = ay + t * dy
  return (px - qx) * (px - qx) + (py - qy) * (py - qy)
}

/**
 * How close to a land segment a point has to be to count as ON the coast.
 *
 * A hundredth of the land's own quantum. `land-50m.json` is quantised at 1e5,
 * i.e. 0.0036° of longitude — 400 m — so nothing in the data can assert a
 * position finer than that, and every coastal vertex in a clip result either IS
 * a land vertex or is an intersection point exactly on a land segment. The
 * tolerance is therefore only ever absorbing the clipper's own rounding, and it
 * is set two orders of magnitude below the quantum so that a hand-drawn
 * frontier which happens to run *along* a coast is still recognised as a
 * frontier: at 4 m, "on the coast" means the arithmetic put it there.
 */
export const COAST_TOL_DEG = 3.6e-5

export function onCoast(index, x, y, tol = COAST_TOL_DEG) {
  const ix = Math.floor(x / index.cell)
  const iy = Math.floor(y / index.cell)
  const tol2 = tol * tol
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      const list = index.grid.get((ix + dx) * 100000 + (iy + dy))
      if (!list) continue
      for (const s of list) if (distSqToSegment(x, y, s[0], s[1], s[2], s[3]) <= tol2) return true
    }
  return false
}

/**
 * Which edges of a clipped ring are the COAST rather than a frontier.
 *
 * Flag `i` is about the edge LEAVING vertex `i` — the same convention
 * `Shape.seam` uses in lib/drawnGeometry.ts, and for the same reason: an edge
 * is a property of a step, not of a point, and the ring is stored open-ish
 * (closed by a repeated last vertex) so the step from the last real vertex is
 * the closing one.
 *
 * The test is on both ends AND the midpoint. Ends alone is not enough: a
 * frontier that starts and finishes on the shore — an isthmus cut, or the two
 * ends of a river mouth — has both its ends on the coast and none of it in
 * between.
 */
export function classifyCoastal(ring, index, tol = COAST_TOL_DEG) {
  const n = ring.length - 1
  const flags = new Array(n).fill(0)
  const at = new Array(n)
  for (let i = 0; i < n; i++) at[i] = onCoast(index, ring[i][0], ring[i][1], tol)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    if (!at[i] || !at[j]) continue
    const mx = (ring[i][0] + ring[j][0]) / 2
    const my = (ring[i][1] + ring[j][1]) / 2
    flags[i] = onCoast(index, mx, my, tol) ? 1 : 0
  }
  return flags
}

/* ------------------------------------------------------- run-length coding */

/**
 * Flags to alternating run lengths, starting with INLAND.
 *
 * A clipped island is one run of a thousand coastal edges; an empire is a
 * handful of runs. Written out per vertex the flags are a third of the file;
 * as runs they are a rounding error, and the decoder is six lines
 * (`coastalRuns` in lib/nations.ts).
 */
export function encodeRuns(flags) {
  const runs = []
  let want = 0
  let i = 0
  while (i < flags.length) {
    let n = 0
    while (i + n < flags.length && flags[i + n] === want) n++
    runs.push(n)
    i += n
    want = want ? 0 : 1
  }
  // A ring that is entirely inland is the common case and codes as nothing.
  if (runs.length === 1) return []
  return runs
}

/* ----------------------------------------------------------- simplification */

/** Douglas–Peucker over an open polyline, keeping both ends. */
export function simplifyRun(pts, tol) {
  if (pts.length < 3) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  const tol2 = tol * tol
  while (stack.length) {
    const [a, b] = stack.pop()
    let far = -1
    let best = tol2
    for (let i = a + 1; i < b; i++) {
      const d = distSqToSegment(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1])
      if (d > best) {
        best = d
        far = i
      }
    }
    if (far < 0) continue
    keep[far] = 1
    stack.push([a, far], [far, b])
  }
  const out = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  return out
}

/**
 * Thin the COASTAL runs of a ring and leave the frontier alone.
 *
 * The asymmetry is the whole point. A sea edge is 50 m coastline the drawn map
 * re-inks over the top of the fill, so the fill only has to MEET it; an inland
 * edge is the authored frontier, is what the reader is actually being shown,
 * and is already as sparse as its author made it. Run boundaries are kept, so
 * the flags survive the thinning unchanged in shape.
 */
export function simplifyRing(ring, flags, tol) {
  if (!tol || !flags.some((f) => f)) return { ring, flags }
  const n = flags.length
  const out = []
  const outFlags = []
  let i = 0
  while (i < n) {
    const f = flags[i]
    let j = i
    while (j < n && flags[j] === f) j++
    const run = ring.slice(i, j + 1)
    const thinned = f ? simplifyRun(run, tol) : run
    for (let k = 0; k < thinned.length - 1; k++) {
      out.push(thinned[k])
      outFlags.push(f)
    }
    i = j
  }
  if (!out.length) return { ring, flags }
  out.push([out[0][0], out[0][1]])
  return { ring: out, flags: outFlags }
}

/* --------------------------------------------------------------- winding */

/** Clockwise (negative shoelace) for an outer ring, counter-clockwise for a hole. */
export function orient(ring, clockwise) {
  const cw = signedArea(ring) < 0
  return cw === clockwise ? ring : ring.slice().reverse()
}

/* ----------------------------------------------------------- the validator */

/** The keyframe in force at t — the same hold-first rule as lib/nations.ts. */
export const keyframeAt = (nation, t) => {
  if (t < nation.from || t > nation.to || !nation.keyframes.length) return undefined
  let cur = nation.keyframes[0]
  for (const k of nation.keyframes) {
    if (k.time > t) break
    cur = k
  }
  return cur
}

/** Drawn at t: existing AND inside the curated notability window. */
export const isNotableAt = (n, t) =>
  t >= n.from && t <= n.to && t >= n.visibleFrom && t <= n.visibleTo

/**
 * How much two concurrent polities may share before it is a bug.
 *
 * As a share of the SMALLER polygon, because the absolute area of a sliver
 * along a two-thousand-kilometre frontier and the absolute area of a province
 * are the same number when one of the polities is Phoenicia. Half a percent is
 * about a one-cell-wide seam down the longest frontier in the corpus; a genuine
 * double claim — a province, a peninsula, a whole successor state — is one to
 * two orders of magnitude above it.
 */
export const OVERLAP_EPSILON = 0.005

/**
 * Every year at which either polity's geometry or notability could change,
 * inside the window where both are drawn. Geometry is piecewise constant in
 * time, so testing the breakpoints is not sampling: it is exhaustive.
 */
function breakpoints(a, b) {
  const lo = Math.max(a.from, b.from, a.visibleFrom, b.visibleFrom)
  const hi = Math.min(a.to, b.to, a.visibleTo, b.visibleTo)
  if (lo > hi) return []
  const ts = new Set([lo])
  for (const k of a.keyframes) if (k.time > lo && k.time <= hi) ts.add(k.time)
  for (const k of b.keyframes) if (k.time > lo && k.time <= hi) ts.add(k.time)
  return [...ts].sort((x, y) => x - y)
}

/**
 * Pairwise overlap over the whole corpus, at every year the answer can change.
 *
 * `geometryOf(nation, keyframe)` returns a MultiPolygon; it is a parameter
 * because the validator runs against three different things — the authored
 * rings, the clipped output, and a synthetic pair in a test — and none of them
 * should have to be written to disk first.
 */
export function findOverlaps(nations, geometryOf, epsilon = OVERLAP_EPSILON) {
  const areaCache = new Map()
  const areaOf = (n, k, g) => {
    const key = `${n.id}@${k.time}`
    let a = areaCache.get(key)
    if (a === undefined) areaCache.set(key, (a = multiPolygonArea(g)))
    return a
  }
  const bboxCache = new Map()
  const boxOf = (n, k, g) => {
    const key = `${n.id}@${k.time}`
    let b = bboxCache.get(key)
    if (b === undefined) bboxCache.set(key, (b = bboxOfRings(g.flat())))
    return b
  }
  const out = []
  for (let i = 0; i < nations.length; i++)
    for (let j = i + 1; j < nations.length; j++) {
      const a = nations[i]
      const b = nations[j]
      let worst
      let years = 0
      const ts = breakpoints(a, b)
      for (let s = 0; s < ts.length; s++) {
        const t = ts[s]
        const end = s + 1 < ts.length ? ts[s + 1] - 1 : Math.min(a.to, b.to, a.visibleTo, b.visibleTo)
        if (!isNotableAt(a, t) || !isNotableAt(b, t)) continue
        const ka = keyframeAt(a, t)
        const kb = keyframeAt(b, t)
        if (!ka || !kb) continue
        const ga = geometryOf(a, ka)
        const gb = geometryOf(b, kb)
        if (!ga.length || !gb.length) continue
        if (boxesMiss(boxOf(a, ka, ga), boxOf(b, kb, gb))) continue
        const inter = robustOp('intersection', ga, gb, `${a.id} x ${b.id} @ ${t}`)
        if (!inter.length) continue
        const area = multiPolygonArea(inter)
        const share = area / Math.min(areaOf(a, ka, ga), areaOf(b, kb, gb))
        if (share <= epsilon) continue
        years += end - t + 1
        if (!worst || share > worst.share)
          worst = { from: t, to: end, share, area, bbox: bboxOfRings(inter.flat()) }
      }
      if (worst) out.push({ a: a.id, b: b.id, years, ...worst })
    }
  return out.sort((x, y) => y.share - x.share)
}

/** One conviction as the build prints it. */
export const describeOverlap = (o) =>
  `${o.a} × ${o.b}: ${(o.share * 100).toFixed(1)}% of the smaller polygon ` +
  `(${o.area.toFixed(2)} sq°) over ${o.years} year(s), worst ${o.from}..${o.to}`

export { polygonClipping }
