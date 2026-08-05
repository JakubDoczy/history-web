import { describe, it, expect } from 'vitest'
import { parseItem, type HistoricalEvent, type RawEvent } from '../src/lib/events'
import {
  clusterSize,
  clusterSvg,
  pinHeight,
  pinShiftPercent,
  pinStateKey,
  pinSvg,
} from '../src/lib/eventPins'
import type { PinDatum } from '../src/lib/eventClusters'
import type { GeoPath } from '../src/lib/paths'
import { TAG_COLORS } from '../src/lib/tags'

// raw in, parsed out — the only way an item is ever made (see parseItem)
const ev = (o: Partial<RawEvent> = {}): HistoricalEvent =>
  parseItem({
    id: 'e', name: 'e', start: 0, lat: 0, lng: 0, priority: 50, tags: ['war'], summary: '', ...o,
  }) as HistoricalEvent

const attr = (svg: string, name: string) => svg.match(new RegExp(`${name}="([^"]+)"`))![1]

describe('pinHeight', () => {
  it('runs 18..30px over the priority range', () => {
    expect(pinHeight(ev({ priority: 0 }), false)).toBe(18)
    expect(pinHeight(ev({ priority: 100 }), false)).toBe(30)
  })
  it('grows the selected pin by a third', () => {
    expect(pinHeight(ev({ priority: 100 }), true)).toBe(41)
  })
})

