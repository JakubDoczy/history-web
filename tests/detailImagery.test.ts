import { describe, it, expect } from 'vitest'
import {
  viewBbox,
  bboxToUvRect,
  imageSize,
  visibleSpanDeg,
  minAltitudeFor,
  IMAGERY_ERA_FROM,
  MIN_ALTITUDE_DETAIL,
  MIN_ALTITUDE_PLAIN,
  PATCH_ON_BELOW,
  PATCH_OFF_ABOVE,
} from '../src/lib/detailImagery'

describe('viewBbox', () => {
  it('is centred on the requested point', () => {
    for (const [lat, lng] of [[0, 0], [60, 10], [-33, 151], [45, -100]] as const) {
      const b = viewBbox(lat, lng, 0.02)
      expect((b.minLat + b.maxLat) / 2).toBeCloseTo(lat, 6)
      expect((b.minLng + b.maxLng) / 2).toBeCloseTo(lng, 6)
    }
  })

  it('shrinks as the camera descends', () => {
    const spans = [0.5, 0.1, 0.02, 0.004].map((a) => {
      const b = viewBbox(0, 0, a)
      return b.maxLat - b.minLat
    })
    for (let i = 1; i < spans.length; i++) expect(spans[i]).toBeLessThan(spans[i - 1])
  })

  it('widens in longitude at high latitude to cover square ground', () => {
    const equator = viewBbox(0, 0, 0.02)
    const arctic = viewBbox(70, 0, 0.02)
    expect(arctic.maxLng - arctic.minLng).toBeGreaterThan(equator.maxLng - equator.minLng)
  })

  it('never leaves valid geographic bounds', () => {
    for (const [lat, lng] of [[89.9, 179.9], [-89.9, -179.9], [90, 180], [-90, -180]] as const) {
      const b = viewBbox(lat, lng, 0.3)
      expect(b.minLat).toBeGreaterThanOrEqual(-90)
      expect(b.maxLat).toBeLessThanOrEqual(90)
      expect(b.minLng).toBeGreaterThanOrEqual(-180)
      expect(b.maxLng).toBeLessThanOrEqual(180)
      expect(b.maxLat).toBeGreaterThan(b.minLat)
      expect(b.maxLng).toBeGreaterThan(b.minLng)
    }
  })
})

describe('bboxToUvRect', () => {
  it('maps the whole world to the unit square', () => {
    expect(bboxToUvRect({ minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 })).toEqual([0, 0, 1, 1])
  })

  it('places a rectangle where the globe UV convention says it belongs', () => {
    // verified against three.js SphereGeometry: u=(lng+180)/360, v=(lat+90)/180
    const [u0, v0, du, dv] = bboxToUvRect({ minLat: 0, minLng: 0, maxLat: 45, maxLng: 90 })
    expect(u0).toBeCloseTo(0.5)
    expect(v0).toBeCloseTo(0.5)
    expect(du).toBeCloseTo(0.25)
    expect(dv).toBeCloseTo(0.25)
  })

  it('round-trips the view centre to the middle of the patch', () => {
    for (const [lat, lng] of [[60, 10], [-33, 151], [25, 15]] as const) {
      const [u0, v0, du, dv] = bboxToUvRect(viewBbox(lat, lng, 0.02))
      expect((lng + 180) / 360).toBeCloseTo(u0 + du / 2, 6)
      expect((lat + 90) / 180).toBeCloseTo(v0 + dv / 2, 6)
    }
  })
})

describe('imageSize', () => {
  it('keeps degrees-per-pixel consistent across both axes', () => {
    const b = viewBbox(45, 10, 0.02)
    const { width, height } = imageSize(b, 900)
    const perPxX = (b.maxLng - b.minLng) / width
    const perPxY = (b.maxLat - b.minLat) / height
    expect(perPxY / perPxX).toBeCloseTo(1, 1)
  })

  it('respects the hard pixel ceiling', () => {
    const b = viewBbox(0, 0, 0.3)
    const { width, height } = imageSize(b, 8000, 2048)
    expect(width).toBeLessThanOrEqual(2048)
    expect(height).toBeLessThanOrEqual(2048)
  })

  it('never asks a source for more detail than it holds', () => {
    // a tight view of a 500 m source: more pixels would only be upsampled blur
    const b = viewBbox(0, 0, 0.002)
    const { width } = imageSize(b, 4000, 2560, 222)
    const lngSpan = b.maxLng - b.minLng
    expect(width).toBeLessThanOrEqual(Math.ceil(lngSpan * 222) + 384)
    expect(width).toBeLessThan(2560) // and so stays quick to fetch
  })
})

