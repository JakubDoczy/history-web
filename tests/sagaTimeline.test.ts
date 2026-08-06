import { describe, it, expect } from 'vitest'
import { parseSteps, type RawStep, type Step } from '../src/lib/steps'
import { pointTime, timeFrom } from '../src/lib/time'
import {
  MIN_LABEL_PX,
  MIN_SLAB_PX,
  RAIL_PAD,
  backPressesTo,
  crumbs,
  labelRows,
  labelWidth,
  layoutRail,
  railWidth,
  railX,
  slabEdges,
  stationAt,
  stations,
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
  it('is the element’s, until the stations could not be pressed at that size', () => {
    expect(railWidth(1200, 11)).toBe(1200)
    expect(railWidth(390, 11)).toBe(11 * MIN_SLAB_PX) // a phone scrolls instead
  })

  it('leaves air at both ends, so the first and last station are not on the edge', () => {
    expect(railX(0, 1000)).toBeCloseTo(RAIL_PAD * 1000)
    expect(railX(1, 1000)).toBeCloseTo(1000 - RAIL_PAD * 1000)
    expect(railX(0.5, 1000)).toBeCloseTo(500)
  })
})

describe('slab edges — the half-open windows, widened until they can be hit', () => {
  const widths = (e: number[]) => e.slice(1).map((x, i) => x - e[i])

  it('are the step windows themselves when there is room for them', () => {
    expect(slabEdges([100, 300, 600], 900, 44)).toEqual([0, 300, 600, 900])
  })

  it('give every station a pressable target, in order, without leaving the rail', () => {
    const xs = stations(ww2, ww2Span).map((s) => railX(s.u, 1200))
    const e = slabEdges(xs, 1200, MIN_SLAB_PX)
    expect(e[0]).toBe(0)
    expect(e[e.length - 1]).toBe(1200)
    expect(e).toEqual([...e].sort((a, b) => a - b))
    for (const w of widths(e)) expect(w).toBeGreaterThanOrEqual(MIN_SLAB_PX - 1e-9)
  })

  it('shares the rail out evenly when even the minimum will not fit', () => {
    const e = slabEdges([0, 10, 20, 30], 80, 44) // 4 x 44 > 80
    expect(widths(e).every((w) => Math.abs(w - 20) < 1e-9)).toBe(true)
  })

  it('moves an edge no further than it has to', () => {
    // one tight pair in the middle of an otherwise roomy rail: the two edges
    // around it move, the ones outside it do not
    const e = slabEdges([0, 200, 210, 600], 800, 44)
    expect(e[1]).toBe(200)
    expect(e[2]).toBe(244)
    expect(e[3]).toBe(600)
  })
})

