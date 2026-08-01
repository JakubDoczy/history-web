import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { isReactive, toRaw } from 'vue'
import { useNationStore } from '../src/stores/nations'
import { useTimeStore } from '../src/stores/time'

/**
 * What the globe's polygon layer actually receives.
 *
 * Both of these are performance contracts rather than behaviour, and both are
 * invisible until profiled: a proxied dataset triples the cost of every
 * coordinate read on the way to the GPU, and a fresh entry object per tick
 * makes three-globe rebuild meshes and re-tessellate caps for borders that have
 * not moved.
 */
describe('nation store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const time = useTimeStore()
    time.range = { start: 500, end: 1945 }
    time.currentTime = 1200
  })

  it('keeps the dataset out of Vue reactivity', () => {
    const nations = useNationStore()
    expect(isReactive(nations.all)).toBe(false)
    expect(toRaw(nations.all)).toBe(nations.all)
    expect(isReactive(nations.all[0].keyframes[0])).toBe(false)
    expect(nations.all.length).toBeGreaterThan(10) // and it is still the data
  })

  it('hands back the same border objects when the cursor moves within a keyframe', () => {
    const nations = useNationStore()
    const time = useTimeStore()
    const before = nations.borders
    expect(before.length).toBeGreaterThan(0)
    time.currentTime = 1201
    const after = nations.borders
    expect(after.length).toBe(before.length)
    for (let i = 0; i < after.length; i++) {
      expect(after[i]).toBe(before[i])
      expect(after[i].coordinates).toBe(before[i].coordinates)
    }
  })

  it('draws nothing while the timeline is zoomed out past human history', () => {
    const nations = useNationStore()
    const time = useTimeStore()
    time.range = { start: -1e6, end: 2000 }
    expect(nations.borders).toEqual([])
  })
})
