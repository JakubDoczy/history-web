import type { WebGLRenderer } from 'three'
import {
  BASE_LEVEL,
  TILE_MEMORY_BUDGET,
  TILE_PX,
  TileCache,
  bboxOf,
  maxLevel,
  parentOf,
  targetLevel,
  tileKey,
  tilePlan,
  tileSpanDeg,
  type Tile,
  type TilePlan,
} from './tilePyramid'
import {
  ATLAS_UPLOADS_PER_FRAME,
  UPLOAD_WINDOW_MS,
  TileAtlas,
  buildIndex,
  fitLevel,
  type AtlasIndex,
} from './tileAtlas'

/**
 * High-resolution imagery for the region being looked at, streamed as a pyramid
 * of fixed WMS tiles and handed to the shader as a GPU-resident atlas.
 *
 * The first version stitched WMTS tiles and got the index arithmetic wrong; the
 * second asked for one arbitrary rectangle per settled view, which could not
 * drift because there was no index left — and could not cache either, because
 * every URL it built was unique. It refetched ground it already held on any pan,
 * it could prefetch nothing, and it spent a full-resolution request on a view
 * the camera was about to leave.
 *
 * So the grid came back, as `lib/tilePyramid.ts`: pure functions with their own
 * tests, aligned to the sphere, wrapping in longitude and clamping in latitude
 * in one tested place rather than in this file. What that buys is what Maps has
 * always had — canonical cacheable URLs, a prefetch ring, no refetch of ground
 * already paid for, and a coarser level resident under every pixel so a gesture
 * shows soft imagery instead of a hole.
 *
 * What has gone since is everything between the tiles and the screen. Those
 * tiles used to be composited onto one canvas per view, and the canvas uploaded
 * whole with `generateMipmap` — 111 ms per publish, which is why publishing had
 * to be deferred through a gesture, coalesced across arrivals, feathered at the
 * joins, re-sized on a ladder, and sharpened by a Lanczos pass at rest. Every
 * one of those rules existed to make a full upload affordable. A tile now costs
 * one 512² `texSubImage2D` into `lib/tileAtlas.ts` and the shader assembles the
 * picture from an index, so the composite canvas, the scratch canvas, the
 * feathering, the view-scale Lanczos, the publish path and the whole deferral
 * grammar around them are gone rather than tuned.
 *
 * What survives from that era, and why:
 *
 *  - `detailWanted`'s hysteresis, the era gate and the pre-era zoom clamp: they
 *    are about *whether* imagery belongs on screen, which no upload path
 *    changes.
 *  - the motion detector (`viewMotion` / `MOTION_EPS`), on one caller instead of
 *    four: the prefetch ring is still spent only when the camera is still,
 *    because during a gesture every byte belongs to ground that is on screen
 *    now. Publishing no longer consults it — there is nothing left to defer.
 */

/**
 * The year modern imagery stops being an anachronism.
 *
 * It used to gate *streaming*: before 1930 no patch was fetched at all, and a
 * separate zoom floor held the camera 300 km up so the reason would not show.
 * That was the wrong lever. Sharper coastlines, rivers, ice and desert are as
 * true in 1500 as in 2000 — what dates the imagery is only the scale at which
 * roads and reservoirs become legible. So imagery now streams in every era that
 * uses the modern basemap, and the year decides how *close* the camera may come
 * instead.
 */
export const IMAGERY_ERA_FROM = 1930

/** globe.gl's perspective camera, unless the component tells us otherwise. */
export const DEFAULT_FOV = 50

/** Camera altitude, in globe radii, at which the view spans a given ground width. */
export const altitudeForViewKm = (km: number): number => {
  const halfAngle = (km / 2 / 111.32) * (Math.PI / 180)
  return 1 / Math.cos(halfAngle) - 1
}

/** Closest approach once modern imagery is appropriate: a ~100 km view. */
export const MIN_ALTITUDE_DETAIL = altitudeForViewKm(100)

/** Ground span, across the frame, of the closest view allowed before 1930. */
export const PRE_ERA_VIEW_KM = 100

/**
 * Camera altitude at which the *frame* spans a given ground width — the inverse
 * of viewSpanDeg.
 *
 * Not the same question as altitudeForViewKm, and the difference is not
 * academic. A 20 km *horizon* is reached 7.8 m above the ground, where the
 * frame is a few metres wide and the globe mesh fills nothing; a 20 km *frame*
 * is 22.7 km up. The horizon measure is right for "how much of the planet is in
 * principle in front of me" and wrong for every question about what is on
 * screen, which is what a zoom cap is.
 */
export const altitudeForFrameKm = (km: number, fovDeg = DEFAULT_FOV): number => {
  const half = (km / 2 / 111.32) * (Math.PI / 180)
  const theta = ((fovDeg / 2) * Math.PI) / 180
  return Math.sin(half + theta) / Math.sin(theta) - 1
}

/**
 * The pre-1930 zoom cap: close enough that terrain, coast, river and ice read
 * properly, not so close that a modern city fills the screen in a century that
 * had none. At 100 km across a 1000 px window that is ~100 m per pixel, where a
 * whole city is a smudge a few pixels wide and no road exists at all — the
 * scale of a regional map rather than a street map, which is the scale at which
 * modern imagery stops making a claim about the century on screen.
 */
export const MIN_ALTITUDE_PRE_ERA = altitudeForFrameKm(PRE_ERA_VIEW_KM)

/**
 * How close the camera may come. Inverted from the old rule: the era no longer
 * decides whether imagery exists, only how far in it may be inspected.
 *
 * `eraFrom` is the year the streamed layer stops being an anachronism, or
 * `null` for a layer that never was one. The drawn map passes `null`: a drawn
 * coastline says nothing about which century is on the timeline, so the clamp
 * that keeps a photographed motorway out of the fourteenth century has nothing
 * to hold back. Written as a parameter rather than read from
 * `IMAGERY_ERA_FROM` so the rule belongs to the SOURCE and not to this file.
 */
export const minAltitudeFor = (
  year: number,
  detailEnabled: boolean,
  eraFrom: number | null = IMAGERY_ERA_FROM,
): number =>
  detailEnabled && eraFrom !== null && year < eraFrom ? MIN_ALTITUDE_PRE_ERA : MIN_ALTITUDE_DETAIL

/**
 * Angular width of the visible cap, in degrees, for an altitude in globe radii.
 *
 * The floor here matters: it was 1e-3, which pinned the closest possible view at
 * ~570 km however low the zoom limit was set, so finer imagery could never show.
 */
export const visibleSpanDeg = (altitude: number) =>
  2 * Math.acos(Math.min(1, 1 / (1 + Math.max(altitude, 1e-9)))) * (180 / Math.PI)

