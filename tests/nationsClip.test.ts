import { describe, it, expect } from 'vitest'
// The build step's own library. Untyped on purpose: it is a node script beside
// the other data scripts (scripts/clip-nations.mjs is the CLI around it), and
// the alternative — a second copy of the geometry in src/ that nothing at
// runtime would import — is how two answers to one question get shipped.
// @ts-expect-error - .mjs build script, no declarations
import * as clip from '../scripts/nations-clip-lib.mjs'
import {
  decodeKeyframe,
  decodeRing,
  decodeRuns,
  encodeRing,
  frontierRuns,
  signedRingArea,
  type Nation,
  type Ring,
} from '../src/lib/nations'
import rawNations from '../src/data/nations.clipped.json'

/**
 * THE BUILD STEP, tested where it is cheap to test it.
 *
 * The pipeline itself runs against 550 kB of Natural Earth and takes fifteen
 * seconds, which is a build's business and not a test suite's. What is here
 * instead is the arithmetic it is made of, on shapes small enough to compute
 * the right answer by hand — plus a walk over the shipped corpus for the
 * invariants that only the corpus can break.
 */

/** A closed CW square, the winding the data ships in. */
const square = (x: number, y: number, w: number, h = w): number[][] => [
  [x, y],
  [x, y + h],
  [x + w, y + h],
  [x + w, y],
  [x, y],
]

/** One land polygon in the shape `landPolygons` produces. */
const landPiece = (ring: number[][]) => ({ bbox: clip.bboxOfRings([ring]), poly: [ring] })

describe('clipToLand', () => {
  const island = landPiece(square(0, 0, 10))

  it('keeps only the part of an extent that is on land', () => {
    // an empire drawn from the middle of the island out into the sea
    const empire = [[square(5, 5, 10)]]
    const out = clip.clipToLand(empire, [island])
    expect(clip.multiPolygonArea(out)).toBeCloseTo(25, 6)
  })

  it('conserves area when the extent is already inland', () => {
    const inland = [[square(2, 2, 3)]]
    const out = clip.clipToLand(inland, [island])
    expect(clip.multiPolygonArea(out)).toBeCloseTo(9, 9)
  })

  it('breaks an empire the sea cuts in two into islands', () => {
    const west = landPiece(square(0, 0, 4))
    const east = landPiece(square(6, 0, 4))
    const empire = [[square(0, 0, 10, 4)]]
    const out = clip.clipToLand(empire, [west, east])
    expect(out).toHaveLength(2)
    expect(clip.multiPolygonArea(out)).toBeCloseTo(32, 6)
  })

  it('reads a ring split at the seam as two pieces, not as a piece with a hole', () => {
    // `splitAtSeam` cuts Afro-Eurasia into two rings inside ONE shape, and a
    // shape's rings carry no outer/hole distinction — the rasterizer fills them
    // with evenodd. Handed straight to the clipper, ring 1 would be a hole in
    // ring 0 and every polity in the Old World would clip to nothing.
    const layer = {
      shapes: [
        {
          // two disjoint pieces of one "shape", exactly what a seam split leaves
          pts: Float64Array.from([
            ...[-180, 0, -180, 10, -170, 10, -170, 0],
            ...[170, 0, 170, 10, 180, 10, 180, 0],
          ]),
          rings: Uint32Array.from([0, 4, 8]),
          bbox: [-180, 0, 180, 10] as [number, number, number, number],
          seam: Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1]),
        },
      ],
    }
    const pieces = clip.landPolygons(layer)
    expect(pieces).toHaveLength(2)
    const total = pieces.reduce(
      (a: number, p: { poly: number[][][] }) => a + clip.multiPolygonArea([p.poly]),
      0,
    )
    expect(total).toBeCloseTo(200, 6)
    // and a polity on the western piece survives the clip
    const polity = [[square(-178, 2, 4)]]
    expect(clip.multiPolygonArea(clip.clipToLand(polity, pieces))).toBeCloseTo(16, 6)
  })
})

describe('coastal classification', () => {
  const coastRing = square(0, 0, 10)
  const index = clip.coastIndex([landPiece(coastRing)])

  it('marks the edges that came from the land and not the ones that did not', () => {
    // a polity covering the western half of the island: three of its edges are
    // the island's own shore, the fourth is the frontier down the middle
    const clipped = clip.clipToLand([[square(-5, -5, 10, 20)]], [landPiece(coastRing)])
    expect(clipped).toHaveLength(1)
    const ring = clipped[0][0]
    const flags = clip.classifyCoastal(ring, index)
    expect(flags.length).toBe(ring.length - 1)
    const coastal = flags.filter((f: number) => f).length
    expect(coastal).toBeGreaterThan(0)
    expect(coastal).toBeLessThan(flags.length) // the frontier is not coast
    // every coastal edge's midpoint really is on the island's boundary
    for (let i = 0; i < flags.length; i++) {
      if (!flags[i]) continue
      const mx = (ring[i][0] + ring[i + 1][0]) / 2
      const my = (ring[i][1] + ring[i + 1][1]) / 2
      expect(clip.onCoast(index, mx, my)).toBe(true)
    }
  })

  it('does not call an inland frontier coastal just because its ends touch the shore', () => {
    // the frontier runs from shore to shore across the island; both ENDPOINTS
    // are on the coast and none of the line between them is
    const flags = clip.classifyCoastal([[5, 0], [5, 10], [6, 10], [6, 0], [5, 0]], index)
    expect(flags[0]).toBe(0) // up the middle
    expect(flags[2]).toBe(0) // and back down
  })

  it('codes runs and decodes them back to the same flags', () => {
    const flags = [0, 0, 1, 1, 1, 0, 1]
    const runs = clip.encodeRuns(flags)
    expect(runs).toEqual([2, 3, 1, 1])
    expect([...decodeRuns(runs, flags.length)]).toEqual(flags)
    // an all-inland ring is the common case and costs nothing
    expect(clip.encodeRuns([0, 0, 0])).toEqual([])
    expect([...decodeRuns([], 3)]).toEqual([0, 0, 0])
  })
})

