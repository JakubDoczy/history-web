# High-speed imagery architecture

Status: phase 1 and phase 2 landed. Author: architect session. This document is
the contract; implementations adapt naming to the codebase but not the shape.
Deviations taken in phase 2 are recorded at the end.

## Diagnosis

The desktop smoothness gap against Google Maps is not a language problem and
not a renderer problem. Session instrumentation put our JS self-time near 1 ms
per frame during gestures; the hitches were decode, resample, and GPU upload
work happening *at interaction time*. Maps never does any of that during a
gesture: the world is pre-cut into fixed tiles at every zoom level, tiles are
cached (HTTP, memory, GPU), the ring around the viewport is prefetched before
the camera arrives, and a zoom blends two pyramid levels that are already
resident. The structural fix is to adopt that shape, not to rewrite the
issuing side in C/C++/Rust — WebGL calls cost the same from WASM.

## The pyramid

Plate carrée (equirectangular) tiling, matching the shader's lat/lng
parameterisation — no reprojection anywhere.

- `TILE_PX = 512`.
- Level `z` divides longitude into `2^z` columns and latitude into `2^(z-1)`
  rows; every tile is square in degrees: `360 / 2^z` per side.
- Effective resolution of level `z` is `512 · 2^z px / 360°`. The base map
  (4096 px / 360°) is exactly level 3, so streaming levels are `z = 4 ..
  Z_MAX`, with `Z_MAX` bounded by what the sharp source can actually serve
  (derive from its max ground resolution, do not guess).
- `tileBbox(z, x, y)` and `tilesCovering(bbox, z)` are pure functions with
  unit tests. Longitude wraps; latitude clamps.
- Target level for a view: smallest `z` whose texel density ≥ screen density
  (reuse the `baseTexelsPerScreenPx` / `detailLod` math).

Fetching goes through the existing `wmsUrl` path with the tile's bbox at
512×512. Aligned fixed grids make every URL canonical: the browser HTTP cache
and any service-side cache start hitting, which arbitrary bboxes never did.
The mock-WMS test harness keeps working unchanged since it already serves
arbitrary bboxes.

## Tile cache and scheduler

- `TileCache`: key `z/x/y/sourceLabel`, value a decoded `ImageBitmap` (decode
  via `createImageBitmap`, off the main thread where the platform allows).
  LRU by byte budget (start at 96 MB ≈ 90 tiles RGBA; tune by measurement).
  Eviction never touches tiles in the current wanted set or their parents.
- Wanted set per view: visible tiles at target `z`, plus a one-tile prefetch
  ring, plus the covering tiles at `z-1` (the fallback level — these are few
  and essentially permanent near the current view).
- Priority: parents first, then by distance from view centre. In-flight cap
  ~6. Superseded requests are abandoned by generation, but an arrived tile is
  always cached — geometry decides relevance, not arrival order (keep the
  existing philosophy).
- Prefetch of the ring runs only when the camera is still (reuse the existing
  motion/settle machinery); gestures get the bandwidth.

## Phase 1 — tiles feed the existing composite (this round)

The shader and publish path do not change. `DetailImagery` stops requesting
arbitrary view-sized patches and instead composites the wanted tiles onto the
existing composite canvas: fallback level first (always available after first
load, so there is never an uncovered rest — the `REST_MIN_COVER` union check
dies), then target-level tiles where cached, feathered joins only between
levels. Publish rules (motion deferral, `PAN_PUBLISH_MS`, settle) are kept
as-is; they are good and tested.

What this buys before any GPU work: canonical cacheable URLs, prefetch, no
refetch of already-held ground on small moves, a guaranteed fallback under
every pixel, and — because tiles arrive at native pyramid resolution — all
resampling collapses to fixed ratios.

## Fixed-ratio resampling (parallel workstream)

The general Lanczos-3 resampler stays as fallback, but the pyramid only ever
needs two scale factors: exact 2× up (terminal tiles shown past `Z_MAX`;
fallback level drawn at child scale) and exact 2× down (building a parent
from four children instead of refetching it). At a fixed ratio, polyphase
Lanczos-3 has a constant, precomputable weight set — 2 phases × 6 taps per
axis, separable. Specialise these in `scripts/wasm/lanczos.c`: constant
weights baked at compile time, SIMD across pixels, unrolled taps. The JS glue
(`patchResample.ts` / `lanczosWasm.ts`) detects the exact-2× case and takes
the fast path; the `PatchResampler` public interface does not change.
Benchmark both paths; keep the numbers in the module comment.

## Phase 2 — GPU-resident atlas (next round, designed now)

Eliminate the composite-and-full-upload from the interactive path entirely:

- One atlas texture (`texStorage2D`, immutable), e.g. 4096² = 64 slots of
  512². New tiles upload with a single 512² `texSubImage2D`, budgeted ≤ 2 per
  frame — hundreds of microseconds, invisible.
