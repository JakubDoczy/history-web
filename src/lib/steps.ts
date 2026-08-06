import {
  pointTime,
  timeEnd,
  timeExtent,
  timeFrom,
  timeStart,
  type Time,
  type Year,
} from './time'
import { isDrawing, type Drawing, type DrawingSpec } from './drawing'
import { internalLinkIds } from './richtext'

/**
 * STEPS — the authored moments inside one event.
 *
 * Focus mode answers "show me this". A stepped event answers the next question a
 * reader asks of a campaign that ran for six months: *and then what?* The
 * whole of Barbarossa on one map is four hundred thousand square kilometres of
 * ink laid down at once — every front, every pocket, every axis, true of no
 * single day. Steps cut that into the moments a historian would actually name.
 *
 * Four rules, and they are the whole design. The first three are inherited from
 * the stages this generalises; the fourth is what the generalisation added.
 *
 * ---------------------------------------------------------------------------
 * 1. THE OVERVIEW IS THE DEFAULT, AND IT IS EVERYTHING
 * ---------------------------------------------------------------------------
 *
 * Entering focus shows the plan whole, exactly as it did before steps existed.
 * A step is something the reader *steps into* and can always step back out of;
 * it is never what they land on. `resolveFocusInk` (lib/present/ink.ts) with no
 * step id returns the drawing unchanged and untouched — same object, so the
 * renderer's key comparison sees no change at all.
 *
 * ---------------------------------------------------------------------------
 * 2. ONLY THE AUTHORED STEPS ARE SELECTABLE
 * ---------------------------------------------------------------------------
 *
 * This is a list of named moments, not a scrubber. There is no arbitrary day to
 * land on between Smolensk and Kiev, because the data does not know one and
 * inventing it would be the map making a claim the corpus cannot support. The
 * strip in the UI is therefore chips, not a slider: what you can select is
 * exactly what someone wrote down.
 *
 * ---------------------------------------------------------------------------
 * 3. A STEP'S TIME IS MEASURED IN THE SAME SPACE A DRAWING LAYER'S `at` IS
 * ---------------------------------------------------------------------------
 *
 * A drawing layer has carried an `at` since the schema was written (see
 * `DrawingCommon` in lib/drawing.ts) — "a year (1941) or a fraction of the
 * event's span (0..1)" — and a step's time is written in the SAME two forms,
 * because the two are compared against each other: a layer belongs to the step
 * whose window its `at` falls in.
 *
 * Both forms are normalised to a FRACTION before anything is compared
 * (`atFraction`), and that is not an implementation detail. Both exemplars run
 * inside a single year — Barbarossa is dated 1941, D-Day 1944 — so a year-form
 * value cannot separate June from December on either of them, and resolving
 * everything to years first would collapse every step of Barbarossa onto 1941
 * and put every layer in the first window. In fraction space the same data
 * orders correctly, and a multi-year event whose steps are written as years
 * normalises into the same space and orders correctly too.
 *
 * The ambiguity is real and it is inherited, not invented: a value of 0 or 1 on
 * an event spanning the turn of the era is a fraction, not the year. No event in
 * the corpus is in that position, the alternative (a second field, or a sigil)
 * would have to be threaded through the drawing schema as well, and this is the
 * convention the drawing schema already shipped with.
 *
 * ---------------------------------------------------------------------------
 * 4. A STEP IS A TIME **AND A DRAWING**, LIKE THE EVENT IT IS PART OF
 * ---------------------------------------------------------------------------
 *
 * This is what makes a step a small event rather than a filter setting. It
 * carries a `Time` — a point *or a period*, the same variant the event carries
 * (lib/time.ts) — and it may carry a `drawing` of its own, which is drawn ON TOP
 * of the parent's layers that the step's window keeps.
 *
 * Both halves of that matter, and the second is the interesting one. The
 * original design had exactly one way to say "this ink belongs to that moment":
 * put an `at` on a layer of the PARENT's drawing. That works, and every layer of
 * both exemplars is authored that way, but it means a step can only ever
 * *subtract* — it can never draw something the overview does not already show.
 * A step's own drawing is the additive half: an inset, an order of battle, a
 * second front that would be nonsense laid over the whole campaign at once. The
 * two compose (see `resolveFocusInk`), so an event may use either, or both, and
 * a drawing authored before steps existed keeps behaving exactly as it did.
 *
 * The `time` variant is the other half of the same generalisation. A step is
 * usually a moment — "6 June" — but some are plainly a stretch: "the beachhead,
 * 7–30 June" is a period, and saying so lets the panel label it honestly and the
 * validator check both ends. What a period does NOT do is change which layers
 * the step owns: the windows still tile by each step's START (see
 * `stepWindows`), because they must partition the drawing exactly, and two
 * overlapping periods would put one layer in two steps.
 */

