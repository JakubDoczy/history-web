import { isMinor, shapeOf, type MapPin } from './events'
import type { PinDatum } from './eventClusters'
import type { Tier } from './eventTiers'
import { primaryTag, tagColor } from './tags'

/**
 * Map pins. A point event is the classic teardrop; an area event is a pin
 * *standing on a footprint* — a dashed ellipse under its tip plus corner
 * brackets in its head — so "this covers a region" reads at a glance instead of
 * needing the legend; a path event carries a winding route in its head, drawn
 * in the same white line the brackets are, so "this goes somewhere" reads the
 * same way. The fill colour is the event's primary tag, so the globe
 * reads as one: red = war, blue = technology, grey = extinction…
 *
 * Several events on the same spot collapse into a round count badge instead
 * (see lib/eventClusters.ts); it is deliberately not a teardrop, so a badge is
 * never mistaken for one more event.
 */

/**
 * The size a tier is drawn at, as a factor on the priority-derived height.
 *
 * A multiplier rather than a replacement: priority scaling says how important
 * an event is *in the corpus* and the tier says how it placed *in this result
 * set*, and both are worth reading. The steps are large enough to tell apart at
 * a glance across a whole globe of pins (a tier-1 pin is ~40% taller than a
 * tier-3 one of the same priority) and small enough that the map keeps one
 * visual language rather than three.
 */
export const TIER_SCALE: Record<Tier, number> = { 1: 1, 2: 0.85, 3: 0.7 }

/**
 * Pin height in px: priority 0..100 → 18..30, scaled by tier, and selected pins
 * a third larger again. Tier 1 is the size the map has always drawn.
 */
export const pinHeight = (e: MapPin, selected: boolean, tier: Tier = 1) =>
  Math.round((18 + (e.priority / 100) * 12) * TIER_SCALE[tier] * (selected ? 1.35 : 1))

/**
 * SVG geometry. The teardrop lives in a 24×32 box with its tip at y=31; an area
 * pin keeps that body and extends the box downward for the footprint, so the
 * *pin* is the same size either way and only the artwork grows.
 */
const BOX_W = 24
const BOX_H = 32
const AREA_BOX_H = 39
const TIP_Y = 31

const TEARDROP = 'M12 31C7.2 24.6 3 18.3 3 11.6 3 6 7 2 12 2s9 4 9 9.6c0 6.7-4.2 13-9 19.4z'

/**
 * How far up to shift the artwork so the tip — not the box centre — sits on the
 * coordinate. CSS2DRenderer centres the wrapper, so the shift is measured from
 * the box's mid-line and expressed as a percentage of the box height.
 */
export const pinShiftPercent = (boxH: number, anchorY: number) =>
  -((anchorY - boxH / 2) / boxH) * 100

/** Corner brackets framing the pin head: the "this is a region" mark. */
const brackets = (cx: number, cy: number) => {
  const r = 5.1
  const arm = 2.5
  const corner = (sx: number, sy: number) =>
    `<path d="M${cx + sx * r} ${cy + sy * (r - arm)}L${cx + sx * r} ${cy + sy * r}L${
      cx + sx * (r - arm)
    } ${cy + sy * r}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.97"/>`
  return corner(-1, -1) + corner(1, -1) + corner(-1, 1) + corner(1, 1)
}

/**
 * The path mark: a short winding route across the pin's head, with a dot at
 * each end.
 *
 * Same language as the area brackets — white, 2px round-capped strokes on the
 * tag-coloured body — because they answer the same question in the same place:
 * *what shape of thing is this?* The curve is deliberately an S rather than a
 * straight line; a straight one at this size reads as a strikethrough. The two
 * end dots are the ports, which is what makes it a journey rather than a
 * squiggle, and they survive the shrink to an 18 px minor pin where the curve
 * itself is only a few pixels of stroke.
 */
