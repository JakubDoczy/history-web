import { describe, it, expect } from 'vitest'
// The build library, untyped for the same reason nations-clip-lib is: it is a
// node script beside the other data scripts, and a second copy of it in src/
// would be two answers to one question.
// @ts-expect-error - .mjs build script, no declarations
import * as modern from '../scripts/modern-borders-lib.mjs'
// @ts-expect-error - .mjs build script, no declarations
import * as clip from '../scripts/nations-clip-lib.mjs'
import {
  isModernYear,
  modernBorderEntries,
  modernDatedGroups,
  modernGeneration,
  MODERN_FROM,
  MODERN_SOURCE,
  MODERN_TO,
} from '../src/lib/modernBorders'
import { decodeRing, encodeRing, QUANTUM, type Ring } from '../src/lib/nations'
import { frontierInkPlan, MODERN_BORDER, COASTAL_INK } from '../src/lib/present/ink'
import payload from '../src/data/borders.modern.json'

const data = payload as unknown as {
  source: string
  from: number
  to: number
  stats: { vertices: number; pairs: number; droppedEdges: number }
  dated: { from: number; pair: string; why: string; lines: number[][] }[]
  lines: number[][]
}

const everyLine = () => [...data.lines, ...data.dated.flatMap((d) => d.lines)]

/**
 * THE TOPOLOGY READING — a frontier is an arc two countries share.
 *
 * This is the whole reason the modern set needs no difference operator, no
 * overlap validator and no frontier rules: the source stores the boundary
 * between two countries ONCE, and everything downstream is bookkeeping over
 * that fact. These are the small shapes that prove the bookkeeping.
 */
describe('frontierArcs', () => {
  /** A topology in the shape world-atlas ships: two countries sharing arc 1. */
  const topo = {
    type: 'Topology',
    transform: { scale: [1, 1], translate: [0, 0] },
    // arc 0: the west coast; arc 1: the shared frontier; arc 2: the east coast
    arcs: [
      [[0, 0], [0, 10]],
      [[5, 10], [0, -10]],
      [[5, 0], [0, 10]],
    ],
    objects: {
      countries: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Polygon', arcs: [[0, 1]], properties: { name: 'West' } },
          { type: 'Polygon', arcs: [[2, ~1]], properties: { name: 'East' } },
        ],
      },
    },
  }

  it('keeps the arc two countries share and drops the coast', () => {
    const found = modern.frontierArcs(topo)
    expect(found).toHaveLength(1)
    expect([found[0].a, found[0].b]).toEqual(['East', 'West'])
    expect(found[0].points).toEqual([[5, 10], [5, 0]])
  })

  it('names the frontier the same way whichever country references it first', () => {
    const flipped = {
      ...topo,
      objects: {
        countries: {
          ...topo.objects.countries,
          geometries: [...topo.objects.countries.geometries].reverse(),
        },
      },
    }
    expect(modern.frontierArcs(flipped)[0].key).toBe(modern.frontierArcs(topo)[0].key)
  })

  it('refuses a topology where one arc belongs to three countries', () => {
    const three = {
      ...topo,
      objects: {
        countries: {
          ...topo.objects.countries,
          geometries: [
            ...topo.objects.countries.geometries,
            { type: 'Polygon', arcs: [[1]], properties: { name: 'Third' } },
          ],
        },
      },
    }
    expect(() => modern.frontierArcs(three)).toThrow(/shared by 3 countries/)
  })
})

/**
 * A frontier that ends at the sea ends ON the coastline, and the drawn map inks
 * that line itself. Same rule, same tolerance, same reason as the polity
 * corpus — see COASTAL_INK.
 */
