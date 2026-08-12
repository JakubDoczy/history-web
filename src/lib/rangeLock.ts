import { clamp, MAX_TIME, MIN_TIME, type Year } from './time'
import { orderSpan, type Span } from './selection'

/**
 * THE RANGE LOCK — how wide a window a click asks for, at the depth it lands at.
 *
 * The reader's complaint was that a click on the rail moved the cursor and left
 * the view where it was, so scrubbing meant clicking, then panning, then zooming
 * to whatever the years they had just picked deserved. What they asked for
 * instead is a window that COMES WITH the click — and, crucially, one that is
 * RELATIVE: *"when looking at millions of years ago, timeline range by default
 * should be much larger than timeline range in current years … near current
 * years something like 1 year back and 5 to the future"*.
 *
 * So the whole rule is one line — a span proportional to how far back the year
 * is, with a floor near the present — and everything else here is the arithmetic
 * of keeping it inside the ends of time.
 *
 *   span = max(FLOOR, k · (PRESENT − year))
 *
 * Why proportional, and not a table of zoom levels per era: because the
 * proportional rule is the one that has no steps in it. A click at 900 ka and a
 * click at 1.1 Ma are the same kind of question and get windows a fifth apart,
 * where any table of ranges has a boundary somewhere and two neighbouring years
 * either side of it get answers that differ by a factor.
 *
 * It also has a property worth stating, because it is why the rail looks the
 * same at every depth: the display warp is asinh about the present, which is
 * logarithmic in (PRESENT − year) once you are more than a couple of centuries
 * back — so a window whose WIDTH IN YEARS is a fixed multiple of that distance
 * has a fixed width IN WARP, i.e. it lands on screen at the same size at 10 ka,
 * at 1 Ma and at 2.5 Ga. Measured, for the defaults below: 0.215 of a warp unit
 * at every depth past about a millennium, on a rail 18.13 units wide.
 * See tests/rangeLock.test.ts.
 */

/**
 * The floor, in years, and where the clicked year sits inside it — the reader's
 * own example, stated as the two numbers it is made of: *"1 year back and 5 to
 * the future"* is a six-year span with the year one sixth of the way in.
 *
 * It exists because the proportional rule alone degenerates at the present:
 * distance 0 is a window of no width, and a click on 2020 would ask for a span
 * of about a year. Below the floor the answer stops being relative and becomes
 * the reader's stated default.
 */
export const LOCK_FLOOR_YEARS = 6
export const LOCK_SPLIT = 1 / 6

/**
 * k — the dimensionless one. How much of the distance back to the present a
 * click asks to see.
 *
 * 0.2, chosen by looking at what the rail actually draws at a ladder of depths
 * — the pictures are /tmp/shots56, and tests/rangeLock.test.ts asserts the
 * boundaries below rather than the constant, so the evidence moves if the era
 * tables do:
 *
 *  · **The named-period lane opens for as far back as there are periods to
 *    name.** The fine lane appears at windows of 2000 years or less
 *    (`SUB_AGE_MAX_SPAN`), and k = 0.2 puts that boundary at a distance of
 *    10 000 years — 7975 BCE, i.e. every entry in SUB_AGES but the first two
 *    millennia of the Neolithic. So a locked click anywhere in recorded
 *    history lands on a rail with the periods drawn on it. At k = 0.3 the
 *    boundary moves to 4642 BCE and four fifths of the Neolithic lose the
 *    lane; at k = 0.1 it moves to 18 ka and opens the lane over eight
 *    millennia of prehistory the table has nothing to put in it.
 *  · **The era strip flips to geology at the depth history runs out.** Bands
 *    switch from the human table to the geological one past a 20 000-year
 *    window (`bandsFor`), i.e. at a distance of 98 ka — deep inside the Stone
 *    Age band, which is the last human-history entry and runs back to 3 Ma.
 *  · **Deep time gets a quarter of the era it is in.** 1 Ma → a 200 ka window
 *    (two glacial cycles); 100 Ma → 20 Ma, a quarter of the Cretaceous;
 *    2.5 Ga → 500 Ma, a third of the Archean. Wide enough to show the era you
 *    clicked into AND its neighbours' edges, which is the reading a deep-time
 *    rail is for. At k = 0.5 the Cretaceous click reaches into the Paleogene
 *    and a 250 Ma click covers three periods, so the strip stops saying where
 *    you are; at k = 0.1 the window at 100 Ma is 10 Ma — an eighth of the
 *    Cretaceous, with no boundary in it, so the rail is a single colour.
 */
