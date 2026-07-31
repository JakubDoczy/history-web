import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  GlobeSurface,
  enhancedLuma,
  enhancedWaterLuma,
  waterMask,
  ENHANCED_GRADE,
} from '../src/lib/globeSurface'
import { MAP_FADE_MS } from '../src/lib/mapFade'
import { readFileSync } from 'node:fs'
import type { WebGLRenderer } from 'three'

/**
 * three's loaders reach for the DOM, so the surface can only be built here with
 * `img` stubbed. The stub keeps every element it made, keyed by the URL it was
 * given, so a test can decide when — and at what size — each map "arrives".
 */
class StubImage {
  static made: StubImage[] = []
  width = 0
  height = 0
  src = ''
  crossOrigin?: string
  private listeners = new Map<string, ((e?: unknown) => void)[]>()
  addEventListener(type: string, fn: (e?: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  removeEventListener(type: string, fn: (e?: unknown) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn))
  }
  arrive(width: number, height: number) {
    this.width = width
    this.height = height
    for (const fn of this.listeners.get('load') ?? []) fn.call(this)
  }
}

const URLS = { day: '/day.jpg', night: '/night.jpg', relief: '/relief.png', clouds: '/clouds.jpg' }
const renderer = {
  capabilities: { getMaxAnisotropy: () => 4, maxTextureSize: 8192 },
} as unknown as WebGLRenderer
const imageFor = (url: string) => StubImage.made.find((i) => i.src === url)!

