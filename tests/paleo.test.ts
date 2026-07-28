import { describe, it, expect } from 'vitest'
import { textureBlend, type TextureKeyframe } from '../src/lib/paleo'

const frames: TextureKeyframe[] = [
  { time: -250e6, url: 'pangaea' },
  { time: -150e6, url: 'breakup' },
  { time: -10_000, url: 'modern' },
]

describe('textureBlend', () => {
  it('clamps to first frame in deep past', () => {
    expect(textureBlend(frames, -4e9)).toEqual({ from: 'pangaea', to: 'pangaea', f: 0 })
  })
  it('holds modern for the last 10k years (no morphing near present)', () => {
    expect(textureBlend(frames, -10_000)).toEqual({ from: 'modern', to: 'modern', f: 0 })
    expect(textureBlend(frames, 2026)).toEqual({ from: 'modern', to: 'modern', f: 0 })
  })
  it('is exactly the keyframe at its own time', () => {
    expect(textureBlend(frames, -150e6)).toEqual({ from: 'breakup', to: 'modern', f: 0 })
  })
  it('blends linearly between adjacent frames', () => {
    const b = textureBlend(frames, -200e6)
    expect(b.from).toBe('pangaea')
    expect(b.to).toBe('breakup')
    expect(b.f).toBeCloseTo(0.5)
  })
  it('f approaches 1 near the next keyframe', () => {
    expect(textureBlend(frames, -151e6).f).toBeCloseTo(0.99)
  })
})
