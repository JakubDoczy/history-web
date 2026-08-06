import { describe, it, expect } from 'vitest'
import { parseSteps, type RawStep, type Step } from '../src/lib/steps'
import { pointTime, timeExtent, timeFrom } from '../src/lib/time'
import {
  LANE_GAP_PX,
  MAX_LANES,
  MIN_LABEL_PX,
  minLabelPx,
  MIN_TICKS,
  MIN_WINDOW_DAYS,
  RAIL_PAD,
  TICK_PX,
  tickRoom,
  FULL_WINDOW,
  axisTicks,
  backPressesTo,
  crumbs,
  formatAt,
  laneOf,
  labelWidth,
  layoutRail,
  markZ,
  minWindow,
  panWindow,
  railU,
  railX,
  revealIn,
  spanUnit,
  zoomWindow,
  spread,
  stationAt,
  stationTime,
  stationUnit,
  stations,
  stepBy,
} from '../src/lib/present/sagaTimeline'

/**
 * The two shapes the layout has to survive.
 *
 * WORLD WAR II, as the corpus now dates it: eleven steps across six years, at
 * their own dates, with four of them piled into the last four months. Every
 * time here is a real one (round 45) — the fractions this fixture used to carry
 * were proportions of the war rather than dates, and put D-Day in 1943.
 *
 * And a POINT-DATED saga, which no longer exists in the corpus but is still a
 * shape the schema allows: four steps written as proportions inside a span with
 * no extent at all. It has no rule and its stations are spaced evenly, because
 * there is nothing else honest to do with them (see `spread`).
 */
const ww2Raw: RawStep[] = [
  { id: 'battle-britain', name: 'Battle of Britain', start: 1940.52322, end: 1940.83197, child: 'battle-britain' },
  { id: 'barbarossa', name: 'Operation Barbarossa', start: 1941.4726, end: 1941.9274, child: 'barbarossa' },
  { id: 'holocaust', name: 'The Holocaust', start: 1941.4726, end: 1945.34932, child: 'holocaust' },
  { id: 'pearl-harbor', name: 'Attack on Pearl Harbor', at: 1941.93288, child: 'pearl-harbor' },
  { id: 'midway', name: 'Battle of Midway', start: 1942.42329, end: 1942.43151, child: 'midway' },
  { id: 'stalingrad', name: 'Battle of Stalingrad', start: 1942.64247, end: 1943.08904, child: 'stalingrad' },
  { id: 'd-day', name: 'D-Day landings', start: 1944.43033, end: 1944.56421, child: 'd-day' },
  { id: 've-day', name: 'Victory in Europe', at: 1945.34932, child: 've-day' },
  { id: 'trinity', name: 'Trinity nuclear test', at: 1945.53836, child: 'trinity' },
  { id: 'hiroshima', name: 'Atomic bombings', start: 1945.59589, end: 1945.60411, child: 'hiroshima' },
  { id: 'vj-day', name: 'Victory over Japan', at: 1945.62055, child: 'vj-day' },
]
const ww2: Step[] = parseSteps(ww2Raw)
/** 1 September 1939 – 2 September 1945. */
const ww2Span = timeFrom(1939.66712, 1945.66986)

const dday: Step[] = parseSteps([
  { id: 'six-june', name: '6 June', at: 0 },
  { id: 'beachhead', name: 'The beachhead', at: 0.3 },
  { id: 'cherbourg', name: 'Cherbourg', at: 0.6 },
  { id: 'breakout', name: 'The breakout', at: 0.85 },
])
const ddaySpan = pointTime(1944)

/**
 * D-Day AS THE CORPUS DATES IT: 6 June – 25 July 1944, seven weeks.
 *
 * The fixture above is the point-dated shape (an unruled rail); this is the
 * real span, and it is the one the tick floor was measured against — it is the
 * shortest saga in the corpus and the one that showed a single tick on a phone.
 */
