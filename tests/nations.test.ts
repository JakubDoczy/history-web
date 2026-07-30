import { describe, it, expect } from 'vitest'
import {
  activeKeyframe,
  extremes,
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

describe('extremes', () => {
  it('picks largest and smallest keyframe active in the window', () => {
    const { max, min } = extremes(rome, -150, 200)
    expect(max?.time).toBe(117)
    expect(min?.time).toBe(-270) // still in force at window start
  })
  it('window fully inside one keyframe → max === min', () => {
    const { max, min } = extremes(rome, 150, 200)
    expect(max).toBe(min)
    expect(max?.time).toBe(117)
  })
  it('sees the first keyframe from the start of existence', () => {
    expect(extremes(rome, -509, -400).max?.time).toBe(-270)
  })
  it('empty outside existence', () => {
    expect(extremes(rome, 1000, 2000)).toEqual({})
    expect(extremes(rome, -2000, -1000)).toEqual({})
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
