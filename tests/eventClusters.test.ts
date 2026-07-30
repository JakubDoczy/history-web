import { describe, it, expect } from 'vitest'
import type { HistoricalEvent } from '../src/lib/events'
import {
  angularSeparationDeg,
  clusterEvents,
  clusterSpanBucket,
  clusterThresholdDeg,
  fanPositions,
  FAN_SPAN_FRACTION,
  layoutPins,
  spanChangedEnough,
  wrapLngDeg,
} from '../src/lib/eventClusters'

const ev = (id: string, o: Partial<HistoricalEvent> = {}): HistoricalEvent => ({
  id, name: id, start: 0, lat: 0, lng: 0, priority: 50, tags: ['war'], summary: '', ...o,
})

/** Roughly world view (altitude 2.5), and a street-level view of one city. */
const WORLD_SPAN = 147
const CITY_SPAN = 0.05

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

describe('fanPositions', () => {
  const RADIUS_AT_40 = 40 * FAN_SPAN_FRACTION

  it('spreads members evenly around the anchor at a span-scaled radius', () => {
    const spots = fanPositions({ lat: 0, lng: 0 }, 4, 40)
    expect(spots).toHaveLength(4)
    for (const s of spots)
      expect(angularSeparationDeg({ lat: 0, lng: 0 }, s)).toBeCloseTo(RADIUS_AT_40, 1)
    const wider = fanPositions({ lat: 0, lng: 0 }, 4, 80)
    expect(angularSeparationDeg({ lat: 0, lng: 0 }, wider[0])).toBeGreaterThan(
      angularSeparationDeg({ lat: 0, lng: 0 }, spots[0]),
    )
  })

  it('puts the first member directly above the anchor', () => {
    const [first] = fanPositions({ lat: 10, lng: 20 }, 3, 40)
    expect(first.lat).toBeGreaterThan(10)
    expect(first.lng).toBeCloseTo(20, 6)
  })

  it('divides longitude by cos(lat) so the ring stays round near the poles', () => {
    const [, side] = fanPositions({ lat: 60, lng: 0 }, 4, 40)
    // the side member is a quarter turn round, so its offset is pure longitude
    expect(Math.abs(wrapLngDeg(side.lng))).toBeCloseTo(
      RADIUS_AT_40 / Math.cos((60 * Math.PI) / 180),
      2,
    )
    expect(angularSeparationDeg({ lat: 60, lng: 0 }, side)).toBeCloseTo(RADIUS_AT_40, 1)
  })

  it('keeps longitudes wrapped when the anchor sits on the seam', () => {
    for (const s of fanPositions({ lat: 0, lng: 179.9 }, 4, 40))
      expect(Math.abs(s.lng)).toBeLessThanOrEqual(180)
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
    const { pins, legs } = layoutPins(groups, { visibleSpanDeg: WORLD_SPAN })
    expect(legs).toHaveLength(0)
    expect(pins.filter((p) => p.kind === 'cluster')).toHaveLength(1)
    const badge = pins.find((p) => p.kind === 'cluster')!
    expect(badge.kind === 'cluster' && badge.members).toHaveLength(3)
    expect(pins.filter((p) => p.kind === 'event').map((p) => p.id)).toEqual(['kyoto'])
  })

  it('fans an expanded cluster out, one leg per member', () => {
    const { pins, legs } = layoutPins(groups, {
      expandedId: 'colosseum',
      visibleSpanDeg: WORLD_SPAN,
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
    const { pins } = layoutPins(groups, { expandedId: 'colosseum', visibleSpanDeg: WORLD_SPAN })
    const forum = pins.find((p) => p.id === 'forum')!
    expect(forum.kind === 'event' && forum.fanned).toBe(true)
    expect(forum.lat).not.toBeCloseTo(41.892, 3)
    const kyoto = pins.find((p) => p.id === 'kyoto')!
    expect(kyoto.kind === 'event' && kyoto.fanned).toBe(false)
    expect(kyoto.lat).toBe(35)
  })

  it('lifts the selected event out of a collapsed cluster, at its own coordinates', () => {
    const { pins } = layoutPins(groups, { selectedId: 'vatican', visibleSpanDeg: WORLD_SPAN })
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
    const { pins } = layoutPins(pair, { selectedId: 'a', visibleSpanDeg: WORLD_SPAN })
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
