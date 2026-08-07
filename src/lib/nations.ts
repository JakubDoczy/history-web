import { formatYear, type Year } from './time'

/**
 * Historical polities as time-varying border polygons.
 *
 * TWO FILES, and the split is the whole design (scripts/clip-nations.mjs):
 *
 *   src/data/nations.json          AUTHORING. Hand-drawn extents: smooth inland
 *                                  frontiers, approximate coastlines, open CW
 *                                  rings. Nothing at runtime reads it.
 *   src/data/nations.clipped.json  WHAT THIS MODULE READS. Every extent
 *                                  intersected with the same
 *                                  `public/data/map/land-50m.json` the drawn
 *                                  map renders, frontiers between concurrent
 *                                  polities subtracted so each is one agreed
 *                                  line, and every edge classified as COAST or
 *                                  FRONTIER.
 *
 * The point of clipping at build time is that agreement with the coastline is
 * then a fact about the arithmetic rather than a thing an author has to keep
 * getting right: a fill cannot jut into the sea, because the sea was subtracted
 * from it by the same geometry the sea is drawn from.
 *
 * PER POLITY:
 *
 *   id            stable key
 *   name          display name
 *   color         six-digit hex; the globe layer appends an alpha to it
 *   from, to      existence span (astronomical years, 1 BCE = 0)
 *   visibleFrom,  the *notability* window — when this polity is worth drawing.
 *   visibleTo     Independent of existence: the Abbasids lasted to 1258 but stop
 *                 being one of the world's headline powers around 1000, and Kush
 *                 only becomes interesting a couple of centuries after it forms.
 *                 The windows are curated so that any instant shows 3-8 polities,
 *                 and so that a succession is not a co-reign — Sumer is not drawn
 *                 in the year Akkad conquered it.
 *   keyframes     [{ time, polys, coast }] sorted by time.
 *
 * Borders hold: the keyframe in force at t is the last one at or before t, and
 * the first keyframe also holds *backwards* to the start of existence, so a
 * polity is never drawn borderless during its own lifetime.
 */

/**
 * Ring in GeoJSON order: [lng, lat]. Left open — the renderer closes it.
 *
 * Wound CLOCKWISE (negative shoelace) when it is a piece's OUTER ring. On a
 * sphere a ring encloses two regions, and the globe's polygon layer fills the
 * one clockwise winding bounds; a counter-clockwise ring paints the whole
 * planet *except* the nation, which is exactly how an early dataset managed to
 * look so wrong. A HOLE is the same rule inverted, so holes are wound
 * counter-clockwise — there is exactly one in the corpus, the Caspian inside
 * the Mongol Empire, and it is the reason a piece is a list of rings at all.
 */
export type Ring = [number, number][]

/** One connected piece of a polity: outer ring first, holes after. */
export type Piece = Ring[]

/**
 * The wire format: a ring as DELTA-CODED INTEGERS at `QUANTUM` degrees.
 *
 * Clipping to a 50 m coastline is what it costs — the corpus goes from 16 554
 * authored vertices to 93 166 — and written as decimal pairs that is 1.9 MB of
 * JSON in the bundle against the 239 kB the authored file was. The same numbers
 * as integer deltas are 870 kB, and compress to about 205 kB, because a
 * coastline is a walk in small steps and a small step is two or three
 * characters. It is the same trick, for the same reason, as the quantised
 * TopoJSON the drawn map's own vectors arrive in (lib/drawnGeometry.ts).
 *
 * `QUANTUM` is 1e-4°, about 11 m — one and a half decimal places finer than
 * `land-50m.json`'s own 0.0036° quantisation, so it is not a second
 * simplification, it is a lossless-enough integer view of the first.
 */
export type EncodedRing = number[]
export const QUANTUM = 1e-4

/**
 * Run-length coding of "the edge LEAVING vertex i is the COAST", inland first.
 *
 * The convention — a flag is about the edge leaving a vertex, and at the last
 * vertex it is the closing edge — is `Shape.seam`'s in lib/drawnGeometry.ts,
 * and it is the same kind of fact: an edge that is there because of where the
 * *land* is rather than because of where a border was drawn. A coastal edge is
 * NOT inked by the nations layer, because the drawn map already inks that line
 * and a second pen over it doubles the stroke and makes every disagreement
 * visible. Only the inland frontier gets political ink.
 *
 * An all-inland ring codes as `[]`, which is most of them.
 */
export type CoastRuns = number[]

export interface NationKeyframe {
  time: Year
  /** Pieces, each a list of encoded rings: outer first, holes after. */
  polys: EncodedRing[][]
  /** Per piece, per ring, the coastal runs. Absent means nothing here is coast. */
  coast?: CoastRuns[][]
}

export interface Nation {
  id: string
  name: string
  color: string // hex like '#b05c4a'
  from: Year
  to: Year
  visibleFrom: Year
  visibleTo: Year
  keyframes: NationKeyframe[]
}

