/**
 * The one zoom ladder.
 *
 * Two things snap a continuously-changing zoom onto discrete steps so the work
 * hanging off it does not re-run every frame: `clusterSpanBucket` (how far
 * apart two events have to be to group) and `scopeRadiusBucket` (how big a
 * circle of ground the query is cut to). Both used to write the ladder out
 * themselves, and viewport.ts documented the fact that they matched — a comment
 * is a poor way to hold two expressions equal, and the match is load-bearing:
 * the scope margin is sized on the assumption that the two agree about what a
 * zoom step is, so a change to one alone would silently shrink the circle that
 * the margin is protecting.
 *
 * Half an octave: `2 ** (n / 2)`, so a factor of ~1.41 between rungs. Fine
 * enough that a step is never a jump, coarse enough that a pinch crosses only a
 * handful of them.
 */

/**
 * Snap to the half-octave ladder.
 *
 * `mode` is the rounding, and the two callers genuinely want different ones:
 *
 *  - `'nearest'` for a threshold, where the point is only to stop the value
 *    changing continuously and either neighbour is equally good;
 *  - `'up'` for a radius, which is a *promise* that everything inside it was
 *    considered. Rounding a promise to nearest can take up to 16% off it, and
 *    what falls out is whatever sat at the edge.
 */
export const halfOctave = (value: number, mode: 'nearest' | 'up' = 'nearest'): number => {
  const rungs = Math.log2(Math.max(1e-6, value)) * 2
  return 2 ** ((mode === 'up' ? Math.ceil(rungs) : Math.round(rungs)) / 2)
}
