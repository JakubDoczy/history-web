/**
 * PIN ARTWORK, at the size a pin actually is.
 *
 * The one claim about pins that no unit test can settle: whether a mark is
 * LEGIBLE. `pinSvg` is a string, and a string test can only say that the path
 * data is present — it cannot say that crossed swords at 14 px read as swords
 * rather than as a smudge, which is the whole question the glyph registry
 * turns on (see `TAG_GLYPHS` in src/lib/present/pin.ts).
 *
 * So this renders the real resolver's real output, at the real sizes, over the
 * two grounds the globe actually shows — a bright ocean and dark land — and the
 * decision is made by looking. Driven by tests/e2e/sagaPins.e2e.mjs.
 */
import { parseItem, type HistoricalEvent, type MapPin, type RawEvent } from '../../src/lib/events'
import { clusterSvg, pinSvg } from '../../src/lib/eventPins'
import { resolveClusterSpec, resolvePinSpec } from '../../src/lib/present/pin'
import type { RenderMode } from '../../src/lib/present/mode'
import type { Tier } from '../../src/lib/eventTiers'

const ev = (o: Partial<RawEvent> & { id: string }): HistoricalEvent =>
  parseItem({
    name: o.id, start: 1941, lat: 0, lng: 0, priority: 70, tags: ['war'], summary: '', ...o,
  }) as HistoricalEvent

const STEPS = [{ id: 'one', name: 'One', at: 0 }]

const pin = (e: MapPin, o: { mode?: RenderMode; tier?: Tier; selected?: boolean } = {}) =>
  pinSvg(
    resolvePinSpec(e, {
      mode: o.mode ?? 'realistic',
      tier: o.tier ?? 1,
      selected: o.selected ?? false,
    }),
  )

const stack = (members: MapPin[], mode: RenderMode = 'realistic') =>
  clusterSvg(resolveClusterSpec(members, { mode, tier: 1 }))

const cell = (caption: string, svg: string, zoom = 1) =>
  `<div class="cell"><div class="${zoom > 1 ? 'zoom' : ''}" style="zoom:${zoom}">${svg}</div>` +
  `<span class="cap">${caption}</span></div>`

/** Priorities that bracket the real range: the minor pin, the middle, the leader. */
const SIZES: [string, number, Tier][] = [
  ['minor 18px', 0, 3],
  ['mid 24px', 60, 2],
  ['top 30px', 100, 1],
]

const row = (label: string, cells: string) => `<h2>${label}</h2><div class="row">${cells}</div>`

const band = (ground: 'ocean' | 'land', mode: RenderMode) => {
  const war = (o: Partial<RawEvent> = {}) => ev({ id: 'war', tags: ['war'], ...o })
  const trade = (o: Partial<RawEvent> = {}) => ev({ id: 'trade', tags: ['economy'], ...o })
  const plain = (o: Partial<RawEvent> = {}) => ev({ id: 'plain', tags: ['politics'], ...o })
  return (
    `<div class="band ${ground}">` +
    row(
      `${ground} · ${mode} · category glyphs at real size`,
      SIZES.map(([cap, priority, tier]) =>
        [
          cell(`war ${cap}`, pin(war({ priority }), { mode, tier })),
          cell(`trade ${cap}`, pin(trade({ priority }), { mode, tier })),
          cell(`plain ${cap}`, pin(plain({ priority }), { mode, tier })),
        ].join(''),
      ).join(''),
    ) +
    row(
      `${ground} · ${mode} · saga ring vs plain, and the other shapes`,
      [
        cell('saga', pin(war({ steps: STEPS }), { mode })),
        cell('plain', pin(war(), { mode })),
        cell('saga selected', pin(war({ steps: STEPS }), { mode, selected: true })),
        cell('saga area', pin(war({ steps: STEPS, area: [[0, 0], [1, 1], [2, 0]] }), { mode })),
        cell('trade route', pin(trade({ paths: [[[0, 0], [5, 5]]] }), { mode })),
        cell('saga trade', pin(trade({ steps: STEPS }), { mode })),
        cell('stack with a saga', stack([war({ steps: STEPS }), plain(), plain()], mode)),
        cell('stack without', stack([war(), plain(), plain()], mode)),
      ].join(''),
    ) +
    `</div>`
  )
}

/** 4x, for the record: what the eye is doing when it leans in. */
const magnified = `<div class="band land">${row(
  'magnified 4x — the same artwork, nothing redrawn',
  [
    cell('war', pin(ev({ id: 'w', tags: ['war'], priority: 70 })), 4),
    cell('trade', pin(ev({ id: 't', tags: ['economy'], priority: 70 })), 4),
    cell('saga', pin(ev({ id: 's', tags: ['war'], priority: 70, steps: STEPS })), 4),
    cell('plain', pin(ev({ id: 'p', tags: ['politics'], priority: 70 })), 4),
  ].join(''),
)}</div>`

document.getElementById('app')!.innerHTML =
  band('ocean', 'realistic') +
  band('land', 'realistic') +
  band('land', 'schematic') +
  magnified
