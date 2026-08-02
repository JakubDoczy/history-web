<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useEventStore } from '../stores/events'
import { useTimeStore } from '../stores/time'
import { formatYear } from '../lib/time'
import { renderRichText } from '../lib/richtext'
import { isConcept, isEvent, isPerson, kindOf, type Item, type Place } from '../lib/events'
import { fetchWikiImage, wikiDebug, wikiRefForEvent, type WikiImage } from '../lib/wikiImage'

const events = useEventStore()
const time = useTimeStore()

/* The panel renders an ITEM, not only an event: an event, a life or an idea,
   with the same typography and the same link behaviour. What differs is the
   header (a date range, a lifespan with place chips, or nothing) and which
   sections have anything to show. */
const e = computed(() => events.selected!)
const person = computed(() => (isPerson(e.value) ? e.value : null))
const event = computed(() => (isEvent(e.value) ? e.value : null))
const kindLabel = computed(() => ({ event: '', person: 'Person', concept: 'Concept' })[kindOf(e.value)])

/** The line under the title: a span, a lifespan, or the year an idea is anchored at. */
const when = computed(() => {
  const p = person.value
  if (p) return p.died === undefined ? `b. ${formatYear(p.born)}` : `${formatYear(p.born)} – ${formatYear(p.died)}`
  if (isConcept(e.value)) return ''
  const ev = event.value!
  return ev.end ? `${formatYear(ev.start)} – ${formatYear(ev.end)}` : formatYear(ev.start)
})

/**
 * What "Show on map" is about. Normally the article itself; when the panel was
 * opened from a *derived* pin (a birth or a death, which are events in their own
 * right but carry the life's article), it is that pin — the reader is looking at
 * one end of a life and the map should go there, not to the other end.
 */
const mapId = computed(() => events.selectedId ?? e.value.id)
/**
 * Whether the action has anywhere to go. An event always has (its pin), a life
 * has the place it began, an idea has nothing — and the button is then simply
 * not there, rather than there and inert.
 */
const mappable = computed(() => !!events.mapTarget(mapId.value))

const children = computed(() => (event.value ? events.childrenOf(event.value.id) : []))
/** Everything this article links to, and everything that links back to it. */
const linked = computed(() => events.linkedTo(e.value.id))
const readMore = computed(() =>
  (e.value.related ?? []).map((id) => events.byId(id)).filter((i): i is Item => !!i),
)

const places = computed(() => {
  const p = person.value
  if (!p) return [] as { label: string; place: Place }[]
  const out: { label: string; place: Place }[] = []
  if (p.birthPlace) out.push({ label: p.birthPlace.label ?? 'Born here', place: p.birthPlace })
  if (p.deathPlace) out.push({ label: p.deathPlace.label ?? 'Died here', place: p.deathPlace })
  return out
})

function goTo(id: string) {
  const target = events.byId(id)
  if (!target) return
  events.select(id)
  const year = events.focusYear(id)
  if (year !== undefined) time.setTime(year)
}
function onBodyClick(ev: MouseEvent) {
  const id = (ev.target as HTMLElement).dataset?.event
  if (id) goTo(id)
}
function follow(link: { event?: string; url?: string }) {
  if (link.event) goTo(link.event)
  else if (link.url) window.open(link.url, '_blank')
}
/**
 * A birth or death place chip: put the globe over it and the timeline on the
 * year, so the map answers "where was this" without a search.
 */
function goToPlace(place: Place, year: number) {
  events.lookAt(place.lat, place.lng)
  time.setTime(year)
}

/* --- lead picture, fetched from Wikipedia when the event carries no image ---
   Nothing about the picture is stored in our data (see lib/wikiImage.ts); it is
   looked up from the article link the event already has, on open. */
const wikiImage = ref<WikiImage | null>(null)
const wikiShown = ref(false) // set on decode, so the fade only runs on a real picture
/**
 * A wider rendering of the thumbnail is a guess about Wikimedia's thumbnailer
 * (see lib/wikiImage.ts). When the guess 404s we drop to the URL the API
 * actually promised rather than to no picture at all.
 */
const wikiFellBack = ref(false)
const wikiSrc = computed(() =>
  wikiFellBack.value ? wikiImage.value?.fallbackUrl : wikiImage.value?.url,
)
let inflight: AbortController | null = null

function onImageError() {
  const img = wikiImage.value
  if (img?.fallbackUrl && !wikiFellBack.value) {
    wikiDebug('rendered thumbnail failed; falling back to the size the API gave', img.url)
    wikiFellBack.value = true
    return
  }
  wikiDebug('picture failed to load', wikiSrc.value)
  wikiImage.value = null
}

