import {
  timeExtent,
  timeFrom,
  timeIntersects,
  timeLength,
  timeStart,
  pointTime,
  type Time,
  type Year,
} from './time'
import { assertNever } from './variant'
import type { Ring } from './nations'
import { DEFAULT_DIRECTION, type GeoPath, type PathDirection } from './paths'
import { drawingPoints, type Drawing } from './drawing'
import { parseSteps, type RawStep, type Step } from './steps'
import { internalLinkIds } from './richtext'
import { GeoGrid, SpanIndex, TopScored, separationDeg } from './queryIndex'
import type { ViewportScope } from './viewport'

export { assertNever }

/**
 * ============================================================================
 * THE DOMAIN MODEL
 * ============================================================================
 *
 * This file is the codebase's core type. Everything else — the store, the
 * globe, the panel, the search, the index — is a consumer of what is declared
 * here, so the shape of these types is the shape of the app.
 *
 * Three rules hold it together.
 *
 * ---------------------------------------------------------------------------
 * 1. CLOSED UNIONS WITH REQUIRED DISCRIMINANTS
 * ---------------------------------------------------------------------------
 *
 * There are four unions, and every member of each carries a required `kind`:
 *
 *     Item    = HistoricalEvent | Person | Concept      an article the app owns
 *     MapPin  = HistoricalEvent | LifeMarker            a teardrop on the globe
 *     Feature = area | line | point                     ground an event occupies
 *     Time    = point | period                          when it happened (lib/time.ts)
 *
 * Consumers dispatch with `switch (x.kind)` closed by `assertNever`, so adding
 * a fourth kind of anything is a compile error at every place that has to care
 * and silent everywhere else. There are no `isFoo()` predicates: narrowing
 * happens on the discriminant, at the point where the variants genuinely
 * diverge. (`ofKind` exists only because `.filter` needs a callable predicate.)
 *
 * The three item kinds share one id space, one search, one panel and one link
 * syntax — `[text](item:id)`:
 *
 *  - `event`   something that happened at a place and a time. Pinned on the
 *              globe and drawn on the timeline.
 *  - `person`  an article about a life. Not a pin of its own; two LIFE MARKERS
 *              (birth, death) are derived from it, and clicking one opens the
 *              life.
 *  - `concept` an article about an idea. No place, and only a nominal year
 *              (`anchorYear`) so it lands in an era chunk. Reached from links
 *              and from search.
 *
 * ---------------------------------------------------------------------------
 * 2. AN EVENT IS A TIME, A PLACE, AND (SOMETIMES) SOME INK
 * ---------------------------------------------------------------------------
 *
 * Three fields, and each is a whole answer to one question:
 *
 *     time     : Time            WHEN — a point, or a period (lib/time.ts)
 *     location : EventLocation   WHERE — one anchor, and every feature around it
 *     drawing? : Drawing         WHAT IT DID — the operational overlay
 *
 * **Time is a variant.** It used to be `start` plus an optional `end`, and every
 * corner of the app that cared wrote `end ?? start` to make sense of that — six
 * places, six independent guesses at what a missing end meant. Now the two cases
 * are two members of a union and the collapse happens once, at the parser. See
 * lib/time.ts, which owns the type and every fold over it.
 *
 * **Location is composed.** An event used to carry `lat`, `lng`, `area?`,
 * `paths?` and `direction?` side by side, and every renderer sniffed for the
 * ones it cared about. Now:
 *
 *     location = { anchor: LatLng, features: Feature[] }
 *
 * `anchor` is the MAIN LOCATION — where the pin stands, always present, because
 * a pin is what an event *is* on this map. `features` is everything else the
 * event occupies: its footprint, its routes, and any secondary sites it names.
 * A list of variants rather than named optional fields, for one reason: the
 * operations that hurt were the FOLDS. "Every coordinate this occupies"
 * (`locationPoints`, which frames the camera) and "how far it reaches"
 * (`locationRadiusDeg`, which scopes the query) used to be three presence checks
 * each, in three different idioms, with the rules about what counts written in
 * prose. Over a list of variants they are one exhaustive switch each, and the
 * prose becomes a `case`.
 *
 * The list is canonical, not free-form, and the parser guarantees it: at most
 * one `area` and one `line`, always in the order area → line → points. So
 * `featureOf(loc, 'area')` is a total answer to "what is this event's
 * footprint?", not a search — the places that want one named component (the pin
 * glyph, the polygon layer, the route ink) ask for it by kind and get back the
 * variant, fully typed, or `undefined`. Points are the one kind an event may
 * carry several of, so they are asked for as a list (`pointFeatures`); that is
 * the difference between "the ground this covers" and "the places this names".
 *
 * Composition also makes the illegal states go away. `direction` lived next to
 * `paths` and meant nothing without it — a data test existed purely to assert
 * that no event carried one without the other. It is now a field OF the line
 * feature, defaulted at the boundary, so the invariant is a type rather than a
 * test.
 *
 * **The drawing is not a location.** It was briefly a third shape in that list,
 * and it does not belong there: a footprint and a route are ground, and a battle
 * plan is a *picture of what happened on* the ground. It is a field of its own,
 * which is also what lets a STEP carry one (lib/steps.ts) — a step occupies no
 * ground but very much draws.
 *
 * ---------------------------------------------------------------------------
 * 3. NORMALISE AT THE BOUNDARY, ONCE
 * ---------------------------------------------------------------------------
 *
 * The JSON on disk is flat and stays flat: `start`/`end`, `lat`/`lng`, `area`,
 * `paths`, `direction`, `points`, `drawing`, and `kind` omitted on the several
 * hundred entries written before persons and concepts existed (see
 * scripts/build_event_chunks.py, which is the only writer, and
 * tests/eventsData.test.ts, which is the contract). Those shapes are declared
 * here too — `RawEvent`, `RawPerson`, `RawConcept` — and they are the ONLY place
 * an optional kind, a loose coordinate or a bare `end` exists.
 *
 * `parseItems` is the single ingestion point (called from `adopt` in
 * stores/events.ts, and from the tests that read the chunk files). It stamps the
 * discriminant, folds the two date fields into a `Time`, composes the location,
 * and normalises the steps. Past it, `kind` is required and every one of those
 * is a value — no consumer defaults, no consumer sniffs.
 *
 * ---------------------------------------------------------------------------
 * PINS ARE THEIR OWN UNION
 * ---------------------------------------------------------------------------
 *
 * A birth pin used to be a `HistoricalEvent` with a runtime-only `derivedFrom`
 * string on it, tested for by presence. It is now `LifeMarker`, a second member
 * of `MapPin`, holding the `Person` it came from. What was "if this string is
 * set, the pin is a lie about an article" is now a variant that cannot be
 * mistaken for an event: markers are pinnable but not articles, so they are in
 * `MapPin` and NOT in `Item` — which is exactly why they have never been in
 * `byId`, in search, or in the panel.
 */

/* ========================================================== the item union */

export type ItemKind = 'event' | 'person' | 'concept'

