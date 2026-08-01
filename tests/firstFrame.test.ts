import { describe, it, expect, vi } from 'vitest'
import { FirstFrameGate, FIRST_FRAME_DEADLINE_MS } from '../src/lib/firstFrame'

/** A gate whose deadline only fires when the test says so. */
const gateWithTimer = (deadlineMs = 1000) => {
  const timers: { fn: () => void; ms: number }[] = []
  const gate = new FirstFrameGate({ deadlineMs, timer: (fn, ms) => timers.push({ fn, ms }) })
  return { gate, timers, fire: () => timers.forEach((t) => t.fn()) }
}

describe('FirstFrameGate', () => {
  it('holds work until the globe draws', () => {
    const { gate } = gateWithTimer()
    const cb = vi.fn()
    gate.whenDrawn(cb)
    expect(cb).not.toHaveBeenCalled()
    expect(gate.drawn).toBe(false)
    gate.release()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(gate.drawn).toBe(true)
  })

  it('runs everything queued, in order', () => {
    const { gate } = gateWithTimer()
    const order: number[] = []
    gate.whenDrawn(() => order.push(1))
    gate.whenDrawn(() => order.push(2))
    gate.whenDrawn(() => order.push(3))
    gate.release()
    expect(order).toEqual([1, 2, 3])
  })

  // The whole point of a latch rather than an event: a late subscriber has not
  // missed anything.
  it('runs work registered after the release, immediately', () => {
    const { gate } = gateWithTimer()
    gate.release()
    const cb = vi.fn()
    gate.whenDrawn(cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('releases once, however many frames are drawn', () => {
    const { gate } = gateWithTimer()
    const cb = vi.fn()
    gate.whenDrawn(cb)
    gate.release()
    gate.release()
    gate.release()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('opens on the deadline when no globe ever draws', () => {
    const { gate, fire } = gateWithTimer()
    const cb = vi.fn()
    gate.whenDrawn(cb)
    fire()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(gate.drawn).toBe(true)
  })

  it('a deadline that fires after a real release changes nothing', () => {
    const { gate, fire } = gateWithTimer()
    const cb = vi.fn()
    gate.whenDrawn(cb)
    gate.release()
    fire()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('arms the deadline once, on the first waiter, and not before', () => {
    const { gate, timers } = gateWithTimer(1234)
    expect(timers).toHaveLength(0)
    gate.whenDrawn(() => {})
    gate.whenDrawn(() => {})
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(1234)
  })

  it('arms no deadline once already released', () => {
    const { gate, timers } = gateWithTimer()
    gate.release()
    gate.whenDrawn(() => {})
    expect(timers).toHaveLength(0)
  })

  it('deadlineMs 0 means no rescue timer at all', () => {
    const timers: (() => void)[] = []
    const gate = new FirstFrameGate({ deadlineMs: 0, timer: (fn) => timers.push(fn) })
    const cb = vi.fn()
    gate.whenDrawn(cb)
    expect(timers).toHaveLength(0)
    expect(cb).not.toHaveBeenCalled()
  })

  it('ships a deadline long enough for a slow first paint but short of a stall', () => {
    expect(FIRST_FRAME_DEADLINE_MS).toBeGreaterThanOrEqual(3000)
    expect(FIRST_FRAME_DEADLINE_MS).toBeLessThanOrEqual(15000)
  })

  it('defaults to a real timer without one being supplied', async () => {
    const gate = new FirstFrameGate({ deadlineMs: 1 })
    const cb = vi.fn()
    gate.whenDrawn(cb)
    await new Promise((r) => setTimeout(r, 20))
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
