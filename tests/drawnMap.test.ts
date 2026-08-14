import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createCanvas, Path2D as NodePath2D } from '@napi-rs/canvas'
import {
  CHUNK_DEG,
  buildWorld,
  bucketsCovering,
  layerOf,
  loadWorld,
  packLayer,
  packedBuffers,
  shapesNear,
  unpackLayer,
  type DrawnWorld,
  type Layer,
} from '../src/lib/drawnGeometry'
import {
  DrawnRenderer,
  LevelPaths,
  LOD_FINE_Z,
  LOD_Z,
  MIN_SEG_PX,
  PAPER,
  WATER_FADE,
  landAt,
  levelOf,
  waterAlpha,
  type DrawCtx,
} from '../src/lib/drawnTile'
import {
  DRAWN_ERA_FROM,
  DRAWN_GEOMETRY_Z,
  DRAWN_LABEL,
  DRAWN_LABEL_COARSE,
  DRAWN_LABEL_FINE,
  DRAWN_LABELS,
  DRAWN_PX_PER_DEG,
  DRAWN_Z_MAX,
  DrawnTiles,
} from '../src/lib/drawnSource'
import { BASE_LEVEL, TILE_PX, maxLevel, tileBbox } from '../src/lib/tilePyramid'
import {
  IMAGERY_ERA_FROM,
  MIN_ALTITUDE_DETAIL,
  MIN_ALTITUDE_PRE_ERA,
  minAltitudeFor,
  singleSourcePlan,
  IMAGERY_PLAN,
  type TileSource,
} from '../src/lib/detailImagery'
import { DRAWN_FRAMES, DRAWN_TEXTURE, PALEO_FRAMES, framesFor } from '../src/data/paleoTextures'
import { modernShare } from '../src/lib/paleo'
import { DETAIL_MODE } from '../src/lib/globeSurface'
import { resolveGlobeStyle } from '../src/lib/present'
import { DEFAULT_PALETTE } from '../src/lib/palette'

/**
 * The drawn map, tested where it can be: the geometry index, the rasterizer's
 * two promises (same tile twice is the same bytes, two tiles meet), and the
 * three numbers that were derived from measurement rather than chosen.
 *
 * The rasterizer runs here for real. It is written against the 2D API rather
 * than against a browser, so node draws the same plate the worker does with the
 * same code — which is also how the build-time world texture is made
 * (scripts/render-drawn-world.mjs). Without that property this file could only
 * test the arithmetic around the drawing.
 */
;(globalThis as unknown as { Path2D: unknown }).Path2D = NodePath2D

const read = (f: string) => JSON.parse(readFileSync(`public/data/map/${f}`, 'utf8'))
let cached: DrawnWorld | undefined
const world = (): DrawnWorld =>
  (cached ??= buildWorld(read('land-110m.json'), read('land-50m.json'), read('water-50m.json')))

/**
 * …and the same world with the third rung on it.
 *
 * Kept apart from `world()` on purpose. The 10m layer arrives on demand in the
 * app and is absent for most of a session, so the tests that describe the map
 * without it are describing a state it really has; and the decode is 700 ms,
 * which is not worth paying in the tests that never draw finer than level 6.
 */
let cachedFine: Layer | undefined
const fineLand = (): Layer =>
  (cachedFine ??= layerOf(read('land-10m.json'), 'land', true, { chunk: true }))
const fineWorld = (): DrawnWorld => ({ ...world(), fineLand: fineLand() })

const surface = () => {
  const canvas = createCanvas(TILE_PX, TILE_PX)
  const ctx = canvas.getContext('2d')
  return {
    ctx: ctx as unknown as DrawCtx,
    pixels: () => Uint8ClampedArray.from(ctx.getImageData(0, 0, TILE_PX, TILE_PX).data),
  }
}

/** A tile over western Europe: coast, islands, rivers, open sea. */
const EUROPE = (z: number) => ({
  z,
  x: Math.floor(0.53 * 2 ** z),
  y: Math.floor(0.29 * 2 ** (z - 1)),
})

describe('the bucket index', () => {
  it('names every cell a box touches, and no others', () => {
    // one cell is 22.5 degrees; a box inside one is one cell, a box spanning
    // three columns and two rows is six
    expect(bucketsCovering({ minLng: 1, maxLng: 2, minLat: 1, maxLat: 2 })).toHaveLength(1)
    expect(bucketsCovering({ minLng: -10, maxLng: 40, minLat: -10, maxLat: 20 })).toHaveLength(
      3 * 2,
    )
    // and the poles clamp rather than running off the grid
    expect(bucketsCovering({ minLng: -180, maxLng: 180, minLat: -90, maxLat: 90 })).toHaveLength(
      16 * 8,
    )
  })

  it('finds exactly what a brute-force bounding-box scan finds', () => {
    // The index is an optimisation and nothing else: it may not change the
    // answer. Checked against every shape in the layer, over boxes that between
    // them cover an ocean, a dense archipelago and a whole continent.
    const brute = (layer: Layer, b: ReturnType<typeof tileBbox>) =>
      layer.shapes
        .map((s, i) => [s, i] as const)
        .filter(
          ([s]) =>
            !(
              s.bbox[2] < b.minLng ||
              s.bbox[0] > b.maxLng ||
              s.bbox[3] < b.minLat ||
              s.bbox[1] > b.maxLat
            ),
        )
        .map(([, i]) => i)
    const w = world()
    for (const layer of [w.land!, w.rivers!, w.coarseLand]) {
      for (const box of [
        tileBbox(5, 17, 9), // western Europe
        tileBbox(6, 3, 15), // the open Pacific
        tileBbox(4, 12, 4), // the Indonesian archipelago
        tileBbox(3, 0, 0), // a whole polar quadrant
      ]) {
        expect(shapesNear(layer, box)).toEqual(brute(layer, box))
      }
    }
  })

  it('splits a multipolygon so the index can say anything at all', () => {
    // world-atlas ships `land` as ONE MultiPolygon of 1429 rings. Kept whole it
    // has the planet for a bounding box, so every tile matches it and the index
    // saves nothing — this is the decode decision that makes a tile 0.9 ms
    // instead of 7.
    const land = world().land!
    expect(land.shapes.length).toBeGreaterThan(1000)
    const pacific = shapesNear(land, tileBbox(6, 3, 15))
    expect(pacific.length).toBeLessThan(20)
  })
})

