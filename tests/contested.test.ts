import { describe, it, expect } from 'vitest'
import { Scene } from 'three'
import polygonClipping from 'polygon-clipping'
import {
  ABUT_TOL_KM,
  MODERN_CLAIMANTS,
  areaKm2,
  gapBetweenKm,
  resolveClaimant,
  ringAreaKm2,
  zoneFaults,
  // @ts-expect-error — a build script, deliberately untyped JS
} from '../scripts/contested-lib.mjs'
import {
  contestedLabel,
  contestedRings,
  hatchColors,
  isContestedAt,
  type ContestedZone,
} from '../src/lib/contested'
import { HATCH_NEUTRAL, HATCH_PERIOD_DEG, hatchMaterial, hatchTone } from '../src/lib/hatch'
import { DASH_DEG, FrontierLayer, GAP_DEG } from '../src/lib/frontierLayer'
import { CONTESTED, frontierInkPlan } from '../src/lib/present'
import { encodeRing, type InkEntry, type Nation, type Ring } from '../src/lib/nations'
import authoredFile from '../src/data/nations.json'
import clippedFile from '../src/data/nations.clipped.json'

/**
 * CONTESTED TERRITORY, round 60 — docs/design/contested-territory.md.
 *
 * The shape of what is tested here follows the shape of the feature: a build
 * half that decides who may claim what and carves it out of them, a runtime
 * half that decides what colour the hatch is and where the dashes go, and the
 * shipped corpus, which is the only place the two meet.
 */

const zones = (clippedFile as unknown as { contested: ContestedZone[] }).contested
const authoredZones = (authoredFile as unknown as { contested: Record<string, unknown>[] }).contested
const nations = (clippedFile as unknown as { nations: Nation[] }).nations

/** A square, clockwise (the winding the whole corpus is stored in). */
const box = (x0: number, y0: number, x1: number, y1: number): Ring => [
  [x0, y1],
  [x1, y1],
  [x1, y0],
  [x0, y0],
]
const closed = (r: Ring): Ring => [...r, r[0]]

describe('measuring a zone', () => {
  it('gives a ring its area on the sphere, in km²', () => {
    // A one-degree cell is R²·Δλ·(sin φ₂ − sin φ₁): 12 364 km² on the equator…
    expect(ringAreaKm2(closed(box(0, 0, 1, 1)))).toBeCloseTo(12363.7, 0)
    // …and half of that at sixty north, because the parallel is half as long.
    expect(ringAreaKm2(closed(box(0, 60, 1, 61)))).toBeCloseTo(6088.4, 0)
  })
  it('subtracts a hole', () => {
    const outer = closed(box(0, 0, 2, 2))
    const hole = closed(box(0.5, 0.5, 1.5, 1.5))
    expect(areaKm2([[outer, hole]])).toBeCloseTo(ringAreaKm2(outer) - ringAreaKm2(hole), 0)
  })
})

describe('who is claiming', () => {
  const byId = new Map<string, { name: string; color: string; from: number; to: number }>([
    ['india', { name: 'Republic of India', color: '#6f9070', from: 1947, to: 2100 }],
  ])

  it('resolves a corpus polity to its own name and colour', () => {
    expect(resolveClaimant('india', byId)).toMatchObject({ kind: 'polity', color: '#6f9070' })
  })
  it('resolves a present-day state to a Natural Earth unit, with no colour', () => {
    const who = resolveClaimant('pakistan', byId)
    expect(who).toMatchObject({ kind: 'modern', ne: 'Pakistan' })
    expect(who.color).toBeUndefined()
  })
  it('resolves nothing else — a typo is not a claimant', () => {
    expect(resolveClaimant('ukrania', byId)).toBeUndefined()
  })
  it('keeps the modern keys clear of every polity id, so no key means two states', () => {
    // `russia` in this corpus is the Russian Empire, 1547–1917. The Russian
    // Federation is `russianfederation` precisely so that a zone cannot claim
    // one and get the other.
    const ids = new Set(nations.map((n) => n.id))
    for (const key of Object.keys(MODERN_CLAIMANTS)) expect(ids.has(key), key).toBe(false)
    expect(MODERN_CLAIMANTS.russianfederation.ne).toBe('Russia')
  })
})

