import { LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture } from 'three'
import {
  TILE_MEMORY_BUDGET,
  TILE_PX,
  TileCache,
  bboxOf,
  childrenOf,
  maxLevel,
  parentOf,
  placeOnCanvas,
  targetLevel,
  tileKey,
  tilePlan,
  tileSpanDeg,
  type Tile,
  type TilePlan,
} from './tilePyramid'
import {
  createPatchResampler,
  upscaleFits,
  type Crop,
  type PatchResampler,
} from './patchResample'

/**
 * High-resolution imagery for the region being looked at, streamed as a pyramid
 * of fixed WMS tiles and composited onto one canvas for the shader.
 *
 * The first version stitched WMTS tiles and got the index arithmetic wrong; the
 * second asked for one arbitrary rectangle per settled view, which could not
 * drift because there was no index left — and could not cache either, because
 * every URL it built was unique. It refetched ground it already held on any pan,
 * it could prefetch nothing, and it spent a full-resolution request on a view
 * the camera was about to leave.
 *
 * So the grid is back, but as `lib/tilePyramid.ts`: pure functions with their
 * own tests, aligned to the sphere, wrapping in longitude and clamping in
 * latitude in one tested place rather than in this file. What that buys is what
 * Maps has always had — canonical cacheable URLs, a prefetch ring, no refetch of
 * ground already paid for, and a coarser level resident under every pixel so a
 * gesture shows soft imagery instead of a hole.
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
 */
export const minAltitudeFor = (year: number, detailEnabled: boolean): number =>
  detailEnabled && year < IMAGERY_ERA_FROM ? MIN_ALTITUDE_PRE_ERA : MIN_ALTITUDE_DETAIL

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
  const minLng = clamp(lng - lngSpan / 2, -180, 180)
  const maxLng = clamp(lng + lngSpan / 2, -180, 180)
  return { minLat, minLng, maxLat, maxLng }
}

/** The bbox expressed in the globe's UV space: u=(lng+180)/360, v=(lat+90)/180. */
export const bboxToUvRect = (b: Bbox): [number, number, number, number] => [
  (b.minLng + 180) / 360,
  (b.minLat + 90) / 180,
  (b.maxLng - b.minLng) / 360,
  (b.maxLat - b.minLat) / 180,
]

/** Hard ceiling per axis. 4096 is the smallest max-texture-size in the field. */
export const MAX_PATCH_PX = 4096

/**
 * The composite canvas is one size, and never shrinks under a moving camera.
 *
 * There used to be two: a half-scale one while the camera moved and a
 * full-scale one at rest, on the reasoning that a picture replaced within a
 * frame or two need not be sharp. The reasoning is sound and the behaviour is
 * not. A wheel zoom is a burst of small movements with pauses between them, and
 * the settle timer fires in every pause — so the canvas halved and doubled
 * several times a second, and each doubling is imagery visibly snapping back
 * into focus. That is the "replaced by lower and then back by higher" half of
 * the field report, and it is worse than the cost it was avoiding: the display
 * rule is that effective resolution must not go backward over ground the camera
 * is already looking at, and a canvas that shrinks breaks it everywhere at once.
 *
 * What is left of the saving is the part that costs nothing to look at: the
 * size ladder (COMPOSITE_SIZE_STEP) and the redraw dedupe mean one allocation
 * and one upload per distinct picture, rather than one per frame.
 */

/**
 * Granularity of a composite canvas's size.
 *
 * The size a zoom asks for drifts by a pixel or two per frame — 1462, 1430,
 * 1417, 1413, 1406 — and every distinct size is a fresh GL allocation and a
 * fresh mip chain, on the main thread, several times a second. Snapping to a
 * ladder turns a whole zoom into one allocation.
 *
 * The canvas need not match the target rectangle's aspect for the geometry to
 * be right: `placeOnCanvas` and `bboxToUvRect` are both expressed in the target
 * bbox, so snapping the two axes independently changes only how square the
 * texels are, which the shader already accounts for through uDetailSize.
 */
export const COMPOSITE_SIZE_STEP = 128

/** Snap a composite axis up to the ladder, without passing the ceiling. */
export const snapCompositeSize = (px: number, maxPx: number, step = COMPOSITE_SIZE_STEP): number =>
  Math.max(step, Math.min(maxPx, Math.ceil(px / step) * step))

/**
 * How large the composite canvas is — a function of the screen and the ceiling,
 * and of nothing else.
 *
 * It used to be derived from the target rectangle and from how much resolution
 * the cached imagery actually held, which is the economical answer and the wrong
 * one. Both inputs change continuously as the camera moves, so the canvas
 * changed size on almost every composite, and a texture whose image changes
 * shape cannot be re-uploaded into its existing GL storage — every one of those
 * is a fresh allocation, a fresh upload and a fresh mip chain on the main
 * thread. Measured across the scripted sequence: twelve reallocations for
 * fifteen composites, and 10–20 seconds of blocking time.
 *
 * Sizing to the screen instead gives exactly two sizes for a session — one for
 * motion, one for rest — so the texture is allocated twice and re-uploaded in
 * place thereafter. At wide zoom the canvas then holds more pixels than the
 * imagery in it contains, which costs memory and cannot cost quality: the
 * shader's mip level is derived from the texture's own width, so a canvas drawn
 * larger than its source is described honestly.
 *
 * The canvas need not share the target rectangle's aspect for the geometry to
 * be right — `placeOnCanvas` and `bboxToUvRect` are both expressed in the target
 * bbox — so both axes snap independently and only the texel shape changes.
 */
export function compositeCanvasSize(
  screenPx: number,
  aspect: number,
  maxPx: number,
): { width: number; height: number } {
  const height = snapCompositeSize(screenPx * PATCH_MARGIN, maxPx)
  const width = snapCompositeSize(screenPx * PATCH_MARGIN * clamp(aspect, 0.35, 3), maxPx)
  return { width, height }
}

/**
 * What this device should be asked to hold for one patch.
 *
 * The 4096 ceiling is a statement about GL limits, not about whether uploading
 * 33 MB of texture per composite is a reasonable thing to do to a phone. Two
 * things bound it in practice: the driver's own maximum, and how much memory
 * the device has to lose — a patch at the ceiling costs its own bytes plus a
 * third again for mips, and it is competing with an 8192-wide cloud mask and
 * three 4096 base maps.
 *
 * `deviceMemory` is coarse (and absent on Safari), so a very dense screen with
 * no memory hint is assumed to be a phone rather than a workstation: that is
 * the way round where guessing wrong is cheap — a slightly softer patch — while
 * the other way is a stall the user feels.
 */