/**
 * Ground span actually inside the frame, in degrees.
 *
 * This is the single biggest reason streamed patches looked soft, and it is not
 * a resolution cap at all — it is the rectangle. `visibleSpanDeg` is the
 * *horizon*: everything the camera could see if the lens were infinitely wide.
 * Close in the two diverge violently. At 0.02 radii the horizon is 22.7° of
 * ground — 2500 km — while a 50° lens frames 1.05°, about 117 km. Sizing the
 * patch to the horizon fetched twenty times more ground than was on screen and
 * then spent the whole pixel budget on it, so the part anybody could see came
 * back at ~2.8 km per pixel instead of ~130 m.
 *
 * Geometry: the camera sits at d = 1 + altitude from the centre and the frame
 * edge leaves it at θ = fov/2 from the axis through the centre. In the triangle
 * centre-camera-ground the sine rule gives the angle at the centre as
 * asin(d sin θ) − θ. When d sin θ ≥ 1 the edge ray misses the planet entirely
 * and the horizon is the limit again, which is the far-out case.
 */
export const viewSpanDeg = (altitude: number, fovDeg = DEFAULT_FOV): number => {
  const d = 1 + Math.max(altitude, 1e-9)
  const theta = ((fovDeg / 2) * Math.PI) / 180
  const s = d * Math.sin(theta)
  if (s >= 1) return visibleSpanDeg(altitude) // the frame is wider than the planet
  return 2 * (Math.asin(s) - theta) * (180 / Math.PI)
}

/**
 * How much larger than the frame to fetch. Some margin is needed or the patch's
 * feathered edge eats into the view, and the cache has nothing to hand back
 * when the camera turns.
 */
export const PATCH_MARGIN = 1.25

