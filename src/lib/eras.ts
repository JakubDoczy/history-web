import type { Year } from './time'

export interface Era {
  name: string
  start: Year
  end: Year
  color: string
}

/** ICS eras/periods, colors desaturated from the standard geological palette. */
export const GEOLOGIC: Era[] = [
  { name: 'Hadean', start: -4.567e9, end: -4.031e9, color: '#4a2b3d' },
  { name: 'Archean', start: -4.031e9, end: -2.5e9, color: '#6d3352' },
  { name: 'Proterozoic', start: -2.5e9, end: -538.8e6, color: '#8e4361' },
  { name: 'Cambrian', start: -538.8e6, end: -485.4e6, color: '#4c7a6a' },
  { name: 'Ordovician', start: -485.4e6, end: -443.8e6, color: '#3f7f74' },
  { name: 'Silurian', start: -443.8e6, end: -419.2e6, color: '#4d8a74' },
  { name: 'Devonian', start: -419.2e6, end: -358.9e6, color: '#5c8a63' },
  { name: 'Carboniferous', start: -358.9e6, end: -298.9e6, color: '#5a7f7a' },
  { name: 'Permian', start: -298.9e6, end: -251.9e6, color: '#7a6a55' },
  { name: 'Triassic', start: -251.9e6, end: -201.4e6, color: '#6b5a7d' },
  { name: 'Jurassic', start: -201.4e6, end: -145e6, color: '#3f7f8c' },
  { name: 'Cretaceous', start: -145e6, end: -66e6, color: '#5c8a5c' },
  { name: 'Paleogene', start: -66e6, end: -23.03e6, color: '#8a7a4a' },
  { name: 'Neogene', start: -23.03e6, end: -2.58e6, color: '#9a8a45' },
  { name: 'Quaternary', start: -2.58e6, end: 2100, color: '#a8964f' },
]

/** Human-history periods, shown instead of geology when zoomed in. */
export const HISTORICAL: Era[] = [
  { name: 'Stone Age', start: -3e6, end: -3300, color: '#5a5f6d' },
  { name: 'Bronze Age', start: -3300, end: -1200, color: '#7d6242' },
  { name: 'Iron Age', start: -1200, end: -550, color: '#67564d' },
  { name: 'Classical', start: -550, end: 500, color: '#6d6a4a' },
  { name: 'Medieval', start: 500, end: 1500, color: '#4f5a72' },
  { name: 'Early Modern', start: 1500, end: 1800, color: '#5f5273' },
  { name: 'Industrial', start: 1800, end: 1945, color: '#6a4f4f' },
  { name: 'Contemporary', start: 1945, end: 2100, color: '#48707a' },
]

const within = (e: Era, t: Year) => t >= e.start && t < e.end

/** Finest-grained named era containing t (historical wins inside its range). */
export const eraAt = (t: Year): Era | undefined =>
  HISTORICAL.find((e) => within(e, t)) ?? GEOLOGIC.find((e) => within(e, t))

/** Bands to draw for a window: human periods when zoomed in, geology otherwise. */
export const bandsFor = (start: Year, end: Year): Era[] => {
  const scale = end - start <= 20_000 ? HISTORICAL : GEOLOGIC
  return scale.filter((e) => e.start < end && e.end > start)
}