describe('splitOffCoast', () => {
  // a strip of land whose north shore is y=0, indexed by the very function the
  // polity pipeline indexes Natural Earth with
  const coasts = clip.coastIndex([
    { bbox: [0, -5, 10, 0], poly: [[[0, 0], [10, 0], [10, -5], [0, -5], [0, 0]]] },
  ])

  it('cuts the run that lies along the shore out of a frontier', () => {
    const line: Ring = [[1, 5], [2, 0], [5, 0], [6, 5]]
    const { lines, dropped } = modern.splitOffCoast(line, coasts, 1e-3)
    expect(dropped).toBe(1)
    expect(lines).toEqual([[[1, 5], [2, 0]], [[5, 0], [6, 5]]])
  })

  it('keeps a frontier that only touches the sea at each end', () => {
    const line: Ring = [[2, 0], [4, 5], [6, 0]]
    const { lines, dropped } = modern.splitOffCoast(line, coasts, 1e-3)
    expect(dropped).toBe(0)
    expect(lines).toEqual([line])
  })
})

/**
 * THE HONESTY THRESHOLD, as arithmetic. `MERGES` is the patch set that buys the
 * years from 1992 to 2011, and the whole of a patch is "do not draw this line
 * yet" — see the library for why that is all a merge has to be when the payload
 * is frontiers rather than fills.
 */
describe('the threshold and its patch set', () => {
  it('starts in 1992, the first full year after the Soviet dissolution', () => {
    expect(MODERN_FROM).toBe(1992)
    expect(modern.MODERN_FROM).toBe(MODERN_FROM)
    expect(MODERN_TO).toBe(modern.MODERN_TO)
    expect(isModernYear(1991)).toBe(false)
    expect(isModernYear(1992)).toBe(true)
    expect(isModernYear(MODERN_TO + 1)).toBe(false)
  })

  it('dates every patch inside the window, with the reason written down', () => {
    for (const m of modern.MERGES) {
      expect(m.from).toBeGreaterThan(MODERN_FROM - 1)
      expect(m.from).toBeLessThanOrEqual(2011)
      expect(m.pair).toHaveLength(2)
      expect(m.why.length).toBeGreaterThan(40)
    }
    // the last one is South Sudan, which is why 2011 is the other threshold
    expect(Math.max(...modern.MERGES.map((m: { from: number }) => m.from))).toBe(2011)
  })

  it('ships exactly the patch set the library names', () => {
    expect(modernDatedGroups().map((d) => `${d.pair}@${d.from}`).sort()).toEqual(
      modern.MERGES.map((m: { pair: string[]; from: number }) => `${[...m.pair].sort().join(' | ')}@${m.from}`).sort(),
    )
  })

  it('draws no line at all before the threshold, and everything after 2011', () => {
    expect(modernBorderEntries(1991)).toEqual([])
    expect(modernGeneration(1991)).toBe(-1)
    expect(modernGeneration(1992)).toBe(0)
    expect(modernGeneration(2011)).toBe(modern.MERGES.length)
    expect(modernGeneration(2024)).toBe(modern.MERGES.length)
  })

  it('adds each frontier in the year it became one, and never removes one', () => {
    const count = (t: number) => modernBorderEntries(t)[0]?.frontier.length ?? 0
    const years = [1992, 1993, 2002, 2006, 2008, 2011]
    const counts = years.map(count)
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1])
    // and nothing moves in a year where nothing happened
    expect(count(1994)).toBe(count(2001))
    expect(count(2012)).toBe(count(2024))
  })

  it('holds Sudan whole until 2011 and splits it after', () => {
    const sudan = data.dated.find((d) => d.pair.includes('Sudan'))!
    expect(sudan.from).toBe(2011)
    const at = (t: number) => modernBorderEntries(t)[0].frontier.length
    expect(at(2011) - at(2010)).toBe(sudan.lines.length)
  })
})

/**
 * The payload. It is generated, committed and imported into the bundle, so what
 * a test can still catch is a codec that lost a decimal place and a build that
 * shipped a different file than the one the library describes.
 */
