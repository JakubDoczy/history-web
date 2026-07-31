import { LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture } from 'three'
import { compositePlan, placeOnCanvas, pruneCache, type CachedPatch } from './patchCache'
import {
  createPatchResampler,
  upscaleFits,
  type Crop,
  type PatchResampler,
} from './patchResample'

/**
 * High-resolution imagery for the region being looked at, fetched from NASA GIBS
 * as a single WMS image.
 *
 * An earlier version stitched WMTS tiles, which meant reimplementing the tile
 * grid: level selection, row/column indexing, edge clamping, canvas stitching
 * and partial-failure handling. Every one of those was a chance to place the
 * imagery somewhere it did not belong. WMS takes an explicit bounding box, so
 * the image we receive covers exactly the rectangle we asked for — the
 * placement cannot drift, because there is no index arithmetic left to get
 * wrong.
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
 * Pixel size for a bbox.
 *
 * `screenPx` must be in *device* pixels: the globe renders at the device pixel
 * ratio, so sizing against CSS pixels under-requests by 2–3× on a phone and the
 * result is soft however good the source is. Capped by the source's own
 * resolution — asking a 500 m map for more than 222 px per degree returns
 * upsampled blur, slowly — and by a hard ceiling.
 *
 * The ceiling used to be 1536, which was the real reason patches looked soft:
 * a 1440-tall window at devicePixelRatio 2 asks for 2880 device pixels down the
 * screen, and the patch came back at just over half that however close the
 * camera was and however fine the source. The two caps that are *principled* —
 * the screen's own density and the source's native resolution — are the ones
 * that should bite.
 *
 * Both axes are scaled together when the ceiling bites, so degrees-per-pixel
 * stays the same across the image; letting width clamp on its own would stretch
 * the sampling on one axis only.
 */
export function imageSize(
  b: Bbox,
  screenPx: number,
  maxPx = MAX_PATCH_PX,
  pxPerDeg = BASE_SOURCE.pxPerDeg,
): { width: number; height: number } {
  const lngSpan = Math.max(b.maxLng - b.minLng, 1e-6)
  const latSpan = Math.max(b.maxLat - b.minLat, 1e-6)
  // The bbox spans PATCH_MARGIN times the frame in latitude, and `screenPx` is
  // the frame's height in device pixels — so this is exactly the screen's own
  // pixel density, never less, until the source or the ceiling says otherwise.
  // The margin has to be the same one viewBbox used, or the two silently
  // disagree and the request comes back short.
  const heightWanted = Math.min(screenPx * PATCH_MARGIN, latSpan * pxPerDeg)
  let height = Math.max(heightWanted, 192)
  let width = Math.max((height * lngSpan) / latSpan, 192)
  const over = Math.max(width, height) / maxPx
  if (over > 1) {
    height /= over
    width /= over
  }
  return { width: clamp(Math.round(width), 64, maxPx), height: clamp(Math.round(height), 64, maxPx) }
}


/**
 * Pixels per degree of latitude a request will actually deliver — the number to
 * compare against the screen's own density when asking whether a patch is as
 * sharp as the zoom warrants.
 */
export const requestedPxPerDeg = (b: Bbox, size: { height: number }) =>
  size.height / Math.max(b.maxLat - b.minLat, 1e-9)

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
 * Shrink a rectangle about its centre until neither span exceeds `maxSpanDeg`.
 *
 * Wide views are now inside the streaming range, and a source has a span past
 * which asking it for one image is unreasonable however much of the frame that
 * leaves uncovered — a 10 m mosaic rendered across 40 degrees is gigapixels of
 * work for a server to throw away. Covering the middle of the frame sharply
 * beats covering none of it: the shader feathers the patch edge and keeps the
 * base map's colour, so a partial patch reads as the centre being in focus.
 */
