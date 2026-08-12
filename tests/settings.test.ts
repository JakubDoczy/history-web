import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSettingsStore, MAX_EVENTS } from '../src/stores/settings'
import { DEFAULT_MODE } from '../src/lib/present/mode'

describe('settings store', () => {
  beforeEach(() => setActivePinia(createPinia()))
  it('shows clouds and atmosphere by default', () => {
    const s = useSettingsStore()
    expect(s.clouds).toBe(true)
    expect(s.atmosphere).toBe(true)
  })
  it('caps the globe at a readable number of events by default', () => {
    expect(useSettingsStore().maxEvents).toBe(30)
  })

  it('keeps the default inside the slider range, on a step', () => {
    expect(MAX_EVENTS.default).toBeGreaterThanOrEqual(MAX_EVENTS.min)
    expect(MAX_EVENTS.default).toBeLessThanOrEqual(MAX_EVENTS.max)
    expect(MAX_EVENTS.default % MAX_EVENTS.step).toBe(0)
    expect(MAX_EVENTS.min % MAX_EVENTS.step).toBe(0)
    expect(MAX_EVENTS.max % MAX_EVENTS.step).toBe(0)
  })

  it('draws the modern states by default, because nothing else draws 2000', () => {
    expect(useSettingsStore().modernBorders).toBe(true)
  })

  it('toggles each independently', () => {
    const s = useSettingsStore()
    s.toggle('clouds')
    expect(s.clouds).toBe(false)
    expect(s.atmosphere).toBe(true)
    s.toggle('clouds')
    expect(s.clouds).toBe(true)
  })

  /**
   * Map mode selects a whole `GlobeStyle` rather than switching the knobs off
   * (see lib/present/globe.ts). Leaving them alone is the point: switching back
   * restores exactly what the reader had, without the app having to remember a
   * second copy of their settings.
   */
  it('starts on the photographed globe, and leaves the knobs alone when it changes', () => {
    const s = useSettingsStore()
    expect(s.mode).toBe(DEFAULT_MODE)
    expect(s.mode).toBe('realistic')
    s.setMode('schematic')
    expect(s.mode).toBe('schematic')
    expect([s.clouds, s.atmosphere, s.relief, s.detail]).toEqual([true, true, true, true])
    s.setMode('realistic')
    expect(s.mode).toBe('realistic')
  })
})