- A small index (uniform array or 64×64 data texture) maps view-space tile →
  atlas slot + level. The surface shader resolves the patch sample through
  one indirection; where the target tile is absent it falls through to the
  parent's slot (Maps-style: coarse but present beats sharp but absent).
- Cross-fade per tile on arrival (age uniform per slot) so sharpening is a
  dissolve, not a pop.
- The composite canvas, scratch canvas, feathering, and full-texture publish
  path are deleted once this lands.

## Phase 2 as built — deviations, and why

Shape kept: one immutable `texStorage2D` atlas of 8×8 slots of 512, one
512-px `texSubImage2D` per tile, ≤ 2 slots a frame, no `generateMipmap` on the
atlas, a per-frame index resolving target → parent → base map, and a 200 ms
per-slot dissolve. Measured on the scripted route: 0 full-texture uploads and 0
`generateMipmap` at interaction time, against 1 of each per gesture before;
2.03 MB the most any frame uploads; draw calls unchanged at 7.

Four things the contract did not say, and one it did:

1. **A second, small atlas for the blurred tap.** The shader does not paint the
   patch on; it divides a sharp tap by one blurred to the base map's own density
   and multiplies the base map by the ratio, which is what keeps NASA's colour
   under Sentinel's structure. That blurred tap used to be mip `z − 3` of the
   composite, and "no mips on the atlas" removes it. Each tile is therefore held
   twice: 512 sharp, and 64 reduced to `4096 / 2^z` texels (the base map's scale)
   and blown back out to the slot. 1 MB of texture, one 64² upload per tile,
   exact for `z ≥ 6`; below that the reduction bottoms out and the ratio
   transfers up to two octaves the base map already has, bounded by the existing
   `[0.55, 1.8]` clamp. A per-slot manual mip chain would have cost the same
   memory and been less exact.
2. **A clamped gutter, not an inset one.** Insetting the sample *rect* rescales
   the tile by 511/512 and leaves neighbours a texel out of register at the join.
   Clamping the in-tile coordinate to `[0.5, 511.5]` texels is exactly
   CLAMP_TO_EDGE for a standalone tile: interior geometry untouched, only the
   outer half texel held.
3. **`fitLevel` replaces `patchPixelCap`.** The atlas is the same 4096² the
   composite was capped at, so the cap survives — as "the finest level whose
   grid and its parent fit 64 slots and the 16×8 index" rather than as a canvas
   size. It is the only place resolution is given up.
4. **The upload budget is a token bucket on the clock, not a per-call count.**
   `update` is reached more than once per animation frame (the camera-change
   handler and the render tick both go through it; a zoom, three times), and
   counting calls spent two and three budgets in one frame — measured at 4.26 MB
   and 6.39 MB before the bucket, exactly 2× and 3× the intent.
5. **The exact-2× terminal upscale is not implemented.** Left out on measurement,
   not on effort: `MIN_ALTITUDE_DETAIL` is a 100 km *horizon*, which is 196 m of
   altitude and a 168 m frame — 0.22 m per screen pixel against level 12's
   19.1 m, i.e. the terminal tile is already magnified 87×. One CPU octave of
   Lanczos costs 4 slots per terminal tile (the atlas holds 16 instead of 64) and
   ~40 ms of worker time each, and buys a visible difference only over the single
   octave where the magnification is 2–4×. If the zoom floor is ever raised so
   that the terminal range is where people actually look, this becomes worth
   revisiting; the kernel is already there.

Deleted with the composite, as the contract required: the composite canvas, the
scratch canvas, feathering and `absentNeighbours`, `compositeCanvasSize` /
`snapCompositeSize` / `patchPixelCap`, the view-scale Lanczos path and
`lib/patchResample.ts` with it, `publish` / `recomposite` / `coversView` /
`viewCoverage` / `movedEnough` / `PAN_MIN_COVER` / `PAN_PUBLISH_MS` /
`TILE_COALESCE_MS` / `detailLod` / `bboxToUvRect`.

Of commit 96954fe's slow-pan work, what survives is the classification itself —
`viewMotion` integrated from the last view that counted as a move, against
`MOTION_EPS` — on one caller: the prefetch ring, which may still only be spent on
a still camera. Nothing is published any more, so nothing is deferred, and the
escape hatch that bounded the deferral went with it.

One pre-existing finding the instrument turned up, unrelated to this work:
globe.gl re-derives `controls.minDistance` from the camera's own near plane on
every zoom event, and `GlobeView` tracks `near` to the altitude — so a scripted
jump straight to a low altitude is clamped to the floor the *previous* near
plane implied, the point of view then does not change, `applyPov` early-returns
on that, and the descent stalls. A wheel zoom, which moves less than 0.385× per
notch, never trips it.

## Invariants to preserve

Era gating (`IMAGERY_ERA_FROM`, pre-era zoom clamp), attribution plumbing,
`detailWanted` hysteresis, motion-deferred publishes, frame-on-demand wakes,
and the texStorage2D shape rules (never resize a published canvas). All
existing tests keep passing; new pure functions get their own.
