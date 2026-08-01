import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  GlobeSurface,
  enhancedLuma,
  enhancedWaterLuma,
  waterMask,
  ENHANCED_GRADE,
  NIGHT_LIGHTS,
  lightsEnergy,
  lightsScale,
  lightsReveal,
} from '../src/lib/globeSurface'
import { MAP_FADE_MS } from '../src/lib/mapFade'
import { eraPlan, ERA_WINDOW, type TextureKeyframe } from '../src/lib/paleo'
import { readFileSync } from 'node:fs'
import { RGBAFormat, RedFormat, SRGBColorSpace, type WebGLRenderer } from 'three'

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

const URLS = {
  day: '/day.jpg',
  night: '/night.jpg',
  relief: '/relief.png',
  clouds: '/clouds.jpg',
  cloudNrm: '/clouds-nrm.webp',
}
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

  it('uploads the two data maps as R8, and the colour maps as they are', () => {
    // the shader reads `.r` from both the height field and the cloud mask, so
    // three quarters of an RGBA8 upload is memory and mipmap work spent on
    // channels nothing samples: 42 MB across the two at their shipped sizes
    const surface = new GlobeSurface(URLS, renderer)
    surface.loadRest()
    const u = surface.material.uniforms
    expect(u.uRelief.value.format).toBe(RedFormat)
    expect(u.uClouds.value.format).toBe(RedFormat)
    expect(u.uEraA.value.format).toBe(RGBAFormat)
    expect(u.uNight.value.format).toBe(RGBAFormat)
    // and the data maps stay linear; grading a height field crushes its mids
    expect(u.uRelief.value.colorSpace).not.toBe(SRGBColorSpace)
    expect(u.uEraA.value.colorSpace).toBe(SRGBColorSpace)
  })

  it('spends anisotropy on the colour maps only', () => {
    // 16x on a data map is 16 texel fetches per sample for detail that does not
    // survive being differenced into a normal or blurred into an alpha
    const big = {
      capabilities: { getMaxAnisotropy: () => 16, maxTextureSize: 8192 },
    } as unknown as WebGLRenderer
    const surface = new GlobeSurface(URLS, big)
    surface.loadRest()
    const u = surface.material.uniforms
    expect(u.uEraA.value.anisotropy).toBe(4)
    expect(u.uNight.value.anisotropy).toBe(4)
    expect(u.uRelief.value.anisotropy).toBe(1)
    expect(u.uClouds.value.anisotropy).toBe(1)
  })

  it('never asks for more anisotropy than the driver has', () => {
    const weak = {
      capabilities: { getMaxAnisotropy: () => 2, maxTextureSize: 4096 },
    } as unknown as WebGLRenderer
    const surface = new GlobeSurface(URLS, weak)
    expect(surface.material.uniforms.uEraA.value.anisotropy).toBe(2)
  })

  it('carries every uniform the fragment shader declares', () => {
    // a uniform the shader reads but the material never declares silently stays
    // at zero, which is invisible in review and wrong on screen
    const surface = new GlobeSurface(URLS, renderer)
    const declared = [...surface.material.fragmentShader.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)]
      .map((m) => m[1])
    for (const name of declared) expect(surface.material.uniforms).toHaveProperty(name)
  })

  /**
   * Deep-time frames: 39 of them, 32 MB each with mips. Everything here is a
   * memory policy — what is bound, what is held, and what is freed.
   */
  describe('era frames', () => {
    const frames: TextureKeyframe[] = Array.from({ length: 8 }, (_, i) => ({
      time: -400e6 + i * 50e6,
      url: `/era${i}.jpg`,
    }))
    /** ...with the day basemap pinned last, exactly as PALEO_FRAMES does. */
    const withModern: TextureKeyframe[] = [...frames, { time: -10_000, url: URLS.day }]
    const at = (t: number, prev?: number) => eraPlan(withModern, t, prev)

    const ready = (surface: GlobeSurface) => {
      surface // the day map decodes first, as it does in the app
      imageFor(URLS.day).arrive(4096, 2048)
    }

    it('never binds a frame that has not decoded', () => {
      // three renders an undecoded texture as black, so an era jump used to
      // black the whole planet out for the length of a decode
      const surface = new GlobeSurface(URLS, renderer)
      ready(surface)
      const day = surface.material.uniforms.uEraA.value
      surface.setEra(at(-300e6))
      expect(surface.material.uniforms.uEraA.value).toBe(day)
      expect(surface.material.uniforms.uEraB.value).toBe(day)
      expect(surface.material.uniforms.uEraMix.value).toBe(0)
    })

    it('swaps to the real frame the moment it lands', () => {
      const surface = new GlobeSurface(URLS, renderer)
      ready(surface)
      surface.setEra(at(-275e6)) // half way between two keyframes
      imageFor('/era2.jpg').arrive(4096, 2048)
      expect(surface.material.uniforms.uEraA.value).toBe(surface.texture('/era2.jpg'))
      // and the second half of the pair is still held at the first: half of a
      // crossfade is a frame of the era, the other half would be black
      expect(surface.material.uniforms.uEraB.value).toBe(surface.texture('/era2.jpg'))
      expect(surface.material.uniforms.uEraMix.value).toBe(0)
      imageFor('/era3.jpg').arrive(4096, 2048)
      expect(surface.material.uniforms.uEraB.value).toBe(surface.texture('/era3.jpg'))
      expect(surface.material.uniforms.uEraMix.value).toBeCloseTo(0.5, 6)
    })

    it('holds the last good frame across a jump to an undecoded era', () => {
      const surface = new GlobeSurface(URLS, renderer)
      ready(surface)
      surface.setEra(at(-350e6))
      imageFor('/era1.jpg').arrive(4096, 2048)
      const shown = surface.material.uniforms.uEraA.value
      surface.setEra(at(-175e6, -350e6)) // era picker: a jump, not a scrub
      expect(surface.material.uniforms.uEraA.value).toBe(shown) // one keyframe stale
      expect(surface.material.uniforms.uEraMix.value).toBe(0) // and not a blend of it
      imageFor('/era4.jpg').arrive(4096, 2048)
      expect(surface.material.uniforms.uEraA.value).not.toBe(shown)
    })

    it('asks for the next frame in the direction of travel', () => {
      const surface = new GlobeSurface(URLS, renderer)
      ready(surface)
      surface.setEra(at(-275e6, -300e6)) // scrubbing toward the present
      expect(imageFor('/era2.jpg')).toBeTruthy() // the pair
      expect(imageFor('/era3.jpg')).toBeTruthy()
      expect(imageFor('/era4.jpg')).toBeTruthy() // and the one it is heading for
      // but nothing behind it: the window retains what it has, it does not fetch
      expect(StubImage.made.some((i) => i.src === '/era1.jpg')).toBe(false)
    })

    it('frees every frame outside the window as the cursor moves', () => {
      const surface = new GlobeSurface(URLS, renderer)
      ready(surface)
      const freed: string[] = []
      let prev: number | undefined
      for (const t of [-400e6, -350e6, -300e6, -250e6, -200e6, -150e6, -100e6, -50e6]) {
        surface.setEra(at(t, prev))
        prev = t
        for (const url of surface.residentEras) {
          const tex = surface.texture(url)
          if (!tex.userData.watched) {
            tex.userData.watched = true
            tex.addEventListener('dispose', () => freed.push(url))
          }
          imageFor(url)?.arrive(4096, 2048)
        }
      }
      // the whole point: residency is bounded by the window, not by how far the
      // timeline has been dragged
      expect(surface.residentEras.length).toBeLessThanOrEqual(2 * ERA_WINDOW + 2)
      expect(freed.length).toBeGreaterThan(0)
      for (const url of freed) expect(surface.residentEras).not.toContain(url)
    })

    it('never frees the basemap, even though it is also the last keyframe', () => {
      // PALEO_FRAMES ends on the modern map, which is the same texture the
      // globe draws for the whole of recorded history
      const surface = new GlobeSurface(URLS, renderer)
      ready(surface)
      let disposed = false
      surface.texture(URLS.day).addEventListener('dispose', () => (disposed = true))
      surface.setEra(at(2026))
      surface.setEra(at(-400e6, 2026))
      expect(disposed).toBe(false)
      expect(surface.texture(URLS.day).image).toBeTruthy()
    })

    it('never frees what the samplers are bound to', () => {
      const surface = new GlobeSurface(URLS, renderer)
      ready(surface)
      surface.setEra(at(-350e6))
      imageFor('/era1.jpg').arrive(4096, 2048)
      let disposed = false
      surface.texture('/era1.jpg').addEventListener('dispose', () => (disposed = true))
      // a jump far enough that era1 is outside the new window, while the shader
      // is still holding it because nothing at the destination has decoded
      surface.setEra(at(-175e6, -350e6))
      expect(surface.material.uniforms.uEraA.value).toBe(surface.texture('/era1.jpg'))
      expect(disposed).toBe(false)
    })
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
      [URLS.clouds, URLS.cloudNrm, URLS.day, URLS.night, URLS.relief].sort(),
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

/**
 * City lights.
 *
 * Every constant below is a *measured* pixel of the map this repo ships
 * (public/textures/base/earth-night.webp), named by where it sits in that
 * map's own distribution of light energy. They are what the shader's constants
 * are tuned against, so a change to either that breaks the relationship fails
 * here rather than on someone's screen.
 *
 *   PACIFIC   sRGB (6, 24, 46)      the blue moonlit base, no lights at all
 *   SAHARA    sRGB (28, 64, 88)     a much brighter base, still no lights
 *   ICE_PEAK  energy 0.0035         the brightest non-light anywhere on the map
 *   SUBURB    sRGB (49, 54, 52)     median of the lit pixels
 *   CORE      sRGB (113, 107, 102)  99th percentile of the lit pixels
 *   PEAK      sRGB (131, 107, 97)   the single brightest light on Earth here
 */
describe('city lights', () => {
  /** One sRGB byte to linear light — the space the shader samples the map in. */
  const s2l = (c: number) => (c <= 10.31475 ? c / 3294.6 : ((c / 255 + 0.055) / 1.055) ** 2.4)
  /** A measured map pixel, as the shader's extraction reads it. */
  const energy = (r: number, b: number) => lightsEnergy(s2l(r), s2l(b))
  const PACIFIC = energy(6, 46)
  const SAHARA = energy(28, 88)
  const SUBURB = energy(49, 52)
  const CORE = energy(113, 102)
  const PEAK = energy(131, 97)
  const ICE_PEAK = 0.0035

  it("reads the map's blue moonlit base as no light at all", () => {
    // this is the reported bug: the base used to be added as emission, so every
    // city sat on a wash nearly as bright as it was and the lights read grey
    expect(PACIFIC).toBe(0)
    expect(SAHARA).toBe(0)
  })

  it('separates the dimmest light from the brightest non-light by a wide margin', () => {
    // a luminance test cannot do this: Antarctic ice and Greenland outshine a
    // small town in this map, which is why the extraction is on colour
    expect(SUBURB).toBeGreaterThan(ICE_PEAK * 3)
    expect(CORE).toBeGreaterThan(ICE_PEAK * 20)
  })

  it('keeps a neutral (LED, mercury vapour) light rather than erasing it', () => {
    // blueBase = 1 would subtract all of a white lamp's own blue; 0.55 leaves a
    // neutral source 45% of its energy while still zeroing the base
    expect(energy(120, 120)).toBeCloseTo((1 - NIGHT_LIGHTS.blueBase) * s2l(120), 6)
    expect(energy(120, 120)).toBeGreaterThan(ICE_PEAK * 20)
  })

  it('normalises to the map it actually ships with', () => {
    // the scale is what makes `threshAt0 - edge >= 1` a real guarantee. If the
    // map's peak fell far short of `peak`, the reveal would open late again —
    // exactly the bug that kept every year before 1978 unlit
    expect(PEAK).toBeGreaterThan(0.9 * NIGHT_LIGHTS.peak)
    expect(PEAK).toBeLessThanOrEqual(NIGHT_LIGHTS.peak)
    expect(lightsScale(PEAK)).toBeGreaterThan(0.95)
    expect(lightsScale(0)).toBe(0)
  })

  it('shows nothing before electrification', () => {
    for (const e of [SUBURB, CORE, PEAK]) expect(lightsReveal(e, 0)).toBe(0)
    // and nothing leaks in just above zero either — 1880 itself must be dark
    expect(lightsReveal(PEAK, 1e-4)).toBe(0)
  })

  it('runs a ramp that actually moves across the electric era', () => {
    // the shipped era factor (lib/sun.ts) evaluated at these years
    const u = { 1900: 0.112, 1930: 0.279, 1950: 0.446, 1970: 0.657, 2016: 0.925 }
    // the great cores first...
    expect(lightsReveal(PEAK, u[1900])).toBeGreaterThan(0.1)
    expect(lightsReveal(SUBURB, u[1900])).toBe(0)
    // ...then whole cities...
    expect(lightsReveal(CORE, u[1930])).toBeGreaterThan(0.4)
    expect(lightsReveal(CORE, u[1950])).toBeGreaterThan(0.9)
    expect(lightsReveal(SUBURB, u[1950])).toBeLessThan(0.5)
    // ...then everything
    expect(lightsReveal(SUBURB, u[1970])).toBeGreaterThan(0.7)
    expect(lightsReveal(SUBURB, u[2016])).toBeCloseTo(1, 3)
    expect(lightsReveal(CORE, u[2016])).toBeCloseTo(1, 3)
  })

  it('is monotonic in both the year and the brightness', () => {
    for (const e of [SUBURB, CORE, PEAK]) {
      let last = -1
      for (let f = 0.05; f <= 1.0001; f += 0.01) {
        const v = lightsReveal(e, f)
        expect(v).toBeGreaterThanOrEqual(last)
        last = v
      }
    }
    for (const f of [0.3, 0.6, 0.925]) {
      expect(lightsReveal(CORE, f)).toBeGreaterThanOrEqual(lightsReveal(SUBURB, f))
    }
  })

  it('emits warm at every level, and reaches white only at the peak', () => {
    const { dim, hot, core } = NIGHT_LIGHTS
    // amber at the outskirts: red is several times blue
    expect(dim[0] / dim[2]).toBeGreaterThan(5)
    // warm white at the cores, but still warm — never a neutral grey
    expect(hot[2]).toBeLessThan(0.8)
    expect(hot[0]).toBe(1)
    // and the ramp only ever warms; it must not cool anything down
    for (let i = 0; i < 3; i++) expect(hot[i]).toBeGreaterThanOrEqual(dim[i])
    // the brightest light on the map lands just past white in red alone, so the
    // very peak clips to warm white and nothing below it does
    expect(PEAK * core * hot[0]).toBeGreaterThan(1)
    expect(CORE * core * hot[1]).toBeLessThan(1)
  })

  it('spills less than it shines', () => {
    // the halo is bloom, not a second copy of the map: if it ever outweighed
    // the sharp tap the cities would smear into a wash
    expect(NIGHT_LIGHTS.halo).toBeLessThan(NIGHT_LIGHTS.core / 3)
    // and it is a LOD *bias*, so the spill is always wider than the pixel and
    // can never be undersampled at the limb the way a fixed level would be
    expect(NIGHT_LIGHTS.haloLod).toBeGreaterThanOrEqual(2)
    expect(readFileSync('src/lib/globeSurface.ts', 'utf8')).toMatch(
      /texture\(uNight, vUv, \$\{f\(N\.haloLod\)\}\)/,
    )
  })
})
