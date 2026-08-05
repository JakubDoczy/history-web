import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { FOCUS_CHILD_CAP, FOCUS_STACK_CAP, useEventStore } from '../src/stores/events'
import { useSettingsStore } from '../src/stores/settings'
import { useTimeStore } from '../src/stores/time'
import type { RawEvent } from '../src/lib/events'

const ev = (id: string, priority: number): RawEvent => ({
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

import { parseItem, type RawItem, type RawPerson } from '../src/lib/events'
import { focusTargetFor } from '../src/lib/geoFocus'

const einstein: RawPerson = {
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

  const seed = (): RawItem[] => [
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

  /* --- the typed relation getters, as the panel's four sections read them --- */
  describe('relation getters', () => {
    const graph = (): RawItem[] => [
      { id: 'war', name: 'War', start: 1939, lat: 0, lng: 0, priority: 96, tags: [], summary: '' },
      { id: 'operation', name: 'Operation', start: 1941, lat: 0, lng: 0, priority: 80, tags: [], summary: '', parent: 'war' },
      { id: 'later-battle', name: 'Later battle', start: 1943, lat: 0, lng: 0, priority: 60, tags: [], summary: '', parent: 'operation' },
      { id: 'first-battle', name: 'First battle', start: 1941, lat: 0, lng: 0, priority: 40, tags: [], summary: '', parent: 'operation', weak: ['aside'] },
      { id: 'treaty', name: 'Treaty', start: 1945, lat: 0, lng: 0, priority: 70, tags: [], summary: '', strong: ['war'] },
      { id: 'aside', name: 'Aside', start: 1950, lat: 0, lng: 0, priority: 10, tags: [], summary: '', body: 'see [the war](item:war)' },
    ]

    it('gives the chain an item is part of, innermost first', () => {
      const events = useEventStore()
      events.adopt(graph())
      expect(events.parentChainOf('later-battle').map((i) => i.id)).toEqual(['operation', 'war'])
      expect(events.parentChainOf('war')).toEqual([])
    })

    it('gives the direct children, in the order they happened', () => {
      const events = useEventStore()
      events.adopt(graph())
      expect(events.childrenOf('operation').map((i) => i.id)).toEqual(['first-battle', 'later-battle'])
      expect(events.childrenOf('war').map((i) => i.id)).toEqual(['operation'])
    })

    it('reads a strong edge from the side that did not declare it', () => {
      const events = useEventStore()
      events.adopt(graph())
      expect(events.strongOf('war').map((i) => i.id)).toEqual(['treaty'])
      expect(events.strongOf('treaty').map((i) => i.id)).toEqual(['war'])
    })

    it('reads weak edges both ways too', () => {
      const events = useEventStore()
      events.adopt(graph())
      expect(events.weakOf('aside').map((i) => i.id)).toEqual(['first-battle'])
    })

    /**
     * "See also" is the softest section, and the only one that is assembled
     * rather than declared: weak edges first, then whatever the prose links to
     * that no stronger relation already claimed.
     */
    it('folds body links into see-also, behind the weak edges', () => {
      const events = useEventStore()
      events.adopt(graph())
      // `aside` links to `war` in its body, and is weakly tied to `first-battle`
      expect(events.seeAlsoOf('aside').map((i) => i.id)).toEqual(['first-battle', 'war'])
    })

    it('never offers the same item under two headings', () => {
      const events = useEventStore()
      events.adopt(graph())
      // the war is `aside`'s body link, but it is `treaty`'s strong relation and
      // `operation`'s parent — so it appears in exactly one section of each
      expect(events.seeAlsoOf('treaty').map((i) => i.id)).toEqual([])
      expect(events.seeAlsoOf('operation').map((i) => i.id)).toEqual([])
      expect(events.strongOf('operation').map((i) => i.id)).toEqual([])
    })
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
    // a place chip leaves the zoom alone; a fitted view states one
    expect(events.flyTo?.altitude).toBeUndefined()
    events.lookAt(48.4, 9.99, 0.8)
    expect(events.flyTo?.altitude).toBe(0.8)
  })
})

/* --------------------------------------------------------- show on map --- */

describe('show on map', () => {
  const route: RawEvent = {
    id: 'voyage', name: 'A voyage', start: 1519, end: 1522, lat: -52.5, lng: -70,
    priority: 79, tags: ['exploration'], summary: '',
    paths: [[[-70, -52.5], [-100, -35], [-130, -15], [-145, 0]]],
  }
  const seed = (): RawItem[] => [
    route,
    einstein,
    { id: 'idea', kind: 'concept', name: 'An idea', anchorYear: 1905, priority: 70, tags: ['science'], summary: '' },
  ]
  beforeEach(() => {
    setActivePinia(createPinia())
    useTimeStore().$reset()
  })

  it('selects the item, brings the timeline onto it and fits its geometry', () => {
    const events = useEventStore()
    const time = useTimeStore()
    events.adopt(seed())
    time.setSelection(1700, 1800)
    events.showOnMap('voyage')

    expect(events.selectedId).toBe('voyage') // …which is what keeps the pin
    // the band grew to hold the year, by the edge the year was past
    expect(time.selection.start).toBe(1519)
    expect(time.selection.end).toBe(1800)
    // and the camera is somewhere that can see the whole route
    const target = focusTargetFor(parseItem(route))!
    expect(events.flyTo).toEqual({ ...target, seq: 1 })
    expect(events.flyTo!.altitude).toBeGreaterThan(0.3)
  })

  it('offers nothing for an item with no geometry, and does nothing if asked', () => {
    const events = useEventStore()
    events.adopt(seed())
    expect(events.mapTarget('idea')).toBeUndefined()
    events.select('idea')
    events.showOnMap('idea')
    expect(events.flyTo).toBeUndefined()
    expect(events.selectedId).toBe('idea') // and the panel is left alone
  })

  it('flies a life to the place it began', () => {
    const events = useEventStore()
    events.adopt(seed())
    events.showOnMap('einstein')
    expect(events.selectedId).toBe('einstein')
    expect(events.flyTo!.lat).toBeCloseTo(48.4, 6)
    expect(events.flyTo!.lng).toBeCloseTo(9.99, 6)
  })

  it('keeps a derived pin selected when the article it opened asks for the map', () => {
    const events = useEventStore()
    events.adopt(seed())
    events.select('einstein--death')
    events.showOnMap('einstein--death')
    // the pin the reader opened stays the selected one, and the map goes there
    expect(events.selectedId).toBe('einstein--death')
    expect(events.flyTo!.lat).toBeCloseTo(40.36, 6)
    expect(events.flyTo!.lng).toBeCloseTo(-74.67, 6)
    expect(useTimeStore().selection.end).toBeGreaterThanOrEqual(1955)
  })

  it('works from a cold start, on an item nothing has selected', () => {
    const events = useEventStore()
    events.adopt(seed())
    expect(events.selectedId).toBeUndefined()
    events.showOnMap('voyage')
    expect(events.selected?.id).toBe('voyage')
  })
})

/* ------------------------------------------- viewport scoping and tiers --- */

import { useViewStore } from '../src/stores/view'
import { cameraScope } from '../src/lib/viewport'

const at = (id: string, priority: number, lat: number, lng: number): RawEvent => ({
  id, name: id, start: 1500, lat, lng, priority, tags: ['war'], summary: '',
})

describe('the globe query follows the camera', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useTimeStore().selection = { start: 1400, end: 1600 }
  })

  /** Thirty global heavyweights, ten Parisian also-rans. */
  const seed = () => [
    ...Array.from({ length: 30 }, (_, i) => at(`world${i}`, 99, -40 + i, -120 + i * 4)),
    ...Array.from({ length: 10 }, (_, i) => at(`paris${i}`, 40 + i, 48.8 + i * 0.01, 2.3)),
  ]

  it('is the global contest at world view — the default camera changes nothing', () => {
    const events = useEventStore()
    const view = useViewStore()
    events.adopt(seed())
    // the default camera really is world view
    expect(cameraScope({ lat: 0, lng: 0, altitude: view.altitude, aspect: 1.6 })).toBeUndefined()
    expect(events.visible.every((e) => e.id.startsWith('world'))).toBe(true)
  })

  it('spends the budget inside the frame once zoomed in', () => {
    const events = useEventStore()
    const view = useViewStore()
    events.adopt(seed())
    view.scope = { lat: 48.85, lng: 2.35, radiusDeg: 5 }
    const ids = events.visible.map((e) => e.id)
    expect(ids).toHaveLength(10)
    expect(ids.every((id) => id.startsWith('paris'))).toBe(true)
  })

  it('goes back to the global set when the camera pulls out', () => {
    const events = useEventStore()
    const view = useViewStore()
    events.adopt(seed())
    view.scope = { lat: 48.85, lng: 2.35, radiusDeg: 5 }
    expect(events.visible[0].id).toMatch(/^paris/)
    view.scope = undefined
    expect(events.visible.every((e) => e.id.startsWith('world'))).toBe(true)
  })

  it('tiers the visible set into three, best first', () => {
    const events = useEventStore()
    events.adopt(Array.from({ length: 30 }, (_, i) => at(`e${i}`, 99 - i, i, 0)))
    const tiers = events.tiers
    const visible = events.visible
    expect(tiers.size).toBe(30)
    expect(tiers.get(visible[0].id)).toBe(1)
    expect(tiers.get(visible[29].id)).toBe(3)
    // monotone down the list: a better-placed pin is never in a worse tier
    for (let i = 1; i < visible.length; i++)
      expect(tiers.get(visible[i].id)!).toBeGreaterThanOrEqual(tiers.get(visible[i - 1].id)!)
  })

  it('keeps minor pins in the bottom tier when they are shown', () => {
    const events = useEventStore()
    const settings = useSettingsStore()
    settings.showMinorEvents = true
    events.adopt([at('ranked', 80, 0, 0), at('unranked', 0, 1, 0)])
    expect(events.tiers.get('unranked')).toBe(3)
    expect(events.tiers.get('ranked')).toBe(1)
  })
})

