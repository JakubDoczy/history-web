import { describe, it, expect } from 'vitest'
import { parseSteps, type RawStep, type Step } from '../src/lib/steps'
import { pointTime, timeFrom } from '../src/lib/time'
import {
  LANE_GAP_PX,
  MAX_LANES,
  MIN_LABEL_PX,
  MIN_STATION_PX,
  RAIL_PAD,
  axisTicks,
  backPressesTo,
  crumbs,
  formatAt,
  laneOf,
  labelWidth,
  layoutRail,
  railWidth,
  railX,
  stationTime,
  stations,
  stepBy,
} from '../src/lib/present/sagaTimeline'

/**
 * The corpus's own two shapes, because they are the two the layout has to
 * survive: World War II, eleven steps across six years with four of them piled
 * into the last 7%, and D-Day, four steps inside a span that is a single point.
 */
const ww2Raw: RawStep[] = [
  { id: 'battle-britain', name: 'Battle of Britain', at: 0.14, child: 'battle-britain' },
  { id: 'barbarossa', name: 'Operation Barbarossa', at: 0.28, child: 'barbarossa' },
  { id: 'pearl-harbor', name: 'Attack on Pearl Harbor', at: 0.37, child: 'pearl-harbor' },
  { id: 'holocaust', name: 'The Holocaust', start: 0.38, end: 0.95, child: 'holocaust' },
  { id: 'midway', name: 'Battle of Midway', at: 0.45, child: 'midway' },
  { id: 'stalingrad', name: 'Battle of Stalingrad', start: 0.48, end: 0.57, child: 'stalingrad' },
  { id: 'd-day', name: 'D-Day landings', at: 0.78, child: 'd-day' },
  { id: 've-day', name: 'Victory in Europe', at: 0.93, child: 've-day' },
  { id: 'trinity', name: 'Trinity nuclear test', at: 0.96, child: 'trinity' },
  { id: 'hiroshima', name: 'Atomic bombings', at: 0.97, child: 'hiroshima' },
  { id: 'vj-day', name: 'Victory over Japan', at: 1, child: 'vj-day' },
]
const ww2: Step[] = parseSteps(ww2Raw)
const ww2Span = timeFrom(1939, 1945)

const dday: Step[] = parseSteps([
  { id: 'six-june', name: '6 June', at: 0 },
  { id: 'beachhead', name: 'The beachhead', at: 0.3 },
  { id: 'cherbourg', name: 'Cherbourg', at: 0.6 },
  { id: 'breakout', name: 'The breakout', at: 0.85 },
])
const ddaySpan = pointTime(1944)