describe('is the claim even possible', () => {
  const a = [[closed(box(0, 0, 1, 1))]]
  it('is zero for shapes that intersect', () => {
    expect(gapBetweenKm(a, [[closed(box(0.5, 0.5, 2, 2))]])).toBe(0)
  })
  it('measures the gap across a strait', () => {
    // 0.05° of longitude at the equator is 5.6 km — the Kerch Strait's order.
    const gap = gapBetweenKm(a, [[closed(box(1.05, 0, 2, 1))]])
    expect(gap).toBeGreaterThan(5)
    expect(gap).toBeLessThan(6.5)
    expect(gap).toBeLessThan(ABUT_TOL_KM)
  })
  it('gives up past the tolerance rather than walking the far side of the planet', () => {
    expect(gapBetweenKm(a, [[closed(box(40, 0, 41, 1))]])).toBe(Infinity)
  })
})

describe('the zone validator', () => {
  const byId = new Map([
    ['india', { name: 'India', color: '#6f9070', from: 1947, to: 2100 }],
    ['sumer', { name: 'Sumer', color: '#b09a72', from: -2900, to: -2334 }],
  ])
  const mp = [[closed(box(0, 0, 1, 1))]]
  const claim = () => mp
  const country = (name: string) => (name === 'Pakistan' ? mp : undefined)
  const run = (zone: Record<string, unknown>, over = mp) =>
    zoneFaults([{ zone, from: zone.from, to: zone.to ?? 2100, mp: over, carved: over }], byId, claim, country)

  const ok = { id: 'z', name: 'Z', from: 1947, claimants: ['india', 'pakistan'] }

  it('passes a zone with two checkable claimants', () => {
    expect(run(ok)).toEqual([])
  })
  it('refuses one claimant — contested ground needs at least two', () => {
    expect(run({ ...ok, claimants: ['india'] })[0]).toMatch(/at least two/)
  })
  it('refuses a claimant named twice', () => {
    expect(run({ ...ok, claimants: ['india', 'india'] }).join()).toMatch(/named twice/)
  })
  it('refuses a claimant nothing can resolve', () => {
    expect(run({ ...ok, claimants: ['india', 'freedonia'] })[0]).toMatch(/no polity or modern claimant/)
  })
  it('refuses a claimant whose life never touches the zone', () => {
    expect(run({ ...ok, claimants: ['sumer', 'pakistan'] })[0]).toMatch(/never overlap/)
  })
  it('refuses a claimant the zone is nowhere near', () => {
    const far = [[closed(box(40, 0, 41, 1))]]
    expect(run({ ...ok, claimants: ['india', 'pakistan'] }, far).join()).toMatch(/km from|nowhere near/)
  })
  it('refuses a zone an earlier zone carved away entirely', () => {
    const faults = zoneFaults(
      [{ zone: ok, from: 1947, to: 2100, mp, carved: [] }],
      byId,
      claim,
      country,
    )
    expect(faults.join()).toMatch(/carved all of it away/)
  })
  it('refuses a duplicate id', () => {
    const one = { zone: ok, from: 1947, to: 2100, mp, carved: mp }
    expect(zoneFaults([one, one], byId, claim, country).join()).toMatch(/duplicate id/)
  })
})

describe('nations.json (contested, authoring)', () => {
  it('authors the five zones the contract names', () => {
    expect(authoredZones.map((z) => z.id)).toEqual([
      'crimea',
      'eastukraine',
      'kashmir',
      'westernsahara',
      'abyei',
    ])
  })

  it.each(authoredZones.map((z) => [z.id, z] as const))('%s is dated, claimed and reasoned', (_id, z) => {
    expect(typeof z.from).toBe('number')
    expect((z.claimants as string[]).length).toBeGreaterThanOrEqual(2)
    // The historian's judgement is the part no pipeline can supply, and every
    // zone here is a live dispute: the reason it is one belongs in the file.
    expect(String(z.note ?? '').length).toBeGreaterThan(80)
  })

  it.each(authoredZones.map((z) => [z.id, z] as const))('%s has clockwise open rings', (_id, z) => {
    for (const ring of z.rings as Ring[]) {
      expect(ring.length).toBeGreaterThanOrEqual(4)
      expect(ring[0]).not.toEqual(ring[ring.length - 1])
      let s = 0
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = ring[i]
        const [nx, ny] = ring[(i + 1) % ring.length]
        s += x * ny - nx * y
      }
      expect(s).toBeLessThan(0) // clockwise, or the cap fills the whole planet
    }
  })

  it('gives every zone declaration a feature, two endpoints and a reason', () => {
    const decls = authoredZones.flatMap((z) =>
      ((z.follows ?? []) as Record<string, unknown>[]).map((d) => ({ id: z.id, d })),
    )
    expect(decls.length).toBeGreaterThanOrEqual(7)
    for (const { id, d } of decls) {
      expect(d.river || d.modern || d.line, id).toBeTruthy()
      expect(Array.isArray(d.from), id).toBe(true)
      expect(Array.isArray(d.to), id).toBe(true)
      expect(String(d.note ?? '').length, id).toBeGreaterThan(40)
    }
  })
})

