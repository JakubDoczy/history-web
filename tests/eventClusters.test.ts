import { describe, it, expect } from 'vitest'
import { parseItem, type HistoricalEvent, type RawEvent } from '../src/lib/events'
import {
  angularSeparationDeg,
  clusterEvents,
  clusterSpanBucket,
  clusterThresholdDeg,
  fanPositions,
  fanRadiusDeg,
  fanRadiusPx,
  fanViewFor,
  legStrokeDeg,
  LEG_ARC,
  LEG_STROKE_PX,
  PIN_ALTITUDE,
  FAN_MAX_PX,
  FAN_MAX_VIEWPORT_FRACTION,
  FAN_MIN_PX,
  layoutPins,
  type FanView,
  spanChangedEnough,
  wrapLngDeg,
} from '../src/lib/eventClusters'
import { degPerScreenPx, viewSpanDeg } from '../src/lib/detailImagery'

const ev = (id: string, o: Partial<RawEvent> = {}): HistoricalEvent =>
  parseItem({
    id, name: id, start: 0, lat: 0, lng: 0, priority: 50, tags: ['war'], summary: '', ...o,
  }) as HistoricalEvent

/** Roughly world view (altitude 2.5), and a street-level view of one city. */
const WORLD_SPAN = 147
const CITY_SPAN = 0.05

/**
 * A 1000x800 window at a given camera altitude, in globe radii — the real
 * conversion the app uses, so these are the numbers a user would see.
 */
const viewAt = (altitude: number, widthPx = 1000, heightPx = 800): FanView =>
  fanViewFor({ altitude, fovDeg: 50, widthPx, heightPx })
/** Whole planet on screen. */
const WORLD_VIEW = viewAt(2.5)
/** Zoomed into one city: the case where the old horizon-scaled fan flew off screen. */
const CITY_VIEW = viewAt(0.02)

describe('wrapLngDeg', () => {
  it('takes the short way round the seam', () => {
    expect(wrapLngDeg(1)).toBe(1)
    expect(wrapLngDeg(359)).toBe(-1)
    expect(wrapLngDeg(-359)).toBe(1)
    expect(wrapLngDeg(-181)).toBe(179)
  })
})

describe('angularSeparationDeg', () => {
  it('scales longitude by cos(lat): a degree of longitude is shorter up north', () => {
    const atEquator = angularSeparationDeg({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })
    const atSixty = angularSeparationDeg({ lat: 60, lng: 0 }, { lat: 60, lng: 1 })
    expect(atEquator).toBeCloseTo(1, 4)
    expect(atSixty).toBeCloseTo(0.5, 2) // cos 60° = 0.5
  })

  it('crosses the antimeridian instead of going the long way round', () => {
    expect(angularSeparationDeg({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 })).toBeCloseTo(1, 4)
  })

  it('is symmetric and zero for a point against itself', () => {
    const a = { lat: 41.9, lng: 12.5 }
    const b = { lat: -33.9, lng: 151.2 }
    expect(angularSeparationDeg(a, b)).toBeCloseTo(angularSeparationDeg(b, a), 9)
    expect(angularSeparationDeg(a, a)).toBe(0)
  })
})

describe('clusterThresholdDeg', () => {
  it('scales with the visible span', () => {
    expect(clusterThresholdDeg(WORLD_SPAN)).toBeGreaterThan(clusterThresholdDeg(10))
    expect(clusterThresholdDeg(10) / clusterThresholdDeg(5)).toBeCloseTo(2, 6)
  })
  it('never collapses to zero, however close the camera', () => {
    expect(clusterThresholdDeg(0)).toBeGreaterThan(0)
  })
})

