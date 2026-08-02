# History Web

**An interactive globe for exploring Earth's history — all 4.5 billion years of it.**

Live: **https://jakubdoczy.github.io/history-web/**

Drag the timeline and the planet follows: continents drift together into Pangaea and
break apart again, ice ages come and go, empires rise, redraw their borders, and
vanish, and events from the birth of the Moon to the present day surface as pins on
the globe.

## Using it

**The timeline** runs along the bottom. Drag it to travel in time, scroll/pinch on it
to zoom from billions of years down to single decades — the scale bends so that deep
time and last century both get room. The highlighted band is the **selection**: only
events inside it appear on the globe. Drag its edges to widen or narrow it, or pick a
named era (Classical, Medieval, Industrial…) from the menu in the top bar.

**The globe** rotates and zooms freely. Colored pins are events — the color tells you
the theme (war red, science teal, exploration amber…). A pin with a dashed footprint
marks an event that covers a region, and one with a small winding route in its head
marks a journey; select either and the region, or the route, draws on the map — the
Silk Road's branches, the Atlantic triangle, Magellan's track right round the world.
Numbered badges are stacks of events in one place — tap to fan them out. Zooming in
streams sharp satellite imagery for the ground you're looking at; before 1930 the
zoom stops at a 100 km view, so modern cities never appear in centuries that had none.

**Events** open into a short illustrated article with links to related events — follow
a battle up to its war, or a discovery sideways to its consequences. **Show on map**,
next to the date, puts the thing on screen: it opens the timeline onto its years and
flies the camera out far enough to hold all of it, whether that is a city, a plague's
footprint or a three-year voyage. When there is real geometry to look at, the article
folds down to a bar above the timeline so nothing covers the map, the event's own
battles appear as pins alongside it, and — for the operations that have one — a
**battle plan** draws: front lines, arrows of advance, the pockets where armies were
lost. Tap the bar to read the article again, Escape to put the map back to normal.
Search (top bar) finds any event by name or tag; "Show only this event family" filters
the globe to one storyline.

**Nations** appear in human history as border outlines — always a handful of the great
powers of that moment, redrawn as the centuries pass.

**Settings** (top-right) let you tune it: how many events show at once, tag filters,
imagery streaming and terrain relief, clouds and atmosphere, the sun's position, and
the look of the planet itself — a graded *Enhanced* style (default) or physically-lit
*Realistic*, with saturation/grayscale/contrast sliders if you want your own palette.

The deep-time surface is not an artist's impression: it renders the PALEOMAP
PaleoDEMs (Scotese & Wright 2018, CC BY 4.0) — real paleogeographic reconstructions
at 109 ages from 541 Ma to the present, with elevation, shelf seas, and the ice caps
of the Hirnantian, the Late Paleozoic Ice Age, and the Cenozoic.

---

## Development

