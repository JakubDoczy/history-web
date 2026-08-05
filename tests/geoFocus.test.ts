import { describe, it, expect } from 'vitest'
import {
  FIT_FOV,
  MAX_FIT_ALTITUDE,
  MIN_FIT_ALTITUDE,
  POINT_CAP_DEG,
  altitudeForCapDeg,
  boundingCap,
  focusTargetFor,
  tightFovDeg,
  MIN_FIT_ASPECT,
} from '../src/lib/geoFocus'
import { viewSpanDeg, visibleSpanDeg } from '../src/lib/detailImagery'
import { separationDeg } from '../src/lib/queryIndex'
import { parseItem, shapeOf, type Concept, type HistoricalEvent, type Person, type RawEvent } from '../src/lib/events'
import type { GeoPath } from '../src/lib/paths'

const ev = (o: Partial<RawEvent> = {}): HistoricalEvent =>
  parseItem({
    id: 'e', name: 'e', start: 1500, lat: 0, lng: 0, priority: 50, tags: ['war'], summary: '', ...o,
  }) as HistoricalEvent

describe('boundingCap', () => {
  it('contains every point it was cut from', () => {
    const sets: GeoPath[] = [
      [
        [0, 0],
        [10, 10],
        [-5, 4],
      ],
      // a route crossing the antimeridian: no longitude convention to get wrong
      [
        [170, 10],
        [178, 12],
        [-175, 14],
        [-168, 11],
      ],
      // and one crossing a pole
      [
        [0, 85],
        [90, 88],
        [180, 86],
      ],
    ]
    for (const points of sets) {
      const cap = boundingCap(points)!
      for (const [lng, lat] of points)
        expect(separationDeg(cap.lat, cap.lng, lat, lng)).toBeLessThanOrEqual(cap.radiusDeg + 1e-9)
    }
  })

  it('gives a single point a cap of no width, centred on it', () => {
    const cap = boundingCap([[12.5, -8.25]])!
    expect(cap.lat).toBeCloseTo(-8.25, 9)
    expect(cap.lng).toBeCloseTo(12.5, 9)
    expect(cap.radiusDeg).toBeCloseTo(0, 9)
  })

  it('falls back to the anchor when the points cancel out', () => {
    // a route right round the equator has a mean vector of nothing at all
    const wrapped: GeoPath = [
      [0, 0],
      [90, 0],
      [180, 0],
      [-90, 0],
    ]
    expect(boundingCap(wrapped)).toBeUndefined()
    const cap = boundingCap(wrapped, { lat: 5, lng: 10 })!
    expect([cap.lat, cap.lng]).toEqual([5, 10])
    expect(cap.radiusDeg).toBeGreaterThan(90)
  })

  it('has nothing to say about no points at all', () => {
    expect(boundingCap([])).toBeUndefined()
    expect(boundingCap([], { lat: 0, lng: 0 })).toBeUndefined()
  })
})

describe('altitudeForCapDeg', () => {
  it('puts the cap inside the frame, with margin, at every size that fits', () => {
    for (const radius of [0.5, 2, 6, 15, 30, 45, 60]) {
      const alt = altitudeForCapDeg(radius)
      // the frame (or, once the frame is wider than the planet, the horizon)
      // holds the whole cap
      const framed = Math.max(viewSpanDeg(alt, FIT_FOV), visibleSpanDeg(alt)) / 2
      expect(framed, `cap ${radius}°`).toBeGreaterThanOrEqual(radius)
    }
  })

  it('is monotonic: a wider cap never asks for a closer camera', () => {
    let prev = -Infinity
    for (let r = 0; r <= 90; r += 1.5) {
      const alt = altitudeForCapDeg(r)
      expect(alt).toBeGreaterThanOrEqual(prev)
      prev = alt
    }
  })

  it('stops at world view rather than pretending a whole globe can be framed', () => {
    expect(altitudeForCapDeg(120)).toBe(MAX_FIT_ALTITUDE)
    expect(altitudeForCapDeg(180)).toBe(MAX_FIT_ALTITUDE)
    expect(altitudeForCapDeg(0)).toBe(MIN_FIT_ALTITUDE)
    expect(altitudeForCapDeg(-5)).toBe(MIN_FIT_ALTITUDE)
  })

  it('respects the lens: a narrow one has to back further off', () => {
    expect(altitudeForCapDeg(10, 30)).toBeGreaterThan(altitudeForCapDeg(10, 50))
  })
})