describe('the selected event keeps its pin', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useTimeStore().selection = { start: 1400, end: 1600 }
  })

  const seed = () => [
    ...Array.from({ length: 30 }, (_, i) => at(`world${i}`, 99, -40 + i, -120 + i * 4)),
    at('paris', 40, 48.85, 2.35),
  ]

  it('survives panning the camera away from it', () => {
    const events = useEventStore()
    const view = useViewStore()
    events.adopt(seed())
    view.scope = { lat: 48.85, lng: 2.35, radiusDeg: 5 }
    events.select('paris')
    expect(events.visible.map((e) => e.id)).toContain('paris')
    // pan to the other side of the world: the frame no longer holds it
    view.scope = { lat: -33.9, lng: 151.2, radiusDeg: 5 }
    const kept = events.visible.map((e) => e.id)
    expect(kept).toContain('paris')
    // and it is kept, not ranked in: the pins that won a place under this
    // camera are exactly the ones that would be there with nothing selected
    events.select(undefined)
    expect(kept.filter((id) => id !== 'paris')).toEqual(events.visible.map((e) => e.id))
  })

  it('survives slipping out of the top N at world view', () => {
    const events = useEventStore()
    const settings = useSettingsStore()
    settings.maxEvents = 10
    events.adopt(seed())
    expect(events.visible.map((e) => e.id)).not.toContain('paris') // it never places
    events.select('paris')
    const ids = events.visible.map((e) => e.id)
    expect(ids).toContain('paris')
    expect(ids).toHaveLength(11) // the ten that placed, plus the one being kept
    expect(ids[ids.length - 1]).toBe('paris') // appended, not ranked in
  })

  it('does not survive the timeline moving off it — the long-standing rule', () => {
    // The window and the filters are the user's own statements about what to
    // show; only the cap and the camera (the app's own judgement) are overridden.
    const events = useEventStore()
    const time = useTimeStore()
    events.adopt(seed())
    events.select('paris')
    expect(events.visible.map((e) => e.id)).toContain('paris')
    time.selection = { start: 1900, end: 2000 }
    expect(events.visible.map((e) => e.id)).not.toContain('paris')
  })

  it('does not survive a filter the user set', () => {
    const events = useEventStore()
    events.adopt(seed())
    events.select('paris')
    events.toggleTag('science') // 'paris' is tagged war
    expect(events.visible.map((e) => e.id)).not.toContain('paris')
  })

  it('adds nothing when the selection is in the set already', () => {
    const events = useEventStore()
    events.adopt(seed())
    const before = events.visible.length
    events.select(events.visible[0].id)
    expect(events.visible).toHaveLength(before)
  })

  it('adds nothing for a selected person, which carries no pin of its own', () => {
    const events = useEventStore()
    events.adopt(seed())
    const before = events.visible.length
    events.select('not-an-event')
    expect(events.visible).toHaveLength(before)
  })
})

