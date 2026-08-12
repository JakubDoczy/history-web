import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { isReactive, toRaw } from 'vue'
import { useNationStore } from '../src/stores/nations'
import { useSettingsStore } from '../src/stores/settings'
import { useTimeStore } from '../src/stores/time'
import { MODERN_FROM } from '../src/lib/modernBorders'

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

  /**
   * The modern states, which are ink and not polities: they never appear in
   * `current` or `borders`, so nothing about the polygon layer, the ranking or
   * `MAX_VISIBLE` can notice them.
   */
  describe('the modern states', () => {
    const modernYear = () => {
      const time = useTimeStore()
      time.range = { start: 1900, end: 2024 }
      time.currentTime = 2000
    }

    it('appears only inside its window, and never as a polity', () => {
      const nations = useNationStore()
      const time = useTimeStore()
      expect(nations.modernBorders).toEqual([]) // 1200
      modernYear()
      expect(nations.modernBorders).toHaveLength(1)
      expect(nations.current.map((n) => n.id)).toEqual(['usa', 'prc', 'india'])
      expect(nations.borders.some((b) => b.nation.id.startsWith('modern'))).toBe(false)
      time.currentTime = MODERN_FROM - 1
      expect(nations.modernBorders).toEqual([])
    })

    it('goes away with the setting, and with a geological zoom', () => {
      const nations = useNationStore()
      const settings = useSettingsStore()
      modernYear()
      expect(settings.modernBorders).toBe(true)
      settings.toggle('modernBorders')
      expect(nations.modernBorders).toEqual([])
      settings.toggle('modernBorders')
      expect(nations.modernBorders).toHaveLength(1)
      useTimeStore().range = { start: -1e6, end: 2000 }
      expect(nations.modernBorders).toEqual([])
    })
  })
})