describe('layoutRail', () => {
  it('puts every mark inside its own target, so pressing the dot selects the dot', () => {
    for (const width of [1200, 800, 484]) {
      const rail = layoutRail(stations(ww2, ww2Span), width)
      for (const s of rail.stations) {
        expect(s.x).toBeGreaterThanOrEqual(s.from)
        expect(s.x).toBeLessThanOrEqual(s.to)
      }
    }
  })

  it('leaves an uncrowded mark exactly on its own moment', () => {
    const rail = layoutRail(stations(dday, ddaySpan), 900)
    for (const s of rail.stations) expect(s.x).toBeCloseTo(s.trueX)
  })

  it('keeps the true moment when the target had to be widened off it', () => {
    const rail = layoutRail(stations(ww2, ww2Span), 700)
    const pushed = rail.stations.filter((s) => Math.abs(s.x - s.trueX) > 2)
    expect(pushed.length).toBeGreaterThan(0) // the pile-up at the end of the war
    for (const s of pushed) expect(s.trueX).toBeCloseTo(railX(s.u, rail.width))
  })

  it('bands a period from its own start to its own end, and a moment not at all', () => {
    const rail = layoutRail(stations(ww2, ww2Span), 1200)
    const by = new Map(rail.stations.map((s) => [s.step.id, s]))
    expect(by.get('midway')!.band).toBeUndefined()
    const band = by.get('holocaust')!.band!
    expect(band.w).toBeGreaterThan(0)
    expect(band.x + band.w).toBeCloseTo(railX(0.95, 1200), 0)
  })

  it('stacks the labels only when one row will not hold them', () => {
    expect(layoutRail(stations(dday, ddaySpan), 1200).rows).toBe(1)
    expect(layoutRail(stations(ww2, ww2Span), 1200).rows).toBe(2)
    expect(layoutRail(stations(ww2, ww2Span), 1200).stations.map((s) => s.row))
      .toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0])
  })

  it('gives a label the room it has, and none at all below a readable width', () => {
    const rail = layoutRail(stations(ww2, ww2Span), 1200)
    for (const s of rail.stations) {
      expect(s.labelPx === 0 || s.labelPx >= MIN_LABEL_PX).toBe(true)
      // the room reaches the next mark on its own row, and stops there
      const next = rail.stations[rail.stations.indexOf(s) + rail.rows]
      if (s.labelPx && next) expect(s.x + s.labelPx).toBeLessThanOrEqual(next.x)
    }
    // and the pile-up at the end of the war is where the names drop out
    expect(rail.stations.filter((s) => !s.labelPx).map((s) => s.step.id)).toContain('trinity')
  })

  it('hangs the last names the other way off their marks, so nothing runs off the rail', () => {
    const rail = layoutRail(stations(ww2, ww2Span), 1200)
    for (const s of rail.stations)
      expect(s.flip, s.step.id).toBe(s.x + labelWidth(s.step.name) > rail.width)
    expect(rail.stations[0].flip).toBe(false)
    expect(rail.stations[rail.stations.length - 1].flip).toBe(true)
  })

  it('is not knocked over by a saga with one step, or by a rail with no width', () => {
    const one = layoutRail(stations([ww2[0]], ww2Span), 1200)
    expect(one.stations[0].from).toBe(0)
    expect(one.stations[0].to).toBe(1200)
    expect(() => layoutRail(stations(ww2, ww2Span), 0)).not.toThrow()
    expect(layoutRail([], 1200).stations).toEqual([])
  })

  it('names two rows’ worth by stacking — the eleven-chip overflow, solved', () => {
    const flat = layoutRail(stations(ww2, ww2Span), 1200)
    const named = flat.stations.filter((s) => s.labelPx).length
    // more than half the names are legible at rest, and the rest are one hover
    // (or one arrow key) away — where the strip showed two chips and scrolled
    expect(named).toBeGreaterThan(5)
  })
})

describe('stationAt — the pointer’s answer is the step that owns the moment', () => {
  const rail = layoutRail(stations(dday, ddaySpan), 900)
  const idAt = (x: number) => stationAt(rail, x)?.step.id

  it('is the step whose window the pixel falls in, half-open like stepWindows', () => {
    const beachhead = rail.stations[1]
    expect(idAt(beachhead.from)).toBe('beachhead')
    expect(idAt(beachhead.to - 0.001)).toBe('beachhead')
    expect(idAt(beachhead.to)).toBe('cherbourg')
  })

  it('opens at both ends: before the first station and after the last', () => {
    expect(idAt(0)).toBe('six-june')
    expect(idAt(rail.width)).toBe('breakout')
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

describe('labelRows', () => {
  it('is one row when every name fits beside its own station', () => {
    expect(labelRows([0, 300, 600, 900], [0, 300, 600], ['A', 'B', 'C'])).toBe(1)
  })
  it('is two when stacking is what buys the room', () => {
    const names = ['Attack on Pearl Harbor', 'Battle of Midway', 'Battle of Stalingrad']
    expect(labelRows([0, 80, 160, 900], [0, 80, 160], names)).toBe(2)
  })
})