/**
 * FOCUS MODE — "Show on map" on anything the map can reach.
 *
 * The mode is deliberately separate from the selection (see `focus` in
 * stores/events.ts), and most of these tests are about that seam: what enters
 * it, what leaves it, and what it does to the pins while it lasts.
 */
describe('focus mode', () => {
  const plan = (id: string, extra: Partial<RawEvent> = {}): RawEvent => ({
    id,
    name: id,
    start: 1941,
    lat: 53.9,
    lng: 27.6,
    priority: 70,
    tags: ['war'],
    summary: '',
    drawing: { layers: [{ type: 'marker', pos: [27.6, 53.9] }] },
    ...extra,
  })

  const child = (id: string, parent: string, priority = 0): RawEvent => ({
    id, name: id, start: 1941, lat: 54, lng: 28, priority, tags: ['war'], summary: '', parent,
  })

  beforeEach(() => {
    setActivePinia(createPinia())
    useTimeStore().focusTime(1941)
  })

  it('enters on Show on map when the item has geometry to look at', () => {
    const events = useEventStore()
    events.adopt([plan('barbarossa')])
    events.showOnMap('barbarossa')
    expect(events.focus).toEqual({ itemId: 'barbarossa' })
    expect(events.panelMinimised).toBe(true)
    expect(events.focused?.id).toBe('barbarossa')
  })

  it('enters for a route or a footprint too, not only for a drawing', () => {
    const events = useEventStore()
    events.adopt([
      plan('route', { drawing: undefined, paths: [[[0, 0], [10, 10]]] }),
      plan('region', { drawing: undefined, area: [[0, 0], [1, 0], [1, 1]] }),
    ])
    events.showOnMap('route')
    expect(events.focus?.itemId).toBe('route')
    events.showOnMap('region')
    expect(events.focus?.itemId).toBe('region')
  })

  /**
   * And for a bare pin. This used to be the one case that stayed out of the
   * mode, on the reasoning that minimising an article to reveal a single
   * teardrop is a worse view of the same thing — but the mode now empties the
   * globe of everything else, so a lone pin on a clean map is exactly the view
   * "show me this" was asking for.
   */
  it('enters for a bare point event with no geometry and no children', () => {
    const events = useEventStore()
    events.adopt([plan('bare', { drawing: undefined })])
    events.showOnMap('bare')
    expect(events.focus).toEqual({ itemId: 'bare' })
    expect(events.panelMinimised).toBe(true)
    expect(events.focusChildren).toEqual([])
    expect(events.visible.map((e) => e.id)).toEqual(['bare'])
  })

  it('moves to the plain item when Show on map is used on one next', () => {
    const events = useEventStore()
    events.adopt([plan('barbarossa'), plan('bare', { drawing: undefined })])
    events.showOnMap('barbarossa')
    events.showOnMap('bare')
    expect(events.focus).toEqual({ itemId: 'bare' })
  })

  /** A concept has nowhere to go, so the action is inert — and so is the mode. */
  it('does not enter for an item the map cannot reach at all', () => {
    const events = useEventStore()
    events.adopt([
      { id: 'idea', kind: 'concept', name: 'An idea', anchorYear: 1941, priority: 70, tags: ['science'], summary: '' },
    ])
    events.showOnMap('idea')
    expect(events.focus).toBeUndefined()
  })

  it('moves when Show on map is used on another rich item', () => {
    const events = useEventStore()
    events.adopt([plan('barbarossa'), plan('d-day', { lat: 49.3, lng: -0.6 })])
    events.showOnMap('barbarossa')
    events.showOnMap('d-day')
    expect(events.focus).toEqual({ itemId: 'd-day' })
  })

  /**
   * The rule the navigation stack sharpened. It used to be "anything but the
   * focused item leaves the mode", which threw the operation away the moment
   * the reader clicked one of the battles it had just put on the globe. What
   * leaves is a statement about something *outside* the family; a part of the
   * focused item is a statement about the thing already on screen.
   */
  it('stays for the focused item and for its parts, leaves for anything else', () => {
    const events = useEventStore()
    events.adopt([plan('barbarossa'), child('minsk', 'barbarossa', 60), plan('d-day')])
    events.showOnMap('barbarossa')
    events.select('barbarossa') // re-selecting the focus is not a change
    expect(events.focus?.itemId).toBe('barbarossa')
    events.select('minsk') // a battle inside the operation: still the operation
    expect(events.focus?.itemId).toBe('barbarossa')
    expect(events.selectedId).toBe('minsk')
    events.select('d-day') // somewhere else entirely
    expect(events.focus).toBeUndefined()
  })

  it('leaves when the panel is closed', () => {
    const events = useEventStore()
    events.adopt([plan('barbarossa')])
    events.showOnMap('barbarossa')
    events.select(undefined)
    expect(events.focus).toBeUndefined()
    expect(events.selectedId).toBeUndefined()
  })

  it('expands back to the article without leaving the mode, and folds again', () => {
    const events = useEventStore()
    events.adopt([plan('barbarossa')])
    events.showOnMap('barbarossa')
    events.toggleFocusExpanded()
    expect(events.focusExpanded).toBe(true)
    expect(events.panelMinimised).toBe(false)
    expect(events.focus?.itemId).toBe('barbarossa') // still the mode
    events.toggleFocusExpanded()
    expect(events.panelMinimised).toBe(true)
  })

  it('re-minimises when Show on map is pressed again on the expanded item', () => {
    const events = useEventStore()
    events.adopt([plan('barbarossa')])
    events.showOnMap('barbarossa')
    events.toggleFocusExpanded()
    events.showOnMap('barbarossa')
    expect(events.panelMinimised).toBe(true)
  })

  it('does nothing when asked to expand outside the mode', () => {
    const events = useEventStore()
    events.toggleFocusExpanded()
    expect(events.focusExpanded).toBe(false)
  })

  it('puts the children on the globe, minor ones included', () => {
    const events = useEventStore()
    const settings = useSettingsStore()
    settings.maxEvents = 1
    events.adopt([
      plan('barbarossa'),
      child('minsk', 'barbarossa'), // minor: priority 0
      child('kiev', 'barbarossa'),
      child('elsewhere', 'other-war'), // minor, and not this operation's
    ])
    expect(events.visible.map((e) => e.id)).not.toContain('minsk')
    events.showOnMap('barbarossa')
    const ids = events.visible.map((e) => e.id)
    expect(ids).toContain('barbarossa')
    expect(ids).toContain('minsk')
    expect(ids).toContain('kiev')
    // …but only ITS children
    expect(ids).not.toContain('elsewhere')
    events.exitFocus()
    expect(events.visible.map((e) => e.id)).not.toContain('minsk')
  })

  /**
   * The other half of the same rule, and the point of the whole mode: the globe
   * shows the focused item and its parts, and NOTHING ELSE. Not the top-ranked
   * events of the era, not the ones that would have won the frame on merit —
   * the reader asked to look at one thing.
   */
  it('clears every unrelated pin off the globe while it lasts', () => {
    const events = useEventStore()
    events.adopt([
      plan('barbarossa'),
      child('minsk', 'barbarossa', 60),
      // two events that would comfortably out-rank the plan on their own
      { ...child('pearl-harbor', 'ww2', 99), start: 1941 },
      { ...child('midway', 'ww2', 98), start: 1941 },
    ])
    const before = events.visible.map((e) => e.id).sort()
    expect(before).toEqual(['barbarossa', 'midway', 'minsk', 'pearl-harbor'])
    events.showOnMap('barbarossa')
    expect(events.visible.map((e) => e.id).sort()).toEqual(['barbarossa', 'minsk'])
    // and leaving puts the globe back exactly as it was
    events.exitFocus()
    expect(events.visible.map((e) => e.id).sort()).toEqual(before)
  })

  /**
   * The user's own statements still hold inside the mode. The cap and the
   * viewport are the app's judgement about what fits, and the focused item
   * outranks both; a tag filter is the reader saying what they want to see, and
   * nothing about "show me this" contradicts it.
   */
  it('still obeys the tag filter, on the focused item and on its children', () => {
    const events = useEventStore()
    events.adopt([plan('barbarossa'), child('minsk', 'barbarossa', 60)])
    events.showOnMap('barbarossa')
    events.toggleTag('science') // nothing here is science
    expect(events.visible).toEqual([])
    events.toggleTag('science')
    expect(events.visible.map((e) => e.id).sort()).toEqual(['barbarossa', 'minsk'])
  })

  /**
   * The pipeline downstream of `visible` is untouched by the mode — it is the
   * same tier cut and the same clustering over a shorter list — but "untouched"
   * is worth one assertion, since a reduced set that produced no tiers would
   * silently render every pin at the same weight.
   */
  it('grades the reduced set: every pin still gets a tier', () => {
    const events = useEventStore()
    events.adopt([
      plan('barbarossa'),
      child('minsk', 'barbarossa', 60),
      child('kiev', 'barbarossa', 10),
    ])
    events.showOnMap('barbarossa')
    expect([...events.tiers.keys()].sort()).toEqual(['barbarossa', 'kiev', 'minsk'])
  })

  /** The camera cannot hide the thing the camera was just flown to. */
  it('ignores the viewport scope: a child off-frame keeps its pin', () => {
    const events = useEventStore()
    events.adopt([plan('barbarossa'), { ...child('faraway', 'barbarossa', 60), lat: -40, lng: 170 }])
    useViewStore().scope = { lat: 54, lng: 28, radiusDeg: 8 }
    events.showOnMap('barbarossa')
    expect(events.visible.map((e) => e.id).sort()).toEqual(['barbarossa', 'faraway'])
  })

  /**
   * A battle plan shows its battles and nothing else. Associations are things
   * to read next, not pins to scatter over someone else's map — which is what
   * the product asked for in so many words.
   */
  it('pins children only: a strong relation is not part of the plan', () => {
    const events = useEventStore()
    useSettingsStore().maxEvents = 1
    events.adopt([
      plan('barbarossa', { strong: ['pact'], weak: ['winter'] }),
      child('minsk', 'barbarossa'),
      { ...child('pact', 'other-war'), name: 'pact' },
      { ...child('winter', 'other-war'), name: 'winter' },
    ])
    events.showOnMap('barbarossa')
    const ids = events.visible.map((e) => e.id)
    expect(ids).toContain('minsk')
    expect(ids).not.toContain('pact')
    expect(ids).not.toContain('winter')
    expect(events.focusChildren.map((e) => e.id)).toEqual(['minsk'])
  })

  it('caps how many children it will force on', () => {
    const events = useEventStore()
    useSettingsStore().maxEvents = 1
    events.adopt([
      plan('barbarossa'),
      ...Array.from({ length: 40 }, (_, i) => child(`c${i}`, 'barbarossa', i)),
    ])
    events.showOnMap('barbarossa')
    expect(events.focusChildren).toHaveLength(FOCUS_CHILD_CAP)
    // the parent, plus the capped children (the top-N budget is 1)
    expect(events.visible).toHaveLength(FOCUS_CHILD_CAP + 1)
    // best first: the cap keeps the ones that matter
    expect(events.focusChildren[0].id).toBe('c39')
  })

  it('does not double-list a child that won a place on its own merit', () => {
    const events = useEventStore()
    events.adopt([plan('barbarossa'), child('minsk', 'barbarossa', 95)])
    events.showOnMap('barbarossa')
    expect(events.visible.filter((e) => e.id === 'minsk')).toHaveLength(1)
  })

  it('still obeys the timeline: a child outside the window keeps its pin off', () => {
    const events = useEventStore()
    events.adopt([plan('barbarossa'), { ...child('later', 'barbarossa'), start: 1990 }])
    events.showOnMap('barbarossa')
    expect(events.visible.map((e) => e.id)).not.toContain('later')
  })
})