/** Where the camera goes when a step is opened. `altitude` in globe radii. */
export interface StepCamera {
  lat: number
  lng: number
  /** Omitted means "keep the height the reader is at" — see `lookAt`. */
  altitude?: number
}

/** One authored step through an event. */
export interface Step {
  /** Unique within its event. The value the UI and the store pass around. */
  id: string
  /** What the chip says, and the heading of the step page. */
  name: string
  /**
   * When it happens, in the dual space rule 3 describes: each end is a year, or
   * a fraction of the event's span. A point for a moment, a period for a stretch.
   */
  time: Time
  /** Optional rich text — the same markup subset a body uses (lib/richtext.ts). */
  page?: string
  /** Optional camera move. Absent leaves the view exactly where the reader put it. */
  camera?: StepCamera
  /**
   * Ink of the step's OWN, drawn over the parent layers its window keeps. See
   * rule 4, and `resolveFocusInk` for the composition.
   */
  drawing?: Drawing
  /**
   * THE STEP IS ANOTHER ITEM: an ENTRANCE rather than a page.
   *
   * A saga's step may be a whole event in its own right — World War II's
   * "Operation Barbarossa" is Barbarossa, which has steps of its own and is a
   * saga itself. Rather than copy that event's prose, its ink and its camera
   * into a step, the step names it, and stepping in *descends*: the focus stack
   * takes the child (`selectStep` in stores/events.ts), which is the same push
   * "Show on map" on a child pin already does. Stepping back out is `focusBack`,
   * the same way out as every other layer of the mode.
   *
   * That is why recursion needed no navigation state: the stack was already a
   * stack. A step that carries this may omit `page`, `drawing` and `camera` —
   * the child supplies all three — and a step that does not carry it behaves
   * exactly as it always has.
   */
  child?: string
  /**
   * Child events to lift while this step is open — ids of events whose `parent`
   * is the stepped event.
   *
   * A pin, not a link: focus mode already puts the event's children on the globe
   * (see `FOCUS_CHILD_CAP` in stores/events.ts), and this says *which of them
   * this moment is about*. Two things follow, and both are the point: a
   * highlighted child is pinned even if the child cap ranked it out, and it is
   * drawn with an accent (see `resolvePinSpec`). Naming a child that does not
   * exist, or one belonging to another event, is a build error rather than a
   * silent no-op.
   */
  highlights?: string[]
}

/**
 * A step as it is written in a chunk file.
 *
 * Two forms of time, and `at` is the one every step in the corpus uses today:
 *
 *     { "at": 0.45 }                 a moment
 *     { "start": 0.3, "end": 0.55 }  a stretch
 *
 * `at` is kept — not as a deprecation, as the short form. Most steps *are*
 * moments, and making them write `start` and `end` with the same number twice
 * would be a worse schema for the common case.
 */
export interface RawStep {
  id: string
  name: string
  /** The moment form. Mutually exclusive with `start`/`end`. */
  at?: number
  /** The stretch form; `end` may be omitted, which makes it a moment again. */
  start?: number
  end?: number
  page?: string
  camera?: StepCamera
  drawing?: Drawing
  child?: string
  highlights?: string[]
}

/** The upper bound of the fraction form; above it a value is a year. */
export const AT_FRACTION_MAX = 1

/** Is this value written as a fraction of the span rather than as a year? */
export const isFractionAt = (at: number) => at >= 0 && at <= AT_FRACTION_MAX

