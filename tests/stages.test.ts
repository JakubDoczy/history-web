import { describe, it, expect } from 'vitest'
import {
  AT_FRACTION_MAX,
  atFraction,
  atYear,
  drawingForStage,
  isFractionAt,
  isStage,
  layerInStage,
  markupProblems,
  orderedStages,
  stageAt,
  stagePageLinkIds,
  stageProblems,
  stageWindows,
  type Stage,
} from '../src/lib/stages'
import type { Drawing, DrawingSpec } from '../src/lib/drawing'

/** Five stages across a single-year event, authored as fractions (the exemplars' form). */
const stages: Stage[] = [
  { id: 'june', name: 'The border battles', at: 0 },
  { id: 'smolensk', name: 'Smolensk', at: 0.2 },
  { id: 'kiev', name: 'Kiev', at: 0.45 },
  { id: 'typhoon', name: 'Typhoon', at: 0.65 },
  { id: 'december', name: 'The counteroffensive', at: 0.9 },
]

const label = (text: string, at?: number): DrawingSpec => ({
  type: 'label',
  pos: [30, 50],
  text,
  ...(at === undefined ? {} : { at }),
})

describe('at — the one field stages and drawing layers share', () => {
  it('reads 0..1 as a fraction and anything else as a year', () => {
    expect(isFractionAt(0)).toBe(true)
    expect(isFractionAt(AT_FRACTION_MAX)).toBe(true)
    expect(isFractionAt(1.0001)).toBe(false)
    expect(isFractionAt(1941)).toBe(false)
    expect(isFractionAt(-0.1)).toBe(false)
  })

  it('normalises a year against the span it is measured in', () => {
    expect(atFraction(1939, 1939, 1945)).toBe(0)
    expect(atFraction(1945, 1939, 1945)).toBe(1)
    expect(atFraction(1942, 1938, 1946)).toBeCloseTo(0.5, 6)
    // a fraction is already the answer, whatever the span
    expect(atFraction(0.3, 1939, 1945)).toBe(0.3)
    expect(atFraction(0.3, -4_000_000_000, 2000)).toBe(0.3)
  })

  it('clamps a year outside the span rather than running off either end', () => {
    expect(atFraction(1900, 1939, 1945)).toBe(0)
    expect(atFraction(2000, 1939, 1945)).toBe(1)
  })

  /**
   * The case both exemplars are in, and the reason everything is compared in
   * fraction space: Barbarossa is dated 1941 with no end, so *every* year-form
   * `at` on it collapses onto one value and could not separate June from
   * December. Fractions still order.
   */
  it('collapses a zero-span event in year form, which is why the exemplars use fractions', () => {
    expect(atFraction(1941, 1941)).toBe(0)
    expect(atFraction(1941, 1941, 1941)).toBe(0)
    expect(atFraction(0.95, 1941)).toBe(0.95)
  })

  it('resolves back to the year the cursor is moved to', () => {
    expect(atYear(0.5, 1939, 1945)).toBe(1942)
    expect(atYear(1943, 1939, 1945)).toBe(1943)
    // inside a single year every stage is that year, which is what a timeline
    // whose unit is the year can honestly say
    expect(atYear(0.9, 1941)).toBe(1941)
  })
})