export function patchPixelCap(
  opts: { maxTextureSize?: number; devicePixelRatio?: number; deviceMemoryGb?: number } = {},
): number {
  const limit = Math.min(opts.maxTextureSize ?? MAX_PATCH_PX, MAX_PATCH_PX)
  const memory = opts.deviceMemoryGb ?? ((opts.devicePixelRatio ?? 1) >= 2.5 ? 4 : 8)
  const budget = memory <= 2 ? 1536 : memory <= 4 ? 2048 : memory <= 8 ? 3072 : MAX_PATCH_PX
  return Math.max(512, Math.min(limit, budget))
}

/**
 * Bounds on the Lanczos-3 upscale of a held patch (see DetailImagery.magnified).
 *
 * Measured in Chromium on the build machine, the compiled kernel runs about
 * 50 ms per megapixel of output, so two megapixels is a ~100 ms budget: one
 * dropped frame at the moment the camera stops moving, paid once per patch and
 * only while imagery is being magnified anyway. Above the cap the composite
 * falls back to bilinear, which is what it always did.
 */
export const RESAMPLE_MAX_PX = 2_000_000
/** Below this magnification, Lanczos-3 and bilinear are the same picture. */
export const RESAMPLE_MIN_SCALE = 1.25


/**
 * Has the view left the patch we hold (or asked for) by enough to be worth a
 * new request?
 *
 * Each axis is judged against its *own* span. Measuring an east–west move
 * against the latitude span looks equivalent and is not: the patch is ~3× wider
 * than it is tall at 70° N, and narrower than it is tall on a portrait phone at
 * the equator. The first case refetched on almost any pan; the second let the
 * view slide more than half a patch-width off the imagery without refetching.
 */
export const movedEnough = (a: Bbox | undefined, b: Bbox) => {
  if (!a) return true
  const latSpan = b.maxLat - b.minLat
  const lngSpan = b.maxLng - b.minLng
  return (
    Math.abs(a.minLat - b.minLat) > latSpan * 0.2 ||
    Math.abs(a.minLng - b.minLng) > lngSpan * 0.2 ||
    Math.abs(a.maxLat - a.minLat - latSpan) > latSpan * 0.1
  )
}

/**
 * Does the rectangle already composited cover all of the one now wanted?
 *
 * Every publish is a full re-upload of the composite canvas *and* a full
 * `generateMipmap` over it — there is no partial mip regeneration in WebGL, so
 * the chain is rebuilt whatever fraction of the pixels changed. Measured over
 * one scripted zoom-in: sixteen uploads and eighteen chain rebuilds, 29 MB at a
 * 640-px viewport and ~130 MB at a desktop one.
 *
 * On a zoom-in every one of those was wasted. The composite is published with
 * its own rectangle (`uDetailRect`), and the shader maps it onto the globe by
 * that rectangle — so a composite of a *wider* box is still exactly where it
 * belongs over the ground, it simply extends past the frame. Redrawing it onto
 * the narrower box adds no ground at all; it only spends canvas pixels on less
 * of it, which is what the settle-time pass does anyway, sharper, 280 ms later.
 *
 * A pan or a zoom-out exposes ground the held rectangle does not have, so this
 * returns false and the fast redraw happens as before. A zoom-out therefore
 * still redraws about every 10% of span growth — 32 publishes across a
 * 90-frame gesture, measured. Compositing onto a rectangle half again as wide
 * as the frame cuts that to 9 and was tried and rejected: the same canvas over
 * more ground is a coarser picture of the ground already on screen, and "the
 * effective resolution must not go backward over ground the camera is already
 * looking at" is the rule the composite sizing exists to keep. Zoom-out was
 * also not what anyone reported; zoom-in was, and this fixes that outright.
 *
 * Plain comparisons are safe because no rectangle here wraps: `viewBbox` clamps
 * longitude into -180..180, and the composite is always cut to one of those.
 *
 * It also now answers a question it could only approximate before. Every
 * composite is drawn over a complete fallback level, so a rectangle that
 * contains the view has imagery on every pixel of it — which is what retired
 * the union-coverage scan that used to be the top row of a pan profile.
 */
export const coversView = (held: Bbox | undefined, want: Bbox): held is Bbox =>
  !!held &&
  held.minLat <= want.minLat &&
  held.maxLat >= want.maxLat &&
  held.minLng <= want.minLng &&
  held.maxLng >= want.maxLng

/**
 * How much of the wanted rectangle the held one actually covers, 0 to 1.
 *
 * Degrees squared, not real area: both rectangles are the same view a moment
 * apart, so the cosine that would turn this into ground area divides out of the
 * ratio.
 */
export const viewCoverage = (held: Bbox | undefined, want: Bbox): number => {
  if (!held) return 0
  const lat = Math.min(held.maxLat, want.maxLat) - Math.max(held.minLat, want.minLat)
  const lng = Math.min(held.maxLng, want.maxLng) - Math.max(held.minLng, want.minLng)
  if (lat <= 0 || lng <= 0) return 0
  const area = (want.maxLat - want.minLat) * (want.maxLng - want.minLng)
  return area > 0 ? Math.min(1, (lat * lng) / area) : 0
}

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
    Math.abs(a.minLng - b.minLng) / lng,
    Math.abs(a.maxLng - b.maxLng) / lng,
  )
}

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
 * `generateMipmap`, and 526 Lanczos jobs. The same pan at 0.0078 span/frame
 * published once, and a flick three times. The user's report was exactly this
 * way round, and now all three publish once or less.
 *
 * Measured instead from the last view that *counted* as a move, the same 0.002
 * is a displacement rather than a speed: any drift crossing it inside SETTLE_MS
 * re-arms the settle, so the whole crawl is one gesture. A decaying motion still
 * converges — orbit damping leaves a finite distance to travel, so the crossings
 * thin out and stop — and a parked camera never crosses at all.
 */
export const MOTION_EPS = 0.002

