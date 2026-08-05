import { describe, it, expect } from 'vitest'
import {
  viewBbox,
  visibleSpanDeg,
  minAltitudeFor,
  IMAGERY_ERA_FROM,
  MIN_ALTITUDE_DETAIL,
  MIN_ALTITUDE_PRE_ERA,
  PRE_ERA_VIEW_KM,
  PATCH_MARGIN,
  viewSpanDeg,
  DEFAULT_FOV,
  DETAIL_ON_TEXELS,
  DETAIL_OFF_TEXELS,
  TILE_INFLIGHT,
  Z_MAX,
  degPerScreenPx,
  baseTexelsPerScreenPx,
  detailWanted,
  planetFillsFrame,
  pickSource,
  type Bbox,
} from '../src/lib/detailImagery'
import { TILE_BYTES, TILE_PX, targetLevel, tileSpanDeg, tilesCovering } from '../src/lib/tilePyramid'
import { ATLAS_UPLOADS_PER_FRAME } from '../src/lib/tileAtlas'

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

  it('still beats the world texture handsomely at the range it serves', () => {
    // the point of streaming at mid zoom at all: a 500 m source is twenty times
    // the 4096-wide world map's density, so the coarse source is not a fallback
    // for failure, it is the answer for the whole mid range
    expect(BASE_SOURCE.pxPerDeg).toBeGreaterThan(BASE_TEXTURE_PX_PER_DEG * 5)
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

import { altitudeForViewKm, BASE_TEXTURE_PX_PER_DEG } from '../src/lib/detailImagery'

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
  altitudeForFrameKm,
  DetailImagery,
  MOTION_EPS,
  SETTLE_MS,
  viewBbox as viewBboxFor,
  viewMotion,
} from '../src/lib/detailImagery'

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

  it('spreads a burst of arrivals over frames, at the upload budget', () => {
    // Tiles land within milliseconds of each other. The old pipeline had to
    // collect them, because each one triggered a whole-canvas upload and a
    // generateMipmap — 48 of those across one scripted pan and zoom, for six
    // distinct pictures. A slot upload is cheap enough not to need collecting,
    // and cheap enough to be *rationed* instead: two a frame, so a burst is
    // never the reason a frame is late.
    const d = new DetailImagery()
    d.update(45, 10, CLOSE, 900, 1)
    FakeImage.landAll() // a view's worth of tiles, all at once
    expect(d.atlas.writes).toBe(0) // …none of them absorbed by arriving alone
    for (let i = 1; i <= 4; i++) {
      d.update(45, 10, CLOSE, 900, 1)
      expect(d.atlas.writes).toBe(i * ATLAS_UPLOADS_PER_FRAME)
      vi.advanceTimersByTime(16)
    }
    expect(d.animating).toBe(true) // …and the pump is told there is more to come
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
    expect(d.atlas.writes).toBe(0) // cached, but no slot and no index
    d.dispose()
  })

  it('publishes resolution only once the imagery it describes has arrived', () => {
    const d = new DetailImagery()
    frames(d, 30)
    expect(d.groundRes).toBe(0) // in flight: nothing on screen to describe yet
    FakeImage.landAll()
    frames(d, 40)
    expect(d.groundRes).toBeGreaterThan(0)
    expect(d.status).toBe('ready')
    d.dispose()
  })

  it('quotes the resolution of the level it actually drew', () => {
    const d = new DetailImagery()
    frames(d, 40)
    FakeImage.landAll()
    frames(d, 60)
    const z = targetLevel(baseTexelsPerScreenPx(CLOSE, 900), Z_MAX)
    expect(d.groundRes).toBeCloseTo((tileSpanDeg(z) * 111_320) / TILE_PX, 6)
    d.dispose()
  })

  it('keeps the loaded source name when the imagery is hidden and shown again', () => {
    const d = new DetailImagery()
    frames(d, 40)
    FakeImage.landAll()
    frames(d, 60)
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

  /** A cache small enough that the route below is guaranteed to evict. */
  const withBitmaps = () =>
    new DetailImagery({
      // A budget of a dozen tiles, so eviction is forced by the route below
      // whatever TILE_MEMORY_BUDGET ships as — the test is about *releasing*
      // evicted bitmaps, not about how big the production cache is.
      tileBudget: 12 * 512 * 512 * 4,
    })

  /** Tiles decode to bitmaps, which hold memory the collector does not account. */
  const decodesToBitmaps = () =>
    vi.stubGlobal('createImageBitmap', async () => new FakeBitmap(TILE_PX, TILE_PX))

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

  it('closes the decoded tiles it evicted', async () => {
    FakeBitmap.made = []
    vi.stubGlobal('ImageBitmap', FakeBitmap)
    decodesToBitmaps()
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
    decodesToBitmaps()
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

  const settleAt = (d: DetailImagery, lat: number, lng: number, rounds = 4) => {
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < 40; i++) {
        d.update(lat, lng, CLOSE, 900, 1)
        vi.advanceTimersByTime(16)
      }
      FakeImage.landAll()
      vi.advanceTimersByTime(SETTLE_MS + 32)
    }
  }

  /** Longitude span of the padded view; what a pan is measured in. */
  const spanOf = (lat: number, lng: number) => {
    const b = viewBboxFor(lat, lng, CLOSE, 1)
    return b.maxLng - b.minLng
  }

  it('covers every tile the view touches, on both levels, once it rests', () => {
    // The old failure this replaces: a pan past the composite's 1.25x margin but
    // well under a tile left a strip of base map along the leading edge that no
    // later frame would ever fill, because nothing had moved *enough*. The index
    // is rebuilt from the view every frame, so the question is only whether the
    // slots behind it are there.
    const d = new DetailImagery()
    settleAt(d, 45, 10)
    const nudge = spanOf(45, 10) * 0.16
    settleAt(d, 45, 10 + nudge)
    const index = d.index!
    const want = viewBboxFor(45, 10 + nudge, CLOSE, 1, PATCH_MARGIN)
    expect(index.resident).toBe(
      tilesCovering(want, index.z).length + tilesCovering(want, index.z - 1).length,
    )
    d.dispose()
  })

  it('re-points the index across a pan instead of re-uploading the view', () => {
    // What the atlas is for. A pan of half a span exposes about half a span of
    // new ground, so it costs about that many slots — where the composite path
    // re-uploaded every pixel of the frame and rebuilt the whole mip chain for
    // it, whatever fraction of the ground was actually new.
    const d = new DetailImagery()
    settleAt(d, 45, 10)
    const held = d.atlas.writes
    const step = spanOf(45, 10) * 0.5
    settleAt(d, 45, 10 + step)
    const grew = d.atlas.writes - held
    expect(grew).toBeGreaterThan(0) // the leading edge really was new ground
    expect(grew).toBeLessThan(held / 2) // …and the rest was already resident
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
 * still-camera pipeline ran on every frame of it: 399 publishes and 523
 * megapixels of upload across one 150-frame crawl, measured in Chromium
 * (tests/e2e/slowPan.e2e.mjs), against 1 publish for the same gesture at four
 * times the speed.
 *
 * The pipeline that made that expensive is gone — nothing is published any more,
 * and a tile costs one slot upload out of a two-a-frame budget. What is left of
 * the fix is the classification itself, and it still matters: the prefetch ring
 * may only be spent on a still camera, because during a gesture every byte
 * belongs to ground that is on screen now. So these assert the classification
 * directly rather than through what it used to cost.
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
   * own span. Returns how many of those frames the pipeline believed it was
   * looking at a parked camera, and how many slot uploads the drag cost.
   */
  const drag = (perFrame: number, frames: number, lng = 10) => {
    const d = new DetailImagery()
    settleAt(d, 45, lng)
    const b = viewBboxFor(45, lng, CLOSE, 1)
    const step = (b.maxLng - b.minLng) * perFrame
    const before = d.atlas.writes
    let stillFrames = 0
    for (let i = 1; i <= frames; i++) {
      d.update(45, lng + step * i, CLOSE, 900, 1)
      // Only the second half counts. A drag starts from rest, and a detector
      // that integrates displacement cannot know it has begun until the drag has
      // travelled one epsilon — 4 frames at a quarter-epsilon crawl. That
      // start-up is a constant, and the whole point is that it does not become a
      // rate: the old per-frame rule classified 113 of 150 crawl frames as still.
      if (d.still && i > frames / 2) stillFrames++
      FakeImage.landAll(1)
      vi.advanceTimersByTime(16)
    }
    const uploads = d.atlas.writes - before
    d.dispose()
    return { stillFrames, uploads, frames }
  }

  it('is a gesture at half the old per-frame speed limit', () => {
    // a hand holds this easily, and every frame of it used to be a full upload
    // and a mip chain rebuild
    expect(drag(MOTION_EPS / 2, 90).stillFrames).toBe(0)
  })

  it('is a gesture through a crawl, where the old rule was worst of all', () => {
    // a quarter of the epsilon per frame: the slower the drag, the longer the
    // machinery spent believing the camera had stopped
    expect(drag(MOTION_EPS / 4, 90).stillFrames).toBe(0)
  })

  it('costs a crawl no more per frame than the flick that was already smooth', () => {
    // The point of the atlas: cost is bounded by the upload budget rather than
    // by how the gesture happened to be classified, so this holds by
    // construction at every speed — which is what the old pipeline could not say.
    for (const speed of [MOTION_EPS / 4, MOTION_EPS / 2, MOTION_EPS * 10]) {
      const run = drag(speed, 90)
      expect(run.uploads).toBeLessThanOrEqual(run.frames * ATLAS_UPLOADS_PER_FRAME)
    }
  })

  it('keeps imagery on screen throughout a slow pan that never ends', () => {
    // The deferral this replaces could strand the screen on the base map; there
    // is nothing to defer now, so the only question is whether the index still
    // resolves. It does, because the fallback level moves with the view and the
    // ring — fetched at the last rest — is a tile ahead of the camera.
    const d = new DetailImagery()
    settleAt(d, 45, 10)
    const b = viewBboxFor(45, 10, CLOSE, 1)
    const step = (b.maxLng - b.minLng) * (MOTION_EPS / 2)
    let bare = 0
    for (let i = 1; i <= 600; i++) {
      d.update(45, 10 + step * i, CLOSE, 900, 1)
      FakeImage.landAll(1)
      vi.advanceTimersByTime(16)
      if (!d.index?.resident) bare++
    }
    expect(bare).toBe(0)
    expect(d.status).toBe('ready')
    d.dispose()
  })

  it('lets a decaying motion converge, so a released flick still settles', () => {
    // Displacement rather than speed still has to reach zero, or the ring waits
    // forever on a camera that is technically moving. Orbit damping decays
    // geometrically, so what is left to travel shrinks and the last crossing of
    // the epsilon does come.
    const d = new DetailImagery()
    settleAt(d, 45, 10)
    const b = viewBboxFor(45, 10, CLOSE, 1)
    let lng = 10
    let v = (b.maxLng - b.minLng) * 0.05
    for (let i = 0; i < 200; i++) {
      lng += v
      v *= 0.9
      d.update(45, lng, CLOSE, 900, 1)
      FakeImage.landAll(1)
      vi.advanceTimersByTime(16)
    }
    expect(d.still).toBe(true)
    expect(d.status).toBe('ready')
    d.dispose()
  })

  it('shows a parked camera its picture on the next frame, not a settle later', () => {
    // What the atlas buys outright. The composite path waited SETTLE_MS after
    // the tiles landed, because publishing was expensive enough to be worth
    // batching; a slot upload is not, so the picture appears on the frame after
    // the first two tiles are in.
    const d = new DetailImagery()
    d.update(45, 10, CLOSE, 900, 1)
    expect(d.status).toBe('loading')
    FakeImage.landAll()
    d.update(45, 10, CLOSE, 900, 1)
    expect(d.status).toBe('ready')
    expect(d.mix).toBe(1)
    d.dispose()
  })

  it('has a floor, and it is a drift of one epsilon per settle', () => {
    // The honest edge of any epsilon: below 0.002 of a span per SETTLE_MS —
    // 0.07 mouse px per frame, ~4 px/s — a drift is indistinguishable from a
    // parked camera and is treated as one. All that now costs is a prefetch
    // ring spent during a movement nobody can see.
    const perFrame = (MOTION_EPS / SETTLE_MS) * 16 * 0.5
    expect(drag(perFrame, 90).stillFrames).toBeGreaterThan(0)
  })
})
