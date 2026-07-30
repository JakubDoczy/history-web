import { describe, it, expect } from 'vitest'
import {
  eraAt,
  bandsFor,
  erasOverlapping,
  spanEraLabel,
  GEOLOGIC,
  HISTORICAL,
} from '../src/lib/eras'

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
})

describe('eraAt', () => {
  it.each([
    [-4.2e9, 'Hadean'],
    [-250e6, 'Triassic'],
    [-66e6 + 1, 'Paleogene'],
    [-2000, 'Bronze Age'],
    [-1000, 'Iron Age'],
    [1200, 'Medieval'],
    [2026, 'Contemporary'],
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