/**
 * The escape hatch on motion-deferred publishing: how little of the view the
 * published rectangle may still cover, and how often the hatch may fire.
 *
 * Nothing is published while the camera is moving. A publish is a full texture
 * upload plus a full `generateMipmap` — 111 ms measured at a desktop composite
 * size — and during a drag it buys only the strip of ground that has just come
 * into view, for one frame, before the next drag frame moves on. Eight of them
 * across a 2.5 s pan is the staggered motion that was reported, and the right
 * answer is to spend none of them: the patch already on the GPU is mapped to
 * its own ground rectangle by the shader, so it pans with the globe for free
 * and stays exactly where it belongs. What the user gives up is imagery on the
 * newly exposed edge until the camera rests, which is the trade that was asked
 * for.
 *
 * The hatch exists so a long drag cannot leave the view with no imagery at all.
 * A third is about where the held rectangle has slid off far enough for the
 * basemap to be most of what is on screen; below that, one composite is worth
 * one hitch. The interval then bounds a flick, which can cross the threshold
 * several times in a second.
 */
export const PAN_MIN_COVER = 0.35
export const PAN_PUBLISH_MS = 800

/**
 * There is no "how much of the view must have imagery" threshold any more, and
 * its absence is the point.
 *
 * There used to be one (`REST_MIN_COVER`, 0.99), tested against the *union* of
 * the cached rectangles, because a composite cut to a rectangle it did not fill
 * left ground with no imagery on it and nothing else could tell. Computing that
 * union meant sorting the cache, ranking each patch by what it uniquely
 * contributed and cutting the survivors against each other on both axes: the
 * most expensive thing in this file per frame, and the top row of a pan profile.
 *
 * The fallback level makes the question vacuous. Every composite draws a
 * complete cover of its own rectangle before anything sharper goes on top, so
 * "does the composite reach this corner" is answered by comparing two
 * rectangles — `coversView` — and the union scan, the plan, the draw ranking and
 * the patch cache that fed them all go with it.
 */

/**
 * How wide the crossfade between two patches inside a composite is, as a
 * fraction of the smaller side of the patch being laid down.
 *
 * A fraction rather than a fixed count so it reads the same at every zoom, and
 * clamped at both ends in DetailImagery.feathered: below about four pixels a
 * ramp is a hard edge with extra steps, and above about sixty it starts eating
 * into ground the patch is there to show.
 */
export const FEATHER_FRACTION = 0.04

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
export interface ImagerySource {
  label: string
  endpoint: string
  layers: string
  /** WMS 1.1.1 takes bbox as lng,lat and calls it SRS; 1.3.0 takes lat,lng and calls it CRS. */
  version: '1.1.1' | '1.3.0'
  /** Native resolution in pixels per degree; 500 m ≈ 222, 10 m ≈ 11100. */
  pxPerDeg: number
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
  attribution?: string
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
 * Mip level of the patch whose blur matches the base map's own sharpness.
 *
 * Dividing the patch by this blurred copy isolates exactly the detail the base
 * map lacks; multiplying that back onto the base map's luminance transfers
 * Sentinel-2's structure while keeping NASA's palette.
 *
 * `imageWidthPx` is the width of the *texture handed to the shader*, not of the
 * imagery inside it. That distinction is the whole point: a mip index addresses
 * a texture's own grid, so a composite canvas drawn at three times its source's
 * density needs a level 1.6 higher to reach the same ground scale, however
 * little real detail it contains. Deriving it from the source's size instead
 * left the blurred tap sharper than the base map, and the patch then fought the
 * base map for a frequency band they both already had.
 *
 * The floor is 0, not 1. A patch no finer than the base map has nothing to
 * contribute, and at level 0 the two taps are the same sample, the ratio is
 * exactly 1, and the patch quietly becomes a no-op — which is the honest
 * answer. Forcing it to 1 instead handed the shader a blurred tap *coarser*
 * than the base map, and the difference between them was transferred twice.
 */
export const detailLod = (
  imageWidthPx: number,
  lngSpanDeg: number,
  basePxPerDeg = BASE_TEXTURE_PX_PER_DEG,
): number => {
  const ratio = imageWidthPx / Math.max(lngSpanDeg, 1e-6) / basePxPerDeg
  return clamp(Math.log2(Math.max(ratio, 1)), 0, 7)
}

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

/** How long the camera must hold still before the prefetch ring is worth spending. */
export const SETTLE_MS = 280

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
 * How long an arriving tile waits for its neighbours before the composite is
 * redrawn.
 *
 * The old pipeline saw one arrival per settled view, so compositing on each one
 * was compositing once. A view now wants tens of tiles and they land within
 * milliseconds of each other, and every composite is a full canvas upload plus
 * a full `generateMipmap` — 48 of them across one scripted pan and zoom against
 * the mock service, where the number of distinct pictures involved was six.
 *
 * One frame of delay collects a burst into one upload. It has to be a timer and
 * not "composite on the next update": the render loop parks when nothing is
 * moving, and it is the publish that wakes it.
 */
export const TILE_COALESCE_MS = 16


export interface DetailImageryOptions {
  maxPx?: number
  /** Where the Lanczos magnification runs; a worker by default. */
  resampler?: PatchResampler
  /** Bytes of decoded tiles to hold. See TILE_MEMORY_BUDGET. */
  tileBudget?: number
}

/** What the live camera wants: recomputed from scratch on every frame. */
interface Wanted {
  target: Bbox
  plan: TilePlan
}

/** A cached tile with its place on the composite canvas already worked out. */
interface Drawn {
  tile: Tile
  image: CanvasImageSource
  x: number
  y: number
  w: number
  h: number
}

/** Which of a tile's four edges are ramped out; see DetailImagery.feathered. */
interface Inset {
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
}

/** The fallback level's own joins: none of them, ever. See recomposite. */
const NO_INSET: Inset = { left: false, right: false, top: false, bottom: false }

/**
 * The edges of a tile that face ground its own level does not have.
 *
 * Only these are ramped, and that is the whole feathering rule now. An edge with
 * a sibling drawn beside it is a butt joint between two images of the same
 * resolution, aligned to the same grid — invisible, where a ramp would show as a
 * band of the coarser level bleeding up through the join. An edge with nothing
 * beside it is a step down a level, which is exactly what a crossfade is for.
 *
 * The neighbours are keyed without a source because the set they are tested
 * against is built the same way; one composite is one source (see
 * sourceForLevel), so the label carries no information here.
 */
const absentNeighbours = (t: Tile, present: Set<string>): Inset => ({
  left: !present.has(tileKey({ z: t.z, x: t.x - 1, y: t.y }, '')),
  right: !present.has(tileKey({ z: t.z, x: t.x + 1, y: t.y }, '')),
  top: !present.has(tileKey({ z: t.z, x: t.x, y: t.y - 1 }, '')),
  bottom: !present.has(tileKey({ z: t.z, x: t.x, y: t.y + 1 }, '')),
})

export class DetailImagery {
  texture?: Texture
  rect: [number, number, number, number] = [0, 0, 1, 1]
  mix = 0
  status: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle'
  sourceLabel = '—'
  attribution = ''
  /** Mip level at which the patch matches the base map's blur. */
  lod = 4
  /** Ground resolution of the imagery on screen, in metres per pixel. */
  groundRes = 0
  onReady?: () => void

