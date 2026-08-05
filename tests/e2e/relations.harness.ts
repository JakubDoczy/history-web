/**
 * EventPanel over the REAL corpus, for checking the relation sections in a
 * browser.
 *
 * The app itself cannot serve this in a sandbox — it boots the globe (WebGL,
 * three.js) and streams imagery over a network this box does not have — but the
 * relation rework is entirely panel and store, and both run here against the
 * shipped chunk files rather than a fixture. That is the point: the sections
 * are only interesting if the data behind them is the data that ships.
 *
 * Dev-server only; outside index.html's graph and never built.
 */
import '../../src/styles/tokens.css'
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import EventPanel from '../../src/components/EventPanel.vue'
import { useEventStore } from '../../src/stores/events'
import { useTimeStore } from '../../src/stores/time'
import type { RawItem } from '../../src/lib/events'
import type { EventManifest } from '../../src/lib/eventChunks'

const pinia = createPinia()
const app = createApp({ render: () => h(EventPanel) })
app.use(pinia)
app.mount('#app')

const store = useEventStore(pinia)
const time = useTimeStore(pinia)

// the dev server mounts `public/` under vite's base (see vite.config.ts)
const DATA = `${import.meta.env.BASE_URL}data/events/`
const manifest: EventManifest = await (await fetch(DATA + 'manifest.json')).json()
for (const c of manifest.chunks) store.adopt((await (await fetch(DATA + c.file)).json()) as RawItem[])

Object.assign(window as unknown as Record<string, unknown>, {
  relHarness: {
    ready: true,
    select: (id?: string) => {
      const year = id && store.focusYear(id)
      if (year !== undefined && year !== false) time.focusTime(year)
      store.select(id)
    },
    showOnMap: (id: string) => store.showOnMap(id),
    exitFocus: () => store.exitFocus(),
    expand: () => store.toggleFocusExpanded(),
    /** What the globe would pin: the focus mode extra pins, by id. */
    focusChildren: () => store.focusChildren.map((e) => e.id),
    visible: () => store.visible.map((e) => e.id),
    relations: (id: string) => ({
      partOf: store.parentChainOf(id).map((i) => i.id),
      contains: store.childrenOf(id).map((i) => i.id),
      strong: store.strongOf(id).map((i) => i.id),
      seeAlso: store.seeAlsoOf(id).map((i) => i.id),
    }),
    selected: () => store.selected?.id,
  },
})
