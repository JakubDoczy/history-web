# High-speed imagery architecture

Status: phase 1 in progress. Author: architect session. This document is the
contract; implementations adapt naming to the codebase but not the shape.

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

## Invariants to preserve

Era gating (`IMAGERY_ERA_FROM`, pre-era zoom clamp), attribution plumbing,
`detailWanted` hysteresis, motion-deferred publishes, frame-on-demand wakes,
and the texStorage2D shape rules (never resize a published canvas). All
existing tests keep passing; new pure functions get their own.