/**
 * A value as a position in 0..1 along the event's span — the one space in which
 * steps and layers are compared (see rule 3 above).
 *
 * A year-form value on a zero-span event (Barbarossa: a point at 1941) has
 * nowhere to land but the beginning, which is why the exemplars are authored as
 * fractions.
 */
export function atFraction(at: number, span: Time): number {
  if (isFractionAt(at)) return at
  const [from, to] = timeExtent(span)
  const length = to - from
  if (length <= 0) return at <= from ? 0 : 1
  return Math.min(1, Math.max(0, (at - from) / length))
}

/**
 * A value as a YEAR — what the time cursor is moved to when a step opens.
 *
 * Inside a single-year event every step resolves to that year, which is correct:
 * the cursor is a statement about the timeline, and the timeline's unit is the
 * year.
 */
export function atYear(at: number, span: Time): Year {
  if (!isFractionAt(at)) return at
  const [from, to] = timeExtent(span)
  return from + at * (to - from)
}

/** Where a step sits in fraction space: the start of its own time. */
export const stepFraction = (step: Step, span: Time): number =>
  atFraction(timeStart(step.time), span)

/**
 * A step's own time as YEARS on the app's timeline — what the panel labels and
 * what the cursor is moved to (its start).
 *
 * The step's time is in the dual space (rule 3); this is the projection of it
 * back onto the event's real years, which is the only space the rest of the app
 * speaks.
 */
export const stepTimeYears = (step: Step, span: Time): Time =>
  timeFrom(atYear(timeStart(step.time), span), atYear(timeEnd(step.time), span))

/* ------------------------------------------------- the boundary: raw steps in */

/**
 * Normalise one authored step. The one place `at` and `start`/`end` become a
 * `Time`; past here nothing in the app knows there were ever two forms.
 */
export function parseStep(raw: RawStep): Step {
  const { at, start, end, ...rest } = raw
  return {
    ...rest,
    time: at !== undefined ? pointTime(at) : timeFrom(start ?? 0, end),
  }
}

export const parseSteps = (raw: readonly RawStep[]): Step[] => raw.map(parseStep)

/* ----------------------------------------------------------- order and windows */

/**
 * Steps in the order they happen.
 *
 * Sorted rather than trusted, because the order the chips read in is the whole
 * of what "in time order" means to the reader, and it must not depend on the
 * order someone happened to type the objects in. Ties keep authored order.
 */
export function orderedSteps(steps: readonly Step[], span: Time): Step[] {
  return steps
    .map((step, i) => ({ step, i, f: stepFraction(step, span) }))
    .sort((a, b) => a.f - b.f || a.i - b.i)
    .map((x) => x.step)
}

/** A step and the half-open span of the event it owns, in fraction space. */
export interface StepWindow {
  step: Step
  from: number
  to: number
}

/**
 * The window each step owns: from its own start up to (not including) the next
 * step's.
 *
 * BY START, even for a period step. The windows have to partition the parent's
 * layers exactly — every dated layer in one step, none in two — and a period's
 * own end cannot be that boundary without either leaving a gap (a layer between
 * one step's end and the next one's start would belong to nothing) or
 * overlapping (two steps claiming the same layer). So a period says how long the
 * moment lasted, which the panel shows and the validator checks, and the
 * *ownership* of ink stays a tiling by start. This is the one place the two
 * halves of rule 4 have to be told apart, and it is worth the paragraph.
 *
 * The two ends are open on purpose. The FIRST window opens at -Infinity so that
 * anything dated before the first named moment still belongs to it — the
 * preliminaries of a campaign are part of its opening, not of nothing — and
 * the LAST closes at +Infinity so that the high-water mark of a campaign belongs
 * to its final step however it was dated. Without both, a layer could fall
 * between the authored moments and vanish from every step while still being on
 * the overview, which reads as a rendering fault rather than as a statement.
 */
