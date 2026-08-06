import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MODE,
  resolvePillKind,
  resolveStepChip,
  sagaOf,
  OUTLINE_WIDTH,
  REALISTIC_BACKGROUND,
  SCHEMATIC_BACKGROUND,
  SCHEMATIC_PALETTE,
  SITE_MARKER_DEG,
  pinGlyphFor,
  pinStateKey,
  resolveClusterSpec,
  resolveFocusInk,
  resolveGlobeStyle,
  resolvePinSpec,
  resolveSelectionInk,
  type GlobeSettings,
  type PinCtx,
  type RenderMode,
} from '../src/lib/present'
import {
  lifeMarkersFor,
  parseItem,
  type HistoricalEvent,
  type MapPin,
  type Person,
  type RawEvent,
} from '../src/lib/events'
import { DEFAULT_PALETTE } from '../src/lib/palette'
import type { PinDatum } from '../src/lib/eventClusters'
import { TAG_COLORS } from '../src/lib/tags'

/**
 * THE PRESENTATION SEAM (src/lib/present/).
 *
 * Two claims are worth a test file of their own, and they are the two the
 * design rests on:
 *
 *  1. every resolver is PURE — same domain value and same context, same spec,
 *     every time and in any order. That is what lets the renderers cache on a
 *     key rather than on a snapshot.
 *  2. the mode really is a seam — `schematic` diverges in the answers, and does
 *     so without any domain value differing by so much as a field.
 */

const MODES: RenderMode[] = ['realistic', 'schematic']

const ev = (o: Partial<RawEvent> = {}): HistoricalEvent =>
  parseItem({
    id: 'e', name: 'e', start: 0, lat: 0, lng: 0, priority: 50, tags: ['war'], summary: '', ...o,
  }) as HistoricalEvent

const einstein: Person = {
  id: 'einstein', kind: 'person', name: 'Albert Einstein', born: 1879, died: 1955,
  birthPlace: { lat: 48.4, lng: 9.99 },
  priority: 90, tags: ['science'], summary: '',
}

const ctx = (o: Partial<PinCtx> = {}): PinCtx => ({
  mode: 'realistic', selected: false, tier: 1, ...o,
})

describe('the resolvers are pure', () => {
  const pins: [string, MapPin][] = [
    ['a point event', ev()],
    ['an area event', ev({ area: [[0, 0], [1, 1], [2, 0]] })],
    ['a route event', ev({ paths: [[[0, 0], [10, 10]]] })],
    ['an event with a plan', ev({ drawing: { layers: [{ type: 'marker', pos: [0, 0] }] } })],
    ['a life marker', lifeMarkersFor(einstein)[0]],
    ['a saga', ev({ steps: [{ id: 'one', name: 'One', at: 0 }] })],
  ]

  for (const [what, pin] of pins)
    for (const mode of MODES)
      it(`gives ${what} the same pin spec every time in ${mode} mode`, () => {
        const c = ctx({ mode, selected: true, tier: 2, highlighted: true })
        expect(resolvePinSpec(pin, c)).toEqual(resolvePinSpec(pin, c))
      })

  it('gives the same selection ink every time, and does not mutate the event', () => {
    const e = ev({ area: [[0, 0], [1, 1], [2, 0]], paths: [[[0, 0], [5, 5]]] })
    const before = JSON.stringify(e)
    expect(resolveSelectionInk(e, { mode: 'realistic' })).toEqual(
      resolveSelectionInk(e, { mode: 'realistic' }),
    )
    expect(JSON.stringify(e)).toBe(before)
  })

  it('gives the same globe style every time', () => {
    const s: GlobeSettings = {
      clouds: true, cloudShadows: false, atmosphere: true, relief: true, detail: true,
      visuals: 'enhanced', palette: DEFAULT_PALETTE,
    }
    for (const mode of MODES) expect(resolveGlobeStyle(s, mode)).toEqual(resolveGlobeStyle(s, mode))
  })

  /** The palette is copied out, not aliased: a slider move must not reach a resolved style. */
  it('hands back a palette the caller cannot edit from under it', () => {
    const s: GlobeSettings = {
      clouds: true, cloudShadows: true, atmosphere: true, relief: true, detail: true,
      visuals: 'enhanced', palette: { ...DEFAULT_PALETTE },
    }
    const flat = resolveGlobeStyle(s, 'schematic')
    flat.palette.saturation = 99
    expect(resolveGlobeStyle(s, 'schematic').palette).toEqual(SCHEMATIC_PALETTE)
  })
})

