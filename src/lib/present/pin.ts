import { assertNever, featureOf, isMinor, type MapPin } from '../events'
import type { PinDatum } from '../eventClusters'
import type { Tier } from '../eventTiers'
import { primaryTag, tagColor, type Tag } from '../tags'
import type { RenderCtx, RenderMode } from './mode'
import { sagaOf } from './saga'
import { inkOnPaper, MARK_MIX } from './ink'

/**
 * WHAT A PIN LOOKS LIKE — resolved from the domain, emitted by lib/eventPins.ts.
 *
 * The split is the point. `resolvePinSpec` decides *what mark this thing gets*:
 * which glyph, how big, what colour, whether it glows. `pinSvg` decides how to
 * draw that in SVG. They used to be one function, and the consequence was that
 * "an event with routes shows a winding line in its head" — a statement about
 * the MODEL — was a ternary inside a template literal, reachable only by
 * building a pin and reading the string back out.
 *
 * Everything below is pure and total: same pin, same context, same spec.
 */

/** The mark in the pin's head. One per shape of thing the map can hold. */
export type PinGlyph =
  /** A plain point event: a filled dot. */
  | 'dot'
  /** An event with routes: a winding line with a port at each end. */
  | 'route'
  /** An event with a footprint: corner brackets around a small centre dot. */
  | 'area'
  /** A life marker: an open ring, so a birth never reads as an event. */
  | 'life'

/* ------------------------------------------------------- category glyphs */

/** A point in the pin's own 24×32 box. */
export type GlyphPt = readonly [x: number, y: number]

/**
 * Where a category glyph is drawn, and how much room it has.
 *
 * The head of the teardrop is a disc of radius 9 centred just under (12, 11);
 * the saga ring (lib/eventPins.ts) is inside it at 7.1, and the ring's inner
 * edge is therefore at 6.6. `GLYPH_R` is what is left for the mark, with a
 * margin around it — the reported fault was crossed swords drawn out to 6.4,
 * which at 1x collided with the ring and ran into the rim, so the tips came
 * back as fragments ("you only see parts of the swords").
 *
 * It is a metric of the REGISTRY, checked against every entry by
 * tests/eventPins.test.ts (`glyphReach`), rather than a scale factor applied by
 * whoever is drawing: a glyph auto-shrunk to fit is a glyph nobody looked at.
 */
export const GLYPH_CENTRE: GlyphPt = [12, 11]
export const GLYPH_R = 5.0

/**
 * One drawn part of a category glyph, as geometry rather than as a path string.
 *
 * Two shapes cover the registry — a round-capped segment and an ellipse — and
 * saying so in the data is what makes the fit above CHECKABLE: the ink a part
 * covers can be measured (`glyphReach`) instead of being guessed at from a
 * `d` attribute. lib/eventPins.ts turns these into path data; there are still no
 * rasters, so a glyph costs no request and takes its mode's ink colour.
 */
export type GlyphPart =
  /** A blade, a beam: a segment, stroked and round-capped. */
  | { kind: 'stroke'; from: GlyphPt; to: GlyphPt; width: number }
  /** A coin: an ellipse, filled — or, with a `width`, drawn as a ring. */
  | { kind: 'ellipse'; at: GlyphPt; rx: number; ry: number; width?: number }

export type GlyphArt = readonly GlyphPart[]

const dist = ([x, y]: GlyphPt) => Math.hypot(x - GLYPH_CENTRE[0], y - GLYPH_CENTRE[1])

/**
 * How far a glyph's ink reaches from the head's centre, in box units — the
 * number `GLYPH_R` is the budget for.
 *
 * Exact for a stroke (a round cap is a disc of half the stroke's width at each
 * end, so the reach is the further endpoint plus that) and sampled for an
 * ellipse, which has no closed form worth writing here.
 */
