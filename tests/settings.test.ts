import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSettingsStore } from '../src/stores/settings'

describe('settings store', () => {
  beforeEach(() => setActivePinia(createPinia()))
  it('shows clouds and atmosphere by default', () => {
    const s = useSettingsStore()
    expect(s.clouds).toBe(true)
    expect(s.atmosphere).toBe(true)
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
