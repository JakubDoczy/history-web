import { describe, it, expect } from 'vitest'
// The resolver, untyped for the same reason `nations-clip-lib` and
// `modern-borders-lib` are: it is a node script beside the other data scripts,
// and a second copy of it under src/ that nothing at runtime would import is
// how two answers to one question get shipped.
// @ts-expect-error - .mjs build script, no declarations
import * as follows from '../scripts/follows-lib.mjs'
// @ts-expect-error - .mjs build script, no declarations
import * as clipLib from '../scripts/nations-clip-lib.mjs'
// @ts-expect-error - .mjs build script, no declarations
import { RIVERS, pickRivers } from '../scripts/vendor-rivers.mjs'
import riverFile from '../src/data/rivers-named.json'
import authored from '../src/data/nations.json'
import clipped from '../src/data/nations.clipped.json'
import { decodeKeyframe, type Nation } from '../src/lib/nations'

/**
 * BORDERS V3 — the resolver that turns "this frontier is the Danube" into the
 * Danube (docs/design/borders-v3.md, scripts/follows-lib.mjs).
 *
 * The shape of the tests follows the shape of the claim. Snapping, orienting,
 * splicing and the mainline choice are arithmetic and are tested on shapes
 * whose right answer can be worked out by hand; the corpus itself is walked for
 * the invariants only the corpus can break — that every declaration resolves,
 * that no declared endpoint is far from the feature it names, and that the
 * error report's arithmetic is the arithmetic it claims.
 */

type Pt = [number, number]

/** A straight polyline along a parallel, one degree a step. */
const eastward = (x0: number, x1: number, y: number): Pt[] => {
  const out: Pt[] = []
  for (let x = x0; x <= x1; x++) out.push([x, y])
  return out
}

describe('the metric', () => {
  it('measures great-circle kilometres, not degrees', () => {
    // a degree of latitude is 111.19 km anywhere; a degree of longitude is that
    // times the cosine, which is the whole reason snapping is not planar
    expect(follows.distKm([0, 0], [0, 1])).toBeCloseTo(111.19, 1)
    expect(follows.distKm([0, 60], [1, 60])).toBeCloseTo(55.6, 0)
    expect(follows.distKm([10, 10], [10, 10])).toBe(0)
  })

  it('adds a polyline up step by step', () => {
    expect(follows.lengthKm(eastward(0, 3, 0))).toBeCloseTo(3 * 111.19, 0)
  })
})

describe('the mainline: which of a river’s pieces are the river', () => {
  it('chains pieces that meet, whichever way round they are stored', () => {
    const a = eastward(0, 5, 0)
    const b = eastward(5, 12, 0).reverse() // stored mouth-first, as NE often does
    const m = follows.mainline([a, b])
    expect(m.line.length).toBe(13)
    expect(m.line[0]).toEqual([0, 0])
    expect(m.line[12]).toEqual([12, 0])
    expect(m.dropped).toEqual([])
  })

  it('takes the longest continuous path at a fork, and records what it dropped', () => {
    const trunk = eastward(0, 10, 0)
    const longBranch = eastward(10, 30, 0)
    const shortBranch = [
      [10, 0],
      [12, 4],
      [14, 8],
    ] as Pt[]
    const m = follows.mainline([trunk, shortBranch, longBranch])
    expect(m.line[m.line.length - 1]).toEqual([30, 0])
    expect(m.dropped.length).toBe(1)
    expect(m.dropped[0].points).toBe(3)
    expect(m.forks).toBe(1)
  })

  it('is exhaustive, not greedy — a long trunk behind a short first branch still wins', () => {
    // Walking greedily from [0,0] the first edge met is the 2° stub; the answer
    // is the 20° trunk on the other side of it.
    const stub = [
      [0, 0],
      [0, 2],
    ] as Pt[]
    const trunk = eastward(0, 20, 0)
    const m = follows.mainline([stub, trunk])
    expect(follows.lengthKm(m.line)).toBeGreaterThan(20 * 111 - 1)
  })

  it('bridges a seam narrower than the data’s own step, and says how wide it was', () => {
    // 129 m is the Ussuri's real seam in the vendored file; JOIN_TOL_KM is 1 km
    const a = eastward(0, 5, 0)
    const b = [[5.0012, 0], [6, 0], [7, 0]] as Pt[]
    const m = follows.mainline([a, b])
    expect(m.line.length).toBe(8)
    expect(m.joins.length).toBe(1)
    expect(m.joins[0]).toBeGreaterThan(0.1)
    expect(m.joins[0]).toBeLessThan(follows.JOIN_TOL_KM)
  })

  it('does not bridge a gap the data can resolve', () => {
    const a = eastward(0, 5, 0)
    const b = eastward(9, 20, 0) // 4° of clear water
    const m = follows.mainline([a, b])
    // the longer piece wins and the shorter is recorded, rather than a 440 km
    // straight line being invented between them
    expect(m.line[0]).toEqual([9, 0])
    expect(m.dropped.length).toBe(1)
  })

  it('holds the real rivers together: every declared river is one chain', () => {
    const rivers = follows.decodeRivers(riverFile)
    for (const [name, expected] of [
      ['Rhine', 1000],
      ['Danube', 2400],
      ['Amur', 2500],
      ['Ussuri', 700],
      ['Yalu', 600],
      ['Tumen', 400],
      ['Euphrates', 2400],
    ] as const) {
      const m = follows.mainline(rivers.get(name))
      expect(m.line.length, name).toBeGreaterThan(100)
      // NE files a river's reaches under the language of each country, so a
      // mainline this long is the alias table in vendor-rivers.mjs working
      expect(follows.lengthKm(m.line), name).toBeGreaterThan(expected)
    }
  })
})

