#!/usr/bin/env node
/**
 * Vendor the NAMED rivers the borders-v3 `follows` resolver derives geometry
 * from, into `src/data/rivers-named.json`.
 *
 *   node scripts/vendor-rivers.mjs          fetch, prune, write
 *   node scripts/vendor-rivers.mjs --check  verify the committed file only
 *
 * WHY THIS IS NOT `vendor-map-data.mjs`. That script vendors the paper the map
 * is DRAWN on, out of npm packages, into `public/data/map/`. This one vendors a
 * build-time input for the nations pipeline, off the Natural Earth repository
 * itself, into `src/data/` beside `nations.json` — which is where the other
 * thing only the build reads already lives. Nothing at runtime imports it, and
 * a build never fetches: the output is committed, like `nations.clipped.json`.
 *
 * WHY NOT `public/data/map/water-50m.json`, which we already ship. Two reasons,
 * both fatal:
 *
 *  1. **It has no names.** `sane-topojson` strips `properties` from every
 *     geometry at its own build (checked: 0 of 461 river features in world_50m
 *     carry any), so our `prune()` dropping properties is not what lost them —
 *     they were never there. A `follows: {river: "Danube"}` declaration cannot
 *     be resolved against 461 anonymous polylines.
 *  2. **It is quantised at 1e4 — 0.036°, about 4 km.** That is fine for a river
 *     drawn as decoration and fades out past `WATER_Z_MAX`; it is not fine as
 *     the definition of a frontier, because it is ten times coarser than the
 *     coastline the same frontier's polygon is clipped against.
 *
 * WHY 1:10m AND NOT 1:50m, when the land is 50m. Because 1:50m rivers do not
 * contain the Yalu, the Tumen or the Ussuri — checked by name and by bounding
 * box; the only rivers NE 50m draws in Manchuria are the Amur, the Songhua, the
 * Liao and the Xiliao. Those three rivers are three of the frontiers this round
 * exists to derive, so the scale is chosen by what has to be on it. The cost is
 * that a 10m river meets a 50m coast at its mouth with a few hundred metres of
 * disagreement; the clip step removes it, because the part of a spliced ring
 * that lies off `land-50m.json` is cut away by the same arithmetic that cuts
 * everything else.
 *
 * WHY AN ALLOWLIST. NE 10m carries 1 367 named river features and 250 892
 * vertices — 2.0 MB of delta-coded integers, ten times the size of the corpus
 * it would serve, nearly all of it rivers no frontier will ever follow. The
 * fifty below are the ones a historical border does follow, plus the obvious
 * candidates for the next data pass; the resolver's error message names the
 * list when a declaration asks for a river that is not in it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = 'src/data/rivers-named.json'

/**
 * Pinned to the Natural Earth release `@cublya/world-atlas`'s land-10m is built
 * from, so the rivers and the land at this scale are one edition of one dataset
 * rather than two downloads on two days.
 */
export const NE_REF = 'v5.1.2'
export const NE_URL =
  `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_REF}` +
  `/geojson/ne_10m_rivers_lake_centerlines.geojson`

/**
 * The rivers a frontier follows, and the names Natural Earth files them under.
 *
 * ONE RIVER IS SEVERAL NAMES, and that is the whole reason this is a table and
 * not a list of strings. NE names each *reach* in the language of the country
 * it runs through: the Danube above Bratislava is `Donau`, the Euphrates above
 * Deir ez-Zor is `Al Furat` and above the Syrian border `Firat`, the upper
 * Amur is `Heilong Jiang`, the Rhine between Lake Constance and Karlsruhe is
 * `Rhin`. Asking for `name === 'Danube'` gets you the river from Bratislava
 * down and silently loses eight hundred kilometres of it — which is exactly the
 * kind of quiet wrong answer this round exists to make impossible.
 *
 * Most of it is mechanical: NE also carries `name_alt` and `name_en`, so
 * `Donau` (name_en Danube), `Lancang` (Mekong), `Heilong Jiang` (Amur) and
 * `Maas` (Meuse) match by themselves. `also` is for the reaches that do not —
 * `Rhin`'s alternate name is `Rhein`, not `Rhine` — and each entry is a name a
 * human checked on a map.
 */