export function clampBboxSpan(b: Bbox, maxSpanDeg: number): Bbox {
  const latSpan = b.maxLat - b.minLat
  const lngSpan = b.maxLng - b.minLng
  const over = Math.max(latSpan, lngSpan) / Math.max(maxSpanDeg, 1e-6)
  if (over <= 1) return b
  const lat = (b.minLat + b.maxLat) / 2
  const lng = (b.minLng + b.maxLng) / 2
  const halfLat = latSpan / over / 2
  const halfLng = lngSpan / over / 2
  return {
    minLat: clamp(lat - halfLat, -90, 90),
    maxLat: clamp(lat + halfLat, -90, 90),
    minLng: clamp(lng - halfLng, -180, 180),
    maxLng: clamp(lng + halfLng, -180, 180),
  }
}

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
 * The pixel budget for a request, expressed the way imageSize wants it.
 *
 * Sizing against "the frame's height in device pixels" is right close in and
 * wrong at wide zoom, for two reasons that pull the same way. A clamped box
 * covers only part of the screen, so it needs proportionally fewer pixels; and
 * the frame's *average* density is far below its centre's, because ground near
 * the limb is foreshortened to nothing. Sizing on the average at a 110 degree
 * frame asked for 10 px per degree where the middle of the screen resolves 14 —
 * a request that arrived coarser than the base map it was replacing.
 *
 * So the budget is the centre's own density, applied across whatever box is
 * actually being requested. Close in the two definitions coincide exactly,
 * which is why nothing about the near range changes.
 */
export const requestScreenPx = (
  request: Bbox,
  altitude: number,
  screenPx: number,
  fovDeg = DEFAULT_FOV,
): number =>
  (request.maxLat - request.minLat) / degPerScreenPx(altitude, screenPx, fovDeg) / PATCH_MARGIN

/** How long the camera must hold still before a request is worth spending. */
export const SETTLE_MS = 280

export interface DetailImageryOptions {
  maxPx?: number
  /** Where the Lanczos magnification runs; a worker by default. */
  resampler?: PatchResampler
}

/**
 * Metrics that only become true when the image they describe is on screen.
 *
 * The mip level used to live here too, computed from the request's own width
 * and carried along until something published it. It belongs to the *texture*,
 * not to the request, so it is derived in `publish` instead — the one place
 * that knows which image the shader is about to be handed.
 */
interface PatchMeta {
  groundRes: number
  /** Effective resolution, used to order the cache's draw stack. */
  pxPerDeg: number
}

export class DetailImagery {
  texture?: Texture
  rect: [number, number, number, number] = [0, 0, 1, 1]
  mix = 0
  status: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle'
  sourceLabel = '—'
  attribution = ''
  /** Mip level at which the patch matches the base map's blur. */
  lod = 4
  /** Ground resolution of the loaded patch, in metres per pixel. */
  groundRes = 0
  onReady?: () => void

  private maxPx: number
  private current?: Bbox
  /** The rectangle a queued or in-flight request is for; distinct from `current`. */
  private pending?: Bbox
  /**
   * Bumped when everything in flight stops being relevant — the camera left the
   * streaming range, imagery was switched off, the component went away.
   *
   * It used to be bumped by every *new* request as well, so an image was
   * discarded the moment a later one had been asked for. With a real network
   * that meant a zoom threw away everything it fetched: each wheel notch issued
   * a request, and each request was superseded by the next one 700 ms later
   * while the first was still 1–2 s from arriving. Measured against the mocked
   * services, a fourteen-second zoom fetched 31 megapixels of imagery and put
   * exactly one patch on screen — the rest was bandwidth spent to be deleted,
   * and the user watched a soft base map the whole way in.
   *
   * A late patch is not wrong, only partial: it covers the ground it covers,
   * and the composite draws it exactly where it belongs under anything sharper.
   * So arrival order no longer decides anything; geometry does.
   */
  private generation = 0
  private settle?: ReturnType<typeof setTimeout>
  private strikes = 0
  private sharpStrikes = 0
  private sharpDisabled = false
  private shown = false
  private disabled = false
  /** Provenance of the texture we hold, kept across a hide so it can be restored. */
  private heldLabel = ''
  private heldAttribution = ''
  /** The last few patches that arrived, newest first — see lib/patchCache.ts. */
  private cache: CachedPatch<CanvasImageSource>[] = []
  /** The rectangle the texture we currently hold covers, composite or not. */
  private composited?: Bbox
  private canvas?: HTMLCanvasElement
  /** Lanczos upscales, keyed by the image they came from; dies with the patch. */
  private upscaled = new WeakMap<
    CanvasImageSource & object,
    { canvas: CanvasImageSource; w: number; h: number; crop: Crop }
  >()
  /** Patches whose upscale is being computed elsewhere; one job each. */
  private upscaling = new Set<CanvasImageSource>()
  private resampler: PatchResampler
  /** What the last composite was cut to, so a late upscale can redraw it. */
  private lastComposite?: { target: Bbox; screenPx: number }
  /** What the last composite actually drew; an identical one is not redrawn. */
  private lastDraw = ''
  /** Pixel size of the image last handed to the shader; see publish(). */
  private published?: { w: number; h: number }
  /** The screen the composite canvas is cut for; see compositeCanvasSize. */
  private viewport = { px: 900, aspect: 1 }
  /** Bumped when a Lanczos upscale lands, so the same plan is drawn again. */
  private upscaleEpoch = 0
  /** Attribution text by source label, so the panel can describe what is shown. */
  private attributions = new Map<string, string>()