describe('clusterEvents', () => {
  const rome = [
    ev('forum', { lat: 41.892, lng: 12.485, priority: 60 }),
    ev('colosseum', { lat: 41.89, lng: 12.492, priority: 80 }),
    ev('vatican', { lat: 41.902, lng: 12.454, priority: 70 }),
  ]

  it('groups same-city events at world view', () => {
    const { singles, clusters } = clusterEvents(rome, WORLD_SPAN)
    expect(singles).toHaveLength(0)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].members.map((e) => e.id)).toEqual(['colosseum', 'vatican', 'forum'])
  })

  it('separates them again once the span shrinks to the streets between them', () => {
    const { singles, clusters } = clusterEvents(rome, CITY_SPAN)
    expect(clusters).toHaveLength(0)
    expect(singles.map((g) => g.id).sort()).toEqual(['colosseum', 'forum', 'vatican'])
  })

  it('anchors a cluster on its highest-priority member, wherever it is in the input', () => {
    const { clusters } = clusterEvents([...rome].reverse(), WORLD_SPAN)
    expect(clusters[0].id).toBe('colosseum')
    expect(clusters[0].lat).toBe(41.89)
    expect(clusters[0].lng).toBe(12.492)
  })

  it('clusters neighbours either side of the antimeridian', () => {
    const pair = [
      ev('fiji', { lat: -17, lng: 179.8, priority: 40 }),
      ev('taveuni', { lat: -17.1, lng: -179.9, priority: 90 }),
    ]
    const { clusters } = clusterEvents(pair, WORLD_SPAN)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].id).toBe('taveuni')
  })

  it('leaves far-apart events as singles', () => {
    const { singles, clusters } = clusterEvents(
      [ev('a', { lat: 0, lng: 0 }), ev('b', { lat: 50, lng: 100 })],
      WORLD_SPAN,
    )
    expect(clusters).toHaveLength(0)
    expect(singles).toHaveLength(2)
  })

  it('keeps every event exactly once', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      ev(`e${i}`, { lat: (i % 5) * 0.4, lng: Math.floor(i / 5) * 0.4, priority: i }),
    )
    const { singles, clusters } = clusterEvents(many, 30)
    const ids = [...singles, ...clusters].flatMap((g) => g.members.map((e) => e.id))
    expect(ids).toHaveLength(25)
    expect(new Set(ids).size).toBe(25)
  })
})

describe('fan radius', () => {
  it('is a fixed number of screen pixels, not a slice of the horizon', () => {
    for (const count of [2, 4, 12]) {
      const px = fanRadiusPx(count, WORLD_VIEW)
      expect(px).toBeGreaterThanOrEqual(FAN_MIN_PX)
      expect(px).toBeLessThanOrEqual(FAN_MAX_PX)
    }
    // the same pixel radius whatever the zoom
    expect(fanRadiusPx(4, CITY_VIEW)).toBe(fanRadiusPx(4, WORLD_VIEW))
  })

  it('grows modestly with member count, so a big ring does not overlap itself', () => {
    expect(fanRadiusPx(12, WORLD_VIEW)).toBeGreaterThan(fanRadiusPx(3, WORLD_VIEW))
    expect(fanRadiusPx(12, WORLD_VIEW)).toBeLessThanOrEqual(FAN_MAX_PX)
    // and stops growing: forty members must not push the ring off screen
    expect(fanRadiusPx(40, WORLD_VIEW)).toBe(fanRadiusPx(12, WORLD_VIEW))
  })

  it('never exceeds 15% of the viewport short side, however small the window', () => {
    for (const [w, h] of [
      [1000, 800],
      [320, 560],
      [1400, 300],
      [40, 40],
    ]) {
      const v = viewAt(0.2, w, h)
      expect(fanRadiusPx(12, v)).toBeLessThanOrEqual(
        Math.min(w, h) * FAN_MAX_VIEWPORT_FRACTION + 1e-9,
      )
    }
  })

  it('shrinks in degrees exactly as the frame span shrinks', () => {
    // the scale is proportional to the camera's height above the pins, so
    // halving that halves the ring
    const wide = fanRadiusDeg(4, viewAt(0.4 + PIN_ALTITUDE))
    expect(fanRadiusDeg(4, viewAt(0.2 + PIN_ALTITUDE))).toBeCloseTo(wide / 2, 12)
    expect(fanRadiusDeg(4, viewAt(0.004 + PIN_ALTITUDE))).toBeCloseTo(wide / 100, 12)
    // and is exactly the pixel radius converted through the frame
    expect(fanRadiusDeg(4, viewAt(0.4))).toBeCloseTo(
      fanRadiusPx(4, viewAt(0.4)) * degPerScreenPx(0.4 - PIN_ALTITUDE, 800),
      12,
    )
  })

  it('measures the scale in the pin plane, not on the ground', () => {
    // pins float at PIN_ALTITUDE, so close in they are magnified relative to
    // the surface: at a 110 km view the difference is over 50%
    const alt = 0.0175
    const ground = degPerScreenPx(alt, 800)
    expect(viewAt(alt).degPerPx).toBeCloseTo(ground * ((alt - PIN_ALTITUDE) / alt), 12)
    expect(viewAt(alt).degPerPx).toBeLessThan(ground * 0.7)
    // and far out the correction is invisible, as it should be
    expect(viewAt(2.5).degPerPx / degPerScreenPx(2.5, 800)).toBeCloseTo(1, 2)
  })

  it('stays finite when the camera drops below the pins themselves', () => {
    const v = viewAt(PIN_ALTITUDE / 2)
    expect(v.degPerPx).toBeGreaterThan(0)
    expect(Number.isFinite(fanRadiusDeg(6, v))).toBe(true)
  })

  it('survives a degenerate frame without dividing by zero', () => {
    expect(Number.isFinite(fanRadiusDeg(4, viewAt(0, 0, 0)))).toBe(true)
    expect(fanRadiusDeg(4, { degPerPx: 0, widthPx: 0, heightPx: 0 })).toBe(0)
  })
})