export function stepWindows(steps: readonly Step[], span: Time): StepWindow[] {
  const ordered = orderedSteps(steps, span)
  return ordered.map((step, i) => ({
    step,
    from: i === 0 ? -Infinity : stepFraction(step, span),
    to: i === ordered.length - 1 ? Infinity : stepFraction(ordered[i + 1], span),
  }))
}

/**
 * "Which step owns this `at`" as a reusable lookup: build the windows once, then
 * answer any number of times.
 *
 * The callers below — `stepAt`, `layerInStep` and `resolveFocusInk` — each used
 * to write the window comparison out for themselves, which is three copies of
 * the rule that decides what is on the map. They must agree exactly (a layer
 * that answers one way to the strip and another way to the renderer is a chip
 * that filters the plan to something nobody authored), so they share one.
 */
export function stepOwner(
  steps: readonly Step[],
  span: Time,
): (at: number) => Step | undefined {
  const windows = stepWindows(steps, span)
  return (at) => {
    const f = atFraction(at, span)
    return windows.find((w) => f >= w.from && f < w.to)?.step
  }
}

/** Which step a moment falls in — `undefined` when there are no steps. */
export function stepAt(steps: readonly Step[], at: number, span: Time): Step | undefined {
  return stepOwner(steps, span)(at)
}

/**
 * The predicate a step's ink is filtered with, and the whole of the rule in one
 * line — shared with `layerInStep` so the two cannot answer differently.
 *
 * A layer with no `at` at all is TIMELESS and belongs to every step. That is the
 * load-bearing half: the three army-group axes of Barbarossa are the shape of
 * the whole campaign and are true of every month of it, so they stay on the map
 * while the fronts and the pockets come and go around them. It is also what
 * keeps the feature backward compatible — a drawing authored before steps
 * existed renders identically in every step.
 */
export const keepsLayer =
  (stepId: string, owner: (at: number) => Step | undefined) =>
  (layer: DrawingSpec): boolean =>
    layer.at === undefined || owner(layer.at)?.id === stepId

/** Does this layer belong in the step with this id? */
export const layerInStep = (
  layer: DrawingSpec,
  stepId: string,
  steps: readonly Step[],
  span: Time,
): boolean => keepsLayer(stepId, stepOwner(steps, span))(layer)

/* ------------------------------------------------------------ validation */

/** Ids are lowercase kebab, like every other id in the corpus. */
export const STEP_ID = /^[a-z0-9][a-z0-9-]*$/

/**
 * Every markdown link in a body, complete ones only — the denominator of the
 * markup check below.
 */
const COMPLETE_LINKS = /\[(.+?)\]\((?:(?:item|event):[\w-]+|https?:(?:[^\s()]|\([^\s()]*\))+)\)/g

/**
 * Is this rich text well formed?
 *
 * `renderRichText` cannot fail — anything it does not recognise falls through as
 * escaped prose — so "valid markup" has to mean something a renderer would never
 * complain about: every `](` in the text is part of a link the renderer will
 * actually turn into an anchor. A page whose link is missing its scheme, or
 * whose id has a stray character in it, ships as visible bracket soup, and that
 * is exactly the failure a build check is for.
 */
export function markupProblems(text: string): string[] {
  const opens = (text.match(/\]\(/g) ?? []).length
  const links = (text.match(COMPLETE_LINKS) ?? []).length
  return opens === links
    ? []
    : [`has ${opens - links} malformed link(s) — every "](" must close a link the renderer knows`]
}

/** Internal link targets in step pages — checked against the corpus by the data test. */
export const stepPageLinkIds = (steps: readonly RawStep[]): string[] =>
  steps.flatMap((s) => (s.page ? internalLinkIds(s.page) : []))

