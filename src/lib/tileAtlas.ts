import {
  DataTexture,
  FramebufferTexture,
  LinearFilter,
  NearestFilter,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  Vector2,
  type WebGLRenderer,
} from 'three'
import type { Bbox } from './detailImagery'
import { BASE_LEVEL, TILE_PX, tileCols, tilesCovering, type Tile } from './tilePyramid'

/**
 * One GPU-resident texture holding the pyramid tiles the view is made of, and
 * the small index that tells the shader where each of them landed.
 *
 * What this replaces: a canvas-2D composite of the whole view, re-uploaded in
 * full with `generateMipmap` on every arrival — 111 ms measured per publish at a
 * desktop composite size, and the reason the pipeline had to defer publishes
 * through a gesture and sharpen only at rest. None of that machinery describes
 * anything a user wants; it exists because the shader was handed one rectangle
 * of pixels and the CPU had to assemble it.
 *
 * Here a tile arrival is one `texSubImage2D` into a slot of an immutable
 * texture, and the *shader* assembles the picture: a surface point resolves to a
 * tile, the tile to a slot, the slot to a rectangle of the atlas. There is
 * nothing to defer, so there is no deferral.
 *
 * Two rules the layout is built around:
 *
 *  - **No mipmaps on the atlas.** A mip chain averages across slot boundaries,
 *    so level 3 of a 4096 atlas mixes eight tiles of unrelated ground into every
 *    texel. Minification is handled by choosing a coarser pyramid level instead
 *    — `targetLevel` already tracks screen density — and below streaming range
 *    the base map covers everything, so the atlas never has to minify far.
 *  - **A half-texel gutter on every sample.** Without mips the only bleed left
 *    is bilinear reaching one texel past a slot's edge into its neighbour.
 *    Clamping the in-slot coordinate to [0.5, 511.5] texels is exactly what
 *    CLAMP_TO_EDGE would do for a standalone tile, so the geometry inside the
 *    tile is untouched and only the outermost half texel is held.
 */

/** Slots across the atlas. 8x8 of 512 px is 4096², the field's smallest ceiling. */
export const ATLAS_COLS = 8
export const ATLAS_SLOTS = ATLAS_COLS * ATLAS_COLS
export const ATLAS_PX = ATLAS_COLS * TILE_PX

/**
 * Every tile is held twice: sharp, and reduced to the base map's own scale.
 *
 * The shader does not paint the patch on; it divides the sharp tap by a blurred
 * one and multiplies the base map by the ratio, so that Sentinel-2 contributes
 * *structure* and NASA keeps the colour (see globeSurface). The blurred tap used
 * to be a mip of the composite — level `z - 3`, where the patch's density meets
 * the 4096-wide world map's. With no mip chain on the atlas that tap has to come
 * from somewhere, and a second small atlas is a better answer than a chain: it
 * is the same sensor low-passed by a real filter, it cannot bleed across slots,
 * and it costs 1 MB and one 64² upload per tile.
 *
 * 64 px per slot because that is where the reduction bottoms out: a level-`z`
 * tile at the base map's density is `4096 / 2^z` texels, which is 64 at z = 6
 * and smaller above it — 4 texels at z = 10, one at z = 12, where a whole tile
 * really is one base-map texel. Levels below 6 are reduced less far than they
 * should be (2 octaves at z = 4), so the ratio there transfers a band the base
 * map already carries; that range is a 2–8x magnification of the base map where
 * the gain is small anyway, and the [0.55, 1.8] clamp bounds it.
 */
export const LOW_PX = 64
export const LOW_ATLAS_PX = ATLAS_COLS * LOW_PX

/** Reduced size of a level-z tile at the base map's own density, in texels. */
export const lowTapPx = (z: number): number =>
  Math.max(1, Math.min(LOW_PX, Math.round(TILE_PX * 2 ** (BASE_LEVEL - z))))

/**
 * How long a newly resident tile takes to dissolve in.
 *
 * A tile arriving is a step change in the sharpness of a piece of ground, and a
 * step is what reads as a pop. 200 ms is long enough to be a transition and
 * short enough that a pan does not trail visibly soft ground behind it. The
 * render pump has to stay awake for the whole of it — see `AtlasIndex.fading`.
 */
