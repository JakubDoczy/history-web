import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ATLAS_COLS,
  ATLAS_PX,
  ATLAS_SLOTS,
  FADE_MS,
  INDEX_ROWS,
  INDEX_W,
  LOW_PX,
  SlotMap,
  buildIndex,
  TileAtlas,
  fitLevel,
  gridCol,
  gridCovering,
  gridOf,
  lowTapPx,
} from '../src/lib/tileAtlas'
import { BASE_LEVEL, TILE_PX, tileCols, tilesCovering, type Tile } from '../src/lib/tilePyramid'
import { viewBbox, Z_MAX, baseTexelsPerScreenPx } from '../src/lib/detailImagery'
import { targetLevel } from '../src/lib/tilePyramid'

describe('atlas geometry', () => {
  it('is one texture of the size the field can be relied on to allow', () => {
    // 4096 is the smallest MAX_TEXTURE_SIZE in circulation, and it is also
    // exactly what the composite this replaces was capped at — so the atlas
    // spends the same texture budget, as whole tiles rather than as a canvas.
    expect(ATLAS_PX).toBe(4096)
    expect(ATLAS_SLOTS).toBe(ATLAS_COLS * ATLAS_COLS)
    expect(ATLAS_PX).toBe(ATLAS_COLS * TILE_PX)
  })

  it('reduces a tile to exactly the base map density, at every level it can', () => {
    // The blurred tap the detail ratio divides by has to be the base map's own
    // scale: a level-z tile spans 360/2^z degrees, and the 4096-wide world map
    // puts 4096/2^z texels across that.
    for (let z = 6; z <= Z_MAX; z++) {
      expect(lowTapPx(z)).toBe(Math.max(1, 4096 / 2 ** z))
    }
    // …and below level 6 the slot runs out before the arithmetic does, so the
    // tap is coarser than the base map by up to two octaves. That range is a 2x
    // to 8x magnification of the base map, where the ratio has little to
    // transfer and the shader's [0.55, 1.8] clamp bounds what it does.
    expect(lowTapPx(5)).toBe(LOW_PX)
    expect(lowTapPx(4)).toBe(LOW_PX)
    expect(lowTapPx(Z_MAX)).toBe(1) // a whole tile is one base-map texel
  })
})

describe('gridOf', () => {
  const t = (x: number, y: number): Tile => ({ z: 9, x, y })

  it('is the bounding box of the tiles, in tile coordinates', () => {
    expect(gridOf([t(4, 7), t(6, 7), t(5, 9)])).toEqual([4, 7, 3, 3])
  })

  it('is empty for no tiles, so the shader tests nothing into range', () => {
    expect(gridOf([])).toEqual([0, 0, 0, 0])
  })

  it('is exactly the covering set of a view', () => {
    const view = viewBbox(45, 10, 0.02, 1.6)
    const [, , w, h] = gridOf(tilesCovering(view, 10))
    expect(w * h).toBe(tilesCovering(view, 10).length)
  })

  /**
   * ROUND 51, DEFECT 2 — the grid has to wrap or the seam is a wall.
   *
   * Read as a plain minimum and maximum, a set straddling ±180 is the WHOLE
   * WORLD's width: 512 columns at z 9, twenty times the index texture, so
   * `atlasCell` rejects every cell and both halves of the frame fall through to
   * the base map. What the reader saw was the near side sharp (its tiles were
   * requested) and the far side not, with the change on the meridian rather
   * than at the edge of the screen.
   */
  it('finds the origin the long way round when the tiles cross the seam', () => {
    const n = tileCols(9)
    expect(gridOf([t(n - 2, 4), t(n - 1, 4), t(0, 4), t(1, 4)])).toEqual([n - 2, 4, 4, 1])
    // …and is unchanged for every set that does not cross it
    expect(gridOf([t(4, 7), t(6, 7), t(5, 9)])).toEqual([4, 7, 3, 3])
    expect(gridOf([t(0, 0)])).toEqual([0, 0, 1, 1])
    expect(gridOf(Array.from({ length: n }, (_, x) => t(x, 0)))).toEqual([0, 0, n, 1])
  })

  it('is exactly the covering set of a view ON the seam, too', () => {
    for (const lng of [180, -179.6, 179.6]) {
      const view = viewBbox(56, lng, 0.02, 1.6)
      const tiles = tilesCovering(view, 10)
      const [x0, , w, h] = gridOf(tiles)
      expect(w * h).toBe(tiles.length)
      expect(w).toBeLessThanOrEqual(INDEX_W)
      // every tile lands inside the grid once the column is taken the short way
      for (const tile of tiles) {
        const gx = gridCol(tile.x, x0, tileCols(10))
        expect(gx).toBeGreaterThanOrEqual(0)
        expect(gx).toBeLessThan(w)
      }
    }
  })
})

