import type { Year } from './time'
import type { Drawing, DrawingSpec } from './drawing'
import { internalLinkIds } from './richtext'

/**
 * STAGED FOCUS — the authored steps through one event.
 *
 * Focus mode answers "show me this". A staged event answers the next question a
 * reader asks of an operation that ran for six months: *and then what?* The
 * whole of Barbarossa on one map is four hundred thousand square kilometres of
 * ink laid down at once — every front, every pocket, every axis, true of no
 * single day. Stages cut that into the moments a historian would actually name.
 *
 * Three rules, and they are the whole design.
 *
 * ---------------------------------------------------------------------------
 * 1. THE OVERVIEW IS THE DEFAULT, AND IT IS EVERYTHING
 * ---------------------------------------------------------------------------
 *
 * Entering focus shows the plan whole, exactly as it did before stages existed.
 * A stage is something the reader *steps into* and can always step back out of;
 * it is never what they land on. `drawingForStage` with no stage id returns the
 * drawing unchanged and untouched — same object, so the renderer's key
 * comparison sees no change at all.
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
 * 3. `at` MEANS THE SAME THING HERE AS ON A DRAWING LAYER
 * ---------------------------------------------------------------------------
 *
 * A drawing layer has carried an `at` since the schema was written (see
 * `DrawingCommon` in lib/drawing.ts) — "a year (1941) or a fraction of the
 * event's span (0..1)" — reserved for exactly this and read by nothing. This
 * module is what finally reads it, and a stage's `at` is the SAME field with
 * the same two forms, because the two are compared against each other: a layer
 * belongs to the stage whose window its `at` falls in.
 *
 * Both forms are normalised to a FRACTION before anything is compared
 * (`atFraction`), and that is not an implementation detail. Both exemplars run
 * inside a single year — Barbarossa is dated 1941, D-Day 1944 — so a year-form
 * `at` cannot separate June from December on either of them, and resolving
 * everything to years first would collapse every stage of Barbarossa onto 1941
 * and put every layer in the first window. In fraction space the same data
 * orders correctly, and a multi-year event whose stages are written as years
 * normalises into the same space and orders correctly too.
 *
 * The ambiguity is real and it is inherited, not invented: an `at` of 0 or 1 on
 * an event spanning the turn of the era is a fraction, not the year. No event
 * in the corpus is in that position, the alternative (a second field, or a
 * sigil) would have to be threaded through the drawing schema as well, and this
 * is the convention the drawing schema already shipped with.
 */

/** Where the camera goes when a stage is opened. `altitude` in globe radii. */
export interface StageCamera {
  lat: number
  lng: number
  /** Omitted means "keep the height the reader is at" — see `lookAt`. */
  altitude?: number
}

/** One authored step through an event. */
export interface Stage {
  /** Unique within its event. The value the UI and the store pass around. */
  id: string
  /** What the chip says, and the heading of the stage page. */
  name: string
  /** When it happens: a year, or a fraction of the event's span. See above. */
  at: number
  /** Optional rich text — the same markup subset a body uses (lib/richtext.ts). */
  page?: string
  /** Optional camera move. Absent leaves the view exactly where the reader put it. */
  camera?: StageCamera
}

/** The upper bound of the fraction form; above it an `at` is a year. */
export const AT_FRACTION_MAX = 1

/** Is this `at` written as a fraction of the span rather than as a year? */
export const isFractionAt = (at: number) => at >= 0 && at <= AT_FRACTION_MAX

/**
 * An `at` as a position in 0..1 along the event's span — the one space in which
 * stages and layers are compared (see rule 3 above).
 *
 * A year-form `at` on a zero-span event (Barbarossa: `start` 1941, no `end`)
 * has nowhere to land but the beginning, which is why the exemplars are
 * authored as fractions.
 */
export function atFraction(at: number, start: Year, end?: Year): number {
  if (isFractionAt(at)) return at
  const span = (end ?? start) - start
  if (span <= 0) return at <= start ? 0 : 1
  return Math.min(1, Math.max(0, (at - start) / span))
}