/**
 * FOCUS NAVIGATION — the stack of contexts.
 *
 * The mode is a place you can be *inside of*: an operation puts its battles on
 * the globe so that they can be opened, and opening one has to leave the
 * operation where it was. These are the transitions that make that true, and
 * the ones that end it — see `focusStack` in stores/events.ts.
 */
describe('focus navigation, inside a plan and back out', () => {
  const plan = (id: string, extra: Partial<RawEvent> = {}): RawEvent => ({
    id, name: id, start: 1941, lat: 53.9, lng: 27.6, priority: 70, tags: ['war'], summary: '',
    drawing: { layers: [{ type: 'marker', pos: [27.6, 53.9] }] },
    ...extra,
  })
  const part = (id: string, parent: string, priority = 0): RawEvent => ({
    id, name: id, start: 1941, lat: 54, lng: 28, priority, tags: ['war'], summary: '', parent,
  })

  /** An operation, two battles inside it, a village inside one battle, and an
   *  unrelated plan on the other side of the war. */
  const corpus = (): RawEvent[] => [
    plan('barbarossa'),
    part('kiev', 'barbarossa', 60),
    part('minsk', 'barbarossa', 50),
    plan('village', { ...part('village', 'kiev', 10) }),
    plan('d-day', { lat: 49.3, lng: -0.6 }),
  ]

  const store = () => {
    const events = useEventStore()
    events.adopt(corpus())
    return events
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    useTimeStore().focusTime(1941)
  })

  it('keeps the operation when one of its battles is opened', () => {
    const events = store()
    events.showOnMap('barbarossa')
    const pinned = events.visible.map((e) => e.id).sort()
    events.select('kiev')
    expect(events.focus).toEqual({ itemId: 'barbarossa' }) // the context is untouched
    expect(events.selectedId).toBe('kiev') // …and the battle is what is being read
    expect(events.focusChildren.map((e) => e.id)).toContain('kiev')
    expect(events.visible.map((e) => e.id).sort()).toEqual(pinned) // same globe
    // and the panel says where it is, by name
    expect(events.focusReturnTo?.id).toBe('barbarossa')
  })

  it('opens the battle expanded even when the operation was minimised', () => {
    // Owner call: tapping a child pin says "tell me about this one" — the
    // article opens expanded regardless of the shape the context's panel was in.
    const events = store()
    events.showOnMap('barbarossa')
    expect(events.panelMinimised).toBe(true)
    events.select('kiev')
    expect(events.panelMinimised).toBe(false) // the battle's article, over the map
    events.select('minsk')
    expect(events.panelMinimised).toBe(false)
    expect(events.focusReturnTo?.id).toBe('barbarossa')
  })

  it('closing the battle comes back to the operation, not to the world', () => {
    const events = store()
    events.showOnMap('barbarossa')
    events.select('kiev')
    events.close()
    expect(events.focus).toEqual({ itemId: 'barbarossa' })
    expect(events.selectedId).toBe('barbarossa')
    expect(events.panelMinimised).toBe(true) // the operation's pill is back
    expect(events.visible.map((e) => e.id)).toContain('minsk') // …and its battles
  })

  it('Escape unwinds the same ladder, one rung at a time', () => {
    const events = store()
    events.showOnMap('barbarossa')
    events.select('kiev')
    events.focusBack()
    expect(events.selectedId).toBe('barbarossa')
    expect(events.focus?.itemId).toBe('barbarossa')
    events.focusBack()
    expect(events.focus).toBeUndefined() // out of the mode…
    expect(events.selectedId).toBe('barbarossa') // …but still reading, as ever
    events.focusBack()
    expect(events.selectedId).toBe('barbarossa') // nothing left to unwind
  })

  /** "Show on map" on a part *pushes*: the battle gets the map on its own
   *  terms, and leaving it comes back to the operation it is part of. */
  it('pushes a context when a battle is shown on the map, and pops it on exit', () => {
    const events = store()
    events.showOnMap('barbarossa')
    events.showOnMap('kiev')
    expect(events.focus).toEqual({ itemId: 'kiev' })
    expect(events.selectedId).toBe('kiev')
    expect(events.focusChildren.map((e) => e.id)).toEqual(['village']) // its own parts
    expect(events.focusReturnTo).toBeUndefined() // it is the context now, not a part of one
    events.close()
    expect(events.focus).toEqual({ itemId: 'barbarossa' })
    expect(events.selectedId).toBe('barbarossa')
    expect(events.visible.map((e) => e.id).sort()).toEqual(['barbarossa', 'kiev', 'minsk'])
  })

  it('pops one context per exit, all the way down to the plain map', () => {
    const events = store()
    events.showOnMap('barbarossa')
    events.showOnMap('kiev')
    events.showOnMap('village')
    expect(events.focus?.itemId).toBe('village')
    events.exitFocus()
    expect(events.focus?.itemId).toBe('kiev')
    events.exitFocus()
    expect(events.focus?.itemId).toBe('barbarossa')
    events.exitFocus()
    expect(events.focus).toBeUndefined()
  })

  it('drops the whole stack when something outside the family is picked', () => {
    const events = store()
    events.showOnMap('barbarossa')
    events.showOnMap('kiev')
    events.select('d-day') // a search hit, a link, another pin
    expect(events.focus).toBeUndefined()
    expect(events.focusStack).toEqual([])
    expect(events.selectedId).toBe('d-day')
    // and the globe is the ordinary one again
    expect(events.visible.map((e) => e.id)).toContain('barbarossa')
  })

  it('replaces the stack when the map is asked for something outside the family', () => {
    const events = store()
    events.showOnMap('barbarossa')
    events.showOnMap('kiev')
    events.showOnMap('d-day')
    expect(events.focusStack).toEqual(['d-day'])
    events.close()
    expect(events.focus).toBeUndefined()
    expect(events.selectedId).toBeUndefined()
  })

  /** The way back has to be an affordance, not a memory: it exists exactly when
   *  the panel is on a part of the context, and it names that context. */
  it('offers the way back only from inside a context', () => {
    const events = store()
    expect(events.focusReturnTo).toBeUndefined()
    events.select('kiev')
    expect(events.focusReturnTo).toBeUndefined() // no focus: nothing to be inside of
    events.showOnMap('barbarossa')
    expect(events.focusReturnTo).toBeUndefined() // the context itself
    events.select('kiev')
    expect(events.focusReturnTo?.name).toBe('barbarossa')
  })

  /** A child ranked out of the pinned set is still part of the operation: it can
   *  be reached from "Contains", and when it is, it gets its pin. */
  it('keeps a pin under a part the child cap ranked out', () => {
    const events = useEventStore()
    events.adopt([
      plan('barbarossa'),
      ...Array.from({ length: 40 }, (_, i) => part(`c${i}`, 'barbarossa', i)),
    ])
    events.showOnMap('barbarossa')
    expect(events.visible.map((e) => e.id)).not.toContain('c0') // ranked out
    events.select('c0')
    expect(events.focus?.itemId).toBe('barbarossa') // still inside the operation
    expect(events.visible.map((e) => e.id)).toContain('c0') // and on the globe
  })

  it('bounds the stack, keeping the innermost contexts', () => {
    const events = useEventStore()
    // a chain of parts, each inside the last
    events.adopt([
      plan('a'),
      ...Array.from({ length: 6 }, (_, i) => plan(`p${i}`, { parent: i ? `p${i - 1}` : 'a' })),
    ])
    events.showOnMap('a')
    for (let i = 0; i < 6; i++) events.showOnMap(`p${i}`)
    expect(events.focusStack).toHaveLength(FOCUS_STACK_CAP)
    expect(events.focusStack[FOCUS_STACK_CAP - 1]).toBe('p5')
  })

  /** Report 3: an era or an age is a question about the world, and it is
   *  answered on a clean map. The pickers call this (TopBar, TimelineBar). */
  it('dismisses everything for an era pick, from however deep in', () => {
    const events = store()
    events.showOnMap('barbarossa')
    events.showOnMap('kiev')
    events.select('village')
    events.expandCluster('somewhere', 40)
    events.dismiss()
    expect(events.focus).toBeUndefined()
    expect(events.focusStack).toEqual([])
    expect(events.focusExpanded).toBe(false)
    expect(events.selectedId).toBeUndefined()
    expect(events.expandedClusterId).toBeUndefined()
    expect(events.visible.map((e) => e.id)).toContain('d-day') // the ordinary globe
  })
})