/** A picture already in the browser cache can be complete before `load` binds. */
function onImageMounted(el: Element) {
  const img = el as HTMLImageElement
  if (img.complete && img.naturalWidth > 0) wikiShown.value = true
}

/** Roughly the panel's content width, in device pixels. */
function targetWidth() {
  const css = Math.min(370, (globalThis.innerWidth || 370) - 32) - 40
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2) // 2x is the useful ceiling here
  return Math.round(Math.max(css, 200) * dpr)
}

watch(
  () => events.selected?.id,
  async (id) => {
    inflight?.abort() // rapid event → event navigation: the stale request goes
    inflight = null
    wikiImage.value = null
    wikiShown.value = false
    wikiFellBack.value = false

    const ev = events.selected
    if (!id || !ev || ev.image) return // an explicit image in the data always wins
    const ref = wikiRefForEvent(ev)
    if (!ref) {
      wikiDebug('item carries no Wikipedia article link', id)
      return
    }

    const ctl = new AbortController()
    inflight = ctl
    const img = await fetchWikiImage(ref, { targetWidth: targetWidth(), signal: ctl.signal })
    // The store may have moved on while this was in flight (a cache hit resolves
    // in a microtask, so even that needs the guard).
    if (ctl.signal.aborted || events.selected?.id !== id) return
    wikiImage.value = img
  },
  { immediate: true },
)

onBeforeUnmount(() => inflight?.abort())
</script>

<template>
  <article v-if="events.selected" class="sheet panel scroll-y">
    <span class="grabber" aria-hidden="true" />
    <button class="close" aria-label="Close" @click="events.select()">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
      >
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>

    <nav v-if="event?.parent" class="crumb">
      <a @click="goTo(event!.parent!)">{{ events.byId(event!.parent!)?.name }}</a>
    </nav>

    <h2>{{ e.name }}</h2>
    <p class="when tnum">
      <span v-if="kindLabel" class="kind">{{ kindLabel }}</span>
      <span v-if="when">{{ when }}</span>
      <!-- The one action that makes the article's subject *visible*: it selects
           the item, brings the timeline onto it and flies the camera to fit its
           whole geometry — a point, a footprint, or a route across an ocean. -->
      <button v-if="mappable" class="show-on-map" data-test="show-on-map" @click="events.showOnMap(mapId)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z" />
          <path d="M9 4v13M15 7v13" />
        </svg>
        Show on map
      </button>
    </p>

    <!-- a life's two fixed points, as buttons: they move the globe and the clock -->
    <p v-if="places.length" class="places">
      <button
        v-for="(p, i) in places"
        :key="p.label"
        data-test="place-chip"
        @click="goToPlace(p.place, i === 0 ? person!.born : (person!.died ?? person!.born))"
      >
        {{ i === 0 ? 'Born' : 'Died' }} · {{ p.label }}
      </button>
    </p>

    <figure v-if="e.image">
      <img
        loading="lazy"
        :src="e.image.url"
        :alt="e.image.caption ?? e.name"
        @error="($event.target as HTMLElement).parentElement!.style.display = 'none'"
      />
      <figcaption v-if="e.image.caption">{{ e.image.caption }}</figcaption>
    </figure>

    <figure v-else-if="wikiImage" class="wiki" :class="{ shown: wikiShown }" data-test="wiki-figure">
      <img
        loading="lazy"
        decoding="async"
        :src="wikiSrc"
        :width="wikiImage.width"
        :height="wikiImage.height"
        :alt="wikiImage.caption ?? e.name"
        @load="wikiShown = true"
        @error="onImageError"
        @vue:mounted="onImageMounted($event.el as Element)"
      />
      <figcaption>
        <span v-if="wikiImage.caption">{{ wikiImage.caption }} · </span>
        <a :href="wikiImage.pageUrl" target="_blank" rel="noopener">Wikipedia</a>
      </figcaption>
    </figure>

    <div v-if="e.body" class="body" @click="onBodyClick" v-html="renderRichText(e.body)" />
    <p v-else class="body">
      <span>{{ e.summary }}</span>
    </p>

    <div v-if="children.length" class="block">
      <span class="eyebrow">Part of this event</span>
      <ul>
        <li v-for="c in children" :key="c.id">
          <a @click="goTo(c.id)">{{ c.name }}</a>
          <span class="year tnum">{{ formatYear(c.start) }}</span>
        </li>
      </ul>
    </div>

    <!-- The article's neighbourhood, assembled rather than hand-listed: what this
         body links to, and what links back at it. -->
    <div v-if="linked.length" class="block" data-test="linked">
      <span class="eyebrow">Linked</span>
      <ul>
        <li v-for="l in linked" :key="l.id">
          <a @click="goTo(l.id)">{{ l.name }}</a>
          <span class="year tnum">{{ kindOf(l) === 'event' ? formatYear(events.focusYear(l.id) ?? 0) : kindOf(l) }}</span>
        </li>
      </ul>
    </div>

    <div v-if="e.links?.length || readMore.length" class="block">
      <span class="eyebrow">Read more</span>
      <p class="links">
        <a v-for="r in readMore" :key="r.id" @click.prevent="goTo(r.id)">{{ r.name }}</a>
        <a v-for="l in e.links" :key="l.label" @click.prevent="follow(l)">{{ l.label }}</a>
      </p>
    </div>

    <div class="tags">
      <button v-for="t in e.tags" :key="t" @click="events.toggleTag(t)">
        {{ t }}
      </button>
    </div>

    <button
      v-if="event && (event.parent || children.length)"
      class="family"
      @click="events.setParentFilter(event.parent ?? event.id)"
    >
      Show only this event family
    </button>
  </article>
