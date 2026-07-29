import { LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture } from 'three'

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

/** Modern imagery shows modern cities; before this year it is an anachronism. */
export const IMAGERY_ERA_FROM = 1930

/** 30 m imagery supports a much closer approach than 500 m did. */
export const MIN_ALTITUDE_DETAIL = 0.0007
export const MIN_ALTITUDE_PLAIN = 0.05

export const minAltitudeFor = (year: number, detailEnabled: boolean): number =>
  detailEnabled && year >= IMAGERY_ERA_FROM ? MIN_ALTITUDE_DETAIL : MIN_ALTITUDE_PLAIN

/** Angular radius of the visible cap, in degrees, for an altitude in globe radii. */
export const visibleSpanDeg = (altitude: number) =>
  2 * Math.acos(Math.min(1, 1 / (1 + Math.max(altitude, 1e-3)))) * (180 / Math.PI)

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
  margin = 1.15,
): Bbox {
  const latSpan = clamp(visibleSpanDeg(altitude) * margin, 0.05, 120)
  const groundWidth = latSpan * clamp(aspect, 0.35, 3)
  const lngSpan = clamp(groundWidth / Math.max(Math.cos((lat * Math.PI) / 180), 0.15), 0.05, 300)
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

/**
 * Pixel size for a bbox.
 *
 * `screenPx` must be in *device* pixels: the globe renders at the device pixel
 * ratio, so sizing against CSS pixels under-requests by 2–3× on a phone and the
 * result is soft however good the source is. Capped by the source's own
 * resolution — asking a 500 m map for more than 222 px per degree returns
 * upsampled blur, slowly — and by a hard ceiling.
 */
export function imageSize(
  b: Bbox,
  screenPx: number,
  maxPx = 2048,
  pxPerDeg = BASE_SOURCE.pxPerDeg,
): { width: number; height: number } {
  const lngSpan = Math.max(b.maxLng - b.minLng, 1e-6)
  const latSpan = Math.max(b.maxLat - b.minLat, 1e-6)
  // the patch spans a little more than the screen, so match its height and let
  // width follow the rectangle's own shape
  const heightWanted = Math.min(screenPx * 1.15, latSpan * pxPerDeg)
  const height = clamp(Math.round(heightWanted), 192, maxPx)
  const width = clamp(Math.round((height * lngSpan) / latSpan), 192, maxPx)
  return { width, height }
}

const movedEnough = (a: Bbox | undefined, b: Bbox) => {
  if (!a) return true
  const span = b.maxLat - b.minLat
  return (
    Math.abs(a.minLat - b.minLat) > span * 0.2 ||
    Math.abs(a.minLng - b.minLng) > span * 0.2 ||
    Math.abs(a.maxLat - a.minLat - span) > span * 0.1
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
  time?: string
  attribution?: string
}

export const BASE_SOURCE: ImagerySource = {
  label: 'Blue Marble 500 m',
  endpoint: 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi',
  layers: 'BlueMarble_ShadedRelief_Bathymetry',
  version: '1.3.0',
  pxPerDeg: 222,
  attribution: 'NASA GIBS / Worldview',
}

export const SHARP_SOURCE: ImagerySource = {
  label: 'Sentinel-2 10 m',
  endpoint: 'https://tiles.maps.eox.at/wms',
  layers: 's2cloudless-2020',
  version: '1.1.1',
  pxPerDeg: 11100,
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

export const PATCH_ON_BELOW = 42
export const PATCH_OFF_ABOVE = 55

export interface DetailImageryOptions {
  maxPx?: number
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
  onReady?: () => void

  private maxPx: number
  private current?: Bbox
  private requestId = 0
  private settle?: ReturnType<typeof setTimeout>
  private strikes = 0
  private sharpStrikes = 0
  private sharpDisabled = false
  private shown = false
  private disabled = false

  constructor(opts: DetailImageryOptions = {}) {
    this.maxPx = opts.maxPx ?? 2048
  }

  update(lat: number, lng: number, altitude: number, screenPx = 900, aspect = 1) {
    if (this.disabled) return
    const span = visibleSpanDeg(altitude)

    // hysteresis: once shown, the patch survives until well past the threshold
    if (span > (this.shown ? PATCH_OFF_ABOVE : PATCH_ON_BELOW)) {
      if (this.shown) {
        this.shown = false
        this.mix = 0
        this.status = 'idle'
        this.sourceLabel = '—'
        this.onReady?.() // or the panel keeps describing a patch nobody can see
      }
      return
    }

    const bbox = viewBbox(lat, lng, altitude, aspect)

    // the imagery we already hold may still cover the view — show it again
    // rather than paying for the same request twice
    if (this.texture && !movedEnough(this.current, bbox)) {
      if (!this.shown || this.mix !== 1) {
        this.shown = true
        this.mix = 1
        this.status = 'ready'
        this.sourceLabel = this.sourceLabel === '—' ? BASE_SOURCE.label : this.sourceLabel
        this.onReady?.()
      }
      return
    }

    // wait for the camera to settle before spending a request
    clearTimeout(this.settle)
    this.settle = setTimeout(() => this.load(bbox, screenPx), 280)
  }

  /**
   * One request, not two. The whole-globe base texture is already on screen, so
   * fetching a Blue Marble patch *and then* a sharp one doubled the traffic and
   * made the view visibly change colour mid-load. The sharp source is asked for
   * directly; Blue Marble is only used once the sharp one has proved
   * unreachable.
   */
  private load(bbox: Bbox, screenPx: number) {
    const id = ++this.requestId
    this.status = 'loading'
    const src = this.sharpDisabled ? BASE_SOURCE : SHARP_SOURCE
    const { width, height } = imageSize(bbox, screenPx, this.maxPx, src.pxPerDeg)
    this.lod = detailLod(width, bbox.maxLng - bbox.minLng)

    this.fetch(src, bbox, width, height, id, {
      fail: () => {
        if (src === SHARP_SOURCE) {
          this.sharpStrikes++
          if (this.sharpStrikes >= 2) this.sharpDisabled = true
          this.load(bbox, screenPx) // fall back immediately, don't leave it bare
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
    handlers: { ok?: () => void; fail?: () => void },
  ) {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (id !== this.requestId) return // a newer view has superseded this one
      this.adopt(img, bbox, src.label, src.attribution)
      handlers.ok?.()
    }
    img.onerror = () => {
      if (id !== this.requestId) return
      handlers.fail?.()
    }
    img.src = wmsUrl(src, bbox, width, height)
  }

  /** Image and its rectangle are taken up together, so they cannot disagree. */
  private adopt(img: HTMLImageElement, bbox: Bbox, label: string, attribution = '') {
    const next = new Texture(img)
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
    this.current = bbox
    this.mix = 1
    this.shown = true
    this.status = 'ready'
    this.sourceLabel = label
    this.attribution = attribution
    this.strikes = 0
    previous?.dispose()
    this.onReady?.()
  }

  dispose() {
    clearTimeout(this.settle)
    this.requestId++
    this.texture?.dispose()
  }
}