describe('GlobeSurface', () => {
  beforeEach(() => {
    StubImage.made = []
    vi.stubGlobal('document', {
      createElementNS: () => {
        const img = new StubImage()
        StubImage.made.push(img)
        return img
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('steps the relief gradient by the relief map own texel, not the colour map one', () => {
    // the height field is half the resolution of the colour maps; using theirs
    // took the finite difference over half a texel and halved every slope
    const surface = new GlobeSurface(URLS, renderer)
    imageFor(URLS.day).arrive(4096, 2048)
    surface.loadRest()
    imageFor(URLS.relief).arrive(2048, 1024)
    const texel = surface.material.uniforms.uTexel.value
    expect(texel.x).toBeCloseTo(1 / 2048, 9)
    expect(texel.y).toBeCloseTo(1 / 1024, 9)
  })

  it('keeps the relief step square, whatever the height field size', () => {
    const surface = new GlobeSurface(URLS, renderer)
    surface.loadRest()
    imageFor(URLS.relief).arrive(8192, 4096)
    const texel = surface.material.uniforms.uTexel.value
    expect(texel.y / texel.x).toBeCloseTo(2, 6) // an equirectangular map is 2:1
  })

  it('carries every uniform the fragment shader declares', () => {
    // a uniform the shader reads but the material never declares silently stays
    // at zero, which is invisible in review and wrong on screen
    const surface = new GlobeSurface(URLS, renderer)
    const declared = [...surface.material.fragmentShader.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)]
      .map((m) => m[1])
    for (const name of declared) expect(surface.material.uniforms).toHaveProperty(name)
  })

  describe('upgrade', () => {
    /** `upgrade` uses `new Image()` directly rather than three's loader. */
    class BareImage {
      static last?: BareImage
      crossOrigin = ''
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      src = ''
      constructor() {
        BareImage.last = this
      }
    }
    beforeEach(() => vi.stubGlobal('Image', BareImage))

    it('leaves the era textures alone when the sharper basemap fails to arrive', () => {
      const surface = new GlobeSurface(URLS, renderer)
      const before = surface.material.uniforms.uEraA.value
      surface.upgrade(URLS.day, '/nope.jpg')
      BareImage.last!.onerror!()
      expect(surface.material.uniforms.uEraA.value).toBe(before)
    })

    it('swaps every uniform still holding the map it replaces', () => {
      // uEraA and uEraB both start on the day map; missing either would leave
      // half of an era crossfade on the old texture
      const surface = new GlobeSurface(URLS, renderer)
      const before = surface.material.uniforms.uEraA.value
      surface.upgrade(URLS.day, '/sharper.jpg')
      BareImage.last!.onload!()
      const u = surface.material.uniforms
      expect(u.uEraA.value).not.toBe(before)
      expect(u.uEraB.value).toBe(u.uEraA.value)
      expect(u.uNight.value).not.toBe(u.uEraA.value) // a different map, untouched
      expect(surface.texture(URLS.day)).toBe(u.uEraA.value) // and the cache agrees
    })
  })
})

/**
 * The enhanced grade. The shader is not runnable here, so the TS mirror of the
 * curve is what these check — and a source assertion keeps the two in step.
 */
describe('enhanced tone curve', () => {
  const luma = enhancedLuma
  // measured off the bundled basemap, in linear light
  const EUROPE = [0.012, 0.024, 0.035, 0.047, 0.064]
  const DEEP_OCEAN = [0.003, 0.008, 0.015]
  const DESERT = [0.16, 0.28, 0.35, 0.39, 0.47]

  const spread = (xs: number[]) => {
    const g = xs.map((x) => Math.pow(luma(x), 1 / 2.2))
    return g[g.length - 1] - g[0]
  }

  it('is monotonic, so no two shades ever swap order', () => {
    let last = -1
    for (let l = 0; l <= 1.0001; l += 0.002) {
      const v = luma(l)
      expect(v).toBeGreaterThan(last)
      last = v
    }
  })

  it('pulls Europe apart: the temperate band gets far more grey levels', () => {
    const before = Math.pow(EUROPE[4], 1 / 2.2) - Math.pow(EUROPE[0], 1 / 2.2)
    expect(spread(EUROPE) / before).toBeGreaterThan(1.5)
  })

  it('lifts the temperate midtone well clear of black', () => {
    expect(luma(0.035)).toBeGreaterThan(0.035 * 2)
  })

  it('drives the darkest water further down when the land curve is applied to it', () => {
    // which is exactly why water does not get the land curve — see below
    expect(luma(DEEP_OCEAN[0])).toBeLessThan(DEEP_OCEAN[0])
  })

  it('holds the land curve back from water, or the sea would rise with the land', () => {
    // open ocean overlaps Europe's luminance band, so the curve alone would
    // brighten it too and erase the coastline the grade exists to reveal
    expect(luma(DEEP_OCEAN[1])).toBeGreaterThan(DEEP_OCEAN[1]) // curve alone lifts it
    expect(ENHANCED_GRADE.waterHold).toBeGreaterThan(0.5) // the blueness mask holds it back
    expect(ENHANCED_GRADE.waterHold).toBeLessThanOrEqual(1)
  })

  it('recognises the darkest ocean as water, not as land', () => {
    // the absolute test this replaced scored the abyss at 0.16, so the very
    // water that rendered black took nearly the full land curve
    expect(waterMask(0.0006, 0.0003, 0.0057)).toBeCloseTo(1, 3) // mid-Pacific
    expect(waterMask(0.002, 0.004, 0.012)).toBeCloseTo(1, 3) // deep ocean
    expect(waterMask(0.01, 0.02, 0.05)).toBeCloseTo(1, 3) // shelf
  })

  it('does not mistake land, cloud or ice for water', () => {
    expect(waterMask(0.35, 0.22, 0.09)).toBe(0) // desert
    expect(waterMask(0.02, 0.03, 0.012)).toBe(0) // forest
    expect(waterMask(0.9, 0.92, 0.95)).toBeLessThan(0.1) // cloud: barely blue
    expect(waterMask(0.8, 0.85, 0.9)).toBeLessThan(0.2) // ice
  })

  it('lifts every shade of water instead of leaving it where it was', () => {
    // the complaint this exists to answer: the mid-Pacific rendered black,
    // because withholding the land curve meant water got no treatment at all
    for (const l of DEEP_OCEAN) {
      expect(enhancedWaterLuma(l)).toBeGreaterThan(l * 1.5)
    }
  })

  it('keeps water plainly darker than the land beside it', () => {
    // a coastline is only legible if the sea stays the darker side of it
    for (const l of [...DEEP_OCEAN, 0.024, 0.035]) {
      expect(enhancedWaterLuma(l)).toBeLessThan(luma(l * 3)) // land of any nearby shade
    }
    expect(enhancedWaterLuma(0.035)).toBeLessThan(luma(0.035))
  })

  it('lifts water by a plain multiplier, so its hue cannot drift', () => {
    // a per-channel gain scales luminance by the same factor it scales each
    // channel: blue stays blue, rather than sliding toward cyan or grey
    const ratios = [0.003, 0.01, 0.03].map((l) => enhancedWaterLuma(l) / l)
    for (const r of ratios) expect(r).toBeLessThan(ENHANCED_GRADE.waterGain)
    expect(ENHANCED_GRADE.waterGain).toBeGreaterThan(1)
    // the gain is strongest exactly where the sea was blackest
    expect(ratios[0]).toBeGreaterThan(ratios[2])
  })

  it('levels the lifted water off, so bright shallows cannot outshine the coast', () => {
    // the lift is a slope at black, not a multiplier: by the time water is as
    // bright as land it has stopped rising and land has not
    for (const l of [0.05, 0.1, 0.3]) {
      expect(enhancedWaterLuma(l)).toBeLessThan(luma(l) * 0.7)
    }
    // and it can never exceed the ceiling by more than the held-back land share
    for (const l of [0.05, 0.2, 1]) {
      const ceiling = ENHANCED_GRADE.waterCeiling * ENHANCED_GRADE.waterHold
      expect(enhancedWaterLuma(l)).toBeLessThanOrEqual(
        ceiling + (1 - ENHANCED_GRADE.waterHold) * luma(l) + 1e-9,
      )
    }
  })

  it('is monotonic on the water branch too', () => {
    let last = -1
    for (let l = 0; l <= 0.5; l += 0.001) {
      const v = enhancedWaterLuma(l)
      expect(v).toBeGreaterThan(last)
      last = v
    }
  })

  it('lifts the day side more than the night side, and the night side not at all', () => {
    // "brighter" must not mean "the dark side goes grey": the extra exposure is
    // multiplied by `daylight`, which is 0 well inside the night hemisphere
    expect(ENHANCED_GRADE.dayExposure).toBeGreaterThan(0)
    expect(ENHANCED_GRADE.exposure).toBe(0.1) // unchanged: what the night side had
  })

  it('does not blow out the desert, and keeps its detail', () => {
    expect(luma(DESERT[DESERT.length - 1])).toBeLessThan(1)
    expect(spread(DESERT)).toBeGreaterThan(0.05) // still separable, just compressed
  })

  it('compresses highlights harder than it stretches midtones', () => {
    const mid = (luma(0.06) - luma(0.03)) / 0.03
    const high = (luma(0.5) - luma(0.4)) / 0.1
    expect(mid).toBeGreaterThan(high)
  })

  it('leaves black at black and white at white', () => {
    expect(luma(0)).toBe(0)
    expect(luma(1)).toBeCloseTo(1, 6)
  })

  it('is the same curve the shader runs', () => {
    const src = readFileSync('src/lib/globeSurface.ts', 'utf8')
    // the GLSL interpolates these constants, so a change here cannot silently
    // leave the shader on the old grade
    expect(src).toMatch(/pow\(max\(lumA, 0\.0\), \$\{f\(1 \/ G\.gamma\)\}\)/)
    expect(src).toMatch(/smoothstep\(\$\{f\(G\.waterLo\)\}, \$\{f\(G\.waterHi\)\}, blueness\)/)
    expect(src).toMatch(/exp\(-\$\{f\(G\.waterGain\)\} \* lumA \/ \$\{f\(G\.waterCeiling\)\}\)/)
    expect(src).toMatch(/vec3 sea = albedo \* \(seaLum \/ max\(lumA, 0\.0008\)\)/)
    expect(src).toMatch(/mix\(graded, sea, \$\{f\(G\.waterHold\)\} \* water\)/)
    // the day-side lift must stay multiplied by `daylight`, or the night side
    // and the terminator brighten with it
    expect(src).toMatch(
      /color \*= 1\.0 \+ uBoost \* \(\$\{f\(G\.exposure\)\} \+ \$\{f\(G\.dayExposure\)\} \* daylight\)/,
    )
  })
})

describe('deferred maps', () => {
  beforeEach(() => {
    StubImage.made = []
    vi.stubGlobal('document', {
      createElementNS: () => {
        const img = new StubImage()
        StubImage.made.push(img)
        return img
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('asks for nothing but the day map before the globe is up', () => {
    // 1.1 MB of download and 75 MB of texture upload that first paint does not
    // need, in front of the one map it does
    new GlobeSurface(URLS, renderer)
    expect(StubImage.made.map((i) => i.src)).toEqual([URLS.day])
  })

  it('renders sensibly with the deferred maps absent', () => {
    // an unbound sampler reads as transparent black, which has to mean "no
    // lights, no terrain, no cloud" rather than "a black planet"
    const surface = new GlobeSurface(URLS, renderer)
    const u = surface.material.uniforms
    expect(u.uNight.value).toBeNull()
    expect(u.uRelief.value).toBeNull()
    expect(u.uClouds.value).toBeNull()
    // and the night side must not multiply an unbound sampler into the picture
    expect(u.uNightMix.value).toBe(0)
    expect(surface.material.fragmentShader).toMatch(/texture\(uNight, vUv\)\.rgb \* uNightMix/)
  })

  it('signals the day map, once, as soon as it decodes', () => {
    const surface = new GlobeSurface(URLS, renderer)
    let calls = 0
    surface.onDayReady = () => calls++
    imageFor(URLS.day).arrive(4096, 2048)
    imageFor(URLS.day).arrive(4096, 2048)
    expect(calls).toBe(1)
  })

  it('requests the rest only when asked', () => {
    const surface = new GlobeSurface(URLS, renderer)
    imageFor(URLS.day).arrive(4096, 2048)
    expect(StubImage.made).toHaveLength(1)
    surface.loadRest()
    expect(StubImage.made.map((i) => i.src).sort()).toEqual(
      [URLS.clouds, URLS.day, URLS.night, URLS.relief].sort(),
    )
  })

  it('fades each map in rather than switching it on', () => {
    // a height field appearing in one frame turns flat ground into lit terrain
    // instantly, which reads as a fault rather than as an arrival
    const surface = new GlobeSurface(URLS, renderer)
    surface.setRelief(0.7)
    surface.setClouds(true, 1, true)
    surface.loadRest()
    const u = surface.material.uniforms
    expect(u.uRelief_.value).toBe(0)
    expect(u.uCloudAlpha.value).toBe(0)

    imageFor(URLS.relief).arrive(2048, 1024)
    imageFor(URLS.clouds).arrive(4096, 2048)
    imageFor(URLS.night).arrive(4096, 2048)
    surface.advance(MAP_FADE_MS / 3)
    expect(u.uRelief_.value).toBeGreaterThan(0)
    expect(u.uRelief_.value).toBeLessThan(0.7)
    expect(u.uNightMix.value).toBeGreaterThan(0)
    expect(u.uNightMix.value).toBeLessThan(1)

    surface.advance(MAP_FADE_MS)
    expect(u.uRelief_.value).toBeCloseTo(0.7, 6)
    expect(u.uNightMix.value).toBe(1)
    expect(u.uCloudAlpha.value).toBeCloseTo(1, 6)
  })

  it('keeps honouring the settings after a map has faded in', () => {
    const surface = new GlobeSurface(URLS, renderer)
    surface.loadRest()
    imageFor(URLS.relief).arrive(2048, 1024)
    imageFor(URLS.clouds).arrive(4096, 2048)
    surface.advance(MAP_FADE_MS * 2)
    surface.setRelief(0)
    expect(surface.material.uniforms.uRelief_.value).toBe(0)
    surface.setClouds(false)
    expect(surface.material.uniforms.uCloudAlpha.value).toBe(0)
    surface.setClouds(true, 0.5, true)
    expect(surface.material.uniforms.uCloudAlpha.value).toBeCloseTo(0.5, 6)
  })
})
