import { describe, it, expect } from 'vitest'
import {
  activeKeyframe,
  borderRings,
  isNotable,
  keyframeArea,
  nationLabel,
  ringArea,
  signedRingArea,
  visibleNations,
  MAX_VISIBLE,
  type Nation,
  type Ring,
} from '../src/lib/nations'

const square = (size: number): Ring => [[0, 0], [size, 0], [size, size], [0, size]]

const rome: Nation = {
  id: 'rome',
  name: 'Roman Empire',
  color: '#b05c4a',
  from: -509,
  to: 476,
  visibleFrom: -270,
  visibleTo: 476,
  keyframes: [
    { time: -270, rings: [square(1)] },
    { time: -100, rings: [square(3)] },
    { time: 117, rings: [square(5), square(1)] }, // greatest extent, mainland + an island
    { time: 300, rings: [square(4)] },
  ],
}

describe('activeKeyframe', () => {
  it('holds the last keyframe until the next one', () => {
    expect(activeKeyframe(rome, -150)?.time).toBe(-270)
    expect(activeKeyframe(rome, -100)?.time).toBe(-100)
    expect(activeKeyframe(rome, 200)?.time).toBe(117)
  })
  it('holds the first keyframe backwards to the start of existence', () => {
    // Rome exists from -509 but its first drawn border is -270; it is not borderless in between
    expect(activeKeyframe(rome, -400)?.time).toBe(-270)
  })
  it('is undefined outside the existence span', () => {
    expect(activeKeyframe(rome, -600)).toBeUndefined()
    expect(activeKeyframe(rome, 477)).toBeUndefined()
    expect(activeKeyframe(rome, 476)?.time).toBe(300) // inclusive end
  })
})

describe('isNotable', () => {
  it('needs both existence and the notability window', () => {
    expect(isNotable(rome, -400)).toBe(false) // exists, not yet notable
    expect(isNotable(rome, -270)).toBe(true)
    expect(isNotable(rome, 476)).toBe(true)
    expect(isNotable(rome, 500)).toBe(false)
  })
})

describe('ringArea', () => {
  it('signs the shoelace by winding', () => {
    expect(signedRingArea(square(2))).toBe(4) // counter-clockwise
    expect(signedRingArea([...square(2)].reverse())).toBe(-4) // clockwise, as the data ships
  })
  it('computes shoelace area regardless of closure or winding', () => {
    expect(ringArea(square(2))).toBe(4)
    expect(ringArea([...square(2), [0, 0]])).toBe(4) // explicitly closed → same
    expect(ringArea([...square(2)].reverse())).toBe(4)
  })
  it('sums the rings of a keyframe', () => {
    expect(keyframeArea(rome.keyframes[2])).toBe(26)
  })
})

describe('visibleNations', () => {
  const other = (id: string, from: number, to: number, size = 2): Nation => ({
    id,
    name: id,
    color: '#4f8a86',
    from,
    to,
    visibleFrom: from,
    visibleTo: to,
    keyframes: [{ time: from, rings: [square(size)] }],
  })

  it('rotates the set as time moves', () => {
    const pool = [rome, other('han', -206, 220), other('tang', 618, 907)]
    expect(visibleNations(pool, 100).map((n) => n.id)).toEqual(['rome', 'han'])
    expect(visibleNations(pool, 700).map((n) => n.id)).toEqual(['tang'])
    expect(visibleNations(pool, -1000)).toEqual([])
  })

  it('sorts largest first and caps the count', () => {
    const pool = Array.from({ length: 20 }, (_, i) => other(`n${i}`, 0, 100, i + 1))
    const vis = visibleNations(pool, 50)
    expect(vis).toHaveLength(MAX_VISIBLE)
    expect(vis[0].id).toBe('n19') // biggest
    expect(visibleNations(pool, 50, 3)).toHaveLength(3)
  })
})

describe('nationLabel', () => {
  it('names the polity and its span', () => {
    expect(nationLabel(rome)).toBe('Roman Empire (510 BCE – 476)')
  })
})

import rawNations from '../src/data/nations.json'

/**
 * The shipped dataset against what the library and the globe layer assume of it.
 * Every one of these is silent when broken: an out-of-order keyframe makes
 * `activeKeyframe` stop early, a swapped coordinate pair puts a nation in the
 * wrong hemisphere, and a three-digit colour turns into an invalid hex once the
 * polygon layer appends its alpha.
 */