describe('snapping and extraction', () => {
  const line = eastward(0, 10, 0)

  it('snaps to the nearest VERTEX and reports how far it went', () => {
    const s = follows.snapToLine([3.4, 0.2], line)
    expect(s.index).toBe(3)
    expect(s.km).toBeCloseTo(follows.distKm([3.4, 0.2], [3, 0]), 6)
  })

  it('takes the run between two indices, oriented the way it was asked for', () => {
    expect(follows.subPath(line, 2, 5)).toEqual([
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
    ])
    // …and reversed when the declaration runs the other way down the river
    expect(follows.subPath(line, 5, 2)).toEqual([
      [5, 0],
      [4, 0],
      [3, 0],
      [2, 0],
    ])
  })

  it('resolves a declaration into a path and two snap distances', () => {
    const r = follows.resolveOne(
      { river: 'Test', from: [2.1, 0.1], to: [6, 0] },
      { rivers: new Map([['Test', [line]]]) },
    )
    expect(r.name).toBe('Test')
    expect(r.path[0]).toEqual([2, 0])
    expect(r.path[r.path.length - 1]).toEqual([6, 0])
    expect(r.snapFromKm).toBeGreaterThan(0)
    expect(r.snapFromKm).toBeLessThan(20)
    expect(r.snapToKm).toBe(0)
  })

  it('refuses a declaration whose two ends are the same place on the feature', () => {
    expect(() =>
      follows.resolveOne({ river: 'Test', from: [2, 0], to: [2.01, 0] }, { rivers: new Map([['Test', [line]]]) }),
    ).toThrow(/same vertex/)
  })

  it('names the file to fix when a river is not vendored', () => {
    expect(() => follows.resolveOne({ river: 'Styx' }, { rivers: new Map() })).toThrow(/vendor-rivers/)
  })
})