/** What every item carries, whatever its kind. Also the shape of a raw entry. */
export interface ItemBase {
  id: string
  name: string
  /**
   * Ranking position, derived by scripts/build_event_chunks.py from
   * data/events/ranking.txt — never written by hand. Higher = more important;
   * `MINOR_PRIORITY` (0) means "not on the ranking list" (see `isMinor`).
   */
  priority: number
  tags: string[]
  summary: string
  /** Optional rich body (markdown subset, see lib/richtext.ts). */
  body?: string
  image?: { url: string; caption?: string }
  /**
   * External references — the "Read more" strip. Outward links only: an entry
   * pointing at another *item* used to be how a relation was expressed here, and
   * 247 of them said what `parent`/`strong`/`weak` now say properly, one section
   * higher up the panel. The graph is the one place a relation lives.
   */
  links?: { label: string; url: string }[]
  /**
   * STRONG association: the defining, first-order connections. Einstein and
   * relativity; a treaty and the war it ended; an inventor and the invention.
   * If a reader who knows one of the pair would be surprised not to be shown
   * the other, it is strong.
   *
   * Symmetric by definition, so it is authored on ONE side only — the index
   * materialises the inverse (see `buildRelations`) and the build script warns
   * when both sides say it. Which side gets to write it is a judgement about
   * where the sentence reads better, not about direction: relativity lists
   * Einstein because the concept is the thing that needs a person attached.
   */
  strong?: string[]
  /**
   * WEAK association: see-also. Informative but secondary — the same century,
   * the same idea one step removed, a rhyme rather than a cause. Symmetric and
   * one-side-authored exactly like `strong`.
   */
  weak?: string[]
}

/* ---------------------------------------------------------------- location */

export interface LatLng {
  lat: number
  lng: number
}

/**
 * Ground an event occupies beyond its anchor. A closed union — each member is
 * self-contained, carrying everything that feature needs and nothing another one
 * does.
 */
export type Feature =
  /**
   * A footprint: a polygon in GeoJSON [lng, lat] order. The anchor then acts as
   * its centroid — the pin stands *in* the region rather than beside it.
   */
  | { kind: 'area'; ring: Ring }
  /**
   * Route geometry: one or more polylines in GeoJSON [lng, lat] order (see
   * lib/paths.ts for why this is always an array, never a bare `path`), plus
   * whether they have a direction (`PathDirection`).
   *
   * A route event is a pin like any other until it is opened; selecting it draws
   * the lines on the globe, and deselecting removes them again — the same
   * lifecycle the selected footprint has. The anchor stays the place the pin
   * stands, and by convention it stands *on* the route (the Strait of Magellan
   * for the circumnavigation, Nanjing for the treasure fleets).
   */
  | { kind: 'line'; paths: GeoPath[]; direction: PathDirection }
  /**
   * A SECONDARY SITE: somewhere else this event also happened, with an optional
   * name for it.
   *
   * The main location is the anchor — one place, because a pin is one place —
   * and this is how an event says the rest. The Manhattan Project is Los Alamos
   * *and* Oak Ridge and Hanford; a treaty is signed in one city and ratified in
   * another. Before this the only way to say so was to invent a child event with
   * a made-up name, or to leave it in the prose.
   *
   * `at` is a PLACE, not a moment — the field name it shares with a drawing
   * layer's `at` (which is a time) is an unfortunate collision between two
   * schemas that never meet in one object. A feature has no time; a layer has no
   * position outside its own geometry.
   */
  | { kind: 'point'; at: LatLng; name?: string }

export type FeatureKind = Feature['kind']
export type FeatureOfKind<K extends FeatureKind> = Extract<Feature, { kind: K }>

/**
 * The kinds an event may carry at most ONE of, which is what makes `featureOf` a
 * lookup rather than a search. `point` is deliberately not among them.
 */
export type UniqueFeatureKind = 'area' | 'line'

/** Where an event's pin stands, and every feature it draws around that point. */
export interface EventLocation {
  anchor: LatLng
  /**
   * At most one `area` and one `line`, always in the order area → line →
   * points, with the points in the order they were authored. All of that is
   * guaranteed by `parseLocation`, and it is load bearing: uniqueness is what
   * makes `featureOf` a lookup, and the order is what makes a fold over the list
   * deterministic — `locationPoints` feeds the camera fit, whose answer must not
   * depend on the order the parser happened to see fields in.
   *
   * An event may carry all of them at once. The Atlantic slave trade is the case
   * that asked for it: a basin, three legs of a triangle over it, and both drawn
   * when it is selected.
   */
  features: Feature[]
}

/**
 * The one named component, by kind — typed, total, and the only lookup the
 * feature list needs. `undefined` means the event has no feature of that kind,
 * which is the whole of what the old `if (e.area)` was trying to say.
 *
 * Restricted to the kinds that are unique: asking for "the point" of an event
 * with three of them is a question with no honest answer, so the type does not
 * let it be asked. See `pointFeatures`.
 */
export const featureOf = <K extends UniqueFeatureKind>(
  loc: EventLocation,
  kind: K,
): FeatureOfKind<K> | undefined =>
  loc.features.find((f): f is FeatureOfKind<K> => f.kind === kind)

/** Every secondary site this event names, in authored order. */
export const pointFeatures = (loc: EventLocation): FeatureOfKind<'point'>[] =>
  loc.features.filter((f): f is FeatureOfKind<'point'> => f.kind === 'point')

/** A location with nothing but a pin: the common case, and every life marker. */
export const pointLocation = (lat: number, lng: number): EventLocation => ({
  anchor: { lat, lng },
  features: [],
})

/* ------------------------------------------------------------- the variants */

/**
 * The fields a thing needs to be a teardrop on the globe: an id, a name to
 * label it, a moment in time to be culled by, a place to stand, and a rank to
 * be ordered by. Shared by the two members of `MapPin`.
 */
export interface PinFields {
  id: string
  name: string
  /** WHEN: a point or a period. See lib/time.ts. */
  time: Time
  /** WHERE: the anchor the pin stands on, and every feature around it. */
  location: EventLocation
  priority: number
  tags: string[]
}