describe('nations.json', () => {
  const nations = rawNations as Nation[]

  it('ships a curated world', () => {
    expect(nations.length).toBeGreaterThanOrEqual(40)
    expect(new Set(nations.map((n) => n.id)).size).toBe(nations.length)
  })

  it.each(nations.map((n) => [n.id, n] as const))('%s has a coherent span', (_id, n) => {
    expect(n.to).toBeGreaterThan(n.from)
    expect(n.visibleTo).toBeGreaterThan(n.visibleFrom)
    // a notability window outside the polity's life could never draw anything
    expect(n.visibleFrom).toBeLessThanOrEqual(n.to)
    expect(n.visibleTo).toBeGreaterThanOrEqual(n.from)
    expect(activeKeyframe(n, n.visibleFrom)).toBeDefined()
    expect(activeKeyframe(n, n.visibleTo)).toBeDefined()
  })

  it.each(nations.map((n) => [n.id, n] as const))('%s has usable keyframes', (_id, n) => {
    expect(n.keyframes.length).toBeGreaterThan(0)
    for (let i = 1; i < n.keyframes.length; i++) {
      expect(n.keyframes[i].time).toBeGreaterThan(n.keyframes[i - 1].time)
    }
  })

  it.each(nations.map((n) => [n.id, n] as const))('%s has rings in [lng, lat] order', (_id, n) => {
    for (const k of n.keyframes) {
      expect(k.rings.length).toBeGreaterThan(0)
      for (const ring of k.rings) {
        // enough vertices to look drawn rather than sketched, few enough to ship
        expect(ring.length).toBeGreaterThanOrEqual(12)
        expect(ring.length).toBeLessThanOrEqual(80)
        for (const [lng, lat] of ring) {
          expect(Math.abs(lng)).toBeLessThanOrEqual(180)
          expect(Math.abs(lat)).toBeLessThanOrEqual(90)
        }
        // rings are left open; the globe layer closes them itself, and a ring
        // closed twice draws a degenerate final edge
        expect(ring[0]).not.toEqual(ring[ring.length - 1])
        expect(ringArea(ring)).toBeGreaterThan(0) // not a line or a single point
        // clockwise, or the cap fills the entire globe except this nation
        expect(signedRingArea(ring)).toBeLessThan(0)
      }
    }
  })

  it.each(nations.map((n) => [n.id, n] as const))('%s has a six-digit colour', (_id, n) => {
    // the polygon layer builds fills as `color + '22'`, which only parses from six
    expect(n.color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  /**
   * The curation promise: a nation display "relates to a certain time", showing
   * a handful of that moment's powers. Too many and the globe turns to mush; too
   * few and an era looks empty.
   */
  it.each([-2600, -2000, -1400, -1000, -700, -500, -320, -200, -100, 1, 100, 250, 400, 600, 700, 800, 1000, 1100, 1200, 1300, 1400, 1450, 1500, 1550, 1600, 1650, 1700, 1750, 1800, 1850, 1900, 1930, 1950, 1980, 2000])(
    'shows a handful of polities at %i',
    (t) => {
      const vis = visibleNations(nations, t)
      expect(vis.length).toBeGreaterThanOrEqual(3)
      expect(vis.length).toBeLessThanOrEqual(8)
    },
  )
})

/**
 * Held borders against the calendar.
 *
 * Keyframes hold forwards, so a polity whose next keyframe is decades away goes
 * on being drawn at an extent it no longer had — and the failure is silent,
 * because every structural invariant above still passes. The dataset once had
 * France jump straight from Napoleon's 1812 empire to 1900, which drew the
 * Confederation of the Rhine, the Kingdom of Italy and the Dutch coast as
 * French for the whole nineteenth century.
 *
 * These are the dates where a border actually moved, asserted as "was this city
 * inside this polity in this year". A missing keyframe fails one of them.
 */
describe('borders at a date', () => {
  const nations = rawNations as Nation[]

  /** Ray cast in the plane; the rings are small enough that this is exact enough. */
  const inRing = (ring: Ring, lng: number, lat: number): boolean => {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
  const covers = (id: string, t: number, lng: number, lat: number): boolean => {
    const nation = nations.find((n) => n.id === id)
    if (!nation) throw new Error(`no nation ${id}`)
    const k = activeKeyframe(nation, t)
    return !!k && k.rings.some((ring) => inRing(ring, lng, lat))
  }

  // [polity, year, place, lng, lat, inside?]
  const cases: [string, number, string, number, number, boolean][] = [
    // France: revolution, empire, Vienna, Algeria — not one Napoleonic blob
    ['france', 1780, 'Paris', 2.35, 48.85, true],
    ['france', 1780, 'Brussels', 4.35, 50.85, false],
    ['france', 1750, 'the St Lawrence', -72.5, 47.5, true], // New France, until 1763
    ['france', 1780, 'the St Lawrence', -72.5, 47.5, false],
    ['france', 1800, 'Brussels', 4.35, 50.85, true], // annexed 1795
    ['france', 1800, 'Rome', 12.5, 41.9, false],
    ['france', 1812, 'Amsterdam', 4.9, 52.37, true], // the empire at its height
    ['france', 1812, 'Rome', 12.5, 41.9, true],
    ['france', 1849, 'Paris', 2.35, 48.85, true],
    ['france', 1849, 'inland Algeria', 3.05, 36.4, true],
    ['france', 1849, 'Amsterdam', 4.9, 52.37, false], // and not an inch of it after 1815
    ['france', 1849, 'Rome', 12.5, 41.9, false],
    ['france', 1849, 'Berlin', 13.4, 52.5, false],
    ['france', 1849, 'Hanoi', 105.8, 21, false],
    ['france', 1880, 'Nice', 7.1, 43.9, false], // Savoy and Nice are 1860
    ['france', 1930, 'Nice', 7.1, 43.9, true],
    ['france', 1930, 'Hanoi', 105.8, 21, true],

    // Britain: the first empire, its loss, the Raj, the mandates, independence
    ['britain', 1770, 'Philadelphia', -75.16, 39.95, true],
    ['britain', 1790, 'Philadelphia', -75.16, 39.95, false],
    ['britain', 1750, 'Montreal', -73.6, 45.5, false], // French until 1763
    ['britain', 1790, 'Montreal', -73.6, 45.5, true],
    ['britain', 1750, 'Sydney', 151.2, -33.87, false], // the First Fleet is 1788
    ['britain', 1810, 'Sydney', 151.2, -33.87, true],
    ['britain', 1770, 'the Karoo', 21, -32, false], // the Cape is taken in 1806
    ['britain', 1830, 'the Karoo', 21, -32, true],
    ['britain', 1830, 'Delhi', 77.2, 28.6, true],
    ['britain', 1830, 'Lahore', 74.35, 31.55, false], // the Punjab is annexed in 1849
    ['britain', 1870, 'Lahore', 74.35, 31.55, true],
    ['britain', 1890, 'Baghdad', 44.4, 33.3, false], // Ottoman until the mandate
    ['britain', 1925, 'Baghdad', 44.4, 33.3, true],
    ['britain', 1930, 'Delhi', 77.2, 28.6, true],
    ['britain', 1950, 'Delhi', 77.2, 28.6, false], // independence, 1947

    // Ottoman: Hungary won and lost, Greece, Crimea
    ['ottoman', 1500, 'Budapest', 19.04, 47.5, false],
    ['ottoman', 1600, 'Budapest', 19.04, 47.5, true], // Mohács 1526, Buda 1541
    ['ottoman', 1750, 'Budapest', 19.04, 47.5, false], // Karlowitz, 1699
    ['ottoman', 1500, 'Tripoli', 15, 30.5, false],
    ['ottoman', 1600, 'Tripoli', 15, 30.5, true], // 1551
    ['ottoman', 1700, 'Attica', 23.4, 38.2, true],
    ['ottoman', 1850, 'Attica', 23.4, 38.2, false], // Greek independence, 1830
    ['ottoman', 1900, 'Attica', 23.4, 38.2, false],
    ['ottoman', 1700, 'Crimea', 34.5, 45.2, true],
    ['ottoman', 1850, 'Crimea', 34.5, 45.2, false], // annexed by Russia, 1783

    // the rest of the powers whose extent moves inside a keyframe gap
    ['usa', 1810, 'St Louis', -90.2, 38.6, false], // drawn from the Purchase of 1803
    ['usa', 1830, 'St Louis', -90.2, 38.6, true],
    ['usa', 1830, 'Nevada', -117, 39, false], // the Mexican Cession is 1848
    ['usa', 1860, 'Nevada', -117, 39, true],
    ['russia', 1620, 'Yakutsk', 129.7, 62, false],
    ['russia', 1650, 'Yakutsk', 129.7, 62, true], // Okhotsk is reached in 1639
    ['russia', 1650, 'Moscow', 37.6, 55.75, true],
    ['qing', 1660, 'Beijing', 116.4, 39.9, true],
    ['qing', 1660, 'Urga', 106.9, 47.9, false], // Khalkha Mongolia submits in 1691
    ['qing', 1750, 'Urga', 106.9, 47.9, true],
    ['japan', 1890, 'Tokyo', 139.7, 35.68, true],
    ['japan', 1890, 'Taiwan', 121, 24, false], // Shimonoseki, 1895
    ['japan', 1900, 'Taiwan', 121, 24, true],
    ['japan', 1890, 'Seoul', 126.98, 37.57, false], // annexation, 1910
    ['japan', 1920, 'Seoul', 126.98, 37.57, true],
    ['germany', 1875, 'Berlin', 13.4, 52.5, true],
    ['germany', 1875, 'Windhoek', 17.08, -22.57, false], // South West Africa, 1884
    ['germany', 1900, 'Windhoek', 17.08, -22.57, true],
    ['spain', 1520, 'Madrid', -3.7, 40.4, true],
    ['spain', 1520, 'Peru', -74, -12, false], // Pizarro lands in 1532
    ['spain', 1600, 'Peru', -74, -12, true],
    ['spain', 1520, 'Manila', 121, 15, false], // 1565
    ['spain', 1600, 'Manila', 121, 15, true],
    ['spain', 1600, 'Portugal', -8.5, 39.5, true], // the Iberian Union, 1580-1640
    ['spain', 1700, 'Portugal', -8.5, 39.5, false],
    ['portugal', 1520, 'Coimbra', -8.3, 40.2, true],
    ['portugal', 1520, 'Bahia', -40, -15, false], // the captaincies are settled from 1534
    ['portugal', 1580, 'Bahia', -40, -15, true],
    ['portugal', 1520, 'Angola', 14.5, -10, false], // Luanda, 1575
    ['portugal', 1580, 'Angola', 14.5, -10, true],
    ['dutch', 1610, 'Amsterdam', 4.9, 52.37, true],
    ['dutch', 1610, 'Java', 108, -7, false], // Batavia, 1619
    ['dutch', 1650, 'Java', 108, -7, true],
    ['dutch', 1610, 'the Cape', 20, -33, false], // 1652
    ['dutch', 1700, 'the Cape', 20, -33, true],
  ]

  it.each(cases)('%s at %i: %s', (id, year, _place, lng, lat, inside) => {
    expect(covers(id, year, lng, lat)).toBe(inside)
  })
})

/**
 * Border identity across a timeline tick.
 *
 * The globe's polygon layer joins on object identity and re-tessellates on
 * array identity, so "the same borders" has to mean the same objects — see
 * lib/nations.ts. These are the assertions that keep it that way.
 */
describe('borderRings', () => {
  it('returns the same objects while the keyframe holds', () => {
    const a = borderRings(rome, -150)
    const b = borderRings(rome, -120)
    expect(b).toBe(a)
    expect(b[0]).toBe(a[0])
    expect(b[0].coordinates).toBe(a[0].coordinates)
  })

  it('returns different objects once the keyframe changes', () => {
    const a = borderRings(rome, -150) // the -270 keyframe
    const b = borderRings(rome, -50) // the -100 one
    expect(b[0]).not.toBe(a[0])
    expect(b[0].ring).toBe(rome.keyframes[1].rings[0])
  })

  it('gives one entry per ring, in the keyframe order', () => {
    const rings = borderRings(rome, 200) // greatest extent: mainland + island
    expect(rings).toHaveLength(2)
    expect(rings.map((r) => r.ring)).toEqual(rome.keyframes[2].rings)
  })

  it('closes each ring exactly once, without touching the stored one', () => {
    const [entry] = borderRings(rome, -150)
    const open = rome.keyframes[0].rings[0]
    expect(entry.coordinates).toHaveLength(1)
    expect(entry.coordinates[0]).toHaveLength(open.length + 1)
    expect(entry.coordinates[0][open.length]).toEqual(open[0])
    expect(open).toHaveLength(4) // the source data is still open
  })

  it('carries the label and the discriminant the polygon layer needs', () => {
    const [entry] = borderRings(rome, -150)
    expect(entry.kind).toBe('full')
    expect(entry.label).toBe(nationLabel(rome))
    expect(entry.nation).toBe(rome)
  })

  it('draws nothing outside the polity existence', () => {
    expect(borderRings(rome, -900)).toEqual([])
    expect(borderRings(rome, 900)).toEqual([])
  })
})