describe('the splice', () => {
  // A square, clockwise and open, with a coarse northern edge to replace.
  const square = (): Pt[] => [
    [0, 0],
    [0, 10],
    [10, 10],
    [10, 0],
  ]
  // A wiggly "river" between the two northern corners.
  const river: Pt[] = [
    [0, 10],
    [2, 9],
    [4, 11],
    [6, 9],
    [8, 11],
    [10, 10],
  ]
  const features = { rivers: new Map([['Wiggle', [river]]]) }

  it('replaces the authored run and leaves the rest of the ring alone', () => {
    const { ring, segments } = follows.spliceFollows(
      square(),
      [{ river: 'Wiggle', from: [0, 10], to: [10, 10] }],
      features,
    )
    expect(segments.length).toBe(1)
    expect(segments[0].a).toBe(1)
    expect(segments[0].b).toBe(2)
    expect(ring.length).toBe(4 - 2 + river.length)
    expect(ring[0]).toEqual([0, 0])
    expect(ring[ring.length - 1]).toEqual([10, 0])
    expect(ring.slice(1, 1 + river.length)).toEqual(river)
  })

  it('orients the spliced run to the ring rather than to the river’s storage order', () => {
    // the same river, stored the other way round: the result must be identical
    const backwards = { rivers: new Map([['Wiggle', [[...river].reverse()]]]) }
    const a = follows.spliceFollows(square(), [{ river: 'Wiggle', from: [0, 10], to: [10, 10] }], features)
    const b = follows.spliceFollows(square(), [{ river: 'Wiggle', from: [0, 10], to: [10, 10] }], backwards)
    expect(b.ring).toEqual(a.ring)
  })

  it('keeps the ring closed and clockwise', () => {
    const before = square()
    const after = follows.spliceFollows(before, [{ river: 'Wiggle', from: [0, 10], to: [10, 10] }], features).ring
    const check = follows.checkSplice(before, after)
    expect(check.closed).toBe(true)
    expect(check.windingKept).toBe(true)
    // the closing edge is the one the ring never stored; it is the same edge it
    // was before the splice, because the splice did not touch that corner
    expect(check.closingKm).toBeCloseTo(follows.distKm(after[after.length - 1], after[0]), 9)
  })

  it('handles a run that wraps the open ring’s own seam', () => {
    // from the LAST authored vertex round to the first
    const west: Pt[] = [
      [10, 0],
      [5, -2],
      [0, 0],
    ]
    const wrap = { rivers: new Map([['South', [west]]]) }
    const { ring } = follows.spliceFollows(square(), [{ river: 'South', from: [10, 0], to: [0, 0] }], wrap)
    expect(ring.length).toBe(2 + west.length)
    // the southern edge is now the river, and the ring still closes onto it
    expect(ring).toContainEqual([5, -2])
  })

  it('lets two declarations meet at one authored vertex — the Yalu and the Tumen do', () => {
    const left: Pt[] = [
      [0, 10],
      [2, 12],
      [5, 10],
    ]
    const right: Pt[] = [
      [5, 10],
      [8, 12],
      [10, 10],
    ]
    const two = { rivers: new Map([['L', [left]], ['R', [right]]]) }
    const ring = [
      [0, 0],
      [0, 10],
      [5, 10],
      [10, 10],
      [10, 0],
    ] as Pt[]
    const out = follows.spliceFollows(
      ring,
      [
        { river: 'L', from: [0, 10], to: [5, 10] },
        { river: 'R', from: [5, 10], to: [10, 10] },
      ],
      two,
    )
    expect(out.segments.length).toBe(2)
    // the shared vertex appears once, not twice
    expect(out.ring.filter((p) => p[0] === 5 && p[1] === 10).length).toBe(1)
    expect(out.ring).toContainEqual([2, 12])
    expect(out.ring).toContainEqual([8, 12])
  })

  it('refuses two declarations that claim the same authored vertices', () => {
    const long: Pt[] = [
      [0, 10],
      [5, 12],
      [10, 10],
    ]
    const two = { rivers: new Map([['A', [long]], ['B', [long]]]) }
    const ring = [
      [0, 0],
      [0, 10],
      [5, 10],
      [10, 10],
      [10, 0],
    ] as Pt[]
    expect(() =>
      follows.spliceFollows(
        ring,
        [
          { river: 'A', from: [0, 10], to: [10, 10] },
          { river: 'B', from: [5, 10], to: [10, 10] },
        ],
        two,
      ),
    ).toThrow(/same authored vertices/)
  })

  it('puts a declaration on the piece it belongs to, without being told which', () => {
    const far: Pt[] = [
      [100, 10],
      [102, 12],
      [110, 10],
    ]
    const features2 = { rivers: new Map([['Far', [far]]]) }
    const rings = [square(), [[100, 0], [100, 10], [110, 10], [110, 0]] as Pt[]]
    const out = follows.resolveKeyframe(rings, [{ river: 'Far', from: [100, 10], to: [110, 10] }], features2)
    expect(out.rings[0]).toEqual(square()) // untouched
    expect(out.rings[1]).toContainEqual([102, 12])
  })
})

