#!/usr/bin/env node
/**
 * Vendor the drawn map's vector data into public/data/map/.
 *
 * The data is Natural Earth (public domain), shipped as TopoJSON by three npm
 * packages. All are DEV dependencies and none is imported at runtime: the
 * files that land in public/ are static assets exactly like the textures, so a
 * build has no registry in it and the app has no decoder dependency (see
 * lib/drawnGeometry.ts, which reads the same quantised form in ~40 lines).
 *
 * What comes from where, and why:
 *
 *  · `world-atlas@2` — land-110m and countries-50m. Only the `land` object of
 *    the 50m file is taken. It also carries `countries` off the same arcs, and
 *    an earlier round shipped both and drew the borders: that was wrong for
 *    this app. Political boundaries here are a function of the YEAR — the
 *    nations layer draws 73 era-accurate polities and redraws them as the
 *    reader moves through time — so a modern border baked into the paper is a
 *    second, contradictory answer printed under the first. Dropping
 *    `countries` also drops every arc that is only ever an interior boundary
 *    (1959 arcs → 1597) and the 736-feature object that indexed them: measured,
 *    746 kB → 538 kB. Quantised at 1e5, i.e. 0.0036° ≈ 400 m.
 *  · `@cublya/world-atlas@3` — land-10m, and nothing else. It is the same
 *    build as `world-atlas` (same author line, same ISC licence, same
 *    `quantization: 1e5`) re-run against Natural Earth 5.1.2, and it is the
 *    only reachable package that ships honest NE **10m** land: `world-atlas@2`
 *    stops at 50m, `sane-topojson` at 50m, `visionscarto-world-atlas` at 50m,
 *    and the `@geo-maps/*-10m` family is not Natural Earth 1:10m at all — the
 *    "10m" there is *ten metres* of OSM-derived geometry under ODbL, a
 *    different dataset under a different licence. Its own DATA_LICENSE.md
 *    states the terms this repo relies on: "Natural Earth declares all versions
 *    of its raster and vector map data to be in the public domain."
 *    Cross-checked rather than trusted: cublya's land-50m reproduces the
 *    shipped world-atlas 50m coastline to within 0.6% of vertices and 0.3% of
 *    median segment length, so the 10m file out of the same script is the same
 *    pipeline at the next scale (median segment 1517 m against 50m's 7639 m,
 *    5.0× finer, which is what NE's own scale ratio predicts).
 *  · `sane-topojson@4` — rivers and lakes, which world-atlas does not publish
 *    and which no other reachable package has (searched: visionscarto-world-
 *    atlas, @cublya/world-atlas, natural-earth-vector — none carry water). Its
 *    world_50m is quantised at 1e4, i.e. 0.036° ≈ 4 km, so rivers are honest to
 *    about a tile pixel at z ≤ 7 and visibly straight-line above it. That is
 *    the reason lib/drawnTile.ts fades water out past WATER_Z_MAX rather than
 *    drawing what it cannot support.
 *
 * The arcs are pruned to the ones each output actually references — the naive
 * extraction of two objects out of world_50m carries all 4785 arcs (919 kB) to
 * describe 736 features. It is also what makes dropping `countries` a *payload*
 * saving rather than a cosmetic one: the arcs no object references stop being
 * written at all.
 *
 * `topojson-client` is deliberately NOT a dependency of this script, and the
 * design named it. Pruning is arc renumbering, which is fifty lines below, and
 * the runtime decoder in lib/drawnGeometry.ts is forty more; a library that
 * exists to turn topologies into GeoJSON would have to be undone by both of
 * them, because GeoJSON is exactly the shape neither wants (objects per point,
 * arcs already expanded). Nothing here or in the app imports it, so it is not
 * installed.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public/data/map')
mkdirSync(out, { recursive: true })

const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'))

/** Every arc index a geometry (at any nesting depth) references. */
function arcsOf(geometry, into = new Set()) {
  if (geometry.geometries) for (const g of geometry.geometries) arcsOf(g, into)
  const walk = (a) => {
    if (Array.isArray(a)) a.forEach(walk)
    else if (typeof a === 'number') into.add(a < 0 ? ~a : a)
  }
  walk(geometry.arcs ?? [])
  return into
}

