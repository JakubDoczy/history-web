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