describe('gridCovering', () => {
  /**
   * The arithmetic and the definition, held equal.
   *
   * `gridCovering` exists so `fitLevel` can ask "does this fit" without
   * building the tile arrays to find out — which matters now that the level it
   * is handed may lag the camera by an octave and a half and therefore may not
   * fit at all. It is only safe if it is the same answer, so this is the test
   * that makes it the same answer: every level from the first streamable one to
   * the sharp source's ceiling, over views at the equator, at high latitude, at
   * the pole and astride the antimeridian.
   */
  const views = [
    viewBbox(45, 10, 0.02, 1.6),
    viewBbox(45, 10, 0.4, 1.6),
    viewBbox(-72, -140, 0.05, 0.6),
    viewBbox(89.4, 0, 0.3, 2.2),
    viewBbox(-89.6, 33, 0.3, 2.2),
    viewBbox(56, 180, 0.09, 1.4),
    viewBbox(56, -179.7, 0.09, 1.4),
    viewBbox(0, 179.9, 1.2, 1),
    viewBbox(0, 0, 1.3, 3),
  ]

  it('is exactly gridOf(tilesCovering) at every level and every view', () => {
    for (const v of views) {
      for (let z = BASE_LEVEL; z <= Z_MAX; z++) {
        expect({ v, z, g: gridCovering(v, z) }).toEqual({
          v,
          z,
          g: gridOf(tilesCovering(v, z)),
        })
      }
    }
  })

  it('allocates no tiles to answer a question about their number', () => {
    // The point of the function, stated as the thing it must not do: a level
    // the camera has left can want a 29x29 grid, and discovering that 29 > 16
    // must not cost 841 objects three times an animation frame.
    const wide = viewBbox(0, 0, 1.3, 3)
    const [, , w, h] = gridCovering(wide, 12)
    expect(w * h).toBeGreaterThan(1000)
    expect(fitLevel(wide, 12)).toBeLessThan(12)
  })
})

describe('fitLevel', () => {
  const view = (alt: number, aspect = 1.6) => viewBbox(45, 10, alt, aspect)

  it('leaves the screen-derived level alone when it fits', () => {
    const v = view(0.02)
    const z = targetLevel(baseTexelsPerScreenPx(0.02, 900), Z_MAX)
    expect(fitLevel(v, z)).toBe(z)
  })

  it('always returns a level whose two grids fit the atlas and the index', () => {
    // this is the whole contract: the wanted set is bounded *before* anything is
    // asked for, which is what makes "every slot is pinned" unreachable
    for (const alt of [0.004, 0.008, 0.02, 0.05, 0.12, 0.4]) {
      for (const aspect of [0.5, 1, 2.5]) {
        const v = view(alt, aspect)
        const z = fitLevel(v, targetLevel(baseTexelsPerScreenPx(alt, 2400), Z_MAX))
        const [, , gw, gh] = gridOf(tilesCovering(v, z))
        const [, , pw, ph] = gridOf(tilesCovering(v, z - 1))
        expect(gw).toBeLessThanOrEqual(INDEX_W)
        expect(gh).toBeLessThanOrEqual(INDEX_ROWS)
        expect(gw * gh + pw * ph).toBeLessThanOrEqual(ATLAS_SLOTS)
      }
    }
  })

  it('gives up resolution on a dense screen, and only there', () => {
    // the same trade patchPixelCap used to make on a canvas: past the point
    // where the frame wants more tiles than there are slots, the level drops
    const v = view(0.02)
    const dense = targetLevel(baseTexelsPerScreenPx(0.02, 4800), Z_MAX)
    const ordinary = targetLevel(baseTexelsPerScreenPx(0.02, 900), Z_MAX)
    expect(fitLevel(v, dense)).toBeLessThan(dense)
    expect(fitLevel(v, ordinary)).toBe(ordinary) // …and an ordinary one keeps it
    // At the top of the range the index texture binds before the slots do: a
    // 12x9 grid is 108 tiles, so no plausible atlas would have held it anyway.
    expect(fitLevel(v, dense, 4096)).toBe(fitLevel(v, dense))
  })

  it('never falls below the first streaming level', () => {
    expect(fitLevel(viewBbox(0, 0, 2, 1), 12, 4)).toBe(BASE_LEVEL + 1)
  })
})

