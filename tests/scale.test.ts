import { describe, it, expect } from 'vitest'
import {
  kmPerPixel,
  niceScale,
  formatDistance,
  cloudFadeFor,
  cloudSharpenFor,
  CLOUD_SHARPEN_MAX,
  EARTH_RADIUS_KM,
  cloudDriftPhase,
  cloudIdleIntervalMs,
  CLOUD_IDLE_HZ,
  CLOUD_IDLE_STEP_PX,
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
 * The idle drift clock and cadence.
 *
 * A still globe with clouds on it is the one thing that keeps this app
 * rendering when nobody is touching it, and the two questions — *where* is the
 * deck and *how often* to draw it — used to be answered by one timer. They are
 * separate here, and these pin down both halves: the phase is a pure function
 * of the clock (so no frame can ever be stale, whatever caused it), and the
 * cadence is a plain rate chosen for smoothness with a deep sleep under it.
 */
describe('cloudDriftPhase', () => {
  it('is exactly linear in wall-clock time', () => {
    // the property the whole fix rests on: displacement depends only on how
    // much time passed, never on how many frames were drawn in between
    for (const [a, b] of [[0, 100], [100, 200], [5_000, 5_100], [61_000, 61_100]]) {
      const d = cloudDriftPhase(b) - cloudDriftPhase(a)
      expect(d).toBeCloseTo(((b - a) / 1000) * CLOUD_DRIFT_UV_PER_S, 12)
    }
  })

  it('advances at the stated speed', () => {
    expect(cloudDriftPhase(1000)).toBeCloseTo(CLOUD_DRIFT_UV_PER_S, 12)
    expect(cloudDriftPhase(0)).toBe(0)
  })

  it('never leaves [0, 1), however long the session', () => {
    // a full wrap takes 625 s; the shader fract()s it again, so the wrap point
    // is invisible, but the uniform must not grow without bound
    for (const ms of [0, 1e3, 1e5, 1e7, 1e9, 3.15e10]) {
      const p = cloudDriftPhase(ms)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(1)
    }
  })

  it('is monotonic across a wrap, modulo the wrap itself', () => {
    const period = 1000 / CLOUD_DRIFT_UV_PER_S
    let previous = -1
    for (let ms = 0; ms < period; ms += period / 500) {
      const p = cloudDriftPhase(ms)
      expect(p).toBeGreaterThan(previous)
      previous = p
    }
    expect(cloudDriftPhase(period)).toBeCloseTo(0, 9)
  })

  it('stays sane if the clock hands it a negative elapsed time', () => {
    expect(cloudDriftPhase(-100)).toBeGreaterThanOrEqual(0)
    expect(cloudDriftPhase(-100)).toBeLessThan(1)
  })
})

describe('cloudIdleIntervalMs', () => {
  const PX = 900
  const idle = (o: Partial<Parameters<typeof cloudIdleIntervalMs>[0]> = {}) =>
    cloudIdleIntervalMs({
      cloudsShown: true,
      reducedMotion: false,
      viewSpanDeg: viewSpanDeg(2.5),
      viewportPx: PX,
      ...o,
    })

  it('draws a visible drifting deck at the smoothness rate', () => {
    // the default view: the deck is slow there, so the rate is the ceiling
    expect(idle()).toBe(1000 / CLOUD_IDLE_HZ)
  })

  it('never asks for fewer frames than that, at any zoom', () => {
    for (const altitude of [0.15, 0.25, 0.4, 0.7, 1.0, 1.6, 2.5, 4]) {
      expect(idle({ viewSpanDeg: viewSpanDeg(altitude) })!).toBeLessThanOrEqual(
        1000 / CLOUD_IDLE_HZ + 1e-9,
      )
    }
    // and a degenerate viewport cannot produce a zero or negative interval
    expect(idle({ viewSpanDeg: 0 })!).toBeGreaterThan(0)
    expect(idle({ viewportPx: 0 })!).toBe(1000 / CLOUD_IDLE_HZ)
  })

  it('keeps a frame well under a pixel of deck movement at every zoom', () => {
    // the reported stagger was 0.4 px a step at 8-9 Hz; the eye reads motion as
    // a sequence of positions somewhere around a pixel a frame, so the cadence
    // has to hold the step beneath that even at the closest view the film
    // survives to, where the deck crosses 64 px/s
    for (const altitude of [0.15, 0.4, 1.0, 2.5]) {
      const span = viewSpanDeg(altitude)
      const ms = idle({ viewSpanDeg: span })!
      const pxPerSec = CLOUD_DRIFT_UV_PER_S * 360 * (PX / span)
      expect((pxPerSec * ms) / 1000).toBeLessThanOrEqual(CLOUD_IDLE_STEP_PX + 1e-9)
      expect(CLOUD_IDLE_STEP_PX).toBeLessThan(1)
    }
    // and at the view the globe idles at, a tenth of a pixel
    const idleSpan = viewSpanDeg(2.5)
    expect((CLOUD_DRIFT_UV_PER_S * 360 * (PX / idleSpan) * idle()!) / 1000).toBeLessThan(0.2)
  })

  it('asks for more frames as the camera closes in, never fewer', () => {
    let previous = Infinity
    for (const altitude of [4, 2.5, 1.6, 1.0, 0.7, 0.4, 0.25, 0.15]) {
      const ms = idle({ viewSpanDeg: viewSpanDeg(altitude) })!
      expect(ms).toBeLessThanOrEqual(previous)
      previous = ms
    }
  })

  it('sleeps outright when no film is on screen', () => {
    // deep time, the setting off, or a close approach: nothing is animating, so
    // the pump must park rather than redraw an identical picture 30 times a
    // second
    expect(idle({ cloudsShown: false })).toBeNull()
  })

  it('sleeps outright under prefers-reduced-motion', () => {
    expect(idle({ reducedMotion: true })).toBeNull()
    expect(idle({ cloudsShown: false, reducedMotion: true })).toBeNull()
  })

  it('costs less than a full-rate loop for motion nothing can distinguish', () => {
    // the battery half of the decision: at the view the globe idles at this is
    // half the frames of 60 Hz, for a per-frame displacement of 0.12 px against
    // 0.06 px
    expect(CLOUD_IDLE_HZ).toBeLessThanOrEqual(30)
    expect(CLOUD_IDLE_HZ).toBeGreaterThanOrEqual(24)
  })
})
