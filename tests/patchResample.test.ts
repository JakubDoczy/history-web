
import { describe, it, expect } from 'vitest'
import { upscaleFits, type Upscale } from '../src/lib/patchResample'

describe('upscaleFits', () => {
  const base: Upscale = { crop: { x: 100, y: 80, w: 400, h: 300 }, w: 800, h: 600 }
  const drift = (patch: Partial<Upscale> & { crop?: Partial<Upscale['crop']> }): Upscale => ({
    ...base,
    ...patch,
    crop: { ...base.crop, ...(patch.crop ?? {}) },
  })

  it('accepts the copy made for exactly this geometry', () => {
    expect(upscaleFits(base, drift({}))).toBe(true)
    // sub-pixel jitter is the same crop: it is taken at whole pixels
    expect(upscaleFits(base, drift({ crop: { x: 100.3 }, w: 800.2 }))).toBe(true)
  })

  it('refuses a copy of a different source rectangle', () => {
    for (const c of [{ x: 104 }, { y: 84 }, { w: 416 }, { h: 312 }]) {
      expect(upscaleFits(base, drift({ crop: c }))).toBe(false)
    }
  })

  it('refuses a copy made at a different size', () => {
    expect(upscaleFits(base, drift({ w: 830 }))).toBe(false)
    expect(upscaleFits(base, drift({ h: 620 }))).toBe(false)
  })

  it('refuses a stretch of the crop height, which the old 5% rule ignored', () => {
    // A copy of a short strip drawn down a tall destination is the "stretched
    // and deformed" ghost: the same ground, at the wrong scale, over imagery
    // that is in the right place.
    expect(upscaleFits(base, drift({ crop: { h: 150 } }))).toBe(false)
    expect(upscaleFits(base, drift({ crop: { h: 600 } }))).toBe(false)
  })

  it('refuses every drift the old 5% tolerance used to wave through', () => {
    // 4% on each number: inside the old rule, and 4% of misregistration on
    // screen for as long as the copy is reused
    const nearly = drift({ w: 832, h: 624, crop: { x: 104, y: 83, w: 416 } })
    expect(upscaleFits(base, nearly)).toBe(false)
  })

  it('has nothing to reuse when no copy is held', () => {
    expect(upscaleFits(undefined, base)).toBe(false)
  })
})