  private maxPx: number
  /**
   * Bumped when everything in flight stops being relevant — the camera left the
   * streaming range, imagery was switched off, the component went away.
   *
   * It never marks a request as merely superseded, and that is deliberate. A
   * late tile is not wrong, only coarse or off to one side: it covers the ground
   * it covers and the composite draws it exactly where it belongs, or does not
   * draw it at all. Arrival order decides nothing; geometry does. (Before that
   * rule, a zoom threw away everything it fetched — 31 megapixels across a
   * fourteen-second zoom to put one patch on screen.)
   */
  private generation = 0
  private settle?: ReturnType<typeof setTimeout>
  /** …and the one that collects a burst of arrivals into one composite. */
  private due?: ReturnType<typeof setTimeout>
  private strikes = 0
  private sharpStrikes = 0
  private sharpDisabled = false
  private shown = false
  private disabled = false
  /** Provenance of the texture we hold, kept across a hide so it can be restored. */
  private heldLabel = ''
  private heldAttribution = ''
  /** Decoded tiles, bounded by bytes — see lib/tilePyramid.ts. */
  private tiles: TileCache<CanvasImageSource>
  private tileBudget: number
  /** Tile keys on the wire, and the ones their source has already refused. */
  private inflight = new Set<string>()
  private refused = new Set<string>()
  /** The wanted set the scheduler is spending on and the composite is drawing. */
  private want?: Wanted
  /** The rectangle the texture we currently hold covers. */
  private composited?: Bbox
  /**
   * …and whether it was drawn over a *complete* fallback level.
   *
   * This is what lets a rectangle comparison stand in for the union-coverage
   * scan that used to run every frame: a composite with every fallback tile
   * under it has imagery on every one of its pixels, so containing the view is
   * the same statement as covering it. Without that, it is not.
   */
  private solid = false
  /** The rectangle of the last composite; what `movedEnough` is measured against. */
  private current?: Bbox
  private canvas?: HTMLCanvasElement
  /** …and its context, held so a composite is not a fresh `getContext` call. */
  private ctx?: CanvasRenderingContext2D
  /** Lanczos upscales, keyed by the image they came from; dies with the tile. */
  private upscaled = new WeakMap<
    CanvasImageSource & object,
    { canvas: CanvasImageSource; w: number; h: number; crop: Crop }
  >()
  /** Tiles whose upscale is being computed elsewhere; one job each. */
  private upscaling = new Set<CanvasImageSource>()
  private resampler: PatchResampler
  /** What the last composite actually drew; an identical one is not redrawn. */
  private lastDraw = ''
  /** Pixel size of the image last handed to the shader; see publish(). */
  private published?: { w: number; h: number }
  /** When the shader was last handed pixels; see PAN_PUBLISH_MS. */
  private publishedAt = 0
  /** The view the camera is judged to have moved *from*, and when; see MOTION_EPS. */
  private restingAt?: Bbox
  private movedAt = 0
  /** When detail last became wanted; the deadline for the first picture. */
  private wantedAt = 0
  /** The screen the composite canvas is cut for; see compositeCanvasSize. */
  private viewport = { px: 900, aspect: 1 }
  /** Bumped when a Lanczos upscale lands, so the same plan is drawn again. */
  private upscaleEpoch = 0
  /** Attribution text by source label, so the panel can describe what is shown. */
  private attributions = new Map<string, string>()
  /** Reused scratch canvas for feathering a tile into the composite. */
  private scratch?: HTMLCanvasElement
  /** …and its context, on the same terms as the composite's. */
  private scratchCtx?: CanvasRenderingContext2D

  constructor(opts: DetailImageryOptions = {}) {
    this.maxPx = opts.maxPx ?? MAX_PATCH_PX
    this.tileBudget = opts.tileBudget ?? TILE_MEMORY_BUDGET
    this.tiles = new TileCache(this.tileBudget, (img) => this.forget(img))
    this.resampler = opts.resampler ?? createPatchResampler()
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
      this.wantedAt = 0
      if (this.shown) {
        this.shown = false
        this.mix = 0
        this.status = 'idle'
        this.sourceLabel = '—'
        this.onReady?.() // or the panel keeps describing a patch nobody can see
      }
      return
    }

    // Three numbers describe everything the pipeline does with this frame: the
    // ground in view, the pyramid level that matches the screen's density, and
    // the tiles that follow from the two. All pure, all in lib/tilePyramid.ts.
    const target = viewBbox(lat, lng, altitude, aspect, PATCH_MARGIN, fovDeg)
    const z = targetLevel(baseTexelsPerScreenPx(altitude, screenPx, fovDeg), Z_MAX)
    // the composite canvas is cut to the screen, not to the tiles
    this.viewport = { px: screenPx, aspect }
    this.want = { target, plan: tilePlan(target, z) }

    if (this.wantedAt === 0) this.wantedAt = Date.now()

    // Is the camera moving *at all*? Recorded before every early return below,
    // because the answer has to be about the camera and not about whether the
    // view has moved far enough to be worth anything.
    //
    // Measured from where the camera last counted as having moved, never from
    // the previous frame: a gesture is a displacement over a window of time, and
    // a per-frame comparison can only see a speed. Creeping east at a tenth of
    // the threshold per frame trips this every tenth frame — ten times inside
    // one settle — so the crawl is one gesture, publishes defer, and the ring
    // waits. See MOTION_EPS for what the per-frame form cost.
    if (viewMotion(this.restingAt, target) > MOTION_EPS) {
      this.movedAt = Date.now()
      this.restingAt = target
    }

    // Asking for a tile is idempotent — the cache and the in-flight set dedupe
    // by key — so there is no "has the view moved enough to be worth a request"
    // question left to get wrong, and no request to cancel when it moves again.
    // That whole class of bug (a strip of base map along an edge that no later
    // frame would ever fill, because nothing had moved *enough*) is gone with it.
    this.pin()
    this.pump()

