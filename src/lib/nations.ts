import type { Year } from './time'

/** Ring in GeoJSON order: [lng, lat]. Need not be explicitly closed. */
export type Ring = [number, number][]

export interface NationKeyframe {
  time: Year
  ring: Ring
}

export interface Nation {
  id: string
  name: string
  color: string // hex like '#c33'
  end?: Year // nation ceases to exist (last keyframe holds until then)
  /** Snapshots sorted by time; borders hold from one keyframe to the next (step semantics). */
  keyframes: NationKeyframe[]
}

/** Borders in force at time t (hold-last semantics), or undefined outside existence. */
export function activeKeyframe(n: Nation, t: Year): NationKeyframe | undefined {
  if (n.end !== undefined && t > n.end) return undefined
  let cur: NationKeyframe | undefined
  for (const k of n.keyframes) {
    if (k.time > t) break
    cur = k
  }
  return cur
}

/** Planar shoelace area — an approximation, used only to rank extents. */
export const ringArea = (ring: Ring): number =>
  Math.abs(
    ring.reduce((sum, [x, y], i) => {
      const [nx, ny] = ring[(i + 1) % ring.length]
      return sum + x * ny - nx * y
    }, 0) / 2,
  )

/**
 * Largest and smallest extent among keyframes active at any point in [start, end].
 * First-pass approximation: extremes are picked among snapshots, not true unions/intersections.
 */
export function extremes(n: Nation, start: Year, end: Year): { max?: NationKeyframe; min?: NationKeyframe } {
  const existEnd = n.end ?? Infinity
  const active = n.keyframes.filter((k, i) => {
    const until = Math.min(n.keyframes[i + 1]?.time ?? Infinity, existEnd)
    return k.time <= Math.min(end, existEnd) && until >= start
  })
  if (!active.length) return {}
  const byArea = [...active].sort((a, b) => ringArea(a.ring) - ringArea(b.ring))
  return { min: byArea[0], max: byArea[byArea.length - 1] }
}
