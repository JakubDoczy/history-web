import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { redChannel, upscaleCloudMask, flipRows, CLOUD_UPSCALE } from '../src/lib/cloudUpscale'
import type { PixelBuffer } from '../src/lib/lanczos'

const buffer = (w: number, h: number, at: (x: number, y: number) => number): PixelBuffer => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = at(x, y)
      const i = (y * w + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return { data, width: w, height: h }
}

describe('redChannel', () => {
  it('keeps red and drops the rest', () => {
    const src: PixelBuffer = {
      data: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]),
      width: 2,
      height: 1,
    }
    expect([...redChannel(src).data]).toEqual([1, 5])
  })

  it('is one byte per texel, not four', () => {
    const out = redChannel(buffer(8, 4, () => 128))
    expect(out.data.length).toBe(32)
    expect(out.width).toBe(8)
    expect(out.height).toBe(4)
  })
})

describe('upscaleCloudMask', () => {
  it('doubles both dimensions by default', () => {
    const out = upscaleCloudMask(buffer(16, 8, () => 100))
    expect(CLOUD_UPSCALE).toBe(2)
    expect([out.width, out.height]).toEqual([32, 16])
  })

  it('leaves a flat mask flat — no ringing out of nothing', () => {
    const out = upscaleCloudMask(buffer(16, 8, () => 100))
    expect([...out.data].every((v) => v === 100)).toBe(true)
  })

  it('keeps a hard edge hard rather than smearing it over the new texels', () => {
    // vertical step at x = 8; after 2x the step should still be one texel wide
    const out = upscaleCloudMask(buffer(16, 8, (x) => (x < 8 ? 0 : 255)))
    const row = [...out.data.slice(4 * out.width, 5 * out.width)]
    expect(row[14]).toBeLessThan(40) // last dark texel before the edge
    expect(row[17]).toBeGreaterThan(215) // first bright one after it
  })

  it('preserves the mask’s overall level (a mean, not a bias)', () => {
    const src = buffer(32, 16, (x, y) => 40 + 60 * Math.sin(x / 3) * Math.cos(y / 4))
    const before = [...src.data].filter((_, i) => i % 4 === 0).reduce((a, b) => a + b, 0) / (32 * 16)
    const out = upscaleCloudMask(src)
    const after = [...out.data].reduce((a, b) => a + b, 0) / (out.width * out.height)
    expect(Math.abs(after - before)).toBeLessThan(1.5)
  })

  it('is a no-op at scale 1, so a source already big enough costs nothing extra', () => {
    const src = buffer(8, 8, (x, y) => x * 8 + y)
    const out = upscaleCloudMask(src, 1)
    expect([...out.data]).toEqual([...src.data].filter((_, i) => i % 4 === 0))
  })
})

describe('flipRows', () => {
  it('reverses row order and nothing else', () => {
    const m = { data: new Uint8Array([1, 2, 3, 4, 5, 6]), width: 3, height: 2 }
    expect([...flipRows(m).data]).toEqual([4, 5, 6, 1, 2, 3])
  })

  it('is its own inverse', () => {
    const m = upscaleCloudMask(buffer(8, 6, (x, y) => x * 7 + y * 13), 1)
    expect([...flipRows(flipRows(m)).data]).toEqual([...m.data])
  })

  it('leaves the columns alone, so the antimeridian cannot move', () => {
    const m = upscaleCloudMask(buffer(8, 6, (x) => x * 30), 1)
    const flipped = flipRows(m)
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) {
        expect(flipped.data[y * m.width + x]).toBe(m.data[(m.height - 1 - y) * m.width + x])
      }
    }
  })
})

describe('the cloud mask sharpen in the shader', () => {
  const glsl = readFileSync('src/lib/globeSurface.ts', 'utf8')

  it('is an unsharp mask, clamped to the mask’s own range', () => {
    expect(glsl).toContain('c + uCloudSharp * (c - blur)')
    expect(glsl).toMatch(/clamp\(c \+ uCloudSharp \* \(c - blur\), 0\.0, 1\.0\)/)
  })

  it('skips its taps entirely when the sharpen is off', () => {
    expect(glsl).toContain('if (uCloudSharp <= 0.0) return c;')
  })

  it('never runs when the clouds are hidden', () => {
    expect(glsl).toContain('uCloudAlpha > 0.0 ? cloudMask(cloudUv) : 0.0')
  })

  it('leaves the shadow tap unsharpened', () => {
    const shadow = glsl.slice(glsl.indexOf('float occ ='))
    expect(shadow.slice(0, 120)).toContain('texture(uClouds')
    expect(shadow.slice(0, 120)).not.toContain('cloudMask(')
  })
})