const route = (cx: number, cy: number) => {
  const r = 5.2
  const x0 = cx - r
  const x1 = cx + r
  return (
    `<path d="M${x0} ${cy + 2.6}C${cx - 2.4} ${cy + 3.4} ${cx - 3.2} ${cy - 3.2} ${cx} ${cy - 2.6}` +
    `C${cx + 3.2} ${cy - 2} ${cx + 2.4} ${cy + 2.2} ${x1} ${cy - 2.8}"` +
    ` fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"` +
    ` opacity="0.97"/>` +
    `<circle cx="${x0}" cy="${cy + 2.6}" r="1.5" fill="#fff" opacity="0.97"/>` +
    `<circle cx="${x1}" cy="${cy - 2.8}" r="1.5" fill="#fff" opacity="0.97"/>`
  )
}

/**
 * The tier-1 mark: a soft ring around the pin's head, drawn *behind* the body.
 *
 * Behind, and at low opacity, so it reads as light coming off the pin rather
 * than as a second drawn shape — the selected pin already owns the "ring on
 * top" idiom (a hard yellow halo), and a leading pin must not be mistaken for a
 * selected one. White rather than the tag colour so it says "important" in the
 * same voice for every category.
 */
const GLOW =
  // both stay inside the 24-wide box: the viewBox clips, and a clipped glow
  // would flatten on the sides into two arcs
  '<circle cx="12" cy="11" r="11" fill="#fff" opacity="0.09"/>' +
  '<circle cx="12" cy="11" r="10.3" fill="none" stroke="#fff" stroke-width="2.6" opacity="0.22"/>'

export function pinSvg(e: MapPin, selected: boolean, tier: Tier = 1): string {
  const color = tagColor(primaryTag(e))
  const h = pinHeight(e, selected, tier)
  // The two shapes the pin's ARTWORK says something about, asked for by kind:
  // a footprint under the tip, a route in the head. A plan says nothing here —
  // it is ink for the map, not a property of the teardrop.
  const area = !!shapeOf(e.geometry, 'area')
  const hasPaths = !!shapeOf(e.geometry, 'routes')
  const boxH = area ? AREA_BOX_H : BOX_H
  const w = Math.round(h * (BOX_W / BOX_H))
  const svgH = Math.round(h * (boxH / BOX_H))
  const stroke = selected ? '#fff' : 'rgba(8,10,16,0.6)'

  // the footprint goes behind the pin body so the tip appears to stand in it
  const footprint = area
    ? `<g class="pin-footprint">` +
      `<ellipse cx="12" cy="33.6" rx="10.2" ry="4.2" fill="${color}" opacity="0.5"/>` +
      // the dashes go white, not tag-coloured: at 18px the ring is four pixels
      // tall and a coloured dash on a coloured fill on dark ground is mud
      `<ellipse cx="12" cy="33.6" rx="10.2" ry="4.2" fill="none" stroke="#fff"` +
      ` stroke-width="2.2" stroke-dasharray="3.6 2.8" stroke-linecap="round" opacity="0.95"/>` +
      `</g>`
    : ''
  // A route beats a footprint in the head when an event has both: the routes
  // are the thing the reader is being invited to open (they are what the globe
  // draws on selection), and the footprint is still said below, by the ellipse
  // the pin stands in.
  const glyph = hasPaths
    ? route(12, 11)
    : area
      ? brackets(12, 11) + '<circle cx="12" cy="11" r="1.5" fill="#fff" opacity="0.97"/>'
      : '<circle cx="12" cy="11" r="3.6" fill="#fff" opacity="0.95"/>'
  const halo = selected
    ? '<circle cx="12" cy="11" r="10.5" fill="none" stroke="#ffe27a" stroke-width="1.6" opacity="0.9"/>'
    : ''
  return (
    `<svg width="${w}" height="${svgH}" viewBox="0 0 ${BOX_W} ${boxH}" xmlns="http://www.w3.org/2000/svg">` +
    footprint +
    (tier === 1 ? GLOW : '') +
    `<path d="${TEARDROP}" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>` +
    glyph +
    halo +
    `</svg>`
  )
}

/** Badge diameter in px for a cluster of `count` events, scaled by its tier. */
export const clusterSize = (count: number, tier: Tier = 1) =>
  Math.round(Math.min(38, 26 + Math.log2(count) * 5) * TIER_SCALE[tier])

