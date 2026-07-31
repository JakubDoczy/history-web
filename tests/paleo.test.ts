import { describe, it, expect } from 'vitest'
import {
  textureBlend,
  modernShare,
  imageryCredit,
  PALEO_CREDIT,
  type TextureKeyframe,
} from '../src/lib/paleo'

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
  it('survives two frames pinned to the same year', () => {
    // the frame list is a concatenation, so a collision is one data edit away;
    // the resulting NaN blend factor renders the whole globe black
    const collided: TextureKeyframe[] = [
      { time: -250e6, url: 'pangaea' },
      { time: -10_000, url: 'late' },
      { time: -10_000, url: 'modern' },
    ]
    for (const t of [-20_000, -10_000, 0]) {
      expect(Number.isFinite(textureBlend(collided, t).f)).toBe(true)
    }
  })
})

describe('modernShare', () => {
  it('is 1 once the modern map is all that is drawn', () => {
    expect(modernShare(frames, -10_000)).toBe(1)
    expect(modernShare(frames, 2026)).toBe(1)
  })
  it('is 0 while only paleo frames are drawn', () => {
    expect(modernShare(frames, -250e6)).toBe(0)
    expect(modernShare(frames, -200e6)).toBe(0)
    expect(modernShare(frames, -4e9)).toBe(0)
  })
  it('tracks the crossfade into the modern map', () => {
    // halfway between the last paleo frame and the modern one
    expect(modernShare(frames, -75.005e6)).toBeCloseTo(0.5, 3)
  })
})

describe('imageryCredit', () => {
  it('credits the reconstruction while any deep-time frame is on screen', () => {
    expect(imageryCredit(frames, -250e6, '')).toBe(PALEO_CREDIT)
    // mid-crossfade the paleo frame is still visible, so it is still credited
    expect(imageryCredit(frames, -75e6, '')).toBe(PALEO_CREDIT)
  })
  it('credits the modern basemap once the paleo frames are gone', () => {
    expect(imageryCredit(frames, 1500, '')).toMatch(/NASA/)
  })
  it('always defers to the streamed layer, which requires its own credit', () => {
    expect(imageryCredit(frames, -250e6, 'Sentinel-2')).toBe('Sentinel-2')
    expect(imageryCredit(frames, 1500, 'Sentinel-2')).toBe('Sentinel-2')
  })
})

import { PALEO_FRAMES } from '../src/data/paleoTextures'
import frameList from '../src/data/paleoFrames.json'

describe('PALEO_FRAMES', () => {
  it('is strictly ordered, so the surrounding-frame search cannot run off the end', () => {
    for (let i = 1; i < PALEO_FRAMES.length; i++) {
      expect(PALEO_FRAMES[i].time).toBeGreaterThan(PALEO_FRAMES[i - 1].time)
    }
  })
  it('ends on the modern map, so the last 10k years never morph', () => {
    const last = PALEO_FRAMES[PALEO_FRAMES.length - 1]
    expect(last.time).toBe(-10_000)
    expect(textureBlend(PALEO_FRAMES, 1500)).toEqual({ from: last.url, to: last.url, f: 0 })
  })
  it('turns the modern relief map off wherever a paleo frame is drawn', () => {
    expect(modernShare(PALEO_FRAMES, -250e6)).toBe(0)
    expect(modernShare(PALEO_FRAMES, 1500)).toBe(1)
  })
})

describe('paleoFrames.json', () => {
  // Each frame is one PaleoDEM reconstruction, so its time has to be that
  // reconstruction's age. Any other time would be geography nobody computed.
  it('places every frame at its own reconstruction age', () => {
    for (const f of frameList) {
      if (f.ma === 0) continue // the present, held back off the modern map's slot
      expect(f.time).toBe(Math.round(-f.ma * 1e6))
    }
  })
  it('runs oldest to youngest with no repeats', () => {
    for (let i = 1; i < frameList.length; i++) {
      expect(frameList[i].ma).toBeLessThan(frameList[i - 1].ma)
    }
  })
  it('reaches the start of the Cambrian and ends at the present', () => {
    expect(frameList[0].ma).toBeGreaterThanOrEqual(538.8)
    expect(frameList[frameList.length - 1].ma).toBe(0)
  })
})