export const glyphReach = (art: GlyphArt): number =>
  Math.max(
    ...art.map((p) =>
      p.kind === 'stroke'
        ? Math.max(dist(p.from), dist(p.to)) + p.width / 2
        : Math.max(
            ...Array.from({ length: 64 }, (_, i) => {
              const a = (i / 64) * 2 * Math.PI
              return dist([p.at[0] + p.rx * Math.cos(a), p.at[1] + p.ry * Math.sin(a)])
            }),
          ) + (p.width ?? 0) / 2,
    ),
  )

const stroke = (from: GlyphPt, to: GlyphPt, width: number): GlyphPart => ({
  kind: 'stroke',
  from,
  to,
  width,
})

/**
 * CROSSED SWORDS — war.
 *
 * Two blades and two guards, and the count is the design: at the size a pin
 * head actually is (a 6–9 px circle inside a 12–16 px teardrop) every stroke
 * costs contrast, and a blade with a pommel and a fuller is a smudge. The
 * blades run corner to corner so the mark reads as an X first and as swords
 * second, which is the right order — an X on a red pin already says "battle".
 *
 * All four extremes are laid on the same circle of radius `GLYPH_R`, so the
 * mark is as large as its budget and no larger, and it is round: nothing sticks
 * out at one corner to be the first thing the rim eats.
 */
const SWORDS: GlyphArt = [
  stroke([9.05, 13.95], [14.95, 8.05], 1.5),
  stroke([14.95, 13.95], [9.05, 8.05], 1.5),
  stroke([8.2, 12.6], [10.3, 14.7], 1.3),
  stroke([15.8, 12.6], [13.7, 14.7], 1.3),
]

/**
 * STACKED COINS — trade (the `economy` tag, which is what this corpus calls it).
 *
 * Scales lost, and they lost at real size rather than on paper. Three candidates
 * were rendered through this same resolver at the three sizes a pin is actually
 * drawn at (tests/e2e/pins.harness.ts; the comparison is
 * /tmp/shots42/glyph-candidates.png):
 *
 *  · SCALES are five thin strokes — post, beam, base and two pans — inside a
 *    circle that is 7 px across on a leading pin and 4 px on a minor one. At
 *    1x they anti-alias to grey and the pans close into the beam; the mark
 *    survives only at the 4x zoom nobody looks at it from.
 *  · A COIN PAIR (a disc and a ring, offset) holds its contrast but reads as a
 *    key, or as a percent sign — two round things, no stack.
 *  · A COIN STACK is three chunky horizontal marks. Horizontal strokes are the
 *    one thing in this registry that cannot be confused with the war X, it
 *    stays solid at the 18 px minor pin, and at 4x it is unmistakably coins.
 *
 * Which is the contract's own instruction taken literally — "stacked coins if
 * scales read badly at 12–16 px; decide by looking, at real pin size".
 */
const COINS: GlyphArt = [
  { kind: 'ellipse', at: [12, 7.9], rx: 3.6, ry: 1.45 },
  { kind: 'ellipse', at: [12, 11], rx: 3.6, ry: 1.45, width: 1.1 },
  { kind: 'ellipse', at: [12, 14.1], rx: 3.6, ry: 1.45 },
]

/**
 * The registry: primary tag → the mark in the pin head.
 *
 * Keyed by the same tag that already picks the pin's colour (`tagColor`), so
 * the two halves of "what kind of thing is this" are one lookup apart and can
 * never disagree. Deliberately sparse: a category with no entry keeps today's
 * plain dot, because a glyph nobody can read at 14 px is worse than the dot it
 * replaced — the bar for adding one is that it survives `pinSvg` at height 18.
 */
export const TAG_GLYPHS: Partial<Record<Tag, GlyphArt>> = {
  war: SWORDS,
  economy: COINS,
}