</template>

<style scoped>
.panel {
  position: absolute;
  top: calc(58px + var(--safe-t));
  left: calc(var(--s4) + var(--safe-l));
  width: min(370px, calc(100vw - 2 * var(--s4)));
  max-height: calc(100dvh - var(--rail-clear) - 78px - var(--safe-t));
  padding: var(--s5) var(--s5) var(--s5);
  z-index: var(--z-event-panel);
  animation: panel-in 0.26s var(--ease);
}
@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.99);
  }
}
.grabber {
  display: none;
}

.close {
  position: absolute;
  top: var(--s3);
  right: var(--s3);
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  color: var(--muted);
  cursor: pointer;
  transition:
    color var(--fast),
    background-color var(--fast),
    border-color var(--fast);
}
.close:hover {
  color: var(--frost);
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--line);
}
.close:active {
  transform: scale(0.94);
}

.crumb {
  margin-bottom: var(--s1);
  font-size: var(--t-sm);
}
.crumb a::before {
  content: '↑';
  margin-right: 5px;
  opacity: 0.7;
}

h2 {
  margin: 0;
  font-family: var(--serif);
  font-weight: 600;
  font-size: var(--t-title);
  line-height: 1.24;
  letter-spacing: -0.005em;
  padding-right: var(--s5);
  text-wrap: balance;
}
.when {
  margin: 6px 0 0;
  font-family: var(--cond);
  font-size: var(--t-sm);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--brass);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s2);
}
/* what kind of article this is — quiet, since most of them are events */
.kind {
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  padding: 1px 8px;
  font-size: var(--t-xs);
  color: var(--muted);
  letter-spacing: 0.1em;
}

/* "Show on map" rides in the date line, styled as a chip like the tag buttons
   and the place chips: it is an action *about* this item, not a section of it.
   Brass, because it is the only one there that moves the globe. */
.show-on-map {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: transparent;
  border: 1px solid var(--brass-line);
  border-radius: var(--r-pill);
  color: var(--brass);
  padding: 3px 10px;
  cursor: pointer;
  transition:
    color var(--fast),
    border-color var(--fast),
    background-color var(--fast);
}
.show-on-map:hover {
  background: var(--brass-soft);
  color: #f2dcae;
}
.show-on-map:active {
  transform: scale(0.96);
}
.show-on-map svg {
  opacity: 0.85;
}

