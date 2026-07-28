import { describe, it, expect } from 'vitest'
import { subsolarLongitude } from '../src/lib/sun'

describe('subsolarLongitude', () => {
  it.each([
    [12, 0],    // noon UTC → sun over Greenwich
    [18, -90],  // 18:00 UTC → sun over 90°W
    [6, 90],    // 06:00 UTC → sun over 90°E
    [0, 180],   // midnight UTC → antimeridian
  ])('hour %d → lng %d', (h, lng) => expect(subsolarLongitude(h)).toBe(((lng + 540) % 360) - 180))
  it('wraps into [-180, 180)', () => {
    for (let h = 0; h <= 24; h += 0.5) {
      const l = subsolarLongitude(h)
      expect(l).toBeGreaterThanOrEqual(-180)
      expect(l).toBeLessThan(180)
    }
  })
})