/** Everything the renderer needs to draw one teardrop, and nothing else. */
export interface PinSpec {
  glyph: PinGlyph
  /**
   * The category mark drawn in the head, or `null` for the categories that have
   * none. Resolved beside the colour — see `TAG_GLYPHS`.
   */
  mark: GlyphArt | null
  /**
   * THE SAGA MARK: a thin concentric ring inside the pin head, drawn under the
   * category glyph.
   *
   * Inside rather than outside, which is the one judgement in it. Outside the
   * head are two rings already spoken for — the selection's halo and a step's
   * accent — and a third ring out there would be a third thing to tell apart in
   * the same two pixels of margin. Inside, the ring is unambiguous, it survives
   * being selected, highlighted, hovered and tier-1-glowing all at once, and it
   * is the same mark in both render modes.
   */
  saga: boolean
  /** The dashed ellipse under the tip — "this pin stands on a region". */
  footprint: boolean
  /** Height in px: priority, tier and selection already applied. */
  height: number
  /** The teardrop's fill: the event's primary tag colour. */
  body: string
  /** The teardrop's outline. */
  stroke: string
  /** Everything drawn inside the head, and the footprint's dashes. */
  ink: string
  /** The soft tier-1 ring behind the body. */
  glow: boolean
  /**
   * THE SELECTION'S TONE, or `null` — everything the selected pin is drawn in.
   *
   * A tone rather than a ring, which is round 58's correction. It used to be
   * called `halo` and it was one: a circle of radius 10.5 round the head. A
   * circle centred on the head cannot be drawn outside a teardrop — the head is
   * 9 across and the body goes on *downward* for another 20, so any circle wide
   * enough to clear the head re-enters the silhouette at the tail and is drawn
   * across it. That is the reported fault, in one sentence: *"the circle is
   * crossing the pin in a weird way"*. What the tone draws now is stated in
   * lib/eventPins.ts, where the geometry lives: a rim on the pin's own outline
   * and a ring on the ground under its tip.
   */
  select: string | null
  /**
   * The accent a step's `highlights` puts on a child pin, or `null`.
   *
   * A second ring, in a different colour from the selection's, because the two
   * mean different things and can be on at once: the selection is "you opened
   * this", the accent is "this step is about this".
   */
  accent: string | null
  /** Classes for the wrapper element. The stylesheet's half of the same answer. */
  classes: string[]
}

/** What a cluster badge looks like. Same split, same reasons. */
export interface ClusterSpec {
  count: number
  /** The text in the badge — capped, so a big cluster does not overflow it. */
  label: string
  /** Diameter in px, tier applied. */
  diameter: number
  body: string
  ink: string
  /** The tier-1 outer ring. */
  ring: boolean
  /**
   * The saga mark, when ANY member is a saga.
   *
   * A badge is a pin that swallowed several, so it has to say everything its
   * members would have said (the same argument the accent below is here on). At
   * the zoom a saga is fitted to, its own pin is often inside a badge, and a
   * ring the reader cannot see is a ring that is not there.
   */
  saga: boolean
  /**
   * THE SELECTION'S TONE, when the badge has swallowed the selected pin.
   *
   * The same argument the accent below is here on, and the same argument the
   * saga ring is: a badge is a pin that swallowed several, so it has to say
   * everything its members would have said.
   *
   * It is a FALLBACK, and honestly so. `layoutPins` (lib/eventClusters.ts) lifts
   * the open event out of its badge and draws it on its own coordinates, so on a
   * live globe this is never true — which is the better answer of the two,
   * because a lifted pin can carry the whole treatment and a badge could carry
   * only a hint of it. What this covers is the day that lift is not there: a
   * badge standing on the reader's open event and saying nothing is the defect
   * round 58 was opened for, one level up.
   */
  select: string | null
  /** The step accent, when the badge HIDES a child the step named. */
  accent: string | null
  classes: string[]
}

/**
 * What a badge needs to know. `selected` is optional because a badge's
 * selection is a question about its MEMBERS rather than about itself — the
 * caller answers it by looking for the open event in the stack (see
 * `stablePins` in GlobeView) — and most callers have nothing selected at all.
 */
export interface ClusterCtx extends Omit<PinCtx, 'selected'> {
  /** Is the reader's open event one of the pins this badge swallowed? */
  selected?: boolean
}

/**
 * Does this stack hold the open event? The one place that question is answered,
 * so the badge's artwork (`ClusterSpec.select`) and its identity
 * (`pinStateKey`) can never disagree about it.
 */