describe('the rasterizer', () => {
  it('draws the same tile twice, byte for byte', () => {
    // The cache and the atlas both assume it: a tile is addressed by (z, x, y)
    // and nothing else, so two renders that differ would mean the picture
    // depends on when it was asked for.
    const a = surface()
    const b = surface()
    new DrawnRenderer(world()).draw(a.ctx, EUROPE(6))
    // a SECOND renderer, so the level path cache is cold for one and warm for
    // the other — the caching must not be able to change the drawing
    const warm = new DrawnRenderer(world())
    warm.draw(b.ctx, EUROPE(6))
    const c = surface()
    warm.draw(c.ctx, EUROPE(6))
    // `equals`, not `toEqual`: a structural diff of a megabyte of pixels takes
    // seconds to conclude what a memcmp concludes in microseconds, and the
    // failure it would print is a million numbers nobody can read.
    const first = Buffer.from(a.pixels())
    expect(Buffer.from(b.pixels()).equals(first)).toBe(true)
    expect(Buffer.from(c.pixels()).equals(first)).toBe(true)
  })

  it('meets its neighbour at the join', () => {
    // Two tiles that share an edge are two windows onto one drawing, so the
    // column each side of the seam must differ no more than two columns inside
    // one tile do. This is the test that per-tile jitter fails: a coastline
    // wobbled by a per-tile seed kinks at every boundary, and the seam column
    // then differs by far more than the map's own gradient.
    const z = 6
    const t = EUROPE(z)
    const left = surface()
    const right = surface()
    const r = new DrawnRenderer(world())
    r.draw(left.ctx, t)
    r.draw(right.ctx, { ...t, x: t.x + 1 })
    const a = left.pixels()
    const b = right.pixels()
    const column = (px: Uint8ClampedArray, x: number, y: number) => (y * TILE_PX + x) * 4
    let seam = 0
    let inside = 0
    for (let y = 0; y < TILE_PX; y++) {
      for (let c = 0; c < 3; c++) {
        seam += Math.abs(a[column(a, TILE_PX - 1, y) + c] - b[column(b, 0, y) + c])
        inside += Math.abs(a[column(a, TILE_PX - 2, y) + c] - a[column(a, TILE_PX - 1, y) + c])
      }
    }
    // the seam is one step of the same picture, so it costs what a step costs
    expect(seam).toBeLessThanOrEqual(Math.max(inside * 2, TILE_PX * 3))
  })

  it('is a drawing: paper, two grounds, and ink darker than both', () => {
    const s = surface()
    new DrawnRenderer(world()).draw(s.ctx, EUROPE(6))
    const px = s.pixels()
    const lum = (i: number) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
    let min = 255
    let max = 0
    for (let i = 0; i < px.length; i += 4) {
      min = Math.min(min, lum(i))
      max = Math.max(max, lum(i))
    }
    // the ink reaches the pen's own value, and nothing on the sheet is brighter
    // than the paper it is drawn on
    expect(min).toBeLessThan(70)
    expect(max).toBeLessThan(255)
    expect(max).toBeGreaterThan(200)
  })

  /**
   * ROUND 52 — the sea stops being another shade.
   *
   * This test used to assert one thing about every pixel on the plate: `blue <=
   * red + 2`, "no pixel is a photograph's blue, the whole plate is warm". That
   * was true and it was the defect — reported as *"the sea is just another
   * shade"*. A warm sea under warm land differs from it in luminance alone, and
   * 26 of luminance is an emboss, not a coastline.
   *
   * So the claim is replaced rather than relaxed, and it is a stronger claim
   * than the one it retires: the two grounds must differ in HUE (one warm, one
   * cool) *and* neither may be a colour a photograph would produce. The blue
   * bound survives in the form that was actually defending something — a
   * Blue-Marble ocean is `b > r + 18`, and nothing here comes near it.
   */
  it('gives the sea its own substance: warm land, cool sea, one aged sheet', () => {
    const s = surface()
    new DrawnRenderer(world()).draw(s.ctx, EUROPE(6))
    const px = s.pixels()
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
    const lum = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
    const chroma = (c: number[]) => Math.max(...c) - Math.min(...c)
    const land = hex(PAPER.land)
    const sea = hex(PAPER.ocean)

    // 1. the land is parchment and the sea is not: warm against cool
    expect(land[2]).toBeLessThan(land[0] - 20)
    expect(sea[2]).toBeGreaterThan(sea[0])

    // 2. …and the pair is one aged paper artifact, not a poster. The measured
    //    guarantee is that the NEW sea is a less saturated colour than the warm
    //    one it replaced (chroma 43): the separation is direction, not colour.
    expect(chroma(sea)).toBeLessThan(chroma(land))
    expect(chroma(sea)).toBeLessThan(20)

    // 3. …and it is a real separation. 26 of luminance was the complaint; this
    //    is 38, and the wash steps below the sea from there.
    expect(lum(land) - lum(sea)).toBeGreaterThan(32)
    for (const [i, w] of PAPER.wash.entries()) {
      expect(lum(hex(w))).toBeLessThan(lum(sea) - 4 * (i + 1))
      expect(chroma(hex(w))).toBeLessThan(20)
    }
    // the lake belongs to the same water as the sea, within five of luminance
    expect(Math.abs(lum(hex(PAPER.lake)) - lum(sea))).toBeLessThan(8)
    expect(hex(PAPER.lake)[2]).toBeGreaterThan(hex(PAPER.lake)[0])

    // 4. …and on the plate itself: no pixel is a photographed ocean, and no
    //    pixel is more colourful than the paper's own tone range. Aggregated
    //    and asserted once — a quarter of a million `expect` calls is a minute
    //    of test time to say what two numbers say.
    let coolest = -255
    let mostColour = 0
    for (let i = 0; i < px.length; i += 4) {
      coolest = Math.max(coolest, px[i + 2] - px[i])
      mostColour = Math.max(mostColour, chroma([px[i], px[i + 1], px[i + 2]]))
    }
    expect(coolest).toBeLessThan(18)
    expect(mostColour).toBeLessThan(60)
  })

  it('keeps the graticule legible on both grounds', () => {
    // The hairline is ONE pen at one alpha over two grounds now, so its contrast
    // has to be checked on each. Weber contrast, which is what a hairline over a
    // flat tone actually is: the old warm sea gave 10.7% and the land 11.7%.
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
    const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(PAPER.graticule)!
    const pen = [+m[1], +m[2], +m[3]]
    const a = +m[4]
    for (const ground of [PAPER.land, PAPER.ocean]) {
      const g = hex(ground)
      const over = g.map((v, i) => v * (1 - a) + pen[i] * a)
      expect((lum(g) - lum(over)) / lum(g)).toBeGreaterThan(0.1)
    }
  })

  it('draws no political boundary: the paper is the same sheet in every year', () => {
    // THE POINT OF THIS FILE'S ROUND. The rasterizer used to stroke Natural
    // Earth's `countries` into every tile, which put MODERN borders under a
    // nations layer that draws 73 era-accurate polities and changes with the
    // year: at 1500 a reader got Burgundy's frontier and France's printed on
    // top of each other, and only one of them knew what year it was.
    //
    // Measured on the ground rather than on the source, because "the call is
    // gone" is a claim about this file and "there is no line there" is a claim
    // about the map. Two boxes with hundreds of kilometres of pure political
    // line and nothing else drawn in them — no coast, no river, no lake:
    const r = new DrawnRenderer(world())
    const lum = (px: Uint8ClampedArray, i: number) =>
      0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
    // …and a threshold that admits everything the map IS allowed to draw here.
    // Land is 236,226,200 (lum 228); the graticule hairline reduces it to ~205
    // and the dark fleck to ~225; a lake fill is 194. The border stroke this
    // test is about landed at 150, and coast and river ink are darker still.
    const INK_FLOOR = 190
    const inked = (t: { z: number; x: number; y: number }) => {
      const s = surface()
      r.draw(s.ctx, t)
      const px = s.pixels()
      let n = 0
      for (let i = 0; i < px.length; i += 4) if (lum(px, i) < INK_FLOOR) n++
      return n
    }
    // z=6 tile 34,12 — Libya/Niger/Chad, 11.25..16.875E by 16.875..22.5N. Three
    // national frontiers meet inside it and nothing physical is drawn there at
    // all. Measured against the border pass this round removed: 538 pixels.
    expect(inked({ z: 6, x: 34, y: 12 })).toBe(0)
    // z=6 tile 36,11 — 22.5..28.125E by 22.5..28.125N, which is 600 km of the
    // Libya/Egypt frontier: a line ruled along the 25th meridian by a treaty in
    // 1925, drawn across sand that has no coast, no river and no lake in it.
    // Same measurement: 512 pixels before, none now.
    expect(inked({ z: 6, x: 36, y: 11 })).toBe(0)
    // …and the test is not vacuous: the same threshold on a coast is thousands.
    expect(inked(EUROPE(6))).toBeGreaterThan(2000)
  })

  it('renders a tile inside the 8 ms budget', () => {
    const s = surface()
    const r = new DrawnRenderer(world())
    const times: number[] = []
    for (const z of [4, 5, 6, 7, 8, 9]) {
      r.draw(s.ctx, EUROPE(z)) // warm the level's paths, which is once per level
      const t0 = performance.now()
      r.draw(s.ctx, EUROPE(z))
      times.push(performance.now() - t0)
    }
    // Generous against the measured 0.9 ms mean / 3.1 ms worst tile, because
    // this runs on whatever CI is: what it is defending is the SHAPE of the
    // cost — a regression that walked the whole coastline per tile again came
    // in at 7 ms, and one that dropped the per-polygon split at 60.
    expect(Math.max(...times)).toBeLessThan(8)
  })

  it('keeps the level it is drawing, not the level it drew first', () => {
    // `keep = 3` is the pyramid's own working set — a view streams its target
    // level and its parent, and a zoom adds the next one — but which three is a
    // question about RECENCY, and the map used to answer it with insertion
    // order. A camera that goes out and comes back therefore evicted the level
    // it was drawing right then, because that level happened to be the first of
    // the three built, and every path of it was rebuilt from the point arrays:
    // the 8–10 ms first-tile-of-a-level cost, paid again for geometry that was
    // already there.
    const s = surface()
    const r = new DrawnRenderer(world())
    for (const z of [6, 7, 8]) r.draw(s.ctx, EUROPE(z))
    const six = r.paths(6)
    expect(six.size).toBeGreaterThan(0)
    r.draw(s.ctx, EUROPE(6)) // …the camera comes back
    r.draw(s.ctx, EUROPE(9)) // …and then goes somewhere new
    expect(r.paths(6)).toBe(six) // level 6 survived; it is the one in use
    expect(r.paths(7).size).toBe(0) // level 7 is the one the camera left
  })

  it('draws from 110m until the 50m data lands, and from 50m after', () => {
    const coarseOnly = buildWorld(read('land-110m.json'))
    expect(landAt(coarseOnly, 9)[1]).toBe('coarse')
    expect(landAt(world(), LOD_Z)[1]).toBe('land')
    // the switch is BASE_LEVEL, i.e. everywhere: measured, 110m survives the
    // half-pixel filter with a tenth of 50m's segments at the coarsest level
    // anything is drawn at
    expect(LOD_Z).toBe(BASE_LEVEL)
    // …and the cache name changes with it, so paths built from one are never
    // handed out for the other
    expect(landAt(coarseOnly, 9)[1]).not.toBe(landAt(world(), 9)[1])
  })

  it('fades the water out where its quantisation would show', () => {
    expect(waterAlpha(WATER_FADE.from - 1)).toBe(1)
    expect(waterAlpha(WATER_FADE.from)).toBe(1)
    expect(waterAlpha(WATER_FADE.to)).toBe(0)
    expect(waterAlpha(WATER_FADE.to + 3)).toBe(0)
    // one quantum of the water data is 0.036 deg; at the fade's end that is
    // 26 tile pixels, which is a staircase and not a river
    const quantumPx = 0.036 * ((TILE_PX * 2 ** WATER_FADE.to) / 360)
    expect(quantumPx).toBeGreaterThan(10)
  })

  it('measures a plate by its density, not by its z', () => {
    // the 4096-wide world texture is 32 level-3 tiles, and the base map IS
    // level 3 — that identity is what keeps the shader's sharp/blur ratio
    // self-consistent
    expect(levelOf({ z: 3, x: 0, y: 0 })).toBe(BASE_LEVEL)
    expect(levelOf({ z: 0, x: 0, y: 0, px: 4096 })).toBe(BASE_LEVEL)
    expect(levelOf({ z: 1, x: 0, y: 0, px: 2048 })).toBe(BASE_LEVEL)
  })
})

