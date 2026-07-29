import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { GlobeSurface } from '../src/lib/globeSurface'
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
const renderer = { capabilities: { getMaxAnisotropy: () => 4 } } as unknown as WebGLRenderer
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
    imageFor(URLS.relief).arrive(2048, 1024)
    const texel = surface.material.uniforms.uTexel.value
    expect(texel.x).toBeCloseTo(1 / 2048, 9)
    expect(texel.y).toBeCloseTo(1 / 1024, 9)
  })

  it('keeps the relief step square, whatever the height field size', () => {
    const surface = new GlobeSurface(URLS, renderer)
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
