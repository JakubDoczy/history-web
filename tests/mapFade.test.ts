import { describe, it, expect } from 'vitest'
import { fadeTowards, MAP_FADE_MS } from '../src/lib/mapFade'

describe('fadeTowards', () => {
  it('reaches the target, rather than approaching it forever', () => {
    // an exponential approach never arrives, so the relief strength would sit
    // fractionally under the setting for ever and every frame would keep
    // writing a new uniform
    let v = 0
    for (let i = 0; i < 40; i++) v = fadeTowards(v, 1, 16)
    expect(v).toBe(1)
  })

  it('takes the stated time at a steady frame rate', () => {
    let v = 0
    let frames = 0
    while (v < 1 && frames < 1000) {
      v = fadeTowards(v, 1, 10)
      frames++
    }
    expect(frames * 10).toBeGreaterThanOrEqual(MAP_FADE_MS * 0.95)
    expect(frames * 10).toBeLessThanOrEqual(MAP_FADE_MS * 1.15)
  })

  it('cannot overshoot after a long stall', () => {
    // a tab hidden for a minute comes back with the fade finished, not with a
    // ramp that ran to 40
    expect(fadeTowards(0, 1, 60_000)).toBe(1)
    expect(fadeTowards(1, 0, 60_000)).toBe(0)
  })

  it('goes back down as readily as up', () => {
    expect(fadeTowards(1, 0, MAP_FADE_MS / 2)).toBeCloseTo(0.5, 6)
  })

  it('ignores a negative or absent frame time', () => {
    expect(fadeTowards(0.4, 1, -5)).toBe(0.4)
    expect(fadeTowards(0.4, 1, 0)).toBe(0.4)
  })
})