/* ------------------------------------------------------------- the codec */

/** Absolute degrees back out of the deltas. */
export function decodeRing(enc: EncodedRing): Ring {
  const out: Ring = []
  let x = 0
  let y = 0
  for (let i = 0; i < enc.length; i += 2) {
    x += enc[i]
    y += enc[i + 1]
    out.push([x * QUANTUM, y * QUANTUM])
  }
  return out
}

/** …and into them. Used by the build script and by the tests' fixtures. */
export function encodeRing(ring: Ring): EncodedRing {
  const out: EncodedRing = []
  let x = 0
  let y = 0
  for (const [lng, lat] of ring) {
    const ix = Math.round(lng / QUANTUM)
    const iy = Math.round(lat / QUANTUM)
    out.push(ix - x, iy - y)
    x = ix
    y = iy
  }
  return out
}

/** Coastal runs back to one flag per edge. */
export function decodeRuns(runs: CoastRuns, edges: number): Uint8Array {
  const out = new Uint8Array(edges)
  let at = 0
  let coastal = 0
  for (const n of runs) {
    if (coastal) out.fill(1, at, Math.min(at + n, edges))
    at += n
    coastal = coastal ? 0 : 1
  }
  return out
}

/**
 * A keyframe decoded once and kept — the dataset is static, so this is a
 * constant, and it is a constant the GPU path reads on every timeline tick.
 *
 * Decoding is deferred rather than done at load for the reason the JSON is
 * bundled rather than fetched: the store is synchronous and the first frame is
 * a budget. 93 166 vertices is a few milliseconds to walk, and the reader only
 * ever looks at the handful of keyframes their era contains.
 */
export interface DecodedKeyframe {
  pieces: Piece[]
  /** Per piece, per ring: one flag per EDGE. See CoastRuns. */
  coastal: Uint8Array[][]
}

const decodeCache = new WeakMap<NationKeyframe, DecodedKeyframe>()

export function decodeKeyframe(k: NationKeyframe): DecodedKeyframe {
  let d = decodeCache.get(k)
  if (!d) {
    const pieces = k.polys.map((rings) => rings.map(decodeRing))
    const coastal = pieces.map((rings, p) =>
      rings.map((ring, r) => decodeRuns(k.coast?.[p]?.[r] ?? [], ring.length)),
    )
    decodeCache.set(k, (d = { pieces, coastal }))
  }
  return d
}

/** Hard ceiling on simultaneous polities; the data aims well below it. */
export const MAX_VISIBLE = 10

/** True while the polity exists *and* is one of the period's notable powers. */
export const isNotable = (n: Nation, t: Year): boolean =>
  t >= n.from && t <= n.to && t >= n.visibleFrom && t <= n.visibleTo

/** Borders in force at t (hold-first, hold-last), or undefined outside existence. */
export function activeKeyframe(n: Nation, t: Year): NationKeyframe | undefined {
  if (t < n.from || t > n.to || !n.keyframes.length) return undefined
  let cur = n.keyframes[0]
  for (const k of n.keyframes) {
    if (k.time > t) break
    cur = k
  }
  return cur
}

/** Planar shoelace, signed: negative means clockwise, the winding the renderer fills. */
export const signedRingArea = (ring: Ring): number =>
  ring.reduce((sum, [x, y], i) => {
    const [nx, ny] = ring[(i + 1) % ring.length]
    return sum + x * ny - nx * y
  }, 0) / 2

/** Planar shoelace area — an approximation, used only to rank extents. */
export const ringArea = (ring: Ring): number => Math.abs(signedRingArea(ring))

/**
 * Total planar extent of a keyframe, memoised on the keyframe object.
 *
 * The dataset is static, so a keyframe's area is a constant — and the shoelace
 * runs over every vertex of every ring, which for the British Empire at 1900 is
 * a few thousand points. It used to be evaluated from inside a sort comparator,
 * i.e. O(n log n) times per timeline tick, at 60 ticks a second while the
 * timeline is being dragged.
 */
const areaCache = new WeakMap<NationKeyframe, number>()
export const keyframeArea = (k: NationKeyframe): number => {
  let a = areaCache.get(k)
  if (a === undefined) {
    // Holes come off: the Mongol Empire's extent is not the Caspian's as well.
    a = decodeKeyframe(k).pieces.reduce(
      (sum, rings) => sum + rings.reduce((s, r, i) => s + (i ? -1 : 1) * ringArea(r), 0),
      0,
    )
    areaCache.set(k, a)
  }
  return a
}

/**
 * The polities to draw at t: notable ones, largest first, capped. The cap is a
 * backstop for bad data — curation is what actually keeps the globe legible.
 *
 * The keyframe lookup and its area are computed once per nation rather than
 * once per comparison: a comparator is the one place where a `find` over the
 * keyframes and a shoelace over a few thousand vertices are multiplied by
 * log n and paid again on the very next tick.
 */
