import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createCanvas, Path2D as NodePath2D } from '@napi-rs/canvas'
import {
  buildWorld,
  bucketsCovering,
  shapesNear,
  type DrawnWorld,
  type Layer,
} from '../src/lib/drawnGeometry'
import {
  DrawnRenderer,
  LevelPaths,
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
  DRAWN_PX_PER_DEG,
  DRAWN_Z_MAX,
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

  it('derives Z_MAX from where the geometry stops adding, and says why it is higher', () => {
    const land = world().land!
    // the measured claim: the last level that recovers more than 1% more of the
    // data than the one below it
    let saturates = BASE_LEVEL
    let prev = segments(land, BASE_LEVEL)
    for (let z = BASE_LEVEL + 1; z <= 12; z++) {
      const now = segments(land, z)
      if (now / prev > 1.01) saturates = z
      prev = now
    }
    expect(saturates).toBe(DRAWN_GEOMETRY_Z - 1)
    // nothing at all above it: every vertex the DATA has already survives. The
    // slack is the antimeridian clip's own vertices, which are the projection's
    // rather than the data's — `splitAtSeam` puts a point on ±180 beside a data
    // point 0.01° away (Fiji), and 0.01° is half a tile pixel only above z 11.
    expect(segments(land, 12) - segments(land, DRAWN_GEOMETRY_Z + 2)).toBeLessThanOrEqual(4)
    // …and the source still serves finer levels, because the PEN does not
    // saturate with the geometry: ink is a fixed 1.15 tile pixels, so stopping
    // at saturation and magnifying would put a coastline on screen 2^n times
    // too heavy. See DRAWN_Z_MAX.
    expect(DRAWN_Z_MAX).toBeGreaterThan(DRAWN_GEOMETRY_Z)
    // the ceiling is where a tile pixel is finer than the data's own step: the
    // median 50m segment is 7.6 km, and level 9 is 153 m per pixel
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
