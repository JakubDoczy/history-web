import type { Year } from './time'
import type { RenderMode } from './present/mode'

/**
 * POINTS — named places, as context under the events.
 *
 * A point is not an event. An event happens and is over; a point *is there* —
 * a city, a fortress, a volcano — for as long as history has a reason to name
 * it. So a point is culled by nothing an event is culled by: it is outside the
 * top-N event budget, outside the clustering, outside the tag filters. Its own
 * rule is the era table it carries: a point EXISTS only inside its era
 * entries, and how much it matters (and even what it is called) changes from
 * era to era. Constantinople is a top point from 330 to well past 1453 and a
 * modest Greek colony called Byzantion before; Carthage matters enormously
 * until -146 and stops existing at 698; Vesuvius is always there and almost
 * never worth a marker — except around 79.
 *
 * Everything in this file is pure: the data shapes, the year → visible-set
 * resolution, and the icon geometry. The DOM/three half lives in
 * lib/pointsLayer.ts; the reactive glue in stores/points.ts.
 */

/* ---------------------------------------------------------------- the data */

/**
 * What a point can be. An extensible union: the six known kinds each carry
 * their own icon (see `POINT_ICONS`); an unknown kind is legal data and falls
 * back to the site lozenge, so the dataset can grow a kind before the renderer
 * learns to draw it.
 */
export type PointKind = 'city' | 'fortress' | 'volcano' | 'mountain' | 'strait' | 'site'

/**
 * One stretch of a point's existence. Half-open — the point exists for
 * `from <= year < to` — so consecutive entries meet without overlapping and
 * without double-counting the boundary year. `to` omitted means "to the
 * present". `priority` ranks the point *within this era*: 1 is a place the
 * era's map is incomplete without, 5 is a place that merely exists. A per-era
 * `name` is how renames are said (Byzantion → Constantinople → Istanbul);
 * absent, the point's own name stands.
 */
export interface PointEra {
  from: Year
  to?: Year
  priority: number
  name?: string
}

/** A point as authored in src/data/points.json. */
export interface HistoricalPoint {
  id: string
  name: string
  /** Typed loosely on purpose — see `PointKind`. */
  kind: string
  /** GeoJSON order: [lng, lat]. */
  pos: [number, number]
  /** One line for the info chip; never prose. */
  note?: string
  eras: PointEra[]
}

/** A point resolved at a year: what to draw, where, called what. */
export interface ResolvedPoint {
  id: string
  /** The era-resolved name — the point's own unless the era renames it. */
  name: string
  kind: string
  lat: number
  lng: number
  /** The winning era's priority (1 = top). */
  priority: number
  /** The winning era's window, for the info chip. */
  from: Year
  to?: Year
  note?: string
}

/**
 * Bounds of the "points shown" setting; the store and the settings UI share
 * them, exactly as `MAX_EVENTS` does. Zero is a real value and means "no
 * points layer at all".
 */
export const POINTS_SHOWN = { min: 0, max: 25, step: 1, default: 10 } as const

/** The setting, made safe to use as a slice length whatever wrote it. */
export const clampShown = (n: number): number =>
  Math.round(Math.min(POINTS_SHOWN.max, Math.max(POINTS_SHOWN.min, Number.isFinite(n) ? n : 0)))

/**
 * The era containing `year`, or `undefined` — which means the point does not
 * exist at that year and gets no marker.
 *
 * Where entries overlap (they should not, but authored data drifts), the
 * BEST-priority match wins rather than the first, so an overlap degrades into
 * "the point is as important as its most important claim" instead of into
 * whichever line was written higher up.
 */
export function eraAt(p: HistoricalPoint, year: Year): PointEra | undefined {
  let best: PointEra | undefined
  for (const e of p.eras) {
    if (year < e.from || (e.to !== undefined && year >= e.to)) continue
    if (!best || e.priority < best.priority) best = e
  }
  return best
}

/**
 * THE RESOLUTION: at year Y, the candidates are the points whose era table
 * contains Y; they are ranked by that era's priority and the top N are shown.
 *
 * The sort is deliberately total — priority first, then id — so a scrub across
 * a century in which nothing changes produces the identical array order every
 * time, and two points that tie never swap places between frames. That is the
 * whole anti-flicker mechanism, and it costs nothing: the dataset is ~50
 * entries, so this is O(n log n) over almost nothing, safe to re-run on every
 * cursor change.
 */
export function resolvePointsAt(
  points: readonly HistoricalPoint[],
  year: Year,
  shown: number,
): ResolvedPoint[] {
  const n = clampShown(shown)
  if (n === 0) return []
  const hits: { p: HistoricalPoint; e: PointEra }[] = []
  for (const p of points) {
    const e = eraAt(p, year)
    if (e) hits.push({ p, e })
  }
  hits.sort((a, b) => a.e.priority - b.e.priority || (a.p.id < b.p.id ? -1 : 1))
  return hits.slice(0, n).map(({ p, e }) => ({
    id: p.id,
    name: e.name ?? p.name,
    kind: p.kind,
    lng: p.pos[0],
    lat: p.pos[1],
    priority: e.priority,
    from: e.from,
    to: e.to,
    note: p.note,
  }))
}

/**
 * The dataset, checked on the way in rather than trusted: a malformed entry is
 * dropped (and named on the console in dev) instead of becoming a marker at
 * NaN,NaN. The shipped file is additionally held to this shape by
 * tests/points.test.ts, so in practice this is armour against future edits.
 */
