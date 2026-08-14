import { loadWorld, unpackLayer, type DrawnStage, type PackedLayer } from './drawnGeometry'
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

/**
 * …or the other message this worker takes: a finer land layer, already decoded.
 *
 * It arrives instead of being fetched here, which is the round-58 fix — see
 * lib/drawnDecode.worker.ts for what it cost when this thread did it itself.
 * Installing is `unpackLayer` plus one assignment: the shapes are views onto
 * the transferred buffers, so nothing is walked and nothing is copied, and the
 * next tile drawn at level 7 or finer draws from 10m.
 */
export interface DrawnFineMessage {
  fine: PackedLayer
}

/**
 * …and the third: START, with nothing to draw yet.
 *
 * The geometry is loaded on the first tile request, which is the right rule for
 * a worker nobody has asked anything of — but it means the first tile of map
 * mode waits for a fetch and a parse that could have happened while the reader
 * was still moving a pointer toward the toggle. This message is that pointer:
 * it does the load and answers nothing, so the first real request finds the
 * world already there. Asking twice is free — `world()` memoises on `renderer`.
 */
export interface DrawnPrimeMessage {
  prime: true
  base: string
}

type DrawnMessage = DrawnTileRequest | DrawnFineMessage | DrawnPrimeMessage

export interface DrawnTileResponse {
  id: number
  bitmap?: ImageBitmap
  /** Wall time of the render itself, so the budget can be asserted from outside. */
  ms: number
  /**
   * When this worker PICKED THE REQUEST UP, as an epoch millisecond.
   *
   * `ms` says what a tile costs; this says what it waited, which is the number
   * round 58 was about and the one `ms` structurally cannot show. A tile that
   * draws in 0.4 ms and lands a second after it was asked for did not get
   * slower — it sat in this worker's message queue behind something that was
   * not a tile. Epoch-based (`timeOrigin + now`) because the caller's clock and
   * a worker's `performance.now` have different origins and the subtraction has
   * to mean something across them.
   */
  at?: number
  /**
   * Announced when a finer file has parsed and the drawing changes: '50m' on
   * load, '10m' only if somebody drew a plate fine enough to ask for it.
   *
   * The caller has to know, and the reason is the cache. A tile is keyed by
   * (z, x, y, source label) and held for as long as it is wanted, so the tiles
   * drawn in the first second — from a 110m coastline, with no rivers or lakes in
   * the file at all — would be the tiles that view keeps forever. The
   * label changes when this arrives, which retires them by making every key a
   * new one; the old ones fall out of the cache unwanted.
   */
  upgraded?: DrawnStage
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<DrawnMessage>) => void) | null
  postMessage(message: DrawnTileResponse, transfer?: Transferable[]): void
}

let renderer: Promise<DrawnRenderer> | undefined
let surface: OffscreenCanvas | undefined
let g2d: OffscreenCanvasRenderingContext2D | null = null

/** A rung that arrived before the first tile did; installed by whoever is second. */
let parked: PackedLayer | undefined

/**
 * Install a decoded rung, and say so.
 *
 * The announcement is what retires the tiles drawn from 50m: the caller renames
 * the source, the cache is keyed by that name, and the view asks for a set of
 * keys that does not exist yet. Announcing AFTER the assignment is not a
 * detail — the first tile of the new label must find the new geometry here.
 */
function install(drawn: DrawnRenderer, fine: PackedLayer) {
  drawn.world.fineLand = unpackLayer(fine)
  ctx.postMessage({ id: 0, ms: 0, upgraded: '10m' })
}

/** `fine: false` — the 10m rung is decoded elsewhere and installed below. */
const world = (base: string) =>
  (renderer ??= loadWorld(base, (stage) => ctx.postMessage({ id: 0, ms: 0, upgraded: stage }), {
    fine: false,
  }).then((w) => new DrawnRenderer(w)))

ctx.onmessage = async (e: MessageEvent<DrawnMessage>) => {
  const fine = (e.data as DrawnFineMessage).fine
  if (fine) {
    // The renderer may not exist yet — a reader who opens the app already
    // zoomed in can have the rung arrive before the first tile is asked for —
    // and `world()` needs a base URL it does not have here. So the layer is
    // parked, and whichever of the two arrives second does the installing.
    const held = renderer
    if (held) void held.then((drawn) => install(drawn, fine))
    else parked = fine
    return
  }
  // The prewarm: load the world and say nothing. The scratch canvas is left
  // alone — it is one allocation and it is not what the first tile waits for.
  if ((e.data as DrawnPrimeMessage).prime) {
    void world((e.data as DrawnPrimeMessage).base)
    return
  }
  const { id, base, z, x, y } = e.data as DrawnTileRequest
  const at = performance.timeOrigin + performance.now()
  try {
    // The coarse coastline resolves first and the fine one replaces it in
    // place, so the first tiles of a session are drawn before the 50m parse
    // would allow. A tile drawn from 110m is not wrong, only blunt — and it has
    // no rivers and no lakes at all, because those live only in the other file — so the upgrade is announced and the caller retires them.
    const drawn = await world(base)
    if (parked) {
      install(drawn, parked)
      parked = undefined
    }
    if (!surface) {
      surface = new OffscreenCanvas(TILE_PX, TILE_PX)
      g2d = surface.getContext('2d', { willReadFrequently: false })
    }
    if (!g2d) throw new Error('no 2d context')
    const t0 = performance.now()
    drawn.draw(g2d as unknown as DrawCtx, { z, x, y })
    const ms = performance.now() - t0
    const bitmap = surface.transferToImageBitmap()
    ctx.postMessage({ id, bitmap, ms, at }, [bitmap])
  } catch {
    // A refused tile is a hole the pyramid already knows how to fill from the
    // level above it; there is nothing to say and nothing to retry.
    ctx.postMessage({ id, ms: 0 })
  }
}