/** Renumber a topology onto only the arcs its kept objects use. */
function prune(topo, keep) {
  const used = new Set()
  for (const name of keep) arcsOf(topo.objects[name], used)
  const order = [...used].sort((a, b) => a - b)
  const remap = new Map(order.map((a, i) => [a, i]))
  const renumber = (a) =>
    Array.isArray(a) ? a.map(renumber) : a < 0 ? ~remap.get(~a) : remap.get(a)
  const objects = {}
  for (const name of keep) {
    const o = topo.objects[name]
    const fix = (g) => ({
      ...g,
      ...(g.geometries ? { geometries: g.geometries.map(fix) } : {}),
      ...(g.arcs ? { arcs: renumber(g.arcs) } : {}),
      // properties are ~40% of countries-50m and nothing in the drawn map reads
      // them: it draws a coastline, and a coastline has no name
      properties: undefined,
      id: undefined,
    })
    objects[name] = fix(o)
  }
  return {
    type: 'Topology',
    transform: topo.transform,
    objects,
    arcs: order.map((a) => topo.arcs[a]),
  }
}

/**
 * Write one file, and report what it cost — raw, pruned and over the wire.
 *
 * The gzip column is the one that matters for the 10m rung: it is 3.3 MB of
 * JSON and 851 kB of transfer, it is fetched by the drawn mode alone, and (see
 * lib/drawnGeometry.ts) only once a reader has actually zoomed past the level
 * 50m stops being able to answer. Nothing in the bundle imports any of this;
 * they are static assets like the textures.
 */
const kb = (n) => `${(n / 1024).toFixed(0)} kB`
const write = (name, source, topo) => {
  const json = JSON.stringify(topo)
  writeFileSync(join(out, name), json)
  const raw = readFileSync(join(root, source)).length
  console.log(
    `${name.padEnd(16)} raw ${kb(raw).padStart(8)}  pruned ${kb(json.length).padStart(8)}` +
      `  gz ${kb(gzipSync(json).length).padStart(8)}  ${String(topo.arcs.length).padStart(5)} arcs`,
  )
}

const LAND_110M = 'node_modules/world-atlas/land-110m.json'
const LAND_50M = 'node_modules/world-atlas/countries-50m.json'
const LAND_10M = 'node_modules/@cublya/world-atlas/land-10m.json'
const WATER_50M = 'node_modules/sane-topojson/dist/world_50m.json'

write('land-110m.json', LAND_110M, prune(read(LAND_110M), ['land']))
write('land-50m.json', LAND_50M, prune(read(LAND_50M), ['land']))
// 10m carries `land` and nothing else, so there is no second object's arcs to
// drop — and pruning still takes 128 of the 7 092 arcs out, which are the ones
// no geometry in the file references at all.
write('land-10m.json', LAND_10M, prune(read(LAND_10M), ['land']))
// Rivers and lakes for the PAPER. Their names are not here and never were:
// sane-topojson strips `properties` from every geometry at its own build (0 of
// 461 river features in world_50m carry any), so `prune()` dropping them is not
// what lost them. The borders-v3 resolver needs named rivers at a scale a
// frontier can be defined on, and vendors its own — scripts/vendor-rivers.mjs.
write('water-50m.json', WATER_50M, prune(read(WATER_50M), ['rivers', 'lakes']))

writeFileSync(
  join(out, 'CREDITS.md'),
  `# Vector map data

Generated by \`scripts/vendor-map-data.mjs\`. Do not edit by hand.

| file | layers | source | quantisation |
| --- | --- | --- | --- |
| land-110m.json | land | Natural Earth 110m via npm \`world-atlas@2\` | 1e5 (0.0036°) |
| land-50m.json | land | Natural Earth 50m via npm \`world-atlas@2\` | 1e5 (0.0036°) |
| land-10m.json | land | Natural Earth 10m (v5.1.2) via npm \`@cublya/world-atlas@3\` | 1e5 (0.0036°) |
| water-50m.json | rivers, lakes | Natural Earth 50m via npm \`sane-topojson@4\` | 1e4 (0.036°) |

Physical geography only. Political boundaries are not vendored and are not drawn
on the paper: on this globe they belong to the time-aware nations layer, which
answers a year rather than a download.

Natural Earth is public domain — "Natural Earth declares all versions of its
raster and vector map data to be in the public domain", quoted from
\`@cublya/world-atlas\`'s own DATA_LICENSE.md and from
<https://www.naturalearthdata.com/about/terms-of-use/>. \`world-atlas\` and
\`@cublya/world-atlas\` are ISC, \`sane-topojson\` is MIT; all three are
build-time only — nothing here is imported at runtime.

The 10m file is fetched by the drawn map alone, and only once a reader has
zoomed past the level 50m geometry stops being able to answer (see
\`LOD_FINE_Z\` in lib/drawnTile.ts). A world view never pays for it.
`,
)