export interface HistoricalEvent extends ItemBase, PinFields {
  kind: 'event'
  /**
   * THE OPERATIONAL OVERLAY: frontlines, thrusts, markers and labels. See
   * lib/drawing.ts for the schema and lib/drawingLayer.ts for what puts it on
   * the globe.
   *
   * Unlike a footprint or a route, this does NOT draw on a plain selection. A
   * battle plan is a lot of ink, and clicking a pin is a glance; "Show on map"
   * is the request to *study* the thing, and it is what puts the panel out of
   * the way (see `focus` in stores/events.ts) so there is something to study.
   *
   * A field rather than a location feature, because it is not ground the event
   * occupies — it is a picture of what happened on that ground. Which is also
   * why a `Step` can carry one and cannot carry a footprint.
   */
  drawing?: Drawing
  /**
   * HIERARCHICAL CONTAINMENT: the one relation with a direction. A battle is
   * part of a campaign, a campaign part of a war. At most one parent, it
   * must resolve to an event, and the graph is acyclic — all three checked by
   * scripts/build_event_chunks.py and again by the data tests.
   *
   * It is the strongest thing the model can say about two items, and the panel
   * and focus mode both read it that way: containment wins over `strong`, which
   * wins over `weak` (see `buildRelations`).
   */
  parent?: string
  /**
   * THE AUTHORED STEPS through this event, if it has any.
   *
   * A field of its own rather than a feature, and deliberately so — the location
   * list is "ground this event occupies" (see `EventLocation`), and a step
   * occupies no ground. It is a reading of the event's *time*, in the same
   * relation to `time` that `parent` is to the graph, and every step's own time
   * is measured against this event's.
   *
   * Absent on all but the exemplars, and absent is not a degraded case: an event
   * with no steps is the whole feature turned off, and focus mode behaves
   * exactly as it did before. See lib/steps.ts.
   */
  steps?: Step[]
}

/** Where a life began or ended. `label` is what the panel's chip says. */
export interface Place {
  lat: number
  lng: number
  label?: string
}

export interface Person extends ItemBase {
  kind: 'person'
  born: Year
  died?: Year
  birthPlace?: Place
  deathPlace?: Place
}

export interface Concept extends ItemBase {
  kind: 'concept'
  /** Nominal year: the era chunk the concept ships in, and where search sorts it. */
  anchorYear: Year
}

export type Item = HistoricalEvent | Person | Concept

export type LifeMoment = 'birth' | 'death'

/**
 * A point on the globe derived from a life — the place it began or ended.
 *
 * Pinnable but not an article: it carries no summary, no body and no relations,
 * because it *is* the person as far as the reader is concerned (`of` is what a
 * click opens). That is why it is a member of `MapPin` and not of `Item`, and
 * why its id — `${person.id}--birth` — exists nowhere in the data.
 */
export interface LifeMarker extends PinFields {
  kind: 'life-marker'
  moment: LifeMoment
  /** The life it was cut from. The article a click on this pin opens. */
  of: Person
}

/** Everything that can be a teardrop: the events, plus every life's two ends. */
export type MapPin = HistoricalEvent | LifeMarker

/**
 * Anything the app can name, locate or fly to — an article, or a pin standing
 * in for one. The store's `selected`/`focused` getters and the camera fit are
 * all in these terms, because a birth pin is a legitimate thing to look at and
 * is not an `Item`.
 */
export type Subject = Item | LifeMarker

/**
 * A predicate for `.filter`, which needs a callable one. This is the only
 * concession to `isFoo` in the codebase — it is a discriminant check with a
 * signature, not a rule about what a kind is, and everything that is not a
 * filter narrows inline with `switch` or `===`.
 */
export const ofKind =
  <K extends ItemKind>(kind: K) =>
  (i: Item): i is Extract<Item, { kind: K }> =>
    i.kind === kind

/* ============================================== the boundary: raw JSON in */

/**
 * An event as it is written in a chunk file: flat geometry, and a `kind` that
 * may be missing entirely.
 *
 * The missing kind is load-bearing back-compat, not laziness — every entry
 * authored before persons and concepts existed says nothing about its kind, and
 * `parseItem` is what decides (as it always did) that such an entry is an event.
 */
export interface RawEvent extends ItemBase {
  kind?: 'event'
  start: Year
  /** Absent, or equal to `start`, means a point in time. See `timeFrom`. */
  end?: Year
  lat: number
  lng: number
  area?: Ring
  paths?: GeoPath[]
  /** Absent means `oneway`; see `DEFAULT_DIRECTION` in lib/paths.ts. */
  direction?: PathDirection
  /** Secondary sites — see the `point` member of `Feature`. */
  points?: RawPoint[]
  drawing?: Drawing
  parent?: string
  /** Normalised at the boundary — see `steps` on HistoricalEvent, and lib/steps.ts. */
  steps?: RawStep[]
}

/** A secondary site as it is written on disk: flat, like every other coordinate. */
export interface RawPoint {
  lat: number
  lng: number
  name?: string
}

export interface RawPerson extends ItemBase {
  kind: 'person'
  born: Year
  died?: Year
  birthPlace?: Place
  deathPlace?: Place
}

export interface RawConcept extends ItemBase {
  kind: 'concept'
  anchorYear: Year
}

export type RawItem = RawEvent | RawPerson | RawConcept

/**
 * Compose the flat fields into the location value.
 *
 * Empty is empty: an `area: []` or a `paths: []` produces no feature at all,
 * which is what every consumer's old `!!e.area?.length` test meant. A
 * `direction` with no paths to belong to is dropped here rather than carried as
 * a field that means nothing.
 */
export function parseLocation(raw: RawEvent): EventLocation {
  const features: Feature[] = []
  // area → line → points, which is the order every fold will see them in
  if (raw.area?.length) features.push({ kind: 'area', ring: raw.area })
  if (raw.paths?.length)
    features.push({
      kind: 'line',
      paths: raw.paths,
      direction: raw.direction ?? DEFAULT_DIRECTION,
    })
  for (const p of raw.points ?? [])
    features.push({
      kind: 'point',
      at: { lat: p.lat, lng: p.lng },
      ...(p.name === undefined ? {} : { name: p.name }),
    })
  return { anchor: { lat: raw.lat, lng: raw.lng }, features }
}

/**
 * The single ingestion point. Stamps the discriminant, composes the geometry,
 * and drops the flat fields — past here nothing in the app can read `e.lat` or
 * `e.paths`, because they no longer exist.
 *
 * Anything that is not declared a person or a concept is an event. That is the
 * back-compat default, and it is deliberately total rather than exhaustive: a
 * chunk with a `kind` this build has never heard of must still land on the map
 * as best it can, not throw the whole file out.
 */
export function parseItem(raw: RawItem): Item {
  switch (raw.kind) {
    case 'person':
      return { ...raw, kind: 'person' }
    case 'concept':
      return { ...raw, kind: 'concept' }
    default: {
      const ev = raw as RawEvent
      // The flat fields are destructured OUT and re-composed. Past this line
      // they exist only inside `time` and `location`, so no consumer can read an
      // event's `lat`, `paths` or bare `end` even by accident — which is what
      // makes the model closed rather than merely preferred.
      const { start, end, lat, lng, area, paths, direction, points, steps, ...rest } = ev
      return {
        ...rest,
        kind: 'event',
        time: timeFrom(start, end),
        location: parseLocation(ev),
        ...(steps ? { steps: parseSteps(steps) } : {}),
      }
    }
  }
}

export const parseItems = (raw: RawItem[]): Item[] => raw.map(parseItem)

/* ================================================= folds over the model */

/**
 * The priority of an item that is not on the ranking list. Minor items are off
 * the globe by default (Settings → Events → "Show minor events" brings them
 * back) but stay searchable and linkable, which is the whole point of the tier:
 * the corpus can hold far more than the map can usefully show.
 */