describe('resolvePinSpec — the glyph is a statement about the model', () => {
  it('reads the shape of the thing, not the shape of the artwork', () => {
    expect(pinGlyphFor(ev())).toBe('dot')
    expect(pinGlyphFor(ev({ area: [[0, 0], [1, 1], [2, 0]] }))).toBe('area')
    expect(pinGlyphFor(ev({ paths: [[[0, 0], [1, 1]]] }))).toBe('route')
    expect(pinGlyphFor(lifeMarkersFor(einstein)[0])).toBe('life')
  })

  /**
   * A route beats a footprint in the head: the routes are what the reader is
   * being invited to open, and the region is still said by the ellipse the pin
   * stands in — which is why `footprint` stays true either way.
   */
  it('lets a route win the head from a footprint, and keeps the footprint', () => {
    const both = resolvePinSpec(ev({ area: [[0, 0], [1, 1], [2, 0]], paths: [[[0, 0], [1, 1]]] }), ctx())
    expect(both.glyph).toBe('route')
    expect(both.footprint).toBe(true)
  })

  it('takes its colour from the primary tag', () => {
    expect(resolvePinSpec(ev({ tags: ['technology', 'war'] }), ctx()).body).toBe(TAG_COLORS.technology)
  })

  it('grows and haloes a selected pin, and rings a highlighted one', () => {
    const plain = resolvePinSpec(ev(), ctx())
    const chosen = resolvePinSpec(ev(), ctx({ selected: true }))
    expect(chosen.height).toBeGreaterThan(plain.height)
    expect(chosen.halo).not.toBeNull()
    expect(plain.halo).toBeNull()
    expect(plain.accent).toBeNull()
    // both at once, because they mean different things: "you opened this" and
    // "this step is about this"
    const both = resolvePinSpec(ev(), ctx({ selected: true, highlighted: true }))
    expect(both.halo).not.toBeNull()
    expect(both.accent).not.toBeNull()
    expect(both.accent).not.toBe(both.halo)
    expect(both.classes).toContain('event-pin--accent')
  })

  it('glows for tier 1 alone', () => {
    expect(resolvePinSpec(ev(), ctx({ tier: 1 })).glow).toBe(true)
    expect(resolvePinSpec(ev(), ctx({ tier: 2 })).glow).toBe(false)
  })
})

/**
 * SAGAHOOD IS RESOLVED, NOT SNIFFED FOR (lib/present/saga.ts).
 *
 * A saga is an event with steps and nothing else — no kind, no flag — so the
 * one thing worth testing is that every consumer asks the same question of the
 * same composition and gets the same answer.
 */
describe('sagaOf and its consumers', () => {
  const steps = [{ id: 'one', name: 'One', at: 0 }]

  it('is the steps, or nothing', () => {
    expect(sagaOf(ev({ steps }))).toHaveLength(1)
    expect(sagaOf(ev())).toBeUndefined()
    expect(sagaOf(ev({ steps: [] }))).toBeUndefined() // absent is absent
    expect(sagaOf(einstein)).toBeUndefined()
    expect(sagaOf(lifeMarkersFor(einstein)[0])).toBeUndefined()
    expect(sagaOf(undefined)).toBeUndefined()
  })

  it('is what the pin ring and the pill chip both read', () => {
    expect(resolvePinSpec(ev({ steps }), ctx()).saga).toBe(true)
    expect(resolvePinSpec(ev(), ctx()).saga).toBe(false)
    expect(resolveClusterSpec([ev({ id: 'a' }), ev({ id: 'b', steps })], ctx()).saga).toBe(true)
    expect(resolveClusterSpec([ev({ id: 'a' })], ctx()).saga).toBe(false)
    expect(resolvePillKind(ev({ steps }))).toBe('Saga')
  })

  it('names the most specific true thing about everything else', () => {
    expect(resolvePillKind(ev({ drawing: { layers: [{ type: 'marker', pos: [0, 0] }] } }))).toBe('Plan')
    expect(resolvePillKind(ev({ paths: [[[0, 0], [1, 1]]] }))).toBe('Route')
    expect(resolvePillKind(ev())).toBe('Event')
    expect(resolvePillKind(einstein)).toBe('Person')
    // a saga outranks its own plan: the reading is the thing a pill cannot show
    expect(resolvePillKind(ev({ steps, drawing: { layers: [{ type: 'marker', pos: [0, 0] }] } })))
      .toBe('Saga')
  })

  it('tells a page chip from an entrance', () => {
    const page = { id: 'a', name: 'A', time: { kind: 'point' as const, year: 0 } }
    expect(resolveStepChip(page)).toEqual({ kind: 'page', step: page })
    const entrance = { ...page, child: 'd-day' }
    expect(resolveStepChip(entrance)).toEqual({ kind: 'entrance', step: entrance, child: 'd-day' })
  })
})

