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
import {
  BASE_LEVEL,
  TILE_BYTES,
  TILE_PX,
  targetLevel,
  tileCols,
  tileSpanDeg,
  tilesCovering,
} from '../src/lib/tilePyramid'
import { ATLAS_UPLOADS_PER_FRAME, fitLevel } from '../src/lib/tileAtlas'

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

  it('clamps latitude at the poles and never inverts', () => {
    for (const [lat, lng] of [[89.9, 179.9], [-89.9, -179.9], [90, 180], [-90, -180]] as const) {
      const b = viewBbox(lat, lng, 0.3)
      expect(b.minLat).toBeGreaterThanOrEqual(-90)
      expect(b.maxLat).toBeLessThanOrEqual(90)
      expect(b.maxLat).toBeGreaterThan(b.minLat)
      expect(b.maxLng).toBeGreaterThan(b.minLng)
    }
  })

  /**
   * ROUND 51, DEFECT 2 — the antimeridian seam.
   *
   * The clamp that used to be on these two lines is what the reader saw as "a
   * hard boundary somewhere in the ocean" near Kamchatka/Alaska with one side
   * sharp and the other not: a view centred on the seam asked for the half of
   * itself on the near side and stopped at 180, so the far half was never
   * requested at any level and stayed base map.
   */
  it('crosses the antimeridian instead of stopping at it', () => {
    const at180 = viewBbox(56, 180, 0.09, 1.6)
    expect(at180.maxLng).toBeGreaterThan(180)
    expect(at180.minLng).toBeLessThan(180)
    // the box is the same WIDTH wherever it is centred: the seam is not a wall
    const at0 = viewBbox(56, 0, 0.09, 1.6)
    expect(at180.maxLng - at180.minLng).toBeCloseTo(at0.maxLng - at0.minLng, 9)
    expect((at180.minLng + at180.maxLng) / 2).toBeCloseTo(180, 9)
    // …and just past it, where the centre comes back wrapped to -180
    const past = viewBbox(56, -179.5, 0.09, 1.6)
    expect(past.minLng).toBeLessThan(-180)
    expect(past.maxLng - past.minLng).toBeCloseTo(at0.maxLng - at0.minLng, 9)
  })

  it('asks for tiles on BOTH sides of the seam', () => {
    // the whole point of not clamping: `tilesCovering` has wrapped its columns
    // since phase 1 and until this round nothing ever handed it a box that made
    // it do so
    const tiles = tilesCovering(viewBbox(56, 180, 0.09, 1.6), 7)
    const cols = new Set(tiles.map((t) => t.x))
    expect([...cols].some((x) => x >= tileCols(7) - 2)).toBe(true)
    expect([...cols].some((x) => x <= 1)).toBe(true)
    // and no column is ever out of range
    for (const t of tiles) expect(t.x).toBeGreaterThanOrEqual(0)
    for (const t of tiles) expect(t.x).toBeLessThan(tileCols(7))
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
  HOLD_MAGNIFY,
  HOLD_MINIFY,
  LOCAL_RENDER_AHEAD,
  MOTION_EPS,
  SETTLE_MS,
  heldLevel,
  levelWanted,
  sameBbox,
  viewBbox as viewBboxFor,
  viewMotion,
  wrapDeg,
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

  /**
   * ROUND 51, DEFECT 2 — the seam must not read as a jump.
   *
   * The camera's longitude comes back from globe.gl already wrapped, so a drag
   * across ±180 steps from 179.9 to -179.9: half a degree of ground that reads
   * as 359.8 degrees unless the difference is taken the short way round. Read
   * long, every crossing resets `restingAt`, the camera is classified as moving
   * and the prefetch ring is withheld from a pan that never stopped.
   */
  it('takes a pan across the antimeridian for what it is: half a degree', () => {
    const west = { minLat: 54, maxLat: 58, minLng: 177.9, maxLng: 181.9 }
    const east = { minLat: 54, maxLat: 58, minLng: -181.7, maxLng: -177.7 } // 0.4 further on
    expect(viewMotion(west, east)).toBeCloseTo(0.1, 6)
    expect(viewMotion(west, east)).toBeLessThan(viewMotion(box(45, 10), box(45, 11)))
    // and it is symmetric — coming back is the same half degree
    expect(viewMotion(east, west)).toBeCloseTo(viewMotion(west, east), 9)
  })

  it('is continuous across the seam: no step where the wrap happens', () => {
    // walk a camera through 180 in tenths of a degree and watch the motion each
    // step costs. Before the wrap the crossing step alone measured 89.95.
    let prev: Bbox | undefined
    const steps: number[] = []
    for (let lng = 179.0; lng <= 181.01; lng += 0.1) {
      const at = viewBboxFor(56, wrapDeg(lng), 0.02, 1.6)
      if (prev) steps.push(viewMotion(prev, at))
      prev = at
    }
    expect(Math.max(...steps)).toBeLessThan(Math.min(...steps) * 1.5 + 1e-6)
  })

  it('wrapDeg takes the short way round and nothing else', () => {
    expect(wrapDeg(0)).toBe(0)
    expect(wrapDeg(10)).toBe(10)
    expect(wrapDeg(-10)).toBe(-10)
    expect(wrapDeg(359.8)).toBeCloseTo(-0.2, 9)
    expect(wrapDeg(-359.8)).toBeCloseTo(0.2, 9)
    expect(Math.abs(wrapDeg(180))).toBe(180)
    for (const d of [-540, -181, 0, 179, 181, 720]) {
      expect(Math.abs(wrapDeg(d))).toBeLessThanOrEqual(180)
      expect(Math.abs(Math.round((d - wrapDeg(d)) / 360) * 360 - (d - wrapDeg(d)))).toBeLessThan(
        1e-9,
      )
    }
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

/**
 * THE LEVEL A GESTURE STREAMS — round 54.
 *
 * The field report was "zooming in the drawn map is incredibly choppy". The
 * instrument (tests/e2e/drawnPerf.e2e.mjs) attributed it: a scripted world→z9
 * zoom crossed six pyramid levels, and every level is a different set of tiles,
 * so the atlas was thrown away and refilled six times at two slots a frame.
 * 177 tiles rendered, 110 uploaded, 112 MB — and 132 of the 244 tiles the cache
 * took in never reached a slot at all, because the level they belonged to was
 * gone before the upload budget reached them.
 *
 * These are the rules that stop it, tested as arithmetic and then as behaviour.
 */
describe('the level a gesture streams', () => {
  it('measures the wanted level continuously, so a boundary is not an event', () => {
    // targetLevel is the ceiling of this, and a ceiling is the right thing to
    // *choose* a level with and the wrong thing to *compare two moments* with.
    expect(levelWanted(1)).toBe(BASE_LEVEL)
    expect(levelWanted(0.5)).toBe(BASE_LEVEL + 1)
    expect(levelWanted(0.25)).toBe(BASE_LEVEL + 2)
    // …and it is exactly what targetLevel rounds
    for (const t of [0.9, 0.4, 0.13, 0.02, 0.004]) {
      expect(targetLevel(t, 12)).toBe(Math.min(12, Math.ceil(levelWanted(t))))
    }
  })

  it('gives a still camera the level it wants, always', () => {
    // the whole of "no behaviour change at rest": the lag is a property of the
    // gesture and of nothing else, so a settled view is the view it always was
    for (const held of [undefined, 4, 6, 9, 12]) {
      expect(heldLevel(held, 8.2, 9, true)).toBe(9)
    }
  })

  it('keeps a resident level through a zoom rather than chasing the density', () => {
    // 1.5 octaves of magnification: the shader was already magnifying the level
    // it holds, its tiles are resident, and its grid only shrinks as the camera
    // comes in. Inside the band a zoom costs no render and no upload at all.
    expect(heldLevel(6, 6.0, 6, false)).toBe(6)
    expect(heldLevel(6, 7.4, 8, false)).toBe(6)
    expect(heldLevel(6, 7.5, 8, false)).toBe(6)
    expect(heldLevel(6, 7.6, 8, false)).toBe(8)
    expect(HOLD_MAGNIFY).toBe(1.5)
  })

  it('gives the level up sooner on the way out, because the atlas makes it', () => {
    // Holding a FINER level while the frame grows means four times the ground
    // per octave at that level, and fitLevel refuses it as soon as the grid and
    // its parent stop fitting 64 slots. Past one octave that refusal is
    // certain, so the rule states the limit rather than discovering it.
    expect(heldLevel(9, 8.2, 9, false)).toBe(9)
    expect(heldLevel(9, 8.0, 8, false)).toBe(9)
    expect(heldLevel(9, 7.9, 8, false)).toBe(8)
    expect(HOLD_MINIFY).toBeLessThan(HOLD_MAGNIFY)
  })

  it('has nothing to hold before anything is resident', () => {
    expect(heldLevel(undefined, 7.2, 8, false)).toBe(8)
  })

  it('knows two views are the same view without a tolerance to tune', () => {
    const a = viewBboxFor(45, 10, 0.02, 1.6)
    expect(sameBbox(a, viewBboxFor(45, 10, 0.02, 1.6))).toBe(true)
    expect(sameBbox(a, viewBboxFor(45, 10.000001, 0.02, 1.6))).toBe(false)
  })
})

describe('what a scripted zoom costs the pipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeImage.reset()
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /**
   * The same camera path the browser instrument drives, on the fake clock:
   * ninety frames from a world view down to the sharp source's ceiling, one
   * `update` per frame, everything on the wire landing as it would.
   */
  const zoom = (from: number, to: number, frames = 90) => {
    const d = new DetailImagery()
    const levels = new Set<number>()
    for (let i = 0; i < frames; i++) {
      d.update(45, 10, from * (to / from) ** (i / (frames - 1)), 900, 1.4)
      if (d.index) levels.add(d.index.z)
      FakeImage.landAll(4)
      vi.advanceTimersByTime(16)
    }
    return { d, levels, requests: FakeImage.requests.length }
  }

  /** The level the OLD rule streamed on each frame of the same path. */
  const chased = (from: number, to: number, frames = 90) => {
    const seen = new Set<number>()
    for (let i = 0; i < frames; i++) {
      const alt = from * (to / from) ** (i / (frames - 1))
      const view = viewBboxFor(45, 10, alt, 1.4)
      seen.add(fitLevel(view, targetLevel(baseTexelsPerScreenPx(alt, 900), Z_MAX)))
    }
    return seen
  }

  it('does not rebuild the atlas once per level the camera passes through', () => {
    // Every level of the pyramid is a DIFFERENT SET OF TILES, so a level the
    // camera enters and leaves inside a gesture is an atlas thrown away and
    // refilled at two slots a frame for a picture that is gone before it is
    // finished. This is the count of those, before and after, on one path.
    const { d, levels } = zoom(1.2, 0.004)
    const before = chased(1.2, 0.004)
    expect(before.size).toBeGreaterThanOrEqual(8)
    expect(levels.size).toBeLessThan(before.size)
    // …and the shape of the rule: a snap every HOLD_MAGNIFY octaves at worst,
    // so the count is about half, not a few per cent
    expect(levels.size).toBeLessThanOrEqual(Math.ceil(before.size / HOLD_MAGNIFY))
    d.dispose()
  })

  it('asks for tiles for the levels it streams and for no others', () => {
    // Not a proxy: every request is a tile that has to be drawn or fetched,
    // decoded, cached, and uploaded into a slot the camera may already have
    // left. This is the count the browser instrument reports as `workerReqs`,
    // where the same path in drawn mode went from 177 renders to the number in
    // the round's table.
    const { d, requests, levels } = zoom(1.2, 0.004)
    const asked = new Set(FakeImage.requests.map(levelOf))
    // a level is streamed with its parent under it, and nothing else is asked
    // for at all — no level is paid for that never reached the index
    for (const l of asked) expect([...levels].some((z) => z === l || z - 1 === l)).toBe(true)
    expect(requests).toBeLessThan(chased(1.2, 0.004).size * 40)
    d.dispose()
  })

  it('sharpens to the level the camera stopped at, once it has stopped', () => {
    // The requirement the lag is bounded by. Nothing else would tell the
    // pipeline the gesture ended — `update` runs on frames the camera moves,
    // and this is the first moment it has not — so the settle timer re-derives
    // the whole frame from the camera it stopped at.
    const { d } = zoom(1.2, 0.004)
    const alt = 0.004
    const wanted = fitLevel(viewBboxFor(45, 10, alt, 1.4), targetLevel(baseTexelsPerScreenPx(alt, 900), Z_MAX))
    // the gesture may well have ended magnifying a coarser level…
    vi.advanceTimersByTime(SETTLE_MS * 3)
    FakeImage.landAll()
    vi.advanceTimersByTime(SETTLE_MS * 3)
    // …and a settled camera is on the level it asked for, as it always was
    expect(d.still).toBe(true)
    expect(d.index?.z).toBe(wanted)
    d.dispose()
  })

  it('forgets the level it held when the view it was resident in goes away', () => {
    // A held level is a claim that a level is RESIDENT and worth magnifying.
    // Leaving the streaming range or switching source makes that claim false.
    const { d } = zoom(1.2, 0.004)
    d.update(45, 10, 2.5, 900, 1.4) // out of streaming range: nothing is resident
    FakeImage.reset()
    d.update(45, 10, 0.004, 900, 1.4)
    const wanted = fitLevel(viewBboxFor(45, 10, 0.004, 1.4), targetLevel(baseTexelsPerScreenPx(0.004, 900), Z_MAX))
    expect(FakeImage.requests.map(levelOf).every((l) => l === wanted - 1)).toBe(true)
    d.dispose()
  })
})

/**
 * WORKER PARITY WITH THE NETWORK — the second half of round 54.
 *
 * `TILE_INFLIGHT` is six because six is what a browser keeps on the wire, and
 * that is the right number for a cost that is LATENCY: a request already made
 * costs nothing more to leave outstanding. A local rasterizer inverts it. Its
 * cost is CPU, it is not paid until the tile is drawn, and it is about a
 * millisecond — so six in flight drains in six milliseconds and refills from a
 * plan that goes stale long before the atlas, which takes two slots a frame,
 * has absorbed a quarter of it. Measured in the browser on the scripted zoom
 * out: 68 of the 104 tiles drawn, decoded and cached never reached a slot.
 */
describe('a local source renders no further ahead than the atlas can take', () => {
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }
  const localPlan = (drawn: string[], remote = false) => ({
    zMax: 9,
    remote,
    paint: true,
    at: () => ({
      label: 'local',
      pxPerDeg: 1e4,
      render: (t: { z: number; x: number; y: number }) => {
        drawn.push(`${t.z}/${t.x}/${t.y}`)
        return Promise.resolve({ width: TILE_PX, height: TILE_PX } as unknown as CanvasImageSource)
      },
    }),
  })

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /**
   * One scripted stretch of frames, in its own clock.
   *
   * The timers are cleared around it deliberately: a `DetailImagery` left alive
   * keeps a settle armed, and one instance's settle firing inside another
   * instance's frames is the kind of cross-talk that makes a comparison say the
   * opposite of what it measures.
   */
  const run = async (drawn: string[], remote: boolean, frames = 12) => {
    vi.clearAllTimers()
    const d = new DetailImagery({ plan: localPlan(drawn, remote) })
    for (let i = 0; i < frames; i++) {
      // A dense, wide frame on purpose: the rule is about a plan LARGER than
      // the atlas can absorb in the frames available, which is exactly the
      // condition a gesture is in and a small test view is not.
      d.update(45, 10, 0.05, 1800, 2.5)
      await flush()
      vi.advanceTimersByTime(16)
    }
    return d
  }

  it('keeps the drawn-but-unslotted queue inside one frame of headroom', async () => {
    const drawn: string[] = []
    const d = await run(drawn, false)
    expect(drawn.length).toBeGreaterThan(0)
    expect(d.atlas.writes).toBeGreaterThan(0)
    // Everything drawn is either in a slot or within the headroom the rule
    // allows. Without the rule this difference is the whole rest of the plan.
    expect(drawn.length - d.atlas.writes).toBeLessThanOrEqual(LOCAL_RENDER_AHEAD + TILE_INFLIGHT)
    expect(LOCAL_RENDER_AHEAD).toBe(ATLAS_UPLOADS_PER_FRAME * 2)
    d.dispose()
  })

  it('does not throttle a source whose cost is a round trip, only one whose cost is CPU', async () => {
    // The same path, the same arrival schedule, the plan marked remote: a
    // request already on the wire is sunk cost and starting early is free.
    const local: string[] = []
    const remote: string[] = []
    const a = await run(local, false)
    a.dispose()
    const b = await run(remote, true)
    b.dispose()
    expect(remote.length).toBeGreaterThan(local.length)
  })

  it('still finishes the view: the gate is a rate, not a ceiling', async () => {
    const drawn: string[] = []
    const d = await run(drawn, false, 60)
    expect(d.status).toBe('ready')
    expect(d.index?.resident ?? 0).toBeGreaterThan(0)
    // and nothing is left waiting once the atlas has caught up
    expect(d.animating).toBe(false)
    d.dispose()
  })

  it('is finished when it says it is finished, with no tile left unasked', async () => {
    // The failure this is here for: `pump` used to run BEFORE `absorb`, so it
    // decided how far ahead the renderer might run from the previous frame's
    // backlog. On the frame that absorbed the last decoded tiles it therefore
    // did nothing, `absorb` then emptied the backlog and with it `animating`,
    // and a view that still had tiles it had never asked for stopped asking.
    // Photographed in the browser as a settled camera holding 16 of its 21
    // tiles until the settle timer noticed 280 ms later. `animating === false`
    // has to mean the picture is complete, or nothing downstream can trust it.
    // Checked on EVERY frame rather than at the end, and that is the point:
    // the settle timer rescues the end — 280 ms later it pumps again and the
    // view completes — so an end-state assertion cannot see a gap. What has to
    // hold is the CLAIM: `animating === false` with nothing in flight means the
    // picture is complete, and every reader of it (the render pump, which parks
    // on it, and this round's instrument, which waits on it) depends on that.
    // Bounding the local queue is the change that could have broken it.
    //
    // The renderer answers on the NEXT frame here rather than in the same
    // microtask, which is the only thing about this harness that has to be
    // true of the real one: a worker reply crosses a message port, so the
    // frame that asks is never the frame that receives, and the pipeline's
    // bookkeeping has to be correct on the frame in between.
    const drawn: string[] = []
    const waiting: (() => void)[] = []
    vi.clearAllTimers()
    const d = new DetailImagery({
      plan: {
        zMax: 9,
        remote: false,
        paint: true,
        at: () => ({
          label: 'local',
          pxPerDeg: 1e4,
          render: (t: { z: number; x: number; y: number }) => {
            drawn.push(`${t.z}/${t.x}/${t.y}`)
            return new Promise<CanvasImageSource>((res) =>
              waiting.push(() => res({ width: TILE_PX, height: TILE_PX } as unknown as CanvasImageSource)),
            )
          },
        }),
      },
    })
    const inner = d as unknown as {
      want?: { plan: { level: unknown[]; fallback: unknown[] } }
      inflight: Set<string>
    }
    const holes: number[] = []
    for (let i = 0; i < 60; i++) {
      for (const r of waiting.splice(0)) r()
      await flush()
      d.update(45, 10, 0.05, 1800, 2.5)
      await flush()
      const wanted = inner.want ? inner.want.plan.level.length + inner.want.plan.fallback.length : 0
      if (!d.animating && inner.inflight.size === 0 && (d.index?.resident ?? 0) < wanted) holes.push(i)
      vi.advanceTimersByTime(16)
    }
    // the first frame is legitimately empty: nothing has been asked for yet
    expect(holes.filter((i) => i > 0)).toEqual([])
    expect(d.index?.resident).toBe(
      inner.want!.plan.level.length + inner.want!.plan.fallback.length,
    )
    d.dispose()
  })
})

/**
 * ROUND 62 — the mode switch publishes, it does not merely forget.
 *
 * `setPlan` drops the index and the wanted set, which makes `DetailImagery`
 * correct about itself. It said nothing to the SURFACE, which holds the atlas,
 * the two grids and the index texture it was last handed — and the slots behind
 * them still hold the other source's tiles, because the decoded cache and the
 * atlas are deliberately shared across the switch. The other half of the mode
 * (`uDetailPaint`) flips in the same tick, so any gap between the two is a
 * frame of map mode PAINTING satellite tiles as if they were the ground, or of
 * imagery mode dividing a drawing by a reduced tap map mode never uploads.
 *
 * Today GlobeView's settings watcher re-syncs inside the same flush and the gap
 * is empty. That is an ordering between two `watchEffect`s and nothing states
 * it; this does.
 */
describe('changing the plan tells the surface', () => {
  const localPlan = (label: string) => ({
    zMax: 9,
    remote: false,
    paint: true,
    at: () => ({ label, pxPerDeg: 1, render: async () => ({}) as CanvasImageSource }),
  })

  it('fires onReady, with nothing left to show, the moment the source changes', () => {
    const d = new DetailImagery()
    const seen: { index: unknown; mix: number; status: string }[] = []
    d.onReady = () => seen.push({ index: d.index, mix: d.mix, status: d.status })
    d.setPlan(localPlan('drawn'))
    expect(seen).toHaveLength(1)
    // what the surface would be handed: no index, no mix — i.e. the base map,
    // which is the only thing that is true about the new mode until a tile of
    // it lands
    expect(seen[0].index).toBeUndefined()
    expect(seen[0].mix).toBe(0)
    expect(seen[0].status).toBe('idle')
    d.dispose()
  })

  it('says nothing when the plan is the one it already had', () => {
    // The watcher runs on every settings change, not only on a mode change.
    const plan = localPlan('drawn')
    const d = new DetailImagery({ plan })
    let calls = 0
    d.onReady = () => calls++
    d.setPlan(plan)
    expect(calls).toBe(0)
    d.dispose()
  })
})

/**
 * THE LADDER — round 66.
 *
 * The index the shader resolves through holds exactly two levels, so a level
 * change exchanges both grids at once. When the streamed level snapped across
 * octaves — `heldLevel` releasing a gesture's hold, or the settle sharpening a
 * stopped camera — neither of the two new levels had a tile in a slot, and the
 * whole streamed picture fell through to the level-3 base texture for the 8–13
 * frames the upload budget needed to refill it. In paint mode (the drawn map)
 * that base texture is a 4096-wide drawing magnified up to ~90x, so the flash
 * is the reader's "stagger"; measured in tests/e2e/stagger66.e2e.mjs as a
 * bare-grid fraction of 1.0 on every level change of a scripted zoom.
 *
 * The rule: a LOCAL plan's level moves one rung at a time, ascending only when
 * the level on screen is whole (it becomes the next plan's fallback), and
 * descending only when the current fallback is whole (it becomes the next
 * plan's target) unless the atlas no longer fits the held grid at all.
 */
describe('the ladder a local plan climbs between levels', () => {
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }
  const localPlan = (drawn: string[]) => ({
    zMax: 9,
    remote: false,
    paint: true,
    at: () => ({
      label: 'local',
      pxPerDeg: 1e4,
      render: (t: { z: number; x: number; y: number }) => {
        drawn.push(`${t.z}/${t.x}/${t.y}`)
        return Promise.resolve({ width: TILE_PX, height: TILE_PX } as unknown as CanvasImageSource)
      },
    }),
  })

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  interface Inner {
    want?: { plan: { z: number; level: { z: number; x: number; y: number }[]; fallback: { z: number; x: number; y: number }[] } }
    atlas: { slots: { has(k: string): boolean } }
  }

  /** Settle a fresh instance at one altitude, then jump it to another. */
  const settleAt = async (d: DetailImagery, alt: number, frames = 60) => {
    for (let i = 0; i < frames; i++) {
      d.update(45, 10, alt, 900, 1.4)
      await flush()
      vi.advanceTimersByTime(16)
    }
  }

  it('climbs one rung at a time, and only over a whole picture', async () => {
    vi.clearAllTimers()
    const drawn: string[] = []
    const d = new DetailImagery({ plan: localPlan(drawn) })
    const inner = d as unknown as Inner
    await settleAt(d, 0.3) // a coarse level, fully resident
    const from = d.index!.z
    expect(d.still).toBe(true)

    // The jump a settle used to snap across: several octaves in one frame.
    const zs: number[] = []
    const bare: number[] = []
    for (let i = 0; i < 120; i++) {
      d.update(45, 10, 0.004, 900, 1.4)
      await flush()
      const w = inner.want!
      zs.push(w.plan.z)
      // The invariant the round is about: once a picture has been shown, no
      // tile of the target grid may resolve to NOTHING — its own slot or its
      // parent's must be there. Every violation is a rectangle of base map.
      let holes = 0
      for (const t of w.plan.level) {
        const own = inner.atlas.slots.has(`${t.z}/${t.x}/${t.y}/local`)
        const parent = inner.atlas.slots.has(`${t.z - 1}/${t.x >> 1}/${t.y >> 1}/local`)
        if (!own && !parent) holes++
      }
      bare.push(holes)
      vi.advanceTimersByTime(16)
    }
    // one rung at a time, never a snap
    for (let i = 1; i < zs.length; i++) expect(zs[i] - zs[i - 1]).toBeLessThanOrEqual(1)
    // no frame of the climb ever showed bare base texture
    expect(bare.every((b) => b === 0)).toBe(true)
    // and the top of the ladder is exactly where the old rule snapped to
    const view = viewBboxFor(45, 10, 0.004, 1.4)
    const wanted = fitLevel(view, targetLevel(baseTexelsPerScreenPx(0.004, 900), 9))
    expect(zs[zs.length - 1]).toBe(wanted)
    expect(zs[zs.length - 1]).toBeGreaterThan(from)
    expect(d.lagging).toBe(false)
    d.dispose()
  })

  it('still sharpens fully after the settle, exactly as before', async () => {
    vi.clearAllTimers()
    const drawn: string[] = []
    const d = new DetailImagery({ plan: localPlan(drawn) })
    await settleAt(d, 0.3)
    await settleAt(d, 0.004, 150)
    const view = viewBboxFor(45, 10, 0.004, 1.4)
    const wanted = fitLevel(view, targetLevel(baseTexelsPerScreenPx(0.004, 900), 9))
    expect(d.index?.z).toBe(wanted)
    expect(d.index?.resident).toBeGreaterThan(0)
    expect(d.animating).toBe(false)
    expect(d.lagging).toBe(false)
    d.dispose()
  })

  it('climbs back down the same way, one rung per whole fallback', async () => {
    vi.clearAllTimers()
    const drawn: string[] = []
    const d = new DetailImagery({ plan: localPlan(drawn) })
    const inner = d as unknown as Inner
    await settleAt(d, 0.03, 100) // settle somewhere sharp
    const from = d.index!.z
    const zs: number[] = []
    for (let i = 0; i < 120; i++) {
      d.update(45, 10, 0.1, 900, 1.4) // one-ish octave out: the held grid still fits
      await flush()
      zs.push(inner.want!.plan.z)
      vi.advanceTimersByTime(16)
    }
    // never more than one rung per frame on the way down either, unless the
    // atlas refused the held grid — which at this modest step it does not
    for (let i = 1; i < zs.length; i++) expect(zs[i - 1] - zs[i]).toBeLessThanOrEqual(1)
    const view = viewBboxFor(45, 10, 0.1, 1.4)
    const wanted = fitLevel(view, targetLevel(baseTexelsPerScreenPx(0.1, 900), 9))
    expect(zs[zs.length - 1]).toBe(wanted)
    expect(from).toBeGreaterThan(wanted)
    d.dispose()
  })

  it('does not gate a remote plan, whose tiles can hang rather than fail', async () => {
    // The imagery plan keeps its round-54 behaviour bit for bit: a snap to the
    // wanted level at the settle, however many octaves that is. A remote tile
    // that never answers is merely slow, and a residency gate would let it
    // hold the sharpening of every other tile hostage.
    vi.clearAllTimers()
    FakeImage.reset()
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() })
    const d = new DetailImagery()
    const inner = d as unknown as Inner
    for (let i = 0; i < 40; i++) {
      d.update(45, 10, 0.3, 900, 1.4)
      FakeImage.landAll(6)
      vi.advanceTimersByTime(16)
    }
    const from = inner.want!.plan.z
    d.update(45, 10, 0.004, 900, 1.4)
    // the first frame of the jump already streams the wanted level — no rungs
    const view = viewBboxFor(45, 10, 0.004, 1.4)
    expect(inner.want!.plan.z).toBe(fitLevel(view, targetLevel(baseTexelsPerScreenPx(0.004, 900), Z_MAX)))
    expect(inner.want!.plan.z - from).toBeGreaterThan(1)
    vi.unstubAllGlobals()
    d.dispose()
  })
})

