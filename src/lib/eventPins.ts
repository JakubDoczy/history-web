import { assertNever, type MapPin } from './events'
import {
  resolveClusterSpec,
  resolvePinSpec,
  type ClusterSpec,
  type GlyphArt,
  type PinCtx,
  type PinSpec,
} from './present/pin'

/**
 * Map pins — the DRAWING half. What each mark means, and which one a given event
 * gets, is resolved in lib/present/pin.ts; everything here is "given that spec,
 * emit this SVG and this element".
 *
 * The vocabulary: a point event is the classic teardrop; an area event is a pin
 * *standing on a footprint* — a dashed ellipse under its tip plus corner
 * brackets in its head — so "this covers a region" reads at a glance instead of
 * needing the legend; a route event carries a winding line in its head, drawn in
 * the same white the brackets are, so "this goes somewhere" reads the same way;
 * a life marker carries an open ring, so a birth is never mistaken for an event
 * that happened. The fill colour is the event's primary tag, so the globe reads
 * as one: red = war, blue = technology, grey = extinction…
 *
 * Where an event's geometry says nothing — the plain point, which is nine in ten
 * of the corpus — its CATEGORY does instead: crossed swords on a war pin, coins
 * on a trade one, and the plain dot everywhere the registry is silent (see
 * `TAG_GLYPHS` in lib/present/pin.ts). And a SAGA — an event told in steps —
 * carries a thin concentric ring inside its head, in both render modes and
 * through selection, hover and clustering alike.
 *
 * Several events on the same spot collapse into a round count badge instead (see
 * lib/eventClusters.ts); it is deliberately not a teardrop, so a badge is never
 * mistaken for one more event.
 */

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
const brackets = (cx: number, cy: number, ink: string) => {
  const r = 5.1
  const arm = 2.5
  const corner = (sx: number, sy: number) =>
    `<path d="M${cx + sx * r} ${cy + sy * (r - arm)}L${cx + sx * r} ${cy + sy * r}L${
      cx + sx * (r - arm)
    } ${cy + sy * r}" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.97"/>`
  return corner(-1, -1) + corner(1, -1) + corner(-1, 1) + corner(1, 1)
}

/**
 * The route mark: a short winding line across the pin's head, with a dot at each
 * end.
 *
 * Same language as the area brackets — white, 2px round-capped strokes on the
 * tag-coloured body — because they answer the same question in the same place:
 * *what shape of thing is this?* The curve is deliberately an S rather than a
 * straight line; a straight one at this size reads as a strikethrough. The two
 * end dots are the ports, which is what makes it a journey rather than a
 * squiggle, and they survive the shrink to an 18 px minor pin where the curve
 * itself is only a few pixels of stroke.
 */
const route = (cx: number, cy: number, ink: string) => {
  const r = 5.2
  const x0 = cx - r
  const x1 = cx + r
  return (
    `<path d="M${x0} ${cy + 2.6}C${cx - 2.4} ${cy + 3.4} ${cx - 3.2} ${cy - 3.2} ${cx} ${cy - 2.6}` +
    `C${cx + 3.2} ${cy - 2} ${cx + 2.4} ${cy + 2.2} ${x1} ${cy - 2.8}"` +
    ` fill="none" stroke="${ink}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"` +
    ` opacity="0.97"/>` +
    `<circle cx="${x0}" cy="${cy + 2.6}" r="1.5" fill="${ink}" opacity="0.97"/>` +
    `<circle cx="${x1}" cy="${cy - 2.8}" r="1.5" fill="${ink}" opacity="0.97"/>`
  )
}

/**
 * The tier-1 mark: a soft ring around the pin's head, drawn *behind* the body.
 *
 * Behind, and at low opacity, so it reads as light coming off the pin rather
 * than as a second drawn shape — the selected pin already owns the "ring on top"
 * idiom (a hard yellow halo), and a leading pin must not be mistaken for a
 * selected one. White rather than the tag colour so it says "important" in the
 * same voice for every category.
 */