describe('map mode diverges — and only in the presentation', () => {
  it('drops the tier glow and hardens the outline, keeping the glyph and the size', () => {
    const e = ev({ area: [[0, 0], [1, 1], [2, 0]] })
    const real = resolvePinSpec(e, ctx({ mode: 'realistic' }))
    const flat = resolvePinSpec(e, ctx({ mode: 'schematic' }))
    // the model's half is identical…
    expect(flat.glyph).toBe(real.glyph)
    expect(flat.footprint).toBe(real.footprint)
    expect(flat.height).toBe(real.height)
    expect(flat.body).toBe(real.body)
    // …and the look's half is not
    expect(flat.glow).toBe(false)
    expect(real.glow).toBe(true)
    expect(flat.stroke).not.toBe(real.stroke)
    expect(flat.classes).toContain('event-pin--flat')
    expect(real.classes).not.toContain('event-pin--flat')
  })

  it('accents a badge that hides a child the step named', () => {
    const members = [ev({ id: 'kiev-pocket' }), ev({ id: 'other' })]
    expect(resolveClusterSpec(members, { mode: 'realistic', tier: 3 }).accent).toBeNull()
    const lifted = resolveClusterSpec(members, { mode: 'realistic', tier: 3, highlighted: true })
    expect(lifted.accent).not.toBeNull()
    expect(lifted.classes).toContain('event-pin--accent')
    // …and it is drawn, so it has to rebuild
    expect(pinStateKey({ kind: 'cluster', id: 'k', lat: 0, lng: 0, members }, undefined, 3, 'realistic', true))
      .not.toBe(pinStateKey({ kind: 'cluster', id: 'k', lat: 0, lng: 0, members }, undefined, 3, 'realistic', false))
  })

  it('quietens a cluster badge the same way', () => {
    const members = [ev({ id: 'a' }), ev({ id: 'b' })]
    expect(resolveClusterSpec(members, { mode: 'realistic', tier: 1 }).ring).toBe(true)
    expect(resolveClusterSpec(members, { mode: 'schematic', tier: 1 }).ring).toBe(false)
    // …but a badge still counts what it counts
    for (const mode of MODES)
      expect(resolveClusterSpec(members, { mode, tier: 1 }).count).toBe(2)
  })

  it('draws a thinner footprint outline', () => {
    const e = ev({ area: [[0, 0], [1, 1], [2, 0]] })
    const width = (mode: RenderMode) =>
      (resolveSelectionInk(e, { mode })!.layers[0] as { width: number }).width
    expect(width('schematic')).toBe(OUTLINE_WIDTH.schematic)
    expect(width('realistic')).toBe(OUTLINE_WIDTH.realistic)
    expect(width('schematic')).toBeLessThan(width('realistic'))
  })

  /** The whole of what map mode is: every atmospheric effect off, at once. */
  it('turns off everything that models a photographed planet', () => {
    const on: GlobeSettings = {
      clouds: true, cloudShadows: true, atmosphere: true, relief: true, detail: true,
      visuals: 'enhanced', palette: DEFAULT_PALETTE,
    }
    const flat = resolveGlobeStyle(on, 'schematic')
    expect([
      flat.clouds, flat.cloudShadows, flat.atmosphere,
      flat.stars, flat.celestial, flat.night, flat.imagery,
    ]).toEqual([false, false, false, false, false, false, false])
    // and less than the full enhanced lift, on an already fully lit globe
    expect(flat.boost).toBeLessThan(resolveGlobeStyle(on, 'realistic').boost)
    expect(flat.relief).toBe(0)
    expect(flat.flatLight).toBe(1) // no sun, so no terminator
    expect(flat.background).toBe(SCHEMATIC_BACKGROUND)
    expect(flat.palette).toEqual(SCHEMATIC_PALETTE)
  })

  /**
   * …and it ignores the knobs above it rather than being switched off by them:
   * the reader's settings are left exactly as they were, so switching back
   * restores what they had.
   */
  it('answers the same whatever the reader had switched on', () => {
    const all = (v: boolean): GlobeSettings => ({
      clouds: v, cloudShadows: v, atmosphere: v, relief: v, detail: v,
      visuals: v ? 'enhanced' : 'realistic', palette: DEFAULT_PALETTE,
    })
    expect(resolveGlobeStyle(all(true), 'schematic')).toEqual(resolveGlobeStyle(all(false), 'schematic'))
    // while the realistic style is exactly the settings, restated
    expect(resolveGlobeStyle(all(false), 'realistic')).toMatchObject({
      clouds: false, cloudShadows: false, atmosphere: false, relief: 0, imagery: false, boost: 0,
    })
    expect(resolveGlobeStyle(all(true), 'realistic')).toMatchObject({
      clouds: true, cloudShadows: true, atmosphere: true, relief: 1, imagery: true, boost: 1,
      stars: true, celestial: true, night: true, flatLight: null, background: REALISTIC_BACKGROUND,
    })
  })

  it('rebuilds a pin when the mode changes, and only then', () => {
    const a = ev({ id: 'a' })
    const pin: PinDatum = { kind: 'event', id: 'a', lat: 0, lng: 0, event: a, fanned: false }
    expect(pinStateKey(pin, undefined, 1, 'realistic')).not.toBe(
      pinStateKey(pin, undefined, 1, 'schematic'),
    )
    expect(pinStateKey(pin, undefined, 1, 'schematic')).toBe(
      pinStateKey(pin, undefined, 1, 'schematic'),
    )
    // …and when a step highlights it, since that is drawn too
    expect(pinStateKey(pin, undefined, 1, 'realistic', true)).not.toBe(
      pinStateKey(pin, undefined, 1, 'realistic', false),
    )
  })

  it('ships realistic by default — map mode is opt-in', () => {
    expect(DEFAULT_MODE).toBe('realistic')
  })
})

