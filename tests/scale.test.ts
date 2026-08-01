import { describe, it, expect } from 'vitest'
import {
  kmPerPixel,
  niceScale,
  formatDistance,
  cloudFadeFor,
  cloudSharpenFor,
  CLOUD_SHARPEN_MAX,
  EARTH_RADIUS_KM,
  driftIntervalMs,
  DRIFT_MS_MIN,
  DRIFT_MS_MAX,
  DRIFT_STEP_PX,
  CLOUD_DRIFT_UV_PER_S,
} from '../src/lib/scale'
import { viewSpanDeg } from '../src/lib/detailImagery'

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

/**
 * The idle drift rate.
 *
 * A still globe with clouds on it is the one thing that keeps this app
 * rendering when nobody is touching it. The rate used to be a constant 20 Hz;
 * these pin down the rule that replaced it — a fixed amount of *screen*
 * movement per step, which is the thing an eye can or cannot resolve.
 */
describe('driftIntervalMs', () => {
  const PX = 900

  it('moves the deck by the stated number of pixels per step', () => {
    // the definition, restated independently: degrees per second, times pixels
    // per degree, times the interval, is the step in pixels
    for (const span of [12, 40, 90, 147]) {
      const ms = driftIntervalMs(span, PX)
      if (ms === DRIFT_MS_MIN || ms === DRIFT_MS_MAX) continue // clamped, see below
      const pxPerSec = CLOUD_DRIFT_UV_PER_S * 360 * (PX / span)
      expect((pxPerSec * ms) / 1000).toBeCloseTo(DRIFT_STEP_PX, 6)
    }
  })

  it('slows down as the view widens', () => {
    let previous = 0
    for (const span of [10, 20, 40, 60, 90, 120, 150, 180]) {
      const ms = driftIntervalMs(span, PX)
      expect(ms).toBeGreaterThanOrEqual(previous)
      previous = ms
    }
  })

  it('is never faster than the fixed rate it replaced', () => {
    // the point of the change is to draw *less*; a rule that could ask for more
    // frames than 20 Hz would be a regression dressed as an optimisation
    for (let span = 0.5; span <= 200; span += 0.5) {
      const ms = driftIntervalMs(span, PX)
      expect(ms).toBeGreaterThanOrEqual(DRIFT_MS_MIN)
      expect(ms).toBeLessThanOrEqual(DRIFT_MS_MAX)
    }
    // and a degenerate viewport cannot produce a zero or negative interval
    expect(driftIntervalMs(0, PX)).toBe(DRIFT_MS_MIN)
    expect(driftIntervalMs(90, 0)).toBe(DRIFT_MS_MAX)
  })

  it('cuts the default view to well under half the old rate', () => {
    // globe.gl opens at altitude 2.5; this is the view the globe idles at, and
    // the whole reason the fixed rate was worth revisiting
    const ms = driftIntervalMs(viewSpanDeg(2.5), PX)
    expect(ms).toBeGreaterThan(2 * DRIFT_MS_MIN)
    expect(1000 / ms).toBeLessThan(10) // frames per second, against 20
  })

  it('leaves the closest views the clouds reach exactly as they were', () => {
    // clouds fade out by 55° of horizon (cloudFadeFor), which is a framed span
    // of a few degrees — there the deck really does cross pixels quickly, and
    // the floor keeps the rate where it is rather than raising it
    for (const altitude of [0.15, 0.25, 0.4, 0.7]) {
      // still drawing clouds at all of these...
      expect(cloudFadeFor(2 * Math.acos(1 / (1 + altitude)) * (180 / Math.PI)))
        .toBeGreaterThan(0)
      // ...and the rate there is exactly what it has always been
      expect(driftIntervalMs(viewSpanDeg(altitude), PX)).toBe(DRIFT_MS_MIN)
    }
  })
})