const ddayReal = timeFrom(1944.43033, 1944.56421)

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
    expect(by.get('holocaust')!.u).toBeCloseTo(0.3008) // 22 June 1941
    expect(by.get('holocaust')!.uEnd).toBeCloseTo(0.947) // 8 May 1945
    expect(by.get('pearl-harbor')!.uEnd).toBe(by.get('pearl-harbor')!.u)
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
    expect(by.get('pearl-harbor')!.band).toBeUndefined()
    const band = by.get('holocaust')!.band!
    expect(band.x).toBeCloseTo(railX(by.get('holocaust')!.u, 1200))
    expect(band.x + band.w).toBeCloseTo(railX(by.get('holocaust')!.uEnd, 1200))
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

  it('gives the war all three lanes — four of its steps are inside four months', () => {
    // VE Day, Trinity, Hiroshima and VJ Day are 8 May to 15 August 1945, which
    // on a desktop is 49 px of a 1200 px rail. That pile-up IS the summer of
    // 1945, and the lanes are how it is drawn without moving anything.
    expect(layoutRail(stations(ww2, ww2Span), ww2Span, 1200).lanes).toBe(3)
    expect(layoutRail(stations(ww2, ww2Span), ww2Span, 390).lanes).toBe(3)
    expect(layoutRail(stations(dday, ddaySpan), ddaySpan, 1200).lanes).toBe(1)
  })
})

describe('labels', () => {
  it('gives a label the room to the next mark IN ITS OWN LANE, or none at all', () => {
    const rail = layoutRail(stations(ww2, ww2Span), ww2Span, 1200)
    for (const s of rail.stations) {
      expect(s.labelPx === 0 || s.labelPx >= MIN_LABEL_PX, s.step.id).toBe(true)
      // …and the DATE goes beside the name only where both fit: below that the
      // name goes alone rather than being cut to an initial by it
      const need = minLabelPx(stationAt(s, ww2Span, rail.stations.length))
      expect(s.dated, s.step.id).toBe(s.labelPx >= need)
      const next = rail.stations.find((o) => o.lane === s.lane && o.x > s.x)
      if (s.labelPx && next) expect(s.x + s.labelPx).toBeLessThanOrEqual(next.x)
    }
    // and the pile-up at the end of the war is where the names drop out
    expect(rail.stations.filter((s) => !s.labelPx).map((s) => s.step.id)).toContain('vj-day')
  })

  it('names the ones the true dates leave room for, and drops them into the pile', () => {
    const rail = layoutRail(stations(ww2, ww2Span), ww2Span, 1200)
    const named = rail.stations.filter((s) => s.labelPx)
    expect(named.length).toBeGreaterThanOrEqual(4)
    // and every name that was dropped is one of the crowded ones: the summer of
    // 1945, and the two steps that open on the same day as their neighbour
    for (const s of rail.stations)
      if (!s.labelPx)
        expect([
          'barbarossa', 'pearl-harbor', 'midway', 've-day', 'trinity', 'hiroshima', 'vj-day',
        ]).toContain(s.step.id)
  })

  it('names every station of an uncrowded saga', () => {
    const rail = layoutRail(stations(dday, ddaySpan), ddaySpan, 1200)
    expect(rail.stations.every((s) => s.labelPx)).toBe(true)
  })

  it('hangs the last names the other way off their marks, so nothing runs off the rail', () => {
    const rail = layoutRail(stations(ww2, ww2Span), ww2Span, 1200)
    for (const s of rail.stations) {
      const whole = `${s.step.name} ${stationAt(s, ww2Span, rail.stations.length)}`
      expect(s.flip, s.step.id).toBe(s.x + labelWidth(whole) > rail.width)
    }
    expect(rail.stations[0].flip).toBe(false)
    expect(rail.stations[rail.stations.length - 1].flip).toBe(true)
  })
})