/**
 * THE LABEL HANDOFF — round 66's other half.
 *
 * A source that renames itself over a live view (the drawn map's data rungs,
 * 110m → 50m → 10m) re-keys every cached tile at once, which used to
 * un-resolve the whole index in one frame: measured in the browser as the
 * entire picture falling to the base texture mid-gesture (bare fraction 1.0,
 * tests/e2e/stagger66.e2e.mjs) and refilling at two slots a frame. The slots
 * behind the old keys still hold the same ground, so the index now resolves
 * through them until the new keys land, and the swap is per-tile replacement.
 */
describe('a source rename hands the picture over, never drops it', () => {
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }
  const renameable = (drawn: string[]) => {
    const source = {
      label: 'v1',
      pxPerDeg: 1e4,
      render: (t: { z: number; x: number; y: number }) => {
        drawn.push(`${t.z}/${t.x}/${t.y}`)
        return Promise.resolve({ width: TILE_PX, height: TILE_PX } as unknown as CanvasImageSource)
      },
    }
    return { source, plan: { zMax: 9, remote: false, paint: true, at: () => source } }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps every tile resolvable through the swap, then finishes it', async () => {
    vi.clearAllTimers()
    const drawn: string[] = []
    const { source, plan } = renameable(drawn)
    const d = new DetailImagery({ plan })
    const inner = d as unknown as {
      want?: { plan: { level: { z: number; x: number; y: number }[] } }
      atlas: { slots: { has(k: string): boolean } }
      prevLabel?: string
    }
    for (let i = 0; i < 60; i++) {
      d.update(45, 10, 0.05, 900, 1.4)
      await flush()
      vi.advanceTimersByTime(16)
    }
    const before = d.index!.resident
    expect(before).toBeGreaterThan(0)
    const rendered = drawn.length

    source.label = 'v2'
    let minResident = Infinity
    for (let i = 0; i < 80; i++) {
      d.update(45, 10, 0.05, 900, 1.4)
      await flush()
      minResident = Math.min(minResident, d.index!.resident)
      vi.advanceTimersByTime(16)
    }
    // the picture never thinned, let alone vanished — the old slots stood in
    expect(minResident).toBeGreaterThanOrEqual(before)
    // every tile of the plan was re-rendered under the new name…
    expect(drawn.length).toBeGreaterThanOrEqual(rendered * 2 - 2)
    // …and once they covered the plan, the handoff ended
    expect(inner.prevLabel).toBeUndefined()
    for (const t of inner.want!.plan.level) {
      expect(inner.atlas.slots.has(`${t.z}/${t.x}/${t.y}/v2`)).toBe(true)
    }
    d.dispose()
  })

  it('never lets the other mode stand in across a plan switch — round 62', async () => {
    vi.clearAllTimers()
    const drawn: string[] = []
    const { plan } = renameable(drawn)
    const d = new DetailImagery({ plan })
    const inner = d as unknown as { label?: string; prevLabel?: string }
    for (let i = 0; i < 40; i++) {
      d.update(45, 10, 0.05, 900, 1.4)
      await flush()
      vi.advanceTimersByTime(16)
    }
    expect(inner.label).toBe('v1')
    const other: string[] = []
    d.setPlan(renameable(other).plan)
    // the old mode's label may not survive into the new one as a stand-in
    expect(inner.label).toBeUndefined()
    expect(inner.prevLabel).toBeUndefined()
    d.dispose()
  })
})