describe('patch visibility thresholds', () => {
  it('uses hysteresis so hovering near the threshold cannot flicker', () => {
    expect(PATCH_OFF_ABOVE).toBeGreaterThan(PATCH_ON_BELOW)
    expect(PATCH_OFF_ABOVE - PATCH_ON_BELOW).toBeGreaterThanOrEqual(10)
  })
})

describe('zoom limits', () => {
  it('allows close zoom only within the satellite era', () => {
    expect(minAltitudeFor(2000, true)).toBe(MIN_ALTITUDE_DETAIL)
    expect(minAltitudeFor(IMAGERY_ERA_FROM, true)).toBe(MIN_ALTITUDE_DETAIL)
    for (const year of [1929, 1800, -250e6]) {
      expect(minAltitudeFor(year, true)).toBe(MIN_ALTITUDE_PLAIN)
    }
    expect(minAltitudeFor(2020, false)).toBe(MIN_ALTITUDE_PLAIN)
  })
  it('reports a shrinking view as altitude falls', () => {
    expect(visibleSpanDeg(0.01)).toBeLessThan(visibleSpanDeg(1))
  })
})

import { BASE_SOURCE } from '../src/lib/detailImagery'

describe('imagery source', () => {
  it('is a single well-registered layer with no date to get wrong', () => {
    expect(BASE_SOURCE.layers).not.toContain(',')
    expect(BASE_SOURCE.time).toBeUndefined()
    expect(BASE_SOURCE.label).toMatch(/Blue Marble/)
  })
})

import { SHARP_SOURCE, wmsUrl } from '../src/lib/detailImagery'

describe('wmsUrl', () => {
  const bbox = { minLat: 10, minLng: 20, maxLat: 30, maxLng: 50 }

  it('uses lat,lng order and CRS for WMS 1.3.0', () => {
    const url = wmsUrl(BASE_SOURCE, bbox, 512, 256)
    expect(url).toContain('CRS=EPSG:4326')
    expect(url).toContain('bbox=10,20,30,50')
  })

  it('uses lng,lat order and SRS for WMS 1.1.1', () => {
    const url = wmsUrl(SHARP_SOURCE, bbox, 512, 256)
    expect(url).toContain('SRS=EPSG:4326')
    expect(url).toContain('bbox=20,10,50,30') // the axis order differs by version
  })

  it('carries the requested size and layer', () => {
    const url = wmsUrl(SHARP_SOURCE, bbox, 1024, 512)
    expect(url).toContain('width=1024')
    expect(url).toContain('height=512')
    expect(url).toContain(encodeURIComponent(SHARP_SOURCE.layers))
  })

  it('omits TIME unless the source is date-dependent', () => {
    expect(wmsUrl(BASE_SOURCE, bbox, 256, 256)).not.toContain('TIME=')
    expect(BASE_SOURCE.time).toBeUndefined()
  })
})

describe('two-stage sources', () => {
  it('keeps the fallback simple and the sharp source genuinely sharper', () => {
    expect(BASE_SOURCE.layers).not.toContain(',')
    expect(BASE_SOURCE.time).toBeUndefined()
    expect(SHARP_SOURCE.pxPerDeg).toBeGreaterThan(BASE_SOURCE.pxPerDeg * 10)
  })

  it('carries attribution for both sources, as their licences require', () => {
    expect(BASE_SOURCE.attribution).toBeTruthy()
    expect(SHARP_SOURCE.attribution).toMatch(/EOX/)
    expect(SHARP_SOURCE.attribution).toMatch(/Copernicus/)
  })
})