export const FADE_MS = 200

/** How far through its dissolve a slot is: 0 the instant it lands, 1 at FADE_MS. */
export const fadeAt = (bornAt: number, now: number): number =>
  Math.max(0, Math.min(1, (now - bornAt) / FADE_MS))

/**
 * Slot uploads per frame.
 *
 * A 512² `texSubImage2D` is ~1 MB and measured in hundreds of microseconds; two
 * is a megabyte a frame, which fills a view in a handful of frames without ever
 * being the reason a frame is late. The rest of a burst waits, and waiting costs
 * nothing visible because the parent level is already under it.
 */
export const ATLAS_UPLOADS_PER_FRAME = 2

/**
 * …and the window that budget is spent over.
 *
 * "Per frame" cannot be counted in calls, because `update` is not called once
 * per frame: the camera-change handler and the render tick can both reach it in
 * the same animation frame, and a zoom reaches it three times. Measured before
 * this, a pan peaked at 4.26 MB in one frame and a zoom at 6.39 MB — exactly two
 * and three times the intended budget, which is the giveaway. A token bucket on
 * the clock says what was meant instead: two slots per frame's worth of time,
 * however many callers ask.
 */
export const UPLOAD_WINDOW_MS = 16

/**
 * The index texture: 16 wide, 16 tall, RGBA8.
 *
 * Rows 0..7 are the target level's grid and rows 8..15 the parent's, both
 * addressed by `texelFetch` — an integer fetch, so there is no filtering to
 * round the wrong way and no derivative to be undefined. R is the slot, offset
 * by one so that zero means absent; G is the fade, 0..255.
 *
 * A uniform array was the alternative and is worse here: 80 floats is 80 vec4
 * registers on most drivers against a guaranteed floor of 224 for the whole
 * fragment stage, and this shader already carries the era, night, relief and
 * cloud constants.
 */
export const INDEX_W = 16
export const INDEX_ROWS = 8

/** The grid a set of tiles occupies: origin column, origin row, width, height. */
export type Grid = [number, number, number, number]

/**
 * …and the origin is found the LONG WAY ROUND when the set crosses ±180.
 *
 * A view straddling the antimeridian wants columns 254, 255, 0, 1 of a
 * 256-column level. Read as plain minimum and maximum that is origin 0 and
 * width 256 — a grid twenty times the index texture, which `atlasCell` then
 * rejects wholesale, so nothing on either side of the seam resolves to a slot
 * and the whole frame falls back to the base map. Round 51 reported it as a
 * hard boundary in the middle of the Pacific with the near side sharp and the
 * far side not.
 *
 * The origin is therefore the column after the widest gap in the cyclic
 * sequence, and the width is what is left: 254 and 4 for the set above, and the
 * plain answer for every set that does not wrap (whose widest gap is the one
 * containing the seam). Column counts come from the tiles' own level, so no
 * caller has to be told which world it is indexing.
 */
export const gridOf = (tiles: Tile[]): Grid => {
  if (!tiles.length) return [0, 0, 0, 0]
  let y0 = Infinity
  let y1 = -Infinity
  const seen = new Set<number>()
  for (const t of tiles) {
    y0 = Math.min(y0, t.y)
    y1 = Math.max(y1, t.y)
    seen.add(t.x)
  }
  const n = tileCols(tiles[0].z)
  const xs = [...seen].sort((a, b) => a - b)
  // the gap that wraps the seam, first — every other gap is measured against it
  let gap = xs[0] + n - xs[xs.length - 1]
  let x0 = xs[0]
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] - xs[i - 1] <= gap) continue
    gap = xs[i] - xs[i - 1]
    x0 = xs[i]
  }
  return [x0, y0, n - gap + 1, y1 - y0 + 1]
}

/** A tile's column in a grid, the short way round. */
export const gridCol = (x: number, x0: number, cols: number): number =>
  (((x - x0) % cols) + cols) % cols