export const LOCK_SCALE = 0.2

/** The whole timeline: the formation of Earth to now. What a window is clamped into. */
export const LOCK_DOMAIN: Span = { start: MIN_TIME, end: MAX_TIME }

/** How far back a year is from the present. Zero at and after it — the future
 *  is not history, so it is not distance either. */
export const depthOf = (year: Year, domain: Span = LOCK_DOMAIN): number =>
  Math.max(domain.end - year, 0)

/**
 * The window a locked click on `year` asks for.
 *
 * Clamped into the domain by SLIDING, not by shrinking: a click on 2024 wants
 * six years and there are only two left in front of it, so it gets 2020–2026
 * rather than a squashed 2023–2026. The alternative reads as the rule quietly
 * failing near the present, which is the one place the reader named a number.
 *
 * The clicked year is always inside the result — the rail's standing invariant,
 * and it survives the slide for free: an end that saturates moves the window by
 * at most the part of the span on that side of the year.
 */
export function lockedWindow(
  year: Year,
  k: number = LOCK_SCALE,
  split: number = LOCK_SPLIT,
  domain: Span = LOCK_DOMAIN,
): Span {
  const width = domain.end - domain.start
  const t = clamp(year, domain.start, domain.end)
  const span = Math.min(width, Math.max(LOCK_FLOOR_YEARS, Math.max(0, k) * depthOf(t, domain)))
  const s = Math.min(1, Math.max(0, split))
  let start = t - span * s
  if (start + span > domain.end) start = domain.end - span
  if (start < domain.start) start = domain.start
  return { start, end: start + span }
}

/**
 * Read k and the split back off a window the user made themselves — the drag of
 * a handle, or an era they picked. The lock then goes on answering clicks in
 * THEIR proportions instead of the defaults.
 *
 * Two guards, both about the floor. Near the present the span is the floor
 * rather than anything proportional, so `span / distance` there is not a
 * measurement of the reader's taste but an artefact of how close to now they
 * are — a 6-year band 10 years back would teach k = 0.6 and then ask for
 * 1.5 Ga of window at 2.5 Ga. So a window at a distance the floor governs
 * teaches nothing about k (the split it still teaches, since that is what "1
 * back and 5 forward" is), and what it does teach is clamped to a range whose
 * only job is to keep the next click on a rail at all.
 */
export const LOCK_SCALE_RANGE = { min: 0.002, max: 2 } as const

/** Below this distance from the present the FLOOR is what set the span, so the
 *  span says nothing about k. It is exactly the distance at which the default
 *  rule catches up with the floor: 30 years, i.e. anything since 1996. */
export const LOCK_LEARN_MIN_DEPTH = LOCK_FLOOR_YEARS / LOCK_SCALE

export interface Lock {
  scale: number
  split: number
}

export const DEFAULT_LOCK: Lock = { scale: LOCK_SCALE, split: LOCK_SPLIT }

export function deriveLock(
  window: Span,
  year: Year,
  prev: Lock = DEFAULT_LOCK,
  domain: Span = LOCK_DOMAIN,
): Lock {
  const { start, end } = orderSpan(window.start, window.end)
  const span = end - start
  const depth = depthOf(clamp(year, domain.start, domain.end), domain)
  const scale =
    depth > LOCK_LEARN_MIN_DEPTH && span > 0
      ? Math.min(LOCK_SCALE_RANGE.max, Math.max(LOCK_SCALE_RANGE.min, span / depth))
      : prev.scale
  // The cursor can sit outside a band a handle was dragged past it (the drag
  // wins, and nothing drags the cursor along); the split is then the nearer end.
  const split = span > 0 ? Math.min(1, Math.max(0, (year - start) / span)) : prev.split
  return { scale, split }
}

/** Whether a lock is still the one the app shipped with — what the reset
 *  affordance is offered for, and hidden when there is nothing to reset. */
export const isDefaultLock = (lock: Lock): boolean =>
  lock.scale === DEFAULT_LOCK.scale && lock.split === DEFAULT_LOCK.split
