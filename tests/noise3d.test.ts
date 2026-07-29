import { describe, it, expect } from 'vitest'
import { buildNoiseVolume } from '../src/clouds/noise3d'

describe('buildNoiseVolume', () => {
  const size = 16
  const vol = buildNoiseVolume(size, 3)

  it('fills two channels for every texel', () => {
    expect(vol.length).toBe(size ** 3 * 2)
  })

  it('is deterministic for a seed and varies across seeds', () => {
    expect([...buildNoiseVolume(8, 5)]).toEqual([...buildNoiseVolume(8, 5)])
    expect([...buildNoiseVolume(8, 5)]).not.toEqual([...buildNoiseVolume(8, 6)])
  })

  it('uses a healthy dynamic range rather than a flat field', () => {
    const base = vol.filter((_, i) => i % 2 === 0)
    const mean = base.reduce((a, b) => a + b, 0) / base.length
    const spread = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / base.length)
    expect(mean).toBeGreaterThan(20)
    expect(mean).toBeLessThan(235)
    expect(spread).toBeGreaterThan(15) // genuinely varying, not near-constant
  })

  it('wraps seamlessly: opposite faces are near-identical', () => {
    const at = (x: number, y: number, z: number, ch: number) =>
      vol[((z * size + y) * size + x) * 2 + ch]
    // texel 0 and texel `size` are the same point in the tiling lattice, so the
    // last texel must be close to the first, not an arbitrary jump
    let diff = 0
    for (let y = 0; y < size; y++)
      for (let z = 0; z < size; z++) diff += Math.abs(at(0, y, z, 0) - at(size - 1, y, z, 0))
    expect(diff / (size * size)).toBeLessThan(60)
  })
})