const GLOW =
  // both stay inside the 24-wide box: the viewBox clips, and a clipped glow
  // would flatten on the sides into two arcs
  '<circle cx="12" cy="11" r="11" fill="#fff" opacity="0.09"/>' +
  '<circle cx="12" cy="11" r="10.3" fill="none" stroke="#fff" stroke-width="2.6" opacity="0.22"/>'

/**
 * The saga ring: a thin circle inside the pin head, under everything else in it.
 *
 * Inside the head rather than around it — see `PinSpec.saga` for why — and drawn
 * before the glyph so a mark that reaches the ring sits on top of it rather than
 * being cut by it. One radius for every pin, so a globe of sagas reads as one
 * mark repeated instead of as a family of near-circles.
 */
const SAGA_RING = (ink: string) =>
  `<circle cx="12" cy="11" r="7.1" fill="none" stroke="${ink}" stroke-width="1" opacity="0.75"/>`

/** A category mark from the registry, in the pin's ink (lib/present/pin.ts). */
const markSvg = (art: GlyphArt, ink: string): string =>
  art
    .map((p) =>
      p.fill
        ? `<path d="${p.d}" fill="${ink}" opacity="0.97"/>`
        : `<path d="${p.d}" fill="none" stroke="${ink}" stroke-width="${p.width ?? 1.6}"` +
          ` stroke-linecap="round" stroke-linejoin="round" opacity="0.97"/>`,
    )
    .join('')

/** The mark in the head, by glyph. The resolver chose which; this draws it. */
const glyphSvg = (spec: PinSpec): string => {
  const { ink } = spec
  // A category mark stands in for the plain dot: the resolver only ever hands
  // one over for a pin whose head would otherwise hold nothing but that dot.
  if (spec.mark) return markSvg(spec.mark, ink)
  switch (spec.glyph) {
    case 'route':
      return route(12, 11, ink)
    case 'area':
      return brackets(12, 11, ink) + `<circle cx="12" cy="11" r="1.5" fill="${ink}" opacity="0.97"/>`
    case 'dot':
      return `<circle cx="12" cy="11" r="3.6" fill="${ink}" opacity="0.95"/>`
    // A life is an open ring rather than a filled dot: a birth and a death are
    // the two ends of something, not a thing that happened, and at 18 px an
    // outline against a filled disc is the clearest difference there is.
    case 'life':
      return (
        `<circle cx="12" cy="11" r="3.5" fill="none" stroke="${ink}" stroke-width="1.8" opacity="0.95"/>` +
        `<circle cx="12" cy="11" r="1.1" fill="${ink}" opacity="0.95"/>`
      )
    default:
      return assertNever(spec.glyph)
  }
}

/** One teardrop, from a resolved spec. */
export function pinSvg(spec: PinSpec): string {
  const h = spec.height
  const boxH = spec.footprint ? AREA_BOX_H : BOX_H
  const w = Math.round(h * (BOX_W / BOX_H))
  const svgH = Math.round(h * (boxH / BOX_H))

  // the footprint goes behind the pin body so the tip appears to stand in it
  const footprint = spec.footprint
    ? `<g class="pin-footprint">` +
      `<ellipse cx="12" cy="33.6" rx="10.2" ry="4.2" fill="${spec.body}" opacity="0.5"/>` +
      // the dashes go white, not tag-coloured: at 18px the ring is four pixels
      // tall and a coloured dash on a coloured fill on dark ground is mud
      `<ellipse cx="12" cy="33.6" rx="10.2" ry="4.2" fill="none" stroke="${spec.ink}"` +
      ` stroke-width="2.2" stroke-dasharray="3.6 2.8" stroke-linecap="round" opacity="0.95"/>` +
      `</g>`
    : ''
  const halo = spec.halo
    ? `<circle cx="12" cy="11" r="10.5" fill="none" stroke="${spec.halo}" stroke-width="1.6" opacity="0.9"/>`
    : ''
  // Outside the halo, so a pin can be both selected and highlighted and still
  // say both. Sized to stay inside the 24-wide box, like the glow.
  const accent = spec.accent
    ? `<circle cx="12" cy="11" r="11.2" fill="none" stroke="${spec.accent}" stroke-width="1.5" opacity="0.95"/>`
    : ''
  return (
    `<svg width="${w}" height="${svgH}" viewBox="0 0 ${BOX_W} ${boxH}" xmlns="http://www.w3.org/2000/svg">` +
    footprint +
    (spec.glow ? GLOW : '') +
    `<path d="${TEARDROP}" fill="${spec.body}" stroke="${spec.stroke}" stroke-width="1.5"/>` +
    (spec.saga ? SAGA_RING(spec.ink) : '') +
    glyphSvg(spec) +
    halo +
    accent +
    `</svg>`
  )
}

