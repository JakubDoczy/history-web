import { describe, it, expect } from 'vitest'
import { activeKeyframe, extremes, ringArea, type Nation, type Ring } from '../src/lib/nations'

const square = (size: number): Ring => [[0, 0], [size, 0], [size, size], [0, size]]

const rome: Nation = {
  id: 'rome',
  name: 'Rome',
  color: '#c33',
  end: 476,
  keyframes: [
    { time: -500, ring: square(1) },
    { time: -100, ring: square(3) },
    { time: 117, ring: square(5) }, // greatest extent
    { time: 300, ring: square(4) },
  ],
}

describe('activeKeyframe (hold-last semantics)', () => {
  it('holds the last keyframe until the next one', () => {
    expect(activeKeyframe(rome, -200)?.time).toBe(-500)
    expect(activeKeyframe(rome, -100)?.time).toBe(-100)
    expect(activeKeyframe(rome, 200)?.time).toBe(117)
  })
  it('is undefined before first keyframe and after end', () => {
    expect(activeKeyframe(rome, -1000)).toBeUndefined()
    expect(activeKeyframe(rome, 477)).toBeUndefined()
    expect(activeKeyframe(rome, 476)?.time).toBe(300) // inclusive end
  })
})

describe('ringArea', () => {
  it('computes shoelace area regardless of closure', () => {
    expect(ringArea(square(2))).toBe(4)
    expect(ringArea([...square(2), [0, 0]])).toBe(4) // explicitly closed → same
  })
})

describe('extremes', () => {
  it('picks largest and smallest snapshot active in the window', () => {
    const { max, min } = extremes(rome, -150, 200)
    expect(max?.time).toBe(117)
    expect(min?.time).toBe(-500) // still in force at window start
  })
  it('window fully inside one keyframe → max === min', () => {
    const { max, min } = extremes(rome, 150, 200)
    expect(max).toBe(min)
    expect(max?.time).toBe(117)
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
 * wrong hemisphere, and a three-digit colour turns into an invalid eight-digit
 * hex once the polygon layer appends its alpha.
 */
describe('nations.json', () => {
  const nations = rawNations as Nation[]

  it('ships the nations the globe expects to draw', () => {
    expect(nations.length).toBeGreaterThanOrEqual(14)
    expect(new Set(nations.map((n) => n.id)).size).toBe(nations.length)
  })

  it.each(nations.map((n) => [n.id, n] as const))('%s has usable keyframes', (_id, n) => {
    expect(n.keyframes.length).toBeGreaterThan(0)
    for (let i = 1; i < n.keyframes.length; i++) {
      expect(n.keyframes[i].time).toBeGreaterThan(n.keyframes[i - 1].time)
    }
    // a nation whose last border postdates its end can never be drawn
    if (n.end !== undefined) expect(n.keyframes[0].time).toBeLessThanOrEqual(n.end)
    expect(activeKeyframe(n, n.keyframes[0].time)).toBe(n.keyframes[0])
  })

  it.each(nations.map((n) => [n.id, n] as const))('%s has rings in [lng, lat] order', (_id, n) => {
    for (const k of n.keyframes) {
      expect(k.ring.length).toBeGreaterThanOrEqual(3)
      for (const [lng, lat] of k.ring) {
        expect(Math.abs(lng)).toBeLessThanOrEqual(180)
        expect(Math.abs(lat)).toBeLessThanOrEqual(90)
      }
      // rings are left open; the globe layer closes them itself, and a ring
      // closed twice draws a degenerate final edge
      const [first, last] = [k.ring[0], k.ring[k.ring.length - 1]]
      expect(first).not.toEqual(last)
      expect(ringArea(k.ring)).toBeGreaterThan(0) // not a line or a single point
    }
  })

  it.each(nations.map((n) => [n.id, n] as const))('%s has a six-digit colour', (_id, n) => {
    // the polygon layer builds fills as `color + '50'`, which only parses from six
    expect(n.color).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
