import type { Tile } from './tilePyramid'
import { TILE_PX } from './tilePyramid'
import type { TileSource } from './detailImagery'
import { DrawnRenderer, LOD_FINE_Z, type DrawCtx } from './drawnTile'
import { loadWorld, packedBuffers, unpackLayer, type DrawnStage } from './drawnGeometry'
import type { DrawnTileRequest, DrawnTileResponse } from './drawnTile.worker'
import type { DrawnDecodeResponse } from './drawnDecode.worker'

/**
 * The drawn map as a TILE SOURCE — the whole of the pipeline integration.
 *
 * There is no second rendering path. `DetailImagery` asks a source for a tile
 * and gets back something the atlas can upload; a WMS source answers with an
 * `Image` off the network and this one answers with an `ImageBitmap` off a
 * worker. Everything downstream — `tilesCovering`, `TileCache` (already keyed by
 * source label), the in-flight cap, the prefetch ring, the slot map, the
 * per-slot dissolve, the shader's index — is the same code doing the same thing.
 *
 * What is different, and what the constants below record, is that the answers
 * to "how far does this source go" and "in which years is it honest" are
 * properties of a DRAWING rather than of a satellite.
 */

/**
 * The finest level worth rendering. Was 9 on 50m data; 10m moved it to 11.
 *
 * The rule is round 49's, unchanged, and it is worth restating because it is
 * what makes this number a measurement rather than a preference:
 *
 *  · the vector data SATURATES at some level — every vertex it owns survives
 *    the half-pixel filter — and past that a finer level is the same polyline
 *    magnified. For 50m that is level 6; for 10m it is level 8.
 *  · the PEN does not saturate with it. Ink is 1.15 tile pixels at every level
 *    by design (a drawn map's line weight does not change with the scale it is
 *    printed at), so stopping at saturation and letting the pyramid magnify
 *    would put a coastline on screen 2ⁿ times too heavy — the one thing a
 *    drawing cannot survive, where a photograph merely goes soft.
 *  · so the ceiling is where the facets themselves become the picture: the
 *    finest level at which the median segment of the data is still under about
 *    seventy tile pixels of straight line.
 *
 * Both halves move by the same two levels, which is why the answer does:
 *
 *     data   saturates   median segment   that segment at Z_MAX   Z_MAX
 *      50m       6         0.0985° / 7.6 km    71.7 px at z9        9
 *      10m       8         0.0176° / 1.5 km    51.3 px at z11      11
 *
 * Level 12 is refused by both halves: the median facet there is 103 px, longer
 * than anything this map has ever shipped, and a reader cannot reach it anyway
 * — `MIN_ALTITUDE_DETAIL` holds the closest view at a 100 km frame, which wants
 * level 11 on a desktop. The ceiling now matches the camera instead of being
 * two levels under it, and the drawing AT the ceiling is finer than the old
 * ceiling's was (51 px of facet against 72).
 */
export const DRAWN_Z_MAX = 11

/**
 * The level the vector data stops adding segments at. Measured; see above.
 *
 * This is 10m's saturation, because 10m is what the source serves at the levels
 * near the ceiling. 50m's is 6 and 110m's is 4; both are asserted in
 * tests/drawnMap.test.ts, because the three together are what say that each
 * rung is a rung and not a preference.
 */
export const DRAWN_GEOMETRY_Z = 8

/**
 * The year drawn tiles start streaming.
 *
 * NOT the imagery era. `IMAGERY_ERA_FROM` is 1930 because a photograph of a
 * motorway makes a claim about the century it was taken in; a drawn coastline
 * makes no such claim, and the drawn map is at its most useful in exactly the
 * centuries a satellite is least honest about. So the 1930 rule and the zoom
 * clamp behind it do not apply here.
 *
 * What does apply is the coastline itself, and the gate is the one the design
 * asked for: drawn tiles stream in every year the MODERN BASEMAP is the
 * basemap, and in no other. −10 000 is that year — it is where `PALEO_FRAMES`
 * pins the modern map and stops interpolating reconstructions — so a drawn tile
 * can never sharpen a coast the base texture underneath it disagrees with.
 * Before it, the paleo frames drive the surface and pass through the paper
 * grade instead (see `paperMix` in lib/present/globe.ts).
 *
 * The honest limit, written down: between −10 000 and roughly −4 000 sea level
 * was still rising, so Doggerland, Sundaland and the Persian Gulf are wrong on
 * this map. That is a claim the pinned modern basemap already makes; the drawn
 * tiles do not add a new one, they only sharpen it.
 */
export const DRAWN_ERA_FROM = -10_000

