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

/** The shipped corpus, typed once for every describe that walks it. */
const nationsCorpus = rawNations as unknown as Nation[]

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
    // A hairline is what the ARITHMETIC leaves behind, so it is the size of the
    // numbers: the corpus stores coordinates at 1e-4 deg and its widest
    // surviving seam is 5.5 m. Round 52 wrote this test at 0.01 deg — 1.1 km,
    // a hundred times the quantum and legible at any close zoom — because the
    // share-of-the-smaller test it was written against could not tell the
    // difference. The width test can, so the fixture is a real seam now.
    const a = polity('alpha', 100, 300, [square(0, 0, 10)])
    const b = polity('beta', 100, 300, [square(9.9999, 0, 10)])
    expect(clip.findOverlaps([a, b], geometryOf)).toEqual([])
  })

  /**
   * ROUND 55. The share-of-the-smaller test is what let Alsace-Lorraine ship:
   * these two pairs share exactly the same AREA, and the eye calls one of them
   * a province and the other nothing at all. Only width tells them apart.
   */
  it('separates a sliver from a province by width, not by area or share', () => {
    // 0.01 sq degrees, one codec quantum wide and a hundred degrees long: the
    // seam two hand-drawn frontiers leave when the arithmetic rounds.
    const seamA = polity('alpha', 100, 300, [square(0, 0, 100, 10)])
    const seamB = polity('beta', 100, 300, [square(0, 9.9999, 100, 10)])
    // 0.01 sq degrees, 0.1 by 0.1: a piece of ground, small but a piece.
    const blockA = polity('gamma', 100, 300, [square(0, 0, 10)])
    const blockB = polity('delta', 100, 300, [square(9.9, 9.9, 10)])
    const seam = clip.findOverlaps([seamA, seamB], geometryOf, 0)
    const block = clip.findOverlaps([blockA, blockB], geometryOf, 0)
    expect(seam[0].area).toBeCloseTo(block[0].area, 6)
    expect(seam[0].width).toBeCloseTo(1e-4, 6)
    expect(block[0].width).toBeCloseTo(0.05, 4)
    // …and at the shipped threshold the seam is forgiven and the block is not.
    expect(clip.findOverlaps([seamA, seamB], geometryOf)).toEqual([])
    expect(clip.findOverlaps([blockA, blockB], geometryOf)).toHaveLength(1)
  })

  it('convicts a province-sized claim however large the polity holding it is', () => {
    // The Alsace shape: a 0.2 deg band shared down the length of two polities
    // 60 deg across. 12 sq deg of double claim, and still only 0.33% of either
    // — under the old epsilon, which is exactly how Alsace-Lorraine shipped.
    const big = polity('alpha', 100, 300, [square(0, 0, 60)])
    const other = polity('beta', 100, 300, [square(59.8, 0, 60)])
    const found = clip.findOverlaps([big, other], geometryOf)
    expect(found).toHaveLength(1)
    expect(found[0].share).toBeLessThan(clip.OVERLAP_EPSILON)
    expect(found[0].width).toBeGreaterThan(clip.OVERLAP_WIDTH_DEG)
    expect(clip.describeOverlap(found[0])).toContain('km wide')
  })

  it('measures the width of a strip as its width', () => {
    // 2A/P for a 100 x 0.4 strip: 2*40/200.8 = 0.398, the width to within 0.5%.
    expect(clip.overlapWidth([[square(0, 0, 100, 0.4)]])).toBeCloseTo(0.398, 3)
    expect(clip.multiPolygonPerimeter([[square(0, 0, 3, 4)]])).toBeCloseTo(14, 6)
    expect(clip.overlapWidth([])).toBe(0)
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

/**
 * ONE FRONTIER, ONE VERDICT. The reader's second complaint was a border line
 * that is inked here and gone a hand's width along, and a shared frontier
 * classified two ways is one arithmetic that would produce it: the yielding
 * polity gets the keeper's own line, so the two store the SAME numbers, and
 * nothing else in the build notices if they disagree about what those numbers
 * are.
 */
describe('findInkDisagreements', () => {
  const shared: Ring = [
    [0, 0],
    [0, 5],
    [5, 5],
    [5, 0],
  ]
  const polity = (id: string) => ({
    id,
    from: 0,
    to: 100,
    visibleFrom: 0,
    visibleTo: 100,
    keyframes: [{ time: 0 }],
  })
  const rings = (coastal: number[]) => () => [{ ring: shared, coastal: Uint8Array.from(coastal) }]

  it('is silent when both sides call the shared edge the same thing', () => {
    const both = rings([1, 0, 0, 0])
    expect(clip.findInkDisagreements([polity('a'), polity('b')], both)).toEqual([])
  })

  it('names the polities, the year and the place when they disagree', () => {
    const verdicts = new Map([
      ['a', rings([1, 0, 0, 0])],
      ['b', rings([0, 0, 0, 0])],
    ])
    const found = clip.findInkDisagreements(
      [polity('a'), polity('b')],
      (n: { id: string }, k: unknown) => verdicts.get(n.id)!(n, k),
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ a: 'a', b: 'b', year: 0 })
    expect(found[0].at).toEqual([0, 0])
  })

  it('does not compare a polity with itself, whichever way the edge is stored', () => {
    // The same edge walked backwards is the same edge: the key is direction-free.
    const reversed = () => [{ ring: [...shared].reverse() as Ring, coastal: Uint8Array.from([0, 0, 1, 0]) }]
    const verdicts = new Map([
      ['a', rings([1, 0, 0, 0])],
      ['b', reversed],
    ])
    const found = clip.findInkDisagreements(
      [polity('a'), polity('b')],
      (n: { id: string }, k: unknown) => verdicts.get(n.id)!(n, k),
    )
    // a's edge 0 is [0,0]->[0,5]; walked backwards that is b's edge 2, and it
    // carries the same flag, so there is nothing to report.
    expect(found).toEqual([])
  })

  it('ships a corpus in which no shared frontier is inked by only one side', () => {
    const found = clip.findInkDisagreements(nationsCorpus, (_n: unknown, k: unknown) => {
      const { pieces, coastal } = decodeKeyframe(k as never)
      return pieces.flatMap((rs, p) => rs.map((ring, r) => ({ ring, coastal: coastal[p][r] })))
    })
    expect(found).toEqual([])
  }, 30_000)
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
