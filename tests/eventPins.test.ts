import { describe, it, expect } from 'vitest'
import { parseItem, type HistoricalEvent, type MapPin, type RawEvent } from '../src/lib/events'
import {
  clusterSvg as emitClusterSvg,
  pinAnchor,
  pinBox,
  pinShiftPercent,
  pinSvg as emitPinSvg,
} from '../src/lib/eventPins'
import {
  clusterSize,
  pinHeight,
  pinStateKey,
  pinTier,
  resolveClusterSpec,
  resolvePinSpec,
  GLYPH_R,
  SELECT_COLOR,
  glyphReach,
  pinTitle,
  TAG_GLYPHS,
  type GlyphArt,
} from '../src/lib/present/pin'
import type { RenderMode } from '../src/lib/present/mode'
import type { Tier } from '../src/lib/eventTiers'
import type { PinDatum } from '../src/lib/eventClusters'
import type { GeoPath } from '../src/lib/paths'
import { TAG_COLORS } from '../src/lib/tags'

// raw in, parsed out — the only way an item is ever made (see parseItem)
const ev = (o: Partial<RawEvent> = {}): HistoricalEvent =>
  parseItem({
    id: 'e', name: 'e', start: 0, lat: 0, lng: 0, priority: 50, tags: ['war'], summary: '', ...o,
  }) as HistoricalEvent

/**
 * Resolve then emit, which is what the globe does (see lib/present/pin.ts).
 * Written as one helper so the assertions below stay about the ARTWORK; the
 * resolver's own answers are asserted separately, at the bottom.
 */
const pinSvg = (e: MapPin, selected: boolean, tier: Tier = 1, mode: RenderMode = 'realistic') =>
  emitPinSvg(resolvePinSpec(e, { mode, selected, tier }))
const clusterSvg = (members: MapPin[], tier: Tier = 1, mode: RenderMode = 'realistic') =>
  emitClusterSvg(resolveClusterSpec(members, { mode, tier }))

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

  it('gives a point event with no category glyph a plain dot and no footprint', () => {
    // politics is not in the glyph registry, and that is the default case: the
    // dot is what a pin has always been and what most of the corpus still is
    const svg = pinSvg(ev({ tags: ['politics'] }), false)
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

  it('marks the selection with a white outline', () => {
    expect(pinSvg(ev(), true)).toContain('#ffe27a')
    expect(pinSvg(ev(), false)).not.toContain('#ffe27a')
    expect(resolvePinSpec(ev(), { mode: 'realistic', selected: true, tier: 1 }).stroke).toBe('#fff')
  })
})

/* ------------------------------------------------------------ the selection */

/**
 * THE SELECTED PIN — round 58.
 *
 * The reported defect was geometric: the selection was a circle of radius 10.5
 * centred on the head, the head is a disc of radius 9, and the body carries on
 * downward for another twenty units — so the ring cleared the head and came
 * back down ACROSS THE TAIL. Every assertion here is a restatement of "no mark
 * the selection adds may be drawn over the artwork".
 */