export interface Bbox {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * Rectangle to request: centred on the view, slightly larger than it, shaped to
 * the screen's aspect ratio, and widened in longitude for meridian convergence.
 *
 * Matching the screen's shape matters: a square patch of ground on a portrait
 * phone at high latitude fetches roughly twice the area that is ever visible.
 *
 * LONGITUDE IS NOT CLAMPED, and that is round 51's fix for the antimeridian.
 * It used to be — `clamp(lng ± span/2, -180, 180)` — and every consequence of
 * the seam followed from those two calls: a view centred on 180° asked for the
 * half of itself west of the meridian and no more, so the tiles east of it were
 * never requested, never indexed and never uploaded, and the far half of the
 * frame stayed at base-map resolution with a hard edge down the middle of the
 * ocean. Exactly what the reader reported at Kamchatka/Alaska, in both drawn
 * and satellite modes, because the clamp is upstream of the source.
 *
 * The representation chosen is UNCLAMPED DEGREES — `minLng` may be under -180
 * and `maxLng` over it — rather than a wrapped range (`minLng > maxLng`). It
 * keeps `minLng <= maxLng` true, which is what every span, centre, motion and
 * placement calculation downstream already assumes: `maxLng - minLng` stays the
 * width, `placeOnCanvas` stays linear, and `tilesCovering` — which has wrapped
 * its column indices since phase 1 and until now had no caller that made it —
 * needs no change at all. What did need changing is everything that turns a
 * tile's COLUMN into a position in a fixed-size grid: `gridOf`, `buildIndex`
 * and the shader's own index lookup (lib/tileAtlas.ts, lib/globeSurface.ts).
 */
export function viewBbox(
  lat: number,
  lng: number,
  altitude: number,
  aspect = 1,
  margin = PATCH_MARGIN,
  fovDeg = DEFAULT_FOV,
): Bbox {
  // Both lower bounds used to be 0.05° (~5.5 km). At the satellite-era floor
  // the frame is ~180 m, so the longitude clamp alone stretched the rectangle
  // to nineteen times its proper width: the request came back 1920x192, sampled
  // ten times more finely across than down, of ground mostly off screen.
  const latSpan = clamp(viewSpanDeg(altitude, fovDeg) * margin, 0.001, 120)
  const groundWidth = latSpan * clamp(aspect, 0.35, 3)
  const lngSpan = clamp(groundWidth / Math.max(Math.cos((lat * Math.PI) / 180), 0.15), 0.001, 300)
  const minLat = clamp(lat - latSpan / 2, -90, 90)
  const maxLat = clamp(lat + latSpan / 2, -90, 90)
  // …and no clamp here: see above. The span is already bounded to 300°, so the
  // box can never be wider than the world, only across the seam from it.
  return { minLat, minLng: lng - lngSpan / 2, maxLat, maxLng: lng + lngSpan / 2 }
}

/**
 * There is no composite canvas any more, and with it went every constant that
 * described one: the size ladder, the device pixel cap, the aspect-matched
 * allocation, the two Lanczos bounds and the feather width.
 *
 * They were all answers to the same question — how large a rectangle of pixels
 * can this device afford to re-upload and re-mip on every arrival — and the
 * atlas does not ask it. What is left of the ceiling is `ATLAS_SLOTS`, which
 * bounds the same 4096² of texture as whole tiles rather than as a canvas, and
 * `fitLevel`, which is where a dense screen now gives up resolution.
 */

/**
 * How far the view has moved from a reference rectangle, as a fraction of its
 * own span.
 *
 * The largest of the four edges, so a pure zoom counts as motion as readily as
 * a pan does. The reference is deliberately *not* the previous frame — see
 * MOTION_EPS.
 */
export const viewMotion = (a: Bbox | undefined, b: Bbox): number => {
  if (!a) return 1
  const lat = Math.max(b.maxLat - b.minLat, 1e-9)
  const lng = Math.max(b.maxLng - b.minLng, 1e-9)
  return Math.max(
    Math.abs(a.minLat - b.minLat) / lat,
    Math.abs(a.maxLat - b.maxLat) / lat,
    Math.abs(wrapDeg(a.minLng - b.minLng)) / lng,
    Math.abs(wrapDeg(a.maxLng - b.maxLng)) / lng,
  )
}

/**
 * A longitude difference, taken the short way round: -180 … 180.
 *
 * The camera's longitude comes back from globe.gl already wrapped, so a drag
 * across the antimeridian steps from 179.9 to -179.9 — half a degree of ground
 * that reads as 359.8 degrees of jump. Unwrapped, that is a full reset of the
 * motion state on every seam crossing: `restingAt` is thrown away, the camera
 * is classified as moving, and the prefetch ring is withheld from a pan that
 * never actually stopped. Measured as the difference between "the sharpening
 * follows the camera across the seam" and "the sharpening restarts at it".
 */
export const wrapDeg = (d: number): number => d - 360 * Math.round(d / 360)

/**
 * Exact equality of two view rectangles.
 *
 * Exact rather than tolerant on purpose: `viewBbox` is a pure function of the
 * camera, so two calls with the same camera give bit-identical numbers, and
 * anything a tolerance would additionally accept is a camera that really did
 * move. It is only ever used to skip recomputing a plan that cannot have
 * changed.
 */
export const sameBbox = (a: Bbox, b: Bbox): boolean =>
  a.minLat === b.minLat && a.maxLat === b.maxLat && a.minLng === b.minLng && a.maxLng === b.maxLng

/**
 * How far the view may drift *in total* and still count as a still camera.
 *
 * Small, but not zero: orbit damping keeps the camera creeping for the better
 * part of a second after the pointer is released, and waiting for that to reach
 * exactly zero would be waiting for the imagery forever. Two parts in a
 * thousand of the span is well under a screen pixel at any zoom.
 *
 * "In total" is the whole of the rule, and it used to be "between frames". A
 * per-frame threshold does not describe a gesture, it describes a *speed*, and
 * the speed it excluded is one a hand can hold. OrbitControls turns a drag into
 * `2π · rotateSpeed · dx / height` radians and globe.gl sets
 * `rotateSpeed = altitude · 0.3`, so the altitude cancels and a drag moves the
 * view by a fixed fraction of its own span per mouse pixel at *every* zoom —
 * 0.00112 of the span per pixel at 1000x750 and 46° N. So 0.002 per frame was a
 * speed limit of 1.8 px per frame, ~110 px/s, and every slower drag was
 * classified as a still camera in the middle of the gesture. That is not an
 * edge case; it is what a careful drag is.
 *
 * What it cost, measured in Chromium against the mock service over a 150-frame
 * pan (tests/e2e/slowPan.e2e.mjs): at 0.0019 span/frame — 1.7 mouse px, just
 * under the old limit — 113 frames read as still, and the still-camera pipeline
 * ran inside the gesture 399 times: 523 megapixels of texture upload and
 * `generateMipmap`, and 526 Lanczos jobs.
 *
 * Measured instead from the last view that *counted* as a move, the same 0.002
 * is a displacement rather than a speed: any drift crossing it inside SETTLE_MS
 * re-arms the settle, so the whole crawl is one gesture. A decaying motion still
 * converges — orbit damping leaves a finite distance to travel, so the crossings
 * thin out and stop — and a parked camera never crosses at all.
 *
 * The pipeline that made this urgent is gone: nothing is published any more, so
 * nothing has to be deferred. What is still measured against it is the prefetch
 * ring, which may only be spent on a still camera — during a gesture every byte
 * belongs to ground that is on screen now. That is the whole of what commit
 * 96954fe's semantics still govern, and it is governed by the same integrating
 * form for the same reason: a crawl is a gesture, not a series of rests.
 */
export const MOTION_EPS = 0.002

/**
 * Imagery is fetched in two stages.
 *
 * Stage one is NASA Blue Marble: one static layer, no date, always available.
 * It is displayed as soon as it arrives, so there is always *something*.
 *
 * Stage two is Sentinel-2 cloudless — a global, genuinely cloud-free 10 m
 * mosaic, fifty times finer than Blue Marble. It is requested only after stage
 * one has already been shown, so a failure costs sharpness and nothing else.
 * An earlier attempt put an unverified sharp source first and one bad date took
 * the whole feature down; this ordering makes that failure mode impossible.
 */
export interface TileSource {
  label: string
  /** Native resolution in pixels per degree; 500 m ≈ 222, 10 m ≈ 11100. */
  pxPerDeg: number
  attribution?: string
  /**
   * A LOCAL source renders its own tiles; a remote one is fetched.
   *
   * This one member is the whole of what the drawn map needed from this file.
   * The pyramid, the cache, the scheduler, the atlas and the shader never ask
   * where a tile came from, so a vector rasterizer running in a worker
   * (lib/drawnSource.ts) is a source in exactly the sense Sentinel-2 is —
   * which is the architectural claim the drawn map is built on, reduced to an
   * optional function.
   */
  render?: (t: Tile) => Promise<CanvasImageSource>
}

export interface ImagerySource extends TileSource {
  endpoint: string
  layers: string
  /** WMS 1.1.1 takes bbox as lng,lat and calls it SRS; 1.3.0 takes lat,lng and calls it CRS. */
  version: '1.1.1' | '1.3.0'
  /**
   * The widest box worth asking this source for in one image.
   *
   * Not a property of the data — a property of what the server will render
   * without timing out and what the answer is worth when it arrives. A 10 m
   * mosaic across 40 degrees is a gigapixel scene reduced to 4096 px; the
   * 500 m map renders the same box from an overview in one read.
   */
  maxSpanDeg: number
  time?: string
}

export const BASE_SOURCE: ImagerySource = {
  label: 'Blue Marble 500 m',
  endpoint: 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi',
  layers: 'BlueMarble_ShadedRelief_Bathymetry',
  version: '1.3.0',
  pxPerDeg: 222,
  // 60 deg at the 4096 ceiling is 68 px/deg — six times the world texture, and
  // an overview read for GIBS. Wider than this and the win is not worth the
  // megabytes.
  maxSpanDeg: 60,
  attribution: 'NASA GIBS / Worldview',
}

export const SHARP_SOURCE: ImagerySource = {
  label: 'Sentinel-2 10 m',
  endpoint: 'https://tiles.maps.eox.at/wms',
  layers: 's2cloudless-2020',
  version: '1.1.1',
  pxPerDeg: 11100,
  // What this endpoint was already being asked for before streaming reached
  // wider views: the old gate fired at a 3.8 degree frame, which on a landscape
  // window is a ~7 degree box in longitude. Holding the limit just above that
  // keeps the sharp source covering everything it used to, and hands the wider
  // range — where its 4096 px would be spread thinner than 500 m anyway — to
  // the source that renders it from an overview.
  maxSpanDeg: 8,
  attribution:
    'Sentinel-2 cloudless (s2maps.eu) by EOX IT Services GmbH — modified Copernicus Sentinel data 2020',
}

/** Builds a WMS GetMap request, honouring each version's axis-order convention. */
export function wmsUrl(src: ImagerySource, b: Bbox, width: number, height: number): string {
  const bbox =
    src.version === '1.3.0'
      ? `${b.minLat},${b.minLng},${b.maxLat},${b.maxLng}` // 1.3.0 EPSG:4326 is lat,lng
      : `${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}` // 1.1.1 is lng,lat
  const crs = src.version === '1.3.0' ? `CRS=EPSG:4326` : `SRS=EPSG:4326`
  return (
    `${src.endpoint}?service=WMS&request=GetMap&version=${src.version}` +
    `&format=image/jpeg&styles=&transparent=false` +
    `&${crs}&bbox=${bbox}&width=${width}&height=${height}` +
    `&layers=${encodeURIComponent(src.layers)}` +
    (src.time ? `&TIME=${src.time}` : '')
  )
}

/** Effective resolution of the whole-globe base texture, in pixels per degree. */
export const BASE_TEXTURE_PX_PER_DEG = 4096 / 360

/**
 * The blurred tap the detail ratio is divided by used to be a *mip level* of the
 * composite — `detailLod`, derived from the texture's own width so that a canvas
 * drawn at three times its source's density asked for a level 1.6 higher.
 *
 * The atlas has no mip chain to index into (mips bleed across slots), so the
 * blurred tap is a real reduction of each tile to the base map's own density,
 * held in a second small atlas. `lowTapPx` in lib/tileAtlas.ts is the same
 * arithmetic expressed as texels rather than as an octave count, and it is exact
 * rather than clamped into a 0..7 range.
 */

/**
 * Ground degrees covered by one device pixel at the centre of the view.
 *
 * Exact, and simpler than it looks. A ray leaving the camera at angle phi from
 * the axis meets the sphere at ground angle asin(d sin phi) - phi, whose
 * derivative at phi = 0 is d - 1: the altitude itself. Screen position at the
 * centre is (screenPx / 2) * phi / tan(fov / 2). So the whole thing collapses
 * to altitude * 2 tan(fov/2) / screenPx, in radians.
 */
export const degPerScreenPx = (altitude: number, screenPx: number, fovDeg = DEFAULT_FOV): number =>
  (Math.max(altitude, 1e-9) * 2 * Math.tan(((fovDeg / 2) * Math.PI) / 180) * (180 / Math.PI)) /
  Math.max(screenPx, 1)

/**
 * How many base-map texels the screen gets per device pixel.
 *
 * Below 1 the base map is being magnified — every screen pixel is showing less
 * than one texel of a 4096-wide world map, which is exactly what "pixelated"
 * means. This is the number that should decide when a patch is fetched, and it
 * is not what used to decide it.
 */
export const baseTexelsPerScreenPx = (
  altitude: number,
  screenPx: number,
  fovDeg = DEFAULT_FOV,
  basePxPerDeg = BASE_TEXTURE_PX_PER_DEG,
): number => basePxPerDeg * degPerScreenPx(altitude, screenPx, fovDeg)

/**
 * Stream once the base map falls under one texel per device pixel, and keep
 * streaming until it is comfortably back above it.
 *
 * The old gate was `visibleSpanDeg(altitude) < 42`, a fixed horizon angle with
 * no reference to the screen or to the base map at all. It corresponds to a
 * 3.8 degree *frame* — where the 4096 basemap is delivering 0.024 texels per
 * device pixel on a 1800 px viewport, i.e. it is being magnified forty-two
 * times. Everything between "the base map ran out" and "the old threshold
 * fired" was the dead zone the complaint was about: visibly soft ground with
 * nothing on its way.
 */
export const DETAIL_ON_TEXELS = 1
export const DETAIL_OFF_TEXELS = 1.3

/**
 * Does the planet still overflow the frame?
 *
 * The one case where streaming is pointless however coarse the base map looks:
 * with the whole globe inside the lens there is no rectangle of ground to ask
 * for that is not most of a hemisphere, and the request would cost megabytes to
 * beat a 4096 world map by a factor the eye cannot find at that size.
 */
export const planetFillsFrame = (altitude: number, fovDeg = DEFAULT_FOV): boolean =>
  (1 + Math.max(altitude, 0)) * Math.sin(((fovDeg / 2) * Math.PI) / 180) < 1

/** The gate: is a streamed patch worth having at this altitude, on this screen? */
export const detailWanted = (
  altitude: number,
  screenPx: number,
  fovDeg = DEFAULT_FOV,
  shown = false,
): boolean =>
  planetFillsFrame(altitude, fovDeg) &&
  baseTexelsPerScreenPx(altitude, screenPx, fovDeg) < (shown ? DETAIL_OFF_TEXELS : DETAIL_ON_TEXELS)

/**
 * Which source to ask, given how much ground the frame covers.
 *
 * Sentinel-2 is fifty times finer and correspondingly expensive to render over
 * a wide box; Blue Marble is coarse but its 222 px/deg still out-resolves the
 * 11.4 px/deg world texture by twenty times, which is the whole of the win at
 * mid zoom. So the sharp source serves the close range and the base source —
 * previously only a failure fallback — serves the range that used to have
 * nothing at all.
 */
export const pickSource = (spanDeg: number, sharpDisabled = false): ImagerySource =>
  !sharpDisabled && spanDeg <= SHARP_SOURCE.maxSpanDeg ? SHARP_SOURCE : BASE_SOURCE

/**
 * The finest level worth streaming: what the sharp source can actually serve.
 *
 * Level 12 is 5825 px per degree, against Sentinel-2's declared 11100 — level 13
 * would be 11650, past the mosaic's own resolution, and the server would answer
 * a request for it with its own pixels upsampled. Past this the pyramid stops
 * and the terminal tiles are magnified locally instead, which at least costs
 * nothing to fetch.
 */
export const Z_MAX = maxLevel(SHARP_SOURCE)

/**
 * Which source serves a view, decided on the *coarser* of the two levels it will
 * fetch.
 *
 * One source per composite, always. Sentinel-2 is a different sensor from Blue
 * Marble — greener, darker — and where the two met on one canvas the join was a
 * hard line with a palette step across it that no edge feather can help, because
 * the feather is at the tile's edge and the seam is a change of colour across
 * it. So the fallback level and the target level must agree, and asking the
 * question of the fallback level is what makes them: the coarser tile is the
 * wider box, so a source that will render it will certainly render its children.
 */
export const sourceForLevel = (z: number, sharpDisabled = false): ImagerySource =>
  pickSource(tileSpanDeg(z - 1), sharpDisabled)

/**
 * WHICH SOURCES A MODE STREAMS, and how far up the pyramid they go.
 *
 * One value, because the two questions are one decision: `Z_MAX` is a property
 * of what a source can honestly serve, and a pipeline that streamed one
 * source's tiles to another's ceiling would be asking a server to upsample or a
 * rasterizer to draw facets. `DetailImagery` holds a plan rather than reading
 * the module constants, which is the whole of what let a second kind of source
 * exist without a second copy of the scheduler.
 */
export interface SourcePlan {
  zMax: number
  /** The source for a level, given whether the sharp one has been demoted. */
  at(z: number, sharpDisabled: boolean): TileSource
  /** Does a failure from this plan mean anything? Local rendering never retries. */
  remote: boolean
  /**
   * Does the shader PAINT these tiles on, or divide the base map by them?
   *
   * The atlas holds every tile twice — sharp, and reduced to the base map's own
   * density — because the ratio path needs a blurred tap to divide by
   * (lib/tileAtlas.ts, LOW_PX). Paint mode does not: `uDetailPaint = 1` cancels
   * the ratio entirely and the tile is the ground. So this is not a rendering
   * choice made twice, it is the one choice read by both halves — the shader
   * asks it as `DETAIL_MODE`, and the upload path asks it here to know whether
   * the reduction is worth making at all.
   */
  paint?: boolean
}

export const IMAGERY_PLAN: SourcePlan = {
  zMax: Z_MAX,
  at: (z, sharpDisabled) => sourceForLevel(z, sharpDisabled),
  remote: true,
}

/** …and the trivial plan a local source needs: one source at every level. */
export const singleSourcePlan = (source: TileSource, zMax: number, paint = false): SourcePlan => ({
  zMax,
  at: () => source,
  remote: false,
  paint,
})

/** How long the camera must hold still before the prefetch ring is worth spending. */
export const SETTLE_MS = 280

/**
 * The pyramid level a view wants, before it is rounded to a level that exists.
 *
 * `targetLevel` is the ceiling of this, and the ceiling is right for choosing a
 * level: imagery must never be blurrier than the screen it is on. It is the
 * wrong thing to compare two moments of a gesture with, because a zoom that
 * moves the density by a tenth of an octave either side of a boundary changes
 * the ceiling twice and the picture not at all. The lag rule below is written
 * against the continuous number for exactly that reason.
 */
export const levelWanted = (baseTexels: number): number =>
  BASE_LEVEL - Math.log2(Math.max(baseTexels, 1e-9))

/**
 * How far the streamed level may lag the camera DURING A GESTURE, up and down.
 *
 * This is round 54's answer to the field report ("zooming in the drawn map is
 * incredibly choppy"), and to the honest limit phase 2 wrote down for itself:
 * *"a zoom across three levels rebuilds the atlas repeatedly — 95 MB across 91
 * frames; a level-blend would cut the churn."*
 *
 * What made it churn is that every level of the pyramid is a DIFFERENT SET OF
 * TILES. Chasing the density through a continuous zoom therefore does not
 * sharpen the picture level by level; it throws the whole atlas away once per
 * level and starts refilling it at two slots a frame, and the camera leaves
 * before the refill finishes. Measured on the scripted world→z9 zoom, drawn
 * mode: six levels crossed, 177 tiles rendered, 110 slot uploads, 112 MB — and
 * 132 of the 244 tiles the cache took in never reached a slot at all, because
 * the level they belonged to was gone before the upload budget reached them.
 * Half the work of the gesture was for pictures nobody ever saw.
 *
 * The fix is the one the pyramid was already built for. A resident level that
 * is one or two octaves too coarse is not a hole — the shader magnifies it, and
 * on a *drawing* that reads as a slightly heavier pen rather than as a blurred
 * photograph (which is the whole reason `DRAWN_Z_MAX` is above the level the
 * geometry saturates at). So during a gesture the streamed level simply stays
 * where it is, and every tile of it is already resident: a zoom inside the band
 * costs zero renders and zero uploads. When the camera stops, the level snaps
 * to what the camera actually wants and the picture sharpens into it through
 * the same per-slot dissolve everything else arrives by. Nothing about the
 * resting picture changes — which is the requirement, and is what the pixel
 * diff in tests/e2e/drawnMap.e2e.mjs is there to hold.
 *
 * The two bounds are not the same number, and the asymmetry is structural
 * rather than a taste:
 *
 *  · MAGNIFY (the camera has come closer than the held level) is 1.5 octaves.
 *    Holding a coarser level costs NOTHING — its tiles are resident, its grid
 *    is shrinking, and the shader was already magnifying it. The only cost is
 *    softness, and 1.5 octaves of magnification on a drawn coastline is about
 *    what one wheel-notch of overshoot already looked like.
 *  · MINIFY (the camera has pulled back past the held level) is 1.0 octave,
 *    and it is bounded by the atlas rather than by preference: holding a finer
 *    level while the frame grows means covering four times the ground at that
 *    level per octave, and `fitLevel` refuses it as soon as the grid and its
 *    parent stop fitting 64 slots. Past one octave the refusal is certain, so
 *    the rule states the limit instead of discovering it.
 */
export const HOLD_MAGNIFY = 1.5
export const HOLD_MINIFY = 1.0

/**
 * Which level to stream: the one the camera wants, or the one already resident.
 *
 * `held` is the level the last frame actually used — after `fitLevel`, so it is
 * a level that fits — and `undefined` before anything has streamed. A still
 * camera always gets `wanted`, which is what makes the lag invisible at rest
 * and keeps every settled view byte-identical to the view before this rule
 * existed.
 */
export const heldLevel = (
  held: number | undefined,
  wantedFrac: number,
  wanted: number,
  still: boolean,
): number => {
  if (held === undefined || still) return wanted
  if (wantedFrac - held > HOLD_MAGNIFY) return wanted
  if (held - wantedFrac > HOLD_MINIFY) return wanted
  return held
}

/**
 * How many tile requests may be outstanding at once.
 *
 * Six is roughly a browser's own per-origin ceiling on HTTP/1.1 and a sane
 * pipeline depth on HTTP/2. The cap is what makes a gesture cheap: the wanted
 * set is recomputed every frame, so a zoom that crosses three levels does not
 * put three levels of tiles on the wire — it puts six requests on the wire and
 * re-picks the next six from wherever the camera has got to.
 */
export const TILE_INFLIGHT = 6

/**
 * How far a LOCAL source may render ahead of the atlas.
 *
 * Counted in tiles that are decoded, wanted, and still waiting for a slot —
 * `backlog`, the same number that keeps the render pump awake. Two is
 * `ATLAS_UPLOADS_PER_FRAME`, so four is one animation frame of headroom over
 * the budget: a tile is always ready the moment a slot frees, and nothing is
 * drawn for a frame the uploader will never catch up with. See `pump`.
 */
export const LOCAL_RENDER_AHEAD = ATLAS_UPLOADS_PER_FRAME * 2

/**
 * Arrivals no longer need collecting.
 *
 * `TILE_COALESCE_MS` existed because a view wants tens of tiles, they land
 * within milliseconds of each other, and every one of them used to trigger a
 * whole-canvas upload and a `generateMipmap` — 48 of those across one scripted
 * pan and zoom, for six distinct pictures. A tile now costs one 512 texSubImage,
 * so a burst of sixteen is sixteen cheap uploads spread two to a frame rather
 * than one expensive upload that had to be timed.
 */

export interface DetailImageryOptions {
  /**
   * Where the atlas lives. Without one the class is pure bookkeeping — slots are
   * still allocated and the index still built — which is what lets the whole
   * scheduler and fallback story be tested away from a GPU.
   */
  renderer?: WebGLRenderer
  /** Bytes of decoded tiles to hold. See TILE_MEMORY_BUDGET. */
  tileBudget?: number
  /** Slots in the atlas; the tests use a small one to reach eviction. */
  atlasSlots?: number
  /** Which sources to stream, and how far. Defaults to the WMS imagery plan. */
  plan?: SourcePlan
}

/** What the live camera wants: recomputed from scratch on every frame. */
interface Wanted {
  target: Bbox
  plan: TilePlan
}

export class DetailImagery {
  /** The atlas the shader samples, and the index that addresses it. */
  readonly atlas: TileAtlas
  index?: AtlasIndex
  mix = 0
  status: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle'
  sourceLabel = '—'
  attribution = ''
  /** Ground resolution of the imagery on screen, in metres per pixel. */
  groundRes = 0
  onReady?: () => void