describe('the low tap, and who reads it', () => {
  /**
   * A renderer that records where each upload landed, and a canvas that records
   * that it was drawn on. Between them they answer the only question this lever
   * asks: does a tile the shader PAINTS still pay for the reduced copy the
   * ratio path divides by?
   */
  const rig = () => {
    const uploads: string[] = []
    const reductions: number[] = []
    const canvas = () => {
      const c = {
        width: 0,
        height: 0,
        getContext: () => ({
          imageSmoothingQuality: 'low',
          canvas: c,
          drawImage: (_i: unknown, _x: number, _y: number, w: number) => reductions.push(w),
        }),
      }
      return c
    }
    vi.stubGlobal('document', { createElement: () => canvas() })
    const renderer = {
      copyTextureToTexture: (_src: unknown, dst: { image: { width: number } }) =>
        uploads.push(dst.image.width === ATLAS_PX ? 'sharp' : 'low'),
    }
    return { uploads, reductions, renderer }
  }
  afterEach(() => vi.unstubAllGlobals())

  const tile = { width: TILE_PX, height: TILE_PX } as unknown as CanvasImageSource

  it('holds a ratio-mode tile twice: sharp, and at the base map density', () => {
    const { uploads, reductions, renderer } = rig()
    const atlas = new TileAtlas(renderer as never)
    atlas.put('9/1/1/s', tile, 9, 0)
    expect(uploads).toEqual(['sharp', 'low'])
    // 512 down to the tile's own base-map extent, then back out to the slot
    expect(reductions).toEqual([lowTapPx(9), LOW_PX])
    atlas.dispose()
  })

  it('holds a painted tile once, because nothing samples the other one', () => {
    // `uDetailPaint = 1` multiplies the sharp/blurred ratio out of the shader
    // entirely (globeSurface: `mix(stack, 1.0, uDetailPaint)`), so in map mode
    // the reduced copy is computed, uploaded and never read. What it cost per
    // tile was a main-thread `drawImage` of 512² down to as little as 8² at
    // high smoothing quality — the last CPU rasterisation in the upload path —
    // plus a second GL call.
    const { uploads, reductions, renderer } = rig()
    const atlas = new TileAtlas(renderer as never)
    atlas.put('9/1/1/drawn', tile, 9, 0, false)
    expect(uploads).toEqual(['sharp'])
    expect(reductions).toEqual([])
    // …and the slot bookkeeping is untouched: the tile is as resident as ever
    expect(atlas.slots.slotOf('9/1/1/drawn')).toBeDefined()
    expect(atlas.writes).toBe(1)
    atlas.dispose()
  })
})