/**
 * ROUND 51, DEFECT 1 — the chord from South Africa to Chukotka.
 *
 * Reported as "one huge defect starting from a point in South Africa stretching
 * through Ceylon, South Korea and ending somewhere around Kamchatka". It was a
 * `closePath()` at the antimeridian in the path builder: `closePath` closes to
 * the last `moveTo`, which for the first piece of a ring is the RING'S OWN
 * FIRST VERTEX — and Afro-Eurasia's ring 0 begins at 16.45° E, 28.62° S, the
 * mouth of the Orange River. Two crossings, two chords, one lens across the
 * Indian Ocean and the Pacific.
 *
 * Three tests, at three levels of the stack: the geometry may not contain such
 * a segment, the pen may not draw one, and the ocean the reader named must have
 * no ink in it.
 */
describe('no chord across the world', () => {
  const layers = () => {
    const w = world()
    return [
      ['coarse land', w.coarseLand],
      ['land', w.land!],
      ['rivers', w.rivers!],
      ['lakes', w.lakes!],
    ] as const
  }

  it('clips every ring to the ±180 strip at decode', () => {
    for (const [name, layer] of layers()) {
      for (let s = 0; s < layer.shapes.length; s++) {
        const shape = layer.shapes[s]
        for (let r = 0; r + 1 < shape.rings.length; r++) {
          for (let i = shape.rings[r]; i + 1 < shape.rings[r + 1]; i++) {
            const d = Math.abs(shape.pts[i * 2 + 2] - shape.pts[i * 2])
            // the only edges left that span the world are the polar closures
            // `splitAtSeam` inserts along ±90, and they are marked as such
            if (d > 180) expect(`${name}#${s}:${i} seam=${shape.seam?.[i]}`).toContain('seam=1')
          }
        }
      }
    }
  })

  it('breaks a seam-crossing ring into pieces sealed on the meridian', () => {
    // Afro-Eurasia: one ring in, two pieces out, each starting and ending on a
    // meridian — which is what makes closing it a line down the seam rather
    // than a line to South Africa.
    const eurasia = world().land!.shapes.find(
      (s) => s.bbox[0] <= -25 && s.bbox[2] >= 179 && s.bbox[3] > 70,
    )!
    expect(eurasia.seam).toBeDefined()
    let sealed = 0
    for (let r = 0; r + 1 < eurasia.rings.length; r++) {
      const a = eurasia.rings[r]
      const b = eurasia.rings[r + 1] - 1
      if (Math.abs(eurasia.pts[a * 2]) !== 180) continue
      sealed++
      expect(Math.abs(eurasia.pts[b * 2])).toBe(180)
      expect(eurasia.pts[a * 2]).toBe(eurasia.pts[b * 2])
      expect(eurasia.seam![b]).toBe(1)
    }
    expect(sealed).toBe(2)
  })

  it('gives the pen a path with no seam edge on it', () => {
    // The fill needs the meridian closures (they are what make the piece a
    // polygon); the pen must not follow them, or the Bering Strait grows a
    // coastline with shoreline wash down the 180th meridian. Recorded off a
    // Path2D stand-in, because a built path cannot be read back.
    class Rec {
      ops: [string, number, number][] = []
      moveTo(x: number, y: number) {
        this.ops.push(['M', x, y])
      }
      lineTo(x: number, y: number) {
        this.ops.push(['L', x, y])
      }
      closePath() {
        this.ops.push(['Z', 0, 0])
      }
    }
    const held = (globalThis as unknown as { Path2D: unknown }).Path2D
    ;(globalThis as unknown as { Path2D: unknown }).Path2D = Rec
    try {
      const paths = new LevelPaths(BASE_LEVEL)
      const worldPx = paths.worldPx
      for (const [name, layer] of layers()) {
        for (const which of ['fill', 'stroke'] as const) {
          for (let i = 0; i < layer.shapes.length; i++) {
            const ops = (paths.path(layer, name, i)[which] as unknown as Rec).ops
            let at: [number, number] | undefined
            let start: [number, number] | undefined
            let long = 0
            let polar = 0
            for (const [op, x, y] of ops) {
              if (op === 'M') at = start = [x, y]
              else if (op === 'L' || op === 'Z') {
                const to = op === 'Z' ? start! : ([x, y] as [number, number])
                if (at && Math.hypot(to[0] - at[0], to[1] - at[1]) > worldPx * 0.05) {
                  // ±90 is the world's own edge: a polar cap is closed round it
                  if (Math.abs(at[1] - worldPx / 2) < 1 && Math.abs(to[1] - worldPx / 2) < 1) polar++
                  else long++
                }
                at = op === 'Z' ? start : to
              }
            }
            expect(`${name}/${which}#${i}: ${long}`).toBe(`${name}/${which}#${i}: 0`)
            if (which === 'stroke') expect(polar).toBe(0)
          }
        }
      }
      expect(paths.worldPx).toBe(4096)
    } finally {
      ;(globalThis as unknown as { Path2D: unknown }).Path2D = held
    }
  })

  it('leaves no ink along the reported transect: open ocean stays paper', () => {
    // THE TRANSECT THE READER TRACED, walked and sampled. The two chords ran
    // from Afro-Eurasia's first vertex (16.45 E, 28.62 S) to its two seam
    // crossings in Chukotka (179.87 E, 69.01 N and 179.83 E, 65.03 N), so the
    // line is stated here from its real endpoints rather than eyeballed off a
    // screenshot.
    //
    // Which samples are used is DERIVED, not typed: a point counts as open
    // ocean when no land, lake or river shape has a bounding box within half a
    // degree of it — so the test cannot silently start probing Madagascar if
    // the data is ever revendored.
    const w = world()
    const r = new DrawnRenderer(w)
    const z = 7
    const s = createCanvas(TILE_PX, TILE_PX)
    const ctx = s.getContext('2d')
    // read from the palette rather than typed: this test is about ink where
    // there should be none, not about which tone the sea is that round
    const [or, og, ob] = [1, 3, 5].map((i) => parseInt(PAPER.ocean.slice(i, i + 2), 16))
    /** Open water: outside every land ring, and no vertex of anything within R. */
    const R = 0.7
    const dry = (lng: number, lat: number) => {
      const box = { minLng: lng - R, maxLng: lng + R, minLat: lat - R, maxLat: lat + R }
      for (const layer of [w.land!, w.lakes!, w.rivers!]) {
        for (const i of shapesNear(layer, box)) {
          const s = layer.shapes[i]
          for (let r = 0; r + 1 < s.rings.length; r++) {
            let inside = false
            for (let a = s.rings[r], b = s.rings[r + 1] - 1; a < s.rings[r + 1]; b = a++) {
              const [ax, ay] = [s.pts[a * 2], s.pts[a * 2 + 1]]
              const [bx, by] = [s.pts[b * 2], s.pts[b * 2 + 1]]
              if (Math.abs(ax - lng) < R && Math.abs(ay - lat) < R) return false
              if (layer !== w.land) continue
              if (ay > lat !== by > lat && lng < ((bx - ax) * (lat - ay)) / (by - ay) + ax)
                inside = !inside
            }
            if (inside) return false
          }
        }
      }
      return true
    }
    const probes: [number, number][] = []
    for (const end of [
      [179.87, 69.01],
      [179.83, 65.03],
    ]) {
      for (let t = 0.05; t < 1; t += 0.02) {
        const lng = 16.45 + (end[0] - 16.45) * t
        const lat = -28.62 + (end[1] + 28.62) * t
        if (dry(lng, lat)) probes.push([lng, lat])
      }
    }
    // the chords crossed a lot of water; if they did not, this test is not one
    expect(probes.length).toBeGreaterThan(30)
    for (const [lng, lat] of probes) {
      const x = Math.floor(((lng + 180) / 360) * 2 ** z)
      const y = Math.floor(((90 - lat) / 180) * 2 ** (z - 1))
      r.draw(ctx as unknown as DrawCtx, { z, x, y })
      const px = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data
      const b = tileBbox(z, x, y)
      const ix = Math.round(((lng - b.minLng) / (b.maxLng - b.minLng)) * (TILE_PX - 1))
      const iy = Math.round(((b.maxLat - lat) / (b.maxLat - b.minLat)) * (TILE_PX - 1))
      // 24 of tolerance is the paper fleck and nothing else; the chord put land
      // fill (94 away) and two coastline strokes (330) across every one of these.
      let worst = 0
      for (let dx = -3; dx <= 3; dx++) {
        for (let dy = -3; dy <= 3; dy++) {
          const i = ((iy + dy) * TILE_PX + ix + dx) * 4
          worst = Math.max(
            worst,
            Math.abs(px[i] - or) + Math.abs(px[i + 1] - og) + Math.abs(px[i + 2] - ob),
          )
        }
      }
      const where = `${lng.toFixed(1)}E ${lat.toFixed(1)}N`
      expect(`${where}: ${worst}`).toBe(`${where}: ${Math.min(worst, 24)}`)
    }
  })
})

