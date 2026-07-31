import { LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture } from 'three'
import { compositePlan, placeOnCanvas, pruneCache, type CachedPatch } from './patchCache'
import { resampleRGBA } from './lanczosWasm'

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
 * How far past a held patch's own resolution the composite canvas may be sized.
 *
 * The canvas used to be capped at exactly the sharpest cached patch's density,
 * which sounds right — no canvas can invent detail — and meant the CPU never
 * magnified anything: every bit of magnification was left to the GPU, whose
 * only filter is bilinear. That is the soft, faceted texture you see while a
 * fresh patch is on its way. Sizing the canvas toward the screen instead lets
 * Lanczos-3 do the enlargement, and the GPU then has little or nothing left to
 * stretch. Three times is where the extra texture memory stops paying for
 * itself; past it the reconstruction has no more information to work with.
 */
export const COMPOSITE_UPSCALE_MAX = 3

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
 * Canvas size for a composite: the held imagery's own size, enlarged toward the
 * screen's but no further than the resampler is worth running.
 *
 * Both bounds matter. Enlarging past what the screen shows is pure cost, and
 * enlarging past COMPOSITE_UPSCALE_MAX buys nothing a reconstruction filter can
 * honour; RESAMPLE_MAX_PX then keeps a single composite inside about a tenth of
 * a second even on a slow machine.
 */