export const MINOR_PRIORITY = 0
export const isMinor = (i: { priority: number }) => i.priority <= MINOR_PRIORITY

/**
 * WHEN a subject happened, as the one variant the whole app reads.
 *
 * The three item kinds keep their own natural fields — a person is `born` and
 * `died`, an idea is `anchorYear`, and only a pin carries a `Time` outright —
 * because those are what the article is *about* and flattening them would make
 * a life read like an event with a long end. This is the fold that puts all
 * three in one space, and it is what every span-aware consumer asks instead of
 * reaching for a field.
 */
export function timeOf(i: Subject): Time {
  switch (i.kind) {
    case 'event':
    case 'life-marker':
      return i.time
    case 'person':
      return timeFrom(i.born, i.died)
    case 'concept':
      return pointTime(i.anchorYear)
    default:
      return assertNever(i)
  }
}

/** The year a subject sits at: an event starts, a person is born, an idea anchors. */
export const anchorYearOf = (i: Subject): Year => timeStart(timeOf(i))

/** The span a subject occupies on the timeline — a point for anything instantaneous. */
export const timeExtentOf = (i: Subject): [Year, Year] => timeExtent(timeOf(i))

/**
 * Does a subject's own span touch the interval `[start, end]`?
 *
 * The same closed-interval test `EventIndex.admits` runs on a pin (`intersects`,
 * below), lifted to a subject so it can be asked of anything the panel or the
 * focus mode is holding — including a person or a concept, neither of which has
 * a pin. Touching at a single year counts: an event dated to exactly the edge of
 * the band is on the timeline, not off it.
 */
export const touchesSpan = (i: Subject, start: Year, end: Year): boolean =>
  timeIntersects(timeOf(i), start, end)

/**
 * Every coordinate a location occupies, `[lng, lat]` each — its anchor, its
 * footprint, its routes and every secondary site it names.
 *
 * The fold that "show this on the map" is framed on (lib/geoFocus.ts), together
 * with the drawing's own points, which are added by `pointsOf` below — a
 * drawing is not part of the location (see the note at the top), but it is very
 * much part of what the camera has to hold.
 */
export function locationPoints(loc: EventLocation): GeoPath {
  const out: GeoPath = [[loc.anchor.lng, loc.anchor.lat]]
  for (const f of loc.features)
    switch (f.kind) {
      case 'area':
        out.push(...f.ring)
        break
      case 'line':
        for (const path of f.paths) out.push(...path)
        break
      case 'point':
        out.push([f.at.lng, f.at.lat])
        break
      default:
        assertNever(f)
    }
  return out
}

/**
 * Every coordinate a subject occupies — its location, plus its ink.
 *
 * The drawing counts, and it is the case that makes this worth having as a fold
 * rather than as a field read: D-Day is a pin and a battle plan across a
 * coastline, with no footprint and no route, so the plan is the only thing that
 * says how big it is.
 *
 * A person contributes the place their life began (or ended, if that is the only
 * one recorded); a concept contributes nothing, which is what leaves it with no
 * map action at all.
 */
export function pointsOf(i: Subject): GeoPath {
  switch (i.kind) {
    case 'event':
      return [...locationPoints(i.location), ...drawingPoints(i.drawing)]
    case 'life-marker':
      return locationPoints(i.location)
    case 'person': {
      const p = i.birthPlace ?? i.deathPlace
      return p ? [[p.lng, p.lat]] : []
    }
    case 'concept':
      return []
    default:
      return assertNever(i)
  }
}

/* --------------------------------------------------------------- relations */

/**
 * The four relation maps, materialised in both directions.
 *
 * The data files carry three optional fields — `parent`, `strong`, `weak` — and
 * every one of them is written on one side only. This turns that authoring
 * shorthand into the graph the app actually reads:
 *
 *  · `children`  the inverse of `parent`, chronological. A parent never lists
 *                its parts; the parts each name the whole.
 *  · `strong`    declared strong edges *plus their inverses*, so listing
 *                Einstein on the relativity article puts relativity on
 *                Einstein's without anyone writing it twice.
 *  · `weak`      the same for see-also.
 *
 * **One pair, one relation.** The three are a precedence order, not a set of
 * independent tags: containment beats strong, strong beats weak. A pair that is
 * already parent-and-child is removed from both association maps, and a pair
 * that is strong in one direction is removed from weak — otherwise an item that
 * says `weak: [ww2]` while WWII is its parent would appear twice in the panel,
 * once as the thing it is part of and once as an aside.
 *
 * Nothing relates to itself, and every id is deduped: the authoring convention
 * is a request, not a guarantee, and a corpus of six hundred items will always
 * hold a pair someone wrote from both ends.
 */
export interface Relations {
  /** parent id → its direct children, chronological. */
  children: Map<string, HistoricalEvent[]>
  /** id → strongly associated ids, both directions merged. */
  strong: Map<string, string[]>
  /** id → see-also ids, both directions merged, minus anything stronger. */
  weak: Map<string, string[]>
}

/** Add `value` to the set stored at `key`, creating it on first use. */
const addTo = (m: Map<string, Set<string>>, key: string, value: string) => {
  const set = m.get(key)
  if (set) set.add(value)
  else m.set(key, new Set([value]))
}

/**
 * Collect the declared edges of one field into a symmetric adjacency map.
 * Unknown ids are dropped here rather than carried as dangling strings — the
 * build script fails on them, so at runtime they can only come from a chunk
 * that has not loaded yet, and a link to nothing is worse than no link.
 */
function symmetrise(
  items: Item[],
  field: 'strong' | 'weak',
  byId: Map<string, Item>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const i of items)
    for (const other of i[field] ?? []) {
      if (other === i.id || !byId.has(other)) continue
      addTo(out, i.id, other)
      addTo(out, other, i.id)
    }
  return out
}

export function buildRelations(items: Item[], byId: Map<string, Item>): Relations {
  const children = new Map<string, HistoricalEvent[]>()
  /** id → the pair it is already in a *hierarchical* relation with. */
  const family = new Map<string, Set<string>>()
  for (const i of items) {
    // only an event is contained by anything: a life or an idea is *related* to
    // things, never a part of them, which is why `parent` is an event's field
    if (i.kind !== 'event' || !i.parent || i.parent === i.id || !byId.has(i.parent)) continue
    const list = children.get(i.parent)
    if (list) list.push(i)
    else children.set(i.parent, [i])
    addTo(family, i.id, i.parent)
    addTo(family, i.parent, i.id)
  }
  // Chronological, because "Contains" is a narrative: a war's parts read in the
  // order they happened. Priority breaks the tie so two events in the same year
  // still land in a stable, meaningful order.
  for (const list of children.values())
    list.sort((a, b) => timeStart(a.time) - timeStart(b.time) || b.priority - a.priority)

  const rank = (id: string) => byId.get(id)?.priority ?? MINOR_PRIORITY
  const year = (id: string) => {
    const i = byId.get(id)
    return i ? anchorYearOf(i) : 0
  }
  const resolve = (
    src: Map<string, Set<string>>,
    exclude: (id: string) => Set<string> | undefined,
  ): Map<string, string[]> => {
    const out = new Map<string, string[]>()
    for (const [id, set] of src) {
      const kept = [...set].filter((o) => !exclude(id)?.has(o))
      // Best first, then oldest first — the same order the search results and
      // the old "Linked" strip used, so the panel's lists all read alike.
      if (kept.length) out.set(id, kept.sort((a, b) => rank(b) - rank(a) || year(a) - year(b)))
    }
    return out
  }

  const strongSets = symmetrise(items, 'strong', byId)
  const strong = resolve(strongSets, (id) => family.get(id))
  const weak = resolve(symmetrise(items, 'weak', byId), (id) => {
    const out = new Set(family.get(id))
    for (const o of strongSets.get(id) ?? []) out.add(o)
    return out
  })
  return { children, strong, weak }
}