describe('legStrokeDeg', () => {
  it('is a hairline on screen at every zoom, not a fixed slice of the globe', () => {
    for (const alt of [2.5, 0.4, 0.02]) {
      const v = viewAt(alt)
      expect(legStrokeDeg(v) / v.degPerPx).toBeCloseTo(LEG_STROKE_PX, 9)
      // and always far thinner than the ring it points across
      expect(legStrokeDeg(v)).toBeLessThan(fanRadiusDeg(3, v) / 10)
    }
  })

  it('shrinks with the zoom rather than swallowing the pins', () => {
    expect(legStrokeDeg(viewAt(0.02))).toBeLessThan(legStrokeDeg(viewAt(2.5)) / 50)
    expect(legStrokeDeg(viewAt(0.02))).toBeGreaterThan(0)
  })
})

/**
 * The fireworks, in numbers.
 *
 * The arc layer draws a Bézier that leaves the ground, rises to `altitude` and
 * comes back — so the shape of a leg is entirely decided by these four values,
 * and the complaint ("children fly out on parabolic arcs") was the old
 * altitude of 0.004 radii being *four times* the whole length of the leg at the
 * zoom a stack is actually opened at.
 */
describe('LEG_ARC', () => {
  it('is flat: the same altitude at both ends and in the middle', () => {
    expect(LEG_ARC.startAltitude).toBe(LEG_ARC.altitude)
    expect(LEG_ARC.endAltitude).toBe(LEG_ARC.altitude)
  })

  it('lies in the plane the pins float in, so a leg meets the tip it points at', () => {
    expect(LEG_ARC.altitude).toBe(PIN_ALTITUDE)
  })

  it('does not tween — a fan relaid on every frame of a zoom has nothing to chase', () => {
    expect(LEG_ARC.transitionMs).toBe(0)
  })

  it('no longer hops several times the length of the leg it is drawn along', () => {
    // An altitude in globe radii is that many radians of arc, which is the unit
    // the fan is measured in — so the two are directly comparable.
    const asDeg = (radii: number) => (radii * 180) / Math.PI
    const legDeg = fanRadiusDeg(6, CITY_VIEW)
    // what it used to do: an apex four times the leg's own ground length
    expect(asDeg(0.004) / legDeg).toBeGreaterThan(3)
    // what it does now: nothing at all, at any zoom
    expect(asDeg(LEG_ARC.altitude - LEG_ARC.startAltitude)).toBe(0)
  })
})