/**
 * An `at` as a YEAR — what the time cursor is moved to when a stage opens.
 *
 * Inside a single-year event every stage resolves to that year, which is
 * correct: the cursor is a statement about the timeline, and the timeline's
 * unit is the year.
 */
export function atYear(at: number, start: Year, end?: Year): Year {
  return isFractionAt(at) ? start + at * ((end ?? start) - start) : at
}

/**
 * Stages in the order they happen.
 *
 * Sorted rather than trusted, because the order the chips read in is the whole
 * of what "in `at` order" means to the reader, and it must not depend on the
 * order someone happened to type the objects in. Ties keep authored order.
 */
export function orderedStages(stages: readonly Stage[], start: Year, end?: Year): Stage[] {
  return stages
    .map((stage, i) => ({ stage, i, f: atFraction(stage.at, start, end) }))
    .sort((a, b) => a.f - b.f || a.i - b.i)
    .map((x) => x.stage)
}

/** A stage and the half-open span of the event it owns, in fraction space. */
export interface StageWindow {
  stage: Stage
  from: number
  to: number
}

/**
 * The window each stage owns: from its own `at` up to (not including) the next
 * stage's.
 *
 * The two ends are open on purpose. The FIRST window opens at -Infinity so that
 * anything dated before the first named moment still belongs to it — the
 * preliminaries of an operation are part of its opening, not of nothing — and
 * the LAST closes at +Infinity so that the high-water mark of a campaign
 * belongs to its final stage however it was dated. Without both, a layer could
 * fall between the authored moments and vanish from every stage while still
 * being on the overview, which reads as a rendering fault rather than as a
 * statement.
 */
export function stageWindows(
  stages: readonly Stage[],
  start: Year,
  end?: Year,
): StageWindow[] {
  const ordered = orderedStages(stages, start, end)
  return ordered.map((stage, i) => ({
    stage,
    from: i === 0 ? -Infinity : atFraction(stage.at, start, end),
    to: i === ordered.length - 1 ? Infinity : atFraction(ordered[i + 1].at, start, end),
  }))
}

/**
 * "Which stage owns this `at`" as a reusable lookup: build the windows once,
 * then answer any number of times.
 *
 * The three callers below — `stageAt`, `layerInStage` and `drawingForStage` —
 * each used to write the window comparison out for themselves, which is three
 * copies of the rule that decides what is on the map. They must agree exactly
 * (a layer that answers one way to the strip and another way to the renderer is
 * a chip that filters the plan to something nobody authored), so they share one.
 */
export function stageOwner(
  stages: readonly Stage[],
  start: Year,
  end?: Year,
): (at: number) => Stage | undefined {
  const windows = stageWindows(stages, start, end)
  return (at) => {
    const f = atFraction(at, start, end)
    return windows.find((w) => f >= w.from && f < w.to)?.stage
  }
}

/** Which stage a moment falls in — `undefined` when there are no stages. */
export function stageAt(
  stages: readonly Stage[],
  at: number,
  start: Year,
  end?: Year,
): Stage | undefined {
  return stageOwner(stages, start, end)(at)
}

/**
 * Does this layer belong in the stage with this id?
 *
 * A layer with no `at` at all is TIMELESS and belongs to every stage. That is
 * the load-bearing half of the rule: the three army-group axes of Barbarossa
 * are the shape of the whole campaign and are true of every month of it, so
 * they stay on the map while the fronts and the pockets come and go around
 * them. It is also what keeps the feature backward compatible — a drawing
 * authored before stages existed renders identically in every stage.
 */
export const layerInStage = (
  layer: DrawingSpec,
  stageId: string,
  stages: readonly Stage[],
  start: Year,
  end?: Year,
): boolean => keepsLayer(stageId, stageOwner(stages, start, end))(layer)

/**
 * The predicate `drawingForStage` filters with, and the whole of the rule above
 * in one line — shared with `layerInStage` so the two cannot answer differently.
 */
const keepsLayer =
  (stageId: string, owner: (at: number) => Stage | undefined) =>
  (layer: DrawingSpec): boolean =>
    layer.at === undefined || owner(layer.at)?.id === stageId