export function visibleNations(nations: Nation[], t: Year, limit = MAX_VISIBLE): Nation[] {
  const ranked: { nation: Nation; area: number }[] = []
  for (const nation of nations) {
    if (!isNotable(nation, t)) continue
    const k = activeKeyframe(nation, t)
    if (k) ranked.push({ nation, area: keyframeArea(k) })
  }
  return ranked
    .sort((a, b) => b.area - a.area)
    .slice(0, limit)
    .map((r) => r.nation)
}

/**
 * One drawable border ring, with an identity that outlives a timeline tick.
 *
 * The globe's polygon layer joins its data by object identity, stamps a random
 * id on anything it has not seen, and rebuilds the whole three.js object —
 * group, two meshes, three materials — for every id it does not recognise. It
 * then re-tessellates the cap whenever the coordinate array is a different
 * *array* than last time, even if the numbers in it are identical. Rebuilding
 * these objects per tick therefore cost 25 object recreations, 75 material
 * disposals and ~14 ms of re-tessellation per tick — for borders that had not
 * moved, because borders only move when the keyframe changes.
 *
 * So they are memoised on exactly what they depend on: the polity, the keyframe
 * in force, and which ring of it. The cache is bounded by the dataset (a couple
 * of keyframes per polity) and the data is static, so nothing is ever evicted.
 */
export interface BorderRing {
  nation: Nation
  /** Only one kind of border is drawn; the field keeps the globe's
   * polygon-entry union discriminated against event areas. */
  kind: 'full'
  /** The piece's outer ring. What the frontier ink and the tests read. */
  ring: Ring
  /** GeoJSON Polygon `coordinates`: outer then holes, each closed. Identity is the point. */
  coordinates: Ring[]
  /** What the globe shows on hover: name plus the polity's span. */
  label: string
  /**
   * The polylines of this piece that are NOT the coast, ready to be inked.
   *
   * A clipped polity's boundary is two different kinds of line wearing one
   * outline. The sea edges came from `land-50m.json` and the drawn map inks
   * them itself, with an eleven-pixel shoreline wash on top; inking them again
   * in the polity's colour draws a second, slightly different coastline over
   * the first, which is the "coastlines do not match" the reader reported even
   * once the geometry agrees. The inland edges are the frontier — the thing the
   * layer exists to show — and they are all that is stroked.
   *
   * Empty for an island: Java under the Dutch has no land frontier, and the
   * fill is what says who holds it.
   */
  frontier: Ring[]
}

const ringCache = new Map<string, BorderRing[]>()

/**
 * The inland runs of one ring, as open polylines.
 *
 * A run wraps the ring's end, so the walk starts after the first coastal edge
 * where there is one — otherwise a frontier that happens to straddle vertex 0
 * comes out as two lines with a gap between them at an arbitrary place.
 */
export function frontierRuns(ring: Ring, coastal: Uint8Array): Ring[] {
  const n = ring.length
  if (!n) return []
  let first = -1
  for (let i = 0; i < n; i++)
    if (coastal[i]) {
      first = i
      break
    }
  if (first < 0) return [[...ring, ring[0]]] // no coast at all: the whole ring
  const out: Ring[] = []
  let cur: Ring = []
  for (let s = 1; s <= n; s++) {
    const i = (first + s) % n
    if (coastal[i]) {
      // The run already ends at ring[i]: the previous inland edge pushed its own
      // far end, which is this edge's near end. Pushing it again duplicates the
      // last vertex and draws a zero-length segment.
      if (cur.length) {
        out.push(cur)
        cur = []
      }
      continue
    }
    if (!cur.length) cur.push(ring[i])
    cur.push(ring[(i + 1) % n])
  }
  if (cur.length > 1) out.push(cur)
  return out.filter((r) => r.length > 1)
}

/** The border rings in force at t, as objects stable across ticks. */
export function borderRings(n: Nation, t: Year): BorderRing[] {
  const k = activeKeyframe(n, t)
  if (!k) return []
  const key = `${n.id}@${k.time}`
  let entries = ringCache.get(key)
  if (!entries) {
    const label = nationLabel(n)
    const { pieces, coastal } = decodeKeyframe(k)
    entries = pieces.map((rings, p) => ({
      nation: n,
      kind: 'full' as const,
      ring: rings[0],
      // the renderer wants closed rings; the data is stored open
      coordinates: rings.map((r) => [...r, r[0]] as Ring),
      label,
      frontier: rings.flatMap((r, i) => frontierRuns(r, coastal[p][i])),
    }))
    ringCache.set(key, entries)
  }
  return entries
}

/** "Roman Empire (509 BCE – 476)" — polygon labels carry the span, not the keyframe. */
export const nationLabel = (n: Nation): string =>
  `${n.name} (${formatYear(n.from)} – ${formatYear(n.to)})`


