import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three'

/**
 * High-resolution imagery streamed from NASA GIBS as WMTS tiles.
 *
 * The globe always carries a whole-world base texture; this adds a patch of much
 * sharper imagery over the region actually being looked at, chosen at a zoom
 * level that matches the camera altitude. Zoomed out, the patch is dropped and
 * the base texture carries the image on its own.
 *
 * GIBS EPSG:4326 tiles are 512 px and quadtree-indexed: level L has 2^(L+1)
 * columns by 2^L rows, each spanning 180/2^L degrees.
 */

export const TILE_PX = 512

/**
 * Modern satellite imagery shows modern cities, fields and reservoirs. Before
 * this year it would be an anachronism, so close zoom is barred and the base
 * map carries the view instead.
 */
export const IMAGERY_ERA_FROM = 1930

/** Closest the camera may come, in globe radii of altitude. */
export const MIN_ALTITUDE_DETAIL = 0.0014 // view ~6° across, matching 500 m imagery
export const MIN_ALTITUDE_PLAIN = 0.05 // without detail, stay back where the base map holds up

export const minAltitudeFor = (year: number, detailEnabled: boolean): number =>
  detailEnabled && year >= IMAGERY_ERA_FROM ? MIN_ALTITUDE_DETAIL : MIN_ALTITUDE_PLAIN

export const degPerTile = (level: number) => 180 / 2 ** level

/** Angular radius of the visible cap, in degrees, for a camera altitude in globe radii. */
export const visibleSpanDeg = (altitude: number) =>
  2 * Math.acos(Math.min(1, 1 / (1 + Math.max(altitude, 1e-3)))) * (180 / Math.PI)

/** Finest level whose `grid`×`grid` patch still covers the visible cap. */
export function levelForAltitude(altitude: number, grid: number, maxLevel: number): number {
  const span = Math.max(visibleSpanDeg(altitude), 1e-3)
  const level = Math.floor(Math.log2((180 * grid) / span))
  return Math.max(0, Math.min(maxLevel, level))
}

/**
 * Level chosen so the patch is at least as sharp as the screen showing it.
 *
 * A tile is TILE_PX across `degPerTile` degrees, so it supplies
 * TILE_PX/degPerTile pixels per degree; the display needs viewportPx/span.
 * Solving for the level and rounding up guarantees we never magnify tiles —
 * which is what made close views blurry when the level was picked purely by
 * coverage.
 */
export function levelForView(spanDeg: number, viewportPx: number, maxLevel: number): number {
  const needed = viewportPx / Math.max(spanDeg, 1e-4)
  const level = Math.ceil(Math.log2((needed * 180) / TILE_PX))
  return Math.max(0, Math.min(maxLevel, level))
}

export interface TileRange {
  col0: number
  row0: number
  cols: number
  rows: number
  level: number
}

/** Tile block of `grid`×`grid` centred on a point, clamped to the matrix bounds. */
export function tileRange(lat: number, lng: number, level: number, grid: number): TileRange {
  const deg = degPerTile(level)
  const maxCol = 2 ** (level + 1) - 1
  const maxRow = 2 ** level - 1
  const cols = Math.min(grid, maxCol + 1)
  const rows = Math.min(grid, maxRow + 1)
  const centreCol = Math.floor((lng + 180) / deg)
  const centreRow = Math.floor((90 - lat) / deg)
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v))
  return {
    level,
    cols,
    rows,
    col0: clamp(centreCol - Math.floor((cols - 1) / 2), maxCol - cols + 1),
    row0: clamp(centreRow - Math.floor((rows - 1) / 2), maxRow - rows + 1),
  }
}

/** The block's extent in the globe's UV space: u=(lng+180)/360, v=(lat+90)/180. */
export function rangeToUvRect(r: TileRange): [u0: number, v0: number, du: number, dv: number] {
  const deg = degPerTile(r.level)
  const lng0 = -180 + r.col0 * deg
  const latTop = 90 - r.row0 * deg
  const latBottom = latTop - r.rows * deg
  return [(lng0 + 180) / 360, (latBottom + 90) / 180, (r.cols * deg) / 360, (r.rows * deg) / 180]
}

const sameRange = (a: TileRange | undefined, b: TileRange) =>
  !!a && a.level === b.level && a.col0 === b.col0 && a.row0 === b.row0 && a.cols === b.cols && a.rows === b.rows