/**
 * Provenance, shown in the panel exactly as a sensor's would be — and, for the
 * first second of a session, the CACHE KEY that retires the first tiles drawn.
 *
 * The rasterizer starts on the 55 kB 110m coastline and switches to the 50m
 * files (the finer coast, and the rivers and lakes, which only exist there)
 * when they have parsed. Tiles are keyed by source label and pinned while
 * wanted, so without two labels the tiles a view happened to ask for in that
 * window would be the tiles it kept — measured in the browser as a Europe at
 * continental zoom with a blunt coast and no rivers on it, indefinitely.
 */
export const DRAWN_LABEL = 'Drawn — Natural Earth 50m'
export const DRAWN_LABEL_COARSE = 'Drawn — Natural Earth 110m'
/**
 * …and the third, which arrives on demand rather than on load.
 *
 * The 10m file is 851 kB gzipped and is fetched the first time a plate is drawn
 * at `LOD_FINE_Z` or finer, so this label appears only for a reader who has
 * zoomed to a coast. It retires the 50m tiles for exactly the reason the 50m
 * label retires the 110m ones — the cache is keyed by label and pins what the
 * view wants, so a Norway that arrived a second before the upgrade would keep
 * its blunter coastline for as long as anyone looked at it.
 *
 * Note what the label does NOT claim: that every tile under it is drawn from
 * 10m geometry. It is a stamp on the geometry the renderer HOLDS. A level-5
 * plate is still drawn from 50m (see `landAt`) because at level 5 the two are
 * the same drawing, and it is cached under this name because that is the state
 * of the world it came out of.
 */
export const DRAWN_LABEL_FINE = 'Drawn — Natural Earth 10m'

/** Which label each parse stage brings, and in which order they may arrive. */
export const DRAWN_LABELS: Record<DrawnStage, string> = {
  '50m': DRAWN_LABEL,
  '10m': DRAWN_LABEL_FINE,
}
const STAGE_RANK: Record<string, number> = {
  [DRAWN_LABEL_COARSE]: 0,
  [DRAWN_LABEL]: 1,
  [DRAWN_LABEL_FINE]: 2,
}

export const DRAWN_ATTRIBUTION =
  'Coastlines, rivers and lakes: Natural Earth (public domain), drawn on device'

/**
 * Pixels per degree the source can honestly serve.
 *
 * A vector source has no native resolution, so this is derived from `Z_MAX`
 * rather than the other way round — the same relation `maxLevel` expresses for
 * a raster source, read backwards. It exists so that anything reasoning about
 * sources in general (the panel's ground-resolution line) gets a number that
 * means the same thing here as it does for Sentinel-2.
 */
export const DRAWN_PX_PER_DEG = (TILE_PX * 2 ** DRAWN_Z_MAX) / 360

/**
 * A rendered tile, from a worker where the platform allows and from this thread
 * where it does not.
 *
 * The fallback is not a token: `OffscreenCanvas` is the only part of this that
 * is not universal, and without it the geometry parse (~350 ms) and every tile
 * (~1 ms) land on the main thread. That is affordable precisely because the
 * measurement says a tile is a millisecond — the fallback is slower than the
 * worker and still inside a frame.
 */
export class DrawnTiles {
  readonly source: TileSource
  /**
   * The same rasterizer under a label the 10m rung never touches.
   *
   * `landAt` only reaches for 10m geometry from `LOD_FINE_Z` up, so a tile
   * below that level is byte-identical before and after the rung lands — and
   * retiring it anyway (which one label for the whole pyramid did) re-rendered
   * and re-uploaded the entire coarse pyramid for pixels that could not
   * change. Measured on the scripted city→world zoom out: 21 re-renders of
   * world- and continental-level tiles, every one of them identical to the
   * tile it replaced. So the plan answers `sourceFor(z)`: levels at and above
   * the rung stream under the fine label and are retired by it; levels below
   * keep the 50m label for as long as the session lives, which is also the
   * honest provenance — that is the data they are drawn from.
   */
  readonly coarseSource: TileSource
  private worker?: Worker
  private pending = new Map<number, (r: DrawnTileResponse) => void>()
  /** When each request was posted, on the same epoch clock the worker stamps. */
  private sentAt = new Map<number, number>()
  private next = 1
  /** Main-thread path: the renderer, the scratch canvas, and its context. */
  private local?: Promise<DrawnRenderer>
  private canvas?: HTMLCanvasElement
  /** Render times, newest last — the budget is asserted from outside. */
  readonly times: number[] = []
  /**
   * How long each tile waited in the worker's queue before it was picked up.
   *
   * The companion to `times`, and the one round 58 exists for: `times` is what
   * a tile costs and this is what it cost to be behind something. Kept for the
   * same reason — a claim about a queue is assertable from outside or it is a
   * story (tests/e2e/drawnPerf.e2e.mjs).
   */
  readonly waits: number[] = []
  /** Fires when a finer file lands and the label changes under the caller. */
  onUpgrade?: () => void
  /** The 10m rung: one decode, in its own worker, at most once a session. */
  private decoder?: Worker
  private askedFine = false
  /** Whether `prime` has already been sent; see it. */
  private primed = false
  /**
   * What that decode cost, as the worker that did it measured it.
   *
   * Quoted rather than inferred because it is the number this round moved: the
   * same milliseconds used to be spent on the thread that draws tiles.
   */
  fineDecodeMs?: number

