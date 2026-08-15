import { describe, it, expect } from 'vitest'
import {
  AT_FRACTION_MAX,
  atFraction,
  atYear,
  isFractionAt,
  isRawStep,
  layerInStep,
  markupProblems,
  orderedSteps,
  parseStep,
  parseSteps,
  stepAt,
  stepPageLinkIds,
  stepProblems,
  stepTimeYears,
  stepWindows,
  type RawStep,
  type Step,
} from '../src/lib/steps'
import { resolveFocusInk } from '../src/lib/present/ink'
import { pointTime, timeFrom, type Time } from '../src/lib/time'
import { parseItem, type HistoricalEvent, type RawEvent } from '../src/lib/events'
import type { Drawing, DrawingSpec } from '../src/lib/drawing'

/** Five steps across a single-year event, authored as fractions (the exemplars' form). */
const raw: RawStep[] = [
  { id: 'june', name: 'The border battles', at: 0 },
  { id: 'smolensk', name: 'Smolensk', at: 0.2 },
  { id: 'kiev', name: 'Kiev', at: 0.45 },
  { id: 'typhoon', name: 'Typhoon', at: 0.65 },
  { id: 'december', name: 'The counteroffensive', at: 0.9 },
]
const steps: Step[] = parseSteps(raw)

/** The span the exemplars run in: Barbarossa, a point at 1941. */
const y1941 = pointTime(1941)

const label = (text: string, at?: number): DrawingSpec => ({
  type: 'label',
  pos: [30, 50],
  text,
  ...(at === undefined ? {} : { at }),
})

/**
 * Focus ink needs a whole event, since a step's own drawing merges over the
 * parent's. This builds one through the parser, like everything else.
 */
const stepped = (o: Partial<RawEvent> = {}): HistoricalEvent =>
  parseItem({
    id: 'e', name: 'e', start: 1941, lat: 0, lng: 0, priority: 50, tags: [], summary: '',
    steps: raw,
    ...o,
  }) as HistoricalEvent

const inkFor = (e: HistoricalEvent, stepId?: string) =>
  resolveFocusInk(e, stepId, { mode: 'realistic' })

describe('a step is a time, and time is a variant', () => {
  it('reads a bare `at` as a moment', () => {
    expect(parseStep({ id: 'a', name: 'a', at: 0.3 }).time).toEqual(pointTime(0.3))
  })

  it('reads start/end as a stretch, and a start alone as a moment again', () => {
    expect(parseStep({ id: 'a', name: 'a', start: 0.2, end: 0.4 }).time).toEqual({
      kind: 'period',
      start: 0.2,
      end: 0.4,
    })
    expect(parseStep({ id: 'a', name: 'a', start: 0.2 }).time).toEqual(pointTime(0.2))
  })

  it('projects a step’s own time back onto the event’s years', () => {
    const span = timeFrom(1939, 1945)
    const point = parseStep({ id: 'a', name: 'a', at: 0.5 })
    const period = parseStep({ id: 'b', name: 'b', start: 0, end: 0.5 })
    expect(stepTimeYears(point, span)).toEqual(pointTime(1942))
    expect(stepTimeYears(period, span)).toEqual({ kind: 'period', start: 1939, end: 1942 })
  })
})

describe('at — the one field steps and drawing layers share', () => {
  it('reads 0..1 as a fraction and anything else as a year', () => {
    expect(isFractionAt(0)).toBe(true)
    expect(isFractionAt(AT_FRACTION_MAX)).toBe(true)
    expect(isFractionAt(1.0001)).toBe(false)
    expect(isFractionAt(1941)).toBe(false)
    expect(isFractionAt(-0.1)).toBe(false)
  })

  it('normalises a year against the span it is measured in', () => {
    expect(atFraction(1939, timeFrom(1939, 1945))).toBe(0)
    expect(atFraction(1945, timeFrom(1939, 1945))).toBe(1)
    expect(atFraction(1942, timeFrom(1938, 1946))).toBeCloseTo(0.5, 6)
    // a fraction is already the answer, whatever the span
    expect(atFraction(0.3, timeFrom(1939, 1945))).toBe(0.3)
    expect(atFraction(0.3, timeFrom(-4_000_000_000, 2000))).toBe(0.3)
  })

  it('clamps a year outside the span rather than running off either end', () => {
    expect(atFraction(1900, timeFrom(1939, 1945))).toBe(0)
    expect(atFraction(2000, timeFrom(1939, 1945))).toBe(1)
  })

  /**
   * The case both exemplars are in, and the reason everything is compared in
   * fraction space: Barbarossa is a point at 1941, so *every* year-form value on
   * it collapses onto one number and could not separate June from December.
   * Fractions still order.
   */
  it('collapses a zero-span event in year form, which is why the exemplars use fractions', () => {
    expect(atFraction(1941, y1941)).toBe(0)
    expect(atFraction(1941, timeFrom(1941, 1941))).toBe(0)
    expect(atFraction(0.95, y1941)).toBe(0.95)
  })

  it('resolves back to the year the cursor is moved to', () => {
    expect(atYear(0.5, timeFrom(1939, 1945))).toBe(1942)
    expect(atYear(1943, timeFrom(1939, 1945))).toBe(1943)
    // inside a single year every step is that year, which is what a timeline
    // whose unit is the year can honestly say
    expect(atYear(0.9, y1941)).toBe(1941)
  })
})