/* ------------------------------------------------------------ life markers */

/** `${personId}${LIFE_MARKER_SUFFIX.birth}` etc. — a life marker's id. */
export const LIFE_MARKER_SUFFIX: Record<LifeMoment, string> = {
  birth: '--birth',
  death: '--death',
}

/**
 * The pins a person contributes to the globe.
 *
 * A life is an article, not a pin — but a birth and a death *are* points at a
 * place and a time, and the map is poorer for leaving them off. So the index
 * synthesises them rather than the data duplicating them: nothing in the files
 * says "Birth of Einstein", and editing the person moves the pin.
 *
 * They are minor-tier by construction. Two pins per person over a corpus of
 * lives would swamp the globe at the default cap, and a birth is rarely the
 * most important thing in its window; the ranking list governs the *person*,
 * and the pins ride along when minor events are shown.
 *
 * No place, no pin: a coordinate is not something to guess at.
 */
export function lifeMarkersFor(p: Person): LifeMarker[] {
  const make = (moment: LifeMoment, year: Year, place: Place): LifeMarker => ({
    kind: 'life-marker',
    id: p.id + LIFE_MARKER_SUFFIX[moment],
    moment,
    of: p,
    name: `${moment === 'birth' ? 'Birth' : 'Death'} of ${p.name}`,
    time: pointTime(year),
    location: pointLocation(place.lat, place.lng),
    priority: MINOR_PRIORITY,
    tags: p.tags,
  })
  const out: LifeMarker[] = []
  if (p.birthPlace) out.push(make('birth', p.born, p.birthPlace))
  if (p.died !== undefined && p.deathPlace) out.push(make('death', p.died, p.deathPlace))
  return out
}

/** Everything that can carry a pin: real events, plus every life's markers. */
export function mapPinsOf(items: Item[]): MapPin[] {
  const out: MapPin[] = []
  for (const i of items)
    switch (i.kind) {
      case 'event':
        out.push(i)
        break
      case 'person':
        out.push(...lifeMarkersFor(i))
        break
      case 'concept':
        break // an idea has no place to stand
      default:
        assertNever(i)
    }
  return out
}

/* --------------------------------------------------------------- filtering */

export interface EventFilter {
  tags?: string[] // pin must carry at least one
  parent?: string // pin must be the parent itself or a descendant
  /** Include minor-tier (unranked) pins. Off by default — see MINOR_PRIORITY. */
  minor?: boolean
}

const intersects = (e: MapPin, start: Year, end: Year) => timeIntersects(e.time, start, end)

/**
 * Is this pin the filter's root, or somewhere under it?
 *
 * A life marker terminates the walk immediately: containment is an event's
 * relation, so a birth is never *part of* anything (it is only ever related to
 * the life it came from).
 */
const isUnder = (e: MapPin, root: string, byId: ReadonlyMap<string, Subject>) => {
  for (let cur: MapPin | undefined = e; cur; ) {
    if (cur.id === root) return true
    if (cur.kind !== 'event' || !cur.parent) return false
    const next = byId.get(cur.parent)
    cur = next?.kind === 'event' ? next : undefined
  }
  return false
}

const passes = (e: MapPin, filter: EventFilter, byId: ReadonlyMap<string, Subject>) =>
  (filter.minor || !isMinor(e)) &&
  (!filter.tags?.length || e.tags.some((t) => filter.tags!.includes(t))) &&
  (!filter.parent || isUnder(e, filter.parent, byId))

/* ------------------------------------------------- partial-coverage penalty */

/**
 * A year is a unit of time, not an instant: an event dated 1939–1945 occupies
 * *seven* years, and one dated 1969 occupies one. Both spans below are measured
 * that way, which is what the dataset's integer years mean and what a reader
 * sees in the label.
 *
 * Without it the intervals are closed for `intersects` and half-open for
 * coverage, and the two disagree exactly where it hurts: Stalingrad (1942–1943)
 * against a 1943–1944 selection is an intersection worth zero overlap — the one
 * year both of them are *about* measures nothing — and the event that best
 * fits the window takes the heaviest penalty in it.
 */
export const YEAR_UNIT = 1

/**
 * How much of an event the selection actually contains: overlap ÷ event span,
 * in [0, 1]. A point event spans one unit and, once it intersects at all,
 * scores 1 — there is nothing partial about being somewhere.
 *
 * This is deliberately *not* symmetric with "how much of the selection the
 * event covers" — the question the culling asks is "is this event about the
 * years on screen?", and a 146-year warming trend seen through a ten-year
 * window is only 7% about them.
 */
export function coverageOf(time: Time, start: Year, end: Year): number {
  const [s, e] = timeExtent(time)
  const overlap = Math.min(e, end) - Math.max(s, start) + YEAR_UNIT
  return Math.max(0, Math.min(1, overlap / (timeLength(time) + YEAR_UNIT)))
}