describe('the levels the drawn source serves', () => {
  /** Segments of a layer that survive the half-pixel filter at a level. */
  const segments = (layer: Layer, level: number) => {
    const k = (TILE_PX * 2 ** level) / 360
    let kept = 0
    for (const shape of layer.shapes) {
      for (let r = 0; r + 1 < shape.rings.length; r++) {
        let lx: number | undefined
        let ly = 0
        for (let i = shape.rings[r]; i < shape.rings[r + 1]; i++) {
          const x = shape.pts[i * 2] * k
          const y = shape.pts[i * 2 + 1] * k
          if (lx === undefined || Math.abs(x - lx) + Math.abs(y - ly) >= MIN_SEG_PX) {
            if (lx !== undefined) kept++
            lx = x
            ly = y
          }
        }
      }
    }
    return kept
  }

  /** The last level that recovers >1% more of a layer than the one below it. */
  const saturationOf = (layer: Layer) => {
    let sat = BASE_LEVEL
    let prev = segments(layer, BASE_LEVEL)
    for (let z = BASE_LEVEL + 1; z <= 14; z++) {
      const now = segments(layer, z)
      if (now / prev > 1.01) sat = z
      prev = now
    }
    return sat + 1
  }

  /** The median segment of a layer, in degrees — which is what a pixel measures. */
  const medianSegment = (layer: Layer) => {
    const d: number[] = []
    for (const shape of layer.shapes)
      for (let r = 0; r + 1 < shape.rings.length; r++)
        for (let i = shape.rings[r]; i + 1 < shape.rings[r + 1]; i++) {
          if (shape.seam?.[i]) continue
          d.push(
            Math.hypot(
              shape.pts[i * 2 + 2] - shape.pts[i * 2],
              shape.pts[i * 2 + 3] - shape.pts[i * 2 + 1],
            ),
          )
        }
    d.sort((a, b) => a - b)
    return d[d.length >> 1]
  }
  const facetPx = (deg: number, z: number) => (deg * TILE_PX * 2 ** z) / 360

  it('gives each rung a level where the one below it has nothing left to say', () => {
    // Three files, three saturation levels, and they are what LOD_Z and
    // LOD_FINE_Z are chosen from: a rung is worth loading exactly where the rung
    // under it has run out of vertices a tile pixel could show.
    expect(saturationOf(world().coarseLand)).toBe(4)
    expect(saturationOf(world().land!)).toBe(6)
    expect(saturationOf(fineWorld().fineLand!)).toBe(DRAWN_GEOMETRY_Z)
    expect(DRAWN_GEOMETRY_Z).toBe(8)
    // …and the switch to 10m is at or above the level 50m stops improving at,
    // never below it: below, the finer file would cost 851 kB to draw the same
    // coastline.
    expect(LOD_FINE_Z).toBeGreaterThanOrEqual(saturationOf(world().land!))
    // nothing at all above saturation: every vertex the DATA has already
    // survives. The slack is the clip's own vertices — the antimeridian's and
    // (on 10m) the chunk walls' — which are the projection's and the decoder's
    // rather than the data's.
    const land = fineWorld().fineLand!
    expect(segments(land, 13) / segments(land, DRAWN_GEOMETRY_Z) - 1).toBeLessThan(0.001)
  })

  it('derives Z_MAX from saturation and from how long a facet is at it', () => {
    // …and the source still serves finer levels than the data saturates at,
    // because the PEN does not saturate with it: ink is a fixed 1.15 tile
    // pixels, so stopping at saturation and magnifying would put a coastline on
    // screen 2^n times too heavy. See DRAWN_Z_MAX.
    expect(DRAWN_Z_MAX).toBeGreaterThan(DRAWN_GEOMETRY_Z)
    // THE RULE, stated once and applied to both rungs: the ceiling is the
    // finest level at which the median facet of the data is still no longer
    // than the median 50m facet was at the ceiling round 49 shipped (z9, 72 px).
    // That is what "the polygonisation is already the limit" measures.
    const limit = facetPx(medianSegment(world().land!), 9)
    expect(limit).toBeGreaterThan(70)
    expect(limit).toBeLessThan(75)
    const fine = medianSegment(fineWorld().fineLand!)
    expect(facetPx(fine, DRAWN_Z_MAX)).toBeLessThan(limit)
    expect(facetPx(fine, DRAWN_Z_MAX + 1)).toBeGreaterThan(limit)
    expect(DRAWN_Z_MAX).toBe(11)
    // and the ceiling is now finer AT the ceiling than the one it replaces
    expect(facetPx(fine, DRAWN_Z_MAX)).toBeLessThan(limit * 0.8)
    // the same statement in ground units: a tile pixel at the ceiling is well
    // inside the data's own step
    const pxPerDeg = (TILE_PX * 2 ** DRAWN_Z_MAX) / 360
    expect((1 / pxPerDeg) * 111_320).toBeLessThan(200)
    expect(DRAWN_PX_PER_DEG).toBe(pxPerDeg)
  })

  it('quotes its resolution the way a raster source does', () => {
    // maxLevel is the WMS rule read forwards; a vector source has no native
    // resolution, so its declared one is derived from the ceiling instead. The
    // two must agree or anything reasoning about sources in general is wrong.
    expect(maxLevel({ pxPerDeg: DRAWN_PX_PER_DEG })).toBe(DRAWN_Z_MAX)
  })
})