Vue 3 + TypeScript + [globe.gl](https://github.com/vasturiano/globe.gl)/three.js,
with a single custom shader for the planet surface (era crossfades, day/night,
city lights, clouds, streamed imagery) and a small SIMD WebAssembly kernel for
Lanczos-3 resampling. Node 20+.

```sh
npm install
npm run dev      # local dev server
npm test         # unit tests (vitest)
npm run build    # type-check + production build into dist/
```

### Deploying

The site is served from the `gh-pages` branch (build output only). The deploy script
runs the tests first and refuses to publish if they fail:

```sh
GITHUB_TOKEN=<token with repo access> ./scripts/deploy.sh
```

### Layout

```
src/
├── lib/          pure logic — time scales, events, clustering, nations, paleo,
│                 imagery streaming, patch cache, resampling, shaders
├── stores/       Pinia state (time, events, nations, settings, view, ui)
├── components/   globe, timeline, panels — kept thin
└── data/         nation borders, paleo frame index, texture manifests
public/
├── data/events/  event dataset, streamed in era-sized chunks + manifest
└── textures/     bundled basemaps, clouds, moon, paleo frames
scripts/          data/texture generators, WASM build, deploy
tests/            unit tests, one file per lib module
```

### How the data is made

- **Events** live in `public/data/events/` as era chunks behind a manifest; the app
  streams whichever chunks the visible time window touches.
  `scripts/build_event_chunks.py` rebuilds chunks, spine, and manifest from any flat
  JSON dropped in that folder, and validates the geometry on the way through.
- **Geometry** is `[lng, lat]` throughout (GeoJSON order): `lat`/`lng` for the pin,
  an optional `area` ring, and an optional `paths` — *always* a list of polylines, so
  a network (the Silk Road) and a single voyage are the same shape of data. Routes are
  authored as named waypoints and curved onto great circles at draw time
  (`src/lib/paths.ts`), because the renderer would otherwise join two ports with a
  line that is straight in lat/lng and wrong on the sphere.
- **Route direction**: `direction` is `"oneway"` (the default) or `"twoway"`. A
  one-way route is a voyage — its dashes run from the first waypoint to the last and
  two chevrons sit on the road at a third and two-thirds along. A two-way route is a
  network (the Silk Road, the Manila galleon) and gets a symmetric, static 50/50 dash
  with no arrows, because an arrow on a thousand-year trade road would be a claim the
  history does not support.
- **Drawings** (`drawing`) are the battle-plan overlay: an operational map drawn from
  data rather than shipped as a picture, rendered by `src/lib/drawingLayer.ts` when the
  item is *shown on the map*. Schema in `src/lib/drawing.ts`, validated at build time by
  `validate_drawing` and over the corpus by `tests/eventsData.test.ts`. One field,
  `layers`, holding any number of four kinds — every coordinate `[lng, lat]`, every
  colour optional and defaulting to the event's tag colour:

  | kind | shape | keys |
  | --- | --- | --- |
  | `frontline` | a line held at a moment | `paths` (list of polylines), `dash: solid\|dashed`, `width` (screen px) |
  | `thrust` | an axis of advance, with a real arrowhead on the end | `path` (the spine; its last point is the tip), `width` (degrees of arc), `taper` |
  | `marker` | a point with a glyph | `pos`, `style: cross\|star\|dot\|arrow`, `size` (degrees), `bearing` (for `arrow`) |
  | `label` | words on the map | `pos`, `text`, `size: sm\|md` |

  Every layer may also carry `color`, `label` (a caption above a marker; documentation
  on the others) and `at` — a year or a 0..1 fraction, reserved for staging a drawing as
  the timeline moves. Nothing reads `at` yet and every layer renders regardless.
  Two units on purpose: a frontline is a *symbol drawn on* a map and is sized in screen
  pixels, a thrust is a *thing on the ground* and is sized in degrees of arc.
  The shipped exemplars are **Operation Barbarossa** (the 22 June border, the December
  high-water mark, the three army-group axes, the Minsk/Smolensk/Kiev pockets) and
  **D-Day** (the five beaches, the airborne drops, the beachhead on the night of the
  6th and the front on 30 June).
- **Paleogeography**: `scripts/gen_paleo_v4.py` downloads the PALEOMAP PaleoDEMs and
  renders the 38 deep-time frames (hypsometric tints, hillshade, shelf seas, ice).
- **Nations** are hand-curated keyframed polygons in `src/data/nations.json`; rings
  are clockwise, cut against real coastlines.
- **WASM**: `scripts/wasm/lanczos.c` is compiled by `npm run build:wasm` (clang,
  wasm32 + SIMD128) and committed base64-inlined, so normal builds need no toolchain.

### Conventions worth keeping

- **Tests gate deploys.** Most bugs here were geometry or lifecycle errors that
  type-check cleanly and fail silently at runtime; each fix lands with the test that
  would have caught it.
- **Never put an unverified data source ahead of a working one.** Load the reliable
  one first, upgrade when the better one actually arrives.
- **Logic in `src/lib` as pure functions**; components stay thin. Anything that
  renders is verified indirectly, by testing the maths it depends on.
- **Comment the surprises, not the obvious** — why a threshold has hysteresis, why a
  clamp exists, why a source was rejected.

### Credits

Blue Marble basemaps and city lights: NASA. Streamed imagery: NASA GIBS/Worldview
and Sentinel-2 cloudless by EOX. Paleogeography: PALEOMAP PaleoDEMs, Scotese &
Wright (2018), CC BY 4.0. See `public/textures/CREDITS.md` for full citations.