describe('winding and the codec', () => {
  it('orients an outer ring clockwise and a hole counter-clockwise', () => {
    const ccw: number[][] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]
    expect(clip.signedArea(clip.orient(ccw, true))).toBeLessThan(0)
    expect(clip.signedArea(clip.orient(ccw, false))).toBeGreaterThan(0)
    // already correct: the same array back, not a copy
    const cw = clip.orient(ccw, true)
    expect(clip.orient(cw, true)).toBe(cw)
  })

  it('round-trips a ring through the delta codec inside the quantum', () => {
    const ring: Ring = [[12.3456, -4.5678], [12.4, -4.6], [12.5, -4.5]]
    const back = decodeRing(encodeRing(ring))
    for (const [i, [lng, lat]] of ring.entries()) {
      expect(back[i][0]).toBeCloseTo(lng, 4)
      expect(back[i][1]).toBeCloseTo(lat, 4)
    }
  })
})

describe('sea-edge simplification', () => {
  it('thins a coastal run and leaves the frontier vertices alone', () => {
    // a ring whose first three edges are a wiggly coast and whose last is a
    // straight inland frontier
    const ring: number[][] = [[0, 0], [1, 0.0001], [2, 0], [2, 2], [0, 2], [0, 0]]
    const flags = [1, 1, 0, 0, 0]
    const out = clip.simplifyRing(ring, flags, 0.01)
    expect(out.ring.length).toBeLessThan(ring.length)
    // the frontier corners survive
    expect(out.ring).toContainEqual([2, 2])
    expect(out.ring).toContainEqual([0, 2])
    // and the flags still describe the ring they came back with
    expect(out.flags.length).toBe(out.ring.length - 1)
  })

  it('is a no-op on a ring with no coast at all', () => {
    const ring: number[][] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]
    const out = clip.simplifyRing(ring, [0, 0, 0, 0], 0.1)
    expect(out.ring).toBe(ring)
  })
})

describe('the overlap validator', () => {
  const polity = (
    id: string,
    from: number,
    to: number,
    rings: number[][][],
  ): Record<string, unknown> => ({
    id,
    name: id,
    from,
    to,
    visibleFrom: from,
    visibleTo: to,
    keyframes: [{ time: from, rings }],
  })
  const geometryOf = (_n: unknown, k: { rings: number[][][] }) => k.rings.map((r) => [r])

  it('convicts a region-scale double claim and names the years', () => {
    const a = polity('alpha', 100, 300, [square(0, 0, 10)])
    const b = polity('beta', 200, 400, [square(5, 0, 10)])
    const found = clip.findOverlaps([a, b], geometryOf)
    expect(found).toHaveLength(1)
    expect(found[0].a).toBe('alpha')
    expect(found[0].b).toBe('beta')
    expect(found[0].share).toBeCloseTo(0.5, 6) // half of either
    expect(found[0].from).toBe(200)
    expect(found[0].to).toBe(300)
    expect(clip.describeOverlap(found[0])).toContain('alpha × beta')
  })

  it('forgives a hairline down a shared frontier', () => {
    const a = polity('alpha', 100, 300, [square(0, 0, 10)])
    const b = polity('beta', 100, 300, [square(9.99, 0, 10)])
    expect(clip.findOverlaps([a, b], geometryOf)).toEqual([])
  })

  it('does not convict polities that are never on the globe together', () => {
    const a = polity('alpha', 100, 199, [square(0, 0, 10)])
    const b = polity('beta', 200, 300, [square(0, 0, 10)]) // identical ground
    expect(clip.findOverlaps([a, b], geometryOf)).toEqual([])
  })

  it('tests the year a keyframe changes, not just the first year of the window', () => {
    const a = polity('alpha', 100, 300, [square(0, 0, 1)])
    // beta is elsewhere to begin with and moves onto alpha at 200
    const b = {
      ...polity('beta', 100, 300, [square(50, 50, 10)]),
      keyframes: [
        { time: 100, rings: [square(50, 50, 10)] },
        { time: 200, rings: [square(0, 0, 10)] },
      ],
    }
    const found = clip.findOverlaps([a, b], geometryOf)
    expect(found).toHaveLength(1)
    expect(found[0].from).toBe(200)
  })
})