/** Is this one authored step, structurally? The runtime twin of `validate_steps`. */
export function isRawStep(s: unknown): s is RawStep {
  if (!s || typeof s !== 'object') return false
  const v = s as Record<string, unknown>
  if (typeof v.id !== 'string' || !STEP_ID.test(v.id)) return false
  if (typeof v.name !== 'string' || !v.name) return false
  // exactly one of the two time forms, and every number of it finite
  const moment = v.at !== undefined
  const stretch = v.start !== undefined
  if (moment === stretch) return false
  if (moment && !(typeof v.at === 'number' && Number.isFinite(v.at))) return false
  if (stretch) {
    if (!(typeof v.start === 'number' && Number.isFinite(v.start))) return false
    if (v.end !== undefined && !(typeof v.end === 'number' && Number.isFinite(v.end))) return false
    if (typeof v.end === 'number' && v.end < (v.start as number)) return false
  }
  if (v.page !== undefined && (typeof v.page !== 'string' || !v.page)) return false
  if (v.drawing !== undefined && !isDrawing(v.drawing)) return false
  if (v.child !== undefined && (typeof v.child !== 'string' || !v.child)) return false
  if (v.highlights !== undefined) {
    if (!Array.isArray(v.highlights) || !v.highlights.length) return false
    if (!v.highlights.every((h) => typeof h === 'string' && h.length > 0)) return false
  }
  if (v.camera !== undefined) {
    const c = v.camera as Record<string, unknown>
    if (!c || typeof c !== 'object') return false
    if (typeof c.lat !== 'number' || Math.abs(c.lat) > 90) return false
    if (typeof c.lng !== 'number' || Math.abs(c.lng) > 180) return false
    if (c.altitude !== undefined && !(typeof c.altitude === 'number' && c.altitude > 0)) return false
  }
  return true
}

/**
 * Everything wrong with an event's steps, as sentences — `[]` when it is sound,
 * and the shared answer behind the build script's check, the contract test's,
 * and the runtime guard's.
 *
 * It reads the RAW event, because that is what the build script and the data
 * test hold: the point of a validator is to catch what the parser would
 * otherwise have to guess at.
 *
 * The rules that are about the EVENT rather than about the step are the ones
 * worth having a validator for at all: ids unique *per event*, a year-form time
 * inside the event's own span, and a highlight naming a real child. A step dated
 * outside the thing it is a step of is not a typo the renderer can absorb — it
 * silently owns a window no layer can fall in.
 */
export function stepProblems(
  e: {
    id?: string
    start: Year
    end?: Year
    steps?: readonly RawStep[]
  },
  /** Ids of this event's children, when the caller knows them — see `highlights`. */
  childIds?: ReadonlySet<string>,
  /** Every id in the corpus, when the caller knows them — see `Step.child`. */
  itemIds?: ReadonlySet<string>,
): string[] {
  const { steps } = e
  if (steps === undefined) return []
  if (!Array.isArray(steps) || !steps.length)
    return ['steps must be a non-empty list — drop the field instead']
  const [from, to] = timeExtent(timeFrom(e.start, e.end))
  const out: string[] = []
  const seen = new Set<string>()
  for (const [i, s] of steps.entries()) {
    const where = `step ${i}`
    if (!isRawStep(s)) {
      out.push(`${where} is not a valid step`)
      continue
    }
    if (seen.has(s.id)) out.push(`${where}: duplicate step id "${s.id}"`)
    seen.add(s.id)
    // Both ends of the time, whichever form it was written in: a period whose
    // end falls outside the event is exactly as wrong as a point that does.
    for (const v of [s.at, s.start, s.end])
      if (v !== undefined && !isFractionAt(v) && (v < from || v > to))
        out.push(`${where} (${s.id}): ${v} is outside the event's span ${from}..${to}`)
    for (const p of markupProblems(s.page ?? '')) out.push(`${where} (${s.id}) page ${p}`)
    // An entrance descends into the child. Into ITSELF it would descend for
    // ever, which is the one cycle a single event can hold on its own; the rest
    // of the acyclicity check is a walk over the corpus (build_event_chunks.py).
    if (s.child !== undefined) {
      if (s.child === e.id) out.push(`${where} (${s.id}): descends into its own event`)
      else if (itemIds && !itemIds.has(s.child))
        out.push(`${where} (${s.id}): descends into "${s.child}", which does not exist`)
    }
    for (const h of s.highlights ?? [])
      if (childIds && !childIds.has(h))
        out.push(`${where} (${s.id}): highlights "${h}", which is not a child of this event`)
  }
  return out
}
