import { describe, it, expect } from 'vitest'
import {
  eraAt,
  bandsFor,
  subBandsFor,
  subLaneOpen,
  erasOverlapping,
  spanEraLabel,
  GEOLOGIC,
  HISTORICAL,
  SUB_AGES,
  SUB_AGE_MAX_SPAN,
} from '../src/lib/eras'
import { MIN_TIME, MAX_TIME } from '../src/lib/time'

describe('era tables', () => {
  it.each([
    ['GEOLOGIC', GEOLOGIC],
    ['HISTORICAL', HISTORICAL],
  ])('%s is contiguous and ordered', (_, table) => {
    for (let i = 1; i < table.length; i++) {
      expect(table[i].start).toBe(table[i - 1].end)
      expect(table[i].end).toBeGreaterThan(table[i].start)
    }
  })

  it.each([
    ['GEOLOGIC', GEOLOGIC],
    ['HISTORICAL', HISTORICAL],
    ['SUB_AGES', SUB_AGES],
  ])('%s ends at the present, never in the future', (_, table) => {
    // (GEOLOGIC opens before MIN_TIME — the Hadean predates the Earth being a
    // body at all; the display clamps it. The end is what matters here.)
    for (const e of table) expect(e.end, e.name).toBeLessThanOrEqual(MAX_TIME)
    expect(table[table.length - 1].end).toBe(MAX_TIME)
  })
})

describe('SUB_AGES', () => {
  // The lane is one row deep, so two periods that share a year would paint over
  // each other. Curation, not layout, is what keeps that from happening.
  it('is ordered and never overlaps itself (one lane, gaps allowed)', () => {
    for (let i = 0; i < SUB_AGES.length; i++) {
      expect(SUB_AGES[i].end).toBeGreaterThan(SUB_AGES[i].start)
      if (i) expect(SUB_AGES[i].start).toBeGreaterThanOrEqual(SUB_AGES[i - 1].end)
    }
  })

  // The tier only earns its row by being finer than the one above it.
  it('is finer than the historical tier it annotates', () => {
    for (const s of SUB_AGES) {
      const eras = erasOverlapping(s.start, s.end)
      expect(eras.length, s.name).toBeGreaterThan(0)
      for (const e of eras) expect(s.end - s.start, s.name).toBeLessThan(e.end - e.start)
    }
  })

  it('gives neighbours distinct colours', () => {
    for (let i = 1; i < SUB_AGES.length; i++) {
      expect(SUB_AGES[i].color).not.toBe(SUB_AGES[i - 1].color)
    }
    expect(new Set(SUB_AGES.map((e) => e.name)).size).toBe(SUB_AGES.length)
  })

  it('covers antiquity as well as the modern centuries', () => {
    const names = SUB_AGES.map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['Pax Romana', 'Hellenistic Period']))
    expect(SUB_AGES.filter((e) => e.end < 0).length).toBeGreaterThanOrEqual(5)
    expect(SUB_AGES.filter((e) => e.start > 1500).length).toBeGreaterThanOrEqual(8)
  })
})

describe('subBandsFor', () => {
  it('stays out of the way until the window is narrow enough', () => {
    expect(subBandsFor(-4e9, MAX_TIME)).toEqual([])
    expect(subBandsFor(-550, MAX_TIME)).toEqual([]) // the home window: no lane
    expect(subBandsFor(1000, 1000 + SUB_AGE_MAX_SPAN + 1)).toEqual([])
    expect(subBandsFor(1900, 1900 + SUB_AGE_MAX_SPAN).length).toBeGreaterThan(0)
  })

  it('returns only the periods the window touches, in order', () => {
    expect(subBandsFor(1900, 1960).map((e) => e.name)).toEqual([
      'Victorian Era',
      'World War I',
      'Roaring Twenties',
      'Great Depression',
      'World War II',
      'Cold War',
    ])
    expect(subBandsFor(800, 1000).map((e) => e.name)).toEqual(['Viking Age'])
    expect(subBandsFor(-200, -100)).toEqual([
      SUB_AGES.find((e) => e.name === 'Hellenistic Period'),
    ])
  })

  it('has nothing to show in an unnamed stretch — the lane may be empty', () => {
    expect(subBandsFor(1650, 1680)).toEqual([]) // between Reformation and Enlightenment
    expect(subBandsFor(-12_000, -11_000)).toEqual([]) // before the table starts
  })

  // ...but the row itself stays: panning across a gap must not shunt the ruler.
  it('keeps the lane open across an unnamed stretch', () => {
    expect(subLaneOpen(1650, 1680)).toBe(true)
    expect(subLaneOpen(-12_000, -11_000)).toBe(true)
    expect(subLaneOpen(1600, 1700)).toBe(true)
    expect(subLaneOpen(-550, MAX_TIME)).toBe(false) // the home window
    expect(subLaneOpen(MIN_TIME, MAX_TIME)).toBe(false)
  })

  it('runs the fine lane up to the present too', () => {
    const last = subBandsFor(MAX_TIME - 50, MAX_TIME)
    expect(last[last.length - 1].name).toBe('Information Age')
    expect(last[last.length - 1].end).toBe(MAX_TIME)
  })
})

