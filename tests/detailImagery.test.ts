import { describe, it, expect } from 'vitest'
import {
  viewBbox,
  bboxToUvRect,
  imageSize,
  visibleSpanDeg,
  minAltitudeFor,
  IMAGERY_ERA_FROM,
  MIN_ALTITUDE_DETAIL,
  MIN_ALTITUDE_PRE_ERA,
  PRE_ERA_VIEW_KM,
  MAX_PATCH_PX,
  PATCH_MARGIN,
  requestedPxPerDeg,
  viewSpanDeg,
  DEFAULT_FOV,
  DETAIL_ON_TEXELS,
  DETAIL_OFF_TEXELS,
  degPerScreenPx,
  baseTexelsPerScreenPx,
  detailWanted,
  planetFillsFrame,
  clampBboxSpan,
  pickSource,
  requestScreenPx,
  compositeCanvasSize,
  snapCompositeSize,
  RESAMPLE_MAX_PX,
  type Bbox,
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
    const { height } = imageSize(b, 4000, 2048, 222)
    const latSpan = b.maxLat - b.minLat
    expect(height).toBeLessThanOrEqual(Math.ceil(latSpan * 222) + 192)
    expect(height).toBeLessThan(2048) // and so stays quick to fetch
  })

  it('lets the sharper source out-resolve the base one wherever a patch shows', () => {
    // Now that the patch is cut to the frame rather than to the horizon, the
    // rectangle is small enough that Blue Marble's 500 m ceiling bites across
    // the whole range a patch is shown in, and the 10 m source always pulls
    // ahead. It used to tie with it at the far end.
    for (const alt of [0.0015, 0.02, 0.05]) {
      const b = viewBbox(45, 10, alt)
      const base = imageSize(b, 2400, MAX_PATCH_PX, BASE_SOURCE.pxPerDeg)
      const sharp = imageSize(b, 2400, MAX_PATCH_PX, SHARP_SOURCE.pxPerDeg)
      expect(sharp.height).toBeGreaterThan(base.height)
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

describe('clampBboxSpan', () => {
  const box = { minLat: 0, maxLat: 40, minLng: -30, maxLng: 50 }

  it('leaves a rectangle inside the limit exactly as it was', () => {
    expect(clampBboxSpan(box, 100)).toBe(box)
  })

  it('shrinks about the centre, keeping the shape', () => {
    const c = clampBboxSpan(box, 40)
    expect((c.minLat + c.maxLat) / 2).toBeCloseTo(20, 9)
    expect((c.minLng + c.maxLng) / 2).toBeCloseTo(10, 9)
    expect(Math.max(c.maxLat - c.minLat, c.maxLng - c.minLng)).toBeCloseTo(40, 9)
    const before = (box.maxLng - box.minLng) / (box.maxLat - box.minLat)
    expect((c.maxLng - c.minLng) / (c.maxLat - c.minLat)).toBeCloseTo(before, 9)
  })

  it('never leaves valid geographic bounds', () => {
    const c = clampBboxSpan({ minLat: -90, maxLat: 90, minLng: -180, maxLng: 180 }, 30)
    expect(c.minLat).toBeGreaterThanOrEqual(-90)
    expect(c.maxLng).toBeLessThanOrEqual(180)
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

describe('requestScreenPx', () => {
  it('is the frame height in device pixels close in, where that is right', () => {
    for (const alt of [0.02, 0.004, 0.0005]) {
      const frame = viewBbox(20, 10, alt)
      expect(requestScreenPx(frame, alt, 1800)).toBeCloseTo(1800, -1)
    }
  })

  it('scales with the latitude span the request actually covers', () => {
    const alt = 0.02
    const frame = viewBbox(20, 10, alt)
    const cut = clampBboxSpan(frame, (frame.maxLat - frame.minLat) / 2)
    const ratio = (cut.maxLat - cut.minLat) / (frame.maxLat - frame.minLat)
    expect(requestScreenPx(cut, alt, 1800) / requestScreenPx(frame, alt, 1800)).toBeCloseTo(ratio, 9)
  })

  it('sizes wide requests on the centre density, not the frame average', () => {
    // at wide zoom the limb is foreshortened to nothing, so the frame's average
    // px/deg is far below what the middle of the screen actually resolves;
    // sizing on the average returned patches coarser than the base map
    const alt = 1.2
    const frame = viewBbox(20, 10, alt)
    const box = clampBboxSpan(frame, BASE_SOURCE.maxSpanDeg)
    const size = imageSize(box, requestScreenPx(box, alt, 1800), MAX_PATCH_PX, BASE_SOURCE.pxPerDeg)
    expect(requestedPxPerDeg(box, size)).toBeGreaterThan(BASE_TEXTURE_PX_PER_DEG)
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
  static last?: FakeImage
  crossOrigin = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private url = ''
  get src() {
    return this.url
  }
  set src(v: string) {
    this.url = v
    FakeImage.requests.push(v)
    FakeImage.last = this
  }
}

describe('DetailImagery streaming', () => {
  const CLOSE = 0.02 // ~23 deg span: patch territory
  // world view: the globe sits inside the lens, so there is no rectangle worth
  // asking for however coarse the base map looks
  const FAR = 2.5

  beforeEach(() => {
    vi.useFakeTimers()
    FakeImage.requests = []
    FakeImage.last = undefined
    vi.stubGlobal('Image', FakeImage)
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

  it('still requests imagery when update runs every frame', () => {
    // the settle timer was cleared and re-armed on every call, so it never
    // elapsed and no patch was ever fetched at all
    const d = new DetailImagery()
    frames(d, Math.ceil(SETTLE_MS / 16) + 4)
    expect(FakeImage.requests).toHaveLength(1)
  })

  it('does not re-request while the camera holds still', () => {
    const d = new DetailImagery()
    frames(d, 200)
    expect(FakeImage.requests).toHaveLength(1)
  })

  it('drops a queued request when the camera zooms back out', () => {
    const d = new DetailImagery()
    d.update(45, 10, CLOSE, 900, 1)
    vi.advanceTimersByTime(SETTLE_MS / 2) // still queued
    d.update(45, 10, FAR, 900, 1)
    vi.advanceTimersByTime(SETTLE_MS * 2)
    expect(FakeImage.requests).toHaveLength(0)
    expect(d.mix).toBe(0)
  })

  it('publishes resolution only once the image it describes has arrived', () => {
    const d = new DetailImagery()
    frames(d, 30)
    expect(FakeImage.requests).toHaveLength(1)
    expect(d.groundRes).toBe(0) // in flight: nothing on screen to describe yet
    FakeImage.last!.onload!()
    expect(d.groundRes).toBeGreaterThan(0)
    expect(d.status).toBe('ready')
  })

  it('keeps the loaded source name when the patch is hidden and shown again', () => {
    const d = new DetailImagery()
    frames(d, 30)
    FakeImage.last!.onload!()
    expect(d.sourceLabel).toBe(SHARP_SOURCE.label)

    d.update(45, 10, FAR, 900, 1) // zoom out: patch retires
    expect(d.sourceLabel).toBe('—')

    d.update(45, 10, CLOSE, 900, 1) // and back: the same texture is re-shown
    expect(d.mix).toBe(1)
    expect(d.sourceLabel).toBe(SHARP_SOURCE.label) // not the fallback's name
    expect(d.attribution).toBe(SHARP_SOURCE.attribution)
  })

  it('streams at mid zoom, where it used to show a magnified world map', () => {
    // altitude 0.3: a 17 deg frame. The old gate (horizon span under 42 deg)
    // did not fire until 0.071, so this whole range showed the 4096 base map
    // magnified ten times with nothing on its way.
    const d = new DetailImagery()
    frames(d, 30, 45, 10, 0.3)
    expect(FakeImage.requests).toHaveLength(1)
    // and it asks the source that can actually render a box that wide
    expect(FakeImage.requests[0]).toContain(BASE_SOURCE.endpoint)
    d.dispose()
  })

  it('never asks a source for a wider box than it will serve', () => {
    for (const alt of [1.2, 0.8, 0.4, 0.3, 0.1, 0.02, 0.002]) {
      FakeImage.requests = []
      const d = new DetailImagery()
      frames(d, 30, 20, 10, alt)
      expect(FakeImage.requests).toHaveLength(1)
      const url = new URL(FakeImage.requests[0])
      const [a, b, c, e] = (url.searchParams.get('bbox') ?? '').split(',').map(Number)
      const sharp = url.href.includes(SHARP_SOURCE.endpoint)
      // 1.3.0 is lat,lng and 1.1.1 is lng,lat, so compare both spans
      const span = Math.max(Math.abs(c - a), Math.abs(e - b))
      expect(span).toBeLessThanOrEqual(
        (sharp ? SHARP_SOURCE.maxSpanDeg : BASE_SOURCE.maxSpanDeg) + 1e-6,
      )
      d.dispose()
    }
  })

  it('sizes a clamped request to the screen, not to the frame it was cut from', () => {
    // a box clamped to a fraction of the frame covers that fraction of the
    // screen; asking for the full frame's pixel count would oversample by
    // exactly the amount it was clamped by, and cost the same multiple
    const d = new DetailImagery()
    frames(d, 30, 20, 10, 1.2) // ~110 deg frame, clamped to the base source's 60
    const url = new URL(FakeImage.requests[0])
    const width = Number(url.searchParams.get('width'))
    const height = Number(url.searchParams.get('height'))
    expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_PATCH_PX)
    const [minLat, , maxLat] = (url.searchParams.get('bbox') ?? '').split(',').map(Number)
    // finer than the world texture it is replacing — only just, at a frame
    // this wide, which is exactly what "the base map has just stopped keeping
    // up" means; the margin grows fast as the camera descends
    expect(height / (maxLat - minLat)).toBeGreaterThan(BASE_TEXTURE_PX_PER_DEG)
    d.dispose()
  })

  it('falls back to the base source after the sharp one fails twice', () => {
    const d = new DetailImagery()
    frames(d, 30)
    expect(FakeImage.requests[0]).toContain(SHARP_SOURCE.endpoint)
    FakeImage.last!.onerror!()
    FakeImage.last!.onerror!()
    expect(FakeImage.requests[2]).toContain(BASE_SOURCE.endpoint)
  })
})

describe('requested resolution', () => {
  /**
   * The complaint this answers: patches looked softer than the zoom warranted.
   * The screen asks for `screenPx` device pixels down its height and sees
   * `visibleSpanDeg` degrees of ground, so anything below that ratio is visibly
   * upsampled. The only excuses are the source's own native resolution and the
   * hard texture ceiling.
   */
  const ALTITUDES = [0.4, 0.2, 0.08, 0.03, 0.01, 0.004, 0.001, MIN_ALTITUDE_DETAIL]
  const SCREENS = [900, 1600, 2880] // laptop, desktop, retina laptop at dpr 2

  it('meets the screen density at every altitude, unless a real limit stops it', () => {
    for (const alt of ALTITUDES) {
      for (const screenPx of SCREENS) {
        if (!detailWanted(alt, screenPx)) continue
        for (const aspect of [1, 1.6]) {
          const b = viewBbox(20, 10, alt, aspect)
          const size = imageSize(b, screenPx, MAX_PATCH_PX, SHARP_SOURCE.pxPerDeg)
          const got = requestedPxPerDeg(b, size)
          const wanted = screenPx / viewSpanDeg(alt)
          const atCeiling = Math.max(size.width, size.height) >= MAX_PATCH_PX - 1
          const atSourceLimit = got >= SHARP_SOURCE.pxPerDeg * 0.99
          // the only excuses are the texture ceiling and the source's own
          // native resolution; anything else is a request we simply under-asked
          expect(got >= wanted * 0.999 || atCeiling || atSourceLimit).toBe(true)
        }
      }
    }
  })

  it('was short of the screen at the old 1536 ceiling, which is why it looked soft', () => {
    const b = viewBbox(0, 10, 0.01)
    const screenPxPerDeg = 1600 / viewSpanDeg(0.01)
    const old = imageSize(b, 1600, 1536, SHARP_SOURCE.pxPerDeg)
    expect(requestedPxPerDeg(b, old)).toBeLessThan(screenPxPerDeg * 0.9)
    const now = imageSize(b, 1600, MAX_PATCH_PX, SHARP_SOURCE.pxPerDeg)
    expect(requestedPxPerDeg(b, now)).toBeGreaterThanOrEqual(screenPxPerDeg * 0.999)
  })

  it('still refuses to out-ask a source past its native resolution', () => {
    for (const alt of [0.05, 0.02, 0.008]) {
      const b = viewBbox(0, 0, alt)
      const size = imageSize(b, 4000, MAX_PATCH_PX, BASE_SOURCE.pxPerDeg)
      // below a few hundred pixels the request is not worth shrinking further,
      // so the floor is allowed to win; above it, the source's ceiling rules
      const atFloor = size.height <= 192
      expect(atFloor || requestedPxPerDeg(b, size) <= BASE_SOURCE.pxPerDeg * 1.01).toBe(true)
    }
    const wide = viewBbox(0, 0, 0.05)
    expect(imageSize(wide, 4000, MAX_PATCH_PX, BASE_SOURCE.pxPerDeg).height).toBeLessThan(
      imageSize(wide, 4000, MAX_PATCH_PX, SHARP_SOURCE.pxPerDeg).height,
    )
  })

  it('keeps degrees-per-pixel square even when the ceiling bites', () => {
    // a wide bbox used to clamp width alone, which stretched the sampling
    const b = viewBbox(70, 0, 0.05, 2.5)
    const { width, height } = imageSize(b, 6000, 1024, SHARP_SOURCE.pxPerDeg)
    expect(Math.max(width, height)).toBeLessThanOrEqual(1024)
    const perPxX = (b.maxLng - b.minLng) / width
    const perPxY = (b.maxLat - b.minLat) / height
    expect(perPxY / perPxX).toBeCloseTo(1, 1)
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
  constructor() {
    FakeCanvas.made.push(this)
  }
  getContext() {
    return {
      clearRect: () => this.cleared++,
      drawImage: (image: unknown, x: number, y: number, w: number, h: number) =>
        this.ops.push({ image, x, y, w, h }),
    }
  }
}

describe('cached patch compositing', () => {
  const CLOSE = 0.02
  /** A pan of ~27% of the patch width: past the refetch threshold, well inside it. */
  const PAN = (() => {
    const b = viewBbox(45, 10, CLOSE, 1)
    return (b.maxLng - b.minLng) * 0.27
  })()

  beforeEach(() => {
    vi.useFakeTimers()
    FakeImage.requests = []
    FakeImage.last = undefined
    FakeCanvas.made = []
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Settle, fetch and land one patch at the given point. */
  const land = (d: DetailImagery, lat: number, lng: number) => {
    for (let i = 0; i < 30; i++) {
      d.update(lat, lng, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    FakeImage.last!.onload!()
  }

  it('composites a patch the moment it arrives, rather than showing it raw', () => {
    // One route to the shader, not two. A patch used to be published directly
    // on arrival and composited on every later move, so the rectangle the
    // shader feathered against changed from the request's box to the view's box
    // and back — and the edge of the imagery moved with it.
    const d = new DetailImagery()
    land(d, 45, 10)
    const canvas = FakeCanvas.made[0]
    expect(canvas).toBeDefined()
    expect(canvas.ops).toHaveLength(1)
    expect(canvas.ops[0].image).toBe(FakeImage.last)
    expect(d.mix).toBe(1)
  })

  it('redraws the patch it holds onto the new view, out of the cache and after the drag', () => {
    const d = new DetailImagery()
    land(d, 45, 10)
    const rectBefore = [...d.rect]
    const requestsBefore = FakeImage.requests.length
    const held = FakeImage.last // the patch already on screen
    // the canvas is reused between composites, so clear the record rather than
    // the instance
    const canvas = FakeCanvas.made[0]
    canvas.ops.length = 0
    canvas.cleared = 0

    d.update(45, 10 + PAN, CLOSE, 900, 1) // a pan of ~27% of the patch width
    // Nothing at all happens while the camera is moving. A composite is a full
    // texture upload and a full mip rebuild — 111 ms measured — and mid-drag it
    // buys one frame of imagery on the newly exposed edge before the next drag
    // frame replaces it. That is the stutter that was reported, so the drag
    // costs neither a publish nor a request.
    expect(canvas.ops).toHaveLength(0)
    expect(FakeImage.requests).toHaveLength(requestsBefore)

    vi.advanceTimersByTime(SETTLE_MS + 1)
    expect(canvas).toBeDefined()
    expect(canvas.ops).toHaveLength(1) // the one patch we own
    expect(canvas.cleared).toBe(1) // and nothing stale left under it
    // the patch is now to the *west* of the view, so it is drawn left of centre
    expect(canvas.ops[0].x).toBeLessThan(0)
    expect(canvas.ops[0].y).toBeCloseTo(0, 6) // same latitude: no vertical shift
    // the texture now covers the new view, and the picture came out of the
    // cache: it is the patch we already had, not the one the settle has only
    // just gone to ask for
    expect(d.rect).not.toEqual(rectBefore)
    expect(d.mix).toBe(1)
    expect(canvas.ops[0].image).toBe(held)
  })

  it('still issues the fresh request after the camera settles', () => {
    const d = new DetailImagery()
    land(d, 45, 10)
    d.update(45, 10 + PAN, CLOSE, 900, 1)
    expect(FakeImage.requests).toHaveLength(1) // composited, not fetched
    vi.advanceTimersByTime(SETTLE_MS + 32)
    expect(FakeImage.requests).toHaveLength(2) // and then fetched
  })

  it('layers several cached patches, sharpest last', () => {
    const d = new DetailImagery()
    land(d, 45, 10) // west
    vi.advanceTimersByTime(SETTLE_MS * 2)
    land(d, 45, 10 + 2 * PAN) // east
    // the canvas is reused between composites, so clear the record rather than
    // the instance
    const canvas = FakeCanvas.made[0]
    canvas.ops.length = 0

    d.update(45, 10 + PAN, CLOSE, 900, 1) // back to the middle: both still show
    // The redraw is deferred to rest now: a composite mid-gesture is a full
    // texture upload and mip rebuild the user feels as a stutter, and imagery
    // they cannot see because the next drag frame replaces it. Same picture,
    // one settle later.
    vi.advanceTimersByTime(SETTLE_MS + 1)
    expect(canvas.ops).toHaveLength(2)
    // both patches are at the same zoom, so the tie-break is age: the newest
    // one — the one nearest the new view — must be drawn on top
    expect(canvas.ops[1].x).toBeGreaterThan(canvas.ops[0].x)
  })

  it('draws only the newest patch when a zoom leaves them nested', () => {
    // Each wheel notch asks for a smaller box around the same point, and now
    // that late patches are kept they all arrive. Stacked concentrically they
    // are a small image over a larger copy over a larger copy, joined by hard
    // rectangular edges no feather touches.
    const d = new DetailImagery()
    land(d, 45, 10)
    vi.advanceTimersByTime(SETTLE_MS * 2)
    for (let i = 0; i < 30; i++) {
      d.update(45, 10, CLOSE * 0.6, 900, 1)
      vi.advanceTimersByTime(16)
    }
    const canvas = FakeCanvas.made[0]
    canvas.ops.length = 0
    FakeImage.last!.onload!()
    expect(canvas.ops).toHaveLength(1)
  })

  it('does not composite a patch the camera has jumped away from', () => {
    const d = new DetailImagery()
    land(d, 45, 10)
    const before = FakeCanvas.made[0]?.ops.length ?? 0
    d.update(-40, -170, CLOSE, 900, 1) // the other side of the world
    expect(FakeCanvas.made[0]?.ops.length ?? 0).toBe(before) // nothing to draw
  })

  it('resamples a magnified patch, but never inside the caller\'s task', async () => {
    // A canvas that can actually read and write pixels, which the stub above
    // deliberately cannot: the resampler is skipped without readback, and the
    // point of this test is that it is *not* skipped when readback exists.
    class PixelCanvas {
      static made: PixelCanvas[] = []
      width = 0
      height = 0
      ops: { image: unknown; w: number; h: number }[] = []
      put = 0
      constructor() {
        PixelCanvas.made.push(this)
      }
      getContext() {
        return {
          clearRect: () => {},
          drawImage: (image: unknown, _x = 0, _y = 0, w = 0, h = 0) =>
            this.ops.push({ image, w, h }),
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4),
            width: w,
            height: h,
          }),
          putImageData: () => this.put++,
        }
      }
    }
    vi.stubGlobal('document', { createElement: () => new PixelCanvas() })
    vi.stubGlobal('ImageData', class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    })

    const d = new DetailImagery()
    // land a patch at a wide view, so what we hold is coarse...
    for (let i = 0; i < 30; i++) {
      d.update(45, 10, 0.09, 900, 1)
      vi.advanceTimersByTime(16)
    }
    const img = FakeImage.last!
    // the browser fills these in; the composite needs them to know the scale
    Object.assign(img, { naturalWidth: 600, naturalHeight: 400 })

    // ...then descend *before* it lands, so the composite the arrival triggers
    // draws that coarse patch onto a canvas cut to a much closer view. The
    // descent itself no longer redraws anything — the rectangle already
    // composited covers it, and the upload that redraw cost was the zoom-in
    // stall (see coversView) — so the arrival is what puts a magnified patch on
    // the canvas, which is the case this test is about.
    d.update(45, 10, 0.02, 900, 1)
    // An arrival mid-gesture normally goes into the cache and no further — a
    // composite is an upload and a mip rebuild, and the camera is still moving.
    // This one is the FIRST picture, which the deadline in `arm` deliberately
    // does not defer: a globe with no imagery on it at all waits for nobody. So
    // it lands here, unsharpened, which is what the next lines are about.
    img.onload!()

    // The zoom's own composite is bilinear: the raw image, straight onto the
    // canvas, and not one pixel filtered on the way. That is what keeps the
    // zoom handler inside a frame.
    const canvas = PixelCanvas.made.find((c) => c.ops.length)!
    expect(canvas).toBeDefined()
    expect(canvas.ops).not.toHaveLength(0)
    expect(canvas.ops[0].image).toBe(img)
    expect(PixelCanvas.made.every((c) => c.put === 0)).toBe(true)

    // ...and no frame of a zoom filters anything inside the update call. The
    // resample the *arrival* asked for does land during these frames — that is
    // the whole point of deferring it — so the invariant is measured across
    // each call rather than over the loop.
    const puts = () => PixelCanvas.made.reduce((s, c) => s + c.put, 0)
    for (let i = 0; i < 10; i++) {
      const before = puts()
      d.update(45, 10, 0.02 - i * 0.0005, 900, 1)
      expect(puts()).toBe(before)
      await vi.advanceTimersByTimeAsync(16)
    }

    // Then the camera settles, the resample runs off this task, and the
    // composite is redrawn with it — the same picture as before, only later.
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 32)
    expect(PixelCanvas.made.some((c) => c.put > 0)).toBe(true)
    const sharp = PixelCanvas.made
      .flatMap((c) => c.ops)
      .filter((o) => o.image instanceof PixelCanvas)
    expect(sharp.length).toBeGreaterThan(0)
    d.dispose()
  })

  it('asks for one resample per patch, however many frames a zoom takes', async () => {
    let calls = 0
    const d = new DetailImagery({
      resampler: {
        run: async () => {
          calls++
          return undefined
        },
        dispose: () => {},
      },
    })
    for (let i = 0; i < 30; i++) {
      d.update(45, 10, 0.09, 900, 1)
      vi.advanceTimersByTime(16)
    }
    Object.assign(FakeImage.last!, { naturalWidth: 600, naturalHeight: 400 })
    FakeImage.last!.onload!()
    // the camera was standing still when it landed, so this one is sharpened
    const onArrival = calls
    expect(onArrival).toBe(1)
    // a continuous zoom: the wanted size changes every frame, and none of them
    // is worth filtering because the next frame replaces it
    for (let i = 0; i < 20; i++) {
      d.update(45, 10, 0.05 - i * 0.0015, 900, 1)
      await vi.advanceTimersByTimeAsync(16)
    }
    expect(calls).toBe(onArrival)
    // one pass once the camera stops, not one per frame
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 32)
    expect(calls).toBe(onArrival + 1)
    d.dispose()
  })

  it('keeps a patch that arrives after a later request went out', () => {
    // A zoom issues a request per notch, and with a real network each one is
    // still 1-2 s away when the next goes out. Discarding an image because
    // something newer had been *asked for* meant a zoom threw away everything
    // it fetched and showed the bare base map the whole way in.
    const d = new DetailImagery()
    for (let i = 0; i < 30; i++) {
      d.update(45, 10, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    const first = FakeImage.last!
    // the camera moves on and a second request goes out while the first is
    // still in flight
    for (let i = 0; i < 30; i++) {
      d.update(45, 10 + 2 * PAN, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    expect(FakeImage.requests).toHaveLength(2)
    expect(FakeImage.last).not.toBe(first)

    first.onload!() // the older one lands last, and is still worth having
    expect(d.mix).toBe(1)
    // and it is drawn where it belongs — west of the current view, not over it
    const canvas = FakeCanvas.made[0]
    expect(canvas.ops).toHaveLength(1)
    expect(canvas.ops[0].image).toBe(first)
    expect(canvas.ops[0].x).toBeLessThan(0)
  })

  it('cuts a late patch to the view the camera is looking at now', () => {
    // The fast path — "what we hold still covers this view" — does not
    // recomposite, so the last *composited* rectangle can be several zoom steps
    // old. Cutting an arrival to that instead of to the live view drew a patch
    // smaller than the frame, and its feathered edge appeared to shrink while
    // the camera stood still.
    const d = new DetailImagery()
    for (let i = 0; i < 30; i++) {
      d.update(45, 10, 0.05, 900, 1)
      vi.advanceTimersByTime(16)
    }
    const inFlight = FakeImage.last!
    // zoom in a little — not far enough to refetch, so update() takes the fast
    // path and never recomposites
    d.update(45, 10, 0.045, 900, 1)
    const wanted = viewBbox(45, 10, 0.045, 1)
    inFlight.onload!()
    // …and the arrival waits for the camera, so the rectangle it lands on is
    // the live one rather than the one it was requested for
    vi.advanceTimersByTime(SETTLE_MS + 1)
    const [, , du] = d.rect
    expect(du * 360).toBeCloseTo(wanted.maxLng - wanted.minLng, 3)
  })

  it('still drops an image once streaming has been cancelled under it', () => {
    // zooming back out is not "something newer is coming", it is "nobody is
    // looking at this any more"
    const d = new DetailImagery()
    land(d, 45, 10)
    for (let i = 0; i < 30; i++) {
      d.update(45, 10 + 2 * PAN, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    const pending = FakeImage.last!
    d.update(45, 10, 2.5, 900, 1) // out to a world view: streaming stops
    const canvas = FakeCanvas.made[0]
    canvas.ops.length = 0
    pending.onload!()
    expect(canvas.ops).toHaveLength(0)
    expect(d.mix).toBe(0)
  })

  it('never shrinks the composite because the camera moved', () => {
    // The display rule: effective resolution must not go backward over ground
    // the camera is already looking at. A canvas that halves while the camera
    // moves and doubles when it stops breaks that everywhere at once, several
    // times a second, for as long as the wheel is turning.
    const SCREEN = 3000
    const d = new DetailImagery({ maxPx: 4096 })
    for (let i = 0; i < 30; i++) {
      d.update(45, 10, CLOSE, SCREEN, 1)
      vi.advanceTimersByTime(16)
    }
    FakeImage.last!.onload!()
    const canvas = FakeCanvas.made[0]
    const atRest = Math.max(canvas.width, canvas.height)
    expect(atRest).toBeGreaterThan(0)

    d.update(45, 10 + PAN, CLOSE, SCREEN, 1)
    expect(Math.max(canvas.width, canvas.height)).toBe(atRest)
    vi.advanceTimersByTime(SETTLE_MS + 32)
    expect(Math.max(canvas.width, canvas.height)).toBe(atRest)
  })

  it('never composites the canvas into itself', () => {
    // A canvas drawn into itself is undefined at best and a feedback loop at
    // worst, each generation nesting a copy of the last. Nothing puts the
    // composite into the cache today, so this is a guard against a future
    // change making it possible — checked by putting the destination in the
    // cache by hand and confirming it is not drawn.
    const d = new DetailImagery()
    land(d, 45, 10)
    const canvas = FakeCanvas.made[0]
    const cache = (d as unknown as { cache: { image: unknown }[] }).cache
    cache.unshift({ ...cache[0], image: canvas })
    canvas.ops.length = 0
    d.update(45, 10 + PAN, CLOSE, 900, 1)
    expect(canvas.ops.some((o) => o.image === canvas)).toBe(false)
  })

  it('changes the rectangle only in the same call that redraws the pixels', () => {
    // Content, rectangle and mip level describe one picture. If the rectangle
    // moves to a new view while the texture still holds the previous
    // composite's pixels, the shader stretches the old picture over the new
    // ground — which is the other half of the stretch-and-nest report.
    const d = new DetailImagery()
    land(d, 45, 10)
    const canvas = FakeCanvas.made[0]
    const seen: { rect: number[]; ops: number }[] = []
    for (const step of [0.4, 0.9, 1.5, 2.2]) {
      canvas.ops.length = 0
      d.update(45, 10 + PAN * step, CLOSE, 900, 1)
      seen.push({ rect: [...d.rect], ops: canvas.ops.length })
    }
    // every frame that moved the rectangle also redrew the canvas
    for (let i = 1; i < seen.length; i++) {
      const moved = seen[i].rect.some((v, k) => v !== seen[i - 1].rect[k])
      if (moved) expect(seen[i].ops).toBeGreaterThan(0)
    }
  })

  it('quotes the resolution of the imagery on screen, not of the last arrival', () => {
    // The scale panel reads this. An arrival that the composite dedupes away —
    // same patches, same size, same rectangle — never reaches the screen, and
    // quoting its resolution anyway is how a still picture came to be described
    // as getting coarser and then finer again.
    const d = new DetailImagery()
    land(d, 45, 10)
    const sharp = d.groundRes
    expect(sharp).toBeGreaterThan(0)
    // a second, coarser patch for the same view arrives and changes nothing
    for (let i = 0; i < 30; i++) {
      d.update(45, 10 + PAN, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    const before = d.groundRes
    d.update(45, 10 + PAN, CLOSE, 900, 1)
    expect(d.groundRes).toBe(before)
  })

  it('does not redraw the same composite twice', () => {
    // publishing re-uploads every pixel of the canvas, and update() runs on
    // every frame the view moves
    const d = new DetailImagery()
    land(d, 45, 10)
    const canvas = FakeCanvas.made[0]
    canvas.ops.length = 0
    canvas.cleared = 0
    for (let i = 0; i < 8; i++) d.update(45, 10 + PAN, CLOSE, 900, 1)
    // The redraw is deferred to rest now: a composite mid-gesture is a full
    // texture upload and mip rebuild the user feels as a stutter, and imagery
    // they cannot see because the next drag frame replaces it. Same picture,
    // one settle later.
    vi.advanceTimersByTime(SETTLE_MS + 1)
    expect(canvas.cleared).toBe(1)
    expect(canvas.ops).toHaveLength(1)
  })

  it('never hands the shader a rectangle its pixels were not drawn for', () => {
    // Content, rectangle and mip level are written by publish() together. If a
    // rectangle can be updated while the texture still holds the previous
    // composite, the shader stretches the old pixels across the new box — the
    // nesting reported from the field.
    const d = new DetailImagery()
    const drawnFor = () => {
      const c = FakeCanvas.made[0]
      return c && c.ops.length ? c : undefined
    }
    const check = () => {
      if (!d.texture || !drawnFor()) return
      // the rect the shader holds must be the uv rect of the bbox the canvas
      // was cut to, to the precision the composite key is keyed on
      expect(d.rect.map((n) => +n.toFixed(6))).toEqual(
        bboxToUvRect(lastTarget!).map((n) => +n.toFixed(6)),
      )
    }
    let lastTarget: Bbox | undefined
    for (const [lat, lng, alt] of [
      [45, 10, 0.06], [45, 10, 0.05], [45.02, 10.03, 0.04], [45.02, 10.03, 0.02],
    ] as const) {
      for (let i = 0; i < 30; i++) {
        lastTarget = viewBbox(lat, lng, alt, 1)
        d.update(lat, lng, alt, 900, 1)
        vi.advanceTimersByTime(16)
      }
      FakeImage.last!.onload!()
      check()
    }
    d.dispose()
  })

  it('does not reuse the texture object when the canvas has been resized', () => {
    // three allocates immutable storage on a texture's first upload and never
    // again, so re-flagging a texture whose canvas has changed shape uploads the
    // new image into the old allocation: silently into the top-left corner, with
    // the previous composite left in the rest.
    const d = new DetailImagery({ maxPx: 4096 })
    for (let i = 0; i < 30; i++) {
      d.update(45, 10, CLOSE, 3000, 1)
      vi.advanceTimersByTime(16)
    }
    FakeImage.last!.onload!()
    const canvas = FakeCanvas.made[0]
    const first = { tex: d.texture, w: canvas.width, h: canvas.height }
    // the window is resized, which is the one thing that still changes the
    // composite's shape now that a moving camera does not
    d.update(45, 10 + PAN, CLOSE, 1200, 1)
    // The redraw is deferred to rest now: a composite mid-gesture is a full
    // texture upload and mip rebuild the user feels as a stutter, and imagery
    // they cannot see because the next drag frame replaces it. Same picture,
    // one settle later.
    vi.advanceTimersByTime(SETTLE_MS + 1)
    expect(canvas.width).not.toBe(first.w)
    expect(d.texture).not.toBe(first.tex) // a fresh texture, so GL reallocates
    // ...and the texture object is kept where the shape has not changed, which
    // is what the snapped size ladder makes the common case
    const held = d.texture
    const shape = canvas.width
    d.update(45, 10 + PAN * 1.6, CLOSE, 1200, 1)
    expect(canvas.width).toBe(shape)
    expect(d.texture).toBe(held)
    d.dispose()
  })

  it('keeps one canvas shape for a whole zoom', () => {
    // A canvas that changes shape cannot be re-uploaded into its existing GL
    // storage, so every change is an allocation, a full upload and a mip chain
    // on the main thread. Measured before this: twelve reallocations across one
    // scripted sequence, and ten to twenty seconds of blocking time.
    const d = new DetailImagery()
    land(d, 45, 10)
    const canvas = FakeCanvas.made[0]
    const shapes = new Set<string>()
    for (let alt = CLOSE * 3; alt > CLOSE; alt *= 0.97) {
      for (let i = 0; i < 4; i++) {
        d.update(45, 10, alt, 900, 1)
        vi.advanceTimersByTime(16)
      }
      shapes.add(`${canvas.width}x${canvas.height}`)
    }
    // two, and only two: the in-motion size and the resting one. Before this it
    // was one per composite.
    expect(shapes.size).toBeLessThanOrEqual(2)
    d.dispose()
  })

  it('never draws the composite canvas into itself', () => {
    // a canvas drawn into itself nests a copy of the last generation each time
    const d = new DetailImagery()
    land(d, 45, 10)
    const canvas = FakeCanvas.made[0]
    canvas.ops.length = 0
    d.update(45, 10 + PAN, CLOSE, 900, 1)
    expect(canvas.ops.every((o) => o.image !== canvas)).toBe(true)
  })

  it('works without a canvas at all, as it must in a stale browser', () => {
    vi.stubGlobal('document', undefined)
    const d = new DetailImagery()
    land(d, 45, 10)
    expect(() => d.update(45, 10 + PAN, CLOSE, 900, 1)).not.toThrow()
    vi.advanceTimersByTime(SETTLE_MS + 32)
    expect(FakeImage.requests).toHaveLength(2) // the fetch path is untouched
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

  it('asks for a roughly square-sampled image there, not a letterbox', () => {
    const b = viewBbox(46, 8, MIN_ALTITUDE_DETAIL, 1200 / 900)
    const { width, height } = imageSize(b, 900, MAX_PATCH_PX, SHARP_SOURCE.pxPerDeg)
    const perPxX = (b.maxLng - b.minLng) / width
    const perPxY = (b.maxLat - b.minLat) / height
    expect(perPxY / perPxX).toBeCloseTo(1, 1)
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
    FakeImage.requests = []
    FakeImage.last = undefined
    FakeCanvas.made = []
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const settle = (d: DetailImagery, lat: number, lng: number, alt: number) => {
    for (let i = 0; i < 30; i++) {
      d.update(lat, lng, alt, 900, 1)
      vi.advanceTimersByTime(16)
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
      FakeImage.last!.onload!()
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
    FakeImage.last!.onload!()
    const canvas = FakeCanvas.made[0]

    const seen = new Map<string, string>()
    for (let i = 0; i < 12; i++) {
      d.update(45, 10 + i * 0.02, CLOSE, 900, 1)
      const rect = d.rect.map((n) => n.toFixed(6)).join(',')
      const pixels = canvas.ops.map((o) => `${o.x.toFixed(2)}:${o.y.toFixed(2)}:${o.w.toFixed(2)}`).join('|')
      // one rectangle can only ever go with one arrangement of pixels
      const held = seen.get(rect)
      if (held !== undefined) expect(pixels).toBe(held)
      seen.set(rect, pixels)
    }
    d.dispose()
  })

  it('never draws the composite canvas into itself', () => {
    // Source and destination being the same canvas is undefined at best and a
    // feedback loop at worst, each generation nesting a copy of the last.
    const d = new DetailImagery()
    settle(d, 45, 10, CLOSE)
    FakeImage.last!.onload!()
    const canvas = FakeCanvas.made[0]
    for (let i = 0; i < 8; i++) {
      d.update(45, 10 + i * 0.05, CLOSE, 900, 1)
      vi.advanceTimersByTime(40)
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
    const asked: { crop: { x: number; y: number; w: number; h: number }; dw: number; dh: number }[] = []
    const canvases: Record<string, unknown> = {}
    const d = new DetailImagery({
      resampler: {
        run: async (_image, crop, dw, dh) => {
          asked.push({ crop: { ...crop }, dw, dh })
          const c = { width: dw, height: dh, tag: `${Math.round(crop.x)},${Math.round(crop.y)},${Math.round(crop.w)},${Math.round(crop.h)}@${dw}x${dh}` }
          canvases[c.tag] = c
          return c as unknown as CanvasImageSource
        },
        dispose: () => {},
      },
    })
    settle(d, 45, 10, 0.09)
    Object.assign(FakeImage.last!, { naturalWidth: 800, naturalHeight: 600 })
    FakeImage.last!.onload!()
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 32)

    const canvas = FakeCanvas.made[0]
    // walk the camera in, so the wanted crop and destination drift continuously
    for (let i = 0; i < 14; i++) {
      d.update(45, 10, 0.09 - i * 0.004, 900, 1)
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

import { PATCH_KEEP } from '../src/lib/patchCache'

describe('cached imagery is released, not just dropped', () => {
  const CLOSE = 0.02

  beforeEach(() => {
    vi.useFakeTimers()
    FakeImage.requests = []
    FakeImage.last = undefined
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
    constructor(public width: number, public height: number, public tag: string) {
      FakeBitmap.made.push(this)
    }
    close() {
      this.closed = true
    }
  }

  it('closes exactly the bitmaps of the patches it evicted', async () => {
    FakeBitmap.made = []
    vi.stubGlobal('ImageBitmap', FakeBitmap)
    const made = new Map<unknown, FakeBitmap>()
    const d = new DetailImagery({
      resampler: {
        run: async (image) => {
          const b = new FakeBitmap(64, 64, String(made.size))
          made.set(image, b)
          return b as unknown as CanvasImageSource
        },
        dispose: () => {},
      },
    })

    // land more patches than the cache keeps, each with a sharpened copy
    const images: unknown[] = []
    for (let i = 0; i < PATCH_KEEP + 3; i++) {
      for (let f = 0; f < 30; f++) {
        d.update(45, 10 + i * 0.9, CLOSE, 900, 1)
        vi.advanceTimersByTime(16)
      }
      const img = FakeImage.last!
      Object.assign(img, { naturalWidth: 400, naturalHeight: 300 })
      images.push(img)
      img.onload!()
      await vi.advanceTimersByTimeAsync(SETTLE_MS + 32)
    }

    // whatever the cache no longer holds must have had its bitmap closed, and
    // whatever it still holds must not
    const held = new Set((d as unknown as { cache: { image: unknown }[] }).cache.map((p) => p.image))
    for (const [image, bitmap] of made) {
      expect(bitmap.closed).toBe(!held.has(image))
    }
    expect([...made.values()].some((b) => b.closed)).toBe(true) // eviction did happen
    d.dispose()
  })

  it('closes what it still holds when it is disposed', async () => {
    FakeBitmap.made = []
    vi.stubGlobal('ImageBitmap', FakeBitmap)
    const d = new DetailImagery({
      resampler: {
        run: async () => new FakeBitmap(64, 64, 'x') as unknown as CanvasImageSource,
        dispose: () => {},
      },
    })
    for (let f = 0; f < 30; f++) {
      d.update(45, 10, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    Object.assign(FakeImage.last!, { naturalWidth: 400, naturalHeight: 300 })
    FakeImage.last!.onload!()
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 32)
    expect(FakeBitmap.made.length).toBeGreaterThan(0)
    d.dispose()
    expect(FakeBitmap.made.every((b) => b.closed)).toBe(true)
  })
})

import { REST_MIN_COVER, FEATHER_FRACTION, viewBbox as viewBboxFor } from '../src/lib/detailImagery'
import { unionCoverage as unionCov } from '../src/lib/patchCache'

/**
 * The two properties a pan has to keep: the picture finishes, and it never gets
 * worse on the way. Both were reported broken from the field, and both are
 * about the gap between "the request is worth repeating" and "the imagery
 * reaches the edge of the screen", which are not the same question.
 */
describe('panning to rest', () => {
  const CLOSE = 0.02

  /** A canvas that records draws and can build the gradients feathering needs. */
  class PanCanvas {
    static made: PanCanvas[] = []
    width = 0
    height = 0
    ops: { image: unknown; x: number; y: number; w: number; h: number }[] = []
    gradients = 0
    composites: string[] = []
    constructor() {
      PanCanvas.made.push(this)
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
        set globalCompositeOperation(v: string) {
          this.composites?.push?.(v)
        },
        get globalCompositeOperation() {
          return 'source-over'
        },
        fillStyle: '',
      } as unknown as CanvasRenderingContext2D
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    FakeImage.requests = []
    FakeImage.last = undefined
    PanCanvas.made = []
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('document', { createElement: () => new PanCanvas() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /**
   * The rectangle a request went out for, read back off the WMS URL.
   *
   * Asserting on what the pipeline *asks for* rather than on what it has cached
   * keeps the test to the class's own surface — and it is the stronger
   * statement anyway: the invariant is that a view missing imagery causes a
   * request that covers it.
   */
  const requestedBbox = (url: string): Bbox => {
    const q = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    const n = q.get('bbox')!.split(',').map(Number)
    return q.get('version') === '1.3.0'
      ? { minLat: n[0], minLng: n[1], maxLat: n[2], maxLng: n[3] }
      : { minLng: n[0], minLat: n[1], maxLng: n[2], maxLat: n[3] }
  }

  /** Hold the camera at a view long enough for one settle, and land the patch. */
  const settleAt = (d: DetailImagery, lat: number, lng: number, ms = SETTLE_MS * 3) => {
    for (let i = 0; i < ms / 16; i++) {
      d.update(lat, lng, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    if (FakeImage.last?.onload) FakeImage.last.onload()
  }

  it('fills the edge a pan too small to refetch has exposed', () => {
    const d = new DetailImagery()
    settleAt(d, 45, 10)
    const first = FakeImage.requests.length
    expect(first).toBeGreaterThan(0)

    // A pan past the patch's own 1.25x margin but under the fifth-of-a-span
    // that `movedEnough` asks for. This is the case that used to leave a strip
    // of base map along the leading edge that no later frame would ever fill.
    const span = viewBboxFor(45, 10, CLOSE, 1)
    const width = span.maxLng - span.minLng
    const nudge = width * 0.16 // margin gives out at 0.125; refetch trips at 0.2
    expect(movedEnough(span, viewBboxFor(45, 10 + nudge, CLOSE, 1))).toBe(false)

    settleAt(d, 45, 10 + nudge)
    expect(FakeImage.requests.length).toBeGreaterThan(first) // a request was owed

    // ...for a rectangle that covers the view, and once it lands the published
    // rectangle is the view's own again
    const want = viewBboxFor(45, 10 + nudge, CLOSE, 1)
    const asked = requestedBbox(FakeImage.requests.at(-1)!)
    expect(unionCov([{ bbox: asked }], want)).toBeGreaterThanOrEqual(REST_MIN_COVER)
    expect(d.rect[0] * 360 - 180).toBeCloseTo(want.minLng, 6)
    d.dispose()
  })

  it('asks again after several small pans that each stay under the threshold', () => {
    const d = new DetailImagery()
    settleAt(d, 45, 10)
    const span = viewBboxFor(45, 10, CLOSE, 1)
    const step = (span.maxLng - span.minLng) * 0.15
    let lng = 10
    for (let i = 0; i < 3; i++) {
      lng += step
      const before = FakeImage.requests.length
      settleAt(d, 45, lng)
      expect(FakeImage.requests.length).toBeGreaterThan(before)
      const want = viewBboxFor(45, lng, CLOSE, 1)
      const asked = requestedBbox(FakeImage.requests.at(-1)!)
      expect(unionCov([{ bbox: asked }], want)).toBeGreaterThanOrEqual(REST_MIN_COVER)
    }
    d.dispose()
  })

  it('stops asking once the view is covered, however long it stands still', () => {
    // the other side of the same rule: a coverage test that never quite reaches
    // its threshold would spend a request every settle for as long as the app
    // is open
    const d = new DetailImagery()
    settleAt(d, 45, 10)
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
    settleAt(d, 45, 10)
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

  it('feathers a patch whose edge falls inside the composite', () => {
    // the join between two patches is a crossfade, not a butt joint: that is
    // what lets the plan keep a patch for a thin strip without bringing a
    // visible rectangular edge with it
    const d = new DetailImagery()
    settleAt(d, 45, 10)
    const span = viewBboxFor(45, 10, CLOSE, 1)
    const nudge = (span.maxLng - span.minLng) * 0.16
    PanCanvas.made.forEach((c) => (c.gradients = 0))
    settleAt(d, 45, 10 + nudge)
    expect(PanCanvas.made.some((c) => c.gradients > 0)).toBe(true)
    expect(FEATHER_FRACTION).toBeGreaterThan(0)
    d.dispose()
  })
})

describe('the cost of a frame that is only moving', () => {
  /**
   * A canvas that counts what is expensive about one: how many times its
   * backing store was reallocated, and how many contexts were asked for.
   *
   * Both are per-frame costs in the shipped app — `recomposite` runs whenever
   * the view moves and feathers every patch it draws — and both are invisible
   * to a test that only looks at the pixels.
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
        clearRect: () => {},
        drawImage: () => {},
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
    FakeImage.requests = []
    FakeImage.last = undefined
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
    for (let i = 0; i < 40; i++) {
      d.update(lat, lng, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    FakeImage.last?.onload?.()
    for (let i = 0; i < 40; i++) {
      d.update(lat, lng, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
  }

  it('does not reallocate the composite canvas once it has one', () => {
    // The composite canvas is deliberately one size for the session (see
    // compositeCanvasSize), so every recomposite after the first is drawing at
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
    // …and now a pan long enough to composite repeatedly at the same size
    for (let i = 1; i <= 6; i++) settle(d, 45, 10 + step * i)
    // the scratch canvas legitimately changes size with each patch's footprint;
    // the composite's own must not have been touched again
    expect(composite.mine.resizes, 'the composite canvas was resized again').toBe(after.resizes)
    expect(
      composite.mine.contexts,
      'a composite asks for a context it already holds',
    ).toBe(after.contexts)
    d.dispose()
  })

  it('does not scan the patch cache on a frame that has plainly moved', () => {
    // `unionCoverage(compositePlan(...))` is the most expensive thing per frame
    // in this file, and on a moving camera its answer cannot matter: the
    // cheaper `movedEnough` has already decided the held imagery is not being
    // re-shown. Counted through the cache the plan has to read.
    const d = new DetailImagery()
    settle(d, 45, 10)
    const span = viewBboxFor(45, 10, CLOSE, 1)
    const wide = (span.maxLng - span.minLng) * 3
    let reads = 0
    const inner = (d as unknown as { cache: unknown[] }).cache
    let held = inner
    Object.defineProperty(d, 'cache', {
      get: () => (reads++, held),
      set: (v) => (held = v),
      configurable: true,
    })
    // one long sweep, far enough that every frame is past `movedEnough`
    for (let i = 1; i <= 20; i++) {
      d.update(45, 10 + (wide * i) / 20, CLOSE, 900, 1)
      vi.advanceTimersByTime(16)
    }
    // a handful of reads for the settle path is fine; one per frame is the bug
    expect(reads, 'the cache is scanned once per moving frame').toBeLessThan(20)
    d.dispose()
  })
})