export const RIVERS = [
  // ---- declared in this round
  { name: 'Rhine', also: ['Rhin', 'Rhein'] },
  { name: 'Danube' }, // `Donau` matches on name_en
  { name: 'Amur' }, // `Heilong Jiang` matches on name_alt
  { name: 'Ussuri' }, // two reaches, `Ussuri` and `Ussuri`/Wusuli
  { name: 'Yalu' },
  { name: 'Tumen' },
  { name: 'Oder' },
  { name: 'Indus' },
  { name: 'Euphrates', also: ['Al Furat', 'Firat'] },
  // ---- the near candidates for the next data pass
  { name: 'Tigris', also: ['Dicle'] },
  { name: 'Rio Grande' },
  { name: 'Prut' },
  { name: 'Dniester' },
  { name: 'Dnieper', also: ['Dnipro'] },
  { name: 'Elbe' },
  { name: 'Sava' },
  { name: 'Drina' },
  { name: 'Bug' },
  { name: 'Southern Bug' },
  { name: 'Nile' },
  { name: 'Mekong' }, // `Lancang` matches on name_en
  { name: 'Congo' },
  { name: 'Niger' },
  { name: 'Ganges' },
  { name: 'Volga' },
  { name: 'Don' },
  { name: 'Ebro' },
  { name: 'Rhône' },
  { name: 'Loire' },
  { name: 'Po' },
  { name: 'Vistula' },
  { name: 'Amu Darya', also: ['Amu  Darya'] }, // the double space is NE's
  { name: 'Syr Darya', also: ['Syr  Darya'] },
  { name: 'Jordan' },
  { name: 'Sutlej' },
  { name: 'Huang' }, // the Yellow River; NE files it as `Huang`, name_en Yellow
  { name: 'Yangtze' },
  { name: 'Paraná' },
  { name: 'Uruguay' },
  { name: 'Amazonas' },
  { name: 'Mississippi' },
  { name: 'Columbia' },
  { name: 'St. Lawrence' },
  { name: 'Ohio' },
  { name: 'Zambezi' },
  { name: 'Limpopo' },
  { name: 'Orange' },
  { name: 'Salween' },
  { name: 'Kura' },
  { name: 'Aras' },
  { name: 'Meuse', also: ['Maas'] },
  { name: 'Moselle', also: ['Mosel'] },
  { name: 'Neman' },
  { name: 'Daugava' },
  { name: 'Tisza', also: ['Tisa'] },
  // ---- round 64: the frontiers of the historical data pass
  // The Orenburg Line: Russia's 1730s-1860s southern frontier runs down this
  // river from Orsk to the Caspian at Guryev.
  { name: 'Ural' },
  // The Siberian (Irtysh) Line of forts, Omsk to Ust-Kamenogorsk, 1750s on.
  // NE names the Kazakh/upper reaches `Ertis` (name_en Ertis, so the alias is
  // needed) and the Chinese headwater `Ertix` (name_alt Irtysh, which matches).
  { name: 'Irtysh', also: ['Ertis'] },
  // The Caucasus Line's western half: Russia's 1783+ frontier is the Kuban.
  // (Its eastern half, the Terek, is not in NE 10m at any spelling.)
  { name: 'Kuban' },
]

/** Same integer codec, same quantum, as the polity corpus. See lib/nations.ts. */
const QUANTUM = 1e-4
const encode = (line) => {
  const out = []
  let x = 0
  let y = 0
  for (const [lng, lat] of line) {
    const ix = Math.round(lng / QUANTUM)
    const iy = Math.round(lat / QUANTUM)
    out.push(ix - x, iy - y)
    x = ix
    y = iy
  }
  return out
}

/**
 * GeoJSON features -> { canonical name: [line, ...] }, allowlist only.
 *
 * A feature belongs to a river if any of its three NE names — `name`,
 * `name_alt`, `name_en` — is the canonical one, or if its `name` is one of the
 * entry's hand-checked `also` spellings. Every part of a MultiLineString is a
 * separate line: the pieces are what the mainline chooser is for.
 */
export function pickRivers(geojson, want = RIVERS) {
  const canonical = new Map()
  for (const r of want) {
    canonical.set(r.name, r.name)
    for (const a of r.also ?? []) canonical.set(a, r.name)
  }
  const rivers = {}
  let vertices = 0
  for (const f of geojson.features) {
    const p = f.properties ?? {}
    const hit = [p.name, p.name_alt, p.name_en, p.name].map((n) => canonical.get(n)).find(Boolean)
    if (!hit) continue
    const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates
    for (const line of parts) {
      if (line.length < 2) continue
      ;(rivers[hit] ??= []).push(line)
      vertices += line.length
    }
  }
  const missing = want.filter((r) => !rivers[r.name]).map((r) => r.name)
  return { rivers, vertices, missing }
}

if (process.argv[1] && process.argv[1].endsWith('vendor-rivers.mjs')) {
  const check = process.argv.includes('--check')
  if (check) {
    const on = JSON.parse(readFileSync(join(root, OUT), 'utf8'))
    const names = Object.keys(on.rivers)
    const unknown = names.filter((n) => !RIVERS.some((r) => r.name === n))
    console.log(
      `rivers: ${names.length} named of ${RIVERS.length} asked for, ` +
        `${on.stats.vertices} vertices, ref ${on.ref}` +
        (unknown.length ? ` — NOT IN THE ALLOWLIST: ${unknown.join(', ')}` : ''),
    )
    process.exit(unknown.length ? 1 : 0)
  }
  const res = await fetch(NE_URL)
  if (!res.ok) throw new Error(`vendor-rivers: ${NE_URL} -> ${res.status}`)
  const geojson = await res.json()
  const { rivers, vertices, missing } = pickRivers(geojson)
  const body =
    `{"source":${JSON.stringify(
      'Natural Earth 1:10m rivers and lake centerlines (public domain), ' +
        `from nvkelso/natural-earth-vector at ${NE_REF}. Named features only, ` +
        'pruned to the allowlist in scripts/vendor-rivers.mjs.',
    )},\n` +
    `"ref":${JSON.stringify(NE_REF)},"quantum":${QUANTUM},\n` +
    `"stats":{"names":${Object.keys(rivers).length},"lines":${Object.values(rivers).reduce(
      (n, l) => n + l.length,
      0,
    )},"vertices":${vertices}},\n` +
    `"rivers":{\n` +
    Object.keys(rivers)
      .sort()
      .map((n) => `${JSON.stringify(n)}:[\n  ${rivers[n].map((l) => JSON.stringify(encode(l))).join(',\n  ')}\n]`)
      .join(',\n') +
    `\n}}\n`
  writeFileSync(join(root, OUT), body)
  console.log(
    `wrote ${OUT} (${(body.length / 1024).toFixed(0)} kB): ${Object.keys(rivers).length} rivers,` +
      ` ${vertices} vertices` +
      (missing.length ? `\n  NOT FOUND in NE 10m (fix the spelling in RIVERS): ${missing.join(', ')}` : ''),
  )
}