describe('nations.clipped.json (contested, shipped)', () => {
  it('ships one entry per authored zone, with resolved claimants', () => {
    expect(zones.map((z) => z.id)).toEqual(authoredZones.map((z) => z.id))
    for (const z of zones) {
      expect(z.claimants.length).toBeGreaterThanOrEqual(2)
      for (const c of z.claimants) expect(c.name.length).toBeGreaterThan(2)
      expect(z.to).toBeGreaterThan(z.from)
      expect(z.polys.length).toBeGreaterThan(0)
    }
  })

  /**
   * THE AREAS, against numbers a reader can look up. Loose bounds on purpose —
   * these are approximations of real administrative lines, and the point of the
   * assertion is that a zone cannot silently move continents or double in size,
   * not that it is surveyed.
   */
  it.each([
    // Crimea's 26 945 km² is a LAND area; Natural Earth 50m draws the Syvash
    // lagoon as solid ground, so the peninsula it ships is about 2 500 km² more.
    ['crimea', 26_000, 30_000],
    // The mainland Russia held after the winter of 2022, Crimea excluded.
    ['eastukraine', 65_000, 90_000],
    // The princely state, 222 236 km², less Aksai Chin and the Shaksgam tract.
    ['kashmir', 170_000, 200_000],
    ['westernsahara', 250_000, 280_000],
    // The Abyei Area as the PCA redrew it in 2009.
    ['abyei', 9_000, 13_000],
  ])('%s covers about the ground it should', (id, lo, hi) => {
    const z = zones.find((x) => x.id === id)!
    const [entry] = [z.polys.map((rings) => rings.map((r) => closed(decode(r))))]
    const km2 = areaKm2(entry)
    expect(km2).toBeGreaterThan(lo)
    expect(km2).toBeLessThan(hi)
  })

  it('carves the disputed ground out of every claimant that is a polity', () => {
    // The one case in the corpus: India claims Kashmir, and after the carve no
    // point inside the zone is inside India's fill. Tested at the zone's own
    // centroid rather than exhaustively — the build's overlap validator does
    // the exhaustive version, over every pair, at every breakpoint.
    const kashmir = zones.find((z) => z.id === 'kashmir')!
    const ring = decode(kashmir.polys[0][0])
    const inside = centroid(ring)
    const india = nations.find((n) => n.id === 'india')!
    const kf = india.keyframes[0]
    const hit = kf.polys.some((rings) => inRing(decode(rings[0]), inside))
    expect(hit).toBe(false)
  })

  it('starts no zone before its dispute', () => {
    const at = (id: string) => zones.find((z) => z.id === id)!
    expect(at('crimea').from).toBeCloseTo(2014.17, 2)
    expect(at('eastukraine').from).toBeCloseTo(2022.15, 2)
    expect(at('kashmir').from).toBeCloseTo(1947.8, 2)
    expect(at('westernsahara').from).toBeCloseTo(1975.9, 2)
    expect(at('abyei').from).toBeCloseTo(2011.5, 2)
    for (const z of zones) expect(isContestedAt(z, z.from - 0.01)).toBe(false)
  })

  it('overlaps no other zone — the occupied oblasts stop at Crimea', () => {
    // The authored ring of the occupied zone is deliberately drawn across the
    // Syvash and into northern Crimea, because Natural Earth draws the lagoon
    // as solid land and threading it by hand would be a guess; the carve is
    // what keeps the two apart, and this is the assertion that it happened.
    const mp = (id: string) =>
      zones.find((z) => z.id === id)!.polys.map((rings) => rings.map((r) => closed(decode(r))))
    const shared = polygonClipping.intersection(mp('crimea'), mp('eastukraine'))
    // Not zero: two rings that share a boundary leave slivers at the codec's
    // 11 m quantum. One square kilometre is a hundred times any of them and a
    // ten-thousandth of the smaller zone.
    expect(areaKm2(shared)).toBeLessThan(1)
  })
})