  /**
   * Bumped when everything in flight stops being relevant — the camera left the
   * streaming range, imagery was switched off, the component went away.
   *
   * It never marks a request as merely superseded, and that is deliberate. A
   * late tile is not wrong, only coarse or off to one side: it covers the ground
   * it covers, and the index either addresses it or does not. Arrival order
   * decides nothing; geometry does. (Before that rule, a zoom threw away
   * everything it fetched — 31 megapixels across a fourteen-second zoom to put
   * one patch on screen.)
   */
  private generation = 0
  /** Re-pumps once the camera has actually stopped, so the ring gets spent. */
  private settle?: ReturnType<typeof setTimeout>
  private strikes = 0
  private sharpStrikes = 0
  private sharpDisabled = false
  private shown = false
  private disabled = false
  /** Decoded tiles, bounded by bytes — see lib/tilePyramid.ts. */
  private tiles: TileCache<CanvasImageSource>
  private tileBudget: number
  /** See SourcePlan: what this instance streams, swappable at runtime. */
  private plan: SourcePlan
  /** Tile keys on the wire, and the ones their source has already refused. */
  private inflight = new Set<string>()
  private refused = new Set<string>()
  /** The wanted set the scheduler is spending on and the index is built from. */
  private want?: Wanted
  /** The view the camera is judged to have moved *from*, and when; see MOTION_EPS. */
  private restingAt?: Bbox
  private movedAt = 0
  /** Wanted tiles that are decoded but not yet in a slot; see `animating`. */
  private backlog = 0
  /** The upload budget, and when it was last topped up. See UPLOAD_WINDOW_MS. */
  private credit = ATLAS_UPLOADS_PER_FRAME
  private creditAt = 0
  /** Attribution text by source label, so the panel can describe what is shown. */
  private attributions = new Map<string, string>()
  /**
   * The level the last frame actually streamed, and whether it is behind the
   * camera on purpose. See `heldLevel`.
   */
  private held?: number
  private lagging = false
  /** The last camera this was updated with, so the settle can re-derive from it. */
  private last?: [number, number, number, number, number, number]