describe('focusTargetFor', () => {
  it('frames a point event from a height that shows its region', () => {
    const target = focusTargetFor(ev({ lat: 48.86, lng: 2.35 }))!
    expect(target.lat).toBeCloseTo(48.86, 6)
    expect(target.lng).toBeCloseTo(2.35, 6)
    expect(target.altitude).toBe(altitudeForCapDeg(POINT_CAP_DEG))
    // a ~1500 km frame: the city in its country, not the city filling the screen
    expect(viewSpanDeg(target.altitude, FIT_FOV) * 111.32).toBeGreaterThan(1000)
    expect(viewSpanDeg(target.altitude, FIT_FOV) * 111.32).toBeLessThan(2500)
  })

  it('fits an area event to its footprint, not to its centroid', () => {
    const area = ev({
      lat: 0,
      lng: 0,
      area: [
        [-20, -20],
        [20, -20],
        [20, 20],
        [-20, 20],
      ],
    })
    const point = focusTargetFor(ev({ lat: 0, lng: 0 }))!
    expect(focusTargetFor(area)!.altitude).toBeGreaterThan(point.altitude)
  })

  it('fits a route, and pulls the camera off the pin to do it', () => {
    // pin in the Strait of Magellan, route out into the Pacific
    const e = ev({
      lat: -52.5,
      lng: -70,
      paths: [
        [
          [-70, -52.5],
          [-100, -35],
          [-130, -15],
          [-145, 0],
        ],
      ],
    })
    const target = focusTargetFor(e)!
    const { lat: anchorLat, lng: anchorLng } = e.geometry.anchor
    expect(target.altitude).toBeGreaterThan(1)
    // the camera looks at the middle of the route, not at the pin
    expect(separationDeg(target.lat, target.lng, anchorLat, anchorLng)).toBeGreaterThan(20)
    // and every waypoint is inside the horizon from there
    for (const [lng, lat] of shapeOf(e.geometry, 'routes')!.paths[0])
      expect(separationDeg(target.lat, target.lng, lat, lng)).toBeLessThanOrEqual(
        visibleSpanDeg(target.altitude) / 2 + 1e-9,
      )
  })

  it('includes the pin, the footprint and every route at once', () => {
    const both = ev({
      lat: 5,
      lng: -25,
      area: [
        [-70, -25],
        [12, -10],
      ],
      paths: [
        [
          [-3, 53.4],
          [-1.28, 5.1],
        ],
      ],
    })
    const target = focusTargetFor(both)!
    for (const [lng, lat] of [[-70, -25], [12, -10], [-3, 53.4], [5, -25], [-25, 5]] as GeoPath)
      expect(separationDeg(target.lat, target.lng, lat, lng)).toBeLessThanOrEqual(
        visibleSpanDeg(target.altitude) / 2 + 1e-9,
      )
  })

  it('sends a life to the place it began, and an idea nowhere at all', () => {
    const person: Person = {
      id: 'p', kind: 'person', name: 'p', born: 1879, priority: 50, tags: ['science'], summary: '',
      birthPlace: { lat: 48.4, lng: 9.99 },
      deathPlace: { lat: 40.35, lng: -74.66 },
    }
    const target = focusTargetFor(person)!
    expect([target.lat, target.lng]).toEqual([48.4, 9.99])

    const noBirth = focusTargetFor({ ...person, birthPlace: undefined })!
    expect(noBirth.lat).toBeCloseTo(40.35, 9)
    expect(noBirth.lng).toBeCloseTo(-74.66, 9)
    expect(noBirth.altitude).toBe(target.altitude)
    expect(focusTargetFor({ ...person, birthPlace: undefined, deathPlace: undefined })).toBeUndefined()

    const concept: Concept = {
      id: 'c', kind: 'concept', name: 'c', anchorYear: 1600, priority: 50, tags: ['science'], summary: '',
    }
    expect(focusTargetFor(concept)).toBeUndefined()
  })
})

describe('focusTargetFor — a drawing is geometry too', () => {
  it('frames a battle plan on the plan, not on the pin it hangs from', () => {
    const plan = ev({
      lat: 49.34,
      lng: -0.6,
      drawing: {
        layers: [
          { type: 'frontline', paths: [[[-1.6, 49.6], [0.1, 49.2]]] },
          { type: 'marker', pos: [-0.9, 49.4] },
          { type: 'label', pos: [-0.3, 49.3], text: 'Sword' },
        ],
      },
    })
    const target = focusTargetFor(plan)!
    // fitted to the plan's own extent, which is a great deal closer than the
    // 1500 km frame a bare point is given
    expect(target.altitude).toBeLessThan(altitudeForCapDeg(POINT_CAP_DEG))
    for (const [lng, lat] of [[-1.6, 49.6], [0.1, 49.2], [-0.9, 49.4], [-0.3, 49.3]] as GeoPath)
      expect(separationDeg(target.lat, target.lng, lat, lng)).toBeLessThanOrEqual(
        visibleSpanDeg(target.altitude) / 2 + 1e-9,
      )
  })

  it('still gives a bare point the point cap, whatever coordinate it sits at', () => {
    // separationDeg of a point against itself returns a hair above zero at some
    // coordinates (an acos near 1); without the extent epsilon those points were
    // framed from the minimum altitude instead of the point cap
    for (const [lng, lat] of [[0, 0], [-74.66, 40.35], [37.62, 55.75], [139.7, 35.7]])
      expect(focusTargetFor(ev({ lat, lng }))!.altitude, `${lng},${lat}`).toBe(
        altitudeForCapDeg(POINT_CAP_DEG),
      )
  })

  it('never goes closer than the app"s own zoom floor', () => {
    const tiny = ev({
      lat: 49.34,
      lng: -0.6,
      drawing: { layers: [{ type: 'marker', pos: [-0.59, 49.35] }] },
    })
    expect(focusTargetFor(tiny)!.altitude).toBe(MIN_FIT_ALTITUDE)
  })
})