describe('SlotMap', () => {
  const map = (capacity = 4) => new SlotMap(capacity)

  it('gives a tile the same slot every time it is asked for', () => {
    const m = map()
    const a = m.acquire('a', 0)!
    expect(m.acquire('a', 100)).toBe(a)
    expect(a.bornAt).toBe(0) // …and does not restart its fade
  })

  it('spends free slots before it evicts anything', () => {
    const m = map()
    const taken = ['a', 'b', 'c', 'd'].map((k) => m.acquire(k, 0)!.index)
    expect(new Set(taken).size).toBe(4)
    expect(m.size).toBe(4)
  })

  it('evicts the least recently wanted slot, and reuses its index', () => {
    const m = map()
    for (const k of ['a', 'b', 'c', 'd']) m.acquire(k, 0)
    const oldest = m.slotOf('a')!.index
    m.pin(['b', 'c', 'd']) // 'a' is no longer wanted, and is now the oldest
    const fresh = m.acquire('e', 10)!
    expect(fresh.index).toBe(oldest)
    expect(m.has('a')).toBe(false)
    expect(m.has('b')).toBe(true)
  })

  it('honours a pin absolutely, and says so rather than breaking it', () => {
    // The alternative — evicting a pinned slot — is a hole on screen paid for
    // with a refetch. fitLevel is what makes this unreachable in practice.
    const m = map()
    for (const k of ['a', 'b', 'c', 'd']) m.acquire(k, 0)
    m.pin(['a', 'b', 'c', 'd'])
    expect(m.acquire('e', 10)).toBeUndefined()
  })

  it('treats pinning as the only touch, so a wanted set is a recency order', () => {
    const m = map()
    for (const k of ['a', 'b', 'c', 'd']) m.acquire(k, 0)
    m.pin(['a']) // a is now the newest…
    m.pin([]) // …and nothing is protected
    expect(m.acquire('e', 10)!.index).toBe(m.slotOf('c')!.index - 1) // b's, now oldest
    expect(m.has('a')).toBe(true)
  })

  it('ages a slot from nothing to fully resident over the fade', () => {
    const m = map()
    const slot = m.acquire('a', 1000)!
    expect(m.fade(slot, 1000)).toBe(0)
    expect(m.fade(slot, 1000 + FADE_MS / 2)).toBeCloseTo(0.5, 6)
    expect(m.fade(slot, 1000 + FADE_MS)).toBe(1)
    expect(m.fade(slot, 9999)).toBe(1) // and never past it
  })
})

