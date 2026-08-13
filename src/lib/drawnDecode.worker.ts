import { layerOf, packLayer, packedBuffers, MAP_DATA, type PackedLayer } from './drawnGeometry'

/**
 * THE SECOND WORKER, and the only thing it does is not draw.
 *
 * Round 57 put a third rung on the drawn map — Natural Earth 10m, 3.3 MB of
 * JSON, 441 974 points, cut into cells at decode — and fetched it from inside
 * the tile worker the first time a plate was drawn at level 7. That is the
 * right TRIGGER and was the wrong THREAD. Measured (scripts/measure-drawn.mjs
 * and tests/e2e/drawnPerf.e2e.mjs):
 *
 *     JSON.parse of land-10m.json          ~140–260 ms
 *     layerOf + chunkShape                 ~510–670 ms
 *     one 512² tile at those levels        0.27–0.62 ms
 *
 * So the decode is between fifteen hundred and three thousand tiles' worth of
 * uninterruptible work, on the one thread that answers tile requests, started
 * by a reader who is halfway through a zoom — because crossing level 7 is what
 * triggers it and crossing level 7 is a gesture, not a resting state. Every
 * tile of the rest of that gesture queued behind it: the atlas absorbs two
 * slots a frame and had nothing to absorb for forty frames, so the picture
 * stopped sharpening exactly where the reader was pushing it. That is the "map
 * mode struggles especially when zooming in" report, and it is not a slow
 * rasterizer — the rasterizer was idle, waiting for a JSON parse.
 *
 * A worker cannot yield in the middle of `JSON.parse`, and slicing the cut into
 * idle chunks would still leave the parse whole, so the answer is the other
 * thread. This one has no canvas and no renderer; it fetches, decodes, cuts,
 * packs and dies. What comes back is nine transferable typed arrays
 * (`packLayer`), which is why handing 7.5 MB of geometry to the renderer costs
 * neither a copy nor a stall on the thread that receives it.
 */

export interface DrawnDecodeRequest {
  /** The app's base URL; the data lives under `${base}data/map/`. */
  base: string
}

export interface DrawnDecodeResponse {
  fine?: PackedLayer
  /** Decode wall time, so the cost this round moved can still be quoted. */
  ms: number
  /** Set when the file could not be fetched or parsed at all. */
  failed?: boolean
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<DrawnDecodeRequest>) => void) | null
  postMessage(message: DrawnDecodeResponse, transfer?: Transferable[]): void
}

ctx.onmessage = async (e: MessageEvent<DrawnDecodeRequest>) => {
  const { base } = e.data
  try {
    const topo = await fetch(`${base}data/map/${MAP_DATA.finest}`).then((r) => r.json())
    const t0 = performance.now()
    const packed = packLayer(layerOf(topo, 'land', true, { chunk: true }))
    const ms = performance.now() - t0
    ctx.postMessage({ fine: packed, ms }, packedBuffers(packed))
  } catch {
    // A rung that does not arrive is a map that keeps the coastline it has.
    // There is nobody to retry for: the trigger fires once per session.
    ctx.postMessage({ ms: 0, failed: true })
  }
}
