import { describe, it, expect } from 'vitest'
import {
  lanczos,
  lanczosWeights,
  resampleLanczos3,
  LANCZOS_A,
  type PixelBuffer,
} from '../src/lib/lanczos'
import { resampleLanczos3Wasm, resampleRGBA, lanczosKernel } from '../src/lib/lanczosWasm'

const buffer = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = f(x, y)
      const i = (y * w + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return { data, width: w, height: h }
}

const at = (p: PixelBuffer, x: number, y: number) => {
  const i = (y * p.width + x) * 4
  return [p.data[i], p.data[i + 1], p.data[i + 2], p.data[i + 3]]
}

describe('lanczos kernel', () => {
  it('is 1 at the centre — the point sin(0)/0 cannot tell you', () => {
    expect(lanczos(0)).toBe(1)
    expect(Number.isNaN(lanczos(0))).toBe(false)
  })

  it('is zero at every other integer, which is what makes scale 1 an identity', () => {
    for (let k = 1; k < LANCZOS_A; k++) {
      expect(lanczos(k)).toBeCloseTo(0, 12)
      expect(lanczos(-k)).toBeCloseTo(0, 12)
    }
  })

  it('is exactly zero outside its support', () => {
    for (const x of [3, 3.5, 10, -3, -7.25]) expect(lanczos(x)).toBe(0)
  })

  it('is symmetric', () => {
    for (const x of [0.3, 1.1, 2.4]) expect(lanczos(x)).toBeCloseTo(lanczos(-x), 12)
  })
})

describe('lanczosWeights', () => {
  it('sums each destination sample to exactly 1, upscaling', () => {
    const { weights, taps } = lanczosWeights(37, 91)
    for (let i = 0; i < 91; i++) {
      let sum = 0
      for (let k = 0; k < taps; k++) sum += weights[i * taps + k]
      expect(sum).toBeCloseTo(1, 5)
    }
  })

  it('sums to 1 downscaling too, where the filter has to widen', () => {
    const { weights, taps, starts } = lanczosWeights(400, 51)
    for (let i = 0; i < 51; i++) {
      let sum = 0
      for (let k = 0; k < taps; k++) sum += weights[i * taps + k]
      expect(sum).toBeCloseTo(1, 5)
    }
    // widened support: a 7.8x reduction must read far more than 6 samples, or
    // it is point-sampling a signal it never band-limited
    expect(taps).toBeGreaterThan(40)
    expect(starts[25]).toBeLessThan(Math.round(25 * (400 / 51)))
  })

  it('is a delta function at scale 1', () => {
    const { weights, taps, starts } = lanczosWeights(64, 64)
    for (let i = 0; i < 64; i++) {
      for (let k = 0; k < taps; k++) {
        const w = weights[i * taps + k]
        expect(w).toBeCloseTo(starts[i] + k === i ? 1 : 0, 6)
      }
    }
  })

  it('centres samples, not edges — a half-pixel error shifts the whole image', () => {
    // upscaling 2x, destination sample 0 sits a quarter of a source pixel in
    const { starts, weights, taps } = lanczosWeights(8, 16)
    let centroid = 0
    for (let k = 0; k < taps; k++) centroid += (starts[0] + k) * weights[k]
    expect(centroid).toBeCloseTo(-0.25, 1)
  })
})