  constructor(opts: DetailImageryOptions = {}) {
    this.tileBudget = opts.tileBudget ?? TILE_MEMORY_BUDGET
    this.plan = opts.plan ?? IMAGERY_PLAN
    this.tiles = new TileCache(this.tileBudget, (img) => this.release(img))
    this.atlas = new TileAtlas(opts.renderer, opts.atlasSlots)
  }

  /**
   * Is there work left that the clock, rather than the camera, will finish?
   *
   * Two kinds: tiles decoded but not yet uploaded (the budget spreads them over
   * frames), and slots still dissolving in. Both change the picture without
   * anyone touching the globe, so the render pump has to keep drawing — the same
   * contract the cloud drift and the map fades are under.
   */
  /**
   * The ground the wanted set was cut to. Read by the instrument route only —
   * it is what makes "did this view ask for the far side of the seam?" a fact
   * an e2e can assert rather than infer (tests/e2e/repro51.e2e.mjs).
   */
  get wanted(): Bbox | undefined {
    return this.want?.target
  }

  get animating(): boolean {
    return this.backlog > 0 || !!this.index?.fading
  }

  /**
   * Stream a different kind of tile from here on — the map/globe switch.
   *
   * Everything in flight is abandoned by generation and the wanted set is
   * dropped, because a Sentinel tile arriving into a drawn view would be
   * cached under its own label (harmless) and indexed into a grid built for the
   * other source (not harmless). The decoded cache itself is NOT cleared: it is
   * keyed by source label already, so switching back finds the tiles it left.
   */
  setPlan(plan: SourcePlan) {
    if (plan === this.plan) return
    this.plan = plan
    this.cancelQueued()
    this.sharpDisabled = false
    this.sharpStrikes = 0
    this.strikes = 0
    this.disabled = false
    this.refused.clear()
    this.shown = false
    this.mix = 0
    this.index = undefined
    this.status = 'idle'
    this.sourceLabel = '—'
  }