export function upscaledSize(
  natural: { width: number; height: number },
  screen: { width: number; height: number },
  maxPx = MAX_PATCH_PX,
): { width: number; height: number } {
  const area = Math.max(natural.width * natural.height, 1)
  const scale = Math.max(
    1,
    Math.min(
      screen.height / Math.max(natural.height, 1),
      COMPOSITE_UPSCALE_MAX,
      Math.sqrt(RESAMPLE_MAX_PX / area),
      maxPx / Math.max(natural.width, natural.height),
    ),
  )
  return {
    width: Math.min(maxPx, Math.round(natural.width * scale)),
    height: Math.min(maxPx, Math.round(natural.height * scale)),
  }
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
 * map lacks; multiplying that back onto the base map's colour transfers
 * Sentinel-2's structure while keeping NASA's palette.
 */
export const detailLod = (
  imageWidthPx: number,
  lngSpanDeg: number,
  basePxPerDeg = BASE_TEXTURE_PX_PER_DEG,
): number => {
  const ratio = imageWidthPx / Math.max(lngSpanDeg, 1e-6) / basePxPerDeg
  return clamp(Math.log2(Math.max(ratio, 1)), 1, 7)
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
}

/** Metrics that only become true when the image they describe is on screen. */
interface PatchMeta {
  lod: number
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
  private requestId = 0
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
    { canvas: HTMLCanvasElement; w: number; h: number; crop: { x: number; y: number; w: number; h: number } }
  >()

  constructor(opts: DetailImageryOptions = {}) {
    this.maxPx = opts.maxPx ?? MAX_PATCH_PX
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
   *    canvas, which upscaledSize already holds inside RESAMPLE_MAX_PX
   *  - once per (patch, size), cached on the patch, because a drag
   *    recomposites repeatedly against the same imagery
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
  ) {
    const up = this.magnified(p, x, y, w, h, canvasW, canvasH)
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

    const held = this.upscaled.get(p.image)
    const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(b, 1) * 0.05
    if (
      held &&
      close(held.w, vw) &&
      close(held.h, vh) &&
      close(held.crop.x, crop.x) &&
      close(held.crop.y, crop.y) &&
      close(held.crop.w, crop.w)
    ) {
      return { canvas: held.canvas, x: vx, y: vy, w: vw, h: vh }
    }

    const canvas = this.resample(p.image, crop, vw, vh)
    if (!canvas) return undefined
    this.upscaled.set(p.image, { canvas, w: vw, h: vh, crop })
    return { canvas, x: vx, y: vy, w: vw, h: vh }
  }

  /** The pixel round-trip: image crop -> ImageData -> Lanczos-3 -> canvas. */
  private resample(
    image: CanvasImageSource,
    crop: { x: number; y: number; w: number; h: number },
    dw: number,
    dh: number,
  ): HTMLCanvasElement | undefined {
    if (typeof document === 'undefined' || typeof ImageData === 'undefined') return undefined
    const cw = Math.max(1, Math.round(crop.w))
    const ch = Math.max(1, Math.round(crop.h))
    try {
      const src = document.createElement('canvas')
      src.width = cw
      src.height = ch
      const sctx = src.getContext('2d', { willReadFrequently: true })
      // a stub canvas (tests) has no pixel readback; fall through to bilinear
      if (!sctx?.getImageData) return undefined
      sctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, cw, ch)
      const out = resampleRGBA(sctx.getImageData(0, 0, cw, ch), dw, dh)

      const dst = document.createElement('canvas')
      dst.width = out.width
      dst.height = out.height
      const dctx = dst.getContext('2d')
      if (!dctx?.putImageData) return undefined
      dctx.putImageData(new ImageData(out.data, out.width, out.height), 0, 0)
      return dst
    } catch {
      // a tainted canvas is the realistic failure here: readback throws, and
      // the bilinear path is a perfectly good answer
      return undefined
    }
  }

  /**
   * Draw every cached patch that still overlaps `target` onto one canvas cut to
   * `target`, coarsest first, and hand that to the shader as the single detail
   * texture. The shader contract does not change: one texture, one rectangle.
   */
  private recomposite(target: Bbox, screenPx: number): boolean {
    const plan = compositePlan(this.cache, target, Date.now())
    if (!plan.length) return false
    const sharpest = plan[plan.length - 1]
    // Two sizes: what the imagery we hold actually contains, and what the
    // screen would like. The canvas is sized between them — see
    // COMPOSITE_UPSCALE_MAX — so the enlargement happens here, through a proper
    // filter, instead of on the GPU through a tent.
    const natural = imageSize(target, screenPx, this.maxPx, sharpest.pxPerDeg)
    const screen = imageSize(target, screenPx, this.maxPx, Number.MAX_SAFE_INTEGER)
    const { width, height } = upscaledSize(natural, screen, this.maxPx)
    const surf = this.surface(width, height)
    if (!surf) return false
    surf.ctx.clearRect(0, 0, width, height)
    for (const p of plan) {
      const { x, y, w, h } = placeOnCanvas(target, p.bbox, width, height)
      this.drawPatch(surf.ctx, p, x, y, w, h, width, height)
    }
    this.publish(surf.canvas, target, {
      // from the natural size, not the canvas: the shader uses this to pick the
      // mip whose blur matches the base map, and an upscaled canvas holds no
      // more real detail than the patch it was made from
      lod: detailLod(natural.width, target.maxLng - target.minLng),
      // the composite is only as good as the patches in it, and its edges are
      // the basemap, so the resolution we quote stays the one we actually have
      groundRes: this.groundRes,
      pxPerDeg: sharpest.pxPerDeg,
    })
    return true
  }

  private cancelQueued() {
    if (!this.pending) return // nothing queued or in flight
    clearTimeout(this.settle)
    this.settle = undefined
    this.pending = undefined
    this.requestId++ // in-flight images resolve into a superseded id and are dropped
  }

  /**
   * One request, not two. The whole-globe base texture is already on screen, so
   * fetching a Blue Marble patch *and then* a sharp one doubled the traffic and
   * made the view visibly change colour mid-load. The sharp source is asked for
   * directly; Blue Marble is only used once the sharp one has proved
   * unreachable.
   */
  private load(bbox: Bbox, screenPx: number, src: ImagerySource) {
    const id = ++this.requestId
    this.status = 'loading'
    const { width, height } = imageSize(bbox, screenPx, this.maxPx, src.pxPerDeg)
    // These describe the image being requested, so they are only true once it is
    // on screen. Publishing them here made the shader sharpen the patch it still
    // held at the incoming patch's mip level, and the panel quote a resolution
    // for imagery nobody could see yet.
    const meta: PatchMeta = {
      lod: detailLod(width, bbox.maxLng - bbox.minLng),
      groundRes: ((bbox.maxLat - bbox.minLat) * 111_320) / height,
      pxPerDeg: width / Math.max(bbox.maxLng - bbox.minLng, 1e-9),
    }

    this.fetch(src, bbox, width, height, id, meta, {
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
    id: number,
    meta: PatchMeta,
    handlers: { ok?: () => void; fail?: () => void },
  ) {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (id !== this.requestId) return // a newer view has superseded this one
      this.adopt(img, bbox, meta, src.label, src.attribution)
      handlers.ok?.()
    }
    img.onerror = () => {
      if (id !== this.requestId) return
      handlers.fail?.()
    }
    img.src = wmsUrl(src, bbox, width, height)
  }

  /** Image, rectangle and metrics are taken up together, so they cannot disagree. */
  private adopt(
    img: HTMLImageElement,
    bbox: Bbox,
    meta: PatchMeta,
    label: string,
    attribution = '',
  ) {
    // A freshly fetched patch covers the whole view on its own, so it is shown
    // directly rather than composited onto itself. It joins the cache for the
    // *next* move, which is the only time compositing has anything to add.
    this.cache = pruneCache(
      [{ bbox, pxPerDeg: meta.pxPerDeg, at: Date.now(), image: img }, ...this.cache],
      bbox,
      Date.now(),
    )
    this.current = bbox
    this.sourceLabel = this.heldLabel = label
    this.attribution = this.heldAttribution = attribution
    this.strikes = 0
    this.publish(img, bbox, meta)
  }

  /** The one place a texture reaches the shader, whether patch or composite. */
  private publish(source: CanvasImageSource, bbox: Bbox, meta: PatchMeta) {
    const next = new Texture(source as HTMLImageElement)
    next.colorSpace = SRGBColorSpace
    // mipmaps are needed: the shader samples a deliberately blurred copy of the
    // patch to separate its fine detail from its overall colour
    next.minFilter = LinearMipmapLinearFilter
    next.magFilter = LinearFilter
    next.generateMipmaps = true
    next.needsUpdate = true

    const previous = this.texture
    this.texture = next
    this.rect = bboxToUvRect(bbox)
    this.composited = bbox
    this.lod = meta.lod
    this.groundRes = meta.groundRes
    this.mix = 1
    this.shown = true
    this.status = 'ready'
    previous?.dispose()
    this.onReady?.()
  }

  dispose() {
    this.cancelQueued()
    this.cache = []
    this.texture?.dispose()
  }
}