/**
 * ROUND 57 — the third rung.
 *
 * Natural Earth 10m, from `@cublya/world-atlas` (the only reachable package
 * that publishes it; see scripts/vendor-map-data.mjs). Five things have to hold
 * for it to be a rung rather than a bigger download: the level it engages at
 * has to be derived, the file must not be fetched before that level is drawn,
 * the cut into cells that makes it affordable must not change the drawing, the
 * antimeridian machinery must survive data seven times denser, and a tile must
 * still be 8 ms.
 */
describe('the 10m rung', () => {
  const NORWAY = (z: number) => ({
    z,
    // 5.5–6.5° E, 61–62° N: the Sognefjord, which is where 50m facets and 10m
    // does not — and which straddles the 5.625° chunk wall, deliberately.
    x: Math.floor(((6.0 + 180) / 360) * 2 ** z),
    y: Math.floor(((90 - 61.5) / 180) * 2 ** (z - 1)),
  })
  const AEGEAN = (z: number) => ({
    z,
    x: Math.floor(((23.5 + 180) / 360) * 2 ** z),
    y: Math.floor(((90 - 38.0) / 180) * 2 ** (z - 1)),
  })
  /**
   * Is this pixel the land's own tone?
   *
   * 40 of summed channel distance, which is one number doing two jobs: it is
   * above the dark paper fleck (34 at its alpha, and the fleck is over
   * everything by design) and far below the sea (107) and every step of the
   * wash. So "the land moved" cannot be answered by the paper.
   */
  const isLand = (px: Uint8ClampedArray, i: number) => {
    const [r, g, b] = [1, 3, 5].map((k) => parseInt(PAPER.land.slice(k, k + 2), 16))
    return Math.abs(px[i] - r) + Math.abs(px[i + 1] - g) + Math.abs(px[i + 2] - b) < 40
  }

  /** Deep inland: no coast, no wall of the chunk grid may show here either. */
  const SIBERIA = (z: number) => ({
    z,
    x: Math.floor(((100 + 180) / 360) * 2 ** z),
    y: Math.floor(((90 - 62) / 180) * 2 ** (z - 1)),
  })

  it('picks the rung by level, and names it apart from the others', () => {
    const w = fineWorld()
    // below the rung, 50m — the finer file exists and is deliberately not used
    expect(landAt(w, LOD_FINE_Z - 1)[0]).toBe(w.land)
    expect(landAt(w, LOD_FINE_Z)[0]).toBe(w.fineLand)
    expect(landAt(w, DRAWN_Z_MAX)[0]).toBe(w.fineLand)
    // …and without it, the map is exactly the map it was
    expect(landAt(world(), LOD_FINE_Z)[0]).toBe(world().land)
    expect(landAt(world(), DRAWN_Z_MAX)[1]).toBe('land')
    // THE CACHE-LABEL LESSON, round 49's, now with three answers: the path cache
    // is keyed by this name, so two rungs sharing one would hand out a path
    // built from 50m geometry for a 10m shape at the same index.
    const names = [
      landAt(w, 0)[1],
      landAt(w, LOD_Z)[1],
      landAt(w, LOD_FINE_Z)[1],
    ]
    expect(new Set(names).size).toBe(3)
  })

  it('asks for the file only when a plate is drawn that needs it', () => {
    // THE PROGRESSIVE LOAD, and the whole of it. 851 kB gzipped is not fetched
    // at load, on a timer, or on a guess about where the camera is going: it is
    // fetched the first time something draws at a level 50m cannot answer.
    let asked = 0
    const w: DrawnWorld = { ...world(), requestFine: () => asked++ }
    const s = surface()
    const r = new DrawnRenderer(w)
    for (const z of [4, 5, 6, LOD_FINE_Z - 1]) r.draw(s.ctx, EUROPE(z))
    expect(asked).toBe(0)
    r.draw(s.ctx, EUROPE(LOD_FINE_Z))
    expect(asked).toBe(1)
    // the world texture is a 4096-wide plate at z=0, and it is level 3 — so the
    // build-time render never asks either, which is why it stays 50m-drawn
    new DrawnRenderer(w).draw(s.ctx, { z: 0, x: 0, y: 0, px: 4096 })
    expect(asked).toBe(1)
  })

  it('says more about a coast than 50m does, which is the point of it', () => {
    // Not a shape test — a count. Over the Sognefjord's own degree square the
    // 10m file carries an order of magnitude more coastline, and that is the
    // difference between a fjord and a notch.
    const box = { minLng: 5, maxLng: 7, minLat: 60.8, maxLat: 61.8 }
    const points = (layer: Layer) =>
      shapesNear(layer, box).reduce((n, i) => {
        const s = layer.shapes[i]
        let inside = 0
        for (let p = 0; p < s.pts.length; p += 2)
          if (
            s.pts[p] >= box.minLng &&
            s.pts[p] <= box.maxLng &&
            s.pts[p + 1] >= box.minLat &&
            s.pts[p + 1] <= box.maxLat
          )
            inside++
        return n + inside
      }, 0)
    // measured: 38 vertices of coast at 50m, 497 at 10m
    const coarse = points(world().land!)
    const fine = points(fineWorld().fineLand!)
    expect(coarse).toBeGreaterThan(20)
    expect(fine / coarse).toBeGreaterThan(8)
  })

  it('cuts the giants into cells without changing the drawing', () => {
    // The cut is what makes 10m affordable: six shapes hold 201 604 of the
    // 441 523 points, and a tile that names one of them walks all of it. Cut to
    // the chunk grid the same tile is 0.3 ms — but a cut that changed the
    // picture would be a cheat, so this renders the same tiles from the WHOLE
    // 10m layer and compares.
    const whole = layerOf(read('land-10m.json'), 'land', true)
    expect(whole.shapes.length).toBeLessThan(fineLand().shapes.length)
    const wholeWorld = { ...world(), fineLand: whole }
    const a = new DrawnRenderer(wholeWorld)
    const b = new DrawnRenderer(fineWorld())
    // The claim is about WHERE THE LAND IS, which is what a cut could break —
    // not about every byte. What legitimately differs is the engraved tick's
    // dash phase: it runs from each ring's own first vertex, so it restarts at
    // a cell wall and the stipple in the shoreline wash lands a pixel or two
    // along. That moves tones inside the wash's own three steps and moves no
    // coastline.
    for (const tile of [NORWAY(9), AEGEAN(9), SIBERIA(8)]) {
      const sa = surface()
      const sb = surface()
      a.draw(sa.ctx, tile)
      b.draw(sb.ctx, tile)
      const pa = sa.pixels()
      const pb = sb.pixels()
      let moved = 0
      let any = 0
      for (let i = 0; i < pa.length; i += 4) {
        if (isLand(pa, i) !== isLand(pb, i)) moved++
        const d =
          Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])
        if (d > 8) any++
      }
      // The coastline is where it was, to within the half-pixel filter's own
      // freedom: `MIN_SEG_PX` keeps a vertex when the last KEPT one is half a
      // pixel away, so a ring that starts at a different vertex — which is what
      // cutting a ring does — can keep a different subset of it and land half a
      // pixel out. Measured: 40 pixels of 262 144 at the Sognefjord, none
      // anywhere else, and every one of them on the coastline itself.
      expect(moved).toBeLessThan(TILE_PX * TILE_PX * 0.0005)
      // …and the stipple's own wander is under 4% of the plate
      expect(any).toBeLessThan(TILE_PX * TILE_PX * 0.04)
    }
  })

  it('fills the interior it cut, and draws no wall there', () => {
    // The failure this defends against is specific and would be catastrophic:
    // clipping Eurasia to a cell of the Gobi returns nothing, and nothing is a
    // hole in Asia. A cell no ring reaches but whose centre is inside one
    // becomes the cell itself — filled, and marked seam so the pen skips it.
    // No rivers and no lakes in this world, deliberately: at level 8 the water
    // layers are still half visible and the Lena would answer the question
    // "is every pixel of interior Siberia the land's tone" for the wrong reason.
    const dry: DrawnWorld = { coarseLand: world().coarseLand, land: world().land, fineLand: fineLand() }
    const r = new DrawnRenderer(dry)
    for (const tile of [SIBERIA(8), SIBERIA(11), { z: 9, x: 306, y: 128 }]) {
      const s = surface()
      r.draw(s.ctx, tile)
      const px = s.pixels()
      let off = 0
      for (let i = 0; i < px.length; i += 4) if (!isLand(px, i)) off++
      expect(`${tile.z}/${tile.x}/${tile.y}: ${off}`).toBe(`${tile.z}/${tile.x}/${tile.y}: 0`)
    }
  })

  it('keeps the antimeridian and the poles it inherited', () => {
    const fine = fineLand()
    // 1. no segment spans the world that is not a marked closure
    for (let s = 0; s < fine.shapes.length; s++) {
      const shape = fine.shapes[s]
      for (let r = 0; r + 1 < shape.rings.length; r++)
        for (let i = shape.rings[r]; i + 1 < shape.rings[r + 1]; i++)
          if (Math.abs(shape.pts[i * 2 + 2] - shape.pts[i * 2]) > 180)
            expect(`fine#${s}:${i} seam=${shape.seam?.[i]}`).toContain('seam=1')
    }
    // 2. EVERY edge that runs along ±180 is the clip's and is marked, so the
    //    pen never follows one. This is the round-51 rule and the round-57
    //    addition to it: 10m carries the meridian in the DATA — Natural Earth's
    //    own ring walks 68.98° N down to 65.07° N along −180 — and unmarked
    //    that is four degrees of ink and wash down the Bering Sea.
    let meridian = 0
    for (const shape of fine.shapes) {
      for (let r = 0; r + 1 < shape.rings.length; r++) {
        const from = shape.rings[r]
        const to = shape.rings[r + 1]
        for (let i = from; i < to; i++) {
          const j = i + 1 === to ? from : i + 1
          const x = shape.pts[i * 2]
          if (Math.abs(x) !== 180 || shape.pts[j * 2] !== x) continue
          meridian++
          expect(`${x} at ${shape.pts[i * 2 + 1].toFixed(2)}: ${shape.seam?.[i]}`).toBe(
            `${x} at ${shape.pts[i * 2 + 1].toFixed(2)}: 1`,
          )
        }
      }
    }
    expect(meridian).toBeGreaterThan(4)
    // 3. Antarctica still reaches the pole rather than being sealed with a bar
    //    across the Pacific. The chunk grid cuts it into cells; the southern
    //    edge of the southernmost of them is 90° S.
    const south = Math.min(...fine.shapes.map((s) => s.bbox[1]))
    expect(south).toBe(-90)
  })

  it('gives the pen no cell wall to follow', () => {
    // Same recording trick as round 51's: the fill wants the wall edges (they
    // are what makes a piece a polygon), the pen must not draw them, or the map
    // grows a 5.625° grid of coastline. Checked as "the stroke path has no long
    // straight run the fill path does not have", at the level the rung starts.
    class Rec {
      ops: [string, number, number][] = []
      moveTo(x: number, y: number) {
        this.ops.push(['M', x, y])
      }
      lineTo(x: number, y: number) {
        this.ops.push(['L', x, y])
      }
      closePath() {
        this.ops.push(['Z', 0, 0])
      }
    }
    const held = (globalThis as unknown as { Path2D: unknown }).Path2D
    ;(globalThis as unknown as { Path2D: unknown }).Path2D = Rec
    try {
      const paths = new LevelPaths(LOD_FINE_Z)
      const fine = fineLand()
      const wallPx = (CHUNK_DEG * paths.worldPx) / 360
      let walls = 0
      let penWalls = 0
      for (let i = 0; i < fine.shapes.length; i++) {
        for (const which of ['fill', 'stroke'] as const) {
          const ops = (paths.path(fine, 'fine', i)[which] as unknown as Rec).ops
          let at: [number, number] | undefined
          for (const [op, x, y] of ops) {
            if (op !== 'L') {
              at = op === 'M' ? [x, y] : undefined
              continue
            }
            // a run along a wall: axis-aligned, and a fair fraction of a cell
            const long =
              at &&
              ((Math.abs(x - at[0]) < 0.01 && Math.abs(y - at[1]) > wallPx * 0.5) ||
                (Math.abs(y - at[1]) < 0.01 && Math.abs(x - at[0]) > wallPx * 0.5))
            if (long) which === 'fill' ? walls++ : penWalls++
            at = [x, y]
          }
        }
      }
      // the fill is made of them…
      expect(walls).toBeGreaterThan(100)
      // …and the pen never draws one
      expect(penWalls).toBe(0)
    } finally {
      ;(globalThis as unknown as { Path2D: unknown }).Path2D = held
    }
  })

  it('draws the same tile twice, and meets its neighbour, on the finer data', () => {
    const r = new DrawnRenderer(fineWorld())
    const a = surface()
    const b = surface()
    r.draw(a.ctx, NORWAY(10))
    new DrawnRenderer(fineWorld()).draw(b.ctx, NORWAY(10))
    expect(Buffer.from(b.pixels()).equals(Buffer.from(a.pixels()))).toBe(true)
    // …and the join, at the level the rung is finest at
    const left = surface()
    const right = surface()
    const t = NORWAY(DRAWN_Z_MAX)
    r.draw(left.ctx, t)
    r.draw(right.ctx, { ...t, x: t.x + 1 })
    const pa = left.pixels()
    const pb = right.pixels()
    let seam = 0
    let inside = 0
    for (let y = 0; y < TILE_PX; y++) {
      for (let c = 0; c < 3; c++) {
        seam += Math.abs(pa[(y * TILE_PX + TILE_PX - 1) * 4 + c] - pb[(y * TILE_PX) * 4 + c])
        inside += Math.abs(
          pa[(y * TILE_PX + TILE_PX - 2) * 4 + c] - pa[(y * TILE_PX + TILE_PX - 1) * 4 + c],
        )
      }
    }
    expect(seam).toBeLessThanOrEqual(Math.max(inside * 2, TILE_PX * 3))
  })

  it('renders a tile of the finer data inside the same 8 ms budget', () => {
    const s = surface()
    const r = new DrawnRenderer(fineWorld())
    const times: number[] = []
    for (const t of [NORWAY, AEGEAN, SIBERIA]) {
      for (let z = LOD_FINE_Z; z <= DRAWN_Z_MAX; z++) {
        r.draw(s.ctx, t(z)) // warm the level's paths, which is once per level
        const t0 = performance.now()
        r.draw(s.ctx, t(z))
        times.push(performance.now() - t0)
      }
    }
    // Measured 0.21–0.85 ms mean and 2.9 ms worst over the whole level range
    // AFTER the cut; before it the same tiles were 11–29 ms, which is the
    // measurement the chunker exists for.
    expect(Math.max(...times)).toBeLessThan(8)
  })

  it('vendors the file as a named, public-domain source', () => {
    const credits = readFileSync('public/data/map/CREDITS.md', 'utf8')
    expect(credits).toMatch(/land-10m\.json/)
    expect(credits).toMatch(/@cublya\/world-atlas/)
    expect(credits).toMatch(/public domain/i)
    // and the vendor script takes it from a package, not from a URL somebody
    // has to be online for
    const vendor = readFileSync('scripts/vendor-map-data.mjs', 'utf8')
    expect(vendor).toMatch(/node_modules\/@cublya\/world-atlas\/land-10m\.json/)
  })
})

