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

    it('rides out a zoom the fan can follow, since the fan is sized on screen', () => {
      const events = useEventStore()
      events.expandCluster('rome', 40)
      events.noteSpan(20) // zoomed in 2x: the ring simply redraws smaller
      expect(events.expandedClusterId).toBe('rome')
      events.noteSpan(8) // 5x: the clustering itself has moved on
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

describe('event data loading, when the network misbehaves', () => {
  const withFetch = async (impl: (url: string) => Promise<Response>) => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => impl(String(url))) as typeof fetch
    setActivePinia(createPinia())
    const store = useEventStore()
    try {
      await store.init()
      return store
    } finally {
      globalThis.fetch = original
    }
  }
  const json = (body: unknown) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  const notFound = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.reject() } as unknown as Response)

  it('survives a manifest that never arrives', async () => {
    // one unguarded await used to reject out of onMounted, leaving an app with
    // no events at all and nothing that would ever ask again
    const store = await withFetch(() => Promise.reject(new Error('offline')))
    expect(store.manifest).toBeNull()
    expect(store.all).toEqual([])
  })

  it('retries the manifest before giving up', async () => {
    let calls = 0
    const store = await withFetch((url) => {
      if (url.endsWith('manifest.json')) {
        calls++
        return calls < 3 ? notFound() : json({ spine: 'spine.json', chunks: [] })
      }
      return json([{ id: 'a', name: 'A', start: 0, end: 0, lat: 0, lng: 0, tags: [], priority: 1 }])
    })
    expect(calls).toBe(3)
    expect(store.all).toHaveLength(1)
  })

  it('treats an HTTP error as a failure rather than as data', async () => {
    // fetch resolves for 404 and 500 alike, so a server that answers "not
    // found" in JSON would have had its error object merged into the index
    const store = await withFetch((url) =>
      url.endsWith('manifest.json')
        ? json({ spine: 'spine.json', chunks: [] })
        : Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'nope' }) } as Response),
    )
    expect(store.all).toEqual([])
    expect(store.requested.has('spine.json')).toBe(false) // and it will be asked for again
  })

  it('refuses a chunk that is not an array of events', async () => {
    const store = await withFetch((url) =>
      url.endsWith('manifest.json') ? json({ spine: 'spine.json', chunks: [] }) : json({ error: 'nope' }),
    )
    expect(store.all).toEqual([])
  })
})

import type { Item, Person } from '../src/lib/events'

const einstein: Person = {
  id: 'einstein', kind: 'person', name: 'Albert Einstein', born: 1879, died: 1955,
  birthPlace: { lat: 48.4, lng: 9.99, label: 'Ulm' },
  deathPlace: { lat: 40.36, lng: -74.67, label: 'Princeton' },
  priority: 88, tags: ['science'], summary: 'physicist',
  body: 'wrote [relativity](item:relativity)',
}

describe('the store as an item store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useTimeStore().currentTime = 1900
  })

  const seed = (): Item[] => [
    einstein,
    { id: 'relativity', name: 'Relativity', start: 1905, lat: 0, lng: 0, priority: 88, tags: ['science'], summary: '', body: 'by [Einstein](item:einstein)' },
    { id: 'idea', kind: 'concept', name: 'Relativity, the idea', anchorYear: 1905, priority: 70, tags: ['science'], summary: '' },
  ]

  it('opens the life behind a derived birth pin, while the pin keeps the highlight', () => {
    const events = useEventStore()
    events.adopt(seed())
    events.select('einstein--birth')
    expect(events.selectedId).toBe('einstein--birth') // the globe still knows which pin
    expect(events.selected?.id).toBe('einstein') // the panel shows the life
  })

  it('keeps derived pins off the globe until the setting asks for them', () => {
    const events = useEventStore()
    const settings = useSettingsStore()
    const time = useTimeStore()
    time.selection = { start: 1870, end: 1890 }
    events.adopt(seed())
    expect(events.visible.map((e) => e.id)).toEqual([])
    settings.showMinorEvents = true
    expect(events.visible.map((e) => e.id)).toEqual(['einstein--birth'])
  })

  it('answers where to put the timeline for any kind of item', () => {
    const events = useEventStore()
    events.adopt(seed())
    expect(events.focusYear('relativity')).toBe(1905) // an event starts
    expect(events.focusYear('einstein')).toBe(1879) // a life is born
    expect(events.focusYear('idea')).toBe(1905) // an idea is anchored
    expect(events.focusYear('einstein--death')).toBe(1955) // a derived pin is its own year
    expect(events.focusYear('nope')).toBeUndefined()
  })

  it('collects an article neighbourhood from links in both directions', () => {
    const events = useEventStore()
    events.adopt(seed())
    expect(events.linkedTo('einstein').map((i) => i.id)).toEqual(['relativity'])
    expect(events.linkedTo('relativity').map((i) => i.id)).toEqual(['einstein'])
  })

  it('searches every kind, and finds a person by name', () => {
    const events = useEventStore()
    events.adopt(seed())
    expect(events.search('einstein').map((i) => i.id)).toEqual(['einstein'])
    expect(events.search('relativity').map((i) => i.id)).toEqual(['relativity', 'idea'])
  })

  it('records a fly-to request per ask, so the same place can be asked for twice', () => {
    const events = useEventStore()
    events.lookAt(48.4, 9.99)
    expect(events.flyTo).toEqual({ lat: 48.4, lng: 9.99, seq: 1 })
    events.lookAt(48.4, 9.99)
    expect(events.flyTo?.seq).toBe(2)
  })
})