describe('the modern-line lookup', () => {
  const arcs = [
    { a: 'France', b: 'Spain', key: 'France | Spain', points: eastward(-2, 1, 43) },
    { a: 'Andorra', b: 'Spain', key: 'Andorra | Spain', points: eastward(1, 3, 43) },
    { a: 'Germany', b: 'Poland', key: 'Germany | Poland', points: eastward(14, 15, 52) },
  ]

  it('turns an ISO pair into the two names Natural Earth uses', () => {
    expect(follows.modernPair('FRA-ESP')).toEqual(['France', 'Spain'])
    // sorted, because that is how a shared arc's owners are keyed
    expect(follows.modernPair('ESP-FRA')).toEqual(['France', 'Spain'])
  })

  it('names the code it does not know', () => {
    expect(() => follows.modernPair('FRA-XYZ')).toThrow(/XYZ/)
    expect(() => follows.modernPair('FRA')).toThrow(/ISO pair/)
  })

  it('finds the arcs a pair shares, and says so when there are none', () => {
    expect(follows.modernLines(arcs, 'FRA-ESP').length).toBe(1)
    expect(() => follows.modernLines(arcs, 'DEU-FRA')).toThrow(/no shared arc/)
  })

  it('chains across a micro-state when the declaration names it', () => {
    // France and Spain share two arcs in the real topology because Andorra sits
    // between them; `+` says which side of it the frontier ran
    const lines = follows.modernLines(arcs, 'FRA-ESP + AND-ESP')
    expect(lines.length).toBe(2)
    const m = follows.mainline(lines)
    expect(m.line[0]).toEqual([-2, 43])
    expect(m.line[m.line.length - 1]).toEqual([3, 43])
    expect(m.dropped).toEqual([])
  })
})

describe('the error report', () => {
  it('counts an inland edge as declared only when it lies ON the declaration', () => {
    const declared = eastward(0, 10, 0)
    const index = follows.segmentIndex([declared])
    const ring = [
      ...declared,
      [10, -5],
      [0, -5],
    ] as Pt[]
    // every edge inland; the northern ten are the declaration, the rest is not
    const coastal = new Uint8Array(ring.length)
    const share = follows.declaredShare([{ ring, coastal }], index)
    expect(share.inlandKm).toBeGreaterThan(share.declaredKm)
    expect(share.declaredKm).toBeCloseTo(follows.lengthKm(declared), 3)
  })

  it('does not credit a freehand line that merely runs near a feature', () => {
    const index = follows.segmentIndex([eastward(0, 10, 0)])
    // a kilometre north: five quanta of the codec is 55 m, and this is not that
    const ring = [...eastward(0, 10, 0.01), [10, -5], [0, -5]] as Pt[]
    const share = follows.declaredShare([{ ring, coastal: new Uint8Array(ring.length) }], index)
    expect(share.declaredKm).toBe(0)
  })

  it('ignores coastal edges: they are the map’s line, not political ink', () => {
    const ring = eastward(0, 10, 0)
    const coastal = new Uint8Array(ring.length).fill(1)
    const share = follows.declaredShare([{ ring, coastal }], follows.segmentIndex([ring]))
    expect(share.inlandKm).toBe(0)
    expect(share.share).toBe(0)
  })

  it('totals the corpus by length and averages the snaps', () => {
    const table = follows.errorTable([
      { id: 'a', inlandKm: 100, declaredKm: 50, snaps: [1, 3] },
      { id: 'b', inlandKm: 300, declaredKm: 0, snaps: [] },
    ])
    expect(table.total.inlandKm).toBe(400)
    expect(table.total.declaredKm).toBe(50)
    expect(table.total.share).toBeCloseTo(0.125, 9)
    expect(table.total.meanSnapKm).toBe(2)
    // rows are ranked by how much geometry each polity actually derived
    expect(table.rows[0].id).toBe('a')
    expect(table.rows[0].share).toBeCloseTo(0.5, 9)
    expect(table.rows[1].share).toBe(0)
  })
})