/**
 * ROUND 58 — WHERE THE RUNG IS DECODED, which turned out to be the whole of the
 * "map mode is slow when zooming in" report.
 *
 * Round 57 got the trigger right (a plate at level 7 is a reader at a coast)
 * and the thread wrong: the fetch's continuation — 140–260 ms of `JSON.parse`
 * and 510–670 ms of `layerOf` + `chunkShape`, measured — ran inside the ONE
 * worker that also draws every tile. A tile is 0.27–0.62 ms, so the decode is
 * upwards of fifteen hundred tiles' worth of work that cannot yield, started by
 * a reader in the middle of the zoom that triggered it. The atlas takes two
 * slots a frame and had nothing to take for the length of the gesture.
 *
 * So the decode moved to a second worker and the layer is handed over packed.
 * Three claims, and all three are things that could quietly stop being true.
 */
describe('the rung arrives without stopping the pen', () => {
  /** The Sognefjord again: the worst case the 10m rung has. */
  const NORWAY_TILE = (z: number) => ({
    z,
    x: Math.floor(((6.0 + 180) / 360) * 2 ** z),
    y: Math.floor(((90 - 61.5) / 180) * 2 ** (z - 1)),
  })

  it('is the same layer on the other side of the wire', () => {
    const layer = fineLand()
    const packed = packLayer(layer)
    const back = unpackLayer(packed)
    expect(back.shapes.length).toBe(layer.shapes.length)
    expect(back.closed).toBe(layer.closed)
    for (let i = 0; i < layer.shapes.length; i++) {
      const a = layer.shapes[i]
      const b = back.shapes[i]
      expect(Array.from(b.pts)).toEqual(Array.from(a.pts))
      // `rings` indexes points RELATIVE to the shape, which is the one thing a
      // flattened layer could plausibly get wrong.
      expect(Array.from(b.rings)).toEqual(Array.from(a.rings))
      expect(b.bbox).toEqual(a.bbox)
      expect(b.seam ? Array.from(b.seam) : undefined).toEqual(
        a.seam ? Array.from(a.seam) : undefined,
      )
    }
    // The bucket grid is sparse — a cell no shape reaches has no list at all —
    // and `shapesNear` reads that emptiness, so it has to survive the trip.
    expect(back.buckets.length).toBe(layer.buckets.length)
    for (let c = 0; c < layer.buckets.length; c++)
      expect(back.buckets[c] ? Array.from(back.buckets[c]) : undefined).toEqual(
        layer.buckets[c] ? Array.from(layer.buckets[c]) : undefined,
      )
  })

  it('draws the same tile from the layer that came over the wire', () => {
    // The claim the round has to keep: nothing about the PICTURE changed, only
    // which thread decoded it. Same tile, same bytes.
    const a = surface()
    const b = surface()
    new DrawnRenderer(fineWorld()).draw(a.ctx, NORWAY_TILE(10))
    new DrawnRenderer({ ...world(), fineLand: unpackLayer(packLayer(fineLand())) }).draw(
      b.ctx,
      NORWAY_TILE(10),
    )
    expect(Array.from(b.pixels())).toEqual(Array.from(a.pixels()))
  })

  it('hands over views, not copies', () => {
    // Nine buffers, all transferable, and every shape a `subarray` of them —
    // which is what makes installing 7.5 MB of geometry cost nothing on the
    // thread that receives it. A copy here would be a stall on the render
    // worker, i.e. the defect this round removed, in a new place.
    const packed = packLayer(fineLand())
    const buffers = packedBuffers(packed)
    expect(buffers.length).toBe(9)
    expect(new Set(buffers).size).toBe(9)
    const back = unpackLayer(packed)
    expect(back.shapes[0].pts.buffer).toBe(packed.pts.buffer)
    expect(back.shapes[back.shapes.length - 1].rings.buffer).toBe(packed.rings.buffer)
  })

  it('will not fetch the rung on the thread that draws', async () => {
    // The tile worker passes `fine: false`, and this is what that buys: there
    // is no `requestFine` on its world at all, so `DrawnRenderer.draw` cannot
    // start a 3.3 MB parse behind the tile it is drawing.
    const asked: string[] = []
    const files: Record<string, unknown> = {
      'land-110m.json': read('land-110m.json'),
      'land-50m.json': read('land-50m.json'),
      'water-50m.json': read('water-50m.json'),
      'land-10m.json': read('land-10m.json'),
    }
    const stub = ((url: string) => {
      const name = url.split('/').pop() as string
      asked.push(name)
      return Promise.resolve({ json: () => Promise.resolve(files[name]) })
    }) as unknown as typeof fetch
    const real = globalThis.fetch
    globalThis.fetch = stub
    try {
      const held = await loadWorld('/', undefined, { fine: false })
      expect(held.requestFine).toBeUndefined()
      new DrawnRenderer(held).draw(surface().ctx, NORWAY_TILE(LOD_FINE_Z))
      await Promise.resolve()
      expect(asked).not.toContain('land-10m.json')
      // …and the default is unchanged, because the main-thread fallback (no
      // worker anywhere) still has nowhere better to run it.
      const own = await loadWorld('/')
      expect(own.requestFine).toBeDefined()
    } finally {
      globalThis.fetch = real
    }
  })

  it('asks for the rung on the first tile request that needs it, and not before', () => {
    // The trigger moved one step up the same causal chain: it used to fire when
    // the rasterizer DREW a plate at level 7, and now fires when the scheduler
    // ASKS for a tile at level 7 — the request that causes that plate. Same
    // reader, same moment, and now the work lands on a thread with no canvas.
    const spawned: { url: string; posts: unknown[] }[] = []
    class FakeWorker {
      posts: unknown[] = []
      onmessage: unknown
      onerror: unknown
      constructor(url: URL) {
        spawned.push(this as unknown as { url: string; posts: unknown[] })
        ;(this as unknown as { url: string }).url = String(url)
      }
      postMessage(m: unknown) {
        this.posts.push(m)
      }
      terminate() {}
    }
    const g = globalThis as unknown as { Worker?: unknown }
    const real = g.Worker
    g.Worker = FakeWorker
    try {
      const tiles = new DrawnTiles('/base/')
      // No OffscreenCanvas in node, so the render worker is not spawned and
      // every tile below takes the local path — which throws, and is not what
      // is being measured. What is measured is who asks for the rung.
      for (const z of [4, 6, LOD_FINE_Z - 1])
        void tiles.source.render?.({ z, x: 1, y: 1 }).catch(() => {})
      expect(spawned.length).toBe(0)
      void tiles.source.render?.({ z: LOD_FINE_Z, x: 1, y: 1 }).catch(() => {})
      expect(spawned.length).toBe(1)
      expect(spawned[0].url).toMatch(/drawnDecode\.worker/)
      expect(spawned[0].posts).toEqual([{ base: '/base/' }])
      // …and once. The file is 851 kB gzipped and the answer does not change.
      void tiles.source.render?.({ z: LOD_FINE_Z + 1, x: 2, y: 1 }).catch(() => {})
      expect(spawned.length).toBe(1)
      tiles.dispose()
    } finally {
      g.Worker = real
    }
  })

  /**
   * ROUND 61 — the geometry load, started before the first tile is asked for.
   *
   * The worker loads the vector world lazily, on its first tile request, which
   * puts a fetch and a parse inside the click that switched the mode. `prime`
   * is the same load asked for on INTENT (a pointer arriving at the toggle),
   * and it must be idempotent and must answer nothing.
   */
  it('primes the rasterizer without asking it for a tile', () => {
    const spawned: { url: string; posts: unknown[] }[] = []
    class FakeWorker {
      posts: unknown[] = []
      onmessage: unknown
      onerror: unknown
      constructor(url: URL) {
        spawned.push(this as unknown as { url: string; posts: unknown[] })
        ;(this as unknown as { url: string }).url = String(url)
      }
      postMessage(m: unknown) {
        this.posts.push(m)
      }
      terminate() {}
    }
    const g = globalThis as unknown as { Worker?: unknown; OffscreenCanvas?: unknown }
    const real = g.Worker
    const realCanvas = g.OffscreenCanvas
    g.Worker = FakeWorker
    // The render worker is only spawned where OffscreenCanvas exists; node has
    // none, and without one there is nothing to prime (see `prime`).
    g.OffscreenCanvas = class {}
    try {
      const tiles = new DrawnTiles('/base/')
      expect(spawned.length).toBe(1)
      expect(spawned[0].url).toMatch(/drawnTile\.worker/)
      tiles.prime()
      expect(spawned[0].posts).toEqual([{ prime: true, base: '/base/' }])
      // …once. A second pointer is not a second world to parse.
      tiles.prime()
      expect(spawned[0].posts).toHaveLength(1)
      // and it spawns nothing of its own: the decode worker is still the 10m
      // rung's, and no tile has asked for that.
      expect(spawned.length).toBe(1)
      tiles.dispose()
    } finally {
      g.Worker = real
      g.OffscreenCanvas = realCanvas
    }
  })

  it('has nothing to prime where there is no worker to prime', () => {
    // Without OffscreenCanvas the rasterizer runs on the main thread and loads
    // the world on its own first tile. Starting that early would move a parse
    // INTO a frame rather than out of one, which is the opposite of the point.
    const g = globalThis as unknown as { Worker?: unknown }
    const real = g.Worker
    g.Worker = undefined
    try {
      const tiles = new DrawnTiles('/base/')
      expect(() => tiles.prime()).not.toThrow()
      tiles.dispose()
    } finally {
      g.Worker = real
    }
  })
})