/**
 * The finest level whose view *and* its parent fit the atlas.
 *
 * The old pipeline capped resolution with `patchPixelCap`: a composite could not
 * exceed 4096 px on a side, so a dense screen got imagery softer than itself.
 * The atlas is the same 4096² of texture and this is the same cap wearing
 * different clothes — except that it is spent as whole tiles rather than as a
 * rectangle, so 64 slots at 512 buy about 9x5 tiles of frame against the old
 * canvas's 4096x2304. Comparable ground, no canvas.
 *
 * Each step down quarters the tile count, so this converges in a couple of
 * iterations from any starting level.
 */
export function fitLevel(view: Bbox, z: number, capacity = ATLAS_SLOTS): number {
  for (let level = z; level > BASE_LEVEL + 1; level--) {
    const [, , gw, gh] = gridOf(tilesCovering(view, level))
    const [, , pw, ph] = gridOf(tilesCovering(view, level - 1))
    if (gw <= INDEX_W && gh <= INDEX_ROWS && gw * gh + pw * ph <= capacity) return level
  }
  return BASE_LEVEL + 1
}

/** A tile's residency: which slot holds it, and when it landed there. */
export interface Slot {
  index: number
  key: string
  bornAt: number
}

/**
 * Which tile is in which slot, and which slot is worth taking.
 *
 * Recency is the wanted set and nothing else, on exactly the terms `TileCache`
 * settled on: the shader reads every visible slot on every frame, so a
 * read-touched LRU would repeat what `pin` already says. `pin` is therefore both
 * "do not evict these" and "these are the newest", and there is one notion of
 * use rather than two that can disagree.
 *
 * A pin is absolute. `fitLevel` is what keeps that safe: the wanted set is
 * bounded to the capacity before anything is asked for, so "every slot is
 * pinned and none may be taken" is unreachable rather than merely unlikely.
 */
export class SlotMap {
  /** Insertion order is least-recently-wanted first. */
  private held = new Map<string, Slot>()
  private pinned = new Set<string>()
  private free: number[]

  constructor(private capacity = ATLAS_SLOTS) {
    this.free = Array.from({ length: capacity }, (_, i) => capacity - 1 - i)
  }

  get size(): number {
    return this.held.size
  }

  slotOf(key: string): Slot | undefined {
    return this.held.get(key)
  }

  has(key: string): boolean {
    return this.held.has(key)
  }

  /** The current wanted set: never evicted, and the most recently used. */
  pin(keys: Iterable<string>) {
    this.pinned = new Set(keys)
    for (const key of this.pinned) {
      const slot = this.held.get(key)
      if (!slot) continue
      this.held.delete(key)
      this.held.set(key, slot)
    }
  }

  /**
   * A slot for this tile: its own if it has one, a free one, else the
   * least-recently-wanted slot that is not pinned. `undefined` only if every
   * slot is pinned, which `fitLevel` rules out.
   */
  acquire(key: string, now: number): Slot | undefined {
    const held = this.held.get(key)
    if (held) return held
    let index = this.free.pop()
    if (index === undefined) {
      for (const [k, slot] of this.held) {
        if (this.pinned.has(k)) continue
        this.held.delete(k)
        index = slot.index
        break
      }
    }
    if (index === undefined) return undefined
    const slot: Slot = { index, key, bornAt: now }
    this.held.set(key, slot)
    return slot
  }

  /** 0 the instant a tile lands, 1 once it has fully dissolved in. */
  fade(slot: Slot, now: number): number {
    return fadeAt(slot.bornAt, now)
  }

  clear() {
    this.held.clear()
    this.pinned.clear()
    this.free = Array.from({ length: this.capacity }, (_, i) => this.capacity - 1 - i)
  }
}

/** Everything the shader needs to resolve a surface point to a slot. */
export interface AtlasIndex {
  z: number
  grid: Grid
  parent: Grid
  data: Uint8Array
  /** True while any resident tile is still dissolving in; the pump must not park. */
  fading: boolean
  /** Whether any target-level tile is resident — decides the quoted resolution. */
  sharp: boolean
  /** How many grid cells resolved to a slot; zero means the base map is all there is. */
  resident: number
}

const INDEX_BYTES = INDEX_W * INDEX_ROWS * 2 * 4

