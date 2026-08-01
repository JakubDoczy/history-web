import { describe, it, expect } from 'vitest'
import {
  SCOPE_MARGIN,
  SCOPE_PAN_STEP,
  cameraScope,
  quantiseScope,
  sameScope,
  scopeRadiusBucket,
} from '../src/lib/viewport'
import { separationDeg } from '../src/lib/queryIndex'
import { viewSpanDeg, visibleSpanDeg } from '../src/lib/detailImagery'

const DEFAULT_ALTITUDE = 2.5

describe('cameraScope threshold', () => {
  it('is undefined at the default view — the frame holds the whole globe', () => {
    expect(cameraScope({ lat: 0, lng: 0, altitude: DEFAULT_ALTITUDE, aspect: 1.6 })).toBeUndefined()
  })

  it('is still undefined at half the default altitude', () => {
    // the frame is wider than the visible disc well past the default view, so
    // there is a comfortable margin before anything changes
    expect(cameraScope({ lat: 0, lng: 0, altitude: 1.2, aspect: 1.6 })).toBeUndefined()
  })

  it('engages once the frame no longer reaches the horizon', () => {
    const scope = cameraScope({ lat: 48, lng: 2, altitude: 0.4, aspect: 1.6 })
    expect(scope).toBeDefined()
    expect(scope!.radiusDeg).toBeLessThan(visibleSpanDeg(0.4) / 2)
  })

  it('tightens monotonically as the camera comes in', () => {
    const radii = [0.4, 0.2, 0.05, 0.01].map(
      (altitude) => cameraScope({ lat: 0, lng: 0, altitude, aspect: 1.6 })!.radiusDeg,
    )
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeLessThan(radii[i - 1])
  })

  it('crosses over continuously: the first scoped circle is the whole visible disc', () => {
    // walk down until the scope appears; it must arrive as wide as the horizon
    let alt = 1.2
    let scope = cameraScope({ lat: 0, lng: 0, altitude: alt, aspect: 1.6 })
    while (!scope && alt > 0.01) {
      alt *= 0.98
      scope = cameraScope({ lat: 0, lng: 0, altitude: alt, aspect: 1.6 })
    }
    expect(scope).toBeDefined()
    // within one quantisation bucket (a half octave) of the horizon radius
    expect(scope!.radiusDeg).toBeGreaterThan((visibleSpanDeg(alt) / 2) * 0.7)
  })
})

describe('scope covers the frame', () => {
  /**
   * The property the whole design rests on: no pin the camera can see may fall
   * outside the circle the query runs in — margin, corner and the error the
   * quantisation grid introduces, all together.
   */
  it('contains every frame corner after quantisation, at every zoom and latitude', () => {
    for (const altitude of [0.4, 0.2, 0.08, 0.03, 0.008, 0.002]) {
      for (const aspect of [0.6, 1, 1.6, 2.4]) {
        for (const lat of [0, 23.7, 51.3, 79.9, -64.2]) {
          for (const lng of [0, 37.4, 179.3, -122.6]) {
            const scope = cameraScope({ lat, lng, altitude, aspect })
            if (!scope) continue
            const half = viewSpanDeg(altitude, 50) / 2
            const halfW = half * aspect
            // the four corners of the frame, as ground offsets from its centre
            for (const [dLat, dLng] of [
              [half, halfW],
              [half, -halfW],
              [-half, halfW],
              [-half, -halfW],
            ]) {
              const cornerLat = Math.max(-90, Math.min(90, lat + dLat))
              // longitude offsets stretch with latitude, which is the worst case
              const cornerLng = lng + dLng / Math.max(0.15, Math.cos((cornerLat * Math.PI) / 180))
              const d = separationDeg(scope.lat, scope.lng, cornerLat, cornerLng)
              expect(d).toBeLessThanOrEqual(scope.radiusDeg + 1e-9)
            }
          }
        }
      }
    }
  })
})

describe('quantisation', () => {
  it('rounds the radius up, never down', () => {
    for (const r of [0.013, 0.4, 1, 7.3, 41]) expect(scopeRadiusBucket(r)).toBeGreaterThanOrEqual(r)
  })

  it('uses half-octave buckets, so a zoom crosses a handful of them per octave', () => {
    expect(scopeRadiusBucket(8)).toBe(8)
    expect(scopeRadiusBucket(8.1)).toBeCloseTo(2 ** 3.5, 9)
    expect(scopeRadiusBucket(2 ** 3.5 + 0.01)).toBe(16)
  })

  it('holds still under a nudge and moves on a real pan', () => {
    const at = (lat: number, lng: number) =>
      cameraScope({ lat, lng, altitude: 0.02, aspect: 1.6 })!
    const base = at(48, 2)
    const step = base.radiusDeg * SCOPE_PAN_STEP
    expect(sameScope(base, at(48 + step * 0.2, 2))).toBe(true)
    expect(sameScope(base, at(48, 2 + step * 0.2))).toBe(true)
    expect(sameScope(base, at(48 + step * 1.5, 2))).toBe(false)
  })

  it('holds still under a zoom nudge and moves across a bucket', () => {
    const at = (altitude: number) => cameraScope({ lat: 0, lng: 0, altitude, aspect: 1.6 })!
    expect(sameScope(at(0.02), at(0.0201))).toBe(true)
    expect(sameScope(at(0.02), at(0.005))).toBe(false)
  })

  it('a slow pan re-cuts the scope a few times per screen width, not per frame', () => {
    const altitude = 0.02
    const width = viewSpanDeg(altitude, 50) * 1.6 // one screen width of ground
    let cuts = 0
    let held = cameraScope({ lat: 0, lng: 0, altitude, aspect: 1.6 })
    // sixty samples: one screen width of panning at a frame apiece
    for (let i = 1; i <= 60; i++) {
      const next = cameraScope({ lat: 0, lng: (i / 60) * width, altitude, aspect: 1.6 })
      if (!sameScope(held, next)) cuts++
      held = next
    }
    expect(cuts).toBeGreaterThan(0)
    expect(cuts).toBeLessThanOrEqual(8)
  })

  it('keeps longitude in (−180, 180] across the seam', () => {
    const s = quantiseScope({ lat: 0, lng: 179.9, radiusDeg: 1 })
    expect(s.lng).toBeGreaterThan(-180)
    expect(s.lng).toBeLessThanOrEqual(180)
  })

  it('clamps latitude at the poles', () => {
    expect(quantiseScope({ lat: 89.9, lng: 0, radiusDeg: 8 }).lat).toBeLessThanOrEqual(90)
    expect(quantiseScope({ lat: -89.9, lng: 0, radiusDeg: 8 }).lat).toBeGreaterThanOrEqual(-90)
  })

  it('the margin leaves room for the snap it is sized against', () => {
    // half a pan step of centre error must still fit inside the margin
    expect(SCOPE_MARGIN * (1 - SCOPE_PAN_STEP / 2)).toBeGreaterThan(1)
  })
})

describe('sameScope', () => {
  it('compares by value, and treats world view as equal to itself', () => {
    expect(sameScope(undefined, undefined)).toBe(true)
    expect(sameScope(undefined, { lat: 0, lng: 0, radiusDeg: 1 })).toBe(false)
    expect(sameScope({ lat: 1, lng: 2, radiusDeg: 3 }, { lat: 1, lng: 2, radiusDeg: 3 })).toBe(true)
    expect(sameScope({ lat: 1, lng: 2, radiusDeg: 3 }, { lat: 1, lng: 2, radiusDeg: 4 })).toBe(false)
  })
})
