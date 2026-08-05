import { describe, it, expect } from 'vitest'
import {
  eraPlan,
  ERA_WINDOW,
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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODERN_TEXTURE, PALEO_FRAMES } from '../src/data/paleoTextures'
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

/**
 * The residency window.
 *
 * Every deep-time frame is 32 MB on the GPU with its mip chain, and the layer
 * used to hold every one it had ever shown — 336 MB measured after a scrub
 * through the Phanerozoic, with exactly one texture ever freed. `eraPlan` is
 * what makes that bounded: what to keep, and what to warm next.
 */
describe('eraPlan', () => {
  // ten frames, evenly spaced, so window arithmetic is readable
  const many: TextureKeyframe[] = Array.from({ length: 10 }, (_, i) => ({
    time: -500e6 + i * 50e6,
    url: `f${i}`,
  }))
  /** The time exactly between frames i and i+1. */
  const between = (i: number) => (many[i].time + many[i + 1].time) / 2

  it('carries the same crossfade textureBlend does', () => {
    for (const t of [-4e9, -500e6, between(3), -75e6, 2026]) {
      const { from, to, f } = eraPlan(many, t)
      expect({ from, to, f }).toEqual(textureBlend(many, t))
    }
  })

  it('keeps the blend pair and two keyframes either side', () => {
    expect(eraPlan(many, between(4)).keep).toEqual(['f2', 'f3', 'f4', 'f5', 'f6', 'f7'])
  })

  it('never keeps more than the window, however far it has scrubbed', () => {
    // the point of the whole exercise: residency is O(1) in timeline length
    for (let i = 0; i < 9; i++) {
      expect(eraPlan(many, between(i)).keep.length).toBeLessThanOrEqual(2 * ERA_WINDOW + 2)
    }
  })

  it('clamps the window at either end instead of running off it', () => {
    expect(eraPlan(many, -4e9).keep).toEqual(['f0', 'f1', 'f2'])
    expect(eraPlan(many, 2026).keep).toEqual(['f7', 'f8', 'f9'])
  })

  it('always keeps what it is about to draw', () => {
    for (let i = 0; i < 9; i++) {
      const plan = eraPlan(many, between(i))
      expect(plan.keep).toContain(plan.from)
      expect(plan.keep).toContain(plan.to)
    }
  })

  it('warms the next frame ahead of a forward scrub', () => {
    // moving toward the present: the frame after the pair is the one about to
    // be needed, and a decode started now is a decode finished by then
    expect(eraPlan(many, between(4), between(5)).prefetch).toBe('f3') // going back
    expect(eraPlan(many, between(4), between(3)).prefetch).toBe('f6') // going forward
  })

  it('guesses forward when there is no previous time', () => {
    expect(eraPlan(many, between(4)).prefetch).toBe('f6')
    expect(eraPlan(many, between(4), between(4)).prefetch).toBe('f6')
  })

  it('has nothing to warm past either end of the timeline', () => {
    expect(eraPlan(many, -4e9, 2026).prefetch).toBeNull() // clamped at f0, going back
    expect(eraPlan(many, 2026, -4e9).prefetch).toBeNull() // clamped at f9, going forward
  })

  it('never prefetches outside what it promises to keep', () => {
    // a prefetch the eviction pass would drop on the same tick is a download
    // spent to be thrown away
    for (const prev of [-4e9, 2026]) {
      for (let i = 0; i < 9; i++) {
        const plan = eraPlan(many, between(i), prev)
        if (plan.prefetch) expect(plan.keep).toContain(plan.prefetch)
      }
    }
  })

  it('holds a single frame with no window at all', () => {
    const one: TextureKeyframe[] = [{ time: -1e6, url: 'only' }]
    const plan = eraPlan(one, 0)
    expect(plan.keep).toEqual(['only'])
    expect(plan.prefetch).toBeNull()
  })

  it('deduplicates the real frame list, where the last frame is the day map', () => {
    // PALEO_FRAMES pins the modern basemap as its last keyframe, and the clamped
    // end returns it as both `from` and `to`
    const plan = eraPlan(frames, 2026)
    expect(new Set(plan.keep).size).toBe(plan.keep.length)
  })
})

/* -------------------------------------------------- the hand-written preload ---
   index.html asks for the day basemap before the module graph exists (see the
   comment there). Two ways to get that URL wrong, and both cost the whole
   saving — a preload that misses spends the bandwidth twice:

     · naming a different file from MODERN_TEXTURE;
     · writing the base into it. Vite's HTML transform rewrites a <link href>
       itself, so `%BASE_URL%textures/…` became `/history-web/history-web/…` in
       dev — a 404 in front of the first frame. */
describe('the basemap preload in index.html', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8')
  const preload = /<link\b[^>]*rel="preload"[^>]*>/s.exec(html)?.[0] ?? ''
  const href = /href="([^"]+)"/.exec(preload)?.[1] ?? ''

  it('names the file the globe actually loads', () => {
    expect(preload).toContain('as="image"')
    expect(preload).toContain('crossorigin') // or the CORS-keyed cache misses
    expect(MODERN_TEXTURE.endsWith(href)).toBe(true)
  })

  it('leaves the base to the transform, exactly once', () => {
    expect(href.startsWith('/')).toBe(true) // root-relative: the transform's cue
    expect(href).not.toContain('%BASE_URL%')
    // nor in any other URL the transform will pass over, for the same reason
    for (const [, url] of html.matchAll(/(?:href|src)="([^"]*)"/g))
      expect(url, url).not.toContain('%BASE_URL%')
  })
})
