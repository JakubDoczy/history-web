import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSettingsStore, MAX_EVENTS } from '../src/stores/settings'

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

  it('toggles each independently', () => {
    const s = useSettingsStore()
    s.toggle('clouds')
    expect(s.clouds).toBe(false)
    expect(s.atmosphere).toBe(true)
    s.toggle('clouds')
    expect(s.clouds).toBe(true)
  })
})
