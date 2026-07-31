import { describe, it, expect } from 'vitest'
import {
  kmPerPixel,
  niceScale,
  formatDistance,
  cloudFadeFor,
  cloudSharpenFor,
  CLOUD_SHARPEN_MAX,
  EARTH_RADIUS_KM,
} from '../src/lib/scale'

describe('kmPerPixel', () => {
  it('scales linearly with altitude', () => {
    const a = kmPerPixel(0.1, 50, 800)
    const b = kmPerPixel(0.2, 50, 800)
    expect(b / a).toBeCloseTo(2)
  })
  it('shrinks as the viewport grows', () => {
    expect(kmPerPixel(0.1, 50, 1600)).toBeCloseTo(kmPerPixel(0.1, 50, 800) / 2)
  })
  it('gives a sane figure for a familiar view', () => {
    // one Earth radius up, 50° fov, 900 px tall: a few km per pixel
    const v = kmPerPixel(1, 50, 900)
    expect(v).toBeGreaterThan(1)
    expect(v).toBeLessThan(20)
    expect(v).toBeLessThan(EARTH_RADIUS_KM)
  })
})

describe('niceScale', () => {
  it('always picks a 1, 2 or 5 mantissa', () => {
    for (const kmPerPx of [0.002, 0.05, 0.3, 1, 7, 55, 900]) {
      const { km } = niceScale(kmPerPx)
      const mantissa = km / 10 ** Math.floor(Math.log10(km))
      expect([1, 2, 5]).toContain(Math.round(mantissa))
    }
  })
  it('never exceeds the pixel budget', () => {
    for (const kmPerPx of [0.002, 0.05, 0.3, 1, 7, 55, 900]) {
      expect(niceScale(kmPerPx, 130).px).toBeLessThanOrEqual(130.0001)
    }
  })
  it('gives a usefully long bar rather than a stub', () => {
    for (const kmPerPx of [0.05, 1, 55]) {
      expect(niceScale(kmPerPx, 130).px).toBeGreaterThan(20)
    }
  })
  it('reports a shorter distance as you zoom in', () => {
    expect(niceScale(0.05).km).toBeLessThan(niceScale(5).km)
  })
})

describe('formatDistance', () => {
  it.each([
    [0.5, '500 m'],
    [1, '1 km'],
    [2000, '2,000 km'],
  ])('%s → %s', (km, s) => expect(formatDistance(km)).toBe(s))
})


describe('cloudFadeFor', () => {
  it('shows clouds fully when the whole disc is in view', () => {
    expect(cloudFadeFor(147)).toBe(1) // default framing
    expect(cloudFadeFor(100)).toBe(1)
  })
  it('retires them before the surface fills the screen', () => {
    expect(cloudFadeFor(55)).toBe(0)
    expect(cloudFadeFor(20)).toBe(0)
  })
  it('fades smoothly in between, never outside 0..1', () => {
    const mid = cloudFadeFor(77)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    for (const span of [0, 10, 55, 77, 100, 180]) {
      expect(cloudFadeFor(span)).toBeGreaterThanOrEqual(0)
      expect(cloudFadeFor(span)).toBeLessThanOrEqual(1)
    }
  })
})

describe('cloudSharpenFor', () => {
  it('is off when a cloud texel is smaller than a pixel', () => {
    expect(cloudSharpenFor(147)).toBe(0) // default framing
    expect(cloudSharpenFor(120)).toBe(0)
  })

  it('is at full strength before the clouds have finished fading out', () => {
    expect(cloudSharpenFor(60)).toBe(CLOUD_SHARPEN_MAX)
    expect(cloudSharpenFor(55)).toBe(CLOUD_SHARPEN_MAX)
  })

  it('covers the band where clouds are still drawn and being magnified', () => {
    // anywhere cloudFadeFor still shows clouds below 120°, something is sharpened
    for (const span of [100, 90, 80, 70, 60]) {
      expect(cloudFadeFor(span)).toBeGreaterThan(0)
      expect(cloudSharpenFor(span)).toBeGreaterThan(0)
    }
  })

  it('rises monotonically as the camera closes in, and stays subtle', () => {
    let previous = -1
    for (let span = 200; span >= 1; span -= 1) {
      const k = cloudSharpenFor(span)
      expect(k).toBeGreaterThanOrEqual(previous)
      expect(k).toBeLessThanOrEqual(CLOUD_SHARPEN_MAX)
      previous = k
    }
    expect(CLOUD_SHARPEN_MAX).toBeLessThan(1) // an unsharp this big rings visibly
  })
})