/**
 * The cluster badge: a filled disc in the dominant (highest-priority) member's
 * tag colour, the count in white, and a thin outer ring that says "more behind
 * this". Centred on the spot rather than tipped at it — a cluster's position is
 * an approximation, and a teardrop would overstate its precision.
 */
export function clusterSvg(spec: ClusterSpec): string {
  const d = spec.diameter
  const fontSize = spec.label.length > 2 ? 13 : 15.5
  return (
    `<svg width="${d}" height="${d}" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">` +
    (spec.ring
      ? `<circle cx="20" cy="20" r="19" fill="none" stroke="${spec.ink}" stroke-width="2" opacity="0.22"/>`
      : '') +
    `<circle cx="20" cy="20" r="18" fill="${spec.body}" opacity="0.2"/>` +
    `<circle cx="20" cy="20" r="18" fill="none" stroke="${spec.body}" stroke-width="1.4" opacity="0.85"/>` +
    `<circle cx="20" cy="20" r="13.4" fill="${spec.body}" stroke="rgba(8,10,16,0.6)" stroke-width="1.6"/>` +
    // The same mark a saga pin carries, in the badge's own geometry: inside the
    // disc, thin, and clear of the tier ring outside it.
    (spec.saga
      ? `<circle cx="20" cy="20" r="15.8" fill="none" stroke="${spec.ink}" stroke-width="1.1" opacity="0.8"/>`
      : '') +
    `<text x="20" y="20" text-anchor="middle" dominant-baseline="central"` +
    ` font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"` +
    ` font-size="${fontSize}" font-weight="700" fill="${spec.ink}">${spec.label}</text>` +
    (spec.accent
      ? `<circle cx="20" cy="20" r="19.2" fill="none" stroke="${spec.accent}" stroke-width="1.6" opacity="0.95"/>`
      : '') +
    `</svg>`
  )
}

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
export function pinElement(e: MapPin, ctx: PinCtx, onClick: () => void): HTMLElement {
  const spec = resolvePinSpec(e, ctx)
  const el = document.createElement('div')
  el.className = spec.classes.join(' ')
  el.innerHTML = pinSvg(spec)
  el.title = e.name
  el.style.setProperty(
    '--pin-shift',
    `${pinShiftPercent(spec.footprint ? AREA_BOX_H : BOX_H, TIP_Y).toFixed(2)}%`,
  )
  return interactive(el, onClick)
}

/** DOM wrapper for a cluster badge, centred on the coordinate. */
export function clusterElement(
  members: MapPin[],
  ctx: Omit<PinCtx, 'selected'>,
  onClick: () => void,
): HTMLElement {
  const spec = resolveClusterSpec(members, ctx)
  const el = document.createElement('div')
  el.className = spec.classes.join(' ')
  el.innerHTML = clusterSvg(spec)
  el.title = `${spec.count} events here — click to expand`
  el.style.setProperty('--pin-shift', '0%')
  return interactive(el, onClick)
}