describe('stage order and windows', () => {
  it('sorts by at, whatever order they were authored in', () => {
    const jumbled = [stages[3], stages[0], stages[4], stages[1], stages[2]]
    expect(orderedStages(jumbled, 1941).map((s) => s.id)).toEqual([
      'june', 'smolensk', 'kiev', 'typhoon', 'december',
    ])
  })

  it('keeps authored order for stages at the same moment', () => {
    const tied: Stage[] = [
      { id: 'a', name: 'a', at: 0.5 },
      { id: 'b', name: 'b', at: 0.5 },
    ]
    expect(orderedStages(tied, 1941).map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('mixes year-form and fraction-form stages into one order', () => {
    const mixed: Stage[] = [
      { id: 'late', name: 'late', at: 1944 },
      { id: 'early', name: 'early', at: 0.1 },
    ]
    expect(orderedStages(mixed, 1939, 1945).map((s) => s.id)).toEqual(['early', 'late'])
  })

  it('opens the first window at -infinity and closes the last at +infinity', () => {
    const w = stageWindows(stages, 1941)
    expect(w[0].from).toBe(-Infinity)
    expect(w[w.length - 1].to).toBe(Infinity)
    // and every window is half-open, butting against the next
    for (let i = 1; i < w.length; i++) expect(w[i].from).toBe(w[i - 1].to)
  })

  it('puts a moment in the stage it belongs to, boundaries included', () => {
    const at = (v: number) => stageAt(stages, v, 1941)?.id
    expect(at(0)).toBe('june')
    expect(at(0.19)).toBe('june')
    expect(at(0.2)).toBe('smolensk') // a stage owns its own moment
    expect(at(0.5)).toBe('kiev')
    expect(at(0.7)).toBe('typhoon')
    expect(at(0.95)).toBe('december')
  })

  /**
   * The open ends are what keep a layer from falling between the authored
   * moments and vanishing from every stage while still being on the overview —
   * which reads as a rendering fault, not as a statement.
   */
  it('never leaves a moment homeless, before the first stage or after the last', () => {
    expect(stageAt(stages, -50, 1941)?.id).toBe('june')
    expect(stageAt(stages, 5000, 1941)?.id).toBe('december')
  })

  it('has no stage at all when there are none', () => {
    expect(stageAt([], 0.5, 1941)).toBeUndefined()
    expect(stageWindows([], 1941)).toEqual([])
  })
})

describe('filtering a drawing to one stage', () => {
  const drawing: Drawing = {
    layers: [
      label('June front', 0),
      label('Army Group Centre'), // timeless: no `at`
      label('Kiev pocket', 0.5),
      label('December front', 0.95),
    ],
  }

  it('is the whole drawing on the overview, and the very same object', () => {
    expect(drawingForStage(drawing, undefined, stages, 1941)).toBe(drawing)
  })

  it('is the whole drawing for an event with no stages', () => {
    expect(drawingForStage(drawing, 'kiev', [], 1941)).toBe(drawing)
  })

  it('keeps the stage’s own layers and drops the other stages’', () => {
    const kiev = drawingForStage(drawing, 'kiev', stages, 1941)!
    expect(kiev.layers.map((l) => (l as { text: string }).text)).toEqual([
      'Army Group Centre',
      'Kiev pocket',
    ])
  })

  /**
   * The half of the rule that carries the design: an untagged layer is TIMELESS
   * and true of the whole event, so the army-group axes stay on the map while
   * the fronts and pockets come and go. It is also what makes every drawing
   * authored before stages existed render identically in every stage.
   */
  it('shows a layer with no at in every stage', () => {
    for (const s of stages) {
      const d = drawingForStage(drawing, s.id, stages, 1941)!
      expect(d.layers.map((l) => (l as { text: string }).text)).toContain('Army Group Centre')
    }
  })

  it('answers per layer as well, for one-off questions', () => {
    expect(layerInStage(label('x', 0.5), 'kiev', stages, 1941)).toBe(true)
    expect(layerInStage(label('x', 0.5), 'june', stages, 1941)).toBe(false)
    expect(layerInStage(label('x'), 'june', stages, 1941)).toBe(true)
  })

  it('is undefined rather than an empty drawing when a stage holds nothing', () => {
    const only: Drawing = { layers: [label('June front', 0)] }
    expect(drawingForStage(only, 'kiev', stages, 1941)).toBeUndefined()
  })

  it('is undefined for an event with no drawing at all', () => {
    expect(drawingForStage(undefined, 'kiev', stages, 1941)).toBeUndefined()
  })

  it('partitions the layers: every dated one lands in exactly one stage', () => {
    const dated = drawing.layers.filter((l) => l.at !== undefined).length
    const kept = stages
      .map((s) => drawingForStage(drawing, s.id, stages, 1941)?.layers ?? [])
      .flat()
      .filter((l) => l.at !== undefined)
    expect(kept).toHaveLength(dated)
  })
})

describe('validation — the runtime twin of validate_stages', () => {
  const event = (extra: Partial<{ stages: Stage[] }> = {}) => ({
    start: 1939,
    end: 1945,
    ...extra,
  })

  it('accepts a well-formed set', () => {
    expect(stageProblems(event({ stages }))).toEqual([])
    expect(stageProblems(event())).toEqual([])
  })

  it('rejects an empty list — the field should be absent instead', () => {
    expect(stageProblems(event({ stages: [] }))).toHaveLength(1)
  })

  it('rejects a duplicate id within one event', () => {
    const dupes: Stage[] = [
      { id: 'kiev', name: 'one', at: 0.1 },
      { id: 'kiev', name: 'two', at: 0.2 },
    ]
    expect(stageProblems(event({ stages: dupes })).join(' ')).toContain('duplicate stage id')
  })

  it('rejects a year-form at outside the event’s own span', () => {
    const out: Stage[] = [{ id: 'a', name: 'a', at: 1970 }]
    expect(stageProblems(event({ stages: out })).join(' ')).toContain('outside')
    const inside: Stage[] = [{ id: 'a', name: 'a', at: 1942 }]
    expect(stageProblems(event({ stages: inside }))).toEqual([])
  })

  it('measures a year-form at against start alone when there is no end', () => {
    expect(stageProblems({ start: 1941, stages: [{ id: 'a', name: 'a', at: 1941 }] })).toEqual([])
    expect(
      stageProblems({ start: 1941, stages: [{ id: 'a', name: 'a', at: 1942 }] }),
    ).toHaveLength(1)
  })

  it('rejects a malformed id, name or at', () => {
    expect(isStage({ id: 'Kiev', name: 'k', at: 0 })).toBe(false) // not kebab
    expect(isStage({ id: 'kiev', name: '', at: 0 })).toBe(false)
    expect(isStage({ id: 'kiev', name: 'k', at: NaN })).toBe(false)
    expect(isStage({ id: 'kiev', name: 'k' })).toBe(false)
    expect(isStage({ id: 'kiev', name: 'k', at: 0 })).toBe(true)
  })

  it('rejects a camera that is off the planet, and accepts one without a height', () => {
    expect(isStage({ id: 'a', name: 'a', at: 0, camera: { lat: 91, lng: 0 } })).toBe(false)
    expect(isStage({ id: 'a', name: 'a', at: 0, camera: { lat: 0, lng: 200 } })).toBe(false)
    expect(isStage({ id: 'a', name: 'a', at: 0, camera: { lat: 0, lng: 0, altitude: 0 } })).toBe(false)
    expect(isStage({ id: 'a', name: 'a', at: 0, camera: { lat: 50, lng: 30 } })).toBe(true)
  })

  /**
   * `renderRichText` cannot throw — anything it does not recognise falls through
   * as escaped prose — so the only useful definition of "valid markup" is that
   * every `](` in the text closes a link the renderer will actually turn into an
   * anchor. A page that fails this ships as visible bracket soup.
   */
  it('catches a page whose links the renderer would not render', () => {
    expect(markupProblems('plain prose, no links at all')).toEqual([])
    expect(markupProblems('see [Kiev](item:kiev-pocket) and [the BBC](https://bbc.co.uk)')).toEqual([])
    expect(markupProblems('see [Kiev](kiev-pocket)')).toHaveLength(1) // no scheme
    expect(markupProblems('see [Kiev](item:kiev pocket)')).toHaveLength(1) // space in the id
    const bad: Stage[] = [{ id: 'a', name: 'a', at: 0, page: 'see [Kiev](nowhere)' }]
    expect(stageProblems(event({ stages: bad })).join(' ')).toContain('malformed link')
  })

  it('collects the internal links a set of pages points at', () => {
    const linked: Stage[] = [
      { id: 'a', name: 'a', at: 0, page: 'see [Kiev](item:kiev-pocket)' },
      { id: 'b', name: 'b', at: 1, page: 'and [Minsk](event:minsk-pocket)' },
      { id: 'c', name: 'c', at: 0.5 },
    ]
    expect(stagePageLinkIds(linked)).toEqual(['kiev-pocket', 'minsk-pocket'])
  })
})
