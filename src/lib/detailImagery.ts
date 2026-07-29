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
 * Imagery is fetched in two stages.
 *
 * The base source always works and is what the view falls back to. The sharp
 * source is Landsat at 30 m — about sixteen times finer — composited server-side
 * over Blue Marble so its ocean gaps stay filled. It is requested *after* the
 * base has already been shown, so if it 404s (its coverage is patchy, and GIBS
 * returns 404 rather than a blank image where a layer has no data) the view is
 * merely less sharp, never broken. An earlier version put the sharp source
 * first and a bad date took the whole feature down with it.
 */
export interface ImagerySource {
  layers: string
  time?: string
  label: string
}

export const BASE_SOURCE: ImagerySource = {
  label: 'Blue Marble 500 m',
  layers: 'BlueMarble_ShadedRelief_Bathymetry',
}

/** WELD global composites only exist for Dec 2008 – Nov 2011. */
export const SHARP_SOURCE: ImagerySource = {
  label: 'Landsat 30 m',
  layers:
    'BlueMarble_ShadedRelief_Bathymetry,Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual',
  time: '2010-01-01',
}

export interface DetailImageryOptions {
  maxPx?: number
  sharpen?: boolean
}

export class DetailImagery {
  texture?: Texture
  rect: [number, number, number, number] = [0, 0, 1, 1]
  mix = 0
  status: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle'
  sourceLabel = '—'
  onReady?: () => void

  private maxPx: number
  private sharpen: boolean
  private current?: Bbox
  private requestId = 0
  private settle?: ReturnType<typeof setTimeout>
  private strikes = 0
  private sharpStrikes = 0
  private sharpDisabled = false
  private disabled = false

  constructor(opts: DetailImageryOptions = {}) {
    this.maxPx = opts.maxPx ?? 3072
    this.sharpen = opts.sharpen ?? true
  }

  private url(src: ImagerySource, b: Bbox, width: number, height: number) {
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
    const id = ++this.requestId
    const { width, height } = imageSize(bbox, viewportPx, this.maxPx)
    this.status = 'loading'

    // stage one: the source that always works
    this.fetch(BASE_SOURCE, bbox, width, height, id, {
      ok: () => {
        // stage two: try to replace it with something sharper
        if (!this.sharpen || this.sharpDisabled) return
        this.fetch(SHARP_SOURCE, bbox, width, height, id, {
          fail: () => {
            this.sharpStrikes++
            if (this.sharpStrikes >= 2) this.sharpDisabled = true
          },
        })
      },
      fail: () => {
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
      this.adopt(img, bbox, src.label)
      handlers.ok?.()
    }
    img.onerror = () => {
      if (id !== this.requestId) return
      handlers.fail?.()
    }
    img.src = this.url(src, bbox, width, height)
  }

  /** Image and its rectangle are taken up together, so they cannot disagree. */
  private adopt(img: HTMLImageElement, bbox: Bbox, label: string) {
    const next = new Texture(img)
    next.colorSpace = SRGBColorSpace
    next.minFilter = next.magFilter = LinearFilter
    next.generateMipmaps = false
    next.needsUpdate = true

    const previous = this.texture
    this.texture = next
    this.rect = bboxToUvRect(bbox)
    this.current = bbox
    this.mix = 1
    this.status = 'ready'
    this.sourceLabel = label
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
