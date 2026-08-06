# The drawn map

Status: contract, round 49. Author: architect session. Implementations adapt
naming to the codebase but not the shape.

The user's brief: *"start developing the 'drawn' map. I don't want you to use
any satellite images for it. Probably the best way would be to have the map
vectorised."* Plus the standing item 6: a visible side toggle, vintage
hand-drawn atlas feel, not satellite, not overly modern.

## The architectural insight

The tile pyramid + GPU atlas built for imagery does not care where tiles come
from. A **local vector rasterizer is just another tile source**: same 512²
plate carrée tiles, same cache, same scheduler, same atlas, same shader path —
but the pixels are drawn on-device from vector geometry in a worker, so
coastlines are crisp at every zoom level, forever, with zero network and zero
satellite imagery. No second rendering pipeline; one new `ImagerySource`-like
provider whose "fetch" is a local render.

## Vector data

- npm `world-atlas@2` (Natural Earth, public domain, TopoJSON): `land-50m`,
  `countries-50m`, `land-110m`. Decode with `topojson-client`. Vendor the
  needed TopoJSON files into `public/data/map/` at build/setup time (they are
  static assets like the textures; no runtime dependency on a registry).
- 50m resolution carries a globe to regional zoom honestly. Past the level
  where 50m geometry visibly polygonizes, the drawn style's answer is
  stylization, not more data (a drawn atlas is allowed — expected — to be a
  drawing). If 10m data is later wanted, it swaps in at the data layer with
  no pipeline change; do not block on it now.
- Rivers/lakes (`rivers-50m`, `lakes-50m` from world-atlas or the
  natural-earth companion packages if reachable) are wanted for the feel at
  mid zoom; include if the package is available in the sandbox, degrade to
  land/coast/graticule alone if not, and say which happened.

## The rasterizer

A worker (OffscreenCanvas 2D; feature-detect, main-thread fallback) renders a
requested tile `(z, x, y)` from the decoded geometry:

- **Paper**: warm parchment ground (flat base + very subtle procedural grain;
  deterministic per tile so adjacent tiles join seamlessly — seed the noise
  from tile coords).
- **Ocean**: slightly deeper parchment tone; a fine stipple or wash band
  hugging the coastline outside the land (the classic engraved-shoreline
  cue), fading out within ~1 tile-relative distance.
- **Land**: lighter tone; **coastline ink**: a confident dark stroke with a
  second, thinner offset pass to suggest a drawn line (two exact strokes, not
  random jitter — jitter per tile would mismatch at joins; the hand-drawn
  feel comes from the double line and the stipple, which are join-safe).
- **Graticule**: hairline every 10° (fade by zoom), drawn under the ink.
- **LOD**: pick 110m geometry for low z, 50m above; simplify per tile via the
  projection scale (drop segments < ~0.5 px).
- Determinism rule: rendering the same tile twice yields identical pixels
  (the cache and the atlas assume it).
- Clipping: geometry is pre-indexed per tile row/col bucket at load so a tile
  render touches only nearby polygons — the whole world's 50m land must not
  be repainted 64 times per view. Budget: a tile renders in ≤ 8 ms in the
  worker on the reference machine; measure and report.

## Pipeline integration

- A `drawn` source sits beside the WMS sources: same `tilesCovering` grid,
  same `TileCache` (keyed by source label — already true), same atlas upload
  path, same fallback/prefetch scheduler. Its `Z_MAX` is where 50m geometry
  stops improving (measure: the level where further zoom adds no new
  segments per tile; likely z≈8-9), beyond which the existing
  coarse-level fallback magnifies — which for a drawing is fine.
- **The base map problem**: in drawn mode the globe's base texture (blue
  marble) must not show through — the whole surface at world view must be
  drawn. Render a build-time equirect 4096×2048 "drawn world" (same
  rasterizer, one big canvas, saved as a static webp under
  `public/textures/map/`) and swap it in as the base texture in drawn mode
  (the paleo-texture crossfade machinery already swaps base textures —
  reuse it). Tiles then sharpen it exactly as imagery does. The sharp/blur
  ratio trick in the shader must keep working (the 64px blurred tap of a
  drawn tile against a drawn base map is self-consistent by construction).
- **Era handling**: modern coastlines are honest for roughly the Holocene;
  for deep-time years the paleo frames already exist. In drawn mode:
  years where a paleo frame drives the base map keep that frame but pass
  through the schematic/paper grade (existing mapFade/schematic plumbing);
  the vector coastline tiles only stream when the modern texture would have
  (same gate the imagery uses, minus the 1930 imagery-era rule — drawn
  tiles are not photographs; they may stream at any year the modern
  coastline is the right coastline). State the year threshold chosen and
  why.
- Day/night, city lights, clouds are already disabled in schematic mode
  (resolveGlobeStyle); the drawn mode IS schematic mode grown up — replace
  the current schematic surface treatment rather than adding a third mode.
  `RenderMode` stays `'realistic' | 'schematic'`.

## The toggle