/* -------------------------------------------------------------- the hatch */

describe('the hatch', () => {
  const zone = (claimants: { id: string; name: string; color?: string }[]): ContestedZone => ({
    id: 'z',
    name: 'Zed',
    from: 2000,
    to: 2100,
    claimants,
    polys: [[encodeRing(box(0, 0, 1, 1))]],
  })

  it('lends a claimant its colour only while the map draws that claimant', () => {
    const z = zone([
      { id: 'india', name: 'India', color: '#6f9070' },
      { id: 'pakistan', name: 'Pakistan' },
    ])
    expect(hatchColors(z, new Set(['india']))).toEqual(['#6f9070', ''])
    // …and takes it back when India leaves the frame: a colour nothing else on
    // the globe wears is a code with no legend.
    expect(hatchColors(z, new Set())).toEqual(['', ''])
  })

  it('paints an absent claimant one of two neutral tones, not one grey twice', () => {
    expect(hatchTone('', 0)).toBe(HATCH_NEUTRAL[0])
    expect(hatchTone('', 1)).toBe(HATCH_NEUTRAL[1])
    expect(HATCH_NEUTRAL[0]).not.toBe(HATCH_NEUTRAL[1])
    expect(hatchTone('#6f9070', 0)).toBe('#6f9070')
  })

  it('names the dispute in the hover label', () => {
    expect(
      contestedLabel(zone([
        { id: 'ukraine', name: 'Ukraine' },
        { id: 'russianfederation', name: 'Russian Federation' },
      ])),
    ).toBe('Zed — claimed by Ukraine and Russian Federation')
  })

  it('builds a cap material that keeps the round-59 draw-call settings', () => {
    const m = hatchMaterial('#112233', '#445566', 0.34)
    expect(m.transparent).toBe(true)
    expect(m.depthWrite).toBe(false)
    expect(m.forceSinglePass).toBe(true)
    expect(m.polygonOffset).toBe(true)
    // Every zone's material patches the same source, so they must share one
    // compiled program or the map pays a shader compile per colour pair.
    expect(m.customProgramCacheKey!()).toBe(hatchMaterial('#000000', '#ffffff', 0.2).customProgramCacheKey!())
  })

  it('derives its stripe from the cap vertex, never from the screen', () => {
    const m = hatchMaterial('#112233', '#445566', 0.34)
    const shader = { uniforms: {}, vertexShader: VERT, fragmentShader: FRAG } as never as {
      uniforms: Record<string, { value: unknown }>
      vertexShader: string
      fragmentShader: string
    }
    m.onBeforeCompile!(shader as never, null as never)
    expect(shader.vertexShader).toContain('vGround = position')
    // gl_FragCoord is the screen; if it ever appears here the hatch crawls.
    expect(shader.fragmentShader).not.toContain('gl_FragCoord')
    expect(shader.fragmentShader).toContain('atan(g.x, g.z)')
    expect(shader.uniforms.uHatchPeriod.value).toBe(HATCH_PERIOD_DEG)
    // Declared once each, or the shader does not compile and the globe goes black.
    const names = [...shader.fragmentShader.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)].map((x) => x[1])
    expect(names).toEqual([...new Set(names)])
  })
})

/* ------------------------------------------------------------- the dashes */

describe('a contested outline is dashed', () => {
  const zone: ContestedZone = {
    id: 'z',
    name: 'Zed',
    from: 2000,
    to: 2100,
    // A ten-degree box on the equator: long enough for many dash periods.
    polys: [[encodeRing(box(0, 0, 10, 10))]],
    claimants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  }
  const entries = contestedRings(zone, ['', ''])
  const solid: InkEntry = { ...entries[0], kind: 'full' }

  const vertices = (list: InkEntry[]) => {
    const layer = new FrontierLayer(new Scene(), 100)
    layer.set(list, () => '#000000', () => 'all')
    const n = layer.object.geometry.getAttribute('position').count
    layer.dispose()
    return n
  }

  it('lays the dashes at the declared period, measured on the ground', () => {
    const layer = new FrontierLayer(new Scene(), 100)
    layer.set(entries, () => '#000000', () => 'all')
    const p = layer.object.geometry.getAttribute('position')
    let ink = 0
    for (let i = 0; i + 1 < p.count; i += 2) {
      const a = latLng(p, i)
      const b = latLng(p, i + 1)
      ink += Math.hypot((b[0] - a[0]) * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180), b[1] - a[1])
    }
    layer.dispose()
    // The share of the perimeter that is ink is the duty cycle of the pattern.
    const perimeter = 40
    expect(ink / perimeter).toBeCloseTo(DASH_DEG / (DASH_DEG + GAP_DEG), 1)
  })

  it('leaves an undisputed border solid', () => {
    const layer = new FrontierLayer(new Scene(), 100)
    layer.set([solid], () => '#000000', () => 'all')
    const p = layer.object.geometry.getAttribute('position')
    let ink = 0
    for (let i = 0; i + 1 < p.count; i += 2) {
      const a = latLng(p, i)
      const b = latLng(p, i + 1)
      ink += Math.hypot((b[0] - a[0]) * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180), b[1] - a[1])
    }
    layer.dispose()
    expect(ink).toBeCloseTo(40, 0)
  })
})