export const clusterHolds = (members: readonly MapPin[], selectedId?: string): boolean =>
  !!selectedId && members.some((m) => m.id === selectedId)

/** What the resolver needs to know beyond the pin itself. */
export interface PinCtx extends RenderCtx {
  selected: boolean
  tier: Tier
  /** Named by the open step's `highlights` (lib/steps.ts). */
  highlighted?: boolean
}

/**
 * The size a tier is drawn at, as a factor on the priority-derived height.
 *
 * A multiplier rather than a replacement: priority scaling says how important an
 * event is *in the corpus* and the tier says how it placed *in this result set*,
 * and both are worth reading. The steps are large enough to tell apart at a
 * glance across a whole globe of pins (a tier-1 pin is ~40% taller than a tier-3
 * one of the same priority) and small enough that the map keeps one visual
 * language rather than three.
 */
export const TIER_SCALE: Record<Tier, number> = { 1: 1, 2: 0.85, 3: 0.7 }

/**
 * Pin height in px: priority 0..100 → 18..30, scaled by tier, and selected pins
 * a third larger again. Tier 1 is the size the map has always drawn.
 */
export const pinHeight = (e: MapPin, selected: boolean, tier: Tier = 1) =>
  Math.round((18 + (e.priority / 100) * 12) * TIER_SCALE[tier] * (selected ? 1.35 : 1))

/**
 * The selected pin's tone, and the highlighted child's accent — per mode,
 * because the ground under them is not the same ground.
 *
 * Both were chosen against a night-blue ocean: `#ffe27a`, which on Blue Marble
 * is unmistakable and on the drawn map's parchment measures 1.11:1 against the
 * land tone. `inkOnPaper` is the whole of that fix — the hue is what says
 * "selected" and "the step means this one", and it survives being taken toward
 * the map's own pen. Round 52 chose the hue; round 58 changed what is *drawn*
 * in it (see `PinSpec.select`) — and, with it, the weight of the mix.
 *
 * `MARK_MIX` rather than round 52's 0.5, and for that constant's own reason: a
 * hairline ring could afford to be quiet, and the rim and the ground ring are a
 * SYMBOL — a few square millimetres of ink that either reads at 18 px or is not
 * there. 0.55 lands the tone at 3.3:1 against the parchment's land, against
 * 2.9:1 before, which is the difference between a drawn mark and a stain.
 */
export const SELECT_COLOR = {
  realistic: '#ffe27a',
  schematic: inkOnPaper('#ffe27a', MARK_MIX),
} as const
export const ACCENT_COLOR = { realistic: '#7ad1ff', schematic: inkOnPaper('#7ad1ff', 0.42) } as const

/** The white every glyph is drawn in. Flatter in map mode — see `resolvePinSpec`. */
const INK = { realistic: '#fff', schematic: '#f4f7fb' } as const
/** The body outline: a dark rim on the photographic globe, a hard line on the map. */
const STROKE = { realistic: 'rgba(8,10,16,0.6)', schematic: '#10151f' } as const

/**
 * Which mark a pin gets, and the one place that decision lives.
 *
 * Order matters and is a judgement: a route beats a footprint, because the
 * routes are the thing the reader is being invited to open (they are what the
 * globe draws on selection) and the footprint is still said by the ellipse the
 * pin stands in. A life marker beats both, because it is not an event at all.
 */
export function pinGlyphFor(e: MapPin): PinGlyph {
  switch (e.kind) {
    case 'life-marker':
      return 'life'
    case 'event':
      if (featureOf(e.location, 'line')) return 'route'
      return featureOf(e.location, 'area') ? 'area' : 'dot'
    default:
      return assertNever(e)
  }
}

/**
 * A pin, resolved.
 *
 * Map mode's divergence is deliberately small and deliberately real: the same
 * glyphs and the same sizes — a pin is a pin — but no soft tier glow and a hard
 * outline instead of a shadowed rim, because a schematic map draws with lines
 * and a photographic one draws with light. The wrapper class is what carries the
 * rest of that to the stylesheet (drop shadows, the footprint's breathing
 * animation), which is where those live already.
 */
