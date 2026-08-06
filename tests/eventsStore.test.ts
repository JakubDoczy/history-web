import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  FOCUS_CHILD_CAP,
  FOCUS_STACK_CAP,
  SIDE_BY_SIDE_MIN_PX,
  opensExpanded,
  useEventStore,
} from '../src/stores/events'
import { useSettingsStore } from '../src/stores/settings'
import { useTimeStore } from '../src/stores/time'
import { useViewStore } from '../src/stores/view'
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

  /* Regression: the fit used the camera's vertical fov alone, so the altitude
     was identical on a desktop and on a portrait phone — where the frame is
     half as wide as it is tall and a route hangs off both sides. */
  it('fits to the window on screen, not to a square one', () => {
    const events = useEventStore()
    const view = useViewStore()
    events.adopt(seed())

    view.viewportWidthPx = 1440
    view.viewportPx = 900
    const desktop = events.mapTarget('voyage')!
    expect(desktop.altitude).toBe(focusTargetFor(parseItem(route), view.fov, 1440 / 900)!.altitude)

    view.viewportWidthPx = 390
    view.viewportPx = 844
    const phone = events.mapTarget('voyage')!
    expect(phone.altitude).toBeGreaterThan(desktop.altitude)
    // the centre is a property of the geometry, not of the window
    expect([phone.lat, phone.lng]).toEqual([desktop.lat, desktop.lng])

    // and the flight the panel asks for is the fitted one, not the square one
    events.showOnMap('voyage')
    expect(events.flyTo!.altitude).toBe(phone.altitude)
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
/* ------------------------------------- the mode never outlives its subject ---
   Regression: a focused battle plan survived a scrub to an arbitrary time —
   Barbarossa's 1941 front was still drawn, in ink, over a Permian paleomap
   300 million years before it, on a globe the same band had emptied of every
   pin (/tmp/shots35/verify-F2-live.png). The band is what says an item is on
   the timeline at all, so when it no longer touches the focused item the mode
   goes, exactly as picking an era already made it go (`dismiss`). */
describe('focus ends when its subject leaves the timeline', () => {
  const op = (extra: Partial<RawEvent> = {}): RawEvent => ({
    id: 'op', name: 'op', start: 1941, end: 1945, lat: 53.9, lng: 27.6,
    priority: 70, tags: ['war'], summary: '',
    drawing: { layers: [{ type: 'marker', pos: [27.6, 53.9] }] },
    steps: [{ id: 'kiev', name: 'Kiev', at: 0.45 }],
    ...extra,
  })
  const focused = () => {
    const events = useEventStore()
    events.adopt([op()])
    events.showOnMap('op')
    expect(events.focus).toEqual({ itemId: 'op' })
    return events
  }
  /** What the app does on every band move (App.vue). */
  const scrubTo = (start: number, end: number) => {
    const time = useTimeStore()
    time.setSelection(start, end)
    useEventStore().dropFocusOffTimeline(time.selection.start, time.selection.end)
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    useTimeStore().focusTime(1941)
  })

  it('drops the whole mode when the band no longer touches the event', () => {
    const events = focused()
    events.selectStep('kiev')
    scrubTo(1600, 1700)
    expect(events.focus).toBeUndefined()
    expect(events.focusDrawing).toBeUndefined()
    expect(events.stepId).toBeUndefined()
    expect(events.selectedId).toBeUndefined() // …a clean map, as an era pick gives
  })

  it('survives a band that still touches the event at all', () => {
    const events = focused()
    scrubTo(1900, 1941) // touching at exactly the start year counts
    expect(events.focus).toEqual({ itemId: 'op' })
    scrubTo(1945, 2000) // and at exactly the end year
    expect(events.focus).toEqual({ itemId: 'op' })
    scrubTo(1942, 1943) // and wholly inside it
    expect(events.focus).toEqual({ itemId: 'op' })
  })

  it('survives stepping through the steps, which move the cursor alone', () => {
    const events = focused()
    const time = useTimeStore()
    time.setSelection(1941, 1945)
    events.selectStep('kiev')
    events.dropFocusOffTimeline(time.selection.start, time.selection.end)
    expect(events.focus).toEqual({ itemId: 'op' })
    expect(events.stepId).toBe('kiev')
  })

  it('leaves a focus alone while its chunk has not loaded', () => {
    // chunks stream, and "I have not loaded it" is not "it is not in this time"
    const events = useEventStore()
    events.focusStack = ['not-loaded-yet']
    events.dropFocusOffTimeline(-300e6, -299e6)
    expect(events.focus).toEqual({ itemId: 'not-loaded-yet' })
  })

  it('keeps the focus the very moment Show on map enters it', () => {
    // showOnMap brings the timeline onto the item before entering the mode; the
    // watcher runs after, and must find the band on the item rather than kill
    // the focus it just opened
    const events = useEventStore()
    const time = useTimeStore()
    events.adopt([op()])
    time.setSelection(1600, 1700)
    events.showOnMap('op')
    events.dropFocusOffTimeline(time.selection.start, time.selection.end)
    expect(events.focus).toEqual({ itemId: 'op' })
  })
})

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
    // `op` carries steps, so the walk covers the two transitions that are not
    // the same for every item. One: entering a focus on a SAGA leaves the
    // article up rather than folding it to the pill (`opensExpanded`, and the
    // view store's default width is a desktop one) — every invariant below is
    // about there being a panel and about what it is on, so both shapes must be
    // walked or the checks only ever see the pill. Two: its second step is an
    // ENTRANCE, so `selectStep` can push a whole context (see `Step.child`),
    // and the walk covers descending into a child as well as arriving at one by
    // pressing its pin.
    plan('op', {
      steps: [
        { id: 'first', name: 'First', at: 0 },
        { id: 'into', name: 'Into the battle', at: 0.5, child: 'battle' },
      ],
    }),
    plan('battle', { parent: 'op', priority: 60, steps: [{ id: 'own', name: 'Own', at: 0 }] }),
    plan('village', { parent: 'battle', priority: 10 }),
    plan('elsewhere', { lat: 49.3, lng: -0.6 }),
  ]

  /**
   * The state, exactly — and `stepId` is part of it now that a chip can move
   * the machine. Without it in here the walk would restore a node with the
   * wrong step open and the graph would stop being deterministic.
   */
  type Snapshot = {
    focusStack: string[]
    selectedId?: string
    focusExpanded: boolean
    stepId?: string
  }
  const ids = ['op', 'battle', 'village', 'elsewhere']
  /** Every chip the strip can offer, over both events that carry steps. */
  const stepIds = ['first', 'into', 'own']

  /** Everything a user can do to this state machine, named. */
  const ACTIONS: [string, (e: ReturnType<typeof useEventStore>) => void][] = [
    ...ids.map((id) => [`select ${id}`, (e: ReturnType<typeof useEventStore>) => e.select(id)] as const),
    ...ids.map((id) => [`showOnMap ${id}`, (e: ReturnType<typeof useEventStore>) => e.showOnMap(id)] as const),
    ...stepIds.map(
      (id) => [`selectStep ${id}`, (e: ReturnType<typeof useEventStore>) => e.selectStep(id)] as const,
    ),
    ['selectStep()', (e) => e.selectStep()],
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
    stepId: e.stepId,
  })
  const restore = (e: ReturnType<typeof useEventStore>, s: Snapshot) => {
    e.focusStack = [...s.focusStack]
    e.selectedId = s.selectedId
    e.focusExpanded = s.focusExpanded
    e.stepId = s.stepId
  }
  const key = (s: Snapshot) =>
    `${s.focusStack.join('>')}|${s.selectedId ?? '-'}|${s.focusExpanded}|${s.stepId ?? '-'}`

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
    // the step machine is walked, not merely present: some node has a step
    // open, and the ENTRANCE has been taken (a two-deep stack reached by a
    // chip, which is the transition the recursion added)
    expect([...seen.keys()].some((k) => k.endsWith('|first'))).toBe(true)
    // …and the ENTRANCE really descends, from EVERY state the saga can be in:
    // the chip pushes the child and hands it the panel. That is the transition
    // recursion added, and the one thing here no other action does.
    setActivePinia(createPinia())
    useTimeStore().focusTime(1941)
    const events = useEventStore()
    events.adopt(corpus)
    let descents = 0
    for (const k of seen.keys()) {
      const [stack, sel, expanded, step] = k.split('|')
      const focusStack = stack ? stack.split('>') : []
      if (focusStack[focusStack.length - 1] !== 'op') continue
      restore(events, {
        focusStack,
        selectedId: sel === '-' ? undefined : sel,
        focusExpanded: expanded === 'true',
        stepId: step === '-' ? undefined : step,
      })
      events.selectStep('into')
      descents++
      expect(events.focusStack.slice(-2), `from ${k}`).toEqual(['op', 'battle'])
      expect(events.selectedId, `from ${k}`).toBe('battle')
      expect(events.stepId, `from ${k}`).toBeUndefined()
    }
    expect(descents, 'the entrance chip was never pressed inside the saga').toBeGreaterThan(0)
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
      const [stack, sel, expanded, step] = k.split('|')
      restore(events, {
        focusStack: stack ? stack.split('>') : [],
        selectedId: sel === '-' ? undefined : sel,
        focusExpanded: expanded === 'true',
        stepId: step === '-' ? undefined : step,
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

/**
 * STEPPED FOCUS: the store's half of the feature (see src/lib/steps.ts for the
 * schema and the folds, and tests/eventsData.test.ts for the corpus).
 *
 * Everything here is about the four things a chip does — filter the drawing,
 * open the page, move the camera, move the cursor — and about the one thing it
 * must never do, which is change the selection band under the reader.
 */
describe('stepped focus', () => {
  const steps = [
    { id: 'june', name: 'The border battles', at: 0, page: 'Three army groups crossed.' },
    { id: 'kiev', name: 'Kiev', at: 0.45, camera: { lat: 50, lng: 32, altitude: 0.2 } },
    { id: 'december', name: 'The counteroffensive', at: 0.9 },
  ]
  const op = (extra: Partial<RawEvent> = {}): RawEvent => ({
    id: 'op',
    name: 'op',
    start: 1941,
    lat: 53.9,
    lng: 27.6,
    priority: 70,
    tags: ['war'],
    summary: '',
    drawing: {
      layers: [
        { type: 'label', pos: [24, 53], text: 'June front', at: 0 },
        { type: 'label', pos: [30, 54], text: 'Army Group Centre' }, // timeless
        { type: 'label', pos: [32, 50], text: 'Kiev pocket', at: 0.5 },
        { type: 'label', pos: [37, 55], text: 'December front', at: 0.95 },
      ],
    },
    steps,
    ...extra,
  })
  const part = (id: string, parent: string): RawEvent => ({
    id, name: id, start: 1941, lat: 54, lng: 28, priority: 0, tags: ['war'], summary: '', parent,
  })

  const texts = (e: ReturnType<typeof useEventStore>) =>
    (e.focusDrawing?.layers ?? []).map((l) => (l as { text: string }).text)

  const store = (extra: RawEvent[] = []) => {
    const events = useEventStore()
    events.adopt([op(), ...extra])
    return events
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    useTimeStore().focusTime(1941)
  })

  it('offers no steps for an event that has none', () => {
    const events = useEventStore()
    events.adopt([op({ steps: undefined })])
    events.showOnMap('op')
    expect(events.focusSteps).toEqual([])
    expect(events.activeStep).toBeUndefined()
    expect(texts(events)).toHaveLength(4) // …and draws everything, as it always did
  })

  it('offers the steps of the focused event, in time order', () => {
    const events = store()
    events.showOnMap('op')
    expect(events.focusSteps.map((s) => s.id)).toEqual(['june', 'kiev', 'december'])
  })

  /**
   * OVERVIEW FIRST, WITHOUT A SECOND CLICK.
   *
   * An operation is the one thing whose focus is a reading as well as a view:
   * folding it to a pill answered "show me Barbarossa" with a two-word bar, and
   * the overview it is supposed to land on took a click nothing advertised. On
   * a phone the article is a sheet OVER the map, so there the pill is still
   * right — the rule is the width, and it is the stylesheets' own break.
   */
  it('opens an operation on its overview where there is room beside the map', () => {
    const events = store()
    events.showOnMap('op')
    expect(events.panelMinimised).toBe(false)
    expect(events.stepId, 'landed on a step rather than the overview').toBeUndefined()
  })

  it('opens the same operation as a pill on a phone', () => {
    useViewStore().viewportWidthPx = 390
    const events = store()
    events.showOnMap('op')
    expect(events.panelMinimised).toBe(true)
  })

  it('leaves everything without steps folded to the pill, desktop or not', () => {
    const events = useEventStore()
    events.adopt([op({ steps: undefined })])
    events.showOnMap('op')
    expect(events.panelMinimised).toBe(true)
  })

  it('decides that on the item and the width, and nothing else', () => {
    const stepped = { kind: 'event', steps: [{ id: 'a' }] } as unknown as Parameters<
      typeof opensExpanded
    >[0]
    expect(opensExpanded(stepped, SIDE_BY_SIDE_MIN_PX)).toBe(true)
    expect(opensExpanded(stepped, SIDE_BY_SIDE_MIN_PX - 1)).toBe(false)
    expect(opensExpanded({ kind: 'event' } as typeof stepped, 1600)).toBe(false)
    expect(opensExpanded(undefined, 1600)).toBe(false)
  })

  /** The owner's rule: the default view is the whole-event overview. */
  it('lands on the overview, with every layer drawn', () => {
    const events = store()
    events.showOnMap('op')
    expect(events.stepId).toBeUndefined()
    expect(events.activeStep).toBeUndefined()
    expect(texts(events)).toEqual([
      'June front', 'Army Group Centre', 'Kiev pocket', 'December front',
    ])
  })

  it('filters the drawing to the step’s layers plus the timeless ones', () => {
    const events = store()
    events.showOnMap('op')
    events.selectStep('kiev')
    expect(events.activeStep?.id).toBe('kiev')
    expect(texts(events)).toEqual(['Army Group Centre', 'Kiev pocket'])
    events.selectStep('december')
    expect(texts(events)).toEqual(['Army Group Centre', 'December front'])
  })

  it('restores the whole drawing on the way back to the overview', () => {
    const events = store()
    events.showOnMap('op')
    events.selectStep('kiev')
    events.selectStep()
    expect(events.stepId).toBeUndefined()
    expect(texts(events)).toHaveLength(4)
  })

  it('opens the panel on a step that has a page, and leaves it alone otherwise', () => {
    const events = store()
    events.showOnMap('op')
    // An operation on a desktop-width screen lands with its overview up, which
    // is the default viewport the view store carries (see `opensExpanded`).
    expect(events.panelMinimised).toBe(false)
    events.toggleFocusExpanded() // …and the reader folds it away again
    events.selectStep('december') // no page: the map stays uncovered
    expect(events.panelMinimised).toBe(true)
    events.selectStep('june') // a page: the article comes up to hold it
    expect(events.panelMinimised).toBe(false)
  })

  it('flies the camera only for a step that says where to look', () => {
    const events = store()
    events.showOnMap('op')
    const before = events.flyTo!.seq
    events.selectStep('december')
    expect(events.flyTo!.seq, 'a step with no camera moved the view').toBe(before)
    events.selectStep('kiev')
    expect(events.flyTo).toMatchObject({ lat: 50, lng: 32, altitude: 0.2 })
  })

  it('refits the whole event when a stepped camera is given back to the overview', () => {
    const events = store()
    events.showOnMap('op')
    events.selectStep('kiev')
    const moved = events.flyTo!.seq
    events.selectStep()
    expect(events.flyTo!.seq).toBeGreaterThan(moved)
    // the whole-event fit, which is the bounding cap of everything it draws —
    // not the pin, and emphatically not where the step left the camera
    expect(events.flyTo).toMatchObject(events.mapTarget('op')!)
  })

  it('leaves the view where the reader put it when no step ever moved it', () => {
    const events = useEventStore()
    events.adopt([op({ steps: steps.map(({ camera, ...s }) => s) })])
    events.showOnMap('op')
    events.selectStep('kiev')
    const seq = events.flyTo!.seq
    events.selectStep()
    expect(events.flyTo!.seq, 'the overview took the camera back for no reason').toBe(seq)
  })

  /**
   * The distinction `setCursor` exists for. The band is what culls the pins, so
   * a chip that dragged it would silently rewrite the set of events on the map —
   * which is not what "step to the next moment of this operation" means.
   */
  it('moves the time cursor and not the selection band', () => {
    const events = store()
    const time = useTimeStore()
    events.showOnMap('op')
    time.setSelection(1900, 1950)
    const band = { ...time.selection }
    time.currentTime = 1000
    events.selectStep('kiev')
    expect(time.currentTime).toBe(1941)
    expect(time.selection).toEqual(band)
  })

  it('ignores a step id the focused event does not declare', () => {
    const events = store()
    events.showOnMap('op')
    events.selectStep('kiev')
    events.selectStep('not-a-step')
    expect(events.stepId, 'an unknown chip changed the map').toBe('kiev')
  })

  it('does nothing at all outside focus mode', () => {
    const events = store()
    events.select('op')
    events.selectStep('kiev')
    expect(events.stepId).toBeUndefined()
    expect(events.focusDrawing).toBeUndefined()
  })

  /* --- the step belongs to the context, and never outlives it ------------ */

  it('opens every new context on its overview', () => {
    const events = store([part('battle', 'op')])
    events.showOnMap('op')
    events.selectStep('kiev')
    events.showOnMap('battle') // pushed: a context of its own
    expect(events.stepId).toBeUndefined()
    events.focusBack() // …and back out to the operation
    expect(events.stepId).toBeUndefined()
  })

  it('drops the step when the mode is left altogether', () => {
    const events = store([{ ...part('other', 'op'), parent: undefined }])
    events.showOnMap('op')
    events.selectStep('kiev')
    events.select('other') // a statement about something else entirely
    expect(events.focus).toBeUndefined()
    expect(events.stepId).toBeUndefined()
  })

  it('keeps the step while a part of the focused event is read', () => {
    const events = store([part('battle', 'op')])
    events.showOnMap('op')
    events.selectStep('kiev')
    events.select('battle')
    // the map is still filtered to the step — the context did not change
    expect(events.stepId).toBe('kiev')
    expect(texts(events)).toEqual(['Army Group Centre', 'Kiev pocket'])
  })

  /* --- the strip is a control over the FOCUSED event ---------------------
     Regression: with a battle inside the operation open, a step chip set
     `stepId` and force-expanded the panel — onto the BATTLE's article, since
     that is what `selectedId` still pointed at. The chip lit up, the step's
     page was unreachable (it renders only on the focused event's own article),
     and the reader who clicked "Kiev" got Minsk. See
     /tmp/shots35/repro-stage-child.mjs. */
  it('brings the selection back to the focused event, and opens the step page', () => {
    const events = store([part('battle', 'op')])
    events.showOnMap('op')
    events.select('battle') // a part of the operation: still the same context
    expect(events.selectedId).toBe('battle')
    events.toggleFocusExpanded() // …minimised again, as the repro leaves it

    events.selectStep('june') // the step with a page
    expect(events.selectedId, 'the step page belongs to the focused event').toBe('op')
    expect(events.stepId).toBe('june')
    expect(events.activeStep?.page).toBeTruthy()
    // which is what makes the page reachable at all (EventPanel's `stepPage`)
    expect(events.panelMinimised).toBe(false)
    expect(events.focusReturnTo).toBeUndefined()
  })

  it('does the same for a step with no page of its own', () => {
    const events = store([part('battle', 'op')])
    events.showOnMap('op')
    events.select('battle')
    events.selectStep('december') // no page: the map stays uncovered
    expect(events.selectedId).toBe('op')
    expect(events.panelMinimised).toBe(true)
  })

  it('takes the overview chip as the way back to the whole event too', () => {
    const events = store([part('battle', 'op')])
    events.showOnMap('op')
    events.selectStep('kiev')
    events.select('battle')
    const seq = events.flyTo!.seq
    events.selectStep()
    expect(events.selectedId).toBe('op')
    expect(events.stepId).toBeUndefined()
    expect(events.flyTo!.seq, 'the overview refits the whole event').toBeGreaterThan(seq)

    // and pressing it again, with nothing to step out of, still publishes nothing
    const settled = events.flyTo!.seq
    events.selectStep()
    expect(events.flyTo!.seq).toBe(settled)
  })

  it('draws the CONTEXT’s step, not the selected part’s own plan', () => {
    const events = store([{ ...part('battle', 'op'), drawing: op().drawing }])
    events.showOnMap('op')
    events.selectStep('june')
    events.select('battle')
    expect(texts(events)).toEqual(['June front', 'Army Group Centre'])
  })

  /* --- ENTRANCES: a step that is another item (docs/design/sagas.md) ------
     The whole of the recursion is that the step hands the reader to the
     existing focus machinery. So what these check is not new state — there is
     none — but that the descent is exactly the push "Show on map" already
     makes, and that the way back is the way back out of any other part. */
  describe('a step that descends into a child', () => {
    /** `op`, with one of its steps turned into an entrance to `battle`. */
    const saga = (): RawEvent[] => [
      op({
        steps: [
          steps[0],
          { id: 'into', name: 'Battle', at: 0.45, child: 'battle' },
          steps[2],
        ],
      }),
      { ...part('battle', 'op'), steps: [{ id: 'own', name: 'Own', at: 0 }] },
      part('village', 'battle'),
    ]
    const descend = () => {
      const events = useEventStore()
      events.adopt(saga())
      events.showOnMap('op')
      events.selectStep('into')
      return events
    }

    it('pushes the child onto the focus stack rather than opening a step', () => {
      const events = descend()
      expect(events.focusStack).toEqual(['op', 'battle'])
      expect(events.selectedId).toBe('battle')
      // it is a context now, not a step of the one above it
      expect(events.stepId).toBeUndefined()
      expect(events.focus?.itemId).toBe('battle')
    })

    it('hands the strip over to the child’s own steps', () => {
      const events = descend()
      expect(events.focusSteps.map((s) => s.id)).toEqual(['own'])
      // …and the child's parts are the pins, so the descent can continue
      expect(events.focusChildren.map((e) => e.id)).toEqual(['village'])
    })

    it('comes back out to the parent’s OVERVIEW, by the ordinary way back', () => {
      const events = descend()
      events.focusBack()
      expect(events.focusStack).toEqual(['op'])
      expect(events.selectedId).toBe('op')
      expect(events.stepId, 'came back into the step it left by').toBeUndefined()
      expect(texts(events)).toHaveLength(4) // the whole plan again
    })

    it('closes out of it one layer at a time, like any other part', () => {
      const events = descend()
      events.close()
      expect(events.focusStack).toEqual(['op'])
      events.close()
      expect(events.focusStack).toEqual([])
      expect(events.selectedId).toBeUndefined()
    })

    it('leaves the map on the child, not on the parent’s step', () => {
      const events = descend()
      expect(events.flyTo).toMatchObject(events.mapTarget('battle')!)
    })

    it('descends again from the child, up to the stack cap', () => {
      const events = descend()
      events.showOnMap('village')
      expect(events.focusStack).toEqual(['op', 'battle', 'village'])
      events.focusBack()
      events.focusBack()
      expect(events.focusStack).toEqual(['op'])
    })

    it('does nothing when the child has not loaded yet', () => {
      // chunks stream: a step may name an item this build has not merged. The
      // build script rejects a dangling id, so this can only be a timing gap,
      // and answering it by changing what is on the globe would be worse.
      const events = useEventStore()
      events.adopt([op({ steps: [{ id: 'into', name: 'Battle', at: 0.45, child: 'nowhere' }] })])
      events.showOnMap('op')
      events.selectStep('into')
      expect(events.focusStack).toEqual(['op'])
      expect(events.stepId).toBeUndefined()
    })
  })
})

/**
 * HIDDEN SUB-EVENTS: the regionally important parts that never make the global
 * cut still get pins, but only inside the thing they are part of.
 */
describe('focus pins the minor children', () => {
  const op = (id: string, extra: Partial<RawEvent> = {}): RawEvent => ({
    id, name: id, start: 1941, lat: 53.9, lng: 27.6, priority: 70, tags: ['war'], summary: '',
    drawing: { layers: [{ type: 'marker', pos: [27.6, 53.9] }] },
    ...extra,
  })
  /** Unranked: priority 0 is what `MINOR_PRIORITY` means (see lib/events.ts). */
  const minorPart = (id: string, parent: string): RawEvent => ({
    id, name: id, start: 1941, lat: 54, lng: 28, priority: 0, tags: ['war'], summary: '', parent,
  })

  const corpus = () => [
    op('barbarossa'),
    minorPart('brest-fortress', 'barbarossa'),
    minorPart('uman-pocket', 'barbarossa'),
    minorPart('tallinn-evacuation', 'barbarossa'),
  ]

  beforeEach(() => {
    setActivePinia(createPinia())
    useTimeStore().focusTime(1941)
  })

  it('leaves them off the ordinary globe, as the ranking list says', () => {
    const events = useEventStore()
    events.adopt(corpus())
    expect(events.visible.map((e) => e.id)).toEqual(['barbarossa'])
  })

  it('pins every one of them inside the focus, minor filter and all', () => {
    const events = useEventStore()
    events.adopt(corpus())
    events.showOnMap('barbarossa')
    expect(events.visible.map((e) => e.id).sort()).toEqual([
      'barbarossa', 'brest-fortress', 'tallinn-evacuation', 'uman-pocket',
    ])
    expect(events.focusChildren.map((e) => e.id).sort()).toEqual([
      'brest-fortress', 'tallinn-evacuation', 'uman-pocket',
    ])
  })

  it('pins them even when the reader has minor events switched off', () => {
    const events = useEventStore()
    const settings = useSettingsStore()
    settings.showMinorEvents = false
    events.adopt(corpus())
    events.showOnMap('barbarossa')
    expect(events.visible).toHaveLength(4)
  })

  /**
   * Tier 3 by construction (see `assignTiers`): a set of unranked pins must not
   * promote a fifth of itself, and inside a focus the minor children are the
   * background the focused item is read against.
   */
  it('tiers them as background, and the operation above them', () => {
    const events = useEventStore()
    events.adopt(corpus())
    events.showOnMap('barbarossa')
    const tiers = events.tiers
    expect(tiers.get('barbarossa')).toBe(1)
    for (const id of ['brest-fortress', 'uman-pocket', 'tallinn-evacuation'])
      expect(tiers.get(id), id).toBe(3)
  })

  it('still honours the cap when a family is larger than the globe can hold', () => {
    const events = useEventStore()
    events.adopt([
      op('barbarossa'),
      ...Array.from({ length: FOCUS_CHILD_CAP + 5 }, (_, i) =>
        minorPart(`part-${i}`, 'barbarossa'),
      ),
    ])
    events.showOnMap('barbarossa')
    expect(events.focusChildren).toHaveLength(FOCUS_CHILD_CAP)
  })
})
