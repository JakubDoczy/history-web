import { LinearFilter, SRGBColorSpace, Texture } from 'three'

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
 * Rectangle to request: centred on the view, a little larger than it, and
 * widened in longitude to compensate for meridian convergence so it covers a
 * roughly square patch of ground.
 */
export function viewBbox(lat: number, lng: number, altitude: number, margin = 1.25): Bbox {
  const latSpan = clamp(visibleSpanDeg(altitude) * margin, 0.05, 120)
  const lngSpan = clamp(latSpan / Math.max(Math.cos((lat * Math.PI) / 180), 0.15), 0.05, 300)
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
 * Pixel size for a bbox. Requested at roughly twice the screen's own density:
 * the patch is sampled at grazing angles across a curved surface, where 1:1
 * sampling still reads as soft.
 */
export function imageSize(b: Bbox, viewportPx: number, maxPx = 3072): { width: number; height: number } {
  const lngSpan = b.maxLng - b.minLng
  const latSpan = Math.max(b.maxLat - b.minLat, 1e-6)
  const width = clamp(Math.round(viewportPx * 2.2), 512, maxPx)
  const height = clamp(Math.round((width * latSpan) / lngSpan), 256, maxPx)
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
 * Sources tried in order, best first. WMS composites a comma-separated list
 * bottom-to-top server-side, so Landsat rides on top of Blue Marble and the
 * oceans — which WELD does not cover — stay filled. If a source fails
 * repeatedly we fall back to the next, so detail degrades rather than vanishes.
 */
export interface ImagerySource {
  layers: string
  time?: string
  label: string
}

export const IMAGERY_SOURCES: ImagerySource[] = [
  {
    label: 'Landsat 30 m',
    layers:
      'BlueMarble_ShadedRelief_Bathymetry,Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual',
    time: '2012-01-01',
  },
  { label: 'Blue Marble 500 m', layers: 'BlueMarble_ShadedRelief_Bathymetry' },
]

export interface DetailImageryOptions {
  sources?: ImagerySource[]
  maxPx?: number
}

export class DetailImagery {
  texture?: Texture
  rect: [number, number, number, number] = [0, 0, 1, 1]
  mix = 0
  status: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle'
  onReady?: () => void

  private sources: ImagerySource[]
  private sourceIdx = 0
  private maxPx: number
  private current?: Bbox
  private inFlight?: HTMLImageElement
  private settle?: ReturnType<typeof setTimeout>
  private strikes = 0
  private everWorked = false
  private disabled = false

  constructor(opts: DetailImageryOptions = {}) {
    this.sources = opts.sources ?? IMAGERY_SOURCES
    this.maxPx = opts.maxPx ?? 3072
  }

  /** Which source is currently supplying imagery, for display in settings. */
  get sourceLabel() {
    return this.sources[this.sourceIdx]?.label ?? '—'
  }

  private url(b: Bbox, width: number, height: number) {
    const src = this.sources[this.sourceIdx]
    // WMS 1.3.0 with EPSG:4326 takes bbox in lat,lng order
    return (
      'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi' +
      '?version=1.3.0&service=WMS&request=GetMap&format=image/jpeg&STYLE=default' +
      '&CRS=EPSG:4326' +
      `&bbox=${b.minLat},${b.minLng},${b.maxLat},${b.maxLng}` +
      `&WIDTH=${width}&HEIGHT=${height}&layers=${encodeURIComponent(src.layers)}` +
      (src.time ? `&TIME=${src.time}` : '')
    )
  }

  update(lat: number, lng: number, altitude: number, viewportPx = 900) {
    if (this.disabled) return
    if (visibleSpanDeg(altitude) > 45) {
      this.mix = 0 // zoomed out: the base map is sharp enough
      return
    }
    const bbox = viewBbox(lat, lng, altitude)
    if (!movedEnough(this.current, bbox)) return

    // wait for the camera to settle before spending a request
    clearTimeout(this.settle)
    this.settle = setTimeout(() => this.load(bbox, viewportPx), 280)
  }

  private load(bbox: Bbox, viewportPx: number) {
    const { width, height } = imageSize(bbox, viewportPx, this.maxPx)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    this.inFlight = img
    this.status = 'loading'

    img.onload = () => {
      if (this.inFlight !== img) return // superseded by a newer request
      const next = new Texture(img)
      next.colorSpace = SRGBColorSpace
      next.minFilter = next.magFilter = LinearFilter
      next.generateMipmaps = false
      next.needsUpdate = true

      const previous = this.texture
      // image and its rectangle are adopted together, so they can never disagree
      this.texture = next
      this.rect = bboxToUvRect(bbox)
      this.current = bbox
      this.mix = 1
      this.status = 'ready'
      this.everWorked = true
      this.strikes = 0
      previous?.dispose()
      this.onReady?.()
    }

    img.onerror = () => {
      if (this.inFlight !== img) return
      this.strikes++
      // two failures on a source means it is not usable here; try the next one
      if (this.strikes >= 2 && this.sourceIdx < this.sources.length - 1) {
        this.sourceIdx++
        this.strikes = 0
        this.load(bbox, viewportPx)
        return
      }
      if (!this.everWorked && this.strikes >= 3) {
        this.disabled = true
        this.status = 'unavailable'
      }
      this.onReady?.()
    }

    img.src = this.url(bbox, width, height)
  }

  dispose() {
    clearTimeout(this.settle)
    this.inFlight = undefined
    this.texture?.dispose()
  }
}