describe('which pen inks a disputed line', () => {
  const zone: ContestedZone = {
    id: 'z',
    name: 'Zed',
    from: 2000,
    to: 2100,
    polys: [[encodeRing(box(0, 0, 1, 1))]],
    claimants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  }
  const [entry] = contestedRings(zone, ['', ''])
  const polity: InkEntry = { ...entry, kind: 'full' }
  const modern: InkEntry = { ...entry, kind: 'full', nation: { ...entry.nation, id: 'modern@0' } }

  it('uses the disputed pen, chosen per ground rather than mixed', () => {
    expect(frontierInkPlan([], { mode: 'schematic' }).colorOf(entry)).toBe(CONTESTED.ink.schematic)
    expect(frontierInkPlan([], { mode: 'realistic' }).colorOf(entry)).toBe(CONTESTED.ink.realistic)
  })

  it('never yields its outline to the modern states, though a polity does', () => {
    const plan = frontierInkPlan([modern], { mode: 'schematic' })
    expect(plan.inkOf(polity)).toBe('none') // the modern set draws that line better
    expect(plan.inkOf(entry)).toBe('frontier') // nobody else draws this one at all
    const photo = frontierInkPlan([modern], { mode: 'realistic' })
    expect(photo.inkOf(entry)).toBe('all')
  })
})

describe('contestedRings', () => {
  const zone: ContestedZone = {
    id: 'z',
    name: 'Zed',
    from: 2000,
    to: 2100,
    polys: [[encodeRing(box(0, 0, 1, 1))]],
    claimants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  }

  it('holds its entries across ticks, and keys them on the hatch', () => {
    expect(contestedRings(zone, ['', ''])[0]).toBe(contestedRings(zone, ['', ''])[0])
    expect(contestedRings(zone, ['#6f9070', ''])[0]).not.toBe(contestedRings(zone, ['', ''])[0])
  })

  it('splits its boundary into frontier and coast like a polity does', () => {
    const [e] = contestedRings(zone, ['', ''])
    // No `coast` runs on this zone, so all of it is frontier and none is coast.
    expect(e.frontier.length).toBe(1)
    expect(e.coast.length).toBe(0)
    expect(e.kind).toBe('contested')
    expect(e.nation.id).toBe('contested:z')
  })
})

/* ------------------------------------------------------------------ helpers */

const QUANTUM = 1e-4
function decode(enc: number[]): Ring {
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

const centroid = (ring: Ring): [number, number] => [
  ring.reduce((s, p) => s + p[0], 0) / ring.length,
  ring.reduce((s, p) => s + p[1], 0) / ring.length,
]

function inRing(ring: Ring, [lng, lat]: [number, number]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** A buffer position back to [lng, lat] — the inverse of the layer's `unit`. */
function latLng(attr: { getX(i: number): number; getY(i: number): number; getZ(i: number): number }, i: number) {
  const x = attr.getX(i)
  const y = attr.getY(i)
  const z = attr.getZ(i)
  const r = Math.hypot(x, y, z)
  return [(Math.atan2(x, z) * 180) / Math.PI, (Math.asin(y / r) * 180) / Math.PI] as const
}

/** Just enough of three's own chunks for `onBeforeCompile` to find its anchors. */
const VERT = '#include <common>\nvoid main() {\n#include <begin_vertex>\n}'
const FRAG = '#include <common>\nvoid main() {\n#include <color_fragment>\n}'