describe('fanPositions', () => {
  const anchor = { lat: 0, lng: 0 }
  /** Where a fanned member lands on screen, in CSS px from the anchor. */
  const offsetPx = (
    centre: { lat: number; lng: number },
    spot: { lat: number; lng: number },
    v: FanView,
  ) => angularSeparationDeg(centre, spot) / v.degPerPx

  it('spreads members evenly around the anchor at the screen radius', () => {
    const view = viewAt(0.4)
    const spots = fanPositions(anchor, 4, view)
    expect(spots).toHaveLength(4)
    for (const s of spots)
      expect(angularSeparationDeg(anchor, s) / fanRadiusDeg(4, view)).toBeCloseTo(1, 3)
    // evenly: four members are a quarter turn apart
    for (let i = 0; i < 4; i++)
      expect(angularSeparationDeg(spots[i], spots[(i + 1) % 4])).toBeCloseTo(
        angularSeparationDeg(spots[0], spots[1]),
        6,
      )
  })

  it('tracks zoom: the ring is the same size on screen at any span', () => {
    for (const alt of [2.5, 0.4, 0.02, 0.002]) {
      const v = viewAt(alt)
      // the cos(lat) correction is a flat-earth step on a sphere, so a ring
      // ten degrees wide is round to a part in a thousand rather than exactly
      for (const s of fanPositions(anchor, 6, v))
        expect(offsetPx(anchor, s, v) / fanRadiusPx(6, v)).toBeCloseTo(1, 2)
    }
    // in *degrees* it shrinks with the zoom, which is what used to be wrong
    expect(angularSeparationDeg(anchor, fanPositions(anchor, 6, viewAt(0.02))[0])).toBeLessThan(
      angularSeparationDeg(anchor, fanPositions(anchor, 6, viewAt(2.5))[0]) / 100,
    )
  })

  it('keeps a crowded fan inside the viewport at close zoom', () => {
    // twelve members, a ~1 deg frame: the case that used to fly off screen
    const v = CITY_VIEW
    const spots = fanPositions({ lat: 41.9, lng: 12.5 }, 12, v)
    const halfFrameDeg = viewSpanDeg(0.02) / 2
    for (const s of spots) {
      const sep = angularSeparationDeg({ lat: 41.9, lng: 12.5 }, s)
      expect(sep).toBeLessThan(halfFrameDeg) // on screen at all
      expect(offsetPx({ lat: 41.9, lng: 12.5 }, s, v)).toBeLessThanOrEqual(
        Math.min(v.widthPx, v.heightPx) * FAN_MAX_VIEWPORT_FRACTION + 1e-6,
      )
    }
  })

  it('puts the first member directly above the anchor', () => {
    const [first] = fanPositions({ lat: 10, lng: 20 }, 3, viewAt(0.4))
    expect(first.lat).toBeGreaterThan(10)
    expect(first.lng).toBeCloseTo(20, 6)
  })

  it('divides longitude by cos(lat) so the ring stays round near the poles', () => {
    const view = viewAt(0.4)
    const r = fanRadiusDeg(4, view)
    const [, side] = fanPositions({ lat: 60, lng: 0 }, 4, view)
    // the side member is a quarter turn round, so its offset is pure longitude
    expect(Math.abs(wrapLngDeg(side.lng))).toBeCloseTo(r / Math.cos((60 * Math.PI) / 180), 6)
    expect(angularSeparationDeg({ lat: 60, lng: 0 }, side) / r).toBeCloseTo(1, 3)
  })

  it('stays on the map at the poles', () => {
    for (const lat of [89.9, -89.9]) {
      for (const s of fanPositions({ lat, lng: 30 }, 8, viewAt(2.5))) {
        expect(Math.abs(s.lat)).toBeLessThanOrEqual(89.5)
        expect(Math.abs(s.lng)).toBeLessThanOrEqual(180)
        expect(Number.isFinite(s.lng)).toBe(true)
      }
    }
  })

  it('keeps longitudes wrapped when the anchor sits on the seam', () => {
    for (const alt of [2.5, 0.02]) {
      const spots = fanPositions({ lat: 0, lng: 179.9 }, 4, viewAt(alt))
      for (const s of spots) expect(Math.abs(s.lng)).toBeLessThanOrEqual(180)
      // and the ring is still round across the seam: every member the same
      // distance from the anchor, none of them a near-360 deg jump away
      for (const s of spots)
        expect(
          angularSeparationDeg({ lat: 0, lng: 179.9 }, s) / fanRadiusDeg(4, viewAt(alt)),
        ).toBeCloseTo(1, 3)
    }
  })
})