/**
 * The cluster badge: a filled disc in the dominant (highest-priority) member's
 * tag colour, the count in white, and a thin outer ring that says "more behind
 * this". Centred on the spot rather than tipped at it — a cluster's position is
 * an approximation, and a teardrop would overstate its precision.
 *
 * The badge carries the *dominant member's* tier, in the same marks a pin uses:
 * a cluster whose best member leads the set glows and stays full size, one made
 * of also-rans is small and quiet. Without that a badge over a city would read
 * as more important than the tier-1 pin next to it merely for being a badge.
 */
export function clusterSvg(members: MapPin[], tier: Tier = 1): string {
  const color = tagColor(primaryTag(members[0]))
  const d = clusterSize(members.length, tier)
  const label = members.length > 99 ? '99+' : String(members.length)
  const fontSize = label.length > 2 ? 13 : 15.5
  return (
    `<svg width="${d}" height="${d}" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">` +
    (tier === 1
      ? '<circle cx="20" cy="20" r="19" fill="none" stroke="#fff" stroke-width="2" opacity="0.22"/>'
      : '') +
    `<circle cx="20" cy="20" r="18" fill="${color}" opacity="0.2"/>` +
    `<circle cx="20" cy="20" r="18" fill="none" stroke="${color}" stroke-width="1.4" opacity="0.85"/>` +
    `<circle cx="20" cy="20" r="13.4" fill="${color}" stroke="rgba(8,10,16,0.6)" stroke-width="1.6"/>` +
    `<text x="20" y="20" text-anchor="middle" dominant-baseline="central"` +
    ` font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"` +
    ` font-size="${fontSize}" font-weight="700" fill="#fff">${label}</text>` +
    `</svg>`
  )
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
 * The tier is part of it, because it is drawn: a pin that changes tier has to
 * be rebuilt at its new size, and one that does not must survive a scrub
 * untouched — which is what the hysteresis in lib/eventTiers.ts is for.
 */
export const pinStateKey = (p: PinDatum, selectedId?: string, tier: Tier = 1): string =>
  p.kind === 'cluster'
    ? `c:${p.id}:${tier}:${p.members.map((e) => e.id).join('|')}`
    : `e:${p.id}:${selectedId === p.id ? 1 : 0}:${tier}`

/** Shared wiring: pins must not let their click reach the globe underneath. */
function interactive(el: HTMLElement, onClick: () => void) {
  el.style.pointerEvents = 'auto'
  el.style.cursor = 'pointer'
  el.addEventListener('pointerdown', (ev) => ev.stopPropagation())
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    onClick()
  })
  return el
}

/** DOM wrapper anchored so the pin's tip sits on the coordinate. */
export function pinElement(
  e: MapPin,
  selected: boolean,
  tier: Tier,
  onClick: () => void,
): HTMLElement {
  const el = document.createElement('div')
  const area = !!shapeOf(e.geometry, 'area')
  el.className =
    'event-pin' +
    ` event-pin--tier${tier}` +
    (selected ? ' event-pin--selected' : '') +
    (area ? ' event-pin--area' : '') +
    // No class for a route event: the winding line is drawn INSIDE the head by
    // `pinSvg`, so unlike the footprint — which the stylesheet animates — there
    // is nothing left for CSS to say about one. The class existed, matched no
    // rule anywhere, and cost a `shapeOf` per pin build.
    //
    // minor pins are opt-in and there are a lot of them; they keep the smallest
    // size pinHeight gives them and go translucent, so they read as a layer
    // underneath the ranked ones rather than as competition for them
    (isMinor(e) ? ' event-pin--minor' : '')
  el.innerHTML = pinSvg(e, selected, tier)
  el.title = e.name
  el.style.setProperty(
    '--pin-shift',
    `${pinShiftPercent(area ? AREA_BOX_H : BOX_H, TIP_Y).toFixed(2)}%`,
  )
  return interactive(el, onClick)
}

/** DOM wrapper for a cluster badge, centred on the coordinate. */
export function clusterElement(
  members: MapPin[],
  tier: Tier,
  onClick: () => void,
): HTMLElement {
  const el = document.createElement('div')
  el.className = `event-pin event-pin--cluster event-pin--tier${tier}`
  el.innerHTML = clusterSvg(members, tier)
  el.title = `${members.length} events here — click to expand`
  el.style.setProperty('--pin-shift', '0%')
  return interactive(el, onClick)
}