  /** The source that serves a level under the current plan. */
  private sourceAt(z: number): TileSource {
    return this.plan.at(z, this.sharpDisabled)
  }

  update(
    lat: number,
    lng: number,
    altitude: number,
    screenPx = 900,
    aspect = 1,
    fovDeg = DEFAULT_FOV,
  ) {
    if (this.disabled) return

    // The gate is "is the base map under-resolved on this screen", not a fixed
    // horizon angle — see detailWanted. Hysteresis lives in the threshold pair,
    // so hovering at the boundary cannot flicker.
    if (!detailWanted(altitude, screenPx, fovDeg, this.shown)) {
      // tiles already on the wire must not land and adopt themselves onto a view
      // nobody is looking at any more
      this.cancelQueued()
      if (this.shown) {
        this.shown = false
        this.mix = 0
        this.status = 'idle'
        this.sourceLabel = '—'
        this.onReady?.() // or the panel keeps describing a patch nobody can see
      }
      return
    }

    this.last = [lat, lng, altitude, screenPx, aspect, fovDeg]

    // Three numbers describe everything the pipeline does with this frame: the
    // ground in view, the pyramid level that matches the screen's density, and
    // the tiles that follow from the two. All pure, all in lib/tilePyramid.ts
    // and lib/tileAtlas.ts.
    const target = viewBbox(lat, lng, altitude, aspect, PATCH_MARGIN, fovDeg)

    // Is the camera moving *at all*? Measured from where it last counted as
    // having moved, never from the previous frame: a gesture is a displacement
    // over a window of time, and a per-frame comparison can only see a speed.
    // See MOTION_EPS. It is answered BEFORE the level is chosen because the
    // level now depends on it — a still camera streams what it wants and a
    // moving one may keep what it has (see `heldLevel`) — and answering it
    // afterwards would have spent a whole frame on the previous gesture's
    // classification.
    if (viewMotion(this.restingAt, target) > MOTION_EPS) {
      this.movedAt = Date.now()
      this.restingAt = target
    }

    const dense = baseTexelsPerScreenPx(altitude, screenPx, fovDeg)
    const wanted = targetLevel(dense, this.plan.zMax)
    // …and what the camera gets, which through a gesture may be the level it
    // already has. The picture is a magnification of a resident level rather
    // than a rebuild of the atlas; see HOLD_MAGNIFY.
    const pick = heldLevel(this.held, levelWanted(dense), wanted, this.still)
    // `fitLevel` is the only place resolution is ever given up, and it is the
    // atlas's 64 slots doing the giving — the same 4096² ceiling `patchPixelCap`
    // used to enforce on a canvas. It is also what bounds the lag on the way
    // out: a held level whose grid no longer fits is refused here.
    const z = fitLevel(target, pick)
    this.held = z
    // Lagging means THE HOLD DEVIATED, not merely that the level is not the
    // density's first choice. `fitLevel` also lowers the level — permanently,
    // on a dense enough screen — and reading that as a lag would arm the
    // settle's replay forever, which is a timer firing four times a second at
    // rest for a view that is already correct. Frame-on-demand is a promise
    // about a parked globe and this is one of the things that could break it.
    this.lagging = pick !== wanted

    // The plan is a pure function of (target, z), and `update` is reached two
    // or three times per animation frame — the camera-change handler and the
    // render tick both go through it. Recomputing an identical plan is three
    // `tilesCovering` sweeps, three sorts and a hundred string keys for an
    // answer that cannot have changed; the parts that CAN change on the clock
    // rather than on the camera — the upload budget and the fades — are below.
    if (!this.want || this.want.plan.z !== z || !sameBbox(this.want.target, target)) {
      this.want = { target, plan: tilePlan(target, z) }
      // Asking for a tile is idempotent — the cache and the in-flight set dedupe
      // by key — so there is no "has the view moved enough to be worth a
      // request" question left to get wrong, and no request to cancel when it
      // moves again.
      this.pin()
    }
    const now = Date.now()
    // ABSORB BEFORE PUMPING, which is the order the local queue's bound makes
    // necessary. `pump` now reads `backlog` to decide how far ahead of the
    // atlas a local source may render, and `absorb` is what recomputes it —
    // so asking first asks against the previous frame's answer, and the frame
    // that frees the queue is not the frame that refills it. At best that
    // costs a frame of latency on every tile; at worst the last absorb of a
    // view empties `backlog`, `animating` goes false with it, and nothing asks
    // for the frame on which the remaining tiles would have been requested —
    // leaving the settle timer 280 ms later as the only thing that finishes
    // the picture. Neither is a trade worth making for an ordering that buys
    // nothing: a request is asynchronous either way.
    this.absorb(now)
    this.pump()
    this.reindex(now)
    this.arm()
  }

