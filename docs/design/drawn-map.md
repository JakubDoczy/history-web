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

## Round 51 — two defects from the field, and what they were

**1. The chord from South Africa to Chukotka.** Reported as *"one huge defect
starting from a point in South Africa stretching through Ceylon, South Korea and
ending somewhere around Kamchatka"*. It was one call: the path builder's
antimeridian guard broke the subpath at a seam crossing and called `closePath()`
first. `closePath` does not close along the seam — it closes back to the last
`moveTo`, which for the first piece of a ring is *the ring's own first vertex*.
`land-50m`'s Afro-Eurasia is one ring of 10 639 points beginning at 16.45° E,
28.62° S (the mouth of the Orange River) and crossing ±180 twice in Chukotka, so
the pen drew two chords from there to (179.87 E, 69.01 N) and (179.83 E,
65.03 N) — the streak, and the reason it read as a thin lens rather than a line.
It was in the world texture and in every streamed tile alike, because both come
from `buildPath`. Not an arc-renumbering error, not Chaikin, not Path2D reuse:
the decoded geometry has no segment over 180° that is not a seam crossing, which
is now asserted.

Rings are clipped to the ±180 strip at DECODE instead (`splitAtSeam`,
lib/drawnGeometry.ts): the crossing gets its own interpolated vertex on both
meridians, the ring is rotated to begin at a crossing so each piece starts and
ends on a meridian, and closing a piece then runs down the meridian — which is
where the data was clipped in the first place, and is the correct fill. A piece
whose ends are on opposite meridians (a polar cap crossing an odd number of
times — Antarctica) is closed around the near pole, so Antarctica now fills to
90° S rather than being sealed with a bar across the Pacific at 84° S.

Every edge inserted there is marked in `Shape.seam`, because it is a fact about
the projection and not about a coast. The fill needs those edges; the pen must
not follow them, or the Bering Strait grows a coastline with 22 px of shoreline
wash down the 180th meridian. So `LevelPaths.path` returns `{ fill, stroke }` —
the same `Path2D` object for all but the four shapes that met the seam. Cost:
four extra paths per level.

**2. The antimeridian seam in the streamer.** Reported as *"near Kamchatka /
Alaska … hard boundary somewhere in the ocean … not on the edge of the screen
but right in the middle"*. Phase 1 recorded the limit and it was the whole
defect: `viewBbox` clamped longitude to ±180, so a view centred on the seam
asked for only the half of itself on the near side. Measured in the browser at
56° N, 180°, altitude 0.09: the wanted grid was `[124, 11, 4, 3]` of a
128-column level — four columns, all west of the meridian — against six columns
for the same camera at 174° or −174°. The far half was never requested at any
level and stayed base map, with the step exactly on the meridian.

`viewBbox` now returns unclamped degrees (`minLng` under −180, `maxLng` over
it). That representation was chosen over a wrapped range because it keeps
`minLng <= maxLng`, which every span, centre, motion and placement calculation
downstream already assumes — `tilesCovering` has wrapped its columns since phase
1 and needed no change at all; it simply now has a caller that makes it. What
did need changing is everything that turns a column into a cell of a fixed-size
grid:

- `gridOf` finds the origin after the widest cyclic gap, so 254, 255, 0, 1 is
  origin 254 width 4 rather than origin 0 width 256 (which `atlasCell` rejected
  wholesale, dropping BOTH halves of the frame to base map);
- `buildIndex` places a tile at `gridCol(t.x, x0, tileCols(t.z))`;
- the surface shader takes the same modulo before the range test;
- `centreFirst` measures the column distance the short way round, or the seam's
  own ground — the middle of the frame — is the last tile in the plan;
- `viewMotion` takes the longitude difference the short way round (`wrapDeg`).
  The camera's longitude comes back from globe.gl already wrapped, so a drag
  across the meridian steps 179.9 → −179.9: half a degree of ground that read as
  359.8 degrees of jump, reset `restingAt` on every crossing and withheld the
  prefetch ring from a pan that never stopped.

All of it is upstream of the tile source, so it fixes drawn and satellite modes
together. Only drawn mode could be photographed here — the sandbox has no route
to the WMS services — so the satellite half is carried by the unit tests on the
same arithmetic.

## Round 52 — the sea, and the mark on it

Two reports, and neither is about geometry.

**1. "The map could maybe use a slightly more contrasting palette (the sea is
just another shade)."** It was. Land and sea differed by 26 of luminance and by
nothing else — the sea was a *darker parchment* — so at world view the map read
as one tone with the continents embossed on it, which is the failure mode of a
two-tone palette that shares a hue.