export function parsePoints(raw: unknown): HistoricalPoint[] {
  if (!Array.isArray(raw)) return []
  const out: HistoricalPoint[] = []
  const seen = new Set<string>()
  for (const r of raw as HistoricalPoint[]) {
    const ok =
      typeof r?.id === 'string' &&
      r.id.length > 0 &&
      !seen.has(r.id) &&
      typeof r.name === 'string' &&
      typeof r.kind === 'string' &&
      Array.isArray(r.pos) &&
      r.pos.length === 2 &&
      Number.isFinite(r.pos[0]) &&
      Number.isFinite(r.pos[1]) &&
      Math.abs(r.pos[0]) <= 180 &&
      Math.abs(r.pos[1]) <= 90 &&
      Array.isArray(r.eras) &&
      r.eras.length > 0 &&
      r.eras.every(
        (e) =>
          Number.isFinite(e?.from) &&
          (e.to === undefined || (Number.isFinite(e.to) && e.to > e.from)) &&
          Number.isInteger(e.priority) &&
          e.priority >= 1,
      )
    if (ok) {
      seen.add(r.id)
      out.push(r)
    } else if (import.meta.env?.DEV) {
      console.warn('points: dropped malformed entry', r)
    }
  }
  return out
}

/* ------------------------------------------------------------- presentation */

/**
 * When labels appear: once the framed span (lib/detailImagery.ts,
 * `viewSpanDeg`) is at most this many degrees of ground — roughly "a continent
 * fills the frame". At world view (~147°) ten labels over one hemisphere read
 * as clutter over the event pins, which are the content; a hovered point shows
 * its label at any zoom (CSS), so nothing is unreachable.
 */
export const POINT_LABEL_MAX_SPAN_DEG = 55

/** How the chip and the tooltip say what a point is. */
export const KIND_LABEL: Record<PointKind, string> = {
  city: 'City',
  fortress: 'Fortress',
  volcano: 'Volcano',
  mountain: 'Mountain',
  strait: 'Strait',
  site: 'Site',
}

export const kindLabel = (kind: string): string =>
  (KIND_LABEL as Record<string, string>)[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1)

/**
 * The muted ink a point is drawn in, per ground. A point is context, not
 * content: quieter than the drawing labels' white, and on paper it is the
 * map's own pen. The casing is the ground's tone, same job as the map-text
 * halo — the icon has to survive snowfield, ocean and parchment alike.
 */
export const POINT_INK: Record<RenderMode, { ink: string; casing: string }> = {
  realistic: { ink: '#d9e2ee', casing: 'rgba(6, 10, 18, 0.85)' },
  schematic: { ink: '#3a3122', casing: 'rgba(240, 232, 210, 0.9)' },
}

/**
 * ICON GEOMETRY — one mark per kind, drawn as line art in a 16×16 box.
 *
 * The vocabulary is the brief's: a city is a circled dot (a settlement mark on
 * any survey map), a fortress a crenellated bastion outline, a volcano a
 * triangle with a notch bitten out of the rim, a mountain the plain triangle,
 * a strait two facing chevrons (the water squeezed between them), a site a
 * small lozenge. All stroke, no fill (bar the city's dot), so the same
 * geometry works in both inks; every path is drawn twice, casing under ink,
 * which is the halo that keeps it legible on any ground.
 */
export interface PointIcon {
  paths: string[]
  /** A filled dot, [cx, cy, r] — the city's centre. */
  dot?: [number, number, number]
}

export const POINT_ICONS: Record<PointKind, PointIcon> = {
  city: { paths: ['M8 3.4A4.6 4.6 0 1 1 8 12.6A4.6 4.6 0 1 1 8 3.4Z'], dot: [8, 8, 1.7] },
  fortress: {
    paths: ['M3.6 12.6V6.4h1.9V4.6h1.7v1.8h1.6V4.6h1.7v1.8h1.9v6.2Z'],
  },
  volcano: { paths: ['M2.8 12.8L6.6 4.4L8 6.6L9.4 4.4L13.2 12.8Z'] },
  mountain: { paths: ['M3 12.8L8 4L13 12.8Z'] },
  // the apexes stop short of meeting: the gap between them IS the water, and
  // two chevrons that touch read as an X at 16 px (photographed and adjusted)
  strait: { paths: ['M4.2 4L7 8L4.2 12', 'M11.8 4L9 8L11.8 12'] },
  site: { paths: ['M8 3.2L12.8 8L8 12.8L3.2 8Z'] },
}

/** The icon for a kind — an unknown kind gets the site lozenge, not a crash. */
export const iconFor = (kind: string): PointIcon =>
  (POINT_ICONS as Record<string, PointIcon>)[kind] ?? POINT_ICONS.site

/**
 * The icon as inline SVG: every path stroked twice (casing then ink), the
 * city's dot filled last. No rasters, no requests — the same rule as the pin
 * glyph registry (lib/present/pin.ts).
 */
export function pointIconSvg(kind: string, ink: string, casing: string, size = 16): string {
  const icon = iconFor(kind)
  const path = (d: string, stroke: string, w: number) =>
    `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}"` +
    ` stroke-linecap="round" stroke-linejoin="round"/>`
  const dot = icon.dot
    ? `<circle cx="${icon.dot[0]}" cy="${icon.dot[1]}" r="${icon.dot[2]}" fill="${ink}"/>`
    : ''
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">` +
    icon.paths.map((d) => path(d, casing, 3.4)).join('') +
    icon.paths.map((d) => path(d, ink, 1.5)).join('') +
    dot +
    `</svg>`
  )
}