  /**
   * Is the camera at rest?
   *
   * Public because it is a fact about the pipeline worth asserting from outside
   * it: this is the one classification commit 96954fe was about, and the ring —
   * the only thing left that reads it — is hard to observe directly.
   */
  get still(): boolean {
    return Date.now() - this.movedAt >= SETTLE_MS
  }

  /**
   * Which tiles eviction may not touch: the whole wanted set, and the parents
   * that stand in wherever the target level has a hole.
   *
   * The ring is in it, and has to be. Leaving a fetched tile evictable while it
   * is still wanted is a fetch loop a still camera never leaves: the tile is
   * fetched, trimmed for want of budget, wanted again on the very next frame,
   * fetched again. Measured against the mock service before this line existed —
   * 907 requests for 140 distinct tiles across one scripted pan and zoom.
   *
   * The atlas is pinned on the narrower set: only the two levels the index
   * addresses. A ring tile is worth holding *decoded* against the pan that is
   * about to want it, and worth no slot until that pan happens.
   */
  private pin() {
    const w = this.want
    if (!w) return
    const label = this.sourceAt(w.plan.z).label
    const keys = new Set<string>()
    for (const t of w.plan.fallback) keys.add(tileKey(t, label))
    for (const t of [...w.plan.level, ...w.plan.ring]) {
      keys.add(tileKey(t, label))
      keys.add(tileKey(parentOf(t), label))
    }
    this.tiles.pin(keys)
    this.atlas.slots.pin(this.indexed(label))
  }

  /** The tiles the index addresses this frame — fallback first, then the level. */
  private indexed(label: string): string[] {
    const w = this.want
    if (!w) return []
    return [...w.plan.fallback, ...w.plan.level].map((t) => tileKey(t, label))
  }

  /**
   * Spend whatever is left of the in-flight budget on the most useful tiles.
   *
   * Parents first: the fallback level is a quarter of the bytes of the level it
   * stands under, and it is what decides whether a moving camera sees coarse
   * imagery or bare base map. Then the target level, centre outward, because
   * that is where the eye is. The ring last and only at rest — during a gesture
   * every byte belongs to ground that is on screen now.
   */
  private pump() {
    const w = this.want
    if (!w || this.disabled) return
    // A LOCAL SOURCE MAY NOT RENDER AHEAD OF THE ATLAS.
    //
    // `TILE_INFLIGHT` is six because six is what a browser will keep on the
    // wire, and it is the right number for a thing whose cost is *latency*: a
    // request already made costs nothing more to leave outstanding, so starting
    // early is free and arriving late is the only risk. A local rasterizer
    // inverts that. Its cost is CPU, it is not paid until the tile is drawn,
    // and it is roughly a millisecond — so six in flight drains in six
    // milliseconds and refills from a plan that will be three frames stale
    // before the atlas, which absorbs two slots per frame, has taken a quarter
    // of it. The renderer runs about ten times faster than the uploader and the
    // surplus is pure waste: measured on the scripted zoom out, 68 of 104 tiles
    // drawn, decoded and cached never reached a slot at all.
    //
    // So the local queue is bounded by what the atlas can actually take. One
    // frame's worth of headroom over the upload budget keeps a tile ready
    // whenever a slot frees, and stops the rasterizer drawing pictures for a
    // camera position the uploader will never reach.
    if (!this.plan.remote && this.backlog >= LOCAL_RENDER_AHEAD) return
    const src = this.sourceAt(w.plan.z)
    const queue = [...w.plan.fallback, ...w.plan.level]
    // The ring is spent out of *headroom*, and only at rest. The frame's own
    // tiles are fetched whatever the budget says — a hole on screen costs a
    // refetch as well as a hole — but a guess about where the camera is going
    // may not push the cache past its bound, because everything wanted is
    // pinned and the overshoot would then be unbounded.
    if (this.still && this.tiles.bytes < this.tileBudget) queue.push(...w.plan.ring)
    for (const tile of queue) {
      if (this.inflight.size >= TILE_INFLIGHT) return
      const key = tileKey(tile, src.label)
      if (this.tiles.has(key) || this.inflight.has(key) || this.refused.has(key)) continue
      this.request(tile, key, src)
    }
  }

  /**
   * One tile, at the pyramid's own size, through the same WMS path as before.
   *
   * The URL is canonical — the same ground at the same level is the same string
   * forever — so the browser's HTTP cache and the service's both hit, which an
   * arbitrary bbox per view never allowed.
   */
  private request(tile: Tile, key: string, src: TileSource) {
    const gen = this.generation
    this.inflight.add(key)
    // Only while there is nothing to look at. The prefetch ring goes out *after*
    // the view is covered and would otherwise leave the panel reading "loading"
    // over a picture that is finished.
    if (!this.shown) this.status = 'loading'
    // A LOCAL source answers the same question with a promise instead of a
    // network round trip. Everything after the arrival is identical, which is
    // the point: `adopt` does not know, the cache does not know, the atlas does
    // not know.
    if (src.render) {
      src.render(tile).then(
        (image) => {
          this.inflight.delete(key)
          this.adopt(key, image, src, gen)
        },
        () => {
          this.inflight.delete(key)
          this.refuse(key, src)
        },
      )
      return
    }
    const img = new Image()
    img.crossOrigin = 'anonymous'
    const arrived = (image: CanvasImageSource) => {
      this.inflight.delete(key)
      this.adopt(key, image, src, gen)
    }
    img.onload = () => {
      // Decoding to an ImageBitmap moves the pixel work off the main thread and
      // gives eviction something it can free on demand rather than when the
      // collector feels like it. It is also what makes the atlas upload cheap:
      // an ImageBitmap is already in the form the driver wants.
      if (typeof createImageBitmap === 'function') {
        createImageBitmap(img).then(arrived, () => arrived(img))
      } else arrived(img)
    }
    img.onerror = () => {
      this.inflight.delete(key)
      this.refuse(key, src)
    }
    img.src = wmsUrl(src as ImagerySource, bboxOf(tile), TILE_PX, TILE_PX)
  }