    // The imagery we already hold may still cover the view — show it again
    // rather than redrawing the same pixels onto a texture that is re-uploaded
    // in full, mip chain and all, every time it is published.
    //
    // Against what is *on screen*, not against the padded rectangle we would
    // request. Both are grown by PATCH_MARGIN, so asking whether the held one
    // contains the wanted one is asking whether the camera has moved by exactly
    // zero — the test failed on a hair's drift and sent every frame of a slow
    // move down the expensive path. The margin exists to buy ground ahead of
    // the camera; spending it is what it is for. What the shader needs is
    // imagery under every screen pixel, which is this question, and the answer
    // now holds for an eighth of a span of travel instead of for nothing.
    const onScreen = viewBbox(lat, lng, altitude, aspect, 1, fovDeg)
    if (
      this.texture &&
      this.solid &&
      !movedEnough(this.current, target) &&
      coversView(this.composited, onScreen)
    ) {
      if (!this.shown || this.mix !== 1) {
        this.shown = true
        this.mix = 1
        this.status = 'ready'
        // the label belongs to the texture we are re-showing, not to whichever
        // source happens to be the fallback — hiding the patch cleared it
        this.sourceLabel = this.heldLabel || BASE_SOURCE.label
        this.attribution = this.heldAttribution
        this.onReady?.()
      }
      return
    }

    // Everything below this line runs *while the camera is moving*. So nothing
    // here publishes: see PAN_MIN_COVER for why a composite mid-gesture is a
    // hitch the user feels and imagery they do not.
    //
    // The one exception is a drag long enough to leave the held rectangle behind
    // altogether. That is a mid-drag settle without the expensive half: redraw
    // what we hold onto the view that has outrun it, but no Lanczos — the
    // sharpening pass is what waits for rest.
    if (
      // nothing published yet is not a stale view, it is a cold start: the first
      // picture belongs to the settle path like any other
      this.composited &&
      !coversView(this.composited, target) &&
      viewCoverage(this.composited, target) < PAN_MIN_COVER &&
      Date.now() - this.publishedAt >= PAN_PUBLISH_MS
    ) {
      this.recomposite()
    }
    clearTimeout(this.settle)
    this.arm()
  }

