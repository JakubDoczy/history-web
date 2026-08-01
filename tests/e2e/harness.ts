/**
 * A page that mounts EventPanel alone, with a hand-seeded event store.
 *
 * The real app cannot serve this purpose in a sandbox: it boots the globe (WebGL,
 * three.js) and streams event chunks and imagery over a network this box does not
 * have. The panel is what the Wikipedia picture lives in, so the panel is what is
 * mounted — everything it touches (events store, time store) is local state.
 *
 * Dev-server only; it is outside `index.html`'s graph and never built.
 */
import '../../src/styles/tokens.css'
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import EventPanel from '../../src/components/EventPanel.vue'
import { useEventStore } from '../../src/stores/events'
import { clearWikiImageCache } from '../../src/lib/wikiImage'
import type { HistoricalEvent } from '../../src/lib/events'

/**
 * Served by the dev server from this directory, not by a Playwright route: any
 * route interception at all changes how Chromium handles CORS, and this spec is
 * partly about CORS.
 */
const OWN_IMAGE = new URL('./fixtures/own-image.png', import.meta.url).pathname

const EVENTS: HistoricalEvent[] = [
  {
    id: 'gobekli-tepe',
    name: 'Göbekli Tepe',
    start: -9499,
    end: -8000,
    lat: 37.22,
    lng: 38.92,
    priority: 72,
    tags: ['religion', 'culture'],
    summary: 'Hunter-gatherers raised monumental carved pillars in southeastern Anatolia.',
    body: 'Circles of T-shaped limestone pillars up to 5.5 m tall are decorated with foxes, snakes and vultures.\n\nMore at [Wikipedia](https://en.wikipedia.org/wiki/Göbekli_Tepe).',
    links: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Göbekli_Tepe' }],
  },
  {
    id: 'jericho',
    name: 'Walls of Jericho',
    start: -9000,
    end: -8000,
    lat: 31.87,
    lng: 35.44,
    priority: 56,
    tags: ['culture'],
    summary: "One of the world's oldest continuously occupied settlements built a stone wall and tower.",
    body: 'A stone wall and tower.\n\nMore at [Wikipedia](https://en.wikipedia.org/wiki/Jericho).',
    links: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Jericho' }],
  },
  {
    // the article 404s in the mock — the panel must fall back to no picture
    id: 'missing',
    name: 'Article that is not there',
    start: -500,
    lat: 0,
    lng: 0,
    priority: 10,
    tags: ['culture'],
    summary: 'The summary endpoint answers 404 for this one.',
    body: 'More at [Wikipedia](https://en.wikipedia.org/wiki/Definitely_Not_A_Page).',
    links: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Definitely_Not_A_Page' }],
  },
  {
    // the request fails at the transport level
    id: 'offline',
    name: 'Article the network refuses',
    start: -400,
    lat: 0,
    lng: 0,
    priority: 10,
    tags: ['culture'],
    summary: 'The request is aborted by the network.',
    body: 'More at [Wikipedia](https://en.wikipedia.org/wiki/Network_Failure_Page).',
    links: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Network_Failure_Page' }],
  },
  {
    // already illustrated by our own data: no Wikipedia lookup, no second picture
    id: 'has-image',
    name: 'Event with its own picture',
    start: 1969,
    lat: 28.5,
    lng: -80.6,
    priority: 90,
    tags: ['exploration'],
    summary: 'Carries an explicit image in the dataset.',
    image: { url: OWN_IMAGE, caption: 'Our own picture' },
    body: 'More at [Wikipedia](https://en.wikipedia.org/wiki/Apollo_11).',
    links: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Apollo_11' }],
  },
  {
    // the article link is a Wikipedia *redirect*: the summary endpoint answers
    // 302 and the browser has to follow it to the target. A third of this
    // dataset's links are redirects, and a pre-flighted request cannot follow one.
    id: 'redirected',
    name: 'Roman aqueducts',
    start: -312,
    lat: 43.95,
    lng: 4.53,
    priority: 60,
    tags: ['technology'],
    summary: 'Rome piped water into its cities across engineered channels.',
    body: 'More at [Wikipedia](https://en.wikipedia.org/wiki/Aqueduct_(Roman)).',
    links: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Aqueduct_(Roman)' }],
  },
  {
    // a real article whose summary carries no thumbnail at all
    id: 'no-picture',
    name: 'HIV/AIDS identified',
    start: 1981,
    lat: 34.05,
    lng: -118.24,
    priority: 70,
    tags: ['biology'],
    summary: 'A new immune-deficiency syndrome was reported in Los Angeles.',
    body: 'More at [Wikipedia](https://en.wikipedia.org/wiki/HIV/AIDS).',
    links: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/HIV/AIDS' }],
  },
  {
    // the lead image is an SVG: the thumbnail is a PNG rendering of it
    id: 'svg-lead',
    name: 'United Nations founded',
    start: 1945,
    lat: 37.78,
    lng: -122.42,
    priority: 80,
    tags: ['politics'],
    summary: 'Fifty-one states signed the Charter in San Francisco.',
    body: 'More at [Wikipedia](https://en.wikipedia.org/wiki/United_Nations).',
    links: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/United_Nations' }],
  },
  {
    // no Wikipedia link anywhere: nothing to look up
    id: 'no-link',
    name: 'Event with no article',
    start: 1200,
    lat: 10,
    lng: 10,
    priority: 20,
    tags: ['culture'],
    summary: 'Nothing to look up.',
    body: 'Plain prose with an [internal link](event:jericho) only.',
  },
]

const pinia = createPinia()
const app = createApp({ render: () => h(EventPanel) })
app.use(pinia)
app.mount('#app')

const store = useEventStore(pinia)
store.adopt(EVENTS)

// Driven from the Playwright spec.
Object.assign(window as unknown as Record<string, unknown>, {
  panelHarness: {
    select: (id?: string) => store.select(id),
    clearCache: () => clearWikiImageCache(),
    events: EVENTS.map((e) => e.id),
  },
})

const initial = new URLSearchParams(location.search).get('event')
if (initial) store.select(initial)