/* a life's birth and death places: chips that fly the globe there */
.places {
  margin: var(--s3) 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.places button {
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.06em;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  color: var(--frost-dim, var(--muted));
  padding: 4px 11px;
  cursor: pointer;
  transition:
    color var(--fast),
    border-color var(--fast),
    background-color var(--fast);
}
.places button:hover {
  color: var(--patina);
  border-color: var(--patina-line);
  background: rgba(255, 255, 255, 0.04);
}
.places button:active {
  transform: scale(0.96);
}

figure {
  margin: var(--s4) 0 0;
}
img {
  width: 100%;
  /* the intrinsic width/height attributes are presentational hints; without this
     the height hint survives `width: 100%` and squashes the picture */
  height: auto;
  border-radius: var(--r-md);
  display: block;
  border: 1px solid var(--line-soft);
  background: rgba(255, 255, 255, 0.03);
}
/* The Wikipedia picture arrives after the panel is already on screen: it fades in
   once decoded, and its intrinsic size is on the element, so the bitmap landing
   does not move the article a second time. The global
   prefers-reduced-motion rule in tokens.css turns the fade off. */
figure.wiki {
  opacity: 0;
  transition: opacity var(--slow);
}
figure.wiki.shown {
  opacity: 1;
}
figcaption {
  margin-top: 7px;
  font-size: var(--t-xs);
  line-height: 1.45;
  color: var(--muted);
  font-style: italic;
}

/* --- the article itself: set for reading, not for filling a box --- */
.body {
  margin-top: var(--s4);
  font-family: var(--serif);
  font-size: 15px;
  line-height: 1.68;
  color: #dbe4f1;
  max-width: 68ch;
  hyphens: auto;
}
.body :deep(p) {
  margin: 0 0 0.9em;
}
.body :deep(p:last-child) {
  margin-bottom: 0;
}
.body :deep(strong) {
  color: #f0f5fb;
  font-weight: 600;
}
.body :deep(em) {
  color: #e7eef8;
}
.body :deep(h3),
.body :deep(h4) {
  margin: 1.4em 0 0.4em;
  font-family: var(--cond);
  font-size: var(--t-sm);
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--frost);
}
.body :deep(ul),
.body :deep(ol) {
  margin: 0 0 0.9em;
  padding-left: 1.15em;
}
.body :deep(li) {
  display: list-item;
  margin-bottom: 0.3em;
}
.body :deep(blockquote) {
  margin: 0 0 0.9em;
  padding-left: var(--s3);
  border-left: 2px solid var(--line);
  color: var(--frost-dim);
  font-style: italic;
}
.body :deep(img) {
  width: 100%;
  border-radius: var(--r-md);
  display: block;
  margin: var(--s3) 0;
}
.body :deep(code) {
  font-size: 0.9em;
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 4px;
}

/* one link treatment everywhere in the panel */
a,
.body :deep(a) {
  color: var(--patina);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: var(--patina-line);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  transition:
    color var(--fast),
    text-decoration-color var(--fast);
}
a:hover,
.body :deep(a:hover) {
  color: #a5dcd2;
  text-decoration-color: currentColor;
}

.block {
  margin-top: var(--s5);
  padding-top: var(--s4);
  border-top: 1px solid var(--line-soft);
  display: grid;
  gap: var(--s2);
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
}
.block li {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--s3);
  font-size: var(--t-md);
  padding: 3px 0;
}
.year {
  color: var(--muted);
  font-family: var(--cond);
  font-size: var(--t-xs);
  flex: none;
}
.links {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--s1) var(--s4);
  font-size: var(--t-md);
}
.links a {
  margin-right: 0;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: var(--s4);
}
.tags button {
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  color: var(--muted);
  padding: 3px 11px;
  cursor: pointer;
  transition:
    color var(--fast),
    border-color var(--fast),
    background-color var(--fast);
}
.tags button:hover {
  color: var(--brass);
  border-color: var(--brass-line);
  background: var(--brass-soft);
}
.tags button:active {
  transform: scale(0.96);
}

.family {
  margin-top: var(--s3);
  width: 100%;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  color: var(--frost);
  padding: 9px;
  font-size: var(--t-sm);
  cursor: pointer;
  transition:
    border-color var(--fast),
    color var(--fast),
    background-color var(--fast);
}
.family:hover {
  border-color: var(--brass-line);
  color: var(--brass);
  background: var(--brass-soft);
}
.family:active {
  transform: scale(0.995);
}

@media (max-width: 640px) {
  /* a bottom sheet, sitting just clear of the timeline */
  .panel {
    top: auto;
    bottom: calc(var(--rail-clear) + var(--s2));
    left: calc(var(--s3) + var(--safe-l));
    right: calc(var(--s3) + var(--safe-r));
    width: auto;
    max-height: 56dvh;
    padding: var(--s5) var(--s4) var(--s4);
    animation-name: sheet-in;
  }
  @keyframes sheet-in {
    from {
      opacity: 0;
      transform: translateY(18px);
    }
  }
  /* a sheet handle, so the panel reads as a surface you can dismiss */
  .grabber {
    display: block;
    position: sticky;
    top: -4px;
    width: 34px;
    height: 3px;
    margin: -10px auto 10px;
    border-radius: var(--r-pill);
    background: var(--line);
  }
  .close {
    top: var(--s2);
    right: var(--s2);
    width: 40px;
    height: 40px;
  }
  h2 {
    padding-right: 40px;
  }
  .body {
    font-size: 15.5px;
  }
  .tags button {
    min-height: 40px;
    box-sizing: border-box;
    padding: 7px 14px;
  }
  .show-on-map {
    min-height: 36px;
    box-sizing: border-box;
    padding: 6px 12px;
  }
  .block li {
    min-height: 40px;
    box-sizing: border-box;
    align-items: center;
    padding: 6px 0;
  }
  .family {
    min-height: 44px;
  }
}
</style>