/**
 * The curve that turns coverage into a multiplier on priority, and the two
 * pairs of constants it is read with.
 *
 *     factor = floor + (1 − floor) · coverage^k        (k < 1, so concave)
 *
 * Concave and floored, both for the same reason: **the ranking list has to be
 * able to win.** A flat multiply by coverage would let any local event outrank
 * the Cold War inside the Cold War, which is not what a reader wants; the floor
 * says "an event never loses more than this fraction of its importance", and
 * k < 1 means the first sliver of overlap already buys most of what is on
 * offer. An event ten times longer than the selection (coverage 0.1) keeps 78%
 * of its rank, so priority 98 still beats priority 70 outright.
 *
 * Two cases, because the two kinds of partial overlap do not mean the same
 * thing:
 *
 *  · **ONGOING** — the event runs past the end of the selection. You are
 *    looking at the middle (or the start) of something still under way: the
 *    Cold War seen from 1960, global warming seen from the 1990s. It is *about*
 *    the years on screen, so the penalty is gentle (floor 0.60, k 0.35).
 *  · **ENDED** — the selection reaches past the event's end, so the thing
 *    finished inside the window and the rest of the window is aftermath. The
 *    Cold War against a 1990–1999 selection is one year of overlap and nine
 *    years of "after". Penalised harder (floor 0.45, k 0.50) — this is the
 *    asymmetry the product asked for.
 *
 * Full containment either way lands on coverage 1 and factor exactly 1: an
 * event wholly inside the selection is never penalised.
 *
 * Tuned against the real dataset (priorities run 52–100):
 *
 *   selection    event                        raw  cov     eff   case
 *   1990–1999    global-warming 1880–2026      90  0.068  68.1  ongoing
 *   1990–1999    cold-war       1947–1991      94  0.044  53.2  ended
 *   1990–1999    himalaya-uplift −50 Ma–2026   60  ~0     36.1  ongoing
 *   1990–1999    german-reunification 1990     78  1      78.0  point
 *   1943–1944    ww2            1939–1945      98  0.286  84.1  ongoing
 *   1943–1944    stalingrad     1942–1943      75  0.500  62.9  ended
 *   1939–1999    ww2            1939–1945      98  1      98.0  whole
 *   1200–1300    ottoman-empire 1299–1922      83  0.003  54.2  ongoing
 *
 * The 1990s case is the one the constants were chosen on: warming should still
 * make the decade's list (68.1 sits mid-table, above Maastricht at 66) without
 * outranking the decade's own headline events (reunification 78, apartheid 75),
 * and the Cold War — over in the first year of the window — should fall to the
 * bottom rather than lead it. The 1943 case is the other end of the same dial:
 * the war is only 29% inside that window but is still what 1943 is *about*, and
 * at 84.1 it stays ahead of D-Day (81), which is wholly inside it.
 */
export const COVERAGE_ONGOING = { floor: 0.6, k: 0.35 } as const
export const COVERAGE_ENDED = { floor: 0.45, k: 0.5 } as const

/**
 * The multiplier itself. Pure; 1 for point events and for full containment.
 *
 * It dispatches on the event's `Time` rather than on a pair of years, which is
 * what makes the point case honest: a point has no span to be partially covered,
 * so `coverageOf` scores it 1 the moment it intersects at all, and the two sets
 * of constants below never come into it.
 */
export function coveragePenalty(time: Time, start: Year, end: Year): number {
  // A selection with no width (a bare cursor) says nothing about coverage, and
  // reading one would penalise every spanning event to its floor at once.
  if (!(end > start)) return 1
  const coverage = coverageOf(time, start, end)
  // "Ended" is decided by the selection reaching the event's end, which also
  // covers the event-wholly-inside case — where coverage is 1 and the choice of
  // constants cannot matter.
  const { floor, k } = end >= timeExtent(time)[1] ? COVERAGE_ENDED : COVERAGE_ONGOING
  return floor + (1 - floor) * coverage ** k
}

/** Priority as the culling sees it: rank, discounted by how much of the event
 *  the selection actually holds. */
export const effectivePriority = (e: MapPin, start: Year, end: Year): number =>
  e.priority * coveragePenalty(e.time, start, end)

/* ------------------------------------------------------- viewport scoping */

/**
 * How far a location reaches from its anchor, in degrees of arc.
 *
 * An area event is indexed as a point (its centroid) plus this radius, so a
 * plague whose centroid is off screen is still found when its footprint is on
 * it. The bounding circle is loose for a long thin ring, which costs a few
 * false positives in the grid and nothing in the answer — membership is tested
 * against the same circle either way, and the alternative (testing the polygon)
 * would pay for precision no one can see at pin scale.
 *
 * The `case` list is the specification, and the two features that contribute
 * NOTHING are the interesting half of it (they used to be a paragraph of
 * comment on a field nobody had to read):
 *
 *  · `line` — a route is drawn only when its event is selected, and a selected
 *    pin is kept by the store whatever the camera is doing (`EventIndex.admits`
 *    ignores the scope). Counting it here would buy nothing on screen and cost
 *    a great deal: a circumnavigation's radius is most of the planet, which
 *    would put its pin in the top-N contest in *every* frame, at a spot the
 *    camera is not looking at.
 *  · `point` — a secondary site is drawn on the same terms as a route (with the
 *    selection, see `resolveSelectionInk`), so the same argument holds: Los
 *    Alamos does not put the Manhattan Project's pin on screen over Tennessee.
 *
 * The drawing is not consulted for the same reason, one step stronger: a plan
 * draws only in focus mode, which does not run this query at all.
 */
export function locationRadiusDeg(loc: EventLocation): number {
  const { lat, lng } = loc.anchor
  let max = 0
  for (const f of loc.features)
    switch (f.kind) {
      case 'area':
        for (const [plng, plat] of f.ring) {
          const d = separationDeg(lat, lng, plat, plng)
          if (d > max) max = d
        }
        break
      case 'line':
      case 'point':
        break // deliberately no reach: see above
      default:
        assertNever(f)
    }
  return max
}

/** Is this pin inside the visible circle (footprint included)? */
export const inScope = (e: MapPin, scope: ViewportScope): boolean =>
  separationDeg(scope.lat, scope.lng, e.location.anchor.lat, e.location.anchor.lng) <=
  scope.radiusDeg + locationRadiusDeg(e.location)

/**
 * Pins in the time window, matching filters, top `cap` by effective priority.
 *
 * THE REFERENCE IMPLEMENTATION, and the reason it is here rather than in the
 * tests: `EventIndex.query` answers the same question three different ways (see
 * `chooseQueryPlan`), each with its own early-out, and the only claim that
 * makes those safe is that all four agree. This is the fourth — the obvious
 * one, a filter and a sort — and tests/events.test.ts holds the index to it
 * over random corpora, windows, filters and camera scopes. Keeping it beside
 * the code it is a statement about is what stops the two drifting when a
 * filter or a tiebreak changes; a copy in a test file would be changed to
 * match the index the day the index went wrong.
 *
 * Nothing in the app calls it. That is correct: it is a specification, and
 * specifications are not on the hot path.
 */
export function visibleEvents(
  events: MapPin[],
  start: Year,
  end: Year,
  filter: EventFilter = {},
  cap = 100,
  scope?: ViewportScope,
): MapPin[] {
  const byId = new Map<string, MapPin>(events.map((e) => [e.id, e]))
  return events
    .filter((e) => intersects(e, start, end))
    .filter((e) => !scope || inScope(e, scope))
    .filter((e) => passes(e, filter, byId))
    .map((e) => ({ e, s: effectivePriority(e, start, end) }))
    // Raw priority breaks a tie in the discounted score, which keeps this in
    // step with the index's scan order (see EventIndex.query).
    .sort((a, b) => b.s - a.s || b.e.priority - a.e.priority)
    .slice(0, cap)
    .map((x) => x.e)
}

/* ------------------------------------------------------------ query plans */