describe('stations', () => {
  it('reads the steps in time order, numbered, whatever order they were typed in', () => {
    const shuffled = [ww2[4], ww2[0], ww2[10], ...ww2.slice(1, 4), ...ww2.slice(5, 10)]
    const s = stations(shuffled, ww2Span)
    expect(s.map((x) => x.step.id)).toEqual(ww2.map((x) => x.id))
    expect(s.map((x) => x.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('tells a page from an entrance, which is what the chevron is drawn from', () => {
    expect(stations(ww2, ww2Span).every((s) => s.kind === 'entrance')).toBe(true)
    expect(stations(dday, ddaySpan).every((s) => s.kind === 'page')).toBe(true)
  })

  it('carries a period step’s own end, and a moment’s is its own start', () => {
    const by = new Map(stations(ww2, ww2Span).map((s) => [s.step.id, s]))
    expect(by.get('holocaust')!.u).toBeCloseTo(0.38)
    expect(by.get('holocaust')!.uEnd).toBeCloseTo(0.95)
    expect(by.get('midway')!.uEnd).toBe(by.get('midway')!.u)
  })

  /**
   * The reason the rail is drawn in fraction space at all: D-Day is dated 1944,
   * a point, so in year space all four steps are the same year and the timeline
   * would be one dot with four names on it.
   */
  it('spreads a saga whose span is a single year', () => {
    expect(stations(dday, ddaySpan).map((s) => s.u)).toEqual([0, 0.3, 0.6, 0.85])
  })
})

describe('the rail’s width', () => {
  it('is the element’s, until the stations could not be told apart at that size', () => {
    expect(railWidth(1200, 11)).toBe(1200)
    expect(railWidth(390, 11)).toBe(11 * MIN_STATION_PX) // a phone scrolls instead
  })

  it('leaves air at both ends, so the first and last station are not on the edge', () => {
    expect(railX(0, 1000)).toBeCloseTo(RAIL_PAD * 1000)
    expect(railX(1, 1000)).toBeCloseTo(1000 - RAIL_PAD * 1000)
    expect(railX(0.5, 1000)).toBeCloseTo(500)
  })
})

/**
 * THE DEFECT THIS ROUND FIXED, as a test.
 *
 * The first rail widened every station's window to a 44 px slab and clamped its
 * mark into it, which spaced eleven steps almost evenly and made a timeline that
 * said nothing about time. Nothing does that any more: a station is at `railX`
 * of its own moment and the only thing crowding may change is which lane it
 * hangs in.
 */
describe('placement is the truth about when', () => {
  it('puts every mark exactly on its own moment, at every width', () => {
    for (const width of [1600, 1200, 800, 484]) {
      const rail = layoutRail(stations(ww2, ww2Span), ww2Span, width)
      for (const s of rail.stations) expect(s.x, s.step.id).toBeCloseTo(railX(s.u, rail.width))
    }
  })

  it('keeps the war’s last four steps piled where they really are', () => {
    const rail = layoutRail(stations(ww2, ww2Span), ww2Span, 1200)
    const by = new Map(rail.stations.map((s) => [s.step.id, s]))
    // 1944.6 to 1945: under a tenth of the rail for four of the eleven steps —
    // which the slab layout used to spread over a quarter of it
    const pile = ['ve-day', 'trinity', 'hiroshima', 'vj-day'].map((id) => by.get(id)!.x)
    expect(pile[pile.length - 1] - pile[0]).toBeLessThan(0.1 * rail.width)
    expect(pile).toEqual([...pile].sort((a, b) => a - b))
  })

  it('bands a period from its own start to its own end, and a moment not at all', () => {
    const rail = layoutRail(stations(ww2, ww2Span), ww2Span, 1200)
    const by = new Map(rail.stations.map((s) => [s.step.id, s]))
    expect(by.get('midway')!.band).toBeUndefined()
    const band = by.get('holocaust')!.band!
    expect(band.x).toBeCloseTo(railX(0.38, 1200))
    expect(band.x + band.w).toBeCloseTo(railX(0.95, 1200))
  })

  it('is not knocked over by a saga with one step, or by a rail with no width', () => {
    const one = layoutRail(stations([ww2[0]], ww2Span), ww2Span, 1200)
    expect(one.stations[0].lane).toBe(0)
    expect(() => layoutRail(stations(ww2, ww2Span), ww2Span, 0)).not.toThrow()
    expect(layoutRail([], ww2Span, 1200).stations).toEqual([])
  })
})

describe('lanes — what crowding is allowed to change', () => {
  it('keeps a station on the axis while there is room beside it', () => {
    expect(laneOf([0, 100, 200, 300])).toEqual([0, 0, 0, 0])
  })

  it('drops the second of a colliding pair to the next lane, not sideways', () => {
    expect(laneOf([0, LANE_GAP_PX - 1, 200])).toEqual([0, 1, 0])
    expect(laneOf([0, LANE_GAP_PX, 200])).toEqual([0, 0, 0])
  })

  it('comes back to lane 0 as soon as lane 0 is clear again', () => {
    expect(laneOf([0, 5, 10, 400])).toEqual([0, 1, 2, 0])
  })

  it('never opens more lanes than the rail is tall enough for', () => {
    const lanes = laneOf([0, 1, 2, 3, 4, 5])
    expect(Math.max(...lanes)).toBeLessThan(MAX_LANES)
    // past the last lane the marks share one and overlap — an honest picture of
    // six moments in five pixels, and the list is how they are reached
    expect(lanes.length).toBe(6)
  })

  it('gives the war two lanes on a desktop and three on a phone’s scrolling rail', () => {
    expect(layoutRail(stations(ww2, ww2Span), ww2Span, 1200).lanes).toBe(2)
    expect(layoutRail(stations(ww2, ww2Span), ww2Span, 390).lanes).toBe(3)
    expect(layoutRail(stations(dday, ddaySpan), ddaySpan, 1200).lanes).toBe(1)
  })
})

describe('labels', () => {
  it('gives a label the room to the next mark IN ITS OWN LANE, or none at all', () => {
    const rail = layoutRail(stations(ww2, ww2Span), ww2Span, 1200)
    for (const s of rail.stations) {
      expect(s.labelPx === 0 || s.labelPx >= MIN_LABEL_PX, s.step.id).toBe(true)
      const next = rail.stations.find((o) => o.lane === s.lane && o.x > s.x)
      if (s.labelPx && next) expect(s.x + s.labelPx).toBeLessThanOrEqual(next.x)
    }
    // and the pile-up at the end of the war is where the names drop out
    expect(rail.stations.filter((s) => !s.labelPx).map((s) => s.step.id)).toContain('trinity')
  })

  it('names more than half of them at rest — the eleven-chip overflow, solved', () => {
    const rail = layoutRail(stations(ww2, ww2Span), ww2Span, 1200)
    expect(rail.stations.filter((s) => s.labelPx).length).toBeGreaterThan(5)
  })

  it('names every station of an uncrowded saga', () => {
    const rail = layoutRail(stations(dday, ddaySpan), ddaySpan, 1200)
    expect(rail.stations.every((s) => s.labelPx)).toBe(true)
  })

  it('hangs the last names the other way off their marks, so nothing runs off the rail', () => {
    const rail = layoutRail(stations(ww2, ww2Span), ww2Span, 1200)
    for (const s of rail.stations)
      expect(s.flip, s.step.id).toBe(s.x + labelWidth(s.step.name) > rail.width)
    expect(rail.stations[0].flip).toBe(false)
    expect(rail.stations[rail.stations.length - 1].flip).toBe(true)
  })
})

describe('the axis — a rule the reader can read the dates off', () => {
  it('rules a six-year war in years, inside its own span', () => {
    const axis = axisTicks(ww2Span, 1200)
    expect(axis.unit).toBe('year')
    expect(axis.ticks.map((t) => t.label)).toEqual(['1939', '1940', '1941', '1942', '1943', '1944', '1945'])
    for (const t of axis.ticks) expect(t.u).toBeGreaterThanOrEqual(0)
    for (const t of axis.ticks) expect(t.u).toBeLessThanOrEqual(1)
    expect(axis.ticks[0].u).toBe(0)
    expect(axis.ticks[axis.ticks.length - 1].u).toBe(1)
  })

  it('coarsens rather than crowding when the rail is narrow', () => {
    const wide = axisTicks(timeFrom(1000, 2000), 1200).ticks.length
    const narrow = axisTicks(timeFrom(1000, 2000), 300).ticks.length
    expect(narrow).toBeLessThan(wide)
    expect(narrow).toBeGreaterThanOrEqual(2)
  })

  it('rules a saga that ran one dated year in MONTHS', () => {
    const axis = axisTicks(timeFrom(1944, 1945), 1200)
    expect(axis.unit).toBe('month')
    expect(axis.ticks[0].label).toBe('Jan 1944')
    expect(axis.ticks.map((t) => t.label)).toContain('Jul')
    // January opens a year, and says so louder than the months between
    expect(axis.ticks.filter((t) => t.major).map((t) => t.label)).toEqual(['Jan 1944', 'Jan 1945'])
  })

  it('rules a fortnight in days', () => {
    const axis = axisTicks(timeFrom(1944.42, 1944.46), 900)
    expect(axis.unit).toBe('day')
    expect(axis.ticks.length).toBeGreaterThan(1)
    expect(axis.ticks.every((t) => /^\d+ [A-Z][a-z]{2}$/.test(t.label))).toBe(true)
  })

  it('rules deep time in the round numbers of its own size', () => {
    const axis = axisTicks(timeFrom(-12000, -9000), 1200)
    expect(axis.unit).toBe('year')
    expect(axis.ticks.length).toBeGreaterThan(2)
    expect(axis.ticks.length).toBeLessThan(16)
  })

  /**
   * A point-dated saga (Barbarossa: 1941) has no extent for a rule to divide,
   * and its steps are proportions of the campaign rather than dates. Ruling it
   * in months would invent a date for every one of them.
   */
  it('refuses to rule a saga dated to a single year, and says which year it is', () => {
    const axis = axisTicks(ddaySpan, 1200)
    expect(axis.unit).toBe('none')
    expect(axis.ticks).toEqual([{ u: 0, label: '1944', major: true }])
  })

  it('names a moment at the rule’s own resolution and no finer', () => {
    expect(formatAt(1944.5, 'year')).toBe('1945')
    expect(formatAt(1944.5, 'month')).toBe('Jul')
    expect(formatAt(1944.5, 'month', true)).toBe('Jul 1944')
    expect(formatAt(1944.0, 'month')).toBe('Jan 1944')
    expect(formatAt(1944.43, 'day', true)).toMatch(/^\d+ Jun 1944$/)
    // outside the calendar's reach the answer is the year, not a made-up month
    expect(formatAt(-250000, 'month')).toBe(formatAt(-250000, 'year'))
  })

  it('dates a station the same way, and says a one-year period once', () => {
    const [britain, holocaust, stalingrad] = ['battle-britain', 'holocaust', 'stalingrad'].map(
      (id) => stations(ww2, ww2Span).find((s) => s.step.id === id)!,
    )
    expect(stationTime(britain, ww2Span, 'year')).toBe('1940')
    expect(stationTime(holocaust, ww2Span, 'year')).toBe('1941 – 1945')
    expect(stationTime(stalingrad, ww2Span, 'year')).toBe('1942') // 1941.9–1942.4, one year
    expect(stationTime(britain, ww2Span, 'month')).toBe('Nov 1939')
  })

  it('is part of the rail’s own layout, measured over the width it is drawn at', () => {
    const rail = layoutRail(stations(ww2, ww2Span), ww2Span, 1200)
    expect(rail.axis.unit).toBe('year')
    expect(rail.axis.ticks.length).toBe(7)
  })
})

describe('prev / next — the other half of the dual system', () => {
  const ids = ww2.map((s) => s.id)

  it('walks [the overview, …the steps] one stop at a time', () => {
    expect(stepBy(ids, undefined, 1)).toEqual({ to: 'battle-britain' })
    expect(stepBy(ids, 'battle-britain', 1)).toEqual({ to: 'barbarossa' })
    expect(stepBy(ids, 'barbarossa', -1)).toEqual({ to: 'battle-britain' })
  })

  it('lands on the overview coming back off the first step', () => {
    expect(stepBy(ids, 'battle-britain', -1)).toEqual({ to: undefined })
  })

  it('stops at both ends rather than wrapping — a span is not a ring', () => {
    expect(stepBy(ids, undefined, -1)).toBeNull()
    expect(stepBy(ids, 'vj-day', 1)).toBeNull()
    expect(stepBy([], undefined, 1)).toBeNull()
    expect(stepBy([], undefined, -1)).toBeNull()
  })

  it('treats an id this saga does not have as the overview', () => {
    expect(stepBy(ids, 'kiev', 1)).toEqual({ to: 'battle-britain' })
    expect(stepBy(ids, 'kiev', -1)).toBeNull()
  })

  it('reaches every step in a finite number of presses, in time order', () => {
    const walked: (string | undefined)[] = []
    for (let at: string | undefined; ; ) {
      const next = stepBy(ids, at, 1)
      if (!next) break
      walked.push((at = next.to))
    }
    expect(walked).toEqual(ids)
  })
})

describe('the breadcrumb', () => {
  const trail = [
    { id: 'ww2', name: 'World War II' },
    { id: 'd-day', name: 'D-Day landings' },
  ]

  it('names the stack, innermost last, and marks where the reader is', () => {
    expect(crumbs(trail)).toEqual([
      { id: 'ww2', name: 'World War II', current: false },
      { id: 'd-day', name: 'D-Day landings', current: true },
    ])
    expect(crumbs([trail[0]])[0].current).toBe(true) // one context is its own crumb
    expect(crumbs([])).toEqual([])
  })

  it('costs one rung of the existing ladder per level climbed', () => {
    expect(backPressesTo(['ww2', 'd-day'], 'd-day', 'ww2')).toBe(1)
    expect(backPressesTo(['ww2', 'd-day', 'cherbourg'], 'cherbourg', 'ww2')).toBe(2)
    expect(backPressesTo(['ww2', 'd-day'], 'd-day', 'd-day')).toBe(0) // already there
  })

  it('pays the extra rung the ladder spends on a part being read', () => {
    // the panel is open on a battle inside D-Day: `focusBack` restores the
    // context first and pops second, so the crumb needs one more press
    expect(backPressesTo(['ww2', 'd-day'], 'omaha', 'ww2')).toBe(2)
    expect(backPressesTo(['ww2', 'd-day'], 'omaha', 'd-day')).toBe(1)
  })

  it('does nothing for a crumb that is not on the stack', () => {
    expect(backPressesTo(['ww2'], 'ww2', 'moon-landing')).toBe(0)
    expect(backPressesTo([], undefined, 'ww2')).toBe(0)
  })
})
