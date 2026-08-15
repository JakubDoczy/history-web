import { describe, it, expect } from 'vitest'
import {
  activeKeyframe,
  borderRings,
  decodeKeyframe,
  decodeRing,
  decodeRuns,
  encodeRing,
  frontierRuns,
  isNotable,
  keyframeArea,
  nationLabel,
  ringArea,
  signedRingArea,
  visibleNations,
  BORDER_SEGMENT_DEG,
  MAX_VISIBLE,
  QUANTUM,
  type Nation,
  type NationKeyframe,
  type Ring,
} from '../src/lib/nations'
import { FRONTIER_BUILD_ALT } from '../src/lib/frontierLayer'

const square = (size: number): Ring => [[0, 0], [size, 0], [size, size], [0, size]]

/** A keyframe from plain rings — one piece per ring, no holes, no coast. */
const kf = (time: number, ...rings: Ring[]): NationKeyframe => ({
  time,
  polys: rings.map((r) => [encodeRing(r)]),
})

const rome: Nation = {
  id: 'rome',
  name: 'Roman Empire',
  color: '#b05c4a',
  from: -509,
  to: 476,
  visibleFrom: -270,
  visibleTo: 476,
  keyframes: [
    kf(-270, square(1)),
    kf(-100, square(3)),
    kf(117, square(5), square(1)), // greatest extent, mainland + an island
    kf(300, square(4)),
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
    keyframes: [kf(from, square(size))],
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

import authoredFile from '../src/data/nations.json'
import clippedFile from '../src/data/nations.clipped.json'

/** The authoring file's shape: hand-drawn open CW rings, one list per keyframe. */
interface Authored {
  id: string
  name: string
  color: string
  from: number
  to: number
  visibleFrom: number
  visibleTo: number
  keyframes: { time: number; rings?: Ring[]; countries?: string[] }[]
}

/**
 * The shipped dataset against what the library and the globe layer assume of it.
 * Every one of these is silent when broken: an out-of-order keyframe makes
 * `activeKeyframe` stop early, a swapped coordinate pair puts a nation in the
 * wrong hemisphere, and a three-digit colour turns into an invalid hex once the
 * polygon layer appends its alpha.
 */
describe('nations.json (authoring)', () => {
  const nations = authoredFile.nations as unknown as Authored[]

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
    expect(activeKeyframe(n as unknown as Nation, n.visibleFrom)).toBeDefined()
    expect(activeKeyframe(n as unknown as Nation, n.visibleTo)).toBeDefined()
  })

  it.each(nations.map((n) => [n.id, n] as const))('%s has usable keyframes', (_id, n) => {
    expect(n.keyframes.length).toBeGreaterThan(0)
    for (let i = 1; i < n.keyframes.length; i++) {
      expect(n.keyframes[i].time).toBeGreaterThan(n.keyframes[i - 1].time)
    }
  })

  /**
   * ROUND 63: a keyframe is EITHER hand-drawn rings or a `countries`
   * declaration — an extent that IS the modern map, taken from the same
   * Natural Earth topology the modern-border ink and the coastline come from
   * (scripts/follows-lib.mjs, `countryExtent`). There is nothing for the
   * authoring rules below to say about the second kind: it has no authored
   * vertices, so there is no vertex cap, no winding to get wrong and no
   * coordinate order to swap. What it does have is a validator the drawn rings
   * do not — `modernInkAgreement`, which fails the build if the fill's edge is
   * not a line the map draws.
   */
  /**
   * ROUND 64 loosened this from "exactly one way" to "at least one way": a
   * PARTIAL EXTENT declares `countries` AND `rings`, and the build unions the
   * two — the Qing at 1800 are China, Mongolia and Taiwan plus a hand ring for
   * Outer Manchuria, which no present state keeps. The hand ring obeys every
   * authoring rule below, exactly as if it were the whole extent.
   */
  it.each(nations.map((n) => [n.id, n] as const))('%s declares each keyframe at least one way', (_id, n) => {
    for (const k of n.keyframes) {
      expect(Boolean(k.rings) || Boolean(k.countries), `${n.id}@${k.time}`).toBe(true)
      if (k.countries) expect(k.countries.length).toBeGreaterThan(0)
    }
  })

  it.each(nations.map((n) => [n.id, n] as const))('%s has rings in [lng, lat] order', (_id, n) => {
    for (const k of n.keyframes) {
      if (!k.rings) continue // a `countries` extent: see above
      expect(k.rings.length).toBeGreaterThan(0)
      for (const ring of k.rings) {
        // Enough vertices to look drawn rather than sketched, few enough to
        // stay a thing a human edits. The ceiling moved from 80 to 84 in round
        // 59 for a reason worth writing down: a `follows` declaration attaches
        // to AUTHORED vertices — the run between them is what the derived river
        // replaces — so a frontier with no vertex where a river starts needs one
        // written down before it can be declared at all. Russia's 1900 ring
        // gained two (the Sungacha junction and Khabarovsk), the USSR's three
        // net, the PRC's one, the Mamluks' one. Four anchors do not stop this
        // file being hand-editable, which is what the cap is for.
        expect(ring.length).toBeGreaterThanOrEqual(12)
        expect(ring.length).toBeLessThanOrEqual(84)
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
   * ROUND 64: the `approx` flag is the authoring half of the sketch pipeline —
   * a polity (or keyframe) whose freehand inland frontier is a historian's
   * estimate says so, and the build dashes what it cannot back with a feature.
   * The polities that do NOT declare it are exactly the ones whose hand lines
   * are surveyed (usa, germany, japan) or wholly derived (prc, india, ussr):
   * a new polity added without a decision here should fail this test and force
   * the decision to be made.
   */
  it('declares approx on every polity whose freehand frontier is an estimate', () => {
    const surveyed = new Set(['usa', 'germany', 'japan', 'prc', 'india', 'ussr'])
    for (const n of nations as unknown as (Authored & { approx?: boolean })[]) {
      if ('approx' in n) expect(typeof n.approx, n.id).toBe('boolean')
      expect(Boolean(n.approx), n.id).toBe(!surveyed.has(n.id))
    }
  })

  /**
   * The curation promise: a nation display "relates to a certain time", showing
   * a handful of that moment's powers. Too many and the globe turns to mush; too
   * few and an era looks empty.
   *
   * The ceiling went from eight to NINE in round 57, when Korea was added: from
   * 1392 to 1909 the corpus draws a ninth polity across East Asia. It is a
   * peninsula rather than a continent — the smallest extent on the globe in
   * every year it appears — and the hard cap it is measured against is still
   * `MAX_VISIBLE` = 10. A tenth would be the point to start trimming windows.
   */
  it.each([-2600, -2000, -1400, -1000, -700, -500, -320, -200, -100, 1, 100, 250, 400, 600, 700, 800, 1000, 1100, 1200, 1300, 1400, 1450, 1500, 1550, 1600, 1650, 1700, 1750, 1800, 1850, 1900, 1930, 1950, 1980, 2000])(
    'shows a handful of polities at %i',
    (t) => {
      const vis = visibleNations(clippedFile.nations as unknown as Nation[], t)
      expect(vis.length).toBeGreaterThanOrEqual(3)
      expect(vis.length).toBeLessThanOrEqual(9)
      expect(vis.length).toBeLessThanOrEqual(MAX_VISIBLE)
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
  const nations = clippedFile.nations as unknown as Nation[]

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
  /** Inside a PIECE: in its outer ring and in none of its holes. */
  const covers = (id: string, t: number, lng: number, lat: number): boolean => {
    const nation = nations.find((n) => n.id === id)
    if (!nation) throw new Error(`no nation ${id}`)
    const k = activeKeyframe(nation, t)
    if (!k) return false
    return decodeKeyframe(k).pieces.some(
      (rings) => inRing(rings[0], lng, lat) && !rings.slice(1).some((h) => inRing(h, lng, lat)),
    )
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

    // KOREA, round 57's hole. Joseon holds the peninsula from 1392, the six
    // garrisons put the frontier on the Tumen under Sejong (1434-1449), the
    // Korean Empire is the same ground renamed in 1897, and Japan annexes it in
    // 1910 — at which point the empire stops being drawn, because a succession
    // is not a co-reign.
    ['joseon', 1400, 'Seoul', 126.98, 37.57, true],
    ['joseon', 1400, 'Pyongyang', 125.75, 39.03, true],
    ['joseon', 1500, 'Busan', 129.05, 35.18, true],
    ['joseon', 1500, 'Jeju', 126.55, 33.4, true], // the island is held whole
    ['joseon', 1400, 'Hoeryong on the Tumen', 129.75, 42.44, false], // Sejong's, 1434-49
    ['joseon', 1500, 'Hoeryong on the Tumen', 129.75, 42.44, true],
    ['joseon', 1500, 'Shenyang', 123.43, 41.8, false], // the Yalu is the frontier
    ['joseon', 1500, 'Vladivostok', 131.89, 43.12, false],
    ['joseon', 1500, 'Tsushima', 129.3, 34.35, false], // Japanese, and not absorbed
    ['koreanempire', 1900, 'Seoul', 126.98, 37.57, true],
    ['koreanempire', 1900, 'Pyongyang', 125.75, 39.03, true],
    ['japan', 1900, 'Seoul', 126.98, 37.57, false], // Shimonoseki left it independent
    ['qing', 1700, 'Pyongyang', 125.75, 39.03, false], // tribute is not a border
    ['qing', 1700, 'Dandong, north of the Yalu', 124.35, 40.15, true],
    ['ming', 1500, 'Pyongyang', 125.75, 39.03, false],

    // ROUND 63, the modern extents. The reader's complaint was that these were
    // wrong in ways a glance could see, and every case below failed before this
    // round: India's hand-drawn ring covered 76% of Bangladesh, 70% of Nepal
    // and 16% of Pakistan, China's covered a quarter of Mongolia and 12% of
    // Vietnam, and the United States' 1900 ring stopped short of south Florida,
    // the Alaska panhandle and Hawaii. All four extents are now the union of
    // named present-day states in Natural Earth (`countries` in nations.json).
    ['india', 2000, 'Delhi', 77.2, 28.6, true],
    ['india', 2000, 'Kolkata', 88.36, 22.57, true],
    ['india', 2000, 'Itanagar in Arunachal', 93.6, 27.1, true], // NE draws it Indian
    ['india', 2000, 'Dhaka', 90.4, 23.8, false], // East Pakistan, then Bangladesh
    ['india', 2000, 'Chittagong', 91.83, 22.36, false],
    ['india', 2000, 'Kathmandu', 85.32, 27.71, false],
    ['india', 2000, 'Thimphu', 89.64, 27.47, false],
    ['india', 2000, 'Karachi', 67.0, 24.86, false],
    ['india', 2000, 'Multan', 71.52, 30.2, false],
    ['india', 2000, 'Colombo', 79.86, 6.93, false],
    ['india', 2000, 'Srinagar', 74.8, 34.08, false], // the contested zone holds it
    ['india', 1950, 'Delhi', 77.2, 28.6, true], // and the same shape from 1947
    ['india', 1950, 'Dhaka', 90.4, 23.8, false],
    ['prc', 2000, 'Beijing', 116.4, 39.9, true],
    ['prc', 2000, 'Lhasa', 91.1, 29.65, true],
    ['prc', 2000, 'Kashgar', 75.99, 39.47, true],
    ['prc', 2000, 'Ulaanbaatar', 106.9, 47.9, false], // Mongolia, since 1921
    ['prc', 2000, 'Hanoi', 105.85, 21.03, false],
    ['prc', 2000, 'Bishkek', 74.6, 42.87, false],
    ['prc', 2000, 'Almaty', 76.9, 43.24, false],
    ['prc', 2000, 'Vladivostok', 131.89, 43.12, false],
    ['usa', 2000, 'the Everglades', -81.0, 25.9, true], // the 1900 ring stopped at 28° N
    ['usa', 2000, 'Skagway in the panhandle', -135.31, 59.46, true],
    ['usa', 2000, 'Ketchikan', -131.65, 55.35, true],
    ['usa', 2000, 'Honolulu', -157.86, 21.31, true],
    ['usa', 2000, 'Vancouver', -123.12, 49.28, false],
    ['ussr', 1980, 'Moscow', 37.6, 55.75, true],
    ['ussr', 1980, 'Tallinn', 24.75, 59.44, true],
    ['ussr', 1980, 'Almaty', 76.9, 43.24, true],
    ['ussr', 1980, 'Kaliningrad', 20.51, 54.71, true],
    ['ussr', 1980, 'Warsaw', 21.01, 52.23, false], // a satellite is not a republic
    ['ussr', 1980, 'Kabul', 69.2, 34.53, false],
    ['ussr', 1980, 'Helsinki', 24.94, 60.17, false],

    // ROUND 64, the historical extents that are honestly unions of present
    // states at a dated peak: the Qing from 1800 (plus a hand ring for Outer
    // Manchuria, which is Russian today), the British Empire at 1900/1920/1947,
    // the French at 1900. The Raj no longer covers Nepal, the Qing's western
    // frontier is Xinjiang's real line, and the Scramble for Africa is drawn
    // with the partition lines the colonies kept.
    ['qing', 1850, 'Lhasa', 91.1, 29.65, true],
    ['qing', 1850, 'Kashgar', 75.99, 39.47, true],
    ['qing', 1850, 'Urga', 106.9, 47.9, true],
    ['qing', 1850, 'Blagoveshchensk, north of the Amur', 127.5, 50.6, true], // Qing until Aigun, 1858
    ['russia', 1850, 'Blagoveshchensk, north of the Amur', 127.5, 50.6, false],
    ['russia', 1870, 'Blagoveshchensk, north of the Amur', 127.5, 50.6, true],
    ['qing', 1890, 'Taipei', 121.52, 25.04, true], // Shimonoseki, 1895
    ['qing', 1900, 'Taipei', 121.52, 25.04, false],
    ['qing', 1850, 'Tashkent', 69.24, 41.3, false], // the steppe was never a province
    ['britain', 1905, 'Nairobi', 36.82, -1.29, true],
    ['britain', 1905, 'Kano', 8.52, 12.0, true],
    ['britain', 1905, 'Khartoum', 32.53, 15.6, true],
    ['britain', 1905, 'Kathmandu', 85.32, 27.71, false], // Nepal was never the Raj
    ['britain', 1905, 'Thimphu', 89.64, 27.47, false],
    ['britain', 1905, 'Colombo', 79.86, 6.93, true],
    ['britain', 1905, 'Addis Ababa', 38.74, 9.03, false], // Adwa held
    ['britain', 1905, 'Kinshasa', 15.3, -4.32, false],
    ['france', 1905, 'Timbuktu', -3.0, 16.77, true],
    ['france', 1905, 'Dakar', -17.45, 14.7, true],
    ['france', 1905, 'Hanoi', 105.85, 21.03, true],
    ['france', 1905, 'Antananarivo', 47.51, -18.88, true],
    ['france', 1905, 'Casablanca', -7.6, 33.57, false], // Morocco is 1912, and never drawn
    ['france', 1905, 'Monrovia', -10.8, 6.3, false],
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
    expect(b[0].ring).toEqual(square(3))
  })

  it('gives one entry per PIECE, in the keyframe order', () => {
    const rings = borderRings(rome, 200) // greatest extent: mainland + island
    expect(rings).toHaveLength(2)
    expect(rings.map((r) => r.ring)).toEqual([square(5), square(1)])
  })

  it('closes each ring exactly once, without touching the stored one', () => {
    const [entry] = borderRings(rome, -150)
    const open = square(1)
    expect(entry.coordinates).toHaveLength(1)
    expect(entry.coordinates[0]).toHaveLength(open.length + 1)
    expect(entry.coordinates[0][open.length]).toEqual(open[0])
    expect(entry.ring).toHaveLength(4) // the decoded ring is still open
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

  /**
   * ROUND 64: the SKETCH runs. An `approx` keyframe's estimated inland edges
   * ship as `approx` run-length flags beside the coastal ones, and the entry
   * splits its boundary three ways — solid frontier, sketch (drawn dashed),
   * coast — from ONE per-edge classification, so the three cannot overlap or
   * leave an edge unaccounted for.
   */
  it('splits the boundary into solid frontier, sketch and coast without overlap', () => {
    const ring = square(4)
    const n: Nation = {
      id: 'sketchy',
      name: 'Sketchy',
      color: '#4f8a86',
      from: 0,
      to: 100,
      visibleFrom: 0,
      visibleTo: 100,
      keyframes: [
        {
          time: 0,
          polys: [[encodeRing(ring)]],
          coast: [[[2, 1]]], // edge 2 is coast
          approx: [[[1, 1]]], // edge 1 is sketch
        },
      ],
    }
    const [entry] = borderRings(n, 50)
    expect(entry.frontier).toHaveLength(1) // edges 3+0 wrap into one run
    expect(entry.sketch).toHaveLength(1)
    expect(entry.coast).toHaveLength(1)
    // Every stored edge is in exactly one of the three sets. The runs are
    // densified, so compare by which stored corner each run starts near.
    expect(entry.sketch[0][0]).toEqual([4, 0]) // edge 1 leaves vertex 1
    expect(entry.coast[0][0]).toEqual([4, 4]) // edge 2 leaves vertex 2
  })
})

/**
 * THE CHORD AND THE ARC — round 55.
 *
 * A stored edge is two numbers however far apart they are, and the corpus is
 * full of authored frontiers that run tens of degrees in one step. Drawn as a
 * chord, such an edge passes under the sphere it is meant to lie on and the
 * planet eats it; handed to the polygon layer, it makes the layer interpolate a
 * great circle that leaves the planar ring its own triangle test is measured
 * against. Both defects are the reader's, both are fixed by densifying first,
 * and these are the assertions that keep it done.
 */
describe('borderRings densification', () => {
  /** Great-circle separation in degrees, the measure the layer tessellates by. */
  const sep = (a: Ring[number], b: Ring[number]) => {
    const R = Math.PI / 180
    const c =
      Math.sin(a[1] * R) * Math.sin(b[1] * R) +
      Math.cos(a[1] * R) * Math.cos(b[1] * R) * Math.cos((b[0] - a[0]) * R)
    return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI
  }
  /** How far below the unit sphere the middle of a chord at `alt` passes. */
  const sag = (a: Ring[number], b: Ring[number], alt: number) => {
    const R = Math.PI / 180
    const v = (p: Ring[number]) => {
      const c = Math.cos(p[1] * R)
      return [c * Math.sin(p[0] * R), Math.sin(p[1] * R), c * Math.cos(p[0] * R)].map(
        (k) => k * (1 + alt),
      )
    }
    const [va, vb] = [v(a), v(b)]
    const m = va.map((k, i) => (k + vb[i]) / 2)
    return 1 - Math.hypot(m[0], m[1], m[2])
  }

  const wide: Nation = {
    ...rome,
    id: 'wide',
    keyframes: [kf(-270, [[0, 0], [30, 0], [30, 10], [0, 10]] as Ring)],
  }

  it('cuts a long stored edge into arcs no longer than the cap resolution', () => {
    const [entry] = borderRings(wide, 0)
    const ring = entry.coordinates[0]
    expect(ring.length).toBeGreaterThan(5)
    for (let i = 0; i + 1 < ring.length; i++)
      expect(sep(ring[i], ring[i + 1])).toBeLessThanOrEqual(BORDER_SEGMENT_DEG + 1e-9)
  })

  it('leaves the stored ring alone — the codec is not re-encoded', () => {
    const [entry] = borderRings(wide, 0)
    expect(entry.ring).toHaveLength(4)
    expect(entry.ring[1]).toEqual([30, 0])
  })

  it('leaves a ring that is already fine enough untouched', () => {
    const [entry] = borderRings(rome, -150) // 1 deg edges
    expect(entry.coordinates[0]).toHaveLength(5)
  })

  it('keeps every stored vertex, in order', () => {
    const [entry] = borderRings(wide, 0)
    const ring = entry.coordinates[0]
    let at = -1
    for (const v of entry.ring) {
      const found = ring.findIndex((p, i) => i > at && p[0] === v[0] && p[1] === v[1])
      expect(found).toBeGreaterThan(at)
      at = found
    }
  })

  it('holds the ink above the planet where a raw chord would go under it', () => {
    const [entry] = borderRings(wide, 0)
    // The stored edge: 30 deg of arc, and its chord at the altitude this ink is
    // built at is buried. Round 63b renamed the constant and lowered it: the ink
    // is grounded and lifted against the camera now, so what this guards is the
    // SOURCE data — that no stored edge is long enough for its chord to leave
    // the planet's surface at any height this layer ever draws at.
    expect(sag([0, 0], [30, 0], FRONTIER_BUILD_ALT)).toBeGreaterThan(FRONTIER_BUILD_ALT)
    // Every drawn segment of it is not.
    const runs = entry.frontier
    expect(runs.length).toBeGreaterThan(0)
    for (const run of runs)
      for (let i = 0; i + 1 < run.length; i++)
        expect(sag(run[i], run[i + 1], FRONTIER_BUILD_ALT)).toBeLessThan(0)
  })

  it('densifies the frontier and the cap with the same stepping', () => {
    // The ink must be vertices OF the fill's contour, not a second curve
    // through the same endpoints — see BORDER_SEGMENT_DEG.
    const [entry] = borderRings(wide, 0)
    const onCap = new Set(entry.coordinates[0].map((p) => `${p[0]},${p[1]}`))
    for (const run of entry.frontier)
      for (const p of run) expect(onCap.has(`${p[0]},${p[1]}`)).toBe(true)
  })

  it('leaves the shipped corpus with no edge the polygon layer must interpolate', () => {
    let edges = 0
    for (const n of clippedFile.nations as unknown as Nation[])
      for (const t of n.keyframes.map((k) => k.time))
        for (const entry of borderRings(n, t)) {
          for (const ring of entry.coordinates)
            for (let i = 0; i + 1 < ring.length; i++) {
              edges++
              expect(sep(ring[i], ring[i + 1])).toBeLessThanOrEqual(BORDER_SEGMENT_DEG + 1e-6)
            }
          for (const run of entry.frontier)
            for (let i = 0; i + 1 < run.length; i++)
              expect(sag(run[i], run[i + 1], FRONTIER_BUILD_ALT)).toBeLessThan(0)
        }
    expect(edges).toBeGreaterThan(50_000)
  }, 60_000)
})