/**
 * Pack the visible grids into the index texture.
 *
 * Two grids, and the second is the whole point: where the target level has not
 * arrived the shader falls through to the parent's slot and shows that ground
 * coarse rather than showing base map. Coarse but present beats sharp but
 * absent, which is the trade Maps makes and the reason a pan does not tear.
 */
export function buildIndex(
  z: number,
  level: Tile[],
  fallback: Tile[],
  resolve: (t: Tile) => Slot | undefined,
  now: number,
  out = new Uint8Array(INDEX_BYTES),
): AtlasIndex {
  out.fill(0)
  const grid = gridOf(level)
  const parent = gridOf(fallback)
  let fading = false
  let sharp = false
  let resident = 0
  const write = (tiles: Tile[], [x0, y0, w, h]: Grid, rowBase: number, isTarget: boolean) => {
    for (const t of tiles) {
      // …the short way round, so a grid whose origin is 254 of 256 still places
      // columns 0 and 1 at cells 2 and 3 rather than at -254 and -253
      const gx = gridCol(t.x, x0, tileCols(t.z))
      const gy = t.y - y0
      if (gy < 0 || gx >= w || gy >= h || gx >= INDEX_W || gy >= INDEX_ROWS) continue
      const slot = resolve(t)
      if (!slot) continue
      const f = fadeAt(slot.bornAt, now)
      if (f < 1) fading = true
      if (isTarget) sharp = true
      resident++
      const i = ((rowBase + gy) * INDEX_W + gx) * 4
      out[i] = slot.index + 1
      out[i + 1] = Math.round(f * 255)
    }
  }
  write(fallback, parent, INDEX_ROWS, false)
  write(level, grid, 0, true)
  return { z, grid, parent, data: out, fading, sharp, resident }
}

/**
 * The GL half: two immutable textures and the index, plus the one call that puts
 * a decoded tile into a slot.
 *
 * `FramebufferTexture` is three's name for "allocate storage and upload
 * nothing", which is exactly an atlas: it takes the `texStorage2D` path with one
 * level and never the `texImage2D` path, so the storage is immutable and the
 * shape can never be renegotiated by a later upload. (That shape rule is the one
 * the composite path learned the hard way — re-flagging a texture whose canvas
 * had been resized landed the new image in the corner of the old allocation and
 * produced the nested-picture bug from the field.)
 *
 * `copyTextureToTexture` with an un-uploaded source texture compiles to exactly
 * one `texSubImage2D` of the tile into the slot, and — because `generateMipmaps`
 * is false on the destination — no `generateMipmap` at all.
 *
 * Without a renderer the whole class is bookkeeping: slots are still allocated
 * and the index is still built, which is what lets the allocation, fallback and
 * fade rules be unit-tested away from a GPU.
 */
export class TileAtlas {
  readonly sharp: Texture
  readonly low: Texture
  readonly index: DataTexture
  readonly slots: SlotMap
  private indexData = new Uint8Array(INDEX_BYTES)
  /** Reused reduction canvases, one per distinct low-tap size (at most five). */
  private reducers = new Map<number, CanvasRenderingContext2D>()
  private lowCanvas?: CanvasRenderingContext2D
  private at = new Vector2()
  /**
   * What this atlas has cost, for the instrument route (tests/e2e/atlas.e2e.mjs)
   * and for the unit tests, which have no GL to count calls in. `writes` is
   * tiles moved into slots, `uploads` the GL calls that took (two per tile: the
   * sharp slot and its reduction), `uploadedBytes` what they carried.
   */
  writes = 0
  uploads = 0
  uploadedBytes = 0

  constructor(private renderer?: WebGLRenderer, capacity = ATLAS_SLOTS) {
    this.slots = new SlotMap(capacity)
    this.sharp = new FramebufferTexture(ATLAS_PX, ATLAS_PX)
    this.low = new FramebufferTexture(LOW_ATLAS_PX, LOW_ATLAS_PX)
    for (const t of [this.sharp, this.low]) {
      t.colorSpace = SRGBColorSpace
      // Linear, never mipmapped: see the note at the top of this file. three
      // only calls generateMipmap for a FramebufferTexture whose minFilter asks
      // for mips, so this is also what keeps that call count at zero.
      t.minFilter = LinearFilter
      t.magFilter = LinearFilter
      t.generateMipmaps = false
      // The tile's own row order, kept. Row 0 of a tile is its northern edge,
      // and the shader measures v down from the tile's north edge to match.
      t.flipY = false
    }
    this.index = new DataTexture(this.indexData, INDEX_W, INDEX_ROWS * 2, RGBAFormat)
    this.index.minFilter = NearestFilter
    this.index.magFilter = NearestFilter
    this.index.generateMipmaps = false
    this.index.needsUpdate = true
  }