/**
 * Three ways to enumerate the same candidates. All produce the identical
 * answer; they differ only in what they touch to get there.
 *
 *  · `priority` — walk the pins best-first and stop when nothing unseen can
 *    still make the cut. Unbeatable when the window is wide, because the answer
 *    is then sitting at the front of the list; degenerates to a full scan when
 *    almost nothing matches, because the bound never rises.
 *  · `time`     — enumerate the span index's hits. Wins when the selection is
 *    narrow against a large corpus: a single year out of ten thousand events.
 *  · `space`    — enumerate the grid's cells. Wins when the camera is close:
 *    the frame holds a hundredth of the corpus and the time window is wide.
 */
export type QueryPlan = 'priority' | 'space' | 'time'

/**
 * Which plan to run, from three counts that are all O(log n) or already known.
 *
 * The model is crude on purpose — one multiplication per plan, because a
 * planner that costs more than the difference between the plans is a loss. It
 * assumes time and space membership are independent (they are not: history
 * happens in cities) and that hits are spread evenly through priority order
 * (they are not either). Both errors push the same way — the priority scan is
 * usually better than estimated — so the estimate is compared against a scan
 * cost that is deliberately not padded.
 */
export function chooseQueryPlan(o: {
  /** Pins in the index. */
  n: number
  cap: number
  /** Pins whose span meets the selection (exact, from the span index). */
  timeHits: number
  /** Pins in the cells the scope touches, or `n` when unscoped. */
  spaceCandidates: number
}): QueryPlan {
  const n = Math.max(1, o.n)
  const density = (o.timeHits / n) * (o.spaceCandidates / n)
  // how far the best-first scan must walk before `cap` survivors accumulate
  const scan = Math.min(n, (o.cap + 1) / Math.max(density, 1 / n))
  // the span index over-scans by the slack in each magnitude bucket; measured
  // on the real corpus and on the synthetic ones that is well under 2x
  const time = 2 * o.timeHits + 8
  const space = o.spaceCandidates + 8
  const best = Math.min(scan, time, space)
  return best === scan ? 'priority' : best === space ? 'space' : 'time'
}

/**
 * Query index for large item sets.
 *
 * It holds every item (so links, search and the panel can reach a person or a
 * concept) but queries only what can be pinned: real events plus the birth and
 * death markers derived from each person.
 *
 * One canonical order runs through the whole thing: `byPriority`, best first.
 * It is the scan order of the cheapest plan, it is the tie-break in every
 * plan's result, and it is the identity a pin has in both auxiliary indexes —
 * `spans` and `geo` are built over exactly that array, so a hit from either is
 * a position in it. That is what lets three different enumerations produce the
 * same list to the last element (see `query`).
 */
export class EventIndex {
  readonly items: Item[]
  readonly byId: Map<string, Item>
  /**
   * The pins that are *not* in `byId`: the birth and death markers derived from
   * each person, whose ids exist nowhere in the data.
   *
   * This used to be every pin, real ones included — a second map the size of
   * the corpus, holding what `byId` already held. At 68 000 items that copy
   * cost 10 ms of the build to answer a question `byId` can answer with one
   * discriminant check (see `pin`).
   */
  private markers: Map<string, LifeMarker>
  private byPriority: MapPin[]
  /** Time spans of `byPriority`, by magnitude bucket (lib/queryIndex.ts). */
  private spans: SpanIndex
  /** Locations of `byPriority`, on a lat/lng grid; areas by centroid + radius. */
  private geo: GeoGrid
  /** id → items whose body links to it. Built once; see `backlinksTo`. */
  private backlinks = new Map<string, Item[]>()
  /** The typed relation graph, both directions materialised (see `buildRelations`). */
  private relations: Relations
  /**
   * Which plan the last query ran. Diagnostics only — the bench script reads
   * it, and a test asserts the planner picks what it claims to. Nothing in the
   * app behaves differently for it.
   */
  lastPlan: QueryPlan = 'priority'