/* --------------------------------------------- the frame is a rectangle ---
   Regression: the fit inverted the camera's VERTICAL fov and nothing else, so
   the altitude for an item was the same on a 1440x900 desktop as on a 390x844
   phone — where the frame is half as wide as it is tall, and a wide item
   (Barbarossa's front, the Silk Road) hung off both sides of the screen. */
describe('tightFovDeg', () => {
  it('leaves a landscape window alone: its height is already the tight axis', () => {
    expect(tightFovDeg(FIT_FOV, 16 / 9)).toBe(FIT_FOV)
    expect(tightFovDeg(FIT_FOV, 1)).toBe(FIT_FOV)
  })

  it('narrows for a portrait window, by the tangent the projection scales', () => {
    const aspect = 390 / 844
    const expected = (2 * Math.atan(aspect * Math.tan((FIT_FOV / 2) * (Math.PI / 180)))) * (180 / Math.PI)
    expect(tightFovDeg(FIT_FOV, aspect)).toBeCloseTo(expected, 9)
    expect(tightFovDeg(FIT_FOV, aspect)).toBeLessThan(FIT_FOV)
    // and monotone: the narrower the window, the narrower the lens across it
    expect(tightFovDeg(FIT_FOV, 0.5)).toBeLessThan(tightFovDeg(FIT_FOV, 0.8))
  })

  it('stops believing an aspect past the bounds the rest of the app clamps to', () => {
    expect(tightFovDeg(FIT_FOV, 0.01)).toBe(tightFovDeg(FIT_FOV, MIN_FIT_ASPECT))
    expect(tightFovDeg(FIT_FOV, 99)).toBe(FIT_FOV)
    expect(tightFovDeg(FIT_FOV, 0)).toBe(FIT_FOV) // no measurement yet: square
  })
})

describe('focusTargetFor — fitted to the window that is actually on screen', () => {
  /** A front ~20° wide and ~5° tall: the shape a portrait frame cuts in half. */
  const wide = ev({
    lat: 52,
    lng: 25,
    paths: [
      [
        [15, 54],
        [25, 52],
        [35, 50],
      ],
    ],
  })

  it('backs the camera off on a portrait phone, and not on a desktop', () => {
    const desktop = focusTargetFor(wide, FIT_FOV, 1440 / 900)!.altitude
    const square = focusTargetFor(wide)!.altitude
    const phone = focusTargetFor(wide, FIT_FOV, 390 / 844)!.altitude
    expect(desktop).toBe(square) // landscape never fitted the wrong axis
    expect(phone).toBeGreaterThan(desktop)
  })

  it('keeps the whole item inside the tight axis of the frame, at every window', () => {
    for (const [w, h] of [[1440, 900], [768, 1024], [390, 844], [320, 568]]) {
      const aspect = w / h
      const target = focusTargetFor(wide, FIT_FOV, aspect)!
      // the circle inscribed in the frame: the half-span of whichever axis is
      // narrower, which is what every point has to be inside
      const halfFrame = viewSpanDeg(target.altitude, tightFovDeg(FIT_FOV, aspect)) / 2
      for (const [lng, lat] of shapeOf(wide.geometry, 'routes')!.paths[0])
        expect(
          separationDeg(target.lat, target.lng, lat, lng),
          `${w}x${h} ${lng},${lat}`,
        ).toBeLessThanOrEqual(halfFrame)
    }
  })

  it('gives a bare point its region on a phone too, not a keyhole', () => {
    const point = focusTargetFor(ev({ lat: 48.86, lng: 2.35 }), FIT_FOV, 390 / 844)!
    expect(point.altitude).toBe(altitudeForCapDeg(POINT_CAP_DEG, tightFovDeg(FIT_FOV, 390 / 844)))
    expect(point.altitude).toBeGreaterThan(altitudeForCapDeg(POINT_CAP_DEG))
  })

  it('still stops at world view for a route that circles the planet', () => {
    const round = ev({
      lat: 0,
      lng: 0,
      paths: [[[0, 0], [90, 10], [180, 0], [-90, -10], [0, 0]]],
    })
    expect(focusTargetFor(round, FIT_FOV, 320 / 568)!.altitude).toBe(MAX_FIT_ALTITUDE)
  })
})