describe('pinSvg', () => {
  it('fills with the primary tag colour', () => {
    expect(pinSvg(ev({ tags: ['technology', 'war'] }), false)).toContain(TAG_COLORS.technology)
  })

  it('keeps the pin the same size whether or not the event is an area', () => {
    // the area box is taller because the footprint hangs below the tip; the
    // *pin* inside it must not shrink, so widths have to match
    for (const priority of [0, 50, 100]) {
      const point = pinSvg(ev({ priority }), false)
      const area = pinSvg(ev({ priority, area: [[0, 0]] }), false)
      expect(attr(area, 'width')).toBe(attr(point, 'width'))
      expect(Number(attr(area, 'height'))).toBeGreaterThan(Number(attr(point, 'height')))
    }
  })

  it('reads as an area at the smallest pin size: footprint plus brackets', () => {
    const svg = pinSvg(ev({ priority: 0, area: [[0, 0]] }), false)
    expect(Number(attr(svg, 'height'))).toBeGreaterThanOrEqual(18)
    expect(svg).toContain('pin-footprint')
    expect(svg).toContain('stroke-dasharray')
    expect((svg.match(/<ellipse/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect((svg.match(/<path/g) ?? []).length).toBe(5) // teardrop + four brackets
  })

  it('gives a point event a plain dot and no footprint', () => {
    const svg = pinSvg(ev(), false)
    expect(svg).not.toContain('pin-footprint')
    expect(svg).toContain('<circle cx="12" cy="11" r="3.6"')
  })

  it('draws a winding route in the head of a path event, and no footprint', () => {
    const route: GeoPath = [
      [0, 0],
      [10, 10],
    ]
    const svg = pinSvg(ev({ paths: [route] }), false)
    expect(svg).not.toContain('pin-footprint')
    // the route stroke plus the teardrop; a point pin has only the teardrop
    expect((svg.match(/<path/g) ?? []).length).toBe(2)
    expect(svg).toContain('stroke-linecap="round"')
    // a port at each end of the line, not the point pin's single centre dot
    expect(svg).not.toContain('<circle cx="12" cy="11" r="3.6"')
    expect((svg.match(/r="1.5"/g) ?? []).length).toBe(2)
    // and it is the same size as any other pin of its priority
    expect(attr(svg, 'width')).toBe(attr(pinSvg(ev(), false), 'width'))
    expect(attr(svg, 'height')).toBe(attr(pinSvg(ev(), false), 'height'))
  })

  it('lets a route win the head from a footprint, which the ellipse still says', () => {
    // an event with both (the Atlantic slave trade): the reader is being offered
    // the routes, and the region is still drawn under the tip
    const svg = pinSvg(ev({ area: [[0, 0]], paths: [[[0, 0], [1, 1]]] }), false)
    expect(svg).toContain('pin-footprint')
    expect(svg).not.toContain('stroke-width="2" stroke-linecap="round"') // no brackets
    expect(Number(attr(svg, 'height'))).toBe(Number(attr(pinSvg(ev({ area: [[0, 0]] }), false), 'height')))
  })

  it('marks the selection with a halo and a white outline', () => {
    expect(pinSvg(ev(), true)).toContain('#ffe27a')
    expect(pinSvg(ev(), false)).not.toContain('#ffe27a')
  })
})

describe('pinShiftPercent', () => {
  it('puts a point pin tip on the coordinate (the old -50%)', () => {
    expect(pinShiftPercent(32, 31)).toBeCloseTo(-46.875, 3)
  })
  it('shifts an area pin less, because its box hangs below the tip', () => {
    expect(pinShiftPercent(39, 31)).toBeGreaterThan(pinShiftPercent(32, 31))
  })
  it('leaves a centred mark alone', () => {
    expect(pinShiftPercent(40, 20)).toBe(-0)
  })
})

describe('cluster badge', () => {
  it('grows with the count but stays in pin territory', () => {
    expect(clusterSize(2)).toBeGreaterThanOrEqual(26)
    expect(clusterSize(2)).toBeLessThan(clusterSize(20))
    expect(clusterSize(500)).toBeLessThanOrEqual(38)
  })

  it('is a round badge in the dominant member colour, not a teardrop', () => {
    const svg = clusterSvg([ev({ tags: ['science'] }), ev({ tags: ['war'] })], 2)
    expect(svg).toContain(TAG_COLORS.science)
    expect(svg).not.toContain('<path')
    expect((svg.match(/<circle/g) ?? []).length).toBe(3) // ring, ring stroke, disc
  })

  it('shows the count in white', () => {
    const svg = clusterSvg([ev(), ev(), ev()])
    expect(svg).toContain('>3</text>')
    expect(svg).toContain('fill="#fff"')
  })

  it('caps a huge count rather than overflowing the badge', () => {
    expect(clusterSvg(Array.from({ length: 240 }, () => ev()))).toContain('>99+</text>')
  })
})

describe('pinStateKey', () => {
  const a = ev({ id: 'a' })
  const b = ev({ id: 'b' })
  const pin = (e: HistoricalEvent, lat = 0, lng = 0, fanned = false): PinDatum => ({
    kind: 'event', id: e.id, lat, lng, event: e, fanned,
  })
  const badge = (id: string, members: HistoricalEvent[]): PinDatum => ({
    kind: 'cluster', id, lat: 0, lng: 0, members,
  })

  it('is the same for the same pin in the same state', () => {
    expect(pinStateKey(pin(a), 'b')).toBe(pinStateKey(pin(a), 'b'))
  })

  it('ignores position, so a fanned pin moving does not rebuild it', () => {
    expect(pinStateKey(pin(a, 10, 20), undefined)).toBe(pinStateKey(pin(a, -5, 130, true), undefined))
  })

  it('changes when selection changes, since the artwork does', () => {
    expect(pinStateKey(pin(a), 'a')).not.toBe(pinStateKey(pin(a), undefined))
    // ...but only for the pin that gained or lost it
    expect(pinStateKey(pin(b), 'a')).toBe(pinStateKey(pin(b), undefined))
  })

  it('separates events from badges, and badges by what is in them', () => {
    expect(pinStateKey(badge('a', [a, b]))).not.toBe(pinStateKey(pin(a)))
    expect(pinStateKey(badge('a', [a, b]))).not.toBe(pinStateKey(badge('a', [a])))
    expect(pinStateKey(badge('a', [a, b]))).toBe(pinStateKey(badge('a', [a, b])))
  })
})

/* ------------------------------------------------------ significance tiers */

import { TIER_SCALE } from '../src/lib/eventPins'
import type { Tier } from '../src/lib/eventTiers'

describe('tier styling', () => {
  const tiers: Tier[] = [1, 2, 3]

  it('draws tier 1 at exactly the size the map has always used', () => {
    for (const priority of [0, 50, 100])
      expect(pinHeight(ev({ priority }), false, 1)).toBe(pinHeight(ev({ priority }), false))
    expect(TIER_SCALE[1]).toBe(1)
  })

  it('steps down in size with the tier, at every priority', () => {
    for (const priority of [0, 40, 100]) {
      const h = tiers.map((t) => pinHeight(ev({ priority }), false, t))
      expect(h[0]).toBeGreaterThan(h[1])
      expect(h[1]).toBeGreaterThan(h[2])
    }
  })

  it('keeps the priority scaling inside the tier', () => {
    // a high-priority tier-3 pin is still bigger than a low-priority tier-3 one
    expect(pinHeight(ev({ priority: 100 }), false, 3)).toBeGreaterThan(
      pinHeight(ev({ priority: 0 }), false, 3),
    )
  })

  it('still grows a selected pin by a third, whatever tier it is in', () => {
    for (const t of tiers)
      expect(pinHeight(ev({ priority: 100 }), true, t) / pinHeight(ev({ priority: 100 }), false, t))
        .toBeCloseTo(1.35, 1)
  })

  it('gives the glow ring to tier 1 alone', () => {
    const glowing = (svg: string) => /r="11" fill="#fff"/.test(svg)
    expect(glowing(pinSvg(ev(), false, 1))).toBe(true)
    expect(glowing(pinSvg(ev(), false, 2))).toBe(false)
    expect(glowing(pinSvg(ev(), false, 3))).toBe(false)
  })

  it('keeps the glow inside the box, so it draws as a ring and not two arcs', () => {
    // the viewBox is 24 wide about cx=12: a glow wider than 12 would be clipped
    const svg = pinSvg(ev(), false, 1)
    for (const [, r, w] of svg.matchAll(/r="([\d.]+)"[^/]*stroke-width="([\d.]+)"/g))
      expect(Number(r) + Number(w) / 2).toBeLessThanOrEqual(12)
  })

  it('still puts the tip on the coordinate, whatever the tier', () => {
    // the artwork scales, the anchor is a percentage of the box, so it holds
    for (const t of tiers) {
      const svg = pinSvg(ev({ priority: 80 }), false, t)
      expect(attr(svg, 'viewBox')).toBe('0 0 24 32')
    }
  })

  it('shrinks and de-glows a cluster badge by its dominant member tier', () => {
    const members = [ev({ id: 'a' }), ev({ id: 'b' })]
    expect(clusterSize(2, 1)).toBeGreaterThan(clusterSize(2, 2))
    expect(clusterSize(2, 2)).toBeGreaterThan(clusterSize(2, 3))
    expect((clusterSvg(members, 1).match(/<circle/g) ?? []).length).toBe(4)
    expect((clusterSvg(members, 3).match(/<circle/g) ?? []).length).toBe(3)
  })

  it('rebuilds a pin when its tier changes, and only then', () => {
    const a = ev({ id: 'a' })
    const pin: PinDatum = { kind: 'event', id: 'a', lat: 0, lng: 0, event: a, fanned: false }
    expect(pinStateKey(pin, undefined, 1)).not.toBe(pinStateKey(pin, undefined, 2))
    expect(pinStateKey(pin, undefined, 2)).toBe(pinStateKey(pin, undefined, 2))
    const badge: PinDatum = { kind: 'cluster', id: 'c', lat: 0, lng: 0, members: [a] }
    expect(pinStateKey(badge, undefined, 1)).not.toBe(pinStateKey(badge, undefined, 3))
  })
})