describe('step order and windows', () => {
  it('sorts by time, whatever order they were authored in', () => {
    const jumbled = [steps[3], steps[0], steps[4], steps[1], steps[2]]
    expect(orderedSteps(jumbled, y1941).map((s) => s.id)).toEqual([
      'june', 'smolensk', 'kiev', 'typhoon', 'december',
    ])
  })

  it('keeps authored order for steps at the same moment', () => {
    const tied = parseSteps([
      { id: 'a', name: 'a', at: 0.5 },
      { id: 'b', name: 'b', at: 0.5 },
    ])
    expect(orderedSteps(tied, y1941).map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('mixes year-form and fraction-form steps into one order', () => {
    const mixed = parseSteps([
      { id: 'late', name: 'late', at: 1944 },
      { id: 'early', name: 'early', at: 0.1 },
    ])
    expect(orderedSteps(mixed, timeFrom(1939, 1945)).map((s) => s.id)).toEqual(['early', 'late'])
  })

  it('orders a period step by where it STARTS', () => {
    const mixed = parseSteps([
      { id: 'long', name: 'long', start: 0.1, end: 0.9 },
      { id: 'later', name: 'later', at: 0.5 },
    ])
    expect(orderedSteps(mixed, y1941).map((s) => s.id)).toEqual(['long', 'later'])
  })

  it('opens the first window at -infinity and closes the last at +infinity', () => {
    const w = stepWindows(steps, y1941)
    expect(w[0].from).toBe(-Infinity)
    expect(w[w.length - 1].to).toBe(Infinity)
    // and every window is half-open, butting against the next
    for (let i = 1; i < w.length; i++) expect(w[i].from).toBe(w[i - 1].to)
  })

  /**
   * The windows tile by START even when a step is a stretch — the partition has
   * to be exact, and a period's own end would either leave a gap or overlap the
   * next step. What the period is for is the step's own label and validation.
   */
  it('tiles by start, so a period step still owns one window and no layer falls between', () => {
    const mixed = parseSteps([
      { id: 'a', name: 'a', at: 0 },
      { id: 'b', name: 'b', start: 0.2, end: 0.4 },
      { id: 'c', name: 'c', at: 0.6 },
    ])
    const w = stepWindows(mixed, y1941)
    expect(w.map((x) => [x.step.id, x.from, x.to])).toEqual([
      ['a', -Infinity, 0.2],
      ['b', 0.2, 0.6],
      ['c', 0.6, Infinity],
    ])
    // the gap between b's own end (0.4) and c's start belongs to b, not to nothing
    expect(stepAt(mixed, 0.5, y1941)?.id).toBe('b')
  })

  it('puts a moment in the step it belongs to, boundaries included', () => {
    const at = (v: number) => stepAt(steps, v, y1941)?.id
    expect(at(0)).toBe('june')
    expect(at(0.19)).toBe('june')
    expect(at(0.2)).toBe('smolensk') // a step owns its own moment
    expect(at(0.5)).toBe('kiev')
    expect(at(0.7)).toBe('typhoon')
    expect(at(0.95)).toBe('december')
  })

  /**
   * The open ends are what keep a layer from falling between the authored
   * moments and vanishing from every step while still being on the overview —
   * which reads as a rendering fault, not as a statement.
   */
  it('never leaves a moment homeless, before the first step or after the last', () => {
    expect(stepAt(steps, -50, y1941)?.id).toBe('june')
    expect(stepAt(steps, 5000, y1941)?.id).toBe('december')
  })

  it('has no step at all when there are none', () => {
    expect(stepAt([], 0.5, y1941)).toBeUndefined()
    expect(stepWindows([], y1941)).toEqual([])
  })
})

describe('resolving a drawing to one step', () => {
  const drawing: Drawing = {
    layers: [
      label('June front', 0),
      label('Army Group Centre'), // timeless: no `at`
      label('Kiev pocket', 0.5),
      label('December front', 0.95),
    ],
  }
  const event = stepped({ drawing })
  const texts = (d: Drawing | undefined) =>
    (d?.layers ?? []).map((l) => (l as { text: string }).text)

  it('is the whole drawing on the overview, and the very same object', () => {
    expect(inkFor(event)).toBe(drawing)
  })

  it('is the whole drawing for an event with no steps', () => {
    expect(inkFor(stepped({ drawing, steps: undefined }), 'kiev')).toBe(drawing)
  })

  it('keeps the step’s own layers and drops the other steps’', () => {
    expect(texts(inkFor(event, 'kiev'))).toEqual(['Army Group Centre', 'Kiev pocket'])
  })

  /**
   * The half of the rule that carries the design: an untagged layer is TIMELESS
   * and true of the whole event, so the army-group axes stay on the map while
   * the fronts and pockets come and go. It is also what makes every drawing
   * authored before steps existed render identically in every step.
   */
  it('shows a layer with no at in every step', () => {
    for (const s of steps) expect(texts(inkFor(event, s.id))).toContain('Army Group Centre')
  })

  it('answers per layer as well, for one-off questions', () => {
    expect(layerInStep(label('x', 0.5), 'kiev', steps, y1941)).toBe(true)
    expect(layerInStep(label('x', 0.5), 'june', steps, y1941)).toBe(false)
    expect(layerInStep(label('x'), 'june', steps, y1941)).toBe(true)
  })

  /* --- at: 'overview' — the saga's own summary map (round 64) ------------- */

  const over = (text: string): DrawingSpec => ({
    type: 'label',
    pos: [30, 50],
    text,
    at: 'overview',
  })

  it('hides an overview-only layer in EVERY step', () => {
    const withOver = stepped({ drawing: { layers: [...drawing.layers, over('The whole war')] } })
    for (const s of steps)
      expect(texts(inkFor(withOver, s.id)), s.id).not.toContain('The whole war')
    // …while the timeless and the step's own dated layers are untouched by it
    expect(texts(inkFor(withOver, 'kiev'))).toEqual(['Army Group Centre', 'Kiev pocket'])
  })

  it('shows it on the overview, which stays the whole drawing and the same object', () => {
    const layers = [...drawing.layers, over('The whole war')]
    const d: Drawing = { layers }
    const withOver = stepped({ drawing: d })
    expect(inkFor(withOver)).toBe(withOver.drawing) // rule 1, identity preserved
    expect(texts(inkFor(withOver))).toContain('The whole war')
  })

  it('answers per layer too: overview-only is in no step', () => {
    for (const s of steps) expect(layerInStep(over('x'), s.id, steps, y1941)).toBe(false)
  })

  it('leaves a step empty rather than timeless when only overview ink remains', () => {
    const only = stepped({ drawing: { layers: [over('The whole war')] } })
    expect(inkFor(only, 'kiev'), 'an overview marker crowd leaked into a step').toBeUndefined()
    expect(texts(inkFor(only))).toEqual(['The whole war'])
  })

  it('degenerates to timeless on an event with no steps (and the build forbids it there)', () => {
    // resolveFocusInk returns the drawing whole for a stepless event whatever
    // the layers say — the honest statement of the code as it stands. The
    // build script rejects at:'overview' on a stepless event, so the corpus
    // can never rely on this; the assertion is here so a change to either half
    // is a decision rather than an accident.
    const d: Drawing = { layers: [over('x')] }
    expect(inkFor(stepped({ drawing: d, steps: undefined }), 'kiev')).toBe(d)
  })

  it('is undefined rather than an empty drawing when a step holds nothing', () => {
    const only = stepped({ drawing: { layers: [label('June front', 0)] } })
    expect(inkFor(only, 'kiev')).toBeUndefined()
  })

  it('is undefined for an event with no drawing at all', () => {
    expect(inkFor(stepped(), 'kiev')).toBeUndefined()
  })

  it('falls back to the overview for a step id the event does not declare', () => {
    expect(inkFor(event, 'not-a-step')).toBe(drawing)
  })

  it('partitions the layers: every dated one lands in exactly one step', () => {
    const dated = drawing.layers.filter((l) => l.at !== undefined).length
    const kept = steps
      .map((s) => inkFor(event, s.id)?.layers ?? [])
      .flat()
      .filter((l) => l.at !== undefined)
    expect(kept).toHaveLength(dated)
  })

  /* --- a step's OWN ink, which is the half a step could not do before ------ */

  it('merges a step’s own drawing over the layers its window kept', () => {
    const own = stepped({
      drawing,
      steps: raw.map((s) =>
        s.id === 'kiev' ? { ...s, drawing: { layers: [label('Encirclement complete')] } } : s,
      ),
    })
    expect(texts(inkFor(own, 'kiev'))).toEqual([
      'Army Group Centre',
      'Kiev pocket',
      'Encirclement complete', // last, so it draws over the plan rather than under it
    ])
    // …and only in its own step
    expect(texts(inkFor(own, 'june'))).not.toContain('Encirclement complete')
  })

  it('draws a step’s own ink even when the parent has no drawing at all', () => {
    const own = stepped({
      steps: raw.map((s) => (s.id === 'june' ? { ...s, drawing: { layers: [label('Dawn')] } } : s)),
    })
    expect(texts(inkFor(own, 'june'))).toEqual(['Dawn'])
    expect(inkFor(own, 'kiev')).toBeUndefined()
  })
})

describe('validation — the runtime twin of validate_steps', () => {
  const event = (steps?: RawStep[]) => ({ id: 'e', start: 1939, end: 1945, steps })

  it('accepts a well-formed set', () => {
    expect(stepProblems(event(raw))).toEqual([])
    expect(stepProblems(event())).toEqual([])
  })

  it('rejects an empty list — the field should be absent instead', () => {
    expect(stepProblems(event([]))).toHaveLength(1)
  })

  it('rejects a duplicate id within one event', () => {
    const dupes: RawStep[] = [
      { id: 'kiev', name: 'one', at: 0.1 },
      { id: 'kiev', name: 'two', at: 0.2 },
    ]
    expect(stepProblems(event(dupes)).join(' ')).toContain('duplicate step id')
  })

  it('rejects a year-form time outside the event’s own span', () => {
    expect(stepProblems(event([{ id: 'a', name: 'a', at: 1970 }])).join(' ')).toContain('outside')
    expect(stepProblems(event([{ id: 'a', name: 'a', at: 1942 }]))).toEqual([])
  })

  it('checks BOTH ends of a stretch against the span', () => {
    expect(
      stepProblems(event([{ id: 'a', name: 'a', start: 1940, end: 1970 }])).join(' '),
    ).toContain('outside')
    expect(stepProblems(event([{ id: 'a', name: 'a', start: 1940, end: 1944 }]))).toEqual([])
  })

  it('measures a year-form time against start alone when there is no end', () => {
    expect(stepProblems({ start: 1941, steps: [{ id: 'a', name: 'a', at: 1941 }] })).toEqual([])
    expect(stepProblems({ start: 1941, steps: [{ id: 'a', name: 'a', at: 1942 }] })).toHaveLength(1)
  })

  it('rejects a malformed id, name or time', () => {
    expect(isRawStep({ id: 'Kiev', name: 'k', at: 0 })).toBe(false) // not kebab
    expect(isRawStep({ id: 'kiev', name: '', at: 0 })).toBe(false)
    expect(isRawStep({ id: 'kiev', name: 'k', at: NaN })).toBe(false)
    expect(isRawStep({ id: 'kiev', name: 'k' })).toBe(false)
    expect(isRawStep({ id: 'kiev', name: 'k', at: 0 })).toBe(true)
  })

  /** One form or the other, never both: two answers to "when" is not a schema. */
  it('rejects a step that is both a moment and a stretch, or neither', () => {
    expect(isRawStep({ id: 'a', name: 'a', at: 0.2, start: 0.3 })).toBe(false)
    expect(isRawStep({ id: 'a', name: 'a', start: 0.3, end: 0.5 })).toBe(true)
    expect(isRawStep({ id: 'a', name: 'a', start: 0.5, end: 0.3 })).toBe(false) // backwards
  })

  it('rejects a camera that is off the planet, and accepts one without a height', () => {
    expect(isRawStep({ id: 'a', name: 'a', at: 0, camera: { lat: 91, lng: 0 } })).toBe(false)
    expect(isRawStep({ id: 'a', name: 'a', at: 0, camera: { lat: 0, lng: 200 } })).toBe(false)
    expect(isRawStep({ id: 'a', name: 'a', at: 0, camera: { lat: 0, lng: 0, altitude: 0 } })).toBe(
      false,
    )
    expect(isRawStep({ id: 'a', name: 'a', at: 0, camera: { lat: 50, lng: 30 } })).toBe(true)
  })

  it('rejects a step drawing the renderer could not draw', () => {
    expect(isRawStep({ id: 'a', name: 'a', at: 0, drawing: { layers: [] } })).toBe(false)
    expect(isRawStep({ id: 'a', name: 'a', at: 0, drawing: { layers: [{ type: 'nope' }] } })).toBe(
      false,
    )
    expect(isRawStep({ id: 'a', name: 'a', at: 0, drawing: { layers: [label('ok')] } })).toBe(true)
  })

  /** A highlight only ever pins and accents a CHILD; anything else is dead data. */
  it('rejects a highlight that is not a child of the event', () => {
    const s: RawStep[] = [{ id: 'a', name: 'a', at: 0, highlights: ['kiev-pocket'] }]
    expect(stepProblems(event(s), new Set(['kiev-pocket']))).toEqual([])
    expect(stepProblems(event(s), new Set(['minsk-pocket'])).join(' ')).toContain('not a child')
    // with no child list to check against, it is simply not checked
    expect(stepProblems(event(s))).toEqual([])
    expect(isRawStep({ id: 'a', name: 'a', at: 0, highlights: [] })).toBe(false)
  })

  it('rejects an entrance into nothing, or into its own event', () => {
    const into = (child: string): RawStep[] => [{ id: 'a', name: 'a', at: 0, child }]
    const corpus = new Set(['d-day', 'e'])
    expect(stepProblems(event(into('d-day')), undefined, corpus)).toEqual([])
    expect(stepProblems(event(into('nowhere')), undefined, corpus).join(' ')).toContain(
      'does not exist',
    )
    // a step into its own event is the one cycle a single event can hold, and
    // it is caught without knowing the corpus at all
    expect(stepProblems(event(into('e'))).join(' ')).toContain('its own event')
    // with no corpus to check against, an id is simply not resolved
    expect(stepProblems(event(into('nowhere')))).toEqual([])
    expect(isRawStep({ id: 'a', name: 'a', at: 0, child: '' })).toBe(false)
    expect(isRawStep({ id: 'a', name: 'a', at: 0, child: 'd-day' })).toBe(true)
  })

  it('lets an entrance omit the page, the ink and the camera', () => {
    // the child supplies all three; a step that carries nothing but an id, a
    // name and a time is a complete entrance (docs/design/sagas.md)
    expect(stepProblems(event([{ id: 'a', name: 'Normandy', at: 0.5, child: 'd-day' }]))).toEqual([])
  })

  /**
   * `renderRichText` cannot throw — anything it does not recognise falls through
   * as escaped prose — so the only useful definition of "valid markup" is that
   * every `](` in the text closes a link the renderer will actually turn into an
   * anchor. A page that fails this ships as visible bracket soup.
   */
  it('catches a page whose links the renderer would not render', () => {
    expect(markupProblems('plain prose, no links at all')).toEqual([])
    expect(markupProblems('see [Kiev](item:kiev-pocket) and [the BBC](https://bbc.co.uk)')).toEqual(
      [],
    )
    expect(markupProblems('see [Kiev](kiev-pocket)')).toHaveLength(1) // no scheme
    expect(markupProblems('see [Kiev](item:kiev pocket)')).toHaveLength(1) // space in the id
    const bad: RawStep[] = [{ id: 'a', name: 'a', at: 0, page: 'see [Kiev](nowhere)' }]
    expect(stepProblems(event(bad)).join(' ')).toContain('malformed link')
  })

  it('collects the internal links a set of pages points at', () => {
    const linked: RawStep[] = [
      { id: 'a', name: 'a', at: 0, page: 'see [Kiev](item:kiev-pocket)' },
      { id: 'b', name: 'b', at: 1, page: 'and [Minsk](event:minsk-pocket)' },
      { id: 'c', name: 'c', at: 0.5 },
    ]
    expect(stepPageLinkIds(linked)).toEqual(['kiev-pocket', 'minsk-pocket'])
  })
})

/** The span a step is measured against is the event's own `Time`, whatever kind it is. */
describe('a span that is itself a variant', () => {
  const cases: [string, Time][] = [
    ['a point', pointTime(1941)],
    ['a period', timeFrom(1939, 1945)],
  ]
  for (const [what, span] of cases)
    it(`orders and windows the same steps over ${what}`, () => {
      expect(orderedSteps(steps, span).map((s) => s.id)).toEqual([
        'june', 'smolensk', 'kiev', 'typhoon', 'december',
      ])
      expect(stepWindows(steps, span)).toHaveLength(5)
    })
})