describe('layoutPins', () => {
  const rome = [
    ev('forum', { lat: 41.892, lng: 12.485, priority: 60 }),
    ev('colosseum', { lat: 41.89, lng: 12.492, priority: 80 }),
    ev('vatican', { lat: 41.902, lng: 12.454, priority: 70 }),
  ]
  const lone = ev('kyoto', { lat: 35, lng: 135.7, priority: 55 })
  const groups = clusterEvents([...rome, lone], WORLD_SPAN)

  it('draws a badge for a collapsed cluster and a pin for a single', () => {
    const { pins, legs } = layoutPins(groups, { fan: WORLD_VIEW })
    expect(legs).toHaveLength(0)
    expect(pins.filter((p) => p.kind === 'cluster')).toHaveLength(1)
    const badge = pins.find((p) => p.kind === 'cluster')!
    expect(badge.kind === 'cluster' && badge.members).toHaveLength(3)
    expect(pins.filter((p) => p.kind === 'event').map((p) => p.id)).toEqual(['kyoto'])
  })

  it('fans an expanded cluster out, one leg per member', () => {
    const { pins, legs } = layoutPins(groups, {
      expandedId: 'colosseum',
      fan: WORLD_VIEW,
    })
    expect(pins.filter((p) => p.kind === 'cluster')).toHaveLength(0)
    expect(pins.map((p) => p.id).sort()).toEqual(['colosseum', 'forum', 'kyoto', 'vatican'])
    expect(legs).toHaveLength(3)
    // each leg runs from the anchor to where its member was actually drawn
    for (const leg of legs) {
      const pin = pins.find((p) => p.id === leg.event.id)!
      expect(pin.lat).toBe(leg.endLat)
      expect(pin.lng).toBe(leg.endLng)
      expect(leg.startLat).toBe(41.89)
    }
  })

  it('moves fanned members off their true coordinates, but not the rest', () => {
    const { pins } = layoutPins(groups, { expandedId: 'colosseum', fan: WORLD_VIEW })
    const forum = pins.find((p) => p.id === 'forum')!
    expect(forum.kind === 'event' && forum.fanned).toBe(true)
    expect(forum.lat).not.toBeCloseTo(41.892, 3)
    const kyoto = pins.find((p) => p.id === 'kyoto')!
    expect(kyoto.kind === 'event' && kyoto.fanned).toBe(false)
    expect(kyoto.lat).toBe(35)
  })

  it('lifts the selected event out of a collapsed cluster, at its own coordinates', () => {
    const { pins } = layoutPins(groups, { selectedId: 'vatican', fan: WORLD_VIEW })
    const pick = pins.find((p) => p.id === 'vatican')!
    expect(pick.kind).toBe('event')
    expect(pick.lat).toBe(41.902)
    const badge = pins.find((p) => p.kind === 'cluster')!
    expect(badge.kind === 'cluster' && badge.members.map((e) => e.id)).toEqual([
      'colosseum',
      'forum',
    ])
  })

  it('drops the badge entirely when lifting the selection leaves one event', () => {
    const pair = clusterEvents(
      [ev('a', { lat: 0, lng: 0, priority: 10 }), ev('b', { lat: 0.1, lng: 0.1, priority: 20 })],
      WORLD_SPAN,
    )
    const { pins } = layoutPins(pair, { selectedId: 'a', fan: WORLD_VIEW })
    expect(pins).toHaveLength(2)
    expect(pins.every((p) => p.kind === 'event')).toBe(true)
  })
})

describe('clusterSpanBucket', () => {
  it('snaps nearby spans to the same bucket, so zoom does not re-cluster every frame', () => {
    expect(clusterSpanBucket(40)).toBe(clusterSpanBucket(41))
    expect(clusterSpanBucket(40)).toBeGreaterThan(0)
  })
  it('still separates spans an octave apart', () => {
    expect(clusterSpanBucket(40)).not.toBe(clusterSpanBucket(80))
    expect(clusterSpanBucket(80) / clusterSpanBucket(40)).toBeCloseTo(2, 6)
  })
  it('survives a degenerate span', () => {
    expect(Number.isFinite(clusterSpanBucket(0))).toBe(true)
  })
})

describe('spanChangedEnough', () => {
  it('ignores small zoom nudges', () => {
    expect(spanChangedEnough(40, 44)).toBe(false)
    expect(spanChangedEnough(40, 36)).toBe(false)
  })
  it('fires in either direction once the view really moves', () => {
    expect(spanChangedEnough(40, 80)).toBe(true)
    expect(spanChangedEnough(40, 20)).toBe(true)
  })
  it('treats "never recorded" as changed', () => {
    expect(spanChangedEnough(0, 40)).toBe(true)
  })
})