  /**
   * Put one decoded tile in a slot: one 512² upload, and one 64² upload of the
   * same tile reduced to the base map's density.
   *
   * The reduction is two `drawImage` calls on canvases a few kilobytes wide —
   * 512 down to the tile's base-map extent, then out to the fixed 64 the slot
   * holds — so the shader needs no per-level size and the second tap is a
   * genuine low-pass rather than a bilinear guess at one.
   */
  put(key: string, image: CanvasImageSource, z: number, now: number): Slot | undefined {
    const slot = this.slots.acquire(key, now)
    if (!slot) return slot
    this.writes++
    if (!this.renderer) return slot
    const x = (slot.index % ATLAS_COLS) * TILE_PX
    const y = Math.floor(slot.index / ATLAS_COLS) * TILE_PX
    this.blit(this.sharp, image, x, y, TILE_PX)
    const low = this.reduce(image, lowTapPx(z))
    if (low) {
      const lx = (slot.index % ATLAS_COLS) * LOW_PX
      const ly = Math.floor(slot.index / ATLAS_COLS) * LOW_PX
      this.blit(this.low, low, lx, ly, LOW_PX)
    }
    return slot
  }

  /** One `texSubImage2D`. No mip chain, no reallocation, no full-texture path. */
  private blit(dst: Texture, image: CanvasImageSource, x: number, y: number, px: number) {
    // A fresh wrapper every time, and deliberately never uploaded on its own:
    // three routes `copyTextureToTexture` through a framebuffer blit if the
    // source already has GL storage, and through a plain `texSubImage2D` if it
    // does not. The plain path is the one that costs nothing.
    const src = new Texture(image as HTMLImageElement)
    src.colorSpace = SRGBColorSpace
    this.at.set(x, y)
    this.renderer!.copyTextureToTexture(src, dst, null, this.at)
    this.uploads++
    this.uploadedBytes += px * px * 4
  }

  /** The tile at the base map's own density, blown back out to the slot size. */
  private reduce(image: CanvasImageSource, px: number): CanvasImageSource | undefined {
    if (typeof document === 'undefined') return undefined
    const out = this.canvas('low', LOW_PX)
    if (!out) return undefined
    if (px >= LOW_PX) {
      out.drawImage(image, 0, 0, LOW_PX, LOW_PX)
      return out.canvas
    }
    const step = this.canvas(`r${px}`, px)
    if (!step) return undefined
    step.drawImage(image, 0, 0, px, px)
    out.drawImage(step.canvas, 0, 0, LOW_PX, LOW_PX)
    return out.canvas
  }

  private canvas(id: string, px: number): CanvasRenderingContext2D | undefined {
    const held = id === 'low' ? this.lowCanvas : this.reducers.get(px)
    if (held) return held
    const c = document.createElement('canvas')
    c.width = c.height = px
    const ctx = c.getContext('2d') ?? undefined
    if (!ctx) return undefined
    // The reduction is the one place a good filter is worth paying for: it is
    // the tap the whole detail ratio is divided by, and a nearest-neighbour
    // 512-to-4 would alias a tile's mean into noise.
    ctx.imageSmoothingQuality = 'high'
    if (id === 'low') this.lowCanvas = ctx
    else this.reducers.set(px, ctx)
    return ctx
  }

  /** Publish this frame's index. 1 KB, re-uploaded in place — no reallocation. */
  setIndex(index: AtlasIndex) {
    this.indexData.set(index.data)
    this.index.needsUpdate = true
  }

  dispose() {
    this.sharp.dispose()
    this.low.dispose()
    this.index.dispose()
    this.slots.clear()
  }
}