describe('the selection mark', () => {
  const sel = (o: Partial<RawEvent> = {}, tier: Tier = 1, mode: RenderMode = 'realistic') =>
    pinSvg(ev(o), true, tier, mode)

  /** Everything drawn after the teardrop is drawn ON the pin. */
  const overArt = (svg: string) => svg.slice(svg.indexOf('stroke-width="1.5"'))

  it('lays no ring over the pin, at any size or in either mode', () => {
    for (const mode of ['realistic', 'schematic'] as const)
      for (const tier of [1, 2, 3] as Tier[])
        for (const shape of [{}, { tags: ['politics' as const] }, { area: [[0, 0], [1, 1], [2, 0]] }]) {
          const over = overArt(sel(shape, tier, mode))
          // the head's coloured disc is radius 9 inside a 1.5 outline; anything
          // drawn on the pin and wider than that leaves the head, and anything
          // that leaves the head comes back down across the tail
          for (const [, r] of over.matchAll(/<circle cx="12" cy="11" r="([\d.]+)"/g))
            expect(Number(r), `${mode}/${tier}`).toBeLessThanOrEqual(8.25)
          for (const [, rx] of over.matchAll(/<ellipse[^/]*rx="([\d.]+)"/g))
            expect(Number(rx), `${mode}/${tier}`).toBeLessThanOrEqual(8.25)
        }
  })

  /** …and the glow and the accent are behind it, which is why they may be wide. */
  it('keeps the tier glow and the step accent behind the body too', () => {
    const spec = resolvePinSpec(ev(), { mode: 'realistic', selected: false, tier: 1, highlighted: true })
    const svg = emitPinSvg(spec)
    const body = svg.indexOf('stroke-width="1.5"')
    expect(svg.indexOf('r="11"')).toBeLessThan(body) // the glow
    expect(svg.indexOf('r="11.2"')).toBeLessThan(body) // the accent
  })

  it('is a rim on the pin’s own outline and a ring on the ground under the tip', () => {
    const svg = sel()
    expect(svg).toContain('class="pin-rim"')
    expect(svg).toContain('class="pin-base"')
    // the rim is the TEARDROP, scaled — not a new shape to learn
    expect(svg.match(/<path d="M12 31C/g)).toHaveLength(2)
    // …and the ground ring is centred on the tip, which is what "this spot" means
    expect(svg).toMatch(/<ellipse cx="12" cy="31"/)
  })

  it('draws both BEHIND the body, which is what keeps them off the artwork', () => {
    const svg = sel({ tags: ['politics'] })
    const body = svg.indexOf('stroke-width="1.5"') // the teardrop's own outline
    expect(svg.indexOf('pin-base')).toBeLessThan(body)
    expect(svg.indexOf('pin-rim')).toBeLessThan(body)
    // …and the head's own dot is drawn after it, so nothing is laid over that
    expect(body).toBeLessThan(svg.indexOf('r="3.6"'))
  })

  it('lets an area pin’s own footprint be its ground ring, in the selection’s tone', () => {
    const svg = pinSvg(ev({ area: [[0, 0], [1, 1], [2, 0]] }), true)
    expect(svg).toContain('pin-footprint')
    expect(svg).not.toContain('pin-base') // no second ellipse stacked on it
    expect(svg).toMatch(/stroke="#ffe27a" stroke-width="2.2" stroke-dasharray/)
    // …and an unselected one keeps the white dashes it always had
    expect(pinSvg(ev({ area: [[0, 0], [1, 1], [2, 0]] }), false)).toMatch(
      /stroke="#fff" stroke-width="2.2" stroke-dasharray/,
    )
  })

  it('gives the box the room the marks need, and only when they are drawn', () => {
    // the rim's crown goes above the teardrop and the ground ring below the tip
    expect(attr(pinSvg(ev(), false), 'viewBox')).toBe('0 0 24 32')
    expect(attr(pinSvg(ev(), true), 'viewBox')).toBe('0 -2 24 38')
    expect(attr(pinSvg(ev({ area: [[0, 0]] }), true), 'viewBox')).toBe('0 -2 24 42')
    // …and everything the selection draws is INSIDE it
    const box = pinBox(resolvePinSpec(ev(), { mode: 'realistic', selected: true, tier: 1 }))
    expect(box.y).toBeLessThanOrEqual(-0.9) // the rim's crown, scaled about (12,20)
    expect(box.y + box.h).toBeGreaterThanOrEqual(35.3) // the ground ring's lower edge
  })

  it('still stands the pin’s tip on the coordinate, whatever box it drew in', () => {
    /*
     * CSS2DRenderer centres the element on the coordinate and `--pin-shift`
     * moves it up by a percentage of its own height. The claim is that after
     * that move the TIP is on the coordinate — for every box this file can
     * emit, including the two the selection introduced. Measured the way the
     * browser does it: in element pixels.
     */
    const offset = (e: MapPin, selected: boolean) => {
      const spec = resolvePinSpec(e, { mode: 'realistic', selected, tier: 1 })
      const box = pinBox(spec)
      const px = (spec.height * box.h) / 32 // the element's own height
      const tipFromTop = (pinAnchor(box) / box.h) * px
      return tipFromTop - px / 2 + (pinShiftPercent(box.h, pinAnchor(box)) / 100) * px
    }
    for (const e of [ev(), ev({ area: [[0, 0], [1, 1], [2, 0]] })])
      for (const selected of [false, true]) expect(offset(e, selected)).toBeCloseTo(0, 9)
  })

  it('is the same treatment on paper, in the map’s own ink', () => {
    const svg = sel({}, 1, 'schematic')
    expect(svg).toContain('class="pin-rim"')
    expect(svg).toContain('class="pin-base"')
    expect(svg).toContain(SELECT_COLOR.schematic)
    expect(svg).not.toContain(SELECT_COLOR.realistic)
  })

  it('leaves the saga ring alone: one is inside the head, the other outside it', () => {
    const svg = pinSvg(ev({ steps: [{ id: 'one', name: 'One', at: 0 }] }), true)
    expect(svg).toMatch(/r="7.1" fill="none"/)
    expect(svg).toContain('class="pin-rim"')
  })

  it('rings a badge that holds the open event, clear of every ring it already has', () => {
    const members = [ev({ id: 'a' }), ev({ id: 'b' })]
    const on = emitClusterSvg(resolveClusterSpec(members, { mode: 'realistic', tier: 1, selected: true }))
    const off = emitClusterSvg(resolveClusterSpec(members, { mode: 'realistic', tier: 1 }))
    expect(on).toMatch(/r="21"[^/]*stroke="#ffe27a"/)
    expect(off).not.toContain('#ffe27a')
    // the box grew rather than the ring moving in on the tier ring at 19
    expect(attr(off, 'viewBox')).toBe('0 0 40 40')
    expect(attr(on, 'viewBox')).toBe('-3 -3 46 46')
    expect(Number(attr(on, 'width'))).toBeGreaterThan(Number(attr(off, 'width')))
  })

  /**
   * A pin can be selected and step-highlighted at once, and both are outside
   * the silhouette now — so the accent is behind the body too, and the order
   * between them is what stops the rim swallowing it.
   */
  it('keeps a step accent readable outside the selection’s rim', () => {
    const spec = resolvePinSpec(ev(), { mode: 'realistic', selected: true, tier: 1, highlighted: true })
    const svg = emitPinSvg(spec)
    expect(svg).toContain(spec.accent!)
    expect(svg.indexOf(spec.accent!)).toBeLessThan(svg.indexOf('pin-rim'))
    // the accent's radius clears the rim: the head is 9 and the rim scales it
    // by SELECT_RIM_SCALE about (12,20), which puts its edge at ~10.4
    expect(11.2).toBeGreaterThan(9 * 1.16)
  })
})

/* -------------------------------------------- category glyphs and the saga */

describe('category glyphs', () => {
  const dot = '<circle cx="12" cy="11" r="3.6"'

  /**
   * The one distinctive piece of what a part is drawn as. The registry holds
   * geometry now (see `GlyphPart`), so this is the assertion's own reading of
   * it — deliberately not a call into `markSvg`, which is the thing under test.
   */
  const drawnAs = (art: GlyphArt) =>
    art.map((p) =>
      p.kind === 'stroke'
        ? `M${p.from[0]} ${p.from[1]}L${p.to[0]} ${p.to[1]}`
        : `cx="${p.at[0]}" cy="${p.at[1]}" rx="${p.rx}"`,
    )

  it('puts the registry mark in the head instead of the dot', () => {
    for (const tag of ['war', 'economy'] as const) {
      const svg = pinSvg(ev({ tags: [tag] }), false)
      expect(svg, tag).not.toContain(dot)
      for (const part of drawnAs(TAG_GLYPHS[tag]!)) expect(svg, tag).toContain(part)
    }
  })

  it('leaves every other category exactly as it was', () => {
    for (const tag of ['politics', 'science', 'culture', 'religion', 'exploration'] as const)
      expect(pinSvg(ev({ tags: [tag] }), false), tag).toContain(dot)
  })

  it('reads the PRIMARY tag, the one that already picks the colour', () => {
    const svg = pinSvg(ev({ tags: ['politics', 'war'] }), false)
    expect(svg).toContain(dot)
    expect(svg).toContain(TAG_COLORS.politics)
  })

  it('leaves a structural glyph alone: a route keeps its route, an area its brackets', () => {
    // the composite (a category mark over the route motif) was drawn and looked
    // at, and two marks do not fit in seven pixels — see resolvePinSpec
    const route = pinSvg(ev({ tags: ['economy'], paths: [[[0, 0], [1, 1]]] }), false)
    for (const part of drawnAs(TAG_GLYPHS.economy!)) expect(route).not.toContain(part)
    const area = pinSvg(ev({ tags: ['war'], area: [[0, 0], [1, 1], [2, 0]] }), false)
    for (const part of drawnAs(TAG_GLYPHS.war!)) expect(area).not.toContain(part)
  })

  /**
   * THE REPORTED FAULT, as a number.
   *
   * The swords were drawn out to 6.4 box units and the saga ring's inner edge is
   * at 6.6, so on a saga's own pin the mark ran into its ring and, at 1x, into
   * the rim behind it: "the crossed swords icon is a bit too large inside the
   * pin so you only see parts of the swords". The budget below is what the
   * registry is authored to now, and this is the check that it stays true of
   * whatever is added to it next.
   */
  describe('the glyph budget', () => {
    /** The head's coloured disc, inside its 1.5-wide outline. */
    const HEAD_R = 9 - 0.75
    /** The saga ring (lib/eventPins.ts) sits at 7.1 and is 1 unit wide. */
    const RING_INNER = 7.1 - 0.5

    it('leaves clear room inside the head, and inside the saga ring', () => {
      expect(GLYPH_R).toBeLessThan(RING_INNER - 0.5)
      expect(GLYPH_R).toBeLessThan(HEAD_R - 2)
    })

    it('holds for every mark in the registry', () => {
      for (const [tag, art] of Object.entries(TAG_GLYPHS))
        expect(glyphReach(art!), tag).toBeLessThanOrEqual(GLYPH_R)
    })

    it('measures a stroke by its far end plus its round cap', () => {
      // a blade from the centre straight out to (12, 5), 2 units wide
      expect(glyphReach([{ kind: 'stroke', from: [12, 11], to: [12, 5], width: 2 }])).toBeCloseTo(7)
      // …and an ellipse by its own boundary, wherever it is centred
      expect(glyphReach([{ kind: 'ellipse', at: [12, 11], rx: 3, ry: 1 }])).toBeCloseTo(3, 1)
      // and an offset one by its true far corner, not by centre + ry: a wide
      // coin sitting below the middle reaches further sideways than downward
      expect(glyphReach([{ kind: 'ellipse', at: [12, 14], rx: 3, ry: 1, width: 2 }])).toBeCloseTo(5.37, 1)
    })

    it('is a real shrink on the swords, which is what the reader saw', () => {
      // the shipped mark is smaller than the one that collided with the ring
      expect(glyphReach(TAG_GLYPHS.war!)).toBeLessThan(6.4)
    })
  })
})

describe('a pin’s hover', () => {
  it('says a saga is one, and how many steps are behind it', () => {
    expect(pinTitle(ev({ name: 'World War II' }))).toBe('World War II')
    expect(pinTitle(ev({ name: 'World War II', steps: [{ id: 'a', name: 'A', at: 0 }] })))
      .toBe('World War II\nSaga · 1 steps')
  })
})

describe('the saga ring', () => {
  const steps = [{ id: 'one', name: 'One', at: 0 }]
  const RING = /r="7.1" fill="none"/

  it('rings a stepped event and nothing else', () => {
    expect(pinSvg(ev({ steps }), false)).toMatch(RING)
    expect(pinSvg(ev(), false)).not.toMatch(RING)
  })

  it('survives selection, tier, both modes and every shape of pin', () => {
    for (const mode of ['realistic', 'schematic'] as const)
      for (const tier of [1, 2, 3] as Tier[])
        for (const selected of [true, false])
          for (const shape of [{}, { area: [[0, 0], [1, 1], [2, 0]] }, { paths: [[[0, 0], [1, 1]]] }])
            expect(pinSvg(ev({ steps, ...shape }), selected, tier, mode), `${mode}/${tier}`)
              .toMatch(RING)
  })

  it('shows on a badge when any member is a saga, and not otherwise', () => {
    const plain = ev({ id: 'p' })
    expect(clusterSvg([plain, ev({ id: 's', steps })])).toMatch(/r="15.8"/)
    expect(clusterSvg([plain, ev({ id: 'q' })])).not.toMatch(/r="15.8"/)
  })

  it('rebuilds the pin if an event gains steps under the reader — a chunk merge', () => {
    const before: PinDatum = {
      kind: 'event', id: 'a', lat: 0, lng: 0, fanned: false, event: ev({ id: 'a' }),
    }
    const after: PinDatum = { ...before, event: ev({ id: 'a', steps }) }
    expect(pinStateKey(before)).not.toBe(pinStateKey(after))
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

describe('pinTier', () => {
  const a = ev({ id: 'a' })
  const b = ev({ id: 'b' })
  const c = ev({ id: 'c' })
  const pin = (e: HistoricalEvent): PinDatum => ({
    kind: 'event', id: e.id, lat: 0, lng: 0, event: e, fanned: false,
  })
  const badge = (members: HistoricalEvent[]): PinDatum => ({
    kind: 'cluster', id: 'k', lat: 0, lng: 0, members,
  })
  const map = (o: Record<string, 1 | 2 | 3>) => new Map<string, 1 | 2 | 3>(Object.entries(o))

  it('gives a lone pin its own tier', () => {
    expect(pinTier(pin(a), map({ a: 2 }))).toBe(2)
  })

  it('gives a badge its most significant member, not its first or its last', () => {
    expect(pinTier(badge([c, a, b]), map({ a: 1, b: 3, c: 2 }))).toBe(1)
    expect(pinTier(badge([a, b, c]), map({ a: 3, b: 2, c: 3 }))).toBe(2)
  })

  it('falls back to the least significant tier for anything off the map', () => {
    // not in the result set, so it cannot be leading it
    expect(pinTier(pin(a), map({}))).toBe(3)
    expect(pinTier(badge([a, b]), map({ b: 2 }))).toBe(2)
    expect(pinTier(badge([a, b]), map({}))).toBe(3)
  })
})

/* ------------------------------------------------------ significance tiers */

import { TIER_SCALE } from '../src/lib/present/pin'

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
