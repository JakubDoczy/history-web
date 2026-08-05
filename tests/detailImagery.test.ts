import { describe, it, expect } from 'vitest'
import {
  viewBbox,
  bboxToUvRect,
  visibleSpanDeg,
  minAltitudeFor,
  IMAGERY_ERA_FROM,
  MIN_ALTITUDE_DETAIL,
  MIN_ALTITUDE_PRE_ERA,
  PRE_ERA_VIEW_KM,
  MAX_PATCH_PX,
  PATCH_MARGIN,
  viewSpanDeg,
  DEFAULT_FOV,
  DETAIL_ON_TEXELS,
  DETAIL_OFF_TEXELS,
  FEATHER_FRACTION,
  TILE_COALESCE_MS,
  TILE_INFLIGHT,
  Z_MAX,
  degPerScreenPx,
  baseTexelsPerScreenPx,
  detailWanted,
  planetFillsFrame,
  pickSource,
  compositeCanvasSize,
  snapCompositeSize,
  RESAMPLE_MAX_PX,
  type Bbox,
} from '../src/lib/detailImagery'
import { TILE_BYTES, TILE_PX, targetLevel, tileSpanDeg } from '../src/lib/tilePyramid'

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

  it('follows the screen shape, so a portrait view fetches less width', () => {
    const portrait = viewBbox(60, 10, 0.02, 0.5)
    const landscape = viewBbox(60, 10, 0.02, 1.8)
    expect(portrait.maxLng - portrait.minLng).toBeLessThan(landscape.maxLng - landscape.minLng)
    // and the vertical extent is unchanged by aspect
    expect(portrait.maxLat - portrait.minLat).toBeCloseTo(landscape.maxLat - landscape.minLat, 6)
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

describe('patch visibility thresholds', () => {
  it('uses hysteresis so hovering near the threshold cannot flicker', () => {
    expect(DETAIL_OFF_TEXELS).toBeGreaterThan(DETAIL_ON_TEXELS)
    // the same altitude can be "keep showing" and "do not start", which is the
    // whole point; a single threshold flickers on a trackpad. Measured on a
    // small viewport, where the texel test is what binds — see below.
    const screenPx = 600
    let alt = 0.001
    while (detailWanted(alt, screenPx, DEFAULT_FOV, false) && alt < 10) alt *= 1.01
    expect(detailWanted(alt, screenPx, DEFAULT_FOV, true)).toBe(true)
  })

  it('turns on exactly where the base map stops keeping up with the screen', () => {
    const screenPx = 600
    // sweep altitudes and find the switch-on point, then check the base map is
    // delivering about one texel per pixel there
    let alt = 3
    while (!detailWanted(alt, screenPx) && alt > 1e-6) alt *= 0.99
    expect(baseTexelsPerScreenPx(alt, screenPx)).toBeCloseTo(DETAIL_ON_TEXELS, 1)
  })

  it('closes the dead zone the old fixed-span gate left open', () => {
    // the old rule: stream once the horizon span drops under 42 degrees
    const OLD_ON_BELOW = 42
    const screenPx = 1800
    let worst = Infinity
    let found = 0
    for (let alt = 1.2; alt > 0.05; alt *= 0.97) {
      const oldWouldStream = visibleSpanDeg(alt) < OLD_ON_BELOW
      if (oldWouldStream) continue
      const texels = baseTexelsPerScreenPx(alt, screenPx)
      if (texels >= DETAIL_ON_TEXELS) continue
      // under-resolved, and the old gate had not fired: the dead zone
      found++
      worst = Math.min(worst, texels)
      expect(detailWanted(alt, screenPx)).toBe(true)
    }
    expect(found).toBeGreaterThan(20)
    // and at its far end the base map was down to a few percent of a texel per
    // pixel — a 20x magnification of a world map, with nothing on its way
    expect(worst).toBeLessThan(0.06)
  })

  it('is geometry-bound, not texel-bound, on any large screen', () => {
    // worth stating because it is not obvious: a 4096-wide world map is already
    // down to half a texel per device pixel at the moment the globe stops
    // fitting inside the lens, so on a desktop the *only* thing holding
    // streaming back at wide zoom is that there is no sensible box to ask for
    expect(baseTexelsPerScreenPx(1.366, 1800)).toBeLessThan(0.5)
    expect(planetFillsFrame(1.36)).toBe(true)
    expect(detailWanted(1.36, 1800)).toBe(true)
  })

  it('leaves the whole planet alone: no patch when the globe fits in the lens', () => {
    expect(planetFillsFrame(2.5)).toBe(false)
    expect(planetFillsFrame(0.5)).toBe(true)
    expect(detailWanted(2.5, 1800)).toBe(false)
    expect(detailWanted(4, 4000)).toBe(false)
  })
})

describe('degPerScreenPx', () => {
  it('is proportional to altitude and inverse to the pixel count', () => {
    expect(degPerScreenPx(0.2, 900)).toBeCloseTo(degPerScreenPx(0.1, 900) * 2, 9)
    expect(degPerScreenPx(0.1, 1800)).toBeCloseTo(degPerScreenPx(0.1, 900) / 2, 9)
  })

  it('agrees with the frame span in the limit, where the two must meet', () => {
    // very close in, the frame is small enough that the sphere is locally flat
    // and span/screenPx is the same measurement by another route
    const alt = 1e-4
    expect(degPerScreenPx(alt, 1000) * 1000).toBeCloseTo(viewSpanDeg(alt), 6)
  })

  it('widens with the lens', () => {
    expect(degPerScreenPx(0.1, 900, 80)).toBeGreaterThan(degPerScreenPx(0.1, 900, 30))
  })
})

describe('pickSource', () => {
  it('sends wide boxes to the source that can render them', () => {
    expect(pickSource(30)).toBe(BASE_SOURCE)
    expect(pickSource(SHARP_SOURCE.maxSpanDeg + 0.1)).toBe(BASE_SOURCE)
  })

  it('uses the sharp source wherever it is usable', () => {
    expect(pickSource(1)).toBe(SHARP_SOURCE)
    expect(pickSource(SHARP_SOURCE.maxSpanDeg)).toBe(SHARP_SOURCE)
  })

  it('respects a sharp source that has already failed', () => {
    expect(pickSource(1, true)).toBe(BASE_SOURCE)
  })

  it('still beats the world texture handsomely at the base source max span', () => {
    // the point of streaming at mid zoom at all: 4096 px over 60 degrees is
    // several times the 4096-wide world map's density
    const px = Math.min(MAX_PATCH_PX, BASE_SOURCE.maxSpanDeg * BASE_SOURCE.pxPerDeg)
    expect(px / BASE_SOURCE.maxSpanDeg).toBeGreaterThan(BASE_TEXTURE_PX_PER_DEG * 5)
  })
})

describe('compositeCanvasSize', () => {
  const call = (px: number, aspect: number, maxPx = MAX_PATCH_PX) =>
    compositeCanvasSize(px, aspect, maxPx)

  it('covers the screen and the margin the patch is fetched with', () => {
    const { height } = call(1000, 1)
    expect(height).toBeGreaterThanOrEqual(1000 * PATCH_MARGIN)
  })

  it('follows the screen shape', () => {
    expect(call(1000, 2).width).toBeGreaterThan(call(1000, 1).width)
    expect(call(1000, 2).height).toBe(call(1000, 1).height)
  })

  it('honours the ceiling on both axes', () => {
    const out = call(6000, 3, 2048)
    expect(out.width).toBeLessThanOrEqual(2048)
    expect(out.height).toBeLessThanOrEqual(2048)
  })

  it('is a function of the screen alone', () => {
    // The whole point: a canvas whose size follows the view cannot be uploaded
    // into its own GL storage twice running, and every change is a fresh
    // allocation, upload and mip chain on the main thread. The camera is not a
    // parameter here, and a fixed viewport therefore has exactly one answer.
    const sizes = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const s = call(1040, 1.4623)
      sizes.add(`${s.width}x${s.height}`)
    }
    expect(sizes.size).toBe(1)
  })

  it('gives one size for a screen, whatever the camera is doing', () => {
    // There is no longer a motion size and a rest size. A wheel zoom pauses
    // between notches and the settle timer fires in each pause, so two sizes
    // meant the canvas halving and doubling several times a second — imagery
    // visibly snapping in and out of focus while the user turned the wheel.
    for (const [px, aspect] of [[2532, 0.46], [700, 1.4], [1040, 1.9]] as const) {
      expect(call(px, aspect, MAX_PATCH_PX)).toEqual(call(px, aspect, MAX_PATCH_PX))
    }
  })

})

describe('snapCompositeSize', () => {
  it('never returns less than asked for, until the ceiling says so', () => {
    for (const px of [100, 513, 1000, 1400, 3000]) {
      expect(snapCompositeSize(px, MAX_PATCH_PX)).toBeGreaterThanOrEqual(px)
    }
    expect(snapCompositeSize(9000, 2048)).toBe(2048)
  })

  it('collapses a zoom\'s worth of drifting sizes onto a handful of steps', () => {
    // measured on a continuous zoom-in: 1462, 1430, 1417, 1413, 1406, 1400...
    const drift = [1462, 1430, 1417, 1413, 1406, 1400, 1395, 1390, 1386]
    expect(new Set(drift.map((n) => snapCompositeSize(n, MAX_PATCH_PX))).size).toBe(2)
  })
})

describe('zoom limits', () => {
  it('caps how close the camera may come before the satellite era', () => {
    expect(minAltitudeFor(2000, true)).toBe(MIN_ALTITUDE_DETAIL)
    expect(minAltitudeFor(IMAGERY_ERA_FROM, true)).toBe(MIN_ALTITUDE_DETAIL)
    for (const year of [1929, 1800, -250e6]) {
      expect(minAltitudeFor(year, true)).toBe(MIN_ALTITUDE_PRE_ERA)
    }
    // with streaming off there is no modern imagery to be anachronistic, so
    // the era stops mattering at all
    expect(minAltitudeFor(1800, false)).toBe(MIN_ALTITUDE_DETAIL)
    expect(minAltitudeFor(2020, false)).toBe(MIN_ALTITUDE_DETAIL)
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

import { detailLod, BASE_TEXTURE_PX_PER_DEG } from '../src/lib/detailImagery'

describe('detailLod', () => {
  it('rises as the patch out-resolves the base texture', () => {
    const modest = detailLod(1024, 40) // ~26 px/° vs base ~11
    const sharp = detailLod(2048, 4) // ~512 px/°
    expect(sharp).toBeGreaterThan(modest)
  })

  it('is the log2 of how much finer the patch is', () => {
    // exactly 8x the base texture's density should ask for mip 3
    const lngSpan = 10
    const width = BASE_TEXTURE_PX_PER_DEG * 8 * lngSpan
    expect(detailLod(width, lngSpan)).toBeCloseTo(3, 5)
  })

  it('stays inside a usable mip range', () => {
    for (const [w, span] of [[128, 90], [4096, 0.5], [256, 0.01], [2048, 120]] as const) {
      const l = detailLod(w, span)
      expect(l).toBeGreaterThanOrEqual(0)
      expect(l).toBeLessThanOrEqual(7)
      expect(Number.isFinite(l)).toBe(true)
    }
  })

  it('is 0 for a patch the base map already out-resolves', () => {
    // At level 0 the shader's two taps are the same sample, so the ratio is
    // exactly 1 and the patch changes nothing. Forcing a floor of 1 instead
    // handed it a tap *blurrier* than the base map, and the band between them —
    // which the base map already carries — was applied a second time: measured
    // at wide zoom, 7/255 of darkening and less apparent detail than no patch.
    expect(detailLod(BASE_TEXTURE_PX_PER_DEG * 60, 60)).toBe(0)
    expect(detailLod(BASE_TEXTURE_PX_PER_DEG * 0.5 * 60, 60)).toBe(0)
    // and 1 exactly where it is twice as fine, which is where it starts to help
    expect(detailLod(BASE_TEXTURE_PX_PER_DEG * 2 * 60, 60)).toBeCloseTo(1, 6)
  })
})

import { altitudeForViewKm, altitudeForFrameKm } from '../src/lib/detailImagery'

describe('altitudeForViewKm', () => {
  it('round-trips against the visible-span calculation', () => {
    for (const km of [100, 300, 1000, 5000]) {
      const span = visibleSpanDeg(altitudeForViewKm(km))
      expect(span * 111.32).toBeCloseTo(km, 0)
    }
  })
  it('is monotonic: a wider view needs a higher camera', () => {
    expect(altitudeForViewKm(300)).toBeGreaterThan(altitudeForViewKm(100))
  })
})

describe('era-dependent zoom floors', () => {
  it('permits a ~100 km view in the satellite era', () => {
    const span = visibleSpanDeg(minAltitudeFor(2000, true))
    expect(span * 111.32).toBeCloseTo(100, 0)
  })
  it('caps earlier periods at a 100 km frame, where modern building does not read', () => {
    for (const year of [1929, 1600, -3000]) {
      const span = viewSpanDeg(minAltitudeFor(year, true))
      expect(span * 111.32).toBeCloseTo(PRE_ERA_VIEW_KM, 1)
    }
  })

  it('holds the camera further out before 1930 than after it', () => {
    // the cap is only a cap if it bites — measured on the horizon rather than
    // on the frame, a "100 km view" sits 200 m above the ground, nearer than
    // the satellite-era floor and showing nothing at all
    expect(minAltitudeFor(1800, true)).toBeGreaterThan(minAltitudeFor(1950, true))
    expect(viewSpanDeg(MIN_ALTITUDE_PRE_ERA)).toBeGreaterThan(
      viewSpanDeg(MIN_ALTITUDE_DETAIL) * 20,
    )
  })

  it('still streams at the pre-1930 cap, rather than capping past the patch', () => {
    for (const screenPx of [900, 1800, 2880]) {
      expect(detailWanted(MIN_ALTITUDE_PRE_ERA, screenPx)).toBe(true)
    }
  })

  it('frames 100 km at the pre-1930 cap — a regional map, not a street map', () => {
    expect(PRE_ERA_VIEW_KM).toBe(100)
    const metresPerPx = (PRE_ERA_VIEW_KM * 1000) / 1000 // across a 1000 px window
    expect(metresPerPx).toBeCloseTo(100, 6)
  })
})

import { afterEach, beforeEach, vi } from 'vitest'
import {
  coversView,
  DetailImagery,
  MOTION_EPS,
  movedEnough,
  PAN_MIN_COVER,
  SETTLE_MS,
  viewBbox as viewBboxFor,
  viewCoverage,
  viewMotion,
} from '../src/lib/detailImagery'

describe('movedEnough', () => {
  const at = (lat: number, lng: number, aspect: number) => viewBbox(lat, lng, 0.02, aspect)

  it('judges an east-west pan against the longitude span, not the latitude one', () => {
    // portrait phone at the equator: the patch is a third as wide as it is tall,
    // so a pan of 30% of its width is only ~10% of the latitude span — under the
    // old threshold, which let the view slide off imagery that was never refetched
    const a = at(0, 0, 0.35)
    const width = a.maxLng - a.minLng
    expect(width).toBeLessThan(a.maxLat - a.minLat) // the shape that broke it
    expect(movedEnough(a, at(0, width * 0.3, 0.35))).toBe(true)
  })

  it('does not refetch for a pan well inside the patch at high latitude', () => {
    // the mirror case: at 70 deg the patch is half again wider than it is tall,
    // so 15% of its width passed the old latitude-based threshold and refetched
    const a = at(70, 0, 0.5)
    const width = a.maxLng - a.minLng
    expect(width).toBeGreaterThan(a.maxLat - a.minLat)
    expect(movedEnough(a, at(70, width * 0.15, 0.5))).toBe(false)
  })

  it('always refetches when there is nothing loaded yet', () => {
    expect(movedEnough(undefined, at(0, 0, 1))).toBe(true)
  })
})

describe('viewMotion', () => {
  const box = (lat: number, lng: number) => ({
    minLat: lat - 2,
    maxLat: lat + 2,
    minLng: lng - 2,
    maxLng: lng + 2,
  })

  it('is zero for a camera that has not moved', () => {
    expect(viewMotion(box(45, 10), box(45, 10))).toBe(0)
  })

  it('measures a pan against the span it is a pan of', () => {
    // 1 degree of a 4 degree view is a quarter of it
    expect(viewMotion(box(45, 10), box(45, 11))).toBeCloseTo(0.25, 6)
  })

  it('sees a pure zoom, which moves no centre at all', () => {
    const a = { minLat: 44, maxLat: 46, minLng: 9, maxLng: 11 }
    const b = { minLat: 43, maxLat: 47, minLng: 8, maxLng: 12 }
    expect(viewMotion(a, b)).toBeGreaterThan(MOTION_EPS)
  })

  it('counts the first frame as motion, since there is nothing to compare to', () => {
    expect(viewMotion(undefined, box(45, 10))).toBe(1)
  })

  it('puts orbit damping below the threshold before it reaches zero', () => {
    // the creep after a released drag has to stop counting as motion, or the
    // imagery waits on a camera that is still technically moving
    const span = 4
    const crawl = span * MOTION_EPS * 0.5
    expect(viewMotion(box(45, 10), box(45, 10 + crawl))).toBeLessThan(MOTION_EPS)
  })
})

describe('viewCoverage', () => {
  const box = (minLat: number, maxLat: number, minLng: number, maxLng: number) => ({
    minLat,
    maxLat,
    minLng,
    maxLng,
  })

  it('is 1 when the held rectangle contains the view', () => {
    expect(viewCoverage(box(40, 44, 10, 15), box(41, 43, 11, 14))).toBe(1)
  })

  it('is 0 once the view has panned clear of it', () => {
    expect(viewCoverage(box(40, 44, 10, 15), box(40, 44, 20, 25))).toBe(0)
  })

  it('is the fraction of the view that still has imagery under it', () => {
    // half the width, all of the height
    expect(viewCoverage(box(40, 44, 10, 15), box(40, 44, 12.5, 17.5))).toBeCloseTo(0.5, 6)
  })

  it('is 0 when nothing has been composited', () => {
    expect(viewCoverage(undefined, box(40, 44, 10, 15))).toBe(0)
  })

  it('drops through the escape hatch about two thirds of a view width along', () => {
    // the hatch is what stops a long drag stranding the user on the basemap;
    // it has to fire while there is still imagery on screen, not after
    const start = viewBbox(45, 10, 0.05, 1.6)
    const width = start.maxLng - start.minLng
    expect(viewCoverage(start, viewBbox(45, 10 + width * 0.5, 0.05, 1.6))).toBeGreaterThan(
      PAN_MIN_COVER,
    )
    expect(viewCoverage(start, viewBbox(45, 10 + width * 0.8, 0.05, 1.6))).toBeLessThan(
      PAN_MIN_COVER,
    )
  })
})

describe('coversView', () => {
  const box = (minLat: number, maxLat: number, minLng: number, maxLng: number) => ({
    minLat,
    maxLat,
    minLng,
    maxLng,
  })

  it('says yes for a zoom-in, which is the whole point', () => {
    // every publish is a full texture upload and a full mip chain rebuild; on a
    // zoom-in the rectangle already on the GPU holds all the ground the new view
    // wants, so the redraw would buy nothing
    const held = box(40, 44, 10, 15)
    expect(coversView(held, box(41, 43, 11, 14))).toBe(true)
  })

  it('says no for a zoom-out, which really does expose new ground', () => {
    expect(coversView(box(41, 43, 11, 14), box(40, 44, 10, 15))).toBe(false)
  })

  it('says no for a pan that leaves the rectangle on any one side', () => {
    const held = box(40, 44, 10, 15)
    expect(coversView(held, box(40, 44, 12, 16))).toBe(false) // east
    expect(coversView(held, box(40, 44, 9, 14))).toBe(false) // west
    expect(coversView(held, box(43, 47, 10, 15))).toBe(false) // north
    expect(coversView(held, box(37, 41, 10, 15))).toBe(false) // south
  })

  it('is inclusive at the edges — an identical rectangle needs no redraw', () => {
    const b = box(40, 44, 10, 15)
    expect(coversView(b, { ...b })).toBe(true)
  })

  it('says no when nothing has been composited yet', () => {
    expect(coversView(undefined, box(40, 44, 10, 15))).toBe(false)
  })

  it('holds across a whole zoom-in, so the redraw fires once and not per step', () => {
    // the measured failure: 33 publishes across one 90-frame wheel zoom
    const held = viewBbox(41.9, 12.5, 1.6, 1.6)
    let redraws = 0
    for (let i = 0; i < 90; i++) {
      const want = viewBbox(41.9, 12.5, 1.6 * Math.pow(0.011 / 1.6, i / 89), 1.6)
      if (!coversView(held, want)) redraws++
    }
    expect(redraws).toBe(0)
  })
})

/** Stands in for the browser's Image: records the URL, resolves on demand. */
class FakeImage {
  static requests: string[] = []
  static pending: FakeImage[] = []
  crossOrigin = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  /** A tile is always the pyramid's own size, whatever ground it holds. */
  naturalWidth = TILE_PX
  naturalHeight = TILE_PX
  private url = ''
  get src() {
    return this.url
  }
  set src(v: string) {
    this.url = v
    FakeImage.requests.push(v)
    FakeImage.pending.push(this)
  }

  static reset() {
    FakeImage.requests = []
    FakeImage.pending = []
  }

  /**
   * Land everything on the wire, and everything the freed slots then ask for.
   *
   * A view wants tens of tiles and only TILE_INFLIGHT may be outstanding, so
   * "the imagery arrived" is a fixed point rather than a single callback.
   */
  /** Refuse the oldest request on the wire, as a dead endpoint would. */
  static failNext() {
    FakeImage.pending.shift()?.onerror?.()
  }

  static landAll(rounds = 40) {
    for (let i = 0; i < rounds && FakeImage.pending.length; i++) {
      const batch = FakeImage.pending
      FakeImage.pending = []
      for (const img of batch) img.onload?.()
    }
  }
}

/** The rectangle the shader was handed, back out of UV space. */
const bboxFromRect = ([u, v, du, dv]: [number, number, number, number]): Bbox => ({
  minLng: u * 360 - 180,
  minLat: v * 180 - 90,
  maxLng: (u + du) * 360 - 180,
  maxLat: (v + dv) * 180 - 90,
})

/** The rectangle a request went out for, read back off the WMS URL. */
const requestedBbox = (url: string): Bbox => {
  const q = new URLSearchParams(url.slice(url.indexOf('?') + 1))
  const n = q.get('bbox')!.split(',').map(Number)
  return q.get('version') === '1.3.0'
    ? { minLat: n[0], minLng: n[1], maxLat: n[2], maxLng: n[3] }
    : { minLng: n[0], minLat: n[1], maxLng: n[2], maxLat: n[3] }
}

/** Which pyramid level a request was for, inferred from the box it asked for. */
const levelOf = (url: string): number => {
  const b = requestedBbox(url)
  return Math.round(Math.log2(360 / (b.maxLat - b.minLat)))
}

describe('DetailImagery streaming', () => {
  const CLOSE = 0.02 // a ~1 degree frame: level 10 territory
  // world view: the globe sits inside the lens, so there is no tile worth
  // asking for however coarse the base map looks
  const FAR = 2.5

  beforeEach(() => {
    vi.useFakeTimers()
    FakeImage.reset()
    FakeCanvas.made = []
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** What the render loop does: one update per animation frame, forever. */
  const frames = (d: DetailImagery, n: number, lat = 45, lng = 10, alt = CLOSE) => {
    for (let i = 0; i < n; i++) {
      d.update(lat, lng, alt, 900, 1)
      vi.advanceTimersByTime(16)
    }
  }

  it('asks for tiles on the frame that wants them, not a settle later', () => {
    // The arbitrary-bbox streamer waited SETTLE_MS before spending anything,
    // because one request was a multi-megapixel picture of a view the camera
    // was about to leave. A tile is a fraction of that and its URL is canonical,
    // so during a gesture the bandwidth goes to ground that is on screen now.
    const d = new DetailImagery()
    d.update(45, 10, CLOSE, 900, 1)
    expect(FakeImage.requests).toHaveLength(TILE_INFLIGHT)
    d.dispose()
  })

  it('never puts more than the in-flight cap on the wire at once', () => {
    const d = new DetailImagery()
    frames(d, 30)
    expect(FakeImage.pending.length).toBeLessThanOrEqual(TILE_INFLIGHT)
    // …and the cap is a throttle, not a ceiling: landing tiles frees slots
    const first = FakeImage.requests.length
    FakeImage.landAll()
    expect(FakeImage.requests.length).toBeGreaterThan(first)
    d.dispose()
  })

  it('spends the first requests on the fallback level, parents before children', () => {
    // Four times cheaper than the level it stands under, and the only thing
    // between a moving camera and bare base map, so it goes out first.
    const d = new DetailImagery()
    d.update(45, 10, CLOSE, 900, 1)
    const z = targetLevel(baseTexelsPerScreenPx(CLOSE, 900), Z_MAX)
    expect(FakeImage.requests.map(levelOf).every((l) => l === z - 1)).toBe(true)
    d.dispose()
  })

  it('asks for every tile at the pyramid size, on the pyramid grid', () => {
    // Aligned fixed boxes are what make a URL canonical, which is what lets the
    // browser's HTTP cache and the service's own cache hit at all.
    const d = new DetailImagery()
    frames(d, 40)
    FakeImage.landAll()
    expect(FakeImage.requests.length).toBeGreaterThan(TILE_INFLIGHT)
    for (const url of FakeImage.requests) {
      const q = new URLSearchParams(url.slice(url.indexOf('?') + 1))
      expect(q.get('width')).toBe(String(TILE_PX))
      expect(q.get('height')).toBe(String(TILE_PX))
      const b = requestedBbox(url)
      const span = b.maxLat - b.minLat
      expect(b.maxLng - b.minLng).toBeCloseTo(span, 6) // square in degrees
      expect((b.minLng + 180) / span).toBeCloseTo(Math.round((b.minLng + 180) / span), 6)
      expect((90 - b.maxLat) / span).toBeCloseTo(Math.round((90 - b.maxLat) / span), 6)
    }
    d.dispose()
  })

  it('never asks for the same tile twice, however tight the budget', () => {
    // The wanted set is pinned, so eviction can never drop a tile the very next
    // frame wants again — and the prefetch ring is spent out of headroom, so it
    // cannot push the cache past its bound and start the same loop from the
    // other end. Without both, a still camera fetched, evicted and refetched
    // forever: 907 requests for 140 distinct tiles, measured.
    const d = new DetailImagery({ tileBudget: TILE_BYTES * 8 })
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 24; i++) {
        d.update(45, 10, CLOSE, 900, 1)
        vi.advanceTimersByTime(16)
      }
      FakeImage.landAll()
      vi.advanceTimersByTime(SETTLE_MS + 32)
    }
    expect(FakeImage.requests.length).toBeGreaterThan(TILE_INFLIGHT)
    expect(new Set(FakeImage.requests).size).toBe(FakeImage.requests.length)
    d.dispose()
  })

  it('collects a burst of arrivals into one composite', () => {
    // Tiles land within milliseconds of each other and every composite is a
    // full canvas upload plus a full generateMipmap. Publishing on each arrival
    // spent 48 of them across one scripted pan and zoom where six pictures were
    // involved.
    const d = new DetailImagery()
    for (let i = 0; i < 24; i++) {
      d.update(45, 10, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    expect(FakeCanvas.made.length).toBe(0) // nothing composited yet
    FakeImage.landAll(1) // one round trip: several tiles, at once
    expect(FakeCanvas.made.length).toBe(0) // …still nothing, one tick later…
    vi.advanceTimersByTime(TILE_COALESCE_MS + 1)
    expect(FakeCanvas.made[0].cleared).toBe(1) // …and then exactly one composite
    d.dispose()
  })

  it('never asks for the same tile twice', () => {
    // The whole economic case for the grid: a pan reuses what it already holds
    // instead of paying again for ground it has.
    const d = new DetailImagery()
    frames(d, 40)
    FakeImage.landAll()
    frames(d, 40, 45, 10.05)
    FakeImage.landAll()
    expect(new Set(FakeImage.requests).size).toBe(FakeImage.requests.length)
    d.dispose()
  })

  it('stops asking once every wanted tile is held', () => {
    const d = new DetailImagery()
    for (let i = 0; i < 6; i++) {
      frames(d, 40)
      FakeImage.landAll()
    }
    const settled = FakeImage.requests.length
    frames(d, 200)
    expect(FakeImage.requests).toHaveLength(settled)
    d.dispose()
  })

  it('lets tiles fetched before a zoom-out land, but never onto the screen', () => {
    // Zooming back out is not "something newer is coming", it is "nobody is
    // looking at this any more". The tiles are as true as ever, so they stay in
    // the cache rather than being paid for twice — but nothing they arrive into
    // may reach the shader.
    const d = new DetailImagery()
    d.update(45, 10, CLOSE, 900, 1)
    expect(FakeImage.requests.length).toBeGreaterThan(0)
    d.update(45, 10, FAR, 900, 1)
    vi.advanceTimersByTime(SETTLE_MS * 2)
    FakeImage.landAll()
    expect(d.mix).toBe(0)
    expect(d.texture).toBeUndefined()
    d.dispose()
  })

  it('publishes resolution only once the imagery it describes has arrived', () => {
    const d = new DetailImagery()
    frames(d, 30)
    expect(d.groundRes).toBe(0) // in flight: nothing on screen to describe yet
    FakeImage.landAll()
    vi.advanceTimersByTime(SETTLE_MS + 32)
    expect(d.groundRes).toBeGreaterThan(0)
    expect(d.status).toBe('ready')
    d.dispose()
  })

  it('quotes the resolution of the level it actually drew', () => {
    const d = new DetailImagery()
    frames(d, 40)
    FakeImage.landAll()
    vi.advanceTimersByTime(SETTLE_MS + 32)
    const z = targetLevel(baseTexelsPerScreenPx(CLOSE, 900), Z_MAX)
    expect(d.groundRes).toBeCloseTo((tileSpanDeg(z) * 111_320) / TILE_PX, 6)
    d.dispose()
  })

  it('keeps the loaded source name when the imagery is hidden and shown again', () => {
    const d = new DetailImagery()
    frames(d, 40)
    FakeImage.landAll()
    vi.advanceTimersByTime(SETTLE_MS + 32)
    expect(d.sourceLabel).toBe(SHARP_SOURCE.label)

    d.update(45, 10, FAR, 900, 1) // zoom out: the imagery retires
    expect(d.sourceLabel).toBe('—')

    d.update(45, 10, CLOSE, 900, 1) // and back: the same texture is re-shown
    expect(d.mix).toBe(1)
    expect(d.sourceLabel).toBe(SHARP_SOURCE.label) // not the fallback's name
    expect(d.attribution).toBe(SHARP_SOURCE.attribution)
    d.dispose()
  })

  it('streams at mid zoom, where it used to show a magnified world map', () => {
    // altitude 0.3: a 17 deg frame. The old gate (horizon span under 42 deg)
    // did not fire until 0.071, so this whole range showed the 4096 base map
    // magnified ten times with nothing on its way.
    const d = new DetailImagery()
    frames(d, 30, 45, 10, 0.3)
    expect(FakeImage.requests.length).toBeGreaterThan(0)
    // and it asks the source that can actually render a box that wide
    expect(FakeImage.requests.every((u) => u.includes(BASE_SOURCE.endpoint))).toBe(true)
    d.dispose()
  })

  it('never asks a source for a wider box than it will serve', () => {
    // Now a statement about the whole plan rather than about one request: the
    // source is picked on the *fallback* level, so the coarser of the two levels
    // a view fetches is the one that has to fit — see sourceForLevel.
    for (const alt of [1.2, 0.8, 0.4, 0.3, 0.1, 0.02, 0.002]) {
      FakeImage.reset()
      const d = new DetailImagery()
      frames(d, 40, 20, 10, alt)
      FakeImage.landAll()
      expect(FakeImage.requests.length).toBeGreaterThan(0)
      for (const url of FakeImage.requests) {
        const b = requestedBbox(url)
        const sharp = url.includes(SHARP_SOURCE.endpoint)
        const span = Math.max(b.maxLat - b.minLat, b.maxLng - b.minLng)
        expect(span).toBeLessThanOrEqual(
          (sharp ? SHARP_SOURCE.maxSpanDeg : BASE_SOURCE.maxSpanDeg) + 1e-6,
        )
      }
      d.dispose()
    }
  })

  it('draws one source per composite, so no join crosses two sensors', () => {
    // Sentinel-2 is a different sensor from Blue Marble — greener, darker — and
    // where the two met on one canvas the seam was a palette step no edge
    // feather can help. Both levels therefore come from one source.
    for (const alt of [0.9, 0.4, 0.2, 0.05, 0.01, 0.003]) {
      FakeImage.reset()
      const d = new DetailImagery()
      frames(d, 40, 20, 10, alt)
      FakeImage.landAll()
      const hosts = new Set(FakeImage.requests.map((u) => new URL(u).host))
      expect(hosts.size).toBe(1)
      d.dispose()
    }
  })

  it('falls back to the base source after the sharp one fails twice', () => {
    const d = new DetailImagery()
    frames(d, 30)
    expect(FakeImage.requests[0]).toContain(SHARP_SOURCE.endpoint)
    const before = FakeImage.requests.length
    FakeImage.failNext()
    FakeImage.failNext()
    expect(FakeImage.requests.slice(before).some((u) => u.includes(BASE_SOURCE.endpoint))).toBe(true)
    d.dispose()
  })
})

describe('streaming era model', () => {
  it('streams in every era that uses the modern basemap', () => {
    // the year no longer gates whether imagery exists — only how close the
    // camera may come to it
    const d = new DetailImagery()
    expect(minAltitudeFor(1500, true)).toBe(MIN_ALTITUDE_PRE_ERA)
    expect(detailWanted(MIN_ALTITUDE_PRE_ERA, 900)).toBe(true)
    d.dispose()
  })

  it('leaves the satellite era own floor exactly where it was', () => {
    expect(visibleSpanDeg(MIN_ALTITUDE_DETAIL) * 111.32).toBeCloseTo(100, 0)
  })
})

/** A canvas that records what was drawn on it, since node has none. */
class FakeCanvas {
  static made: FakeCanvas[] = []
  width = 0
  height = 0
  ops: { image: unknown; x: number; y: number; w: number; h: number }[] = []
  cleared = 0
  /** Where each composite began: a composite clears before it draws anything. */
  marks: number[] = []
  constructor() {
    FakeCanvas.made.push(this)
  }
  /** Just the last composite's draws, since the canvas is reused between them. */
  get last() {
    return this.ops.slice(this.marks.length ? this.marks[this.marks.length - 1] : 0)
  }
  getContext() {
    return {
      clearRect: () => {
        this.cleared++
        this.marks.push(this.ops.length)
      },
      drawImage: (image: unknown, x: number, y: number, w: number, h: number) =>
        this.ops.push({ image, x, y, w, h }),
    }
  }
}

describe('tiled compositing', () => {
  const CLOSE = 0.02
  /** A pan of ~27% of the frame width: enough that the wanted set really moves. */
  const PAN = (() => {
    const b = viewBbox(45, 10, CLOSE, 1)
    return (b.maxLng - b.minLng) * 0.27
  })()

  beforeEach(() => {
    vi.useFakeTimers()
    FakeImage.reset()
    FakeCanvas.made = []
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /**
   * Hold the camera still until every tile the view wants has arrived.
   *
   * A view wants tens of tiles and only TILE_INFLIGHT may be outstanding, and
   * the prefetch ring is not even asked for until the camera has been still for
   * a settle — so "the imagery arrived" is a fixed point rather than one
   * callback, which is what this loops to.
   */
  const land = (d: DetailImagery, lat: number, lng: number, alt = CLOSE) => {
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 24; i++) {
        d.update(lat, lng, alt, 900, 1)
        vi.advanceTimersByTime(16)
      }
      FakeImage.landAll()
      vi.advanceTimersByTime(SETTLE_MS + 32)
    }
  }

  /** The composite canvas: the first one made, and the only one drawn onto. */
  const composite = () => FakeCanvas.made[0]

  it('draws the fallback level first and the target level over it', () => {
    // Coarse but present beats sharp but absent. The level below covers the
    // whole rectangle before anything sharper goes down, so there is never bare
    // base map inside the composite — which is what killed the union-coverage
    // scan the old pipeline ran every frame.
    const d = new DetailImagery()
    land(d, 45, 10)
    const ops = composite().last
    expect(ops.length).toBeGreaterThan(4)
    const sizes = [...new Set(ops.map((o) => Math.round(o.w)))].sort((a, b) => b - a)
    expect(sizes).toHaveLength(2) // two levels, and only two
    expect(sizes[0] / sizes[1]).toBeCloseTo(2, 1) // one level apart
    // …coarse first: everything sharp is drawn after everything coarse
    const lastCoarse = ops.map((o) => Math.round(o.w)).lastIndexOf(sizes[0])
    const firstSharp = ops.map((o) => Math.round(o.w)).indexOf(sizes[1])
    expect(lastCoarse).toBeLessThan(firstSharp)
    expect(d.mix).toBe(1)
    d.dispose()
  })

  it('lays the tiles of one level edge to edge, with no gap and no overlap', () => {
    const d = new DetailImagery()
    land(d, 45, 10)
    const ops = composite().last
    const w = Math.min(...ops.map((o) => Math.round(o.w)))
    const sharp = ops.filter((o) => Math.round(o.w) === w)
    for (const a of sharp) {
      const east = sharp.find((b) => Math.abs(b.x - (a.x + a.w)) < 1e-6 && Math.abs(b.y - a.y) < 1e-6)
      if (east) expect(east.w).toBeCloseTo(a.w, 6)
    }
    // and between them they reach every corner of the canvas
    expect(Math.min(...sharp.map((o) => o.x))).toBeLessThanOrEqual(0)
    expect(Math.max(...sharp.map((o) => o.x + o.w))).toBeGreaterThanOrEqual(composite().width)
    d.dispose()
  })

  it('redraws what it holds onto the new view, out of the cache and after the drag', () => {
    const d = new DetailImagery()
    land(d, 45, 10)
    const rectBefore = [...d.rect]
    const canvas = composite()
    canvas.ops.length = 0
    canvas.cleared = 0

    d.update(45, 10 + PAN, CLOSE, 900, 1)
    // Nothing at all happens while the camera is moving. A composite is a full
    // texture upload and a full mip rebuild — 111 ms measured — and mid-drag it
    // buys one frame of imagery on the newly exposed edge before the next drag
    // frame replaces it.
    expect(canvas.ops).toHaveLength(0)

    vi.advanceTimersByTime(SETTLE_MS + 1)
    expect(canvas.ops.length).toBeGreaterThan(0)
    expect(canvas.cleared).toBe(1) // and nothing stale left under it
    // the ground we already hold is now to the *west*, so it is drawn left of
    // where it was, out of the cache rather than off the network
    expect(Math.min(...canvas.ops.map((o) => o.x))).toBeLessThan(0)
    expect(d.rect).not.toEqual(rectBefore)
    expect(d.mix).toBe(1)
    d.dispose()
  })

  it('never publishes mid-gesture, however many tiles land during it', () => {
    const d = new DetailImagery()
    land(d, 45, 10)
    const canvas = composite()
    canvas.ops.length = 0
    for (let i = 1; i <= 8; i++) {
      d.update(45, 10 + (PAN * i) / 8, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
      FakeImage.landAll() // arrivals during the drag go into the cache and no further
    }
    expect(canvas.ops).toHaveLength(0)
    vi.advanceTimersByTime(SETTLE_MS + 32)
    expect(canvas.ops.length).toBeGreaterThan(0)
    d.dispose()
  })

  it('does not redraw the same composite twice', () => {
    // publishing re-uploads every pixel of the canvas, and update() runs on
    // every frame the view moves
    const d = new DetailImagery()
    land(d, 45, 10)
    const canvas = composite()
    canvas.ops.length = 0
    canvas.cleared = 0
    for (let i = 0; i < 8; i++) d.update(45, 10 + PAN, CLOSE, 900, 1)
    vi.advanceTimersByTime(SETTLE_MS + 1)
    expect(canvas.cleared).toBe(1)
    const once = canvas.ops.length
    for (let i = 0; i < 8; i++) {
      d.update(45, 10 + PAN, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    expect(canvas.ops).toHaveLength(once)
    d.dispose()
  })

  it('does not composite tiles the camera has jumped away from', () => {
    const d = new DetailImagery()
    land(d, 45, 10)
    const canvas = composite()
    canvas.ops.length = 0
    d.update(-40, -170, CLOSE, 900, 1) // the other side of the world
    vi.advanceTimersByTime(SETTLE_MS + 32)
    expect(canvas.ops).toHaveLength(0) // nothing held is anywhere near it
    d.dispose()
  })

  it('keeps tiles that arrive after the camera moved on', () => {
    // A late tile is not wrong, only somewhere else: it covers the ground it
    // covers, and the composite draws it exactly where it belongs. Discarding
    // one because something newer had been *asked for* is how a zoom used to
    // throw away everything it fetched.
    const d = new DetailImagery()
    for (let i = 0; i < 24; i++) {
      d.update(45, 10, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    const early = FakeImage.pending.slice()
    expect(early.length).toBeGreaterThan(0)
    for (let i = 0; i < 24; i++) {
      d.update(45, 10 + PAN / 3, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    for (const img of early) img.onload!() // the older ones land last
    vi.advanceTimersByTime(SETTLE_MS + 32)
    expect(composite().ops.length).toBeGreaterThan(0)
    expect(d.mix).toBe(1)
    d.dispose()
  })

  it('never shrinks the composite because the camera moved', () => {
    // The display rule: effective resolution must not go backward over ground
    // the camera is already looking at. A canvas that halves while the camera
    // moves and doubles when it stops breaks that everywhere at once.
    const SCREEN = 3000
    const d = new DetailImagery({ maxPx: 4096 })
    land(d, 45, 10)
    const canvas = composite()
    const atRest = Math.max(canvas.width, canvas.height)
    expect(atRest).toBeGreaterThan(0)
    d.update(45, 10 + PAN, CLOSE, SCREEN, 1)
    expect(Math.max(canvas.width, canvas.height)).toBe(atRest)
    d.dispose()
  })

  it('keeps one canvas shape for a whole zoom', () => {
    // A canvas that changes shape cannot be re-uploaded into its existing GL
    // storage, so every change is an allocation, a full upload and a mip chain
    // on the main thread. Measured before this: twelve reallocations across one
    // scripted sequence, and ten to twenty seconds of blocking time.
    const d = new DetailImagery()
    land(d, 45, 10)
    const canvas = composite()
    const shapes = new Set<string>()
    for (let alt = CLOSE * 3; alt > CLOSE; alt *= 0.97) {
      for (let i = 0; i < 4; i++) {
        d.update(45, 10, alt, 900, 1)
        vi.advanceTimersByTime(16)
      }
      shapes.add(`${canvas.width}x${canvas.height}`)
    }
    expect(shapes.size).toBe(1)
    d.dispose()
  })

  it('never draws the composite canvas into itself', () => {
    // a canvas drawn into itself nests a copy of the last generation each time
    const d = new DetailImagery()
    land(d, 45, 10)
    const canvas = composite()
    for (let i = 1; i <= 6; i++) {
      d.update(45, 10 + PAN * i, CLOSE, 900, 1)
      vi.advanceTimersByTime(SETTLE_MS + 32)
      FakeImage.landAll()
    }
    expect(canvas.ops.every((o) => o.image !== canvas)).toBe(true)
    d.dispose()
  })

  it('works without a canvas at all, as it must in a stale browser', () => {
    vi.stubGlobal('document', undefined)
    const d = new DetailImagery()
    expect(() => land(d, 45, 10)).not.toThrow()
    expect(FakeImage.requests.length).toBeGreaterThan(0) // the fetch path is untouched
    d.dispose()
  })
})

describe('joins between levels', () => {
  const CLOSE = 0.02

  /** A canvas that records draws and can build the gradients feathering needs. */
  class RampCanvas {
    static made: RampCanvas[] = []
    width = 0
    height = 0
    ops: { image: unknown; x: number; y: number; w: number; h: number }[] = []
    gradients = 0
    constructor() {
      RampCanvas.made.push(this)
    }
    getContext() {
      return {
        clearRect: () => {},
        drawImage: (image: unknown, x = 0, y = 0, w = 0, h = 0) =>
          this.ops.push({ image, x, y, w, h }),
        createLinearGradient: () => {
          this.gradients++
          return { addColorStop: () => {} }
        },
        fillRect: () => {},
        set globalCompositeOperation(_v: string) {},
        get globalCompositeOperation() {
          return 'source-over'
        },
        fillStyle: '',
        set imageSmoothingQuality(_v: unknown) {},
      } as unknown as CanvasRenderingContext2D
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    FakeImage.reset()
    RampCanvas.made = []
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('document', { createElement: () => new RampCanvas() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const ramps = () => RampCanvas.made.reduce((s, c) => s + c.gradients, 0)

  it('feathers the edge where the target level runs out', () => {
    // The only join in a composite that crosses a resolution: a crossfade there
    // is the difference between imagery sharpening in and a rectangle appearing.
    const d = new DetailImagery()
    for (let i = 0; i < 24; i++) {
      d.update(45, 10, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    // land the fallback level and a *few* of the target tiles, so the sharp
    // region has an edge inside the canvas
    FakeImage.landAll(2)
    vi.advanceTimersByTime(SETTLE_MS + 32)
    expect(ramps()).toBeGreaterThan(0)
    expect(FEATHER_FRACTION).toBeGreaterThan(0)
    d.dispose()
  })

  it('does not feather the joins inside a level, which are butt joints', () => {
    // Two tiles of one level are the same resolution on the same grid, so they
    // abut exactly. A ramp there would show as a band of the coarser level
    // bleeding up through the seam — a defect invented by the fix.
    const d = new DetailImagery()
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 24; i++) {
        d.update(45, 10, CLOSE, 900, 1)
        vi.advanceTimersByTime(16)
      }
      FakeImage.landAll()
      vi.advanceTimersByTime(SETTLE_MS + 32)
    }
    RampCanvas.made.forEach((c) => (c.gradients = 0))
    // a redraw of a fully covered view: every target tile has neighbours on
    // every side it shares with the canvas, so nothing is ramped at all
    for (let i = 0; i < 4; i++) {
      d.update(45, 10, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    vi.advanceTimersByTime(SETTLE_MS + 32)
    expect(ramps()).toBe(0)
    d.dispose()
  })
})

describe('viewSpanDeg', () => {
  it('is the horizon once the planet no longer fills the frame', () => {
    for (const alt of [1.5, 2.2, 5]) {
      expect(viewSpanDeg(alt)).toBeCloseTo(visibleSpanDeg(alt), 9)
    }
  })

  it('is far smaller than the horizon close in, which is the whole point', () => {
    // at 0.02 radii the horizon is ~2500 km of ground and a 50 deg lens frames
    // ~117 km of it; sizing the patch to the horizon spent the pixel budget on
    // ground nobody could see
    expect(visibleSpanDeg(0.02) * 111.32).toBeGreaterThan(2000)
    expect(viewSpanDeg(0.02) * 111.32).toBeGreaterThan(100)
    expect(viewSpanDeg(0.02) * 111.32).toBeLessThan(140)
    expect(visibleSpanDeg(0.02) / viewSpanDeg(0.02)).toBeGreaterThan(15)
  })

  it('never claims to see more than the horizon allows', () => {
    for (const alt of [0.001, 0.01, 0.1, 0.5, 1, 3]) {
      expect(viewSpanDeg(alt)).toBeLessThanOrEqual(visibleSpanDeg(alt) + 1e-9)
    }
  })

  it('grows with altitude and with a wider lens', () => {
    let last = 0
    for (const alt of [0.001, 0.01, 0.05, 0.2, 1]) {
      const s = viewSpanDeg(alt)
      expect(s).toBeGreaterThan(last)
      last = s
    }
    expect(viewSpanDeg(0.02, 80)).toBeGreaterThan(viewSpanDeg(0.02, 30))
  })

  it('is close to flat-earth geometry when the camera is low', () => {
    // a sanity check against a completely different calculation: at 0.02 radii
    // the camera is 127 km up and a 50 deg lens sees 2 * 127 * tan(25 deg)
    const km = 2 * 0.02 * 6371 * Math.tan(((DEFAULT_FOV / 2) * Math.PI) / 180)
    expect(viewSpanDeg(0.02) * 111.32).toBeCloseTo(km, -1)
  })

  it('cuts the patch to the frame, so the bbox shrinks with it', () => {
    const b = viewBbox(0, 0, 0.02)
    expect(b.maxLat - b.minLat).toBeCloseTo(viewSpanDeg(0.02) * PATCH_MARGIN, 6)
  })
})

describe('altitudeForFrameKm', () => {
  it('round-trips against the frame-span calculation', () => {
    for (const km of [1, 20, 100, 500]) {
      expect(viewSpanDeg(altitudeForFrameKm(km)) * 111.32).toBeCloseTo(km, 1)
    }
  })

  it('is far higher than the same span measured on the horizon', () => {
    // the distinction the pre-1930 cap turns on: a 20 km horizon is 7.8 m up
    expect(altitudeForFrameKm(20)).toBeGreaterThan(altitudeForViewKm(20) * 100)
    expect(altitudeForViewKm(20) * 6371).toBeLessThan(0.05) // km, i.e. metres up
    expect(altitudeForFrameKm(20) * 6371).toBeGreaterThan(10) // km
  })

  it('needs a higher camera for a wider frame, and a lower one for a wider lens', () => {
    expect(altitudeForFrameKm(100)).toBeGreaterThan(altitudeForFrameKm(20))
    expect(altitudeForFrameKm(20, 80)).toBeLessThan(altitudeForFrameKm(20, 30))
  })
})

describe('bbox shape at the closest zoom', () => {
  it('keeps the screen shape at the satellite-era floor', () => {
    // the longitude clamp used to floor at 0.05 deg, which at a ~180 m frame
    // stretched the rectangle to nineteen times its width
    const aspect = 1200 / 900
    const b = viewBbox(46, 8, MIN_ALTITUDE_DETAIL, aspect)
    const latSpan = b.maxLat - b.minLat
    const lngSpan = b.maxLng - b.minLng
    const groundRatio = (lngSpan * Math.cos((46 * Math.PI) / 180)) / latSpan
    expect(groundRatio).toBeCloseTo(aspect, 2)
  })
})

import { patchPixelCap } from '../src/lib/detailImagery'

describe('patchPixelCap', () => {
  it('never exceeds the GL limit or the hard ceiling', () => {
    expect(patchPixelCap({ maxTextureSize: 2048, deviceMemoryGb: 32 })).toBe(2048)
    expect(patchPixelCap({ maxTextureSize: 16384, deviceMemoryGb: 32 })).toBe(MAX_PATCH_PX)
  })

  it('shrinks the ceiling on a device with little memory to lose', () => {
    const big = patchPixelCap({ deviceMemoryGb: 16 })
    const small = patchPixelCap({ deviceMemoryGb: 2 })
    expect(small).toBeLessThan(big)
    // and the saving is what matters: bytes go as the square
    expect(small * small * 4).toBeLessThan(big * big * 4 * 0.2)
  })

  it('reads a dense screen with no memory hint as a phone, not a workstation', () => {
    // guessing wrong this way costs a slightly softer patch; the other way is a
    // 30 MB upload on a device that cannot absorb it
    expect(patchPixelCap({ devicePixelRatio: 3 })).toBeLessThan(
      patchPixelCap({ devicePixelRatio: 1 }),
    )
  })

  it('is monotonic in memory and always usable', () => {
    let last = 0
    for (const gb of [1, 2, 4, 8, 16]) {
      const cap = patchPixelCap({ deviceMemoryGb: gb })
      expect(cap).toBeGreaterThanOrEqual(last)
      expect(cap).toBeGreaterThanOrEqual(512)
      last = cap
    }
  })

  it('leaves the explicit hint in charge of a dense screen', () => {
    expect(patchPixelCap({ devicePixelRatio: 3, deviceMemoryGb: 16 })).toBe(MAX_PATCH_PX)
  })
})



/**
 * Invariants the reported zoom artefact broke. Each one is a property that has
 * to hold on every frame, not a scenario — a single frame where one of these
 * fails is a stretched or nested patch on screen.
 */
describe('composite atomicity', () => {
  const CLOSE = 0.02

  beforeEach(() => {
    vi.useFakeTimers()
    FakeImage.reset()
    FakeCanvas.made = []
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const settle = (d: DetailImagery, lat: number, lng: number, alt: number, rounds = 3) => {
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < 24; i++) {
        d.update(lat, lng, alt, 900, 1)
        vi.advanceTimersByTime(16)
      }
      FakeImage.landAll()
      vi.advanceTimersByTime(SETTLE_MS + 32)
    }
  }

  it('publishes a rectangle that describes the pixels it just drew', () => {
    // The shader stretches whatever texture it holds across uDetailRect. If the
    // rectangle moves without the pixels moving with it, the imagery is drawn
    // over ground it does not belong to — stretched, and out of register with
    // the base map under it.
    const d = new DetailImagery()
    for (const alt of [0.05, 0.04, 0.03, 0.02]) {
      settle(d, 45, 10, alt)
      const wanted = viewBbox(45, 10, alt, 1)
      const [u0, v0, du, dv] = d.rect
      expect(u0 * 360 - 180).toBeCloseTo(wanted.minLng, 3)
      expect(v0 * 180 - 90).toBeCloseTo(wanted.minLat, 3)
      expect(du * 360).toBeCloseTo(wanted.maxLng - wanted.minLng, 3)
      expect(dv * 180).toBeCloseTo(wanted.maxLat - wanted.minLat, 3)
    }
    d.dispose()
  })

  it('never lets a skipped redraw leave the rectangle pointing at old pixels', () => {
    // The composite is deliberately not redrawn when it would produce the same
    // canvas. That is only safe while "the same canvas" includes the rectangle
    // it was cut to: a skip that let the rectangle move would stretch the pixels
    // that were already there across the new one.
    const d = new DetailImagery()
    settle(d, 45, 10, CLOSE)
    const canvas = FakeCanvas.made[0]

    const seen = new Map<string, string>()
    let previous = ''
    for (let i = 0; i < 12; i++) {
      d.update(45, 10 + i * 0.02, CLOSE, 900, 1)
      vi.advanceTimersByTime(SETTLE_MS + 32)
      const rect = d.rect.map((n) => n.toFixed(6)).join(',')
      const pixels = canvas.ops
        .map((o) => `${o.x.toFixed(2)}:${o.y.toFixed(2)}:${o.w.toFixed(2)}`)
        .join('|')
      // A move small enough to stay inside the margin is now skipped outright —
      // the composite already covers the screen (see the fast path in update).
      // The rectangle it was published with has to stay put through that, which
      // is the invariant in its sharpest form: no draw, no new rectangle.
      if (!pixels) expect(rect).toBe(previous)
      // …and one rectangle can only ever go with one arrangement of pixels
      else {
        const held = seen.get(rect)
        if (held !== undefined) expect(pixels).toBe(held)
        seen.set(rect, pixels)
      }
      previous = rect
      canvas.ops.length = 0
    }
    d.dispose()
  })

  it('never draws the composite canvas into itself', () => {
    // Source and destination being the same canvas is undefined at best and a
    // feedback loop at worst, each generation nesting a copy of the last.
    const d = new DetailImagery()
    settle(d, 45, 10, CLOSE)
    const canvas = FakeCanvas.made[0]
    for (let i = 0; i < 8; i++) {
      d.update(45, 10 + i * 0.05, CLOSE, 900, 1)
      vi.advanceTimersByTime(40)
      FakeImage.landAll()
    }
    expect(canvas.ops.every((o) => o.image !== canvas)).toBe(true)
    d.dispose()
  })

  it('reuses a sharpened copy only at the geometry it was computed for', async () => {
    // A Lanczos copy is a picture of one source rectangle at one size. Drawn
    // into a destination that does not match, it lands scaled and offset from
    // the ground it belongs to: a sharp ghost over the correctly placed
    // imagery. The reuse test used to allow 5% of drift and ignored the crop's
    // height entirely.
    const d = new DetailImagery({
      resampler: {
        run: async (_image, crop, dw, dh) => {
          const c = {
            width: dw,
            height: dh,
            tag: `${Math.round(crop.x)},${Math.round(crop.y)},${Math.round(crop.w)},${Math.round(crop.h)}@${dw}x${dh}`,
          }
          return c as unknown as CanvasImageSource
        },
        dispose: () => {},
      },
    })
    for (let i = 0; i < 24; i++) {
      d.update(45, 10, 0.09, 900, 1)
      vi.advanceTimersByTime(16)
    }
    FakeImage.landAll()
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 32)

    const canvas = FakeCanvas.made[0]
    // walk the camera in, so the wanted crop and destination drift continuously
    for (let i = 0; i < 14; i++) {
      d.update(45, 10, 0.09 - i * 0.004, 900, 1)
      await vi.advanceTimersByTimeAsync(SETTLE_MS + 32)
      FakeImage.landAll()
      await vi.advanceTimersByTimeAsync(SETTLE_MS + 32)
    }
    // every draw of a resampled copy must be at the size that copy was made for
    let drawn = 0
    for (const op of canvas.ops) {
      const c = op.image as { width?: number; height?: number; tag?: string } | undefined
      if (!c?.tag) continue
      drawn++
      expect(Math.round(op.w)).toBe(c.width)
      expect(Math.round(op.h)).toBe(c.height)
    }
    // and the check must not pass by never exercising the path
    expect(drawn).toBeGreaterThan(0)
    d.dispose()
  })
})

describe('cached imagery is released, not just dropped', () => {
  /**
   * An altitude where the fallback level is genuinely magnified.
   *
   * The magnification is 2 x (screen density / target level density), and the
   * target level is the smallest whose density clears the screen — so the ratio
   * runs from just over 1 at the bottom of a level band to 2 at the top, and
   * only the upper part of each band is above RESAMPLE_MIN_SCALE. At 0.014 the
   * fallback lands at 1.69x, comfortably inside it; at 0.02 it is 1.18x and
   * bilinear is the right answer.
   */
  const MAGNIFY = 0.014

  beforeEach(() => {
    vi.useFakeTimers()
    FakeImage.reset()
    FakeCanvas.made = []
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** An ImageBitmap, as far as `instanceof` and `close()` are concerned. */
  class FakeBitmap {
    static made: FakeBitmap[] = []
    closed = false
    constructor(public width: number, public height: number) {
      FakeBitmap.made.push(this)
    }
    close() {
      this.closed = true
    }
  }

  /** A resampler that hands back a bitmap, so eviction has something to close. */
  const withBitmaps = () =>
    new DetailImagery({
      // A budget of a dozen tiles, so eviction is forced by the route below
      // whatever TILE_MEMORY_BUDGET ships as — the test is about *releasing*
      // evicted bitmaps, not about how big the production cache is.
      tileBudget: 12 * 512 * 512 * 4,
      resampler: {
        run: async () => new FakeBitmap(64, 64) as unknown as CanvasImageSource,
        dispose: () => {},
      },
    })

  const visit = async (d: DetailImagery, lng: number) => {
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 24; i++) {
        d.update(45, lng, MAGNIFY, 900, 1)
        vi.advanceTimersByTime(16)
      }
      FakeImage.landAll()
      await vi.advanceTimersByTimeAsync(SETTLE_MS + 32)
    }
  }

  it('closes the sharpened copies of the tiles it evicted', async () => {
    FakeBitmap.made = []
    vi.stubGlobal('ImageBitmap', FakeBitmap)
    const d = withBitmaps()
    // three views far enough apart that none of their tiles overlap: between
    // them they want more decoded imagery than the byte budget allows
    for (const lng of [10, 60, 110, 160]) await visit(d, lng)
    expect(FakeBitmap.made.length).toBeGreaterThan(0)
    expect(FakeBitmap.made.some((b) => b.closed)).toBe(true) // eviction did happen
    d.dispose()
  })

  it('closes what it still holds when it is disposed', async () => {
    FakeBitmap.made = []
    vi.stubGlobal('ImageBitmap', FakeBitmap)
    const d = withBitmaps()
    await visit(d, 10)
    expect(FakeBitmap.made.length).toBeGreaterThan(0)
    d.dispose()
    expect(FakeBitmap.made.every((b) => b.closed)).toBe(true)
  })
})

/**
 * The one magnification the pyramid still needs.
 *
 * A target-level tile is drawn at or below its own scale, so it never needs
 * reconstructing. The fallback level does: it is drawn at its children's scale,
 * an exact 2x up in the limit, and it is what the whole frame shows during a
 * gesture and wherever the sharp level has not arrived. So the Lanczos path is
 * spent there and nowhere else — and never inside the caller's task.
 */
describe('magnifying the fallback level', () => {
  /**
   * An altitude where the fallback level is genuinely magnified.
   *
   * The magnification is 2 x (screen density / target level density), and the
   * target level is the smallest whose density clears the screen — so the ratio
   * runs from just over 1 at the bottom of a level band to 2 at the top, and
   * only the upper part of each band is above RESAMPLE_MIN_SCALE. At 0.014 the
   * fallback lands at 1.69x, comfortably inside it; at 0.02 it is 1.18x and
   * bilinear is the right answer.
   */
  const MAGNIFY = 0.014

  beforeEach(() => {
    vi.useFakeTimers()
    FakeImage.reset()
    FakeCanvas.made = []
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('asks for one resample per tile, however many frames a zoom takes', async () => {
    const asked: unknown[] = []
    const d = new DetailImagery({
      resampler: {
        run: async (image) => {
          asked.push(image)
          return undefined
        },
        dispose: () => {},
      },
    })
    for (let i = 0; i < 24; i++) {
      d.update(45, 10, MAGNIFY, 900, 1)
      vi.advanceTimersByTime(16)
    }
    FakeImage.landAll(1) // the fallback level, which is what gets magnified
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 32)
    const atRest = asked.length
    expect(atRest).toBeGreaterThan(0)
    expect(new Set(asked).size).toBe(atRest) // one job per tile, not one per frame

    // a continuous zoom: the wanted size changes every frame, and none of them
    // is worth filtering because the next frame replaces it
    for (let i = 0; i < 20; i++) {
      d.update(45, 10, MAGNIFY - i * 0.0002, 900, 1)
      await vi.advanceTimersByTimeAsync(16)
    }
    expect(asked.length).toBe(atRest)
    d.dispose()
  })

  it('never filters a pixel inside an update call', async () => {
    // A quarter of a second of Lanczos inside a zoom handler is a quarter of a
    // second of frozen input for a picture the next frame replaces.
    let inside = 0
    let updating = false
    const d = new DetailImagery({
      resampler: {
        run: async () => {
          if (updating) inside++
          return undefined
        },
        dispose: () => {},
      },
    })
    for (let i = 0; i < 24; i++) {
      d.update(45, 10, MAGNIFY, 900, 1)
      vi.advanceTimersByTime(16)
    }
    FakeImage.landAll()
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 32)
    for (let i = 0; i < 10; i++) {
      updating = true
      d.update(45, 10, MAGNIFY - i * 0.0002, 900, 1)
      updating = false
      await vi.advanceTimersByTimeAsync(16)
    }
    // the resampler is *asked* off the update call, and it answers off it too
    expect(inside).toBe(0)
    d.dispose()
  })

  it('does not sharpen a fallback tile its four children already hide', async () => {
    // A megapixel of Lanczos under imagery nobody can see through.
    const asked = new Set<unknown>()
    const d = new DetailImagery({
      resampler: {
        run: async (image) => {
          asked.add(image)
          return undefined
        },
        dispose: () => {},
      },
    })
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 24; i++) {
        d.update(45, 10, MAGNIFY, 900, 1)
        vi.advanceTimersByTime(16)
      }
      FakeImage.landAll()
      await vi.advanceTimersByTimeAsync(SETTLE_MS + 32)
    }
    const covered = asked.size
    // …and once the target level is complete, no further redraw asks for more
    for (let i = 0; i < 8; i++) {
      d.update(45, 10, MAGNIFY, 900, 1)
      await vi.advanceTimersByTimeAsync(16)
    }
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 32)
    expect(asked.size).toBe(covered)
    d.dispose()
  })
})

/**
 * The two properties a pan has to keep: the picture finishes, and it never gets
 * worse on the way. Both were reported broken from the field. The old pipeline
 * needed a union-coverage scan to hold them, because a composite cut to a
 * rectangle did not necessarily fill it; with a complete fallback level under
 * every composite, containing the view and covering it are the same statement.
 */
describe('panning to rest', () => {
  const CLOSE = 0.02

  beforeEach(() => {
    vi.useFakeTimers()
    FakeImage.reset()
    FakeCanvas.made = []
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const settleAt = (d: DetailImagery, lat: number, lng: number, rounds = 3) => {
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < 24; i++) {
        d.update(lat, lng, CLOSE, 900, 1)
        vi.advanceTimersByTime(16)
      }
      FakeImage.landAll()
      vi.advanceTimersByTime(SETTLE_MS + 32)
    }
  }

  it('fills the edge a pan too small to refetch has exposed', () => {
    // A pan past the composite's own 1.25x margin but well under a tile: the
    // case that used to leave a strip of base map along the leading edge that
    // no later frame would ever fill, because nothing had moved *enough*.
    const d = new DetailImagery()
    settleAt(d, 45, 10)
    const span = viewBboxFor(45, 10, CLOSE, 1)
    const nudge = (span.maxLng - span.minLng) * 0.16
    settleAt(d, 45, 10 + nudge)
    const want = viewBboxFor(45, 10 + nudge, CLOSE, 1)
    // the published rectangle is the view's own — every edge of it, not just
    // the two a centred pan happens to leave alone
    const held = bboxFromRect(d.rect)
    expect(held.minLng).toBeCloseTo(want.minLng, 6)
    expect(held.maxLng).toBeCloseTo(want.maxLng, 6)
    expect(held.minLat).toBeCloseTo(want.minLat, 6)
    expect(held.maxLat).toBeCloseTo(want.maxLat, 6)
    d.dispose()
  })

  it('never lets a rectangle be published that the view outgrows in place', () => {
    const d = new DetailImagery()
    settleAt(d, 45, 10)
    const span = viewBboxFor(45, 10, CLOSE, 1)
    const step = (span.maxLng - span.minLng) * 0.15
    let lng = 10
    for (let i = 0; i < 3; i++) {
      lng += step
      settleAt(d, 45, lng)
      const want = viewBboxFor(45, lng, CLOSE, 1)
      expect(bboxFromRect(d.rect).minLng).toBeCloseTo(want.minLng, 6)
      expect(bboxFromRect(d.rect).maxLng).toBeCloseTo(want.maxLng, 6)
    }
    d.dispose()
  })

  it('stops asking once the view is covered, however long it stands still', () => {
    // The other side of the same rule: a coverage test that never quite reached
    // its threshold would spend a request every settle for as long as the app
    // was open. Tile keys make the question exact instead of fractional.
    const d = new DetailImagery()
    settleAt(d, 45, 10, 5)
    const after = FakeImage.requests.length
    for (let i = 0; i < 200; i++) {
      d.update(45, 10, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    expect(FakeImage.requests).toHaveLength(after)
    d.dispose()
  })

  it('tolerates the camera creeping under orbit damping without refetching', () => {
    const d = new DetailImagery()
    settleAt(d, 45, 10, 5)
    const after = FakeImage.requests.length
    const span = viewBboxFor(45, 10, CLOSE, 1)
    const creep = (span.maxLng - span.minLng) * (MOTION_EPS / 2)
    for (let i = 0; i < 120; i++) {
      d.update(45, 10 + creep * Math.sin(i / 9), CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    expect(FakeImage.requests).toHaveLength(after)
    d.dispose()
  })
})

/**
 * A pan slow enough that no single frame of it clears MOTION_EPS.
 *
 * The field report was that a *very slow* drag staggered while a rapid one was
 * smooth — the opposite of every intuition about cost, and a classification bug
 * rather than a cost one. OrbitControls turns a drag into
 * `2π · rotateSpeed · dx / height` radians and globe.gl sets
 * `rotateSpeed = altitude · 0.3`, so the altitude cancels: a drag moves the view
 * by a fixed fraction of its own span per mouse pixel at every zoom, and a
 * per-frame epsilon of 0.002 was a *speed* limit of about 1.8 px per frame. Any
 * slower drag read as a still camera in the middle of the gesture, and the
 * still-camera pipeline ran on every frame of it: the settle path publishes
 * inline once `movedAt` is a settle old, and a publish is a full canvas upload
 * plus `generateMipmap`.
 *
 * Measured in Chromium over a 150-frame pan (tests/e2e/slowPan.e2e.mjs), before
 * the fix: at 0.0019 span/frame — 1.7 mouse px — 113 frames classified still and
 * 399 publishes, 523 megapixels, against 1 publish for the same gesture at
 * 0.0078 span/frame and 3 for a flick. After it, 0 and 0.
 */
describe('a slow pan is a pan', () => {
  const CLOSE = 0.02

  beforeEach(() => {
    vi.useFakeTimers()
    FakeImage.reset()
    FakeCanvas.made = []
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const settleAt = (d: DetailImagery, lat: number, lng: number, rounds = 3) => {
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < 24; i++) {
        d.update(lat, lng, CLOSE, 900, 1)
        vi.advanceTimersByTime(16)
      }
      FakeImage.landAll()
      vi.advanceTimersByTime(SETTLE_MS + 32)
    }
  }

  /**
   * A drag of `frames` frames, each moving the view east by `perFrame` of its
   * own span, tiles landing as they would. Returns what it cost the GPU: one
   * `clearRect` is one composite, and every composite is a publish.
   */
  const cost = (perFrame: number, frames: number, lng = 10) => {
    const d = new DetailImagery()
    settleAt(d, 45, lng)
    const span = viewBboxFor(45, lng, CLOSE, 1)
    const step = (span.maxLng - span.minLng) * perFrame
    const composite = FakeCanvas.made[0]
    const before = composite.cleared
    for (let i = 1; i <= frames; i++) {
      d.update(45, lng + step * i, CLOSE, 900, 1)
      FakeImage.landAll(1)
      vi.advanceTimersByTime(16)
    }
    const spent = composite.cleared - before
    d.dispose()
    return spent
  }

  it('defers publishes through a drag too slow to clear the per-frame epsilon', () => {
    // half the old speed limit — a hand holds this easily, and every frame of it
    // used to be a full upload and a mip chain rebuild
    expect(cost(MOTION_EPS / 2, 90)).toBeLessThanOrEqual(2)
  })

  it('defers them through a crawl, where the old rule was worst of all', () => {
    // a quarter of the epsilon per frame: the slower the drag, the longer the
    // machinery spent believing the camera had stopped
    expect(cost(MOTION_EPS / 4, 90)).toBeLessThanOrEqual(2)
  })

  it('spends no more on a slow pan than on the rapid pan that was already smooth', () => {
    expect(cost(MOTION_EPS / 2, 90)).toBeLessThanOrEqual(cost(MOTION_EPS * 10, 90))
  })

  it('still gets a picture on screen during a slow pan that never ends', () => {
    // The deferral may not strand the screen. A crawl outruns the composite's
    // own margin eventually, and when it does the fast path stops answering and
    // the escape hatch (PAN_MIN_COVER / PAN_PUBLISH_MS) publishes — by distance
    // travelled rather than per frame, so it is rare and it is bounded.
    const d = new DetailImagery()
    settleAt(d, 45, 10)
    const span = viewBboxFor(45, 10, CLOSE, 1)
    const step = (span.maxLng - span.minLng) * (MOTION_EPS / 2)
    const composite = FakeCanvas.made[0]
    const before = composite.cleared
    for (let i = 1; i <= 2000; i++) {
      d.update(45, 10 + step * i, CLOSE, 900, 1)
      FakeImage.landAll(1)
      vi.advanceTimersByTime(16)
    }
    const spent = composite.cleared - before
    expect(spent).toBeGreaterThan(0) // the screen is not stranded…
    expect(spent).toBeLessThan(40) // …nor is it repainted per frame
    expect(d.status).toBe('ready')
    d.dispose()
  })

  it('lets a decaying motion converge, so a released flick still settles', () => {
    // Displacement rather than speed still has to reach zero, or the imagery
    // waits forever on a camera that is technically moving. Orbit damping decays
    // geometrically, so what is left to travel shrinks and the last crossing of
    // the epsilon does come.
    const d = new DetailImagery()
    settleAt(d, 45, 10)
    const span = viewBboxFor(45, 10, CLOSE, 1)
    const width = span.maxLng - span.minLng
    let lng = 10
    let v = width * 0.05
    for (let i = 0; i < 200; i++) {
      lng += v
      v *= 0.9
      d.update(45, lng, CLOSE, 900, 1)
      FakeImage.landAll(1)
      vi.advanceTimersByTime(16)
    }
    // The camera has come to rest at the far end and the imagery followed it —
    // covering the view rather than cut exactly to it, since a last hair of
    // damping is precisely what the composite's margin is for.
    expect(coversView(bboxFromRect(d.rect), viewBboxFor(45, lng, CLOSE, 1, 1))).toBe(true)
    expect(d.status).toBe('ready')
    d.dispose()
  })

  it('publishes as promptly as ever for a camera that is parked', () => {
    // The other half of the contract: integrating motion must not delay the
    // first picture. A cold camera at a standstill has it one settle after the
    // tiles land, exactly as before.
    const d = new DetailImagery()
    for (let i = 0; i < 24; i++) {
      d.update(45, 10, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    FakeImage.landAll()
    expect(d.status).not.toBe('ready')
    vi.advanceTimersByTime(SETTLE_MS + 32)
    expect(d.status).toBe('ready')
    d.dispose()
  })

  it('has a floor, and it is a drift of one epsilon per settle', () => {
    // The honest edge of any epsilon: below 0.002 of a span per SETTLE_MS —
    // 0.07 mouse px per frame, ~4 px/s — a drift is indistinguishable from a
    // parked camera, and is treated as one. What keeps that cheap is no longer
    // the detector but the fast path in update(), which reuses a composite that
    // still covers the screen, so the cost is one publish per eighth of a span
    // travelled rather than one per frame. Measured in Chromium at 0.00008
    // span/frame — 0.07 mouse px — 157 publishes before, 0 after.
    const perFrame = (MOTION_EPS / SETTLE_MS) * 16 * 0.5
    expect(cost(perFrame, 90)).toBeLessThanOrEqual(2)
  })
})

describe('the cost of a frame that is only moving', () => {
  /**
   * A canvas that counts what is expensive about one: how many times its
   * backing store was reallocated, and how many contexts were asked for.
   */
  class CountingCanvas {
    static made: CountingCanvas[] = []
    static resizes = 0
    static contexts = 0
    /** …and per canvas, so the composite can be told from the scratch. */
    mine = { resizes: 0, contexts: 0 }
    #w = 0
    #h = 0
    gradients = 0
    draws = 0
    clears = 0
    set width(v: number) {
      CountingCanvas.resizes++
      this.mine.resizes++
      this.#w = v
    }
    get width() {
      return this.#w
    }
    set height(v: number) {
      CountingCanvas.resizes++
      this.mine.resizes++
      this.#h = v
    }
    get height() {
      return this.#h
    }
    constructor() {
      CountingCanvas.made.push(this)
    }
    getContext() {
      CountingCanvas.contexts++
      this.mine.contexts++
      return {
        clearRect: () => this.clears++,
        drawImage: () => this.draws++,
        createLinearGradient: () => {
          this.gradients++
          return { addColorStop: () => {} }
        },
        fillRect: () => {},
        set fillStyle(_v: unknown) {},
        set globalCompositeOperation(_v: unknown) {},
        set imageSmoothingQuality(_v: unknown) {},
      }
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    FakeImage.reset()
    CountingCanvas.made = []
    CountingCanvas.resizes = 0
    CountingCanvas.contexts = 0
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('document', { createElement: () => new CountingCanvas() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const CLOSE = 0.02
  const settle = (d: DetailImagery, lat: number, lng: number) => {
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 24; i++) {
        d.update(lat, lng, CLOSE, 900, 1)
        vi.advanceTimersByTime(16)
      }
      FakeImage.landAll()
      vi.advanceTimersByTime(SETTLE_MS + 32)
    }
  }

  it('does not reallocate the composite canvas once it has one', () => {
    // The composite canvas is deliberately one size for the session (see
    // compositeCanvasSize), so every recomposite after the first draws at
    // exactly the size it drew at last time. Assigning `width`/`height` anyway
    // is not free and not a no-op: the spec resets the backing store — and
    // every piece of context state with it — whatever value is assigned.
    const d = new DetailImagery()
    settle(d, 45, 10)
    const composite = CountingCanvas.made[0]
    const after = { ...composite.mine }
    expect(after.resizes).toBeGreaterThan(0) // it was sized once, obviously
    expect(composite.width).toBeGreaterThan(0)
    const span = viewBboxFor(45, 10, CLOSE, 1)
    const step = (span.maxLng - span.minLng) * 0.3
    for (let i = 1; i <= 6; i++) settle(d, 45, 10 + step * i)
    // the scratch canvas legitimately changes size with each tile's footprint;
    // the composite's own must not have been touched again
    expect(composite.mine.resizes, 'the composite canvas was resized again').toBe(after.resizes)
    expect(
      composite.mine.contexts,
      'a composite asks for a context it already holds',
    ).toBe(after.contexts)
    d.dispose()
  })

  it('draws nothing at all on a frame that is only moving', () => {
    // The scheduler runs every frame — it has to, the wanted set follows the
    // camera — but the expensive half does not. A composite is a full texture
    // upload and a full mip rebuild, and mid-gesture it buys one frame of
    // imagery the next frame replaces.
    const d = new DetailImagery()
    settle(d, 45, 10)
    const composite = CountingCanvas.made[0]
    const before = { draws: composite.draws, clears: composite.clears }
    const span = viewBboxFor(45, 10, CLOSE, 1)
    const wide = (span.maxLng - span.minLng) * 3
    for (let i = 1; i <= 20; i++) {
      d.update(45, 10 + (wide * i) / 20, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
      FakeImage.landAll()
    }
    // one escape-hatch composite is allowed across a drag this long (see
    // PAN_MIN_COVER); twenty is the bug
    expect(composite.clears - before.clears).toBeLessThanOrEqual(1)
    expect(composite.draws).toBeGreaterThan(before.draws - 1)
    d.dispose()
  })
})