/**
 * …and the corpus itself. These are the invariants that make the shipped file
 * safe to hand to the polygon layer, and each has a specific way of failing
 * silently: a counter-clockwise outer ring paints the whole planet except the
 * nation, a hole wound the same way as its outer punches nothing, and a coast
 * run longer than its ring would ink edges that do not exist.
 */
describe('nations.clipped.json', () => {
  const nations = rawNations as unknown as Nation[]

  it('is the same polities as the authoring file', () => {
    expect(nations.length).toBe(73)
    expect(new Set(nations.map((n) => n.id)).size).toBe(nations.length)
  })

  it.each(nations.map((n) => [n.id, n] as const))('%s is wound for the cap', (_id, n) => {
    for (const k of n.keyframes) {
      const { pieces } = decodeKeyframe(k)
      expect(pieces.length).toBeGreaterThan(0)
      for (const rings of pieces) {
        expect(signedRingArea(rings[0])).toBeLessThan(0) // outer: clockwise
        for (const hole of rings.slice(1)) expect(signedRingArea(hole)).toBeGreaterThan(0)
      }
    }
  })

  it.each(nations.map((n) => [n.id, n] as const))('%s has coast runs that fit', (_id, n) => {
    for (const k of n.keyframes) {
      const { pieces, coastal } = decodeKeyframe(k)
      for (const [p, rings] of pieces.entries())
        for (const [r, ring] of rings.entries()) {
          expect(coastal[p][r].length).toBe(ring.length)
          const runs = k.coast?.[p]?.[r] ?? []
          expect(runs.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(ring.length)
          for (const [lng, lat] of ring) {
            expect(Math.abs(lng)).toBeLessThanOrEqual(180)
            expect(Math.abs(lat)).toBeLessThanOrEqual(90)
          }
        }
    }
  })

  it('leaves most of the corpus uninked, because most of it is coastline', () => {
    let coast = 0
    let inland = 0
    for (const n of nations)
      for (const k of n.keyframes)
        for (const rings of decodeKeyframe(k).coastal)
          for (const flags of rings)
            for (const f of flags) f ? coast++ : inland++
    expect(coast).toBeGreaterThan(inland * 2)
  })

  it('gives an island polity a fill and no frontier ink', () => {
    // Japan in 1890 is four pieces of coastline and not one metre of land
    // border: if the coastal edges were inked, this would be the whole outline;
    // if the fill were invisible, Japan would not be on the map at all.
    const japan = nations.find((n) => n.id === 'japan')!
    const k = japan.keyframes[0]
    const { pieces, coastal } = decodeKeyframe(k)
    const frontier = pieces.flatMap((rings, p) =>
      rings.flatMap((r, i) => frontierRuns(r, coastal[p][i])),
    )
    expect(pieces.length).toBeGreaterThan(1)
    expect(frontier).toEqual([])
  })

  /**
   * THE GATE. `scripts/clip-nations.mjs --check` runs the same function and
   * `npm run build` runs that, so this exists for the reason every gate is in
   * more than one place: the build is what stops a bad file being deployed, and
   * the test suite is what stops one being committed. Two seconds over 73
   * polities and every year at which either of a pair can change.
   */
  it('ships no two concurrent polities claiming the same ground', () => {
    const geometryOf = (_n: unknown, k: unknown) =>
      decodeKeyframe(k as never).pieces.map((rings) => rings.map((r) => [...r, r[0]]))
    const found = clip.findOverlaps(nations, geometryOf)
    expect(found.map(clip.describeOverlap)).toEqual([])
  }, 30_000)

  it('gives a continental polity frontier ink on the land side', () => {
    const france = nations.find((n) => n.id === 'france')!
    const k = france.keyframes[0]
    const { pieces, coastal } = decodeKeyframe(k)
    const frontier = pieces.flatMap((rings, p) =>
      rings.flatMap((r, i) => frontierRuns(r, coastal[p][i])),
    )
    expect(frontier.length).toBeGreaterThan(0)
    expect(frontier.every((run) => run.length >= 2)).toBe(true)
  })
})

describe('frontierRuns', () => {
  it('returns the whole closed ring when nothing is coast', () => {
    const ring: Ring = [[0, 0], [1, 0], [1, 1]]
    const runs = frontierRuns(ring, new Uint8Array([0, 0, 0]))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toHaveLength(4) // closed
  })

  it('returns nothing when it is all coast', () => {
    const ring: Ring = [[0, 0], [1, 0], [1, 1]]
    expect(frontierRuns(ring, new Uint8Array([1, 1, 1]))).toEqual([])
  })

  it('joins a run that wraps the ring start into one line', () => {
    // edges: 0 inland, 1 coast, 2 inland, 3 inland — the last two and the first
    // are one frontier that happens to straddle vertex 0
    const ring: Ring = [[0, 0], [1, 0], [1, 1], [0, 1]]
    const runs = frontierRuns(ring, new Uint8Array([0, 1, 0, 0]))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toEqual([[1, 1], [0, 1], [0, 0], [1, 0]])
  })
})
