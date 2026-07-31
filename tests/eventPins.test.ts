import { describe, it, expect } from 'vitest'
import type { HistoricalEvent } from '../src/lib/events'
import {
  clusterSize,
  clusterSvg,
  pinHeight,
  pinShiftPercent,
  pinStateKey,
  pinSvg,
} from '../src/lib/eventPins'
import type { PinDatum } from '../src/lib/eventClusters'
import { TAG_COLORS } from '../src/lib/tags'

const ev = (o: Partial<HistoricalEvent> = {}): HistoricalEvent => ({
  id: 'e', name: 'e', start: 0, lat: 0, lng: 0, priority: 50, tags: ['war'], summary: '', ...o,
})

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
    const svg = clusterSvg([ev({ tags: ['science'] }), ev({ tags: ['war'] })])
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