  constructor(items: Item[]) {
    this.items = items
    // Loops rather than `new Map(items.map(…))`: the map-of-pairs form
    // allocates a two-element array per item and measured twice as slow at
    // 68 000 items, which at that size is 20 ms of the build spent on garbage.
    this.byId = new Map()
    for (const i of items) this.byId.set(i.id, i)
    this.relations = buildRelations(items, this.byId)
    const pins = mapPinsOf(items)
    this.markers = new Map()
    for (const p of pins) if (p.kind === 'life-marker') this.markers.set(p.id, p)
    // Every life marker sits at MINOR_PRIORITY, so within the minor tier the
    // rank of the *person* is the only thing left to sort on — which is what
    // makes ranking a life worth doing even though a life carries no pin of
    // its own: when minor pins are shown and the cap bites, Einstein's birth
    // survives and an unranked figure's does not.
    const rank = (e: MapPin) => (e.kind === 'life-marker' ? e.of.priority : e.priority)
    this.byPriority = [...pins].sort((a, b) => b.priority - a.priority || rank(b) - rank(a))
    // One pass fills the columns both indexes are built from. Building them
    // from arrays of little objects instead cost 17 ms per 68 000 events in
    // allocation alone — a sixth of the whole build budget, spent on garbage.
    const n = this.byPriority.length
    const starts = new Float64Array(n)
    const ends = new Float64Array(n)
    const lats = new Float64Array(n)
    const lngs = new Float64Array(n)
    const radii = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const e = this.byPriority[i]
      // Ordered by construction (see `timeFrom`), so no min/max here: the
      // variant is what makes that safe to assume.
      const [s, f] = timeExtent(e.time)
      starts[i] = s
      ends[i] = f
      lats[i] = e.location.anchor.lat
      lngs[i] = e.location.anchor.lng
      radii[i] = locationRadiusDeg(e.location)
    }
    this.spans = SpanIndex.fromColumns(starts, ends)
    this.geo = GeoGrid.fromColumns(lats, lngs, radii)
    for (const i of items) {
      // Most items have no body at all, and running the link regex over an
      // empty string 68 000 times cost 20 ms of the build for no links.
      if (!i.body) continue
      for (const id of internalLinkIds(i.body)) {
        const list = this.backlinks.get(id)
        if (list) list.push(i)
        else this.backlinks.set(id, [i])
      }
    }
  }

  /**
   * Top `cap` pins in the span — and, when the camera is zoomed in past world
   * view, in the circle of ground it can see — ranked by *effective* priority:
   * rank times the partial-coverage penalty (see `coveragePenalty`).
   *
   * The budget is deliberately spent inside the scope rather than filtered
   * after it: a global top-30 filtered down to Europe would show whichever of
   * the world's thirty biggest events happened to be European, which at close
   * zoom is usually none of them. Running the same contest among the events on
   * screen is what makes zooming in reveal something.
   *
   * Whichever plan enumerates the candidates, the survivors are chosen by the
   * same bounded heap under the same total order (score, then canonical
   * position), so the three plans are interchangeable — and a test holds them
   * to that on random datasets, because a planner that could change the answer
   * would make the pins depend on the dataset's size.
   *
   * The `priority` plan's early exit is exact rather than heuristic: the
   * coverage penalty is a multiplier in (0, 1], so an event's discounted score
   * can never exceed its raw priority, and once `cap` hits are in hand and the
   * raw priority under the scan has fallen to the weakest of them, nothing
   * further down the list can displace anything.
   */
  query(
    start: Year,
    end: Year,
    filter: EventFilter = {},
    cap = 100,
    scope?: ViewportScope,
  ): MapPin[] {
    if (cap <= 0) return []
    const n = this.byPriority.length
    const timeHits = this.spans.countIntersecting(start, end)
    const spaceCandidates = scope ? this.geo.candidateCount(scope) : n
    const plan = chooseQueryPlan({ n, cap, timeHits, spaceCandidates })
    // The enumeration to fall back on, and what it will cost: both exact counts
    // rather than estimates, which is what makes the budget below meaningful.
    const spaceCost = scope ? spaceCandidates : Infinity
    const timeCost = 2 * timeHits
    const fallback: QueryPlan = spaceCost <= timeCost ? 'space' : 'time'
    const fallbackCost = Math.min(spaceCost, timeCost)

    const run = (chosen: QueryPlan): MapPin[] | undefined => {
      const top = new TopScored<MapPin>(cap)
      // The space plan's enumeration *is* the membership test, so only the
      // other two pay for one.
      const testScope = chosen === 'space' ? undefined : scope
      // `i` is a position in byPriority, which is both the tie-break and the
      // identity the auxiliary indexes hand back.
      const consider = (i: number) => {
        const e = this.byPriority[i]
        if (!intersects(e, start, end)) return
        if (testScope && !this.geo.contains(testScope, i)) return
        if (!passes(e, filter, this.byId)) return
        top.push(e, effectivePriority(e, start, end), i)
      }
      if (chosen === 'priority') {
        // How far the best-first scan may walk before the fallback is simply
        // the better bet. The planner's estimate of this scan is the one number
        // here that cannot be measured up front — it assumes hits are spread
        // evenly through priority order, and the coverage penalty makes that
        // wrong in exactly the case that hurts (a close camera over a busy
        // region, where the cap fills with discounted scores so the early exit
        // never fires). Rather than model that, the scan is given a budget the
        // size of its alternative and abandoned if it overruns: the answer is
        // the same either way, and the worst case is twice the better plan
        // instead of the 15 ms this used to cost at 100x.
        const limit = Math.min(n, Math.ceil(fallbackCost))
        let i = 0
        for (; i < limit; i++) {
          if (top.full && this.byPriority[i].priority <= top.worstScore) break
          consider(i)
        }
        if (i >= limit && limit < n) return undefined // overran: try the other one
      } else if (chosen === 'space' && scope) this.geo.forEach(scope, consider)
      else this.spans.forEach(start, end, consider)
      this.lastPlan = chosen
      return top.drain()
    }
    return run(plan) ?? run(fallback)!
  }

  /** The pin carrying an id — a real event, or a marker derived from a life. */
  pin(id: string): MapPin | undefined {
    const item = this.byId.get(id)
    // a person or a concept carries no pin of its own, and a marker's id is in
    // neither the data nor `byId`
    if (item) return item.kind === 'event' ? item : undefined
    return this.markers.get(id)
  }

  /**
   * The ARTICLE behind an id: the item itself, or — for a life marker — the
   * life it was cut from. What the panel opens when a birth pin is clicked.
   */
  article(id: string): Item | undefined {
    const pin = this.markers.get(id)
    return pin ? pin.of : this.byId.get(id)
  }

  /**
   * The pin for `id`, if the timeline and the filters still admit it.
   *
   * This is what a *selection* is allowed to bypass, and the line is drawn
   * where user intent is: the cap and the camera are the app's judgement about
   * what will fit on screen, and an event the user has explicitly opened should
   * outrank both — losing the pin under the open panel is the app arguing with
   * a decision the user just made. The timeline window and the tag/parent
   * filters are the *user's own* statements about what to show, and overriding
   * those would be the same mistake in the other direction; both have hidden a
   * selected pin since long before this, and both still do.
   */
  admits(id: string, start: Year, end: Year, filter: EventFilter = {}): MapPin | undefined {
    const pin = this.pin(id)
    if (!pin || !intersects(pin, start, end)) return undefined
    return passes(pin, filter, this.byId) ? pin : undefined
  }

  /** Items whose body links to `id`. The other half of a two-way relation. */
  backlinksTo(id: string): Item[] {
    return this.backlinks.get(id) ?? []
  }

  /* ------------------------------------------------------------ relations */

  /** Direct children of `id`, chronological. Not the whole subtree. */
  childrenOf(id: string): HistoricalEvent[] {
    return this.relations.children.get(id) ?? []
  }

  /**
   * What `id` is part of, innermost first: its parent, then its parent's
   * parent, up to the root. `[]` for anything with no parent.
   *
   * Defended against a cycle even though the data cannot hold one — the build
   * script rejects them, but this walk runs on whatever chunks happen to be
   * loaded, and a hang here would take the panel with it.
   */
  parentChain(id: string): HistoricalEvent[] {
    const out: HistoricalEvent[] = []
    const seen = new Set<string>([id])
    let cur = this.byId.get(id)
    while (cur?.kind === 'event' && cur.parent && !seen.has(cur.parent)) {
      seen.add(cur.parent)
      const next = this.byId.get(cur.parent)
      if (next?.kind !== 'event') break
      out.push(next)
      cur = next
    }
    return out
  }

  private lookup(ids: string[] | undefined): Item[] {
    const out: Item[] = []
    for (const id of ids ?? []) {
      const i = this.byId.get(id)
      if (i) out.push(i)
    }
    return out
  }

  /** Strongly associated items, both authoring directions merged, best first. */
  strongOf(id: string): Item[] {
    return this.lookup(this.relations.strong.get(id))
  }

  /** See-also items — weak edges only; the panel adds body-link neighbours. */
  weakOf(id: string): Item[] {
    return this.lookup(this.relations.weak.get(id))
  }
}

/* ------------------------------------------------------------------ search */

/**
 * Name-and-tag search over every loaded item — events, persons and concepts
 * alike — ranked by priority, which is to say by the ranking list.
 *
 * Priority stays the primary key: the list is the app's one statement about
 * what matters, and a search that quietly overrode it would be a second one.
 * Quality of match only breaks ties, where the list has nothing to say — a name
 * beginning with the query ahead of a name merely containing it, and either
 * ahead of a tag-only hit.
 */
export function searchItems(items: Item[], q: string, cap = 8): Item[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  const scored: { item: Item; score: number }[] = []
  for (const i of items) {
    const at = i.name.toLowerCase().indexOf(needle)
    const score = at === 0 ? 2 : at > 0 ? 1 : i.tags.some((t) => t.includes(needle)) ? 0 : -1
    if (score >= 0) scored.push({ item: i, score })
  }
  return scored
    .sort((a, b) => b.item.priority - a.item.priority || b.score - a.score)
    .slice(0, cap)
    .map((s) => s.item)
}