A small vertical control on the right side (near existing side controls if
any): two-state globe/map icon toggle, SVG geometry only (no font glyphs —
round 47's rule), tooltip "Map mode" / "Globe mode", keyboard accessible,
same IBM Plex chip language as the rest. It drives the existing RenderMode
setting (the settings panel entry may stay as the same setting shown in two
places, or link out — one source of truth either way).

## Verification

Screenshots at world view, continental zoom, regional zoom, and a saga's
battle plan over the drawn map (ink layers must read clearly on parchment —
check the drawing/selection ink contrast against the new ground and adjust
the present/ resolvers if the ink was tuned for satellite ground). Phone and
desktop. Determinism test (same tile twice = identical bytes). Join test
(adjacent tiles share edge pixels within tolerance). Render budget numbers.

## As built — round 49, deviations and why

Shape kept: Natural Earth TopoJSON vendored into `public/data/map/`, decoded by
a small loader, pre-indexed into tile-grid buckets; an OffscreenCanvas worker
rasterizer with a main-thread fallback; a `drawn` source beside the WMS ones
through the same grid, cache, scheduler, atlas and shader; a build-time 4096×2048
equirect world texture swapped in through the existing paleo crossfade; map mode
replacing the schematic surface treatment with `RenderMode` unchanged; and a
right-side two-state SVG toggle on the same setting the panel writes.

Seven things the contract did not say, and one it did.

1. **The sharp/blurred ratio cannot carry a drawing.** The contract expected the
   shader's existing trick to be "self-consistent by construction" for a drawn
   base against drawn tiles. It is not, and the reason is the pen: ink is a
   fixed 1.15 *tile pixels* at every level, because that is what makes a drawn
   map look drawn. So the level-3 base texture's shoreline wash is about a
   degree of ground wide and a level-9 tile's is a sixtieth of that; reduced to
   the base map's density the tile's wash is a fifth of a texel and the base
   map's is eight texels of solid tone. They do not cancel, they emboss —
   photographed at the Aegean as crisp coastline ink standing on a soft grey
   doubling of itself. Map mode therefore **paints**: where a tile is resident
   it is the ground, blended parent→target→base by the same per-slot dissolve
   (`DETAIL_MODE`, `uDetailPaint`). The base texture then does exactly the job
   it should — it is what you see until a finer drawing of that ground arrives.
2. **The surface writes linear light into an sRGB buffer.** A raw
   `ShaderMaterial` gets none of the output conversion the built-in materials
   get, so every pixel this globe has ever drawn is a gamma dark — and the
   photographic look (the enhanced grade, the exposure lift, the lambert floor)
   was tuned by eye *through* that, so it is now defined by it. A drawing cannot
   live with it: `#ece2c8` paper reached the screen as (198, 180, 135), browner
   as well as darker because blue loses the most. Map mode encodes its own
   output (`uEncode`, exact sRGB); the realistic branch is untouched.
3. **110m is not a level of detail, it is a floor.** Measured, 110m survives the
   half-pixel filter with 4 992 segments at the *base* level against 50m's
   55 055 — it is the coarser answer everywhere the drawn map is ever drawn. It
   is kept because it is 55 kB against 841 kB: the loader resolves on it, the
   first tiles are drawn from it, and the 50m file replaces it in place. That
   needed a second source label (`DRAWN_LABEL_COARSE`), because the tile cache
   is keyed by label and pins what the view wants — without it, a Europe that
   happened to load in that first second kept a blunt coastline with no rivers
   on it for as long as anyone looked there.
4. **`Z_MAX` is above the level the geometry saturates at, on purpose.** The
   contract's rule — where 50m stops adding segments per tile — measures 6, not
   the 8–9 it guessed. But stopping there and magnifying puts a coastline on
   screen 2ⁿ times too heavy, which is the one failure a drawing does not
   survive and a photograph does (it merely goes soft). 9 is where the two meet:
   one tile pixel is 153 m against a median 50m segment of 7.6 km, so the
   polygonisation is already the limit and level 10 would only draw the same
   facets more sharply.
5. **The bucket index needed the decoder's help.** `world-atlas` ships `land` as
   one MultiPolygon of 1429 rings; indexed as one shape its bounding box is the
   planet, every tile matches it, and every tile walks 60 835 points. Split per
   polygon at decode it is 1420 shapes with real boxes. Measured: 7.0 ms a tile
   before, 0.9 ms after.
6. **globe.gl has a second atmosphere.** `GlobeStyle.atmosphere` drove the
   custom `AtmosphereLayer` only, so the drawn globe kept a blue halo round a
   sheet of paper; `showAtmosphere` is now driven from the same field. This is
   the other half of the note that used to say map mode could not switch the
   limb off — the first half is `uRim`.
7. **Rivers and lakes: present, and at a tenth of the coast's precision.**
   `world-atlas` does not publish water and no other reachable package does
   (searched: visionscarto-world-atlas, @cublya/world-atlas, natural-earth-
   vector). `sane-topojson@4` has both, quantised at 0.036° (~4 km) against the
   coast's 0.0036°. One Chaikin pass at load turns the staircase into a curve;
   past level 7 they fade out and by 9 they are gone, because 4 km is 26 tile
   pixels there and that is a flight of steps, not a river.
8. **Borders are the nations layer's, not the paper's.** The contract said
   nothing about political boundaries and the first build stroked Natural
   Earth's `countries` into every tile, which was wrong for this app in the one
   way that matters: this globe already draws borders, from 73 era-accurate
   polities that change with the year and are re-inked for parchment
   (`inkOnPaper`), so a reader at 1500 got a modern France printed under
   whoever actually held that ground — dashed, permanent, and contradicting the
   layer above it. The paper now carries physical geography only: coast,
   rivers, lakes, graticule, ocean wash, fleck. Dropping `countries` from the
   vendored topology also dropped the 362 arcs that only ever described an
   interior boundary — 746 kB → 538 kB — and 52 kB off the world texture.

Numbers, measured on this machine (`npm run map:measure`, and the in-browser
worker under SwiftShader): tile render 0.9 ms mean / 3.1 ms worst in node and
0.76–1.4 ms mean / 8–10 ms worst in the browser worker, against an 8 ms budget;
the worst case is the first tile of a level, which builds the paths every later
tile of that level reuses. Vector data 894 kB over three files; the world
texture 403 kB.
