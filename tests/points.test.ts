import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  POINTS_SHOWN,
  POINT_ICONS,
  clampShown,
  eraAt,
  iconFor,
  kindLabel,
  parsePoints,
  pointIconSvg,
  resolvePointsAt,
  type HistoricalPoint,
} from '../src/lib/points'
import raw from '../src/data/points.json'
import { usePointsStore } from '../src/stores/points'
import { useTimeStore } from '../src/stores/time'
import { useSettingsStore } from '../src/stores/settings'

const DATA = parsePoints(raw)

/** A minimal point for the synthetic cases. */
const pt = (id: string, eras: HistoricalPoint['eras'], kind = 'city'): HistoricalPoint => ({
  id,
  name: id,
  kind,
  pos: [10, 20],
  eras,
})

describe('the shipped dataset', () => {
  it('survives its own validator whole — every authored entry is well-formed', () => {
    expect(Array.isArray(raw)).toBe(true)
    expect(DATA.length).toBe((raw as unknown[]).length)
    expect(DATA.length).toBeGreaterThanOrEqual(40)
  })

  it('has unique ids, sane coordinates and honest era tables', () => {
    const ids = new Set(DATA.map((p) => p.id))
    expect(ids.size).toBe(DATA.length)
    for (const p of DATA) {
      expect(Math.abs(p.pos[0])).toBeLessThanOrEqual(180)
      expect(Math.abs(p.pos[1])).toBeLessThanOrEqual(90)
      expect(p.eras.length).toBeGreaterThan(0)
      for (const e of p.eras) {
        expect(Number.isInteger(e.priority)).toBe(true)
        expect(e.priority).toBeGreaterThanOrEqual(1)
        expect(e.priority).toBeLessThanOrEqual(5)
        if (e.to !== undefined) expect(e.to).toBeGreaterThan(e.from)
      }
    }
  })

  it('spreads across the kinds the icon registry knows', () => {
    const byKind = new Map<string, number>()
    for (const p of DATA) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1)
    for (const kind of Object.keys(POINT_ICONS)) {
      expect(byKind.get(kind) ?? 0).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('existence windows', () => {
  it('a point exists only inside its era entries', () => {
    const carthage = DATA.find((p) => p.id === 'carthage')!
    expect(eraAt(carthage, -300)).toBeDefined()
    expect(eraAt(carthage, 400)).toBeDefined()
    expect(eraAt(carthage, 800)).toBeUndefined() // gone after 698
    const masada = DATA.find((p) => p.id === 'masada')!
    expect(eraAt(masada, 50)).toBeDefined()
    expect(eraAt(masada, 100)).toBeUndefined() // fell in 73
  })

  it('a gap in the table is a gap on the globe (Samarkand under the Mongols)', () => {
    const samarkand = DATA.find((p) => p.id === 'samarkand')!
    expect(eraAt(samarkand, 1000)).toBeDefined()
    expect(eraAt(samarkand, 1300)).toBeUndefined() // razed 1220, reborn 1370
    expect(eraAt(samarkand, 1400)).toBeDefined()
  })

  it('windows are half-open: the boundary year belongs to the next era', () => {
    const p = pt('x', [
      { from: 0, to: 100, priority: 3, name: 'old' },
      { from: 100, to: 200, priority: 2, name: 'new' },
    ])
    expect(eraAt(p, 99)?.name).toBe('old')
    expect(eraAt(p, 100)?.name).toBe('new')
    expect(eraAt(p, 200)).toBeUndefined()
    // an omitted `to` runs to the present
    const open = pt('y', [{ from: 1900, priority: 1 }])
    expect(eraAt(open, 2025)).toBeDefined()
    expect(eraAt(open, 1899)).toBeUndefined()
  })

  it('overlapping entries degrade to the best-priority claim, not the first', () => {
    const p = pt('x', [
      { from: 0, to: 100, priority: 4 },
      { from: 50, to: 100, priority: 2 },
    ])
    expect(eraAt(p, 75)?.priority).toBe(2)
    expect(eraAt(p, 25)?.priority).toBe(4)
  })
})

describe('priority ordering and stability', () => {
  it('shows the top N by the era priority in force at that year', () => {
    const out = resolvePointsAt(DATA, -400, 10)
    expect(out).toHaveLength(10)
    // priorities come out non-decreasing — the sort is by rank
    for (let i = 1; i < out.length; i++)
      expect(out[i].priority).toBeGreaterThanOrEqual(out[i - 1].priority)
    // the classical world's top places are in the set
    const ids = out.map((p) => p.id)
    expect(ids).toContain('athens') // priority 1 in -510..-322
    expect(ids).toContain('carthage')
    expect(ids).toContain('persepolis')
    expect(ids).not.toContain('masada') // does not exist yet
  })

  it('a place is promoted by its own era: Verdun surfaces in 1916, not 1900', () => {
    const at = (y: number) => resolvePointsAt(DATA, y, 10).map((p) => p.id)
    expect(at(1900)).not.toContain('verdun') // priority 4 background fort
    expect(at(1916)).toContain('verdun') // priority 1, 1914–1919
    expect(at(1916)).toContain('dardanelles')
  })

  it('ties break by id, so scrubbing never reorders a tied pair', () => {
    const a = pt('aaa', [{ from: 0, priority: 2 }])
    const b = pt('bbb', [{ from: 0, priority: 2 }])
    const c = pt('ccc', [{ from: 0, priority: 1 }])
    for (const year of [10, 500, 1900]) {
      expect(resolvePointsAt([b, a, c], year, 3).map((p) => p.id)).toEqual(['ccc', 'aaa', 'bbb'])
    }
  })

  it('is deterministic across repeated calls with the same inputs', () => {
    const one = resolvePointsAt(DATA, 1200, 10)
    const two = resolvePointsAt(DATA, 1200, 10)
    expect(two).toEqual(one)
  })
})

describe('renames', () => {
  it('resolves the era name: Byzantion → Constantinople → Istanbul', () => {
    const city = DATA.find((p) => p.id === 'constantinople')!
    expect(eraAt(city, -400)?.name).toBe('Byzantion')
    expect(eraAt(city, 800)?.name).toBe('Constantinople')
    expect(eraAt(city, 1500)?.name).toBe('Constantinople')
    expect(eraAt(city, 1950)?.name).toBe('Istanbul')
  })

  it('carries the resolved name onto the marker', () => {
    const at1400 = resolvePointsAt(DATA, 1400, 25)
    expect(at1400.find((p) => p.id === 'tenochtitlan')?.name).toBe('Tenochtitlan')
    const at1600 = resolvePointsAt(DATA, 1600, 25)
    expect(at1600.find((p) => p.id === 'tenochtitlan')?.name).toBe('Mexico City')
  })

  it('falls back to the point name where the era does not rename', () => {
    const out = resolvePointsAt(DATA, 1200, 25)
    expect(out.find((p) => p.id === 'venice')?.name).toBe('Venice')
  })
})

describe('the N clamp', () => {
  it('clamps to the shared bounds whatever wrote the setting', () => {
    expect(clampShown(-5)).toBe(0)
    expect(clampShown(0)).toBe(0)
    expect(clampShown(10)).toBe(10)
    expect(clampShown(999)).toBe(POINTS_SHOWN.max)
    expect(clampShown(7.6)).toBe(8)
    expect(clampShown(Number.NaN)).toBe(0)
  })

  it('N = 0 hides the layer; N above the candidates returns all of them', () => {
    expect(resolvePointsAt(DATA, 1200, 0)).toEqual([])
    const all = resolvePointsAt(DATA, 1200, 25)
    expect(all.length).toBeGreaterThan(10)
    expect(all.length).toBeLessThanOrEqual(25)
  })

  it('keeps the default inside the slider range, on a step', () => {
    expect(POINTS_SHOWN.default).toBeGreaterThanOrEqual(POINTS_SHOWN.min)
    expect(POINTS_SHOWN.default).toBeLessThanOrEqual(POINTS_SHOWN.max)
    expect(POINTS_SHOWN.default % POINTS_SHOWN.step).toBe(0)
  })
})

describe('the validator', () => {
  it('drops malformed entries instead of shipping NaN markers', () => {
    const bad = parsePoints([
      { id: 'ok', name: 'Ok', kind: 'city', pos: [1, 2], eras: [{ from: 0, priority: 1 }] },
      { id: 'dup', name: 'A', kind: 'city', pos: [1, 2], eras: [{ from: 0, priority: 1 }] },
      { id: 'dup', name: 'B', kind: 'city', pos: [1, 2], eras: [{ from: 0, priority: 1 }] },
      { id: 'no-eras', name: 'X', kind: 'city', pos: [1, 2], eras: [] },
      { id: 'bad-pos', name: 'X', kind: 'city', pos: [999, 2], eras: [{ from: 0, priority: 1 }] },
      { id: 'bad-era', name: 'X', kind: 'city', pos: [1, 2], eras: [{ from: 100, to: 50, priority: 1 }] },
      { id: 'bad-prio', name: 'X', kind: 'city', pos: [1, 2], eras: [{ from: 0, priority: 0 }] },
    ])
    expect(bad.map((p) => p.id)).toEqual(['ok', 'dup'])
    expect(parsePoints('nonsense')).toEqual([])
  })
})

describe('icons', () => {
  it('every known kind has its own mark; an unknown kind gets the lozenge', () => {
    for (const kind of Object.keys(POINT_ICONS)) {
      expect(iconFor(kind)).toBe(POINT_ICONS[kind as keyof typeof POINT_ICONS])
    }
    expect(iconFor('lighthouse')).toBe(POINT_ICONS.site)
  })

  it('draws casing under ink, in the colours it was handed', () => {
    const svg = pointIconSvg('fortress', '#111', '#eee')
    const casing = svg.indexOf('#eee')
    const ink = svg.indexOf('#111')
    expect(casing).toBeGreaterThan(-1)
    expect(ink).toBeGreaterThan(casing) // casing first = painted under
    expect(svg).toContain('viewBox="0 0 16 16"')
  })

  it('the city alone carries a filled centre dot', () => {
    expect(pointIconSvg('city', '#111', '#eee')).toContain('<circle')
    expect(pointIconSvg('mountain', '#111', '#eee')).not.toContain('<circle')
  })

  it('labels kinds for the chip, with a fallback for future kinds', () => {
    expect(kindLabel('fortress')).toBe('Fortress')
    expect(kindLabel('lighthouse')).toBe('Lighthouse')
  })
})

describe('points store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('resolves against the cursor year and the setting', () => {
    const points = usePointsStore()
    const time = useTimeStore()
    const settings = useSettingsStore()
    expect(settings.maxPoints).toBe(POINTS_SHOWN.default)
    time.focusTime(1200)
    expect(points.visible).toHaveLength(10)
    expect(points.visible.map((p) => p.id)).toContain('constantinople')
    settings.maxPoints = 3
    expect(points.visible).toHaveLength(3)
    settings.maxPoints = 0
    expect(points.visible).toEqual([])
  })

  it('moves with the year: different eras, different sets and names', () => {
    const points = usePointsStore()
    const time = useTimeStore()
    time.focusTime(-400)
    const classical = points.visible.map((p) => p.id)
    time.focusTime(1916)
    const modern = points.visible.map((p) => p.id)
    expect(modern).not.toEqual(classical)
    expect(modern).toContain('verdun')
    time.focusTime(1950)
    expect(points.visible.find((p) => p.id === 'constantinople')?.name).toBe('Istanbul')
  })

  it('the chip follows the marker: scrubbing away closes it', () => {
    const points = usePointsStore()
    const time = useTimeStore()
    time.focusTime(1916)
    points.select('verdun')
    expect(points.selected?.id).toBe('verdun')
    expect(points.selected?.from).toBe(1914)
    time.focusTime(1200) // Verdun is a priority-4 fort here: out of the top 10
    expect(points.selected).toBeNull()
    // clicking the same point again closes the chip
    time.focusTime(1916)
    points.select('verdun')
    expect(points.selected).toBeNull()
  })
})