describe('buildIndex', () => {
  const tiles = (z: number, x0: number, y0: number, w: number, h: number): Tile[] => {
    const out: Tile[] = []
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push({ z, x: x0 + x, y: y0 + y })
    return out
  }
  const cell = (data: Uint8Array, gx: number, gy: number) => {
    const i = (gy * INDEX_W + gx) * 4
    return { slot: data[i] - 1, fade: data[i + 1] / 255 }
  }

  it('maps each visible tile to its slot, relative to the grid origin', () => {
    const m = new SlotMap()
    const level = tiles(10, 100, 40, 3, 2)
    for (const t of level) m.acquire(`${t.x}/${t.y}`, 0)
    const idx = buildIndex(10, level, [], (t) => m.slotOf(`${t.x}/${t.y}`), FADE_MS)
    expect(idx.grid).toEqual([100, 40, 3, 2])
    expect(idx.resident).toBe(6)
    expect(idx.sharp).toBe(true)
    for (const t of level) {
      expect(cell(idx.data, t.x - 100, t.y - 40).slot).toBe(m.slotOf(`${t.x}/${t.y}`)!.index)
    }
  })

  it('puts the parent level in its own half of the index', () => {
    const m = new SlotMap()
    const parent = tiles(9, 50, 20, 2, 1)
    for (const t of parent) m.acquire(`p${t.x}`, 0)
    const idx = buildIndex(10, [], parent, (t) => m.slotOf(`p${t.x}`), FADE_MS)
    expect(idx.parent).toEqual([50, 20, 2, 1])
    expect(idx.sharp).toBe(false) // nothing at the target level: the quote is z-1
    expect(cell(idx.data, 0, INDEX_ROWS).slot).toBe(m.slotOf('p50')!.index)
    expect(cell(idx.data, 1, INDEX_ROWS).slot).toBe(m.slotOf('p51')!.index)
    expect(cell(idx.data, 0, 0).slot).toBe(-1) // …and the target half stays empty
  })

  it('leaves a cell absent when its tile has no slot, so the shader falls through', () => {
    // Coarse but present beats sharp but absent: an absent cell is a zero, and
    // zero is the one slot code that means "use the parent".
    const m = new SlotMap()
    const level = tiles(10, 0, 0, 2, 1)
    m.acquire('0/0', 0)
    const idx = buildIndex(10, level, [], (t) => m.slotOf(`${t.x}/${t.y}`), FADE_MS)
    expect(cell(idx.data, 0, 0).slot).toBeGreaterThanOrEqual(0)
    expect(idx.data[4]).toBe(0)
    expect(idx.resident).toBe(1)
  })

  it('carries each slot own age, and reports that a fade is running', () => {
    const m = new SlotMap()
    const level = tiles(10, 0, 0, 2, 1)
    m.acquire('0/0', 0) // resident since the beginning
    m.acquire('1/0', FADE_MS) // half way through its dissolve at 1.5 fades
    const idx = buildIndex(10, level, [], (t) => m.slotOf(`${t.x}/${t.y}`), FADE_MS * 1.5)
    expect(cell(idx.data, 0, 0).fade).toBe(1)
    expect(cell(idx.data, 1, 0).fade).toBeCloseTo(0.5, 2)
    expect(idx.fading).toBe(true)
  })

  it('is not fading once every slot has finished dissolving', () => {
    // what keeps the render pump from being held awake forever
    const m = new SlotMap()
    const level = tiles(10, 0, 0, 2, 1)
    for (const t of level) m.acquire(`${t.x}/${t.y}`, 0)
    const idx = buildIndex(10, level, [], (t) => m.slotOf(`${t.x}/${t.y}`), FADE_MS + 1)
    expect(idx.fading).toBe(false)
  })

  it('drops a tile the index texture cannot address rather than wrapping it', () => {
    // fitLevel bounds the grid, so this is a belt on braces — but a cell written
    // past the row would land on another tile's entry, which is a slot number
    // addressing the wrong ground.
    const m = new SlotMap()
    const level = tiles(10, 0, 0, INDEX_W + 2, 1)
    for (const t of level) m.acquire(`${t.x}`, 0)
    const idx = buildIndex(10, level, [], (t) => m.slotOf(`${t.x}`), FADE_MS)
    expect(idx.resident).toBe(INDEX_W)
  })

  it('indexes a seam-crossing view on both sides of the meridian', () => {
    // The wanted set of a Pacific view at z 10: the last two columns of the
    // world and the first two. Before the wrap, `t.x - x0` put columns 0 and 1
    // at cells -1022 and -1021, the range test dropped them, and everything
    // east of the seam showed base map.
    const n = tileCols(10)
    const m = new SlotMap()
    const level: Tile[] = []
    for (const x of [n - 2, n - 1, 0, 1]) for (const y of [30, 31]) level.push({ z: 10, x, y })
    for (const t of level) m.acquire(`${t.x}/${t.y}`, 0)
    const idx = buildIndex(10, level, [], (t) => m.slotOf(`${t.x}/${t.y}`), FADE_MS)
    expect(idx.grid).toEqual([n - 2, 30, 4, 2])
    expect(idx.resident).toBe(8)
    for (const t of level) {
      const gx = gridCol(t.x, idx.grid[0], n)
      expect(cell(idx.data, gx, t.y - 30).slot).toBe(m.slotOf(`${t.x}/${t.y}`)!.index)
    }
    // and each of the four columns got its own cell — no two tiles share one
    expect(new Set(level.map((t) => gridCol(t.x, idx.grid[0], n))).size).toBe(4)
  })

  it('wraps the parent grid at the parent level, not the target one', () => {
    const n = tileCols(9)
    const m = new SlotMap()
    const parent: Tile[] = [
      { z: 9, x: n - 1, y: 15 },
      { z: 9, x: 0, y: 15 },
    ]
    for (const t of parent) m.acquire(`p${t.x}`, 0)
    const idx = buildIndex(10, [], parent, (t) => m.slotOf(`p${t.x}`), FADE_MS)
    expect(idx.parent).toEqual([n - 1, 15, 2, 1])
    expect(cell(idx.data, 0, INDEX_ROWS).slot).toBe(m.slotOf(`p${n - 1}`)!.index)
    expect(cell(idx.data, 1, INDEX_ROWS).slot).toBe(m.slotOf('p0')!.index)
  })

  it('writes the whole index and nothing else, so a stale cell cannot survive', () => {
    const m = new SlotMap()
    const buffer = new Uint8Array(INDEX_W * INDEX_ROWS * 2 * 4).fill(255)
    const idx = buildIndex(10, tiles(10, 0, 0, 1, 1), [], () => m.acquire('a', 0), 0, buffer)
    expect(idx.data[0]).toBe(1)
    expect([...idx.data.slice(4, 8)]).toEqual([0, 0, 0, 0])
  })
})