  constructor(private base = '/') {
    this.source = {
      label: DRAWN_LABEL_COARSE,
      pxPerDeg: DRAWN_PX_PER_DEG,
      attribution: DRAWN_ATTRIBUTION,
      render: (t) => this.render(t),
    }
    this.coarseSource = {
      label: DRAWN_LABEL_COARSE,
      pxPerDeg: DRAWN_PX_PER_DEG,
      attribution: DRAWN_ATTRIBUTION,
      render: (t) => this.render(t),
    }
    this.worker = this.spawn()
  }

  /** Which source label a pyramid level streams under; see `coarseSource`. */
  sourceFor(z: number): TileSource {
    return z >= LOD_FINE_Z ? this.source : this.coarseSource
  }

  private spawn(): Worker | undefined {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return undefined
    try {
      const w = new Worker(new URL('./drawnTile.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<DrawnTileResponse>) => {
        if (e.data.upgraded) return this.upgrade(e.data.upgraded)
        const done = this.pending.get(e.data.id)
        this.pending.delete(e.data.id)
        if (e.data.ms) this.times.push(e.data.ms)
        const sent = this.sentAt.get(e.data.id)
        this.sentAt.delete(e.data.id)
        if (sent !== undefined && e.data.at !== undefined)
          this.waits.push(Math.max(0, e.data.at - sent))
        done?.(e.data)
      }
      // A worker that dies takes the drawn map with it, which is worse than a
      // slow one: fall back rather than leave the globe on bare base texture.
      w.onerror = () => {
        this.worker = undefined
        for (const [, done] of this.pending) done({ id: 0, ms: 0 })
        this.pending.clear()
        this.sentAt.clear()
      }
      return w
    } catch {
      return undefined
    }
  }

  /**
   * A finer file has landed, so everything drawn before it is a different map.
   *
   * Renaming the source is the whole mechanism: `DetailImagery` builds its cache
   * keys from the label on every frame, so the next frame wants a set of tiles
   * that does not exist yet and asks for them, and the older ones stop being
   * wanted and fall out of the cache on their own.
   *
   * Ranked rather than replaced, because two stages are now in flight and their
   * order is not guaranteed: a reader who opens the app already zoomed in asks
   * for 10m from the first tile drawn, and a slow 50m response behind a fast
   * 10m one would otherwise rename the source BACKWARDS and retire the better
   * tiles in favour of blunter ones.
   */
  private upgrade(stage: DrawnStage) {
    const label = DRAWN_LABELS[stage]
    let changed = false
    if (STAGE_RANK[label] > STAGE_RANK[this.source.label]) {
      this.source.label = label
      changed = true
    }
    // The coarse levels' label is capped at the 50m stage: 10m geometry is
    // never consulted below LOD_FINE_Z (`landAt`), so those tiles are the same
    // drawing whichever rung is resident and must not be retired by it.
    const cap = STAGE_RANK[label] > STAGE_RANK[DRAWN_LABEL] ? DRAWN_LABEL : label
    if (STAGE_RANK[cap] > STAGE_RANK[this.coarseSource.label]) {
      this.coarseSource.label = cap
      changed = true
    }
    if (changed) this.onUpgrade?.()
  }

  /**
   * THE 10m RUNG IS ASKED FOR HERE, one step earlier in the same causal chain.
   *
   * Round 57 asked for it from inside the rasterizer — `DrawnRenderer.draw`
   * calls `world.requestFine()` on the first plate at level ≥ 7 — which is the
   * right trigger and the wrong place to run it from: the fetch's `then` is
   * ~700 ms of parse and cut on the thread that draws tiles, and the reader who
   * triggers it is by definition mid-zoom. So the trigger moves to the only
   * other place that knows the same fact one moment sooner — a TILE REQUEST at
   * level 7, which is what causes the plate to be drawn — and the work goes to
   * a worker with no canvas in it.
   *
   * The network claim round 57 made is unchanged and still checked as network
   * traffic (drawnMap.e2e.mjs, c2): the file is fetched when a reader reaches a
   * coast, never at load, never for a world or continental view, and once.
   */
  private requestFine() {
    // No workers at all: the rasterizer keeps round 57's behaviour and fetches
    // the file itself from inside `draw` (`loadWorld(…, { fine: true })` in
    // `renderHere`), because a page with no worker has nowhere better to put
    // the work — and it is already drawing tiles on the main thread.
    if (this.askedFine || typeof Worker === 'undefined') return
    this.askedFine = true
    try {
      this.decoder = new Worker(new URL('./drawnDecode.worker.ts', import.meta.url), {
        type: 'module',
      })
    } catch {
      return
    }
    this.decoder.onmessage = (e: MessageEvent<DrawnDecodeResponse>) => {
      const fine = e.data.fine
      this.fineDecodeMs = e.data.ms
      // One decode, then nothing: the layer is 7.5 MB of typed arrays and the
      // JSON it came from is larger still, and neither is wanted again.
      this.decoder?.terminate()
      this.decoder = undefined
      if (!fine) return
      // Straight through to the renderer, buffers transferred, so this thread
      // touches none of the geometry it is carrying. Where there is no tile
      // worker, the local renderer takes it in place — the same unpack.
      if (this.worker) this.worker.postMessage({ fine }, packedBuffers(fine))
      else
        void this.local?.then((drawn) => {
          drawn.world.fineLand = unpackLayer(fine)
          this.upgrade('10m')
        })
    }
    this.decoder.onerror = () => {
      this.decoder?.terminate()
      this.decoder = undefined
    }
    this.decoder.postMessage({ base: this.base })
  }

  /**
   * Start the geometry load without asking for a tile.
   *
   * The worker fetches and parses the vector world on the first tile request,
   * so the first tile of map mode has always waited for it — and that wait is
   * inside the toggle, which is where round 61's field report put it ("switching
   * to it is slow / staggers"). This is called on INTENT (a pointer arriving at
   * the mode control), so the fetch and the parse overlap the reader's own
   * movement instead of the switch.
   *
   * Idempotent, and it answers nothing: the worker memoises the loaded world,
   * and the first real request finds it there. Without a worker there is
   * nothing to prime — `renderHere` loads the world on its own first tile, on
   * the same thread, and starting that early would move a main-thread parse
   * into a frame rather than out of one.
   */
  prime() {
    if (this.primed || !this.worker) return
    this.primed = true
    this.worker.postMessage({ prime: true, base: this.base })
  }

  private render(t: Tile): Promise<CanvasImageSource> {
    if (t.z >= LOD_FINE_Z) this.requestFine()
    return this.worker ? this.renderInWorker(t) : this.renderHere(t)
  }

  private renderInWorker(t: Tile): Promise<CanvasImageSource> {
    const id = this.next++
    const req: DrawnTileRequest = { id, base: this.base, z: t.z, x: t.x, y: t.y }
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => (r.bitmap ? resolve(r.bitmap) : reject(new Error('drawn'))))
      // NOT `Date.now`: it is what the pipeline's own clock is, which a test
      // harness is entitled to virtualise, and a queue wait has to be real.
      this.sentAt.set(id, performance.timeOrigin + performance.now())
      this.worker!.postMessage(req)
    })
  }

  /**
   * …and without a worker: one scratch canvas, drawn and then COPIED.
   *
   * The copy is not optional. The cache holds the returned image for as long as
   * the tile is wanted, and handing back the scratch canvas would mean every
   * cached tile is the same canvas showing whatever was drawn last.
   */
  private async renderHere(t: Tile): Promise<CanvasImageSource> {
    if (typeof document === 'undefined') throw new Error('no canvas')
    // The rasterizer only fetches the 10m rung itself where there is no worker
    // to fetch it in; otherwise `requestFine` above owns it and asking twice
    // would download 3.3 MB twice.
    this.local ??= loadWorld(this.base, (stage) => this.upgrade(stage), {
      fine: typeof Worker === 'undefined',
    }).then((w) => new DrawnRenderer(w))
    const drawn = await this.local
    const canvas = (this.canvas ??= Object.assign(document.createElement('canvas'), {
      width: TILE_PX,
      height: TILE_PX,
    }))
    const g2d = canvas.getContext('2d')
    if (!g2d) throw new Error('no 2d context')
    const t0 = performance.now()
    drawn.draw(g2d as unknown as DrawCtx, t)
    this.times.push(performance.now() - t0)
    if (typeof createImageBitmap === 'function') return createImageBitmap(canvas)
    const copy = document.createElement('canvas')
    copy.width = copy.height = TILE_PX
    copy.getContext('2d')?.drawImage(canvas, 0, 0)
    return copy
  }

  dispose() {
    this.worker?.terminate()
    this.worker = undefined
    this.decoder?.terminate()
    this.decoder = undefined
    this.pending.clear()
    this.sentAt.clear()
  }
}