The sea is now the aged atlas's own answer: a duck-egg wash, desaturated
blue-green leaning grey, against untouched warm parchment land.

|              | rgb           | luminance | chroma | b − r |
| ------------ | ------------- | --------- | ------ | ----- |
| land         | 236, 226, 200 | 226       | 36     | −36   |
| sea, before  | 211, 200, 168 | 200       | 43     | −43   |
| sea, now     | 177, 191, 187 | 188       | 14     | +10   |

Two numbers carry the decision. The separation is 38 of luminance instead of 26,
and it is now a separation of **hue** as well — warm against cool, which the eye
reads as two substances rather than two shades of one. And the same table is the
answer to "I don't want this to look like a crazy colored painting": the new sea
is a *less* saturated colour than the one it replaces (chroma 14 against 43).
Only its direction changed.

Four candidates were rendered through the rasterizer itself and compared at
world, continental and coastal zoom. `A-celadon-faint` (luminance 196, b − r =
−1) was still "another shade" — a neutral grey-green that reads as dust on the
paper rather than as water. `C-slate-duck-egg` (182, +14) is the handsomer atlas
and the bigger jump; at world view its sea begins to carry the picture instead of
sitting under it. `B2-duck-egg-deep` is what shipped.

Everything downstream was re-checked rather than re-tuned by taste:

- the **shoreline wash** keeps its cadence (about 6, 13 and 21 of luminance below
  the open sea) with a point of chroma added at each step, so the band still
  deepens toward the coast; the **engraved tick** is the darkest of those steps
  and needed nothing else;
- the **lake** is the sea's tone five of luminance lighter, as it was;
- the **river** ink is unchanged and is better off for it — it was already a cool
  blue-grey chosen against warm paper, and it now agrees with the sea it runs
  into;
- the **graticule** is unchanged, and that is a measurement: a warm hairline at
  this alpha is 11.2% Weber contrast on the new sea and 11.7% on the land,
  against 10.7% and 11.7% before. It reads the same on both grounds, and it is
  the same pen as the coast, which is why it is not re-tinted per ground;
- the **fleck** stays warm on both grounds, because it is the sheet's own fibre
  lying in front of the ink and must not know what it is over. It shows a little
  more over the cool sea (8 of luminance against 5.5), which is the aged-paper
  cue doing its job.

The world texture is regenerated from the same renderer (391 kB, was 403). The
sRGB encode, the determinism rule and the world-aligned fleck are untouched.

**2. "In steps, 'x' mark is a bit too hard to see on the map."** Two faults with
one shape, and the first is the reason the reader was navigating by the caption:
the battle cross is authored `#ffd7a8`, a pale peach picked — like every accent
on this globe — against a night-blue photograph. On `#ece2c8` parchment that is
**1.16:1**. The D-Day plan's three crosses, its star pair and its dot were
photographed with *nothing at all* under their labels. The second fault shows on
the satellite ground too: the glyph carried no casing and is drawn in the same
family as the thrust ribbons it sits on, so it dissolved exactly where a pocket
closes — on top of the arrow.

The fix is one treatment with two grounds (`markInk`, lib/present/ink.ts), and
the tones are opposite by design:

- **on paper** the mark is INK — the accent taken toward the map's own pen at a
  heavier mix than a border gets (0.55 against 0.45, because a border is hundreds
  of pixels of line and a cross is twelve). `#ffd7a8` becomes `#8c7559`, 3.2:1
  against the land. Its casing is the paper's own highlight, the reserved halo a
  cartographer leaves round a symbol, which is what lifts it off the ribbon;
- **on a photograph** the mark keeps the colour it was chosen for and the casing
  is the route casing, a shade heavier because a glyph's rim is thinner than a
  line's.

Plus weight and a rim: the cross's bars go from 0.26 to 0.34 of its size, and
every glyph is drawn twice — a casing outset by 0.22 glyph units, then the mark.
The outset is a true outset rather than a scale, because scaling an X scales its
bars and leaves no rim along them; and on the cross it is **anisotropic** (all of
it on the arms, 55% on the bars), because a casing that thickens as fast as it
lengthens closes the notches and turns the X into a blot. That was photographed
and reverted before it shipped.

The dot, the star and the arrow get the same treatment, and needed it: the
Moscow star is `#f2f6fc`, which on parchment was 1.08:1. The frontlines and
thrusts were checked against the same glance test and left alone — they are
screen-pixel lines and degree-wide ribbons in saturated colours, and they read on
both grounds. At world view a marker is under a pixel and stays that way; it is a
thing on the ground, and the pin above it is what says where the event is.