describe('the vendored rivers', () => {
  it('is the allowlist and nothing else, at the codec’s quantum', () => {
    const file = riverFile as unknown as {
      quantum: number
      ref: string
      stats: { names: number; lines: number; vertices: number }
      rivers: Record<string, number[][]>
    }
    expect(file.quantum).toBe(1e-4)
    expect(file.ref).toMatch(/^v\d/)
    const names = Object.keys(file.rivers)
    expect(names.length).toBe(file.stats.names)
    for (const n of names) expect(RIVERS.some((r: { name: string }) => r.name === n), n).toBe(true)
    const lines = names.reduce((a, n) => a + file.rivers[n].length, 0)
    expect(lines).toBe(file.stats.lines)
    expect(names.reduce((a, n) => a + file.rivers[n].reduce((b, l) => b + l.length / 2, 0), 0)).toBe(
      file.stats.vertices,
    )
  })

  it('matches a reach by any of Natural Earth’s three names, or a checked alias', () => {
    const picked = pickRivers(
      {
        features: [
          { properties: { name: 'Donau', name_en: 'Danube' }, geometry: { type: 'LineString', coordinates: eastward(0, 3, 0) } },
          { properties: { name: 'Danube' }, geometry: { type: 'LineString', coordinates: eastward(3, 6, 0) } },
          { properties: { name: 'Rhin', name_alt: 'Rhein' }, geometry: { type: 'LineString', coordinates: eastward(0, 3, 1) } },
          { properties: { name: 'Loire' }, geometry: { type: 'LineString', coordinates: eastward(0, 3, 2) } },
        ],
      },
      [{ name: 'Danube' }, { name: 'Rhine', also: ['Rhin'] }],
    )
    expect(Object.keys(picked.rivers).sort()).toEqual(['Danube', 'Rhine'])
    expect(picked.rivers.Danube.length).toBe(2) // Donau matched on name_en
    expect(picked.rivers.Rhine.length).toBe(1) // Rhin matched on the alias
    expect(picked.missing).toEqual([])
  })
})

describe('the corpus', () => {
  const nations = authored.nations as unknown as {
    id: string
    keyframes: { time: number; rings?: [number, number][][]; countries?: string[]; follows?: Record<string, unknown>[] }[]
  }[]
  const declarations = nations.flatMap((n) =>
    n.keyframes.flatMap((k) => (k.follows ?? []).map((d) => ({ id: n.id, time: k.time, d }))),
  )

  it('declares something', () => {
    expect(declarations.length).toBeGreaterThan(30)
    // …on the frontiers a reader actually looks at
    const ids = new Set(declarations.map((x) => x.id))
    for (const want of ['rome', 'byzantium', 'usa', 'france', 'russia', 'joseon']) expect(ids.has(want)).toBe(true)
  })

  /**
   * ROUND 63 took the four modern-era polities past declaring their frontiers
   * to declaring their whole EXTENT: the Republic of India, the PRC, the United
   * States after 1900 and the USSR are unions of present-day states in the same
   * Natural Earth topology, so their fills and the modern-border ink are one
   * geometry rather than two opinions. The USSR left this list when it gained
   * one — the Amur and the Ussuri are still its border, they are just no longer
   * something a human has to declare.
   */
  it('declares four modern extents outright', () => {
    const extents = nations.flatMap((n) =>
      n.keyframes.filter((k) => k.countries).map((k) => ({ id: n.id, time: k.time, codes: k.countries! })),
    )
    expect(extents.map((e) => e.id).sort()).toEqual(['india', 'prc', 'ussr', 'usa'].sort())
    for (const e of extents) {
      expect(e.codes.length, `${e.id}@${e.time}`).toBeGreaterThan(0)
      for (const c of e.codes) expect(follows.ISO_A3[c as keyof typeof follows.ISO_A3], `${e.id} ${c}`).toBeTruthy()
    }
    // fifteen republics, and the union of them is the Soviet outline
    expect(extents.find((e) => e.id === 'ussr')!.codes).toHaveLength(15)
  })

  it('gives every declaration a river or a modern pair, two endpoints and a reason', () => {
    for (const { id, time, d } of declarations) {
      const what = `${id}@${time}`
      expect(d.river || d.modern || d.line, what).toBeTruthy()
      expect(Array.isArray(d.from), what).toBe(true)
      expect(Array.isArray(d.to), what).toBe(true)
      // the historian's judgement is the part a pipeline cannot supply
      expect(String(d.note ?? '').length, what).toBeGreaterThan(40)
    }
  })

  it('puts every declared endpoint on the feature it claims', () => {
    const rivers = follows.decodeRivers(riverFile)
    for (const { id, time, d } of declarations) {
      if (!d.river) continue
      const r = follows.resolveOne(d, { rivers })
      const what = `${id}@${time} ${d.river}`
      expect(r.snapFromKm, what).toBeLessThan(follows.SNAP_WARN_KM)
      expect(r.snapToKm, what).toBeLessThan(follows.SNAP_WARN_KM)
      expect(r.path.length, what).toBeGreaterThan(20)
    }
  })

  it('ships the derived geometry: a declared frontier is in the built file', () => {
    const rivers = follows.decodeRivers(riverFile)
    const built = clipped.nations as unknown as Nation[]
    // Joseon is the cleanest case in the corpus — a peninsula whose only inland
    // frontier is two declared rivers, so nearly all of its ink should be
    // recognised as derived.
    const joseon = nations.find((n) => n.id === 'joseon')!
    const kf = joseon.keyframes.find((k) => k.time === 1450)!
    const res = follows.resolveKeyframe(kf.rings, kf.follows, { rivers })
    const index = follows.segmentIndex(res.segments.map((s: { path: Pt[] }) => s.path))
    const shipped = built.find((n) => n.id === 'joseon')!.keyframes.find((k) => k.time === 1450)!
    const { pieces, coastal } = decodeKeyframe(shipped)
    const rings = pieces.flatMap((rs, p) => rs.map((ring, r) => ({ ring, coastal: coastal[p][r] })))
    const share = follows.declaredShare(rings, index)
    expect(share.inlandKm).toBeGreaterThan(500)
    expect(share.share).toBeGreaterThan(0.8)
  })
})