  constructor(opts: DetailImageryOptions = {}) {
    this.maxPx = opts.maxPx ?? MAX_PATCH_PX
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
      // a queued request must not land after we have zoomed back out, or it
      // adopts — and shows — a patch for a view nobody is looking at any more
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

    // The rectangle is chosen in three steps that used to be one: what the
    // frame covers, which source can serve a box that size, and how much of
    // that box that source will render in one go.
    const frame = viewBbox(lat, lng, altitude, aspect, PATCH_MARGIN, fovDeg)
    const frameSpan = Math.max(frame.maxLat - frame.minLat, frame.maxLng - frame.minLng)
    const src = pickSource(frameSpan, this.sharpDisabled)
    const bbox = clampBboxSpan(frame, src.maxSpanDeg)
    // a clamped box covers less of the screen, so it needs proportionally fewer
    // pixels to match the screen's density — see requestScreenPx
    const requestPx = requestScreenPx(bbox, altitude, screenPx, fovDeg)
    // the composite canvas is cut to the screen, not to the request
    this.viewport = { px: screenPx, aspect }
    // Remembered before any of the early returns below, because a patch can
    // arrive at any moment and it must be cut to the view the camera is looking
    // at *now*. Taking it from the last rectangle that happened to be
    // recomposited meant an arrival during the fast path below was drawn onto a
    // view several zoom steps old: geographically correct, but a patch — and a
    // feathered edge — smaller than the frame, appearing to shrink while the
    // camera stood still.
    this.lastComposite = { target: bbox, screenPx: requestPx }

    // the imagery we already hold may still cover the view — show it again
    // rather than paying for the same request twice
    if (this.texture && !movedEnough(this.current, bbox)) {
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

    // Wait for the camera to settle before spending a request — but only re-arm
    // the timer when the target has actually moved. update() runs once per
    // animation frame; clearing the timer unconditionally reset it every ~16 ms,
    // so the 280 ms never elapsed and no patch was ever fetched at all.
    if (this.pending && !movedEnough(this.pending, bbox)) return
    this.pending = bbox
    // Redraw what we already own onto the new view *now*, before the settle
    // timer has even started. The centre of the screen usually has not moved,
    // so it stays exactly as sharp as it was and only the newly exposed edge
    // falls back to the basemap. Costs one canvas blit and no request, so the
    // settle and hysteresis rules below are untouched.
    this.recomposite(bbox, requestPx)
    clearTimeout(this.settle)
    this.settle = setTimeout(() => {
      this.settle = undefined
      // The camera has stopped. Now — and only now — is it worth magnifying
      // what we hold properly: during the move the next frame would have
      // replaced the result anyway, and each resample costs a full-resolution
      // copy of the patch to hand to the worker.
      this.recomposite(bbox, requestPx, true)
      this.load(bbox, requestPx, src)
    }, SETTLE_MS)
  }

  /** A canvas, or undefined where there is no DOM (tests, SSR). */
  private surface(width: number, height: number) {
    if (typeof document === 'undefined') return undefined
    const c = this.canvas ?? document.createElement('canvas')
    this.canvas = c
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')
    if (ctx) {
      // Bilinear, explicitly. Skia's default for a magnifying drawImage is a
      // high-quality resample, and the composite magnifies whenever the canvas
      // is cut to the screen and the imagery in it is coarser than that — which
      // is most of the zoom range. Measured, that one flag is the difference
      // between a composite costing tens of milliseconds and costing seconds.
      // Nothing is lost: this draw is the deliberately cheap one, and the sharp
      // version arrives from the Lanczos resampler already at its final size,
      // where the smoothing setting no longer applies.
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
    const any = img as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
    const w = any.naturalWidth ?? (typeof any.width === 'number' ? any.width : 0)
    const h = any.naturalHeight ?? (typeof any.height === 'number' ? any.height : 0)
    return w > 0 && h > 0 ? { w, h } : undefined
  }

  /**
   * Draw one cached patch, resampling it properly when it has to be magnified.
   *
   * `drawImage` scaling up is a tent filter, and so is the GPU's magnification
   * of whatever texture we hand it. Both are why a held patch looks soft or
   * faceted while a fresh one is on its way. Lanczos-3 (see lib/lanczos.ts)
   * reconstructs with a windowed sinc instead, which keeps edges where they
   * were; it costs CPU, so it is spent only where it shows:
   *
   *  - only above RESAMPLE_MIN_SCALE, because below about a quarter again the
   *    two filters are indistinguishable
   *  - only on the part of the patch that lands on the canvas. A cached patch
   *    from a wider view can be five times the canvas in each direction, and
   *    resampling the whole of it would be twenty-five times the work for the
   *    same picture — cropping first is what keeps the cost bounded by the
   *    canvas, and RESAMPLE_MAX_PX then bounds what is left
   *  - once per (patch, size), cached on the patch, because a drag
   *    recomposites repeatedly against the same imagery
   *  - and *never in this call*: the filter runs elsewhere (see
   *    lib/patchResample.ts) and this draw takes the bilinear stretch until it
   *    lands, so a composite costs a blit whether or not it is sharp yet
   */
  private drawPatch(
    ctx: CanvasRenderingContext2D,
    p: CachedPatch<CanvasImageSource>,
    x: number,
    y: number,
    w: number,
    h: number,
    canvasW: number,
    canvasH: number,
    sharpen: boolean,
  ) {
    const up = this.magnified(p, x, y, w, h, canvasW, canvasH, sharpen)
    if (up) ctx.drawImage(up.canvas, up.x, up.y, up.w, up.h)
    else ctx.drawImage(p.image, x, y, w, h)
  }

  /** The visible part of the patch, Lanczos-resampled, or undefined if not worth it. */
  private magnified(
    p: CachedPatch<CanvasImageSource>,
    x: number,
    y: number,
    w: number,
    h: number,
    canvasW: number,
    canvasH: number,
    sharpen: boolean,
  ): { canvas: CanvasImageSource; x: number; y: number; w: number; h: number } | undefined {
    const nat = DetailImagery.naturalSize(p.image)
    if (!nat || w < 1 || h < 1) return undefined
    if (Math.max(w / nat.w, h / nat.h) < RESAMPLE_MIN_SCALE) return undefined

    // the part of the patch that lands on the canvas, in canvas pixels...
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
    const held = this.upscaled.get(p.image)
    if (upscaleFits(held, { crop, w: vw, h: vh })) {
      return { canvas: held.canvas, x: vx, y: vy, w: vw, h: vh }
    }

    if (sharpen) this.requestUpscale(p.image, crop, vw, vh)
    return undefined // bilinear stands in until the sharp version arrives
  }

  /**
   * Ask for a magnified copy, and redraw once it exists.
   *
   * One job per patch at a time: during a zoom the wanted size changes every
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
        this.upscaleEpoch++ // the same plan now draws different pixels
        const last = this.lastComposite
        // Redraw only what is on screen now. recomposite() will find this
        // upscale in the cache and draw it, so there is no loop.
        if (last && this.cache.some((p) => p.image === image)) {
          this.recomposite(last.target, last.screenPx, true)
        }
      })
      .catch(() => this.upscaling.delete(image))
  }

  /** An ImageBitmap holds real memory until closed; a canvas needs nothing. */
  private release(canvas?: CanvasImageSource) {
    if (typeof ImageBitmap !== 'undefined' && canvas instanceof ImageBitmap) canvas.close()
  }

  /**
   * Close the sharpened copies belonging to patches that just left the cache.
   *
   * The copies hang off a WeakMap keyed by the patch's image, so dropping the
   * patch does make them collectable — but an ImageBitmap holds memory the
   * collector does not account for, and "collectable" is not "closed". A
   * megapixel-scale bitmap per evicted patch, released whenever the GC feels
   * like it, is exactly the kind of drift that shows up as a device running out
   * of texture memory an hour into a session and never in a profile.
   */
  private evict(before: CachedPatch<CanvasImageSource>[]) {
    const kept = new Set(this.cache.map((p) => p.image))
    for (const p of before) {
      if (kept.has(p.image)) continue
      this.release(this.upscaled.get(p.image)?.canvas)
      this.upscaled.delete(p.image)
      this.upscaling.delete(p.image)
    }
  }

  /**
   * Draw every cached patch that still overlaps `target` onto one canvas cut to
   * `target`, coarsest first, and hand that to the shader as the single detail
   * texture. The shader contract does not change: one texture, one rectangle.
   */
  private recomposite(target: Bbox, screenPx: number, sharpen = false): boolean {
    // remembered before anything can bail out: a patch that arrives later needs
    // to know which view to draw itself onto, even if there is nothing to
    // composite at this instant
    this.lastComposite = { target, screenPx }
    const plan = compositePlan(this.cache, target, Date.now())
    if (!plan.length) return false
    const sharpest = plan[plan.length - 1]
    // The screen and the device ceiling decide this, and nothing that moves
    // with the camera. One size means one GL allocation for the session and no
    // resolution that can pump up and down as the camera starts and stops — see
    // the note above compositeCanvasSize.
    const { width, height } = compositeCanvasSize(
      this.viewport.px,
      this.viewport.aspect,
      this.maxPx,
    )

    // Redrawing the same patches, at the same size, onto the same rectangle
    // produces the same canvas — and publishing it re-uploads every one of its
    // pixels to the GPU. update() runs on every frame the view moves, so this
    // is the difference between one upload per distinct picture and one per
    // frame.
    const key = [
      width,
      height,
      // the sharpening pass draws the same plan at the same size and is still
      // not the same picture — it is the pass that asks for the Lanczos copies
      sharpen ? 'sharp' : 'fast',
      this.upscaleEpoch,
      target.minLat.toFixed(5),
      target.minLng.toFixed(5),
      target.maxLat.toFixed(5),
      target.maxLng.toFixed(5),
      ...plan.map((p) => p.at),
    ].join('|')
    if (key === this.lastDraw && this.texture) return true
    this.lastDraw = key

    const surf = this.surface(width, height)
    if (!surf) return false
    surf.ctx.clearRect(0, 0, width, height)
    for (const p of plan) {
      // A canvas drawn into itself is undefined at best and a feedback loop at
      // worst — each generation nesting a copy of the last. Nothing puts the
      // composite into the cache today; this makes that a property of the code
      // rather than of the reader's memory.
      if (p.image === surf.canvas) continue
      const { x, y, w, h } = placeOnCanvas(target, p.bbox, width, height)
      this.drawPatch(surf.ctx, p, x, y, w, h, width, height, sharpen)
    }
    // the panel describes what is on screen, which is the source the composite
    // actually drew — not whichever request happened to return last
    this.sourceLabel = this.heldLabel = sharpest.source
    this.attribution = this.heldAttribution = this.attributions.get(sharpest.source) ?? ''
    this.publish(surf.canvas, target, {
      // the sharpest imagery actually drawn, not whichever request returned
      // last: this is what the scale panel quotes, and what tells anyone
      // watching whether the picture just got better or worse
      groundRes: sharpest.groundRes,
      pxPerDeg: sharpest.pxPerDeg,
    })
    return true
  }

  private cancelQueued() {
    if (!this.pending) return // nothing queued or in flight
    clearTimeout(this.settle)
    this.settle = undefined
    this.pending = undefined
    this.generation++ // in-flight images resolve into a dead generation and are dropped
  }

  /**
   * One request, not two. The whole-globe base texture is already on screen, so
   * fetching a Blue Marble patch *and then* a sharp one doubled the traffic and
   * made the view visibly change colour mid-load. The sharp source is asked for
   * directly; Blue Marble is only used once the sharp one has proved
   * unreachable.
   */
  private load(bbox: Bbox, screenPx: number, src: ImagerySource) {
    const gen = this.generation
    this.status = 'loading'
    const { width, height } = imageSize(bbox, screenPx, this.maxPx, src.pxPerDeg)
    // These describe the image being requested, so they are only true once it is
    // on screen. Publishing them here made the panel quote a resolution for
    // imagery nobody could see yet.
    const meta: PatchMeta = {
      groundRes: ((bbox.maxLat - bbox.minLat) * 111_320) / height,
      pxPerDeg: width / Math.max(bbox.maxLng - bbox.minLng, 1e-9),
    }

    this.fetch(src, bbox, width, height, gen, meta, {
      fail: () => {
        if (src === SHARP_SOURCE) {
          this.sharpStrikes++
          if (this.sharpStrikes >= 2) this.sharpDisabled = true
          // Retry once, then fall back — one bad response is usually a bad
          // response, two is a source. The box was cut for the sharp source, so
          // either way it is inside the base source's own limit too.
          this.load(bbox, screenPx, this.sharpDisabled ? BASE_SOURCE : SHARP_SOURCE)
          return
        }
        this.strikes++
        if (this.strikes >= 3) {
          this.disabled = true
          this.status = 'unavailable'
          this.onReady?.()
        }
      },
    })
  }

  private fetch(
    src: ImagerySource,
    bbox: Bbox,
    width: number,
    height: number,
    gen: number,
    meta: PatchMeta,
    handlers: { ok?: () => void; fail?: () => void },
  ) {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (gen !== this.generation) return // streaming was cancelled under it
      this.adopt(img, bbox, meta, src)
      handlers.ok?.()
    }
    img.onerror = () => {
      if (gen !== this.generation) return
      handlers.fail?.()
    }
    img.src = wmsUrl(src, bbox, width, height)
  }

  /**
   * Take up an arriving patch. Image, rectangle and metrics go together, so
   * they cannot disagree.
   *
   * A patch reaches the shader by exactly one route: into the cache, then out
   * through the composite. It used to have a second route — a fresh patch was
   * published directly, on the grounds that it covers the whole view on its own
   * — and the two routes disagreed about which rectangle they were for. The
   * direct one published the *request's* box, the composite published the
   * *current view's* box, and since the feather is measured against whichever
   * rectangle was published, the edge of the imagery moved every time the two
   * alternated. One route means one rectangle and one feather.
   */
  private adopt(img: HTMLImageElement, bbox: Bbox, meta: PatchMeta, src: ImagerySource) {
    const now = Date.now()
    this.attributions.set(src.label, src.attribution ?? '')
    const before = this.cache
    this.cache = pruneCache(
      [
        {
          bbox,
          source: src.label,
          pxPerDeg: meta.pxPerDeg,
          groundRes: meta.groundRes,
          at: now,
          image: img,
        },
        ...this.cache,
      ],
      bbox,
      now,
    )
    this.evict(before)
    this.current = bbox
    this.strikes = 0
    // `groundRes` is not set here. It describes the imagery *on screen*, and an
    // arrival does not always reach the screen: when the composite below
    // dedupes — same patches, same size, same rectangle — nothing is
    // republished, and writing the arrival's resolution anyway made the scale
    // panel quote a coarser number than the picture it was standing next to.
    // `publish` is the only writer, so the number and the pixels change
    // together or not at all.
    const view = this.lastComposite
    // Sharpen only if the camera is actually still. An armed settle timer means
    // it is not: patches now land mid-zoom (see `generation`), and a Lanczos
    // pass spent on a picture the next frame replaces is the stall this was
    // moved off the main thread to avoid. Falling back to publishing the image
    // directly covers the one case the composite cannot: no DOM, so no canvas.
    const still = this.settle === undefined
    if (!view || !this.recomposite(view.target, view.screenPx, still)) {
      this.sourceLabel = this.heldLabel = src.label
      this.attribution = this.heldAttribution = src.attribution ?? ''
      this.publish(img, bbox, meta)
    }
  }

  /** The one place a texture reaches the shader, whether patch or composite. */
  private publish(source: CanvasImageSource, bbox: Bbox, meta: PatchMeta) {
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
    // Content, rectangle and mip level move together, in this order, in one
    // call: whatever the shader is handed, the rectangle it is stretched across
    // and the level that matches the base map all describe the same pixels.
    this.rect = bboxToUvRect(bbox)
    this.composited = bbox
    // Derived here, from the image the shader is about to be handed, because
    // that is the only size the mip chain it will sample is built from. See
    // detailLod.
    this.lod = detailLod(size?.w ?? 1, bbox.maxLng - bbox.minLng)
    this.groundRes = meta.groundRes
    this.mix = 1
    this.shown = true
    this.status = 'ready'
    this.onReady?.()
  }

  dispose() {
    this.cancelQueued()
    const held = this.cache
    this.cache = []
    this.evict(held)
    this.resampler.dispose()
    this.texture?.dispose()
  }
}