/**
 * The drawing as one stage shows it: the timeless layers, plus the ones dated
 * inside that stage's window.
 *
 * No stage (the overview) returns the drawing UNCHANGED — the same object, not
 * a copy — so the renderer's key comparison (see `DrawingLayer.set`) sees
 * nothing to rebuild when the reader steps back out.
 */
export function drawingForStage(
  drawing: Drawing | undefined,
  stageId: string | undefined,
  stages: readonly Stage[],
  start: Year,
  end?: Year,
): Drawing | undefined {
  if (!drawing || !stageId || !stages.length) return drawing
  // The windows are built ONCE here and reused for every layer: this is the one
  // caller with a list to walk, and `layerInStage` is the same predicate for a
  // caller with a single layer.
  const layers = drawing.layers.filter(keepsLayer(stageId, stageOwner(stages, start, end)))
  return layers.length ? { layers } : undefined
}

/* ------------------------------------------------------------ validation */

/** Ids are lowercase kebab, like every other id in the corpus. */
export const STAGE_ID = /^[a-z0-9][a-z0-9-]*$/

/**
 * Every markdown link in a body, complete ones only — the denominator of the
 * markup check below.
 */
const COMPLETE_LINKS = /\[(.+?)\]\((?:(?:item|event):[\w-]+|https?:(?:[^\s()]|\([^\s()]*\))+)\)/g

/**
 * Is this rich text well formed?
 *
 * `renderRichText` cannot fail — anything it does not recognise falls through
 * as escaped prose — so "valid markup" has to mean something a renderer would
 * never complain about: every `](` in the text is part of a link the renderer
 * will actually turn into an anchor. A page whose link is missing its scheme,
 * or whose id has a stray character in it, ships as visible bracket soup, and
 * that is exactly the failure a build check is for.
 */
export function markupProblems(text: string): string[] {
  const opens = (text.match(/\]\(/g) ?? []).length
  const links = (text.match(COMPLETE_LINKS) ?? []).length
  return opens === links
    ? []
    : [`has ${opens - links} malformed link(s) — every "](" must close a link the renderer knows`]
}

/** Internal link targets in a stage page — checked against the corpus by the data test. */
export const stagePageLinkIds = (stages: readonly Stage[]): string[] =>
  stages.flatMap((s) => (s.page ? internalLinkIds(s.page) : []))

/** Is this one authored stage, structurally? The runtime twin of `validate_stages`. */
export function isStage(s: unknown): s is Stage {
  if (!s || typeof s !== 'object') return false
  const v = s as Record<string, unknown>
  if (typeof v.id !== 'string' || !STAGE_ID.test(v.id)) return false
  if (typeof v.name !== 'string' || !v.name) return false
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return false
  if (v.page !== undefined && (typeof v.page !== 'string' || !v.page)) return false
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
 * Everything wrong with an event's stages, as sentences — `[]` when it is
 * sound, and the shared answer behind the build script's check, the contract
 * test's, and the runtime guard's.
 *
 * The two rules that are about the EVENT rather than about the stage are the
 * ones worth having a validator for at all: ids unique *per event*, and a
 * year-form `at` inside the event's own span. A stage dated outside the thing
 * it is a stage of is not a typo the renderer can absorb — it silently owns a
 * window no layer can fall in.
 */
export function stageProblems(e: {
  start: Year
  end?: Year
  stages?: readonly Stage[]
}): string[] {
  const { stages } = e
  if (stages === undefined) return []
  if (!Array.isArray(stages) || !stages.length)
    return ['stages must be a non-empty list — drop the field instead']
  const out: string[] = []
  const seen = new Set<string>()
  for (const [i, s] of stages.entries()) {
    const where = `stage ${i}`
    if (!isStage(s)) {
      out.push(`${where} is not a valid stage`)
      continue
    }
    if (seen.has(s.id)) out.push(`${where}: duplicate stage id "${s.id}"`)
    seen.add(s.id)
    if (!isFractionAt(s.at)) {
      const to = e.end ?? e.start
      if (s.at < e.start || s.at > to)
        out.push(`${where} (${s.id}): at ${s.at} is outside the event's span ${e.start}..${to}`)
    }
    for (const p of markupProblems(s.page ?? '')) out.push(`${where} (${s.id}) page ${p}`)
  }
  return out
}