describe('borders.modern.json', () => {
  it('says where it came from', () => {
    expect(MODERN_SOURCE).toMatch(/Natural Earth/)
    expect(MODERN_SOURCE).toMatch(/world-atlas/)
    expect(MODERN_SOURCE).toBe(data.source)
  })

  it('round-trips every line through the delta codec inside the quantum', () => {
    for (const enc of everyLine()) {
      const ring = decodeRing(enc)
      const again = decodeRing(encodeRing(ring))
      expect(again).toHaveLength(ring.length)
      for (const [i, [x, y]] of ring.entries()) {
        expect(Math.abs(again[i][0] - x)).toBeLessThan(QUANTUM)
        expect(Math.abs(again[i][1] - y)).toBeLessThan(QUANTUM)
      }
    }
  })

  it('is polylines on the planet, never a point and never a ring', () => {
    let vertices = 0
    for (const enc of everyLine()) {
      const line = decodeRing(enc)
      vertices += line.length
      expect(line.length).toBeGreaterThanOrEqual(2)
      for (const [x, y] of line) {
        expect(Math.abs(x)).toBeLessThanOrEqual(180)
        expect(Math.abs(y)).toBeLessThanOrEqual(90)
      }
    }
    expect(vertices).toBe(data.stats.vertices)
  })

  /**
   * A frontier that closes on itself is an ENCLAVE — the Vatican, San Marino,
   * Lesotho, the Fergana valley's tangle — and there are twelve of them. It is
   * worth pinning because the other way to produce a closed line is to have
   * walked a country's whole outline, coast and all, which is the one mistake
   * this extraction must not make.
   */
  it('closes a line only around an enclave', () => {
    const closed = everyLine()
      .map(decodeRing)
      .filter((l) => l[0][0] === l[l.length - 1][0] && l[0][1] === l[l.length - 1][1])
    expect(closed.length).toBeLessThanOrEqual(12)
    for (const l of closed) {
      const lngs = l.map((p) => p[0])
      const lats = l.map((p) => p[1])
      // Lesotho is the biggest of them, at 2.4° across
      expect(Math.max(...lngs) - Math.min(...lngs)).toBeLessThan(3)
      expect(Math.max(...lats) - Math.min(...lats)).toBeLessThan(3)
    }
  })

  /**
   * ONE FRONTIER, ONE LINE — the modern set's version of `findInkDisagreements`,
   * and it is an equality rather than a tolerance because a shared arc is the
   * same numbers on both sides. If the extraction ever started walking country
   * outlines instead of arcs, every land border in the world would be in here
   * twice and this is what would say so.
   */
  it('draws no edge twice', () => {
    const seen = new Set<string>()
    const twice: string[] = []
    for (const enc of everyLine()) {
      const line = decodeRing(enc)
      for (let i = 0; i + 1 < line.length; i++) {
        const q = (p: number[]) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`
        const [a, b] = [q(line[i]), q(line[i + 1])]
        const k = a < b ? `${a}|${b}` : `${b}|${a}`
        if (seen.has(k)) twice.push(k)
        seen.add(k)
      }
    }
    expect(twice).toEqual([])
  })

  /**
   * CLIP INTEGRITY, cheaply. The heavy claim — that a country cut against
   * `land-50m.json` loses nothing — is measured in the build, against the
   * decoded land (`clip-nations.mjs`, twelve sampled countries, 100.000%). What
   * a unit test can add is the consequence: these lines are LAND frontiers, so
   * none of them may wander into the open ocean, and the set has to cover the
   * continents rather than one corner of one of them.
   */
  it('is land frontier, spread over the world', () => {
    const pts = everyLine().flatMap((enc) => decodeRing(enc))
    const lngs = pts.map((p) => p[0])
    const lats = pts.map((p) => p[1])
    expect(Math.min(...lngs)).toBeLessThan(-140) // Alaska/Yukon
    expect(Math.max(...lngs)).toBeGreaterThan(140) // Papua
    expect(Math.min(...lats)).toBeLessThan(-50) // Tierra del Fuego
    expect(Math.max(...lats)).toBeGreaterThan(69) // the Norwegian/Russian north
    expect(data.stats.pairs).toBeGreaterThan(280)
  })

  it('has no edge long enough to sag under the globe undensified', () => {
    // The layer densifies onto great circles (BORDER_SEGMENT_DEG), so this is
    // not a correctness gate — it is the check that the source is a walk in
    // small steps, i.e. that the delta codec is the right one for it.
    let longest = 0
    for (const enc of everyLine()) {
      const line = decodeRing(enc)
      for (let i = 0; i + 1 < line.length; i++)
        longest = Math.max(longest, Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]))
    }
    expect(longest).toBeLessThan(12)
  })
})

/**
 * WHO INKS A SHARED BORDER when the modern layer is on. The historical corpus
 * still draws the United States, China and India at 2000, with hand-authored
 * frontiers hundreds of kilometres off the surveyed ones; two pens on one border
 * is the defect the whole rework exists to remove, so the crude one steps aside.
 */
describe('frontierInkPlan', () => {
  const entry = (id: string, color = '#b05c4a') =>
    ({ nation: { id, color }, kind: 'full', ring: [], coordinates: [], label: '', frontier: [], coast: [] }) as never

  it('inks a polity’s frontier when the modern set is not on the globe', () => {
    const plan = frontierInkPlan([], { mode: 'schematic' })
    expect(plan.inkOf(entry('rome'))).toBe('frontier')
    expect(frontierInkPlan([], { mode: 'realistic' }).inkOf(entry('rome'))).toBe('all')
  })

  it('takes the polity’s frontier away in the years the modern set covers', () => {
    const m = modernBorderEntries(2000)
    expect(m).toHaveLength(1)
    expect(frontierInkPlan(m, { mode: 'schematic' }).inkOf(entry('usa'))).toBe('none')
    // …but not its shore on the photograph, where nothing else draws one
    expect(frontierInkPlan(m, { mode: 'realistic' }).inkOf(entry('usa'))).toBe('coast')
    expect(COASTAL_INK.realistic).toBe(true)
  })

  it('always draws the modern set itself, in a neutral quieter than a polity’s', () => {
    const m = modernBorderEntries(2000)
    for (const mode of ['schematic', 'realistic'] as const)
      expect(frontierInkPlan(m, { mode }).inkOf(m[0])).toBe('all')
    const plan = frontierInkPlan(m, { mode: 'schematic' })
    expect(plan.colorOf(m[0])).not.toBe(plan.colorOf(entry('usa')))
    expect(MODERN_BORDER.mix).toBeLessThan(0.45) // the mix a polity border gets
  })
})

/**
 * Identity across a tick, exactly as the polities have it (see `borderRings`):
 * the layer keys its rebuild on the entry list, and a year that changes nothing
 * has to hand back the objects it handed back last time.
 */
describe('modernBorderEntries', () => {
  it('returns the same objects while the generation holds', () => {
    const a = modernBorderEntries(2015)
    const b = modernBorderEntries(2020)
    expect(b).toBe(a)
    expect(b[0].frontier).toBe(a[0].frontier)
  })

  it('returns different objects once a frontier appears', () => {
    expect(modernBorderEntries(2010)).not.toBe(modernBorderEntries(2011))
    expect(modernBorderEntries(2010)[0].nation.id).not.toBe(modernBorderEntries(2011)[0].nation.id)
  })

  it('is one entry for the whole world, and not a polity', () => {
    const [e] = modernBorderEntries(2000)
    expect(e.frontier.length).toBeGreaterThan(300)
    // no keyframes: nothing in the nations layer can rank it, draw a cap for it
    // or hand it to `activeKeyframe`
    expect(e.nation.keyframes).toEqual([])
    expect(e.coordinates).toBe(e.frontier)
  })
})
