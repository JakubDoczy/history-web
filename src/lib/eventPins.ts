import type { HistoricalEvent } from './events'
import { primaryTag, tagColor } from './tags'

/**
 * Map pins. A point event is the classic teardrop; an area event is the same
 * silhouette with a hollow square in place of the dot — "this marks a region,
 * not a spot". The fill colour is the event's primary tag, so the globe reads
 * as a legend: red = war, blue = technology, grey = extinction…
 */

/** Pin height in px: priority 0..100 → 18..30, selected pins a third larger. */
export const pinHeight = (e: HistoricalEvent, selected: boolean) =>
  Math.round((18 + (e.priority / 100) * 12) * (selected ? 1.35 : 1))

export function pinSvg(e: HistoricalEvent, selected: boolean): string {
  const color = tagColor(primaryTag(e))
  const h = pinHeight(e, selected)
  const w = Math.round(h * 0.75)
  const glyph = e.area
    ? '<rect x="8.4" y="7.4" width="7.2" height="7.2" rx="1.4" fill="none" stroke="#fff" stroke-width="1.9" opacity="0.95"/>'
    : '<circle cx="12" cy="11" r="3.6" fill="#fff" opacity="0.95"/>'
  const halo = selected
    ? '<circle cx="12" cy="11" r="10.5" fill="none" stroke="#ffe27a" stroke-width="1.6" opacity="0.9"/>'
    : ''
  return (
    `<svg width="${w}" height="${h}" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="M12 31C7.2 24.6 3 18.3 3 11.6 3 6 7 2 12 2s9 4 9 9.6c0 6.7-4.2 13-9 19.4z"` +
    ` fill="${color}" stroke="${selected ? '#fff' : 'rgba(8,10,16,0.6)'}" stroke-width="1.5"/>` +
    glyph +
    halo +
    `</svg>`
  )
}

/** DOM wrapper anchored so the pin's tip sits on the coordinate. */
export function pinElement(e: HistoricalEvent, selected: boolean, onClick: () => void): HTMLElement {
  const el = document.createElement('div')
  el.className = 'event-pin' + (selected ? ' event-pin--selected' : '')
  el.innerHTML = pinSvg(e, selected)
  el.title = e.name
  el.style.pointerEvents = 'auto'
  el.style.cursor = 'pointer'
  el.addEventListener('pointerdown', (ev) => ev.stopPropagation())
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    onClick()
  })
  return el
}