describe('resolveSelectionInk — what a glance puts on the ground', () => {
  it('is nothing at all for a bare point event', () => {
    expect(resolveSelectionInk(ev(), { mode: 'realistic' })).toBeUndefined()
  })

  it('draws the routes, in the direction the event says', () => {
    const e = ev({ paths: [[[0, 0], [10, 10]]], direction: 'twoway' })
    const layers = resolveSelectionInk(e, { mode: 'realistic' })!.layers
    expect(layers).toHaveLength(1)
    expect(layers[0]).toMatchObject({ type: 'route', direction: 'twoway' })
  })

  it('outlines a footprint, and steps aside for a battle plan', () => {
    const ring: [number, number][] = [[0, 0], [1, 1], [2, 0]]
    expect(resolveSelectionInk(ev({ area: ring }), { mode: 'realistic' })!.layers[0]).toMatchObject({
      type: 'frontline',
    })
    // the cap steps aside for a plan (see eventAreas in GlobeView), and an
    // outline around nothing is a line round a theatre nobody is being shown
    const withPlan = ev({ area: ring, drawing: { layers: [{ type: 'marker', pos: [0, 0] }] } })
    expect(resolveSelectionInk(withPlan, { mode: 'realistic' })).toBeUndefined()
  })

  /** The whole of what a `point` feature draws, and the reason it is in the model. */
  it('marks every secondary site the event names, and labels the named ones', () => {
    const e = ev({
      points: [
        { lat: 35.9, lng: -84.3, name: 'Oak Ridge' },
        { lat: 46.6, lng: -119.5 },
      ],
    })
    const layers = resolveSelectionInk(e, { mode: 'realistic' })!.layers
    expect(layers.map((l) => l.type)).toEqual(['marker', 'label', 'marker'])
    expect(layers[0]).toMatchObject({ style: 'dot', size: SITE_MARKER_DEG, pos: [-84.3, 35.9] })
    expect(layers[1]).toMatchObject({ text: 'Oak Ridge', pos: [-84.3, 35.9] })
  })

  it('draws routes, outline and sites together, in that order', () => {
    const e = ev({
      area: [[0, 0], [1, 1], [2, 0]],
      paths: [[[0, 0], [5, 5]]],
      points: [{ lat: 3, lng: 3 }],
    })
    expect(resolveSelectionInk(e, { mode: 'realistic' })!.layers.map((l) => l.type)).toEqual([
      'route', 'frontline', 'marker',
    ])
  })
})

describe('resolveFocusInk — the mode does not change what a step shows', () => {
  const e = ev({
    drawing: {
      layers: [
        { type: 'label', pos: [0, 0], text: 'timeless' },
        { type: 'label', pos: [1, 1], text: 'early', at: 0 },
        { type: 'label', pos: [2, 2], text: 'late', at: 0.9 },
      ],
    },
    steps: [
      { id: 'first', name: 'first', at: 0 },
      { id: 'second', name: 'second', at: 0.5 },
    ],
  })

  /**
   * Ink is a statement about the DATA, so both looks show the same layers. Map
   * mode differs in how a line is drawn, not in which lines exist — and this is
   * the assertion that keeps a future divergence honest about that.
   */
  it('resolves to the same layers in both modes', () => {
    for (const stepId of [undefined, 'first', 'second'])
      expect(resolveFocusInk(e, stepId, { mode: 'schematic' })).toEqual(
        resolveFocusInk(e, stepId, { mode: 'realistic' }),
      )
  })
})