/**
 * THE STATE MACHINE IS TOTAL.
 *
 * The stuck state was reachable because nothing said what could not happen: the
 * globe was left filtered down to a focused item while no panel named it, so
 * there was nothing on screen to leave the mode by — no pill, no article, and
 * (before this) no era pick that would clear it either.
 *
 * So rather than testing the one sequence that was reported, this walks the
 * WHOLE reachable graph — every action the UI can fire, from every state they
 * can reach — and checks the invariants at each node. The state is exactly
 * `focusStack`, `selectedId` and `focusExpanded`, which is what makes the walk
 * finite and what makes restoring a node by assignment legitimate.
 */
describe('every reachable state has a way out', () => {
  const plan = (id: string, extra: Partial<RawEvent> = {}): RawEvent => ({
    id, name: id, start: 1941, lat: 53.9, lng: 27.6, priority: 70, tags: ['war'], summary: '',
    drawing: { layers: [{ type: 'marker', pos: [27.6, 53.9] }] },
    ...extra,
  })
  const corpus: RawEvent[] = [
    plan('op'),
    plan('battle', { parent: 'op', priority: 60 }),
    plan('village', { parent: 'battle', priority: 10 }),
    plan('elsewhere', { lat: 49.3, lng: -0.6 }),
  ]

  type Snapshot = { focusStack: string[]; selectedId?: string; focusExpanded: boolean }
  const ids = ['op', 'battle', 'village', 'elsewhere']

  /** Everything a user can do to this state machine, named. */
  const ACTIONS: [string, (e: ReturnType<typeof useEventStore>) => void][] = [
    ...ids.map((id) => [`select ${id}`, (e: ReturnType<typeof useEventStore>) => e.select(id)] as const),
    ...ids.map((id) => [`showOnMap ${id}`, (e: ReturnType<typeof useEventStore>) => e.showOnMap(id)] as const),
    ['close', (e) => e.close()],
    ['select()', (e) => e.select()],
    ['focusBack', (e) => e.focusBack()],
    ['exitFocus', (e) => e.exitFocus()],
    ['toggleExpanded', (e) => e.toggleFocusExpanded()],
    ['dismiss', (e) => e.dismiss()],
  ]

  const snap = (e: ReturnType<typeof useEventStore>): Snapshot => ({
    focusStack: [...e.focusStack],
    selectedId: e.selectedId,
    focusExpanded: e.focusExpanded,
  })
  const restore = (e: ReturnType<typeof useEventStore>, s: Snapshot) => {
    e.focusStack = [...s.focusStack]
    e.selectedId = s.selectedId
    e.focusExpanded = s.focusExpanded
  }
  const key = (s: Snapshot) => `${s.focusStack.join('>')}|${s.selectedId ?? '-'}|${s.focusExpanded}`

  /** What the reader can see and press: an article, a pill, or nothing at all. */
  const panelOf = (e: ReturnType<typeof useEventStore>) =>
    !e.selected ? 'none' : e.panelMinimised ? 'pill' : 'article'

  /** Walk the graph once; `visit` is handed every state that is reached. */
  const walk = (visit: (e: ReturnType<typeof useEventStore>, path: string[]) => void) => {
    setActivePinia(createPinia())
    useTimeStore().focusTime(1941)
    const events = useEventStore()
    events.adopt(corpus)
    const start = snap(events)
    const seen = new Map<string, string[]>([[key(start), []]])
    const queue: [Snapshot, string[]][] = [[start, []]]
    while (queue.length) {
      const [state, path] = queue.shift()!
      for (const [name, act] of ACTIONS) {
        restore(events, state)
        act(events)
        const next = snap(events)
        const trail = [...path, name]
        visit(events, trail)
        if (!seen.has(key(next))) {
          seen.set(key(next), trail)
          queue.push([next, trail])
        }
      }
    }
    return seen
  }

  it('reaches every shape of the machine, so the checks below are not vacuous', () => {
    const seen = walk(() => {})
    // 4 items x (no focus | 4 depth-1 contexts | the nested ones) x expanded x
    // which of the family the panel is on. The exact number is not the point —
    // that it is a graph rather than a handful of states is.
    expect(seen.size).toBeGreaterThan(20)
    // and the deepest thing reachable is the chain of parts, capped
    expect(Math.max(...[...seen.keys()].map((k) => k.split('|')[0].split('>').filter(Boolean).length)))
      .toBeLessThanOrEqual(FOCUS_STACK_CAP)
  })

  it('never leaves the globe filtered with nothing on screen to unfilter it', () => {
    walk((events, path) => {
      const focused = events.focus?.itemId
      if (!focused) return
      // A focus filters the globe down to one family (see `visible`). If no
      // panel is up, nothing names it and nothing can leave it: that is the
      // stuck state, and it must not be reachable.
      expect(panelOf(events), `no panel after ${path.join(' → ')}`).not.toBe('none')
      // …and what the panel is on is the context or a part of it, so the article
      // on screen and the pins on the globe are about the same thing.
      const sel = events.selectedId
      const inside = sel !== undefined ? events.byId(sel) : undefined
      const isPart = !!inside && 'parent' in inside && inside.parent === focused
      expect(sel === focused || isPart, `panel on ${sel} inside ${focused}`).toBe(true)
    })
  })

  it('only ever shows the pill inside the mode', () => {
    walk((events, path) => {
      if (events.panelMinimised)
        expect(events.focusStack.length, `pill outside the mode after ${path.join(' → ')}`)
          .toBeGreaterThan(0)
    })
  })

  it('leaves the globe unfiltered whenever the mode is off', () => {
    walk((events, path) => {
      if (events.focusStack.length) return
      // nothing is being held back: the unrelated plan is on the globe again
      expect(events.visible.map((e) => e.id), `after ${path.join(' → ')}`).toContain('elsewhere')
    })
  })

  it('is always a bounded number of closes from the plain map', () => {
    const seen = walk(() => {})
    setActivePinia(createPinia())
    useTimeStore().focusTime(1941)
    const events = useEventStore()
    events.adopt(corpus)
    for (const [k, path] of seen) {
      const [stack, sel, expanded] = k.split('|')
      restore(events, {
        focusStack: stack ? stack.split('>') : [],
        selectedId: sel === '-' ? undefined : sel,
        focusExpanded: expanded === 'true',
      })
      // one press per rung of the ladder, plus the one that closes the article
      let presses = 0
      while ((events.focusStack.length || events.selectedId) && presses < 12) {
        events.close()
        presses++
      }
      expect(events.focusStack, `stuck after ${path.join(' → ')}`).toEqual([])
      expect(events.selectedId, `stuck after ${path.join(' → ')}`).toBeUndefined()
      expect(presses, `too many presses from ${k}`).toBeLessThanOrEqual(FOCUS_STACK_CAP + 2)
    }
  })
})