export function resolvePinSpec(e: MapPin, ctx: PinCtx): PinSpec {
  const flat = ctx.mode === 'schematic'
  const glyph = pinGlyphFor(e)
  // The category mark and the body colour are the same lookup, one line apart:
  // both are what the primary tag says this pin IS.
  //
  // Only where the head would otherwise hold nothing but the plain dot, which
  // is nine pins in ten. A route's winding line and a footprint's brackets are
  // STRUCTURAL — they are what this pin's own geometry says, and the reader
  // needs them to know the thing is openable — so they keep the head. The
  // composite the design asked for (coins over the route motif) was drawn and
  // looked at: at 14 px it is two marks in seven pixels and reads as neither.
  // The route pin keeps its route; the colour still says trade.
  const mark = glyph === 'dot' ? (TAG_GLYPHS[primaryTag(e)] ?? null) : null
  return {
    glyph,
    mark,
    saga: !!sagaOf(e),
    footprint: e.kind === 'event' && !!featureOf(e.location, 'area'),
    height: pinHeight(e, ctx.selected, ctx.tier),
    body: tagColor(primaryTag(e)),
    stroke: ctx.selected ? INK[ctx.mode] : STROKE[ctx.mode],
    ink: INK[ctx.mode],
    // The glow says "this one leads the set" in light coming off the pin. Map
    // mode has no light to come off anything, so it says nothing instead.
    glow: ctx.tier === 1 && !flat,
    select: ctx.selected ? SELECT_COLOR[ctx.mode] : null,
    accent: ctx.highlighted ? ACCENT_COLOR[ctx.mode] : null,
    classes: [
      'event-pin',
      `event-pin--tier${ctx.tier}`,
      ...(ctx.selected ? ['event-pin--selected'] : []),
      ...(glyph === 'area' || (e.kind === 'event' && featureOf(e.location, 'area'))
        ? ['event-pin--area']
        : []),
      // minor pins are opt-in and there are a lot of them; they keep the
      // smallest size and go translucent, so they read as a layer underneath the
      // ranked ones rather than as competition for them
      ...(isMinor(e) ? ['event-pin--minor'] : []),
      ...(sagaOf(e) ? ['event-pin--saga'] : []),
      ...(ctx.highlighted ? ['event-pin--accent'] : []),
      ...(flat ? ['event-pin--flat'] : []),
    ],
  }
}

/**
 * What a pin says when it is hovered.
 *
 * Its name — and, for a saga, that it is one and how many steps it holds. The
 * hover is where the map can afford a sentence, and "Saga · 11 steps" is the cue
 * that tells a reader the pin they are about to open leads somewhere with a
 * shape to it, before they open it. Same vocabulary as the pill, the rail and
 * the panel's own call to action.
 */
export const pinTitle = (e: MapPin): string => {
  const steps = sagaOf(e)
  return steps ? `${e.name}\nSaga · ${steps.length} steps` : e.name
}

/** Badge diameter in px for a cluster of `count` events, scaled by its tier. */
export const clusterSize = (count: number, tier: Tier = 1) =>
  Math.round(Math.min(38, 26 + Math.log2(count) * 5) * TIER_SCALE[tier])

/**
 * A cluster badge, resolved.
 *
 * The badge carries the *dominant member's* tier, in the same marks a pin uses:
 * a cluster whose best member leads the set keeps its ring and its full size,
 * one made of also-rans is small and quiet. Without that a badge over a city
 * would read as more important than the tier-1 pin next to it merely for being a
 * badge.
 */
