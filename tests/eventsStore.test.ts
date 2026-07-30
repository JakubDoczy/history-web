import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useEventStore } from '../src/stores/events'
import { useSettingsStore } from '../src/stores/settings'
import { useTimeStore } from '../src/stores/time'
import type { HistoricalEvent } from '../src/lib/events'

const ev = (id: string, priority: number): HistoricalEvent => ({
  id, name: id, start: 1500, lat: 0, lng: 0, priority, tags: ['war'], summary: '',
})

describe('event store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useTimeStore().currentTime = 1500
  })

  it('caps the visible set at the settings value, highest priority first', () => {
    const events = useEventStore()
    const settings = useSettingsStore()
    events.adopt(Array.from({ length: 60 }, (_, i) => ev(`e${i}`, i)))
    expect(events.visible).toHaveLength(30)
    expect(events.visible[0].id).toBe('e59')
    settings.maxEvents = 10
    expect(events.visible).toHaveLength(10)
  })

  describe('cluster expansion', () => {
    it('opens a cluster and remembers the span it was opened at', () => {
      const events = useEventStore()
      events.expandCluster('rome', 40)
      expect(events.expandedClusterId).toBe('rome')
      expect(events.expandedSpan).toBe(40)
    })

    it('survives a small zoom nudge but closes on a real zoom', () => {
      const events = useEventStore()
      events.expandCluster('rome', 40)
      events.noteSpan(43)
      expect(events.expandedClusterId).toBe('rome')
      events.noteSpan(90)
      expect(events.expandedClusterId).toBeUndefined()
    })

    it('does nothing on zoom when nothing is open', () => {
      const events = useEventStore()
      events.noteSpan(90)
      expect(events.expandedClusterId).toBeUndefined()
    })

    it('closes when a member is selected, and when the globe is clicked', () => {
      const events = useEventStore()
      events.expandCluster('rome', 40)
      events.select('forum')
      expect(events.selectedId).toBe('forum')
      expect(events.expandedClusterId).toBeUndefined()

      events.expandCluster('rome', 40)
      events.collapseClusters()
      expect(events.expandedClusterId).toBeUndefined()
    })
  })
})
