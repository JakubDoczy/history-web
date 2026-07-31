import type { HistoricalEvent } from './events'
import type { PinDatum } from './eventClusters'
import { primaryTag, tagColor } from './tags'

/**
 * Map pins. A point event is the classic teardrop; an area event is a pin
 * *standing on a footprint* — a dashed ellipse under its tip plus corner
 * brackets in its head — so "this covers a region" reads at a glance instead of
 * needing the legend. The fill colour is the event's primary tag, so the globe
 * reads as one: red = war, blue = technology, grey = extinction…
 *
 * Several events on the same spot collapse into a round count badge instead
 * (see lib/eventClusters.ts); it is deliberately not a teardrop, so a badge is
 * never mistaken for one more event.
 */

/** Pin height in px: priority 0..100 → 18..30, selected pins a third larger. */
export const pinHeight = (e: HistoricalEvent, selected: boolean) =>
  Math.round((18 + (e.priority / 100) * 12) * (selected ? 1.35 : 1))

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

export function pinSvg(e: HistoricalEvent, selected: boolean): string {
  const color = tagColor(primaryTag(e))
  const h = pinHeight(e, selected)
  const area = !!e.area
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
  const glyph = area
    ? brackets(12, 11) + '<circle cx="12" cy="11" r="1.5" fill="#fff" opacity="0.97"/>'
    : '<circle cx="12" cy="11" r="3.6" fill="#fff" opacity="0.95"/>'
  const halo = selected
    ? '<circle cx="12" cy="11" r="10.5" fill="none" stroke="#ffe27a" stroke-width="1.6" opacity="0.9"/>'
    : ''
  return (
    `<svg width="${w}" height="${svgH}" viewBox="0 0 ${BOX_W} ${boxH}" xmlns="http://www.w3.org/2000/svg">` +
    footprint +
    `<path d="${TEARDROP}" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>` +
    glyph +
    halo +
    `</svg>`
  )
}

/** Badge diameter in px for a cluster of `count` events. */
export const clusterSize = (count: number) => Math.round(Math.min(38, 26 + Math.log2(count) * 5))

/**
 * The cluster badge: a filled disc in the dominant (highest-priority) member's
 * tag colour, the count in white, and a thin outer ring that says "more behind
 * this". Centred on the spot rather than tipped at it — a cluster's position is
 * an approximation, and a teardrop would overstate its precision.
 */
export function clusterSvg(members: HistoricalEvent[]): string {
  const color = tagColor(primaryTag(members[0]))
  const d = clusterSize(members.length)
  const label = members.length > 99 ? '99+' : String(members.length)
  const fontSize = label.length > 2 ? 13 : 15.5
  return (
    `<svg width="${d}" height="${d}" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">` +
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
 */
export const pinStateKey = (p: PinDatum, selectedId?: string): string =>
  p.kind === 'cluster'
    ? `c:${p.id}:${p.members.map((e) => e.id).join('|')}`
    : `e:${p.id}:${selectedId === p.id ? 1 : 0}`

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
export function pinElement(e: HistoricalEvent, selected: boolean, onClick: () => void): HTMLElement {
  const el = document.createElement('div')
  el.className =
    'event-pin' + (selected ? ' event-pin--selected' : '') + (e.area ? ' event-pin--area' : '')
  el.innerHTML = pinSvg(e, selected)
  el.title = e.name
  el.style.setProperty(
    '--pin-shift',
    `${pinShiftPercent(e.area ? AREA_BOX_H : BOX_H, TIP_Y).toFixed(2)}%`,
  )
  return interactive(el, onClick)
}

/** DOM wrapper for a cluster badge, centred on the coordinate. */
export function clusterElement(members: HistoricalEvent[], onClick: () => void): HTMLElement {
  const el = document.createElement('div')
  el.className = 'event-pin event-pin--cluster'
  el.innerHTML = clusterSvg(members)
  el.title = `${members.length} events here — click to expand`
  el.style.setProperty('--pin-shift', '0%')
  return interactive(el, onClick)
}