describe('eraAt', () => {
  it.each([
    [-4.2e9, 'Hadean'],
    [-250e6, 'Triassic'],
    [-66e6 + 1, 'Paleogene'],
    [-2000, 'Bronze Age'],
    [-1000, 'Iron Age'],
    [1200, 'Medieval'],
    [MAX_TIME - 1, 'Contemporary'],
  ])('%d → %s', (t, name) => expect(eraAt(t)?.name).toBe(name))
})

describe('bandsFor', () => {
  it('shows geology when zoomed out, human periods when zoomed in', () => {
    expect(bandsFor(-4e9, 2000).some((e) => e.name === 'Jurassic')).toBe(true)
    expect(bandsFor(1500, 2000).map((e) => e.name)).toEqual(
      expect.arrayContaining(['Early Modern', 'Industrial', 'Contemporary']),
    )
  })
  it('returns only bands overlapping the window', () => {
    expect(bandsFor(1600, 1700)).toEqual([HISTORICAL.find((e) => e.name === 'Early Modern')])
  })
})

describe('erasOverlapping / spanEraLabel', () => {
  it('names a span that is exactly one era', () => {
    expect(spanEraLabel(500, 1500)).toBe('Medieval')
    expect(erasOverlapping(500, 1500).map((e) => e.name)).toEqual(['Medieval'])
  })
  it('names a run of eras by its ends', () => {
    expect(spanEraLabel(500, 1945)).toBe('Medieval – Industrial')
    expect(erasOverlapping(500, 1945).map((e) => e.name)).toEqual([
      'Medieval',
      'Early Modern',
      'Industrial',
    ])
  })
  it('reads a backwards span the same way', () => {
    expect(spanEraLabel(1945, 500)).toBe('Medieval – Industrial')
  })
  it('falls back to deep time before the human table', () => {
    expect(spanEraLabel(-250e6, -4e6)).toBe('Deep time')
  })
})

import { eraOfSubAge, subErasIn } from '../src/lib/eras'

/**
 * The era menu's second level. The thread of periods is curated to one lane and
 * does *not* line up with the band above it, so "which era is this in" has to be
 * a decision rather than a containment test — see `eraOfSubAge`.
 */
describe('sub-ages under their era', () => {
  it('files every sub-age under exactly one era, losing none of them', () => {
    const filed = HISTORICAL.flatMap(subErasIn)
    expect(filed.length).toBe(SUB_AGES.length)
    expect(new Set(filed.map((s) => s.name)).size).toBe(SUB_AGES.length)
  })

  it('files the ones that straddle an era boundary too', () => {
    // containment would drop all three of these on the floor
    expect(eraOfSubAge(SUB_AGES.find((s) => s.name === 'Migration Period')!)?.name).toBe('Classical')
    expect(eraOfSubAge(SUB_AGES.find((s) => s.name === 'Renaissance')!)?.name).toBe('Medieval')
    expect(eraOfSubAge(SUB_AGES.find((s) => s.name === 'Neolithic')!)?.name).toBe('Stone Age')
  })

  it('puts each period in the era it is mostly in', () => {
    for (const s of SUB_AGES) {
      const era = eraOfSubAge(s)!
      const overlap = Math.min(s.end, era.end) - Math.max(s.start, era.start)
      expect(overlap * 2, s.name).toBeGreaterThan(s.end - s.start)
    }
  })

  it('keeps each era s list in time order, and short enough to be a menu', () => {
    for (const e of HISTORICAL) {
      const subs = subErasIn(e)
      for (let i = 1; i < subs.length; i++)
        expect(subs[i].start, `${e.name}: ${subs[i].name}`).toBeGreaterThanOrEqual(subs[i - 1].start)
      // one era open at a time is the menu's compactness rule; six rows is the
      // most any era costs (Industrial), which fits a phone without scrolling
      expect(subs.length, e.name).toBeLessThanOrEqual(6)
    }
  })

  it('leaves an era with no named periods a leaf, rather than an empty level', () => {
    for (const e of HISTORICAL) expect(Array.isArray(subErasIn(e))).toBe(true)
    expect(subErasIn({ name: 'Nowhere', start: 3000, end: 3001, color: '#000' })).toEqual([])
  })

  // The second level exists to be picked from, and picking is `selectEra`,
  // which fits the window to whatever span it is handed.
  it('offers spans that are real, ordered and inside the timeline', () => {
    for (const s of SUB_AGES) {
      expect(s.end, s.name).toBeGreaterThan(s.start)
      expect(s.start, s.name).toBeGreaterThanOrEqual(MIN_TIME)
      expect(s.end, s.name).toBeLessThanOrEqual(MAX_TIME)
    }
  })
})