describe('the axis — a rule the reader can read the dates off', () => {
  it('rules a six-year war in years, inside its own span', () => {
    const axis = axisTicks(ww2Span, 1200)
    expect(axis.unit).toBe('year')
    // the war opens in September 1939 and ends in September 1945, so the rule
    // runs 1940..1945 — the round years INSIDE its own span, and no others
    expect(axis.ticks.map((t) => t.label)).toEqual(['1940', '1941', '1942', '1943', '1944', '1945'])
    for (const t of axis.ticks) expect(t.u).toBeGreaterThanOrEqual(0)
    for (const t of axis.ticks) expect(t.u).toBeLessThanOrEqual(1)
    expect(axis.ticks[0].u).toBeGreaterThan(0)
    expect(axis.ticks[axis.ticks.length - 1].u).toBeLessThan(1)
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
    // the year a date is IN, never the nearest one: 1944.5 is July 1944
    expect(formatAt(1944.5, 'year')).toBe('1944')
    expect(formatAt(1944.5, 'month')).toBe('Jul')
    expect(formatAt(1944.5, 'month', true)).toBe('Jul 1944')
    expect(formatAt(1944.0, 'month')).toBe('Jan 1944')
    expect(formatAt(1944.43, 'day', true)).toMatch(/^\d+ Jun 1944$/)
    // outside the calendar's reach the answer is the year, not a made-up month
    expect(formatAt(-250000, 'month')).toBe(formatAt(-250000, 'year'))
  })

  it('dates a station one notch finer than its rule, and says a shared year once', () => {
    const st = (id: string) => stations(ww2, ww2Span).find((s) => s.step.id === id)!
    // the war is ruled in years; its stations are dated in months
    expect(stationUnit(ww2Span)).toBe('month')
    expect(stationAt(st('battle-britain'), ww2Span, 11)).toBe('Jul – Oct 1940')
    expect(stationAt(st('pearl-harbor'), ww2Span, 11)).toBe('Dec 1941')
    expect(stationAt(st('holocaust'), ww2Span, 11)).toBe('Jun 1941 – May 1945')
    // a period inside one month says that month once
    expect(stationAt(st('midway'), ww2Span, 11)).toBe('Jun 1942')
    // …and a campaign of seven weeks is dated to the day
    const dd = timeFrom(1944.43033, 1944.56421)
    const six = stations(parseSteps([{ id: 'a', name: 'a', at: 1944.43033 }]), dd)[0]
    expect(stationUnit(dd)).toBe('day')
    expect(stationAt(six, dd, 1)).toBe('6 Jun 1944')
  })

  /**
   * NOTHING SAYS MORE THAN IT KNOWS. A saga ruled in years dates its stations
   * in months — but a step written as a whole year was not dated to a month by
   * whoever wrote it, and the rail may not put one on it.
   */
  it('leaves a step dated to a whole year saying the year', () => {
    const span = timeFrom(1750, 1760)
    const s = stations(parseSteps([{ id: 'a', name: 'a', at: 1755 }]), span)[0]
    expect(stationUnit(span)).toBe('month')
    expect(stationAt(s, span, 1)).toBe('1755')
  })

  /**
   * A POINT-DATED saga has no dates to give: every step resolves to the same
   * year, and the authored fractions are proportions of a campaign. The rail
   * spaces them evenly and numbers them, which is the whole of what it knows.
   */
  it('numbers the stations of a saga that has no dates, and spaces them evenly', () => {
    const rail = layoutRail(stations(dday, ddaySpan), ddaySpan, 1200)
    expect(rail.axis.unit).toBe('none')
    const slots = [0.125, 0.375, 0.625, 0.875]
    expect(spread(stations(dday, ddaySpan), 'none')).toEqual(slots)
    expect(rail.stations.map((s) => s.x)).toEqual(slots.map((u) => railX(u, 1200)))
    // equal gaps, and neither end on the rail's own edge
    const gaps = rail.stations.slice(1).map((s, i) => s.x - rail.stations[i].x)
    expect(new Set(gaps).size).toBe(1)
    expect(rail.stations.map((s) => stationAt(s, ddaySpan, 4))).toEqual([
      '1 of 4', '2 of 4', '3 of 4', '4 of 4',
    ])
    // and no bands: a length of an evenly spaced axis is not a length of time
    expect(rail.stations.every((s) => !s.band)).toBe(true)
  })

  it('is part of the rail’s own layout, measured over the width it is drawn at', () => {
    const rail = layoutRail(stations(ww2, ww2Span), ww2Span, 1200)
    expect(rail.axis.unit).toBe('year')
    expect(rail.axis.ticks.length).toBe(6) // 1940..1945, inside 1939.7..1945.7
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

/* ==========================================================================
   THE WINDOW — round 46
   ==========================================================================

   The rail used to answer "eleven moments will not fit on a phone" by growing
   past the element and scrolling. It answers it by ZOOMING now, which is the
   era rail's answer to the same question, and everything the rail draws is a
   function of the visible window rather than of the span. What follows is that
   function's arithmetic: what a gesture may do, where it is stopped, and what
   the rest of the layout does when the window moves.

   All of it is pure, so all of it is here rather than in a browser: the e2e
   pass checks that the gestures are wired to these functions, not what they
   compute. */

/** The window that shows exactly the years a..b of a saga's span. */
const over = (span: ReturnType<typeof timeFrom>, a: number, b: number) => {
  const [from, to] = timeExtent(span)
  return { u0: railU((a - from) / (to - from)), u1: railU((b - from) / (to - from)) }
}
const len = (w: { u0: number; u1: number }) => w.u1 - w.u0

describe('the visible window', () => {
  it('holds the point under the cursor still, which is what makes a zoom a zoom', () => {
    for (const at of [0, 0.25, 0.5, 1]) {
      const w = zoomWindow(FULL_WINDOW, 0.5, at)
      expect(w.u0 + at * len(w), `anchor ${at}`).toBeCloseTo(at)
    }
    // …and again from a window that is already somewhere
    const w = zoomWindow({ u0: 0.2, u1: 0.6 }, 0.5, 0.75)
    expect(w.u0 + 0.75 * len(w)).toBeCloseTo(0.2 + 0.75 * 0.4)
  })

  it('never zooms out past the saga’s own padded span', () => {
    expect(zoomWindow({ u0: 0.2, u1: 0.5 }, 100, 0.5)).toEqual(FULL_WINDOW)
    expect(zoomWindow(FULL_WINDOW, 2, 0.5)).toEqual(FULL_WINDOW)
    // a window against an end keeps its width and slides rather than being
    // clipped: zooming out at the right edge still arrives at the whole saga
    const w = zoomWindow({ u0: 0.9, u1: 1 }, 3, 1)
    expect(len(w)).toBeCloseTo(0.3)
    expect(w.u1).toBeCloseTo(1)
  })

  it('stops zooming in where the tick ladder stops refining', () => {
    const min = minWindow(ww2Span)
    const w = zoomWindow(FULL_WINDOW, 0.0001, 0.5, min)
    expect(len(w)).toBeCloseTo(min)
    expect(len(zoomWindow(w, 0.5, 0.5, min))).toBeCloseTo(min) // and stays there
  })

  it('sizes that floor from the span: about three days, whatever the saga is', () => {
    const days = (span: ReturnType<typeof timeFrom>) => {
      const [a, b] = timeExtent(span)
      return (minWindow(span) / (1 - 2 * RAIL_PAD)) * (b - a) * 365.2425
    }
    expect(days(ww2Span)).toBeCloseTo(MIN_WINDOW_DAYS, 5)
    expect(days(timeFrom(1944.43, 1944.56))).toBeCloseTo(MIN_WINDOW_DAYS, 5)
    // a saga shorter than the floor cannot zoom at all, and says so
    expect(minWindow(timeFrom(1944, 1944.002))).toBe(1)
    expect(minWindow(ddaySpan)).toBe(1) // …nor can one with no extent
  })

  it('pans by a fraction of rail space, keeping its width, and stops at the ends', () => {
    const on = panWindow({ u0: 0.2, u1: 0.4 }, 0.1)
    expect([on.u0, on.u1].map((v) => +v.toFixed(6))).toEqual([0.3, 0.5])
    expect(panWindow({ u0: 0.2, u1: 0.4 }, -1)).toEqual({ u0: 0, u1: 0.2 })
    expect(panWindow({ u0: 0.2, u1: 0.4 }, 1)).toEqual({ u0: 0.8, u1: 1 })
    expect(panWindow(FULL_WINDOW, 0.5)).toEqual(FULL_WINDOW) // nothing to pan
  })

  it('draws through the window: the same fraction, a different pixel', () => {
    // the whole span across 800px, then a tenth of it across the same 800px
    expect(railX(0.5, 800)).toBeCloseTo(400)
    const w = { u0: 0.45, u1: 0.55 }
    expect(railX(0.5, 800, w)).toBeCloseTo(((RAIL_PAD + 0.45 - 0.45) / 0.1) * 800)
    // …and a moment outside the window lands outside the rail, not on its edge
    expect(railX(0, 800, w)).toBeLessThan(0)
    expect(railX(1, 800, w)).toBeGreaterThan(800)
  })
})

describe('panning a station into view', () => {
  it('leaves a window that already holds it alone, so a walk does not jog the rail', () => {
    const w = { u0: 0.2, u1: 0.6 }
    expect(revealIn(w, 0.4)).toBe(w) // the same object: the caller animates nothing
    expect(revealIn(w, 0.26)).toBe(w) // inside the margin, which is 12% of 0.4
  })

  it('moves the least it can, and brings the station clear of the edge', () => {
    const w = { u0: 0.2, u1: 0.6 }
    const left = revealIn(w, 0.1)
    expect(len(left)).toBeCloseTo(0.4)
    expect(left.u0).toBeCloseTo(0.1 - 0.12 * 0.4)
    const right = revealIn(w, 0.9)
    expect(right.u1).toBeCloseTo(0.9 + 0.12 * 0.4)
  })

  it('does not run off the ends to make room for a station that is on one', () => {
    const [lo, hi] = [revealIn({ u0: 0.2, u1: 0.6 }, 0), revealIn({ u0: 0.2, u1: 0.6 }, 1)]
    expect([lo.u0, lo.u1].map((v) => +v.toFixed(6))).toEqual([0, 0.4])
    expect([hi.u0, hi.u1].map((v) => +v.toFixed(6))).toEqual([0.6, 1])
  })
})

/**
 * THE RULE REFINES WITH THE WINDOW — the third thing the reader asked for:
 * *"the timeline if it's short enough, should show months or even days — all
 * based on how much space you have for ticks."*
 *
 * It is the same ladder round 44 built, fed the VISIBLE span instead of the
 * whole one. So there is no mode and no threshold: a war rules in years, its
 * 1944 in months and D-Day's June in days, and the thing that decides is how
 * many `TICK_PX` of room the labels have.
 */
describe('the tick ladder, walked by the zoom', () => {
  it('steps year → month → day as the window closes on D-Day', () => {
    const at = (w: { u0: number; u1: number }) => axisTicks(ww2Span, 1200, w).unit
    expect(at(FULL_WINDOW)).toBe('year')
    expect(at(over(ww2Span, 1944, 1945))).toBe('month')
    expect(at(over(ww2Span, 1944.41, 1944.5))).toBe('day')
  })

  it('names the ticks in the unit it is ruling in, and marks where a bigger one opens', () => {
    const june = axisTicks(ww2Span, 1200, over(ww2Span, 1944.41, 1944.5))
    expect(june.ticks.some((t) => /^\d+ Jun$/.test(t.label))).toBe(true)
    expect(june.ticks.every((t) => t.major === /^1 /.test(t.label))).toBe(true)
    const y44 = axisTicks(ww2Span, 1200, over(ww2Span, 1944, 1945))
    expect(y44.ticks.map((t) => t.label)).toContain('Jul')
    // January carries its year: a month rule still says WHICH year it is in
    expect(y44.ticks.filter((t) => t.major).map((t) => t.label)).toEqual(['Jan 1944', 'Jan 1945'])
  })

  /**
   * A twelfth of a year is 30.44 days and a calendar month is 28 to 31, so a
   * month rule stepped in twelfths drifts a third of a day per tick. On a
   * ten-month window at 1280px that drift printed "Jan 1944" twice and skipped
   * February entirely — two labels claiming the same month, three pixels apart.
   */
  it('stands its month ticks on the first of the month, on the calendar’s own grid', () => {
    const y44 = axisTicks(ww2Span, 1200, over(ww2Span, 1944, 1945))
    expect(y44.unit).toBe('month')
    expect(new Set(y44.ticks.map((t) => t.label)).size).toBe(y44.ticks.length)
    // every second month from January, because the sequence aligns to the year
    expect(y44.ticks.map((t) => t.label)).toEqual([
      'Jan 1944', 'Mar', 'May', 'Jul', 'Sep', 'Nov', 'Jan 1945',
    ])
    // consecutive months on a one-month rule, none missing and none twice
    const ten = axisTicks(ww2Span, 1280, over(ww2Span, 1943.85, 1944.6))
    expect(ten.ticks.map((t) => t.label)).toEqual([
      'Dec', 'Jan 1944', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug',
    ])
  })

  /**
   * Two NEIGHBOURING ticks never say the same thing. Further apart they may:
   * a six-month rule over three years says Jul three times, and the Januarys
   * between them carry the year — which is the era rail's own idiom and how a
   * ruler has always been read. What is a defect is two adjacent marks both
   * claiming to be January 1944.
   */
  it('never says the same thing twice in a row, at any zoom or width', () => {
    for (const width of [390, 800, 1280]) {
      for (let k = 1; k >= minWindow(ww2Span); k /= 1.25) {
        const w = { u0: Math.max(0, 0.62 - k / 2), u1: Math.min(1, 0.62 + k / 2) }
        const labels = axisTicks(ww2Span, width, w).ticks.map((t) => t.label)
        for (let i = 1; i < labels.length; i++)
          expect(labels[i], `w=${width} k=${k}: ${labels}`).not.toBe(labels[i - 1])
      }
    }
  })

  it('never refines past the window: every tick it draws is inside the span', () => {
    for (const w of [FULL_WINDOW, over(ww2Span, 1941, 1942), over(ww2Span, 1945.5, 1945.6)])
      for (const t of axisTicks(ww2Span, 900, w).ticks) expect(t.u).toBeGreaterThanOrEqual(0)
  })

  it('walks the ladder monotonically — zooming in never coarsens the rule', () => {
    const rank = { year: 0, month: 1, day: 2, none: -1 }
    let last = -1
    for (let k = 1; k >= minWindow(ww2Span); k /= 1.4) {
      const u = rank[axisTicks(ww2Span, 800, { u0: 0.5 - k / 2, u1: 0.5 + k / 2 }).unit]
      expect(u, `window ${k}`).toBeGreaterThanOrEqual(last)
      last = u
    }
    expect(last).toBe(2) // …and it arrives at days
  })

  /**
   * THE DENSITY RULE IS THE COLLISION PROOF. A spacing is only drawn if every
   * label on it has the room ITS OWN STRING wants (`tickRoom`), so two labels
   * cannot be drawn on top of each other — at any zoom, at any width, and
   * whether the spacing was chosen by the calm rule or pushed there by the
   * floor. Swept across both spans, and across the widths where
   * `floor(width / TICK_PX)` ticks over, which is where a density rule breaks
   * if it is going to.
   */
  it('leaves every tick label its room, at every zoom and every width', () => {
    for (const span of [ww2Span, ddayReal])
      for (const width of [219, 220, 221, 320, 329, 330, 331, 390, 440, 660, 880, 1200, 1440]) {
        for (let k = 1; k >= minWindow(span); k /= 1.3) {
          const w = { u0: Math.max(0, 0.5 - k / 2), u1: Math.min(1, 0.5 + k / 2) }
          const ts = axisTicks(span, width, w).ticks
          const xs = ts.map((t) => railX(t.u, width, w))
          for (let i = 1; i < xs.length; i++)
            expect(xs[i] - xs[i - 1], `w=${width} k=${k}: ${ts[i - 1].label}|${ts[i].label}`).toBeGreaterThanOrEqual(
              tickRoom(ts[i - 1].label),
            )
        }
      }
  })
})

/**
 * THE FLOOR UNDER THE RULE (round 47).
 *
 * *"D-Day at fit showed a single tick; WWII showed 2 years."* `TICK_PX` is the
 * room the ERA rail's labels want, and the saga rail sets its ticks in 10px
 * condensed — so on a 390px phone the calm rule divided the rail three ways and
 * a rule with one mark on it is not a rule. There are two statements now: the
 * calm one, which a desktop lives on and which is unchanged, and a floor of
 * `MIN_TICKS` divisions, which a phone lives on and which may only refine as
 * far as the LABELS THEMSELVES allow.
 */
describe('the tick floor — a rule a phone can read a position off', () => {
  const PHONE = 390
  const labels = (span: typeof ww2Span, width: number) =>
    axisTicks(span, width).ticks.map((t) => t.label)

  it('rules D-Day’s seven weeks in days on a phone, not in one lonely month', () => {
    const axis = axisTicks(ddayReal, PHONE)
    expect(axis.unit).toBe('day')
    expect(axis.ticks.length).toBeGreaterThanOrEqual(MIN_TICKS)
    // a 10-day ladder rung, every mark a real date
    expect(axis.ticks.map((t) => t.label)).toEqual(['7 Jun', '17 Jun', '27 Jun', '7 Jul', '17 Jul'])
  })

  it('shows the war’s years on a phone, where it used to show two of six', () => {
    expect(labels(ww2Span, PHONE)).toEqual(['1940', '1941', '1942', '1943', '1944', '1945'])
  })

  it('leaves the desktop’s full war exactly as calm as it was', () => {
    // the calm rule already clears the floor at 1280, so the floor does nothing
    expect(labels(ww2Span, 1280)).toEqual(['1940', '1941', '1942', '1943', '1944', '1945'])
    expect(axisTicks(ww2Span, 1280).ticks.length).toBeGreaterThanOrEqual(MIN_TICKS)
  })

  /**
   * THE BOUNDARY THE CONSTANTS CHOSE. The floor refines to the COARSEST spacing
   * that clears it — never to the finest that fits — so it adds marks where
   * there were too few and nowhere else.
   */
  it('refines to the coarsest rule that clears the floor, and stops there', () => {
    for (const [span, width] of [
      [ddayReal, PHONE],
      [ww2Span, PHONE],
      [ww2Span, 320],
      [timeFrom(1000, 2000), 300],
    ] as const) {
      const n = axisTicks(span, width).ticks.length
      expect(n, `${width}px`).toBeGreaterThanOrEqual(MIN_TICKS)
      // one notch coarser than what was chosen would have fallen short — that
      // is what "coarsest that clears it" means, and it is the whole difference
      // between a floor and a target
      expect(n, `${width}px`).toBeLessThan(2 * MIN_TICKS + 4)
    }
  })

  /** Every mark the floor adds is a DATE. A denser rule that says less is not
   *  the fix — the complaint was that the rail did not say when. */
  it('never buys density with a repeated label', () => {
    for (const span of [ddayReal, ww2Span, timeFrom(-12000, -9000), timeFrom(1000, 2000)])
      for (const width of [280, 320, 360, 390, 430, 768, 1280]) {
        const ls = axisTicks(span, width).ticks.map((t) => t.label)
        for (let i = 1; i < ls.length; i++) expect(ls[i], `${width}px: ${ls}`).not.toBe(ls[i - 1])
      }
  })

  /**
   * The floor is a floor and the collision rule is a ceiling, and the ceiling
   * wins: a rail too narrow for `MIN_TICKS` legible marks gets fewer marks
   * rather than marks drawn on top of each other.
   */
  it('gives up divisions rather than legibility on a rail too narrow for both', () => {
    const ts = axisTicks(ddayReal, 200).ticks
    const xs = ts.map((t) => railX(t.u, 200))
    for (let i = 1; i < xs.length; i++)
      expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(tickRoom(ts[i - 1].label))
  })

  /** The label metric itself, against the strings that measured it. */
  it('asks for room in proportion to the string, plus its inset and its air', () => {
    expect(tickRoom('1940')).toBeLessThan(tickRoom('Jan 1940'))
    expect(tickRoom('Jul')).toBeLessThan(tickRoom('17 Jun'))
    // …and generously: measured in the browser at 10px condensed, "Jan 1944" is
    // 48.8px of glyphs and "10,000 BCE" is 64.2
    expect(tickRoom('Jan 1944')).toBeGreaterThan(48.8)
    expect(tickRoom('10,000 BCE')).toBeGreaterThan(64.2)
    // the calm density is still the wider of the two, which is why a desktop
    // never reaches for the floor
    expect(TICK_PX).toBeGreaterThan(tickRoom('Jan 1944'))
  })
})

describe('the layout, re-derived per window', () => {
  const phone = (w = FULL_WINDOW) => layoutRail(stations(ww2, ww2Span), ww2Span, 390, w)
  /** The last four months of the war — the pile-up the fit view has to stack. */
  const END_OF_WAR = { u0: 0.895, u1: 0.95 }

  it('un-crowds what the fit view had to stack: zoom in and the lanes empty', () => {
    const fit = phone()
    expect(fit.lanes).toBe(3) // eleven moments of a war, on a 390px phone
    expect(fit.stations.filter((s) => s.labelPx > 0).length).toBeLessThan(3)

    const shown = phone(END_OF_WAR).stations.filter((s) => s.x >= 0 && s.x <= 390)
    expect(shown.map((s) => s.step.id)).toEqual(['ve-day', 'trinity', 'hiroshima', 'vj-day'])
    expect(shown.every((s) => s.lane === 0)).toBe(true) // nothing has to hang
    // …and with the room comes a name AND its date, which the fit view dropped
    expect(fit.stations.find((s) => s.step.id === 've-day')!.labelPx).toBe(0)
    expect(shown.filter((s) => s.dated).length).toBeGreaterThan(0)
  })

  it('puts the stations outside the window outside the rail, rather than on its edge', () => {
    const end = phone(END_OF_WAR)
    expect(end.stations.find((s) => s.step.id === 'd-day')!.x).toBeLessThan(0)
    expect(phone(over(ww2Span, 1939.7, 1940.2)).stations.at(-1)!.x).toBeGreaterThan(390)
  })

  it('re-measures a period’s band against the window it is drawn in', () => {
    const wide = phone().stations.find((s) => s.step.id === 'holocaust')!.band!
    const near = phone(over(ww2Span, 1941, 1942)).stations.find((s) => s.step.id === 'holocaust')!
      .band!
    expect(near.w).toBeGreaterThan(wide.w * 5) // six years of it, over one year of rail
  })

  it('reports the window it was derived from, so the view has one source for it', () => {
    const w = over(ww2Span, 1944, 1945)
    expect(phone(w).win).toBe(w)
    expect(phone().win).toBe(FULL_WINDOW)
  })
})

/**
 * WHICH MARK IS ON TOP. In a three-deep pile-up the question "which step am I
 * on" is answered by z-order before it is answered by colour, and the answer
 * used to be four CSS rules of equal specificity all claiming `z-index: 3`.
 */
describe('markZ', () => {
  it('puts the open step above everything, then the cursor, then a hover', () => {
    const z = (s: Parameters<typeof markZ>[0]) => markZ(s)
    expect(z({ on: true, lane: 2 })).toBeGreaterThan(z({ cursor: true, lane: 0 }))
    expect(z({ cursor: true, lane: 2 })).toBeGreaterThan(z({ hover: true, lane: 0 }))
    expect(z({ hover: true, lane: 2 })).toBeGreaterThan(z({ lane: 0 }))
    // the open step is on top even when it is also the cursor and also hovered
    expect(z({ on: true, cursor: true, hover: true })).toBe(z({ on: true }))
  })

  it('orders the row itself by lane: nearer the axis is nearer the eye', () => {
    expect(markZ({ lane: 0 })).toBeGreaterThan(markZ({ lane: 1 }))
    expect(markZ({ lane: 1 })).toBeGreaterThan(markZ({ lane: 2 }))
    expect(markZ({})).toBe(markZ({ lane: 0 }))
    expect(markZ({ lane: 40 })).toBeGreaterThan(0) // never falls out of the stack
  })
})

/**
 * A SAGA'S OWN RESOLUTION, which the zoom must not move.
 *
 * The live rule refines as the reader zooms — that is the feature. The head's
 * span readout and every station's date are facts about the saga, so they are
 * asked of the SPAN at a fixed density instead: zoomed into June 1944 the rule
 * ruled in days, and a war that began in 1939 read "1 Sep – 2 Sep 1945".
 */
describe('spanUnit', () => {
  it('is the span’s own, not the window’s', () => {
    expect(spanUnit(ww2Span)).toBe('year')
    expect(spanUnit(timeFrom(1944.43033, 1944.56421))).toBe('day') // 6 Jun – 25 Jul
    expect(spanUnit(ddaySpan)).toBe('none')
    // …and it does not budge when the rail does
    expect(axisTicks(ww2Span, 1200, over(ww2Span, 1944.41, 1944.5)).unit).toBe('day')
    expect(spanUnit(ww2Span)).toBe('year')
  })

  it('keeps every station’s date at that resolution too', () => {
    const dated = (w: { u0: number; u1: number }) =>
      layoutRail(stations(ww2, ww2Span), ww2Span, 1200, w).stations.map((s) =>
        stationAt(s, ww2Span, 11),
      )
    expect(dated(FULL_WINDOW)).toEqual(dated(over(ww2Span, 1944.41, 1944.5)))
  })
})