describe('the era the drawn map is honest in', () => {
  it('streams exactly when the modern basemap is the basemap', () => {
    // the design's rule: drawn tiles stream in every year the modern texture
    // would have. That year is where PALEO_FRAMES stops interpolating
    // reconstructions and pins the modern map.
    expect(DRAWN_ERA_FROM).toBe(PALEO_FRAMES[PALEO_FRAMES.length - 1].time)
    expect(modernShare(DRAWN_FRAMES, DRAWN_ERA_FROM)).toBe(1)
    expect(modernShare(DRAWN_FRAMES, DRAWN_ERA_FROM - 1)).toBeLessThan(1)
  })

  it('is not the imagery era, and carries no zoom clamp with it', () => {
    expect(DRAWN_ERA_FROM).not.toBe(IMAGERY_ERA_FROM)
    // a photograph of 1500 is an anachronism and is held 100 km up
    expect(minAltitudeFor(1500, true, IMAGERY_ERA_FROM)).toBe(MIN_ALTITUDE_PRE_ERA)
    // a drawn coastline of 1500 is a coastline; it may be inspected as closely
    // as one of 2020, which is most of what the drawn map is for
    expect(minAltitudeFor(1500, true, null)).toBe(MIN_ALTITUDE_DETAIL)
    expect(minAltitudeFor(-9000, true, null)).toBe(MIN_ALTITUDE_DETAIL)
  })

  it('swaps only the modern frame, so deep time is inherited whole', () => {
    expect(DRAWN_FRAMES).toHaveLength(PALEO_FRAMES.length)
    expect(DRAWN_FRAMES[DRAWN_FRAMES.length - 1].url).toBe(DRAWN_TEXTURE)
    expect(DRAWN_FRAMES.slice(0, -1).map((f) => f.url)).toEqual(
      PALEO_FRAMES.slice(0, -1).map((f) => f.url),
    )
    expect(DRAWN_FRAMES.map((f) => f.time)).toEqual(PALEO_FRAMES.map((f) => f.time))
    expect(framesFor('drawn')).toBe(DRAWN_FRAMES)
    expect(framesFor('modern')).toBe(PALEO_FRAMES)
  })
})

