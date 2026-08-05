import { assertNever, featureOf, isMinor, type MapPin } from '../events'
import type { PinDatum } from '../eventClusters'
import type { Tier } from '../eventTiers'
import { primaryTag, tagColor } from '../tags'
import type { RenderCtx, RenderMode } from './mode'

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

/** Everything the renderer needs to draw one teardrop, and nothing else. */
export interface PinSpec {
  glyph: PinGlyph
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
  /** The selected pin's hard ring, or `null`. */
  halo: string | null
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
  /** The step accent, when the badge HIDES a child the step named. */
  accent: string | null
  classes: string[]
}

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

/** The selected pin's halo, and the highlighted child's accent. */
export const HALO_COLOR = '#ffe27a'
export const ACCENT_COLOR = '#7ad1ff'

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
  return {
    glyph,
    footprint: e.kind === 'event' && !!featureOf(e.location, 'area'),
    height: pinHeight(e, ctx.selected, ctx.tier),
    body: tagColor(primaryTag(e)),
    stroke: ctx.selected ? INK[ctx.mode] : STROKE[ctx.mode],
    ink: INK[ctx.mode],
    // The glow says "this one leads the set" in light coming off the pin. Map
    // mode has no light to come off anything, so it says nothing instead.
    glow: ctx.tier === 1 && !flat,
    halo: ctx.selected ? HALO_COLOR : null,
    accent: ctx.highlighted ? ACCENT_COLOR : null,
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
      ...(ctx.highlighted ? ['event-pin--accent'] : []),
      ...(flat ? ['event-pin--flat'] : []),
    ],
  }
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
export function resolveClusterSpec(
  members: MapPin[],
  ctx: Omit<PinCtx, 'selected'>,
): ClusterSpec {
  return {
    count: members.length,
    label: members.length > 99 ? '99+' : String(members.length),
    diameter: clusterSize(members.length, ctx.tier),
    body: tagColor(primaryTag(members[0])),
    ink: INK[ctx.mode],
    ring: ctx.tier === 1 && ctx.mode !== 'schematic',
    // A badge is a pin that swallowed several, so it has to say everything its
    // members would have said. Without this, a step that highlights a child
    // sitting inside a cluster highlights nothing the reader can see — which is
    // the common case at the zoom "Show on map" fits an operation to.
    accent: ctx.highlighted ? ACCENT_COLOR : null,
    classes: [
      'event-pin',
      'event-pin--cluster',
      `event-pin--tier${ctx.tier}`,
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
 */
export const pinStateKey = (
  p: PinDatum,
  selectedId?: string,
  tier: Tier = 1,
  mode: RenderMode = 'realistic',
  highlighted = false,
): string => {
  const m = mode === 'schematic' ? 's' : 'r'
  return p.kind === 'cluster'
    ? `c:${p.id}:${tier}:${m}:${highlighted ? 1 : 0}:${p.members.map((e) => e.id).join('|')}`
    : `e:${p.id}:${selectedId === p.id ? 1 : 0}:${tier}:${m}:${highlighted ? 1 : 0}`
}