export interface DetailTilesOptions {
  layer?: string
  matrixSet?: string
  maxLevel?: number
  grid?: number
}

export class DetailTiles {
  readonly texture: CanvasTexture
  /** UV rect of the loaded patch, and how strongly to blend it. */
  rect: [number, number, number, number] = [0, 0, 1, 1]
  mix = 0

  /** Live canvas backing the texture. */
  private canvas: HTMLCanvasElement
  /** Staging canvas; tiles land here and are swapped in only once complete. */
  private back: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private backCtx: CanvasRenderingContext2D
  private current?: TileRange
  private pending = 0
  private layer: string
  private matrixSet: string
  private maxLevel: number
  private grid: number
  /** Set once the service proves unreachable, so we stop retrying. */
  private disabled = false
  private strikes = 0
  private everWorked = false
  private timer?: ReturnType<typeof setTimeout>
  /** Reported in settings so a failure is visible rather than silently blurry. */
  status: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle'
  /** Called when a patch finishes loading, so the renderer can pick it up. */
  onReady?: () => void

  constructor(opts: DetailTilesOptions = {}) {
    this.layer = opts.layer ?? 'BlueMarble_ShadedRelief_Bathymetry'
    this.matrixSet = opts.matrixSet ?? '500m'
    this.maxLevel = opts.maxLevel ?? 7
    this.grid = opts.grid ?? 3

    this.canvas = document.createElement('canvas')
    this.canvas.width = this.canvas.height = this.grid * TILE_PX
    this.ctx = this.canvas.getContext('2d')!
    this.back = document.createElement('canvas')
    this.backCtx = this.back.getContext('2d')!
    this.texture = new CanvasTexture(this.canvas)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.minFilter = this.texture.magFilter = LinearFilter
  }

  private url(level: number, row: number, col: number) {
    return `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${this.layer}/default/default/${this.matrixSet}/${level}/${row}/${col}.jpg`
  }

  /** Point the patch at the camera's current target; safe to call every frame. */
  update(lat: number, lng: number, altitude: number, viewportPx = 900) {
    if (this.disabled) return
    const level = levelForView(visibleSpanDeg(altitude), viewportPx, this.maxLevel)
    if (level < 2) {
      this.mix = 0 // zoomed out: the base texture is sharp enough
      return
    }
    const range = tileRange(lat, lng, level, this.grid)
    if (sameRange(this.current, range) || this.pending > 0) return
    this.load(range)
  }

  private load(range: TileRange) {
    this.current = range
    this.pending = range.cols * range.rows
    this.status = 'loading'
    let failed = 0

    // never let a hung request wedge the loader permanently
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      if (this.pending > 0) {
        this.pending = 0
        if (this.mix === 0) this.status = 'unavailable'
      }
    }, 12000)

    // sizing a canvas clears it, so stage off-screen: the visible patch keeps
    // showing the previous area until the new one is fully drawn
    this.back.width = range.cols * TILE_PX
    this.back.height = range.rows * TILE_PX

    for (let r = 0; r < range.rows; r++) {
      for (let c = 0; c < range.cols; c++) {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => {
          this.backCtx.drawImage(img, c * TILE_PX, r * TILE_PX, TILE_PX, TILE_PX)
          this.done(range, failed)
        }
        img.onerror = () => {
          failed++
          this.done(range, failed)
        }
        img.src = this.url(range.level, range.row0 + r, range.col0 + c)
      }
    }

  }

  private done(range: TileRange, failed: number) {
    if (--this.pending > 0) return
    clearTimeout(this.timer)

    if (failed === range.cols * range.rows) {
      // Give up only after repeated total failures, and only if a patch has
      // never worked — a single bad batch may just be one unlucky zoom level.
      this.strikes++
      if (!this.everWorked && this.strikes >= 2) {
        this.disabled = true
        this.status = 'unavailable'
      }
      this.onReady?.()
      return
    }

    // swap the staged patch in as one atomic step
    this.canvas.width = this.back.width
    this.canvas.height = this.back.height
    this.ctx.drawImage(this.back, 0, 0)

    this.rect = rangeToUvRect(range)
    this.texture.needsUpdate = true
    this.mix = 1
    this.strikes = 0
    this.everWorked = true
    this.status = 'ready'
    this.onReady?.() // the renderer only learns the patch exists if we say so
  }

  dispose() {
    this.texture.dispose()
  }
}