  /**
   * Is the camera at rest?
   *
   * `this.settle === undefined` looks like it answers this and does not: the
   * timer is only armed once the fast path above has missed, so through the
   * first frames of a drag it reads "still" while the camera is plainly moving.
   * `movedAt` is written on every frame the view changes at all, ahead of every
   * early return, so it has no such hole.
   */
  private get still(): boolean {
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
   * 907 requests for 140 distinct tiles across one scripted pan and zoom, the
   * exact opposite of what a fixed grid is for.
   *
   * Pinning is also the cache's only notion of recency (see TileCache), so this
   * doubles as "these are the tiles in use now".
   */
  private pin() {
    const w = this.want
    if (!w) return
    const label = sourceForLevel(w.plan.z, this.sharpDisabled).label
    const keys = new Set<string>()
    for (const t of w.plan.fallback) keys.add(tileKey(t, label))
    for (const t of [...w.plan.level, ...w.plan.ring]) {
      keys.add(tileKey(t, label))
      keys.add(tileKey(parentOf(t), label))
    }
    this.tiles.pin(keys)
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
    const src = sourceForLevel(w.plan.z, this.sharpDisabled)
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
   * The URL is now canonical — the same ground at the same level is the same
   * string forever — so the browser's HTTP cache and the service's both start
   * hitting, which an arbitrary bbox per view never allowed.
   */
  private request(tile: Tile, key: string, src: ImagerySource) {
    const gen = this.generation
    this.inflight.add(key)
    // Only while there is nothing to look at. The prefetch ring goes out *after*
    // a composite is published and would otherwise leave the panel reading
    // "loading" over a picture that is finished.
    if (!this.shown) this.status = 'loading'
    const img = new Image()
    img.crossOrigin = 'anonymous'
    const arrived = (image: CanvasImageSource) => {
      this.inflight.delete(key)
      this.adopt(key, image, src, gen)
    }
    img.onload = () => {
      // Decoding to an ImageBitmap moves the pixel work off the main thread and
      // gives eviction something it can free on demand rather than when the
      // collector feels like it. A platform without it keeps the element the
      // loader already decoded, which draws identically and only costs a
      // re-decode per composite — the behaviour this file always had.
      if (typeof createImageBitmap === 'function') {
        createImageBitmap(img).then(arrived, () => arrived(img))
      } else arrived(img)
    }
    img.onerror = () => {
      this.inflight.delete(key)
      this.refuse(key, src)
    }
    img.src = wmsUrl(src, bboxOf(tile), TILE_PX, TILE_PX)
  }

  /**
   * One failure is a bad response; two from the same source is the source.
   *
   * Counted per source rather than per tile, because that is the failure worth
   * reacting to. The tile is remembered as refused so the scheduler cannot loop
   * on it, and demoting the sharp source changes every key it would ask for
   * next, so the retry is the whole view at once rather than one tile at a time.
   */
  private refuse(key: string, src: ImagerySource) {
    this.refused.add(key)
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
   * see `generation`. What it does *not* do is reach the screen while the camera
   * is moving: a publish is a full texture upload plus a full `generateMipmap`
   * (111 ms measured at a desktop composite size), bought to show one frame of a
   * picture the next frame replaces. Measured before this rule, a zoom spent
   * seven to fourteen of them across three seconds.
   *
   * Nothing is lost by waiting: the tile is in the cache, the settle's own
   * recomposite reads the cache, and the settle always comes — `arm` is
   * re-armed by motion and converges the moment the camera stops. But an arrival
   * can also land *after* the last settle has fired, so it arms one if there is
   * none, which costs nothing when a settle is already due.
   */
  private adopt(key: string, image: CanvasImageSource, src: ImagerySource, gen: number) {
    this.tiles.set(key, image)
    this.attributions.set(src.label, src.attribution ?? '')
    this.strikes = 0
    if (gen !== this.generation) return
    this.pump() // a slot came free
    if (!this.still) {
      if (this.settle === undefined) this.arm()
      return
    }
    if (this.due !== undefined) return
    this.due = setTimeout(() => {
      this.due = undefined
      this.recomposite(true)
    }, TILE_COALESCE_MS)
  }

  /**
   * Arm the settle timer, and keep re-arming it until the camera is actually
   * still.
   *
   * `SETTLE_MS` after the last significant move is not the same thing as a still
   * camera, and the difference was the whole of the pan problem: an ordinary
   * drag tripped the old re-arm about every 300 ms, and 300 is more than 280, so
   * the timer elapsed *between the trips of a continuous gesture* and ran the
   * rest pipeline — composite, publish, upload, mip chain, Lanczos — eight times
   * across one 2.5 s pan.
   *
   * So the timer asks a second question when it fires: has the view been
   * genuinely motionless for `SETTLE_MS`? `movedAt` is written on every frame
   * the view moves at all, so this converges the moment the camera does.
   */
  private arm() {
    const now = Date.now()
    const left = SETTLE_MS - (now - this.movedAt)
    // A camera that never stops still has to get a *first* picture. Auto-rotate
    // is what makes this reachable: the view drifts by more than MOTION_EPS
    // every frame forever, so the wait for stillness would never end — and with
    // nothing ever published there is no rectangle for the escape hatch to find
    // having slid away either, so the deferral would be permanent. So until
    // something is on the GPU the wait is one SETTLE_MS of wall clock rather
    // than of stillness; after that the hatch bounds staleness at PAN_PUBLISH_MS.
    const overdue = this.publishedAt === 0 && now - this.wantedAt >= SETTLE_MS
    if (left > 0 && !overdue) {
      this.settle = setTimeout(() => this.arm(), left)
      return
    }
    this.settle = undefined
    if (!this.want) return
    // The camera has stopped. Now — and only now — is the prefetch ring worth
    // bandwidth, and what we hold worth magnifying properly: during the move the
    // next frame would have replaced the result anyway.
    this.pump()
    this.recomposite(true)
  }

  /** A canvas, or undefined where there is no DOM (tests, SSR). */
  private surface(width: number, height: number) {
    if (typeof document === 'undefined') return undefined
    const c = this.canvas ?? document.createElement('canvas')
    this.canvas = c
    // Only when it really changed. Assigning `width`/`height` at all reallocates
    // the backing store and resets every piece of context state, *including*
    // when the value assigned is the one already there — the spec says so, and
    // the profiler agreed: across one scripted pan this line and the
    // `getContext` after it were seconds of main thread, for a canvas whose size
    // is deliberately fixed for the session (see compositeCanvasSize). The
    // composite clears the canvas itself, so nothing here relied on the reset.
    if (c.width !== width || c.height !== height) {
      c.width = width
      c.height = height
      this.ctx = undefined // the reset drops the smoothing flag set below
    }
    const ctx = this.ctx ?? c.getContext('2d') ?? undefined
    this.ctx = ctx
    if (ctx) {
      // Bilinear, explicitly. Skia's default for a magnifying drawImage is a
      // high-quality resample, and the composite magnifies whenever a fallback
      // tile is drawn at its children's scale — which is every composite. That
      // one flag is the difference between a composite costing tens of
      // milliseconds and costing seconds. Nothing is lost: this draw is the
      // deliberately cheap one, and the sharp version arrives from the Lanczos
      // resampler already at its final size.
      ctx.imageSmoothingQuality = 'low'
    }
    return ctx ? { canvas: c, ctx } : undefined
  }

  /**
   * Natural pixel size of a cached image, or undefined where it cannot be read.
   *
   * Deliberately tolerant: the cache holds whatever `CanvasImageSource` the
   * platform gave us, and a stub in a test has none of these properties.
   */
  private static naturalSize(img: CanvasImageSource): { w: number; h: number } | undefined {
    const src = img as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
    const w = src.naturalWidth ?? (typeof src.width === 'number' ? src.width : 0)
    const h = src.naturalHeight ?? (typeof src.height === 'number' ? src.height : 0)
    return w > 0 && h > 0 ? { w, h } : undefined
  }

  /**
   * Draw one tile, resampling it properly where it has to be magnified.
   *
   * `drawImage` scaling up is a tent filter, and so is the GPU's magnification
   * of whatever texture we hand it. Lanczos-3 (see lib/lanczos.ts) reconstructs
   * with a windowed sinc instead, which keeps edges where they were. In the
   * pyramid the magnifying case is exactly one: the fallback level, drawn at its
   * children's scale — and the terminal tiles past Z_MAX, drawn at whatever the
   * camera asks. It costs CPU, so it is spent only where it shows:
   *
   *  - only above RESAMPLE_MIN_SCALE, because below about a quarter again the
   *    two filters are indistinguishable
   *  - only on the part of the tile that lands on the canvas
   *  - once per (tile, size), cached on the tile, because a drag recomposites
   *    repeatedly against the same imagery
   *  - and *never in this call*: the filter runs elsewhere (see
   *    lib/patchResample.ts) and this draw takes the bilinear stretch until it
   *    lands, so a composite costs a blit whether or not it is sharp yet
   */
  private drawTile(
    ctx: CanvasRenderingContext2D,
    d: Drawn,
    canvasW: number,
    canvasH: number,
    inset: Inset,
    sharpen: boolean,
  ) {
    const { x, y, w, h } = d
    const up = this.magnified(d.image, x, y, w, h, canvasW, canvasH, sharpen)
    const draw = (c: CanvasRenderingContext2D, dx: number, dy: number) => {
      if (up) c.drawImage(up.canvas, up.x + dx, up.y + dy, up.w, up.h)
      else c.drawImage(d.image, x + dx, y + dy, w, h)
    }
    const soft = this.feathered(x, y, w, h, canvasW, canvasH, inset, draw)
    if (soft) ctx.drawImage(soft.canvas, soft.x, soft.y)
    else draw(ctx, 0, 0)
  }

  /**
   * A tile with the named edges ramped out, ready to be laid over whatever is
   * already on the canvas.
   *
   * Ramping the alpha out over the last few pixels makes a join a crossfade
   * between two resolutions instead of a hard rectangular line between them.
   * Which edges deserve it is the caller's question (see absentNeighbours); this
   * only refuses the ones that fall on the canvas boundary, because an edge
   * lying there is the composite's own outer edge and the shader already
   * feathers that against the base map. Ramping it twice would pull the imagery
   * back from the edge of the rectangle it is supposed to fill.
   */
  private feathered(
    x: number,
    y: number,
    w: number,
    h: number,
    canvasW: number,
    canvasH: number,
    inset: Inset,
    draw: (c: CanvasRenderingContext2D, dx: number, dy: number) => void,
  ): { canvas: HTMLCanvasElement; x: number; y: number } | undefined {
    if (typeof document === 'undefined') return undefined
    const edge = {
      left: inset.left && x > 0.5,
      right: inset.right && x + w < canvasW - 0.5,
      top: inset.top && y > 0.5,
      bottom: inset.bottom && y + h < canvasH - 0.5,
    }
    if (!edge.left && !edge.right && !edge.top && !edge.bottom) return undefined
    // the part of the tile that lands on the canvas, in canvas pixels
    const vx = Math.max(0, Math.floor(x))
    const vy = Math.max(0, Math.floor(y))
    const vw = Math.ceil(Math.min(canvasW, x + w)) - vx
    const vh = Math.ceil(Math.min(canvasH, y + h)) - vy
    if (vw < 4 || vh < 4) return undefined
    const band = Math.round(clamp(Math.min(vw, vh) * FEATHER_FRACTION, 4, 64))

    const scratch = this.scratch ?? document.createElement('canvas')
    this.scratch = scratch
    // Sized only when the size changed, for the reason `surface` is: this runs
    // once per feathered tile per composite, and each assignment is a fresh
    // backing store. The `clearRect` below is what this function actually
    // relied on.
    if (scratch.width !== vw || scratch.height !== vh) {
      scratch.width = vw
      scratch.height = vh
      this.scratchCtx = undefined
    }
    const sc = this.scratchCtx ?? scratch.getContext('2d') ?? undefined
    this.scratchCtx = sc
    // a stub canvas in a test has no gradients; the butt joint is still correct
    if (!sc?.createLinearGradient) return undefined
    sc.clearRect(0, 0, vw, vh)
    draw(sc, -vx, -vy)
    // `destination-out`, not `destination-in`: it subtracts alpha only where it
    // paints, so one band per edge composes without a full-canvas pass and
    // without touching the middle. (`destination-in` is global — every pixel the
    // source does not cover is erased — so four band-shaped passes of it leave
    // four thin bands and nothing else, which is what it did.)
    sc.globalCompositeOperation = 'destination-out'
    const ramp = (x0: number, y0: number, x1: number, y1: number) => {
      const g = sc.createLinearGradient(x0, y0, x1, y1)
      g.addColorStop(0, 'rgba(0,0,0,1)') // full erase at the edge...
      g.addColorStop(1, 'rgba(0,0,0,0)') // ...fading to none by the band's end
      sc.fillStyle = g
      sc.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0) || vw, Math.abs(y1 - y0) || vh)
    }
    if (edge.left) ramp(0, 0, band, 0)
    if (edge.right) ramp(vw, 0, vw - band, 0)
    if (edge.top) ramp(0, 0, 0, band)
    if (edge.bottom) ramp(0, vh, 0, vh - band)
    sc.globalCompositeOperation = 'source-over'
    return { canvas: scratch, x: vx, y: vy }
  }

  /** The visible part of a tile, Lanczos-resampled, or undefined if not worth it. */
  private magnified(
    image: CanvasImageSource,
    x: number,
    y: number,
    w: number,
    h: number,
    canvasW: number,
    canvasH: number,
    sharpen: boolean,
  ): { canvas: CanvasImageSource; x: number; y: number; w: number; h: number } | undefined {
    const nat = DetailImagery.naturalSize(image)
    if (!nat || w < 1 || h < 1) return undefined
    if (Math.max(w / nat.w, h / nat.h) < RESAMPLE_MIN_SCALE) return undefined

    // the part of the tile that lands on the canvas, in canvas pixels...
    const vx = Math.max(0, x)
    const vy = Math.max(0, y)
    const vw = Math.round(Math.min(canvasW, x + w) - vx)
    const vh = Math.round(Math.min(canvasH, y + h) - vy)
    if (vw < 2 || vh < 2) return undefined
    if (vw * vh > RESAMPLE_MAX_PX) return undefined

    // ...and the source rectangle it came from, in image pixels
    const crop = {
      x: ((vx - x) / w) * nat.w,
      y: ((vy - y) / h) * nat.h,
      w: (vw / w) * nat.w,
      h: (vh / h) * nat.h,
    }

    // Reuse only what was computed for exactly this geometry — see upscaleFits.
    const held = this.upscaled.get(image)
    if (upscaleFits(held, { crop, w: vw, h: vh })) {
      return { canvas: held.canvas, x: vx, y: vy, w: vw, h: vh }
    }

    if (sharpen) this.requestUpscale(image, crop, vw, vh)
    return undefined // bilinear stands in until the sharp version arrives
  }

  /**
   * Ask for a magnified copy, and redraw once it exists.
   *
   * One job per tile at a time: during a zoom the wanted size changes every
   * frame, and queueing a resample per frame would move the stall rather than
   * remove it. The job in flight finishes, the redraw it triggers asks for the
   * size wanted *then*, and the sequence converges as soon as the camera stops.
   */
  private requestUpscale(image: CanvasImageSource, crop: Crop, dw: number, dh: number) {
    if (this.upscaling.has(image)) return
    this.upscaling.add(image)
    this.resampler
      .run(image, crop, dw, dh)
      .then((canvas) => {
        this.upscaling.delete(image)
        if (!canvas) return
        this.release(this.upscaled.get(image)?.canvas)
        this.upscaled.set(image, { canvas, w: dw, h: dh, crop })
        this.upscaleEpoch++ // the same tiles now draw different pixels
        // Redraw only if the camera is still. A resample that lands mid-drag is
        // pure polish — the picture is already on screen and correct — so
        // publishing it there would spend a full upload and mip rebuild on a
        // frame the gesture is about to replace. Nothing is lost by waiting: the
        // copy is cached against the tile and `upscaleEpoch` is already bumped,
        // so the settle's own redraw picks it up.
        if (this.still) this.recomposite(true)
      })
      .catch(() => this.upscaling.delete(image))
  }

  /** An ImageBitmap holds real memory until closed; a canvas needs nothing. */
  private release(canvas?: CanvasImageSource) {
    if (typeof ImageBitmap !== 'undefined' && canvas instanceof ImageBitmap) canvas.close()
  }

  /**
   * A tile leaving the cache takes its sharpened copy with it.
   *
   * The copies hang off a WeakMap keyed by the tile's image, so dropping the
   * tile does make them collectable — but an ImageBitmap holds memory the
   * collector does not account for, and "collectable" is not "closed". A
   * megapixel-scale bitmap per evicted tile, released whenever the GC feels like
   * it, is exactly the kind of drift that shows up as a device out of texture
   * memory an hour into a session and never in a profile.
   */
  private forget(image: CanvasImageSource) {
    this.release(this.upscaled.get(image)?.canvas)
    this.upscaled.delete(image)
    this.upscaling.delete(image)
    this.release(image)
  }

  /**
   * Draw the wanted tiles onto one canvas cut to the view and hand that to the
   * shader. The shader contract does not change: one texture, one rectangle.
   *
   * Two levels, in this order and no other. The fallback level goes down first
   * and covers the whole rectangle, so there is never bare base map inside the
   * composite; the target level goes on top wherever it has arrived. That is the
   * Maps trade — coarse but present beats sharp but absent — and it is what
   * killed the union-coverage scan, the draw ranking and the patch cache that
   * used to decide which of a handful of overlapping arbitrary rectangles was
   * worth drawing over which.
   */
  private recomposite(sharpen = false): boolean {
    const w = this.want
    if (!w) return false
    const label = sourceForLevel(w.plan.z, this.sharpDisabled).label
    // The screen and the device ceiling decide this, and nothing that moves with
    // the camera. One size means one GL allocation for the session and no
    // resolution that can pump up and down as the camera starts and stops — see
    // the note above compositeCanvasSize.
    const { width, height } = compositeCanvasSize(this.viewport.px, this.viewport.aspect, this.maxPx)
    const place = (tile: Tile): Drawn | undefined => {
      const image = this.tiles.get(tileKey(tile, label))
      return image && { tile, image, ...placeOnCanvas(w.target, bboxOf(tile), width, height) }
    }
    const under = w.plan.fallback.map(place).filter((d): d is Drawn => !!d)
    const over = w.plan.level.map(place).filter((d): d is Drawn => !!d)
    if (!under.length && !over.length) return false

    // Redrawing the same tiles, at the same size, onto the same rectangle
    // produces the same canvas — and publishing it re-uploads every one of its
    // pixels to the GPU and rebuilds the whole mip chain. update() runs on every
    // frame the view moves, so this is the difference between one upload per
    // distinct picture and one per frame.
    const key = [
      width,
      height,
      // the sharpening pass draws the same tiles at the same size and is still
      // not the same picture — it is the pass that asks for the Lanczos copies
      sharpen ? 'sharp' : 'fast',
      this.upscaleEpoch,
      w.target.minLat.toFixed(5),
      w.target.minLng.toFixed(5),
      w.target.maxLat.toFixed(5),
      w.target.maxLng.toFixed(5),
      ...under.map((d) => tileKey(d.tile, label)),
      '/',
      ...over.map((d) => tileKey(d.tile, label)),
    ].join('|')
    if (key === this.lastDraw && this.texture) return true
    this.lastDraw = key

    const surf = this.surface(width, height)
    if (!surf) return false
    surf.ctx.clearRect(0, 0, width, height)

    const present = new Set(over.map((d) => tileKey(d.tile, '')))
    for (const d of under) {
      // Sharpening a fallback tile that its four children already hide is a
      // megapixel of Lanczos nobody can see.
      const hidden = childrenOf(d.tile).every((c) => present.has(tileKey(c, '')))
      this.drawTile(surf.ctx, d, width, height, NO_INSET, sharpen && !hidden)
    }
    for (const d of over) {
      this.drawTile(surf.ctx, d, width, height, absentNeighbours(d.tile, present), sharpen)
    }

    // the panel describes what is on screen, which is the finest level the
    // composite actually drew — not whichever request happened to return last
    const z = over.length ? w.plan.z : w.plan.z - 1
    this.sourceLabel = this.heldLabel = label
    this.attribution = this.heldAttribution = this.attributions.get(label) ?? ''
    // a complete fallback is what lets `coversView` stand in for a coverage scan
    this.solid = under.length === w.plan.fallback.length
    this.current = w.target
    this.publish(surf.canvas, w.target, (tileSpanDeg(z) * 111_320) / TILE_PX)
    return true
  }

  private cancelQueued() {
    clearTimeout(this.settle)
    clearTimeout(this.due)
    this.settle = this.due = undefined
    // …and the wanted set with it, so nothing can be pumped for a view that is
    // no longer on screen
    this.want = undefined
    if (!this.inflight.size) return
    // in-flight tiles still land in the cache — they are as true as ever — but
    // they resolve into a dead generation and reach no screen
    this.generation++
  }

  /** The one place a texture reaches the shader. */
  private publish(source: CanvasImageSource, bbox: Bbox, groundRes: number) {
    const size = DetailImagery.naturalSize(source)
    // The composite canvas is reused between draws, so most publishes hand the
    // shader the same image object again. Re-flagging that texture re-uploads
    // the pixels without reallocating the GL texture or re-deriving its
    // parameters, which a fresh Texture per composite made the driver do on
    // every frame of a zoom.
    //
    // But only while the pixels are the same shape. three allocates immutable
    // storage with texStorage2D on a texture's *first* upload and never again,
    // so re-flagging a texture whose canvas has since been resized uploads the
    // new image into the old allocation with texSubImage2D — which, when the new
    // canvas is smaller, silently lands it in the top-left corner and leaves the
    // rest of the texture holding the previous composite. No GL error is raised.
    // The shader then stretches that mixture across the current rectangle, and
    // since the previous composite had the one before it in *its* corner, the
    // result is a small image over a larger copy over a larger copy: exactly the
    // nesting reported from the field. Measured on a continuous zoom, 27 of 28
    // composite uploads went into storage cut for a different size.
    const previous = this.texture
    const sameShape =
      !!size && !!this.published && this.published.w === size.w && this.published.h === size.h
    if (previous && previous.image === source && sameShape) {
      previous.needsUpdate = true
    } else {
      const next = new Texture(source as HTMLImageElement)
      next.colorSpace = SRGBColorSpace
      // mipmaps are needed: the shader samples a deliberately blurred copy of
      // the patch to separate its fine detail from its overall colour
      next.minFilter = LinearMipmapLinearFilter
      next.magFilter = LinearFilter
      next.generateMipmaps = true
      next.needsUpdate = true
      this.texture = next
      previous?.dispose()
    }
    this.published = size
    this.publishedAt = Date.now()
    // Content, rectangle and mip level move together, in this order, in one
    // call: whatever the shader is handed, the rectangle it is stretched across
    // and the level that matches the base map all describe the same pixels.
    this.rect = bboxToUvRect(bbox)
    this.composited = bbox
    // Derived here, from the image the shader is about to be handed, because
    // that is the only size the mip chain it will sample is built from. See
    // detailLod.
    this.lod = detailLod(size?.w ?? 1, bbox.maxLng - bbox.minLng)
    this.groundRes = groundRes
    this.mix = 1
    this.shown = true
    this.status = 'ready'
    this.onReady?.()
  }

  dispose() {
    this.cancelQueued()
    this.tiles.clear()
    this.resampler.dispose()
    this.texture?.dispose()
  }
}
