import { describe, it, expect } from 'vitest'
import { RenderPump, RENDER_CUSHION_MS, RENDER_SAFETY_MS } from '../src/lib/renderPump'

/**
 * The rule these all come back to: the renderer may only be parked when nothing
 * can change the picture, and anything that can must be able to start it again
 * in one call. A pump that parks too eagerly shows a stale globe; one that never
 * parks is what this replaced.
 */
const build = (o: { cushionMs?: number; safetyMs?: number } = {}) => {
  let t = 1000
  const log: string[] = []
  const pump = new RenderPump({ safetyMs: 0, ...o, now: () => t })
  pump.onResume = () => log.push('resume')
  pump.onPause = () => log.push('pause')
  return {
    pump,
    log,
    advance: (ms: number) => (t += ms),
    /** One animation frame every 16 ms, as a 60 Hz display would. */
    frames: (n: number, stepMs = 16) => {
      for (let i = 0; i < n; i++) {
        t += stepMs
        pump.tick()
      }
    },
    at: () => t,
  }
}

describe('RenderPump', () => {
  it('starts running, so the first paint is never waiting on an event', () => {
    const { pump } = build()
    expect(pump.running).toBe(true)
  })

  it('parks once the opening cushion has run out', () => {
    const { pump, log, frames } = build({ cushionMs: 200 })
    frames(5) // 80 ms in
    expect(pump.running).toBe(true)
    frames(10) // past 200 ms
    expect(pump.running).toBe(false)
    expect(log).toEqual(['pause'])
  })

  it('resumes on a wake, exactly once however many sources fire', () => {
    const { pump, log, frames } = build({ cushionMs: 200 })
    frames(20)
    expect(pump.running).toBe(false)
    pump.wake()
    pump.wake()
    pump.wake(50)
    expect(pump.running).toBe(true)
    expect(log).toEqual(['pause', 'resume'])
  })

  it('keeps drawing for the whole cushion after the last wake', () => {
    const { pump, frames, advance } = build({ cushionMs: 1000 })
    frames(20)
    advance(5000)
    pump.tick()
    expect(pump.running).toBe(false)
    pump.wake()
    // a drag: a wake per frame for a while, then nothing
    for (let i = 0; i < 30; i++) {
      pump.wake()
      frames(1)
    }
    expect(pump.running).toBe(true)
    frames(40) // 640 ms of silence: still inside the cushion
    expect(pump.running).toBe(true)
    frames(30) // past it
    expect(pump.running).toBe(false)
  })

  it('never lets a later wake shorten an earlier cushion', () => {
    // several dirty sources firing in the same frame is the normal case, and a
    // short one arriving after a long one must not cut it off
    const { pump, frames } = build({ cushionMs: 1000 })
    pump.wake(1000)
    pump.wake(0)
    frames(30) // 480 ms
    expect(pump.running).toBe(true)
    frames(40)
    expect(pump.running).toBe(false)
  })

  it('draws exactly one frame for wake(0), and parks again', () => {
    // what the cloud drift and the safety tick ask for: a single frame, not a
    // second and a half of rendering
    const { pump, log, frames } = build({ cushionMs: 1000 })
    frames(80)
    log.length = 0
    pump.wake(0)
    expect(pump.running).toBe(true)
    frames(1)
    expect(pump.running).toBe(false)
    expect(log).toEqual(['resume', 'pause'])
  })

  it('honours wake(0) even when it arrives inside the same frame as the tick', () => {
    // the deadline is already in the past by the time the tick runs, so without
    // the one-frame floor the wake would produce no frame at all
    const { pump, frames } = build({ cushionMs: 1000, safetyMs: 0 })
    frames(80)
    let drawn = 0
    pump.onResume = () => drawn++
    pump.wake(0)
    expect(drawn).toBe(1)
  })

  it('draws a safety frame at the safety interval, and only one', () => {
    const { pump, log, frames } = build({ cushionMs: 100, safetyMs: 1000 })
    frames(20) // cushion over
    log.length = 0
    frames(40) // 640 ms: no safety tick yet
    expect(log).toEqual([])
    frames(30) // past 1000 ms
    expect(log).toEqual(['resume', 'pause'])
  })

  it('costs about one frame a second when nothing at all is happening', () => {
    const { log, frames } = build({ cushionMs: 100, safetyMs: 1000 })
    frames(20)
    log.length = 0
    frames(60 * 10) // ten seconds at 60 Hz
    const woke = log.filter((l) => l === 'resume').length
    // 600 animation frames; ten of them are drawn
    expect(woke).toBeGreaterThanOrEqual(9)
    expect(woke).toBeLessThanOrEqual(11)
  })

  it('draws every frame while something keeps waking it every frame', () => {
    // autorotation and the cloud drift both look like this: the pump parks
    // between them and is resumed again immediately, which is one render per
    // frame — the same picture the old unconditional loop drew, at the same rate
    const { pump, log, frames } = build({ cushionMs: 1000 })
    frames(80) // park first
    log.length = 0
    for (let i = 0; i < 100; i++) {
      pump.wake(0)
      frames(1)
    }
    expect(log.filter((l) => l === 'resume')).toHaveLength(100)
  })

  it('draws a quarter of the frames when the drift is stepped at 20 Hz', () => {
    // what the cloud deck actually asks for. It moves 0.04 px per frame, so
    // stepping it less often is not something an eye can resolve; on a 60 Hz
    // grid a 50 ms step lands on every fourth frame, i.e. 15 draws a second
    const { pump, log, frames } = build({ cushionMs: 1000, safetyMs: 0 })
    frames(80)
    log.length = 0
    let last = -Infinity
    for (let i = 0; i < 180; i++) {
      const t = i * 16
      if (t - last >= 50) {
        last = t
        pump.wake(0)
      }
      frames(1)
    }
    const woke = log.filter((l) => l === 'resume').length
    expect(woke).toBeGreaterThan(35)
    expect(woke).toBeLessThan(70) // 180 frames, 45 of them drawn
  })

  it('measures the cushion in time, not in frames', () => {
    // the whole reason the cushion is a deadline: on a device managing 5 fps, a
    // 90-frame cushion would be eighteen seconds of rendering for one wheel notch
    const { pump, frames } = build({ cushionMs: 1000 })
    frames(80)
    pump.wake()
    frames(10, 200) // ten frames, but two seconds of them
    expect(pump.running).toBe(false)
  })

  it('ships with a cushion that outlasts the transitions it has to cover', () => {
    // polygons 300 ms, arcs 180 ms, OrbitControls damping ~500 ms
    expect(RENDER_CUSHION_MS).toBeGreaterThanOrEqual(1000)
    expect(RENDER_SAFETY_MS).toBeLessThanOrEqual(1000) // staleness bound
  })
})