  /**
   * One failure is a bad response; two from the same source is the source.
   *
   * Counted per source rather than per tile, because that is the failure worth
   * reacting to. The tile is remembered as refused so the scheduler cannot loop
   * on it, and demoting the sharp source changes every key it would ask for
   * next, so the retry is the whole view at once rather than one tile at a time.
   */
  private refuse(key: string, src: TileSource) {
    this.refused.add(key)
    // A local render that failed did not fail because of the source: there is
    // no server to demote and no strike to count, only a tile the fallback
    // level already covers.
    if (!this.plan.remote) return
    if (src === SHARP_SOURCE) {
      this.sharpStrikes++
      if (this.sharpStrikes >= 2) this.sharpDisabled = true
    } else if (++this.strikes >= 3) {
      this.disabled = true
      this.status = 'unavailable'
      this.onReady?.()
      return
    }
    this.pump()
  }

  /**
   * Take up an arriving tile.
   *
   * It always enters the cache, whatever has happened since it was asked for —
   * see `generation`. What it no longer does is wait: there is no publish to
   * defer, no burst to coalesce and no settle to arm, because reaching the
   * screen now costs one 512 upload out of a per-frame budget. All this has to
   * do is mark the pipeline as having work, which is what wakes the render loop.
   */
  private adopt(key: string, image: CanvasImageSource, src: TileSource, gen: number) {
    this.tiles.set(key, image)
    this.attributions.set(src.label, src.attribution ?? '')
    this.strikes = 0
    if (gen !== this.generation) return
    // COUNTED, not flagged. It used to be `max(backlog, 1)`, which was enough
    // for the only reader it had — `animating`, which asks "is there work left"
    // — but a flag cannot bound a queue. A local source resolves on a microtask
    // and `pump` below re-fills from inside that resolution, so a whole plan
    // was drawn in one frame's cascade before `absorb` ever ran to say how far
    // ahead the renderer had got. One more decoded tile with no slot is exactly
    // what has just happened; `absorb` recomputes the exact figure every frame.
    this.backlog++
    this.pump() // a slot came free
    this.onReady?.()
  }

  /**
   * Keep asking, until the camera has actually stopped.
   *
   * The only thing left that waits for stillness is the prefetch ring, and the
   * render loop cannot be relied on to ask for it: `update` runs on frames the
   * camera moves, and by definition the ring is wanted on the first frame it
   * does not. So one timer, re-armed while the view is still drifting, and a
   * `pump` when it is not.
   */
  private arm() {
    if (this.settle !== undefined) return
    this.settle = setTimeout(() => {
      this.settle = undefined
      if (!this.still) return this.arm()
      // A gesture that ended on a held level has to be told the gesture ended.
      // Nothing else would tell it: `update` runs on frames the camera moves,
      // and by definition this is the first moment it has not — so without this
      // the view would keep the coarse level it was magnifying and never
      // sharpen into the one it stopped at. Re-deriving from the camera it
      // stopped at is what makes the lag a property of the GESTURE and not of
      // the resting picture. It terminates: the replay runs with `still` true,
      // so `heldLevel` returns the wanted level, `lagging` goes false, and the
      // timer it arms takes the plain branch below.
      if (this.lagging && this.last) this.update(...this.last)
      else this.pump()
    }, SETTLE_MS)
  }

  /**
   * Move decoded tiles into atlas slots, at most `ATLAS_UPLOADS_PER_FRAME` a
   * frame.
   *
   * Derived from the wanted set rather than from an arrival queue, and that is
   * deliberate: a slot can also be lost to eviction while its tile is still in
   * the decoded cache, and "wanted, decoded, no slot" is the one condition that
   * covers both cases. Fallback level first, then the target level centre
   * outward, which is the order the plan already comes in.
   */
  private absorb(now: number) {
    const w = this.want
    if (!w) return
    const label = this.sourceAt(w.plan.z).label
    // A token bucket, not a per-call allowance: `update` is reached more than
    // once in an animation frame (the camera-change handler and the render tick
    // both go through it, and a zoom three times), so counting calls spent two
    // and three budgets in one frame — see UPLOAD_WINDOW_MS.
    this.credit = Math.min(
      ATLAS_UPLOADS_PER_FRAME,
      this.credit + ((now - this.creditAt) / UPLOAD_WINDOW_MS) * ATLAS_UPLOADS_PER_FRAME,
    )
    this.creditAt = now
    let budget = Math.floor(this.credit)
    let left = 0
    for (const t of [...w.plan.fallback, ...w.plan.level]) {
      const key = tileKey(t, label)
      if (this.atlas.slots.has(key)) continue
      const image = this.tiles.get(key)
      if (!image) continue
      if (budget > 0) {
        // …without the reduced copy where the shader paints rather than
        // divides: see SourcePlan.paint and TileAtlas.put.
        this.atlas.put(key, image, t.z, now, !this.plan.paint)
        budget--
        this.credit--
      } else left++
    }
    this.backlog = left
  }

  /**
   * Rebuild the index the shader resolves through, and describe what it shows.
   *
   * Every frame, because the grid origin moves with the camera and the fades
   * move with the clock — but it is 1 KB of `Uint8Array` and one `texSubImage2D`
   * of a 16x16 texture, which is three orders of magnitude under the composite
   * upload it replaces.
   */
  private reindex(now: number) {
    const w = this.want
    if (!w) return
    const label = this.sourceAt(w.plan.z).label
    const index = buildIndex(
      w.plan.z,
      w.plan.level,
      w.plan.fallback,
      (t) => this.atlas.slots.slotOf(tileKey(t, label)),
      now,
    )
    this.index = index
    this.atlas.setIndex(index)
    if (!index.resident) return
    // the panel describes what is on screen, which is the finest level actually
    // resident — not whichever request happened to return last
    this.groundRes = (tileSpanDeg(index.sharp ? w.plan.z : w.plan.z - 1) * 111_320) / TILE_PX
    // Provenance no longer has to be *held* across a hide the way it did when
    // the label described a texture that outlived the view: the index is rebuilt
    // from the camera every frame, so re-showing re-derives it.
    this.sourceLabel = label
    this.attribution = this.attributions.get(label) ?? ''
    if (this.shown && this.mix === 1 && this.status === 'ready') return
    this.mix = 1
    this.shown = true
    this.status = 'ready'
    this.onReady?.()
  }

  private cancelQueued() {
    clearTimeout(this.settle)
    this.settle = undefined
    // …and the wanted set with it, so nothing can be pumped for a view that is
    // no longer on screen
    this.want = undefined
    this.backlog = 0
    // The held level is a claim that a level is RESIDENT and worth magnifying.
    // Nothing here is resident any more — the plan changed, or the camera left
    // the streaming range — so the next view picks its level from the camera.
    this.held = undefined
    this.lagging = false
    if (!this.inflight.size) return
    // in-flight tiles still land in the cache — they are as true as ever — but
    // they resolve into a dead generation and reach no screen
    this.generation++
  }

  /** An ImageBitmap holds real memory until closed; anything else needs nothing. */
  private release(image?: CanvasImageSource) {
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close()
  }

  dispose() {
    this.cancelQueued()
    this.tiles.clear()
    this.atlas.dispose()
  }
}