/**
 * ROUND 63 — an extent that IS the modern map (`countryExtent`,
 * `splitAntimeridian`). The unit under test is small and the failure it exists
 * to prevent was not: the first version of `countryExtent` unioned Natural
 * Earth's Russia without splitting it at 180°, a planar clipper read the
 * (179.87 → -180) step as a 360°-wide edge, and the USSR came out as a band
 * round the planet that held northern Alaska.
 */
describe('countryExtent', () => {
  /** A minimal country index: a name -> MultiPolygon map is all it wants. */
  const box = (x0: number, x1: number, y0 = 0, y1 = 1): number[][][][] => [
    [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
  ]
  // The clipper the build uses, reached through the library that owns the
  // dependency — `follows-lib` deliberately does not import one.
  const pc = clipLib.polygonClipping
  const ops = {
    union: (...mps: never[]) => pc.union(...mps),
    intersection: (a: never, b: never) => pc.intersection(a, b),
  }

  it('unions the states it names, dissolving the line between them', () => {
    const index = new Map([['France', box(0, 1)], ['Germany', box(1, 2)]])
    const mp = follows.countryExtent(['FRA', 'DEU'], index, ops)
    // one piece, and nothing of it at x = 1 except the two corners: the shared
    // edge is gone, which is what makes a merge a merge
    expect(mp).toHaveLength(1)
    const xs = (mp[0][0] as number[][]).map((p) => p[0])
    expect(Math.min(...xs)).toBe(0)
    expect(Math.max(...xs)).toBe(2)
  })

  it('names the code it cannot resolve', () => {
    const index = new Map([['France', box(0, 1)]])
    expect(() => follows.countryExtent(['XYZ'], index, ops)).toThrow(/XYZ/)
    expect(() => follows.countryExtent(['DEU'], index, ops)).toThrow(/Germany/)
    expect(() => follows.countryExtent([], index, ops)).toThrow(/at least one/)
  })

  it('cuts a ring that walks across the antimeridian into two pieces', () => {
    // Chukotka in miniature: 178 -> 179 -> -179 -> -178, one continuous walk
    const wrapped = [
      [
        [178, 60],
        [179, 60],
        [-179, 60],
        [-178, 60],
        [-178, 62],
        [179, 62],
        [178, 62],
        [178, 60],
      ],
    ]
    const out = follows.splitAntimeridian([wrapped], ops.intersection)
    expect(out.length).toBe(2)
    for (const poly of out)
      for (const ring of poly as number[][][])
        for (let i = 1; i < ring.length; i++) expect(Math.abs(ring[i][0] - ring[i - 1][0])).toBeLessThanOrEqual(180)
    // and the two halves are on opposite sides of the line
    const sides = (out as number[][][][]).map((p) => Math.sign(p[0][0][0]))
    expect(new Set(sides).size).toBe(2)
  })

  it('leaves a ring that does not cross the line exactly as it found it', () => {
    const plain = box(10, 20)
    expect(follows.splitAntimeridian(plain, ops.intersection)).toEqual(plain)
  })
})