describe('resampleLanczos3', () => {
  it('reports the dimensions it was asked for', () => {
    const src = buffer(9, 5, () => [1, 2, 3, 255])
    const out = resampleLanczos3(src, 23, 17)
    expect(out.width).toBe(23)
    expect(out.height).toBe(17)
    expect(out.data.length).toBe(23 * 17 * 4)
  })

  it('is the identity at scale 1', () => {
    const src = buffer(16, 12, (x, y) => [(x * 17) % 256, (y * 29) % 256, (x * y) % 256, 255])
    const out = resampleLanczos3(src, 16, 12)
    expect([...out.data]).toEqual([...src.data])
  })

  it('leaves a flat field flat, edges included — normalisation, not luck', () => {
    const src = buffer(12, 9, () => [70, 140, 210, 255])
    const out = resampleLanczos3(src, 37, 28)
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) expect(at(out, x, y)).toEqual([70, 140, 210, 255])
    }
  })

  it('rings at a hard edge but never beyond the clamp', () => {
    // a step edge is the worst case for a windowed sinc; the overshoot must
    // saturate, because a wrap would turn the bright side of a coastline black
    const src = buffer(32, 4, (x) => {
      const v = x < 16 ? 0 : 255
      return [v, v, v, 255]
    })
    const out = resampleLanczos3(src, 128, 16)
    let min = 255
    let max = 0
    for (let i = 0; i < out.data.length; i += 4) {
      min = Math.min(min, out.data[i])
      max = Math.max(max, out.data[i])
    }
    expect(min).toBe(0)
    expect(max).toBe(255)
    for (let i = 0; i < out.data.length; i++) {
      expect(out.data[i]).toBeGreaterThanOrEqual(0)
      expect(out.data[i]).toBeLessThanOrEqual(255)
    }
  })

  it('keeps a monotone ramp monotone — no sample lands out of order', () => {
    const src = buffer(16, 1, (x) => {
      const v = Math.round((x / 15) * 255)
      return [v, v, v, 255]
    })
    const out = resampleLanczos3(src, 64, 1)
    for (let x = 1; x < 64; x++) expect(at(out, x, 0)[0]).toBeGreaterThanOrEqual(at(out, x - 1, 0)[0])
  })

  it('holds an edge sharper than the bilinear it replaces', () => {
    // the whole reason this file exists: magnify a step 8x and count how many
    // destination pixels the transition takes. Bilinear — the tent filter both
    // drawImage and the GPU's LinearFilter use — spreads it across the full
    // source pixel it interpolates over.
    const src = buffer(8, 1, (x) => {
      const v = x < 4 ? 20 : 235
      return [v, v, v, 255]
    })
    const width = (read: (x: number) => number) =>
      [...Array(64).keys()].filter((x) => read(x) > 60 && read(x) < 195).length

    const out = resampleLanczos3(src, 64, 1)
    const bilinear = (x: number) => {
      const c = ((x + 0.5) * 8) / 64 - 0.5
      const i = Math.floor(c)
      const f = c - i
      const s = (j: number) => (Math.min(Math.max(j, 0), 7) < 4 ? 20 : 235)
      return s(i) * (1 - f) + s(i + 1) * f
    }
    expect(width((x) => at(out, x, 0)[0])).toBeLessThan(width(bilinear))
  })

  it('survives a 1-pixel source without dividing by zero', () => {
    const out = resampleLanczos3(buffer(1, 1, () => [10, 20, 30, 255]), 5, 5)
    expect(at(out, 2, 2)).toEqual([10, 20, 30, 255])
  })
})

describe('the compiled kernel', () => {
  it('instantiates here', () => {
    // if this ever fails the app still works, just slowly — but the failure
    // should be seen in CI rather than discovered from a frame-rate complaint
    expect(lanczosKernel()).not.toBeNull()
  })

  it('agrees with the TypeScript reference to the byte', () => {
    for (const [sw, sh, dw, dh] of [
      [64, 48, 151, 97],
      [40, 40, 17, 23], // downscale, where the widened filter is exercised
      [31, 17, 31, 17], // identity
    ] as const) {
      const src = buffer(sw, sh, (x, y) => [(x * 13) % 256, (y * 7) % 256, ((x + y) * 31) % 256, 255])
      const ts = resampleLanczos3(src, dw, dh)
      const wasm = resampleLanczos3Wasm(src, dw, dh)!
      expect(wasm.width).toBe(ts.width)
      expect(wasm.height).toBe(ts.height)
      // not bit-identical by construction: the compiled kernel accumulates in
      // float32 and rounds halves up, the reference accumulates in float64 and
      // rounds through Uint8ClampedArray's ties-to-even. One quantisation step
      // is the whole of the disagreement, and it is invisible.
      for (let i = 0; i < ts.data.length; i++) {
        expect(Math.abs(wasm.data[i] - ts.data[i])).toBeLessThanOrEqual(1)
      }
    }
  })

  it('resampleRGBA returns the same result whichever path it takes', () => {
    const src = buffer(23, 19, (x, y) => [(x * 11) % 256, (y * 5) % 256, 0, 255])
    const a = resampleRGBA(src, 47, 39)
    const b = resampleLanczos3(src, 47, 39)
    expect([a.width, a.height]).toEqual([b.width, b.height])
    for (let i = 0; i < b.data.length; i++) expect(Math.abs(a.data[i] - b.data[i])).toBeLessThanOrEqual(1)
  })
})
