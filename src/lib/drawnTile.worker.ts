import { loadWorld } from './drawnGeometry'
import { DrawnRenderer, type DrawCtx } from './drawnTile'
import { TILE_PX } from './tilePyramid'

/**
 * The drawn map's tile source, off the main thread.
 *
 * It owns the geometry as well as the pen: the 1.1 MB of TopoJSON is fetched
 * and decoded HERE, so the ~350 ms of parsing and the ~3 MB of typed arrays
 * never touch the thread that is drawing the globe, and there is nothing to
 * transfer per tile but the finished 512² bitmap.
 *
 * The reply is an `ImageBitmap` and it is transferred, which makes a tile cost
 * the same as a decoded WMS tile at the point where the pipeline takes it: the
 * atlas uploads one, the cache holds one, and `DetailImagery` cannot tell the
 * difference. That is the whole architectural claim — a local vector rasterizer
 * is just another tile source — reduced to a message shape.
 */

export interface DrawnTileRequest {
  id: number
  base: string
  z: number
  x: number
  y: number
}

export interface DrawnTileResponse {
  id: number
  bitmap?: ImageBitmap
  /** Wall time of the render itself, so the budget can be asserted from outside. */
  ms: number
  /**
   * Announced once, when the 50m geometry has parsed and the drawing changes.
   *
   * The caller has to know, and the reason is the cache. A tile is keyed by
   * (z, x, y, source label) and held for as long as it is wanted, so the tiles
   * drawn in the first second — from 110m coastline, with no borders, rivers or
   * lakes in the file at all — would be the tiles that view keeps forever. The
   * label changes when this arrives, which retires them by making every key a
   * new one; the old ones fall out of the cache unwanted.
   */
  upgraded?: true
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<DrawnTileRequest>) => void) | null
  postMessage(message: DrawnTileResponse, transfer?: Transferable[]): void
}

let renderer: Promise<DrawnRenderer> | undefined
let surface: OffscreenCanvas | undefined
let g2d: OffscreenCanvasRenderingContext2D | null = null

ctx.onmessage = async (e: MessageEvent<DrawnTileRequest>) => {
  const { id, base, z, x, y } = e.data
  try {
    // The coarse coastline resolves first and the fine one replaces it in
    // place, so the first tiles of a session are drawn before the 50m parse
    // would allow. A tile drawn from 110m is not wrong, only blunt — and it has
    // no borders, rivers or lakes at all, because those live only in the other
    // two files — so the upgrade is announced and the caller retires them.
    renderer ??= loadWorld(base, () => ctx.postMessage({ id: 0, ms: 0, upgraded: true })).then(
      (w) => new DrawnRenderer(w),
    )
    const drawn = await renderer
    if (!surface) {
      surface = new OffscreenCanvas(TILE_PX, TILE_PX)
      g2d = surface.getContext('2d', { willReadFrequently: false })
    }
    if (!g2d) throw new Error('no 2d context')
    const t0 = performance.now()
    drawn.draw(g2d as unknown as DrawCtx, { z, x, y })
    const ms = performance.now() - t0
    const bitmap = surface.transferToImageBitmap()
    ctx.postMessage({ id, bitmap, ms }, [bitmap])
  } catch {
    // A refused tile is a hole the pyramid already knows how to fill from the
    // level above it; there is nothing to say and nothing to retry.
    ctx.postMessage({ id, ms: 0 })
  }
}