describe('the drawn source in the pipeline', () => {
  const fake: TileSource = {
    label: 'test',
    pxPerDeg: 1,
    render: async () => ({}) as CanvasImageSource,
  }

  it('retires the tiles it drew before the 50m data landed', () => {
    // The cache is keyed by (z, x, y, source label) and pins whatever the view
    // wants, so a tile drawn from the 110m stand-in — a blunt coastline with no
    // rivers and no lakes in the file at all — would be the tile that view kept
    // for as long as it looked there. Two labels is what makes that impossible:
    // the upgrade renames the source, every key becomes a new key, and the old
    // tiles stop being wanted.
    expect(DRAWN_LABEL).not.toBe(DRAWN_LABEL_COARSE)
    const coarse = buildWorld(read('land-110m.json'))
    expect(coarse.land).toBeUndefined()
    expect(coarse.rivers).toBeUndefined()
    expect(coarse.lakes).toBeUndefined()
  })

  it('is a source, on the same terms as a WMS one', () => {
    const plan = singleSourcePlan(fake, DRAWN_Z_MAX)
    expect(plan.at(4, false)).toBe(fake)
    expect(plan.at(12, true)).toBe(fake)
    expect(plan.zMax).toBe(DRAWN_Z_MAX)
    // a local render that fails is a hole the parent level covers; there is no
    // server to demote and no strike to count
    expect(plan.remote).toBe(false)
    expect(IMAGERY_PLAN.remote).toBe(true)
  })

  it('tells the upload path what the shader already knows: this one is painted', () => {
    // The atlas holds every tile twice — sharp, and reduced to the base map's
    // density — because the ratio path divides by the second one. Paint mode
    // multiplies that ratio out (`uDetailPaint = 1`), so for a drawn tile the
    // reduction is a main-thread `drawImage` of 512 down to as little as 8 at
    // high smoothing quality, plus a GL call, for a texel no fragment samples.
    // One flag, read by both halves of the same decision — see DETAIL_MODE.
    expect(singleSourcePlan(fake, DRAWN_Z_MAX, true).paint).toBe(true)
    expect(singleSourcePlan(fake, DRAWN_Z_MAX).paint).toBe(false)
    expect(IMAGERY_PLAN.paint ?? false).toBe(false)
    // and it is the same answer the shader is given for the same mode
    expect(DETAIL_MODE.paint).toBe(1)
    expect(DETAIL_MODE.ratio).toBe(0)
  })

  it('paints the tile on rather than pushing the base map with it', () => {
    // The ratio path assumes the sharp tile and the base map are one picture at
    // two resolutions. They are not, because the pen is a fixed number of TILE
    // pixels: the level-3 base texture's shoreline wash is 11 texels — about a
    // degree of ground — and a level-9 tile's is 11 pixels, a sixtieth of that.
    // Reduced to the base map's density the tile's wash vanishes and the base
    // map's does not, so the ratio embosses instead of cancelling. Measured in
    // the browser before this: crisp coastline ink standing on a soft grey
    // doubling of itself (tests/e2e/drawnMap.e2e.mjs, step c).
    const style = resolveGlobeStyle(
      {
        clouds: true, cloudShadows: true, atmosphere: true, relief: true, detail: true,
        visuals: 'enhanced', palette: DEFAULT_PALETTE,
      },
      'schematic',
    )
    expect(style.detail).toBe(DETAIL_MODE.paint)
    expect(style.tiles).toBe('drawn')
    expect(
      resolveGlobeStyle(
        {
          clouds: true, cloudShadows: true, atmosphere: true, relief: true, detail: true,
          visuals: 'enhanced', palette: DEFAULT_PALETTE,
        },
        'realistic',
      ).detail,
    ).toBe(DETAIL_MODE.ratio)
  })

  it('keeps the paper palette out of the shader grade', () => {
    // The ground is a drawing and was drawn graded; a second grade over it
    // lifts the paper toward white and closes the sea/land gap the map is made
    // of. The rasterizer owns the palette (PAPER) and the shader owns none.
    expect(PAPER.land).not.toBe(PAPER.ocean)
    const s = resolveGlobeStyle(
      {
        clouds: true, cloudShadows: true, atmosphere: true, relief: true, detail: true,
        visuals: 'enhanced', palette: DEFAULT_PALETTE,
      },
      'schematic',
    )
    expect(s.boost).toBe(0)
    expect(s.palette).toEqual({ saturation: 1, grayscale: 0, contrast: 1 })
  })
})

describe('the side toggle', () => {
  const toggle = readFileSync('src/components/ModeToggle.vue', 'utf8')
  const panel = readFileSync('src/components/SettingsPanel.vue', 'utf8')
  const home = readFileSync('src/views/HomeView.vue', 'utf8')

  it('drives the one setting the panel drives — not a second copy of it', () => {
    // ONE SOURCE OF TRUTH. The setting is shown in two places and stored in
    // one: both controls call the same store action and both read
    // `settings.mode`. A local `ref` in either would be a mode that disagrees
    // with itself the first time a reader used the other control.
    for (const src of [toggle, panel]) {
      expect(src).toMatch(/settings\.setMode\('realistic'\)|setMode\(o\.mode\)/)
      expect(src).toMatch(/settings\.mode ===/)
    }
    expect(toggle).not.toMatch(/\bref\s*\(/)
    expect(home).toMatch(/<ModeToggle\s*\/>/)
  })

  it('is drawn geometry, not a font glyph', () => {
    // Round 47's rule: a character the font lacks renders as a box. Both icons
    // are circles, ellipses and paths in a symmetric viewBox.
    const svgs = [...toggle.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((m) => m[0])
    expect(svgs).toHaveLength(2)
    for (const svg of svgs) {
      expect(svg).toMatch(/viewBox="0 0 24 24"/)
      expect(svg).not.toMatch(/<text|font-family|&#/)
      expect(svg).toMatch(/<(circle|ellipse|path)/)
    }
  })

  it('is a keyboard control with a name for each state', () => {
    expect(toggle).toMatch(/role="radiogroup"/)
    expect(toggle).toMatch(/role="radio"/)
    expect(toggle).toMatch(/:aria-checked="settings\.mode === o\.mode"/)
    // arrow keys move between the two, and focus follows the choice
    expect(toggle).toMatch(/ArrowUp|ArrowDown/)
    expect(toggle).toMatch(/\.focus\(\)/)
    // …and each state says what it does, in the tooltip and to a screen reader
    expect(toggle).toMatch(/:title="o\.hint"/)
    expect(toggle).toMatch(/:aria-label="o\.hint"/)
  })
})