export function resolveClusterSpec(members: MapPin[], ctx: ClusterCtx): ClusterSpec {
  return {
    count: members.length,
    label: members.length > 99 ? '99+' : String(members.length),
    diameter: clusterSize(members.length, ctx.tier),
    body: tagColor(primaryTag(members[0])),
    ink: INK[ctx.mode],
    ring: ctx.tier === 1 && ctx.mode !== 'schematic',
    saga: members.some((m) => !!sagaOf(m)),
    select: ctx.selected ? SELECT_COLOR[ctx.mode] : null,
    // A badge is a pin that swallowed several, so it has to say everything its
    // members would have said. Without this, a step that highlights a child
    // sitting inside a cluster highlights nothing the reader can see — which is
    // the common case at the zoom "Show on map" fits a saga to.
    accent: ctx.highlighted ? ACCENT_COLOR[ctx.mode] : null,
    classes: [
      'event-pin',
      'event-pin--cluster',
      `event-pin--tier${ctx.tier}`,
      // the same class a selected pin carries, because it buys the same thing:
      // full opacity and the top of the stack (GlobeView's stylesheet)
      ...(ctx.selected ? ['event-pin--selected'] : []),
      ...(members.some((m) => sagaOf(m)) ? ['event-pin--saga'] : []),
      ...(ctx.highlighted ? ['event-pin--accent'] : []),
      ...(ctx.mode === 'schematic' ? ['event-pin--flat'] : []),
    ],
  }
}

/**
 * A pin's significance tier: its own, or — for a cluster badge — its dominant
 * member's.
 *
 * Dominant by *tier*, not by the raw priority the cluster is anchored on: the
 * two orders differ once the coverage penalty is applied (see
 * `effectivePriority` in lib/events.ts), and a badge hiding the set's leading
 * event has to say so whichever member the badge happens to be sitting on.
 *
 * Anything absent from the map is not in the result set and so cannot lead it,
 * which is what the 3 (the least significant tier) defaults stand for.
 */
export const pinTier = (p: PinDatum, tiers: ReadonlyMap<string, Tier>): Tier =>
  p.kind === 'cluster'
    ? p.members.reduce<Tier>((best, m) => Math.min(best, tiers.get(m.id) ?? 3) as Tier, 3)
    : (tiers.get(p.event.id) ?? 3)

/**
 * Everything about a pin that decides what its DOM looks like.
 *
 * The globe's HTML layer keeps the element it already built for a datum it has
 * seen before, and rebuilds — reparsing the SVG — for one it has not. Keying on
 * this string means a pin is rebuilt when, and only when, its artwork would
 * actually differ: a zoom that leaves the same events on screen touches no DOM
 * at all, however many times it re-runs the layout.
 *
 * Position is deliberately *not* part of the key. A fanned pin moves as the
 * camera zooms, and moving an element is a transform, not a rebuild.
 *
 * The tier is part of it, because it is drawn: a pin that changes tier has to be
 * rebuilt at its new size, and one that does not must survive a scrub untouched
 * — which is what the hysteresis in lib/eventTiers.ts is for. So are the mode
 * and the step highlight, for exactly the same reason: both change the artwork.
 *
 * And so is sagahood, which is drawn (the ring) and which an item can *gain*:
 * the same event arrives in the spine and again in its era chunk, and a merge
 * replaces the object. Without this a pin that grew steps under a reader's
 * cursor would keep the artwork it was built with.
 *
 * A BADGE now reads the selection too (round 58): a stack holding the open event
 * is drawn selected, so a stack that gains or loses it has to be rebuilt — which
 * is exactly what the reader does by zooming out until their pin collapses.
 */
export const pinStateKey = (
  p: PinDatum,
  selectedId?: string,
  tier: Tier = 1,
  mode: RenderMode = 'realistic',
  highlighted = false,
): string => {
  const m = mode === 'schematic' ? 's' : 'r'
  const saga = (e: MapPin) => (sagaOf(e) ? 1 : 0)
  return p.kind === 'cluster'
    ? `c:${p.id}:${clusterHolds(p.members, selectedId) ? 1 : 0}:${tier}:${m}:${
        highlighted ? 1 : 0
      }:${p.members.map((e) => `${e.id}${saga(e)}`).join('|')}`
    : `e:${p.id}:${selectedId === p.id ? 1 : 0}:${tier}:${m}:${highlighted ? 1 : 0}:${saga(p.event)}`
}
