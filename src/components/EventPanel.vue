<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useEventStore } from '../stores/events'
import { useTimeStore } from '../stores/time'
import { formatTime, formatYear } from '../lib/time'
import { renderRichText } from '../lib/richtext'
import { anchorYearOf, assertNever, featureOf, timeOf, type Item, type Place } from '../lib/events'
import { fetchWikiImage, wikiDebug, wikiRefForEvent, type WikiImage } from '../lib/wikiImage'
import StepStrip from './StepStrip.vue'

const events = useEventStore()
const time = useTimeStore()

/* The panel renders an ITEM, not only an event: an event, a life or an idea,
   with the same typography and the same link behaviour. What differs is the
   header (a date range, a lifespan with place chips, or nothing) and which
   sections have anything to show. */
const e = computed(() => events.selected!)
/* The two variants the template asks for by name. Narrowed on the discriminant
   and handed to the template as a nullable, because a template cannot narrow. */
const person = computed(() => (e.value.kind === 'person' ? e.value : null))
const event = computed(() => (e.value.kind === 'event' ? e.value : null))
const kindLabel = computed(() => ({ event: '', person: 'Person', concept: 'Concept' })[e.value.kind])
/**
 * The pill's chip. The article can leave the chip off an event — most items are
 * events and the word adds nothing next to a date — but the pill has no date and
 * no body, so something has to say what kind of thing this is.
 *
 * An event says what SHAPE it is instead, which is the most useful thing a pill
 * can say about one: a plan beats a route beats a bare point.
 */
const pillKind = computed(() => {
  const ev = event.value
  if (!ev) return kindLabel.value
  if (ev.drawing) return 'Plan'
  return featureOf(ev.location, 'line') ? 'Route' : 'Event'
})

/** The line under the title: a span, a lifespan, or the year an idea is anchored at. */
const when = computed(() => {
  const i = e.value
  switch (i.kind) {
    case 'person':
      return i.died === undefined
        ? `b. ${formatYear(i.born)}`
        : `${formatYear(i.born)} – ${formatYear(i.died)}`
    case 'event':
      // One fold over the variant, rather than a truthy test on an optional
      // `end` — which read an event dated to the year 0 as a point by accident.
      return formatTime(timeOf(i))
    case 'concept':
      return ''
    default:
      return assertNever(i)
  }
})

/**
 * What "Show on map" is about. Normally the article itself; when the panel was
 * opened from a *life marker* (a birth or a death, which are pins in their own
 * right but carry the life's article), it is that pin — the reader is looking at
 * one end of a life and the map should go there, not to the other end.
 */
const mapId = computed(() => events.selectedId ?? events.selected?.id ?? '')
/**
 * Whether the action has anywhere to go. An event always has (its pin), a life
 * has the place it began, an idea has nothing — and the button is then simply
 * not there, rather than there and inert.
 */
const mappable = computed(() => !!events.mapTarget(mapId.value))

/* --- the four relation sections, in precedence order ----------------------
   `parent` / `strong` / `weak` in the data, materialised both ways by the
   index (see `buildRelations` in lib/events.ts). The store has already made
   them disjoint, so an item shown under one heading is never shown under
   another — which is the whole reason the sections can be read as a hierarchy
   of closeness rather than as four overlapping lists. */
/** What this is part of, innermost first — its parent, then the parent's parent. */
const partOf = computed(() => events.parentChainOf(e.value.id))
/** What it contains: direct children, chronological. */
const children = computed(() => events.childrenOf(e.value.id))
/** Its defining associations. */
const related = computed(() => events.strongOf(e.value.id))
/** The softer ones, with the article's prose links folded in behind them. */
const seeAlso = computed(() => events.seeAlsoOf(e.value.id))

/**
 * The STAGE PAGE the article is showing, if any — the authored text of the step
 * the reader has stepped into (see `selectStep` in stores/events.ts).
 *
 * Only on the focused event's OWN article. Opening a battle inside a stepped
 * operation swaps the panel to the battle, and the battle's article is about
 * the battle: it must not be overwritten by the text of a step of its parent,
 * even though that step is still what the map is filtered to.
 */
const stepPage = computed(() => {
  const step = events.activeStep
  if (!step?.page) return null
  return events.selectedId === events.focus?.itemId ? step : null
})

/** Persons and concepts are chipped; an event is the unmarked case (as in search). */
const badge = (i: Item) => (i.kind === 'event' ? '' : i.kind)
const yearOf = (id: string) => formatYear(events.focusYear(id) ?? 0)

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
  <!-- WHETHER there is a panel is decided out here, by an ordinary v-if with no
       transition on it, and only the SHAPE of it is transitioned inside.
       That split is a bug fix, not tidiness. This used to be one
       `<Transition mode="out-in">` over a three-way chain — pill, article, and
       *nothing* — and out-in holds the incoming element back until the outgoing
       one's leave resolves. Land on the "nothing" branch while a swap is in
       flight (close the panel within the 0.24 s fold, or on any frame the
       browser is too busy to run — this app is a WebGL globe, so that is a
       normal frame) and the leave never lands: the old panel stayed welded into
       the DOM, still clickable, describing an event the store had already let
       go. Nothing on screen answered to the state any more, so nothing could
       close it — not the X, not Escape, not picking another era. It was the
       reported stuck state.
       Now closing removes the host synchronously, and the inner swap only ever
       chooses between two elements that both exist. -->
  <div v-if="events.selected" class="panel-host">
    <!-- The authored steps of the focused event, above the pill's row. Outside
         the swap below on purpose: it belongs to the FOCUS, not to whichever
         shape the panel is in, and it must not fold away with the article. -->
    <StepStrip />
    <!-- Two shapes of the same panel. The article is the default; the pill is
         what focus mode leaves behind so the map is unobstructed (see
         `focusStack` in stores/events.ts). `mode="out-in"` because they are not
         two states of one box — they are different sizes in different corners,
         and crossfading them in place reads as a glitch rather than as a fold. -->
    <Transition name="panel-swap" mode="out-in">
      <div v-if="events.panelMinimised" key="pill" class="sheet pill" data-test="panel-pill">
        <!-- Inside a focus, on one of its parts: the way back to the thing that
             put this battle on the globe (see `focusReturnTo`). -->
        <button
          v-if="events.focusReturnTo"
          class="pill-back"
          data-test="focus-back"
          :title="`Back to ${events.focusReturnTo.name}`"
          @click="events.focusBack()"
        >
          <span aria-hidden="true">←</span>
          <span class="pill-back-name">{{ events.focusReturnTo.name }}</span>
        </button>
        <button class="pill-main" data-test="pill-expand" @click="events.toggleFocusExpanded()">
          <span class="pill-name">{{ e.name }}</span>
          <span class="pill-kind">{{ pillKind }}</span>
        </button>
        <button class="pill-btn" aria-label="Expand article" @click="events.toggleFocusExpanded()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 15l6-6 6 6" />
          </svg>
        </button>
        <button class="pill-btn" data-test="pill-close" aria-label="Close" @click="events.close()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <!-- `has-minimise` is how the title knows how much of its own line the
           corner buttons have taken: one of them normally, two in focus mode. -->
      <article
        v-else
        key="article"
        class="sheet panel scroll-y"
        :class="{ 'has-minimise': events.focus, 'has-strip': events.focusSteps.length }"
      >
    <span class="grabber" aria-hidden="true" />
    <!-- In focus mode the article can fold back down to the pill without
         leaving the mode: the drawing stays, the pins stay, the reading stops. -->
    <button
      v-if="events.focus"
      class="close minimise"
      data-test="panel-minimise"
      aria-label="Minimise"
      @click="events.toggleFocusExpanded()"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
    <button class="close" aria-label="Close" data-test="panel-close" @click="events.close()">
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

    <!-- The one breadcrumb there is, and only inside a focus: the reader is
         looking at a battle *because* an operation is on the globe underneath
         it, and this says so and takes them back (see `focusReturnTo`). "Part
         of" below still carries the whole chain; this is about where the map
         is, not about where the article sits in the hierarchy. -->
    <button
      v-if="events.focusReturnTo"
      class="back"
      data-test="focus-back"
      @click="events.focusBack()"
    >
      <span aria-hidden="true">←</span>
      <span class="back-name">{{ events.focusReturnTo.name }}</span>
    </button>
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

    <!-- ONE STAGE, INSTEAD OF THE WHOLE ARTICLE.
         A step page is a page, not a section appended to one: the reader
         stepped into a moment of the operation and the panel is what tells them
         about that moment, so the lead picture, the body and the four relation
         lists all step aside. The way back is the first thing in it and says
         where it goes, because there is no other affordance in the panel that
         means "the whole thing again" — the strip's own Overview chip is
         outside this box, over the map. -->
    <section v-if="stepPage" class="step-page" data-test="step-page">
      <button class="back" data-test="step-back" @click="events.selectStep()">
        <span aria-hidden="true">←</span>
        <span class="back-name">Overview</span>
      </button>
      <h3>{{ stepPage.name }}</h3>
      <div class="body" @click="onBodyClick" v-html="renderRichText(stepPage.page!)" />
    </section>

    <template v-else>
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

    <!-- The relation sections, widest first: what contains this, what it
         contains, what it is bound to, what merely rhymes with it. -->
    <div v-if="partOf.length" class="block" data-test="part-of">
      <span class="eyebrow">Part of</span>
      <ul>
        <li v-for="p in partOf" :key="p.id">
          <a @click="goTo(p.id)">{{ p.name }}</a>
          <span class="year tnum">{{ formatYear(anchorYearOf(p)) }}</span>
        </li>
      </ul>
    </div>

    <div v-if="children.length" class="block" data-test="contains">
      <span class="eyebrow">Contains</span>
      <ul>
        <li v-for="c in children" :key="c.id">
          <a @click="goTo(c.id)">{{ c.name }}</a>
          <span class="year tnum">{{ formatYear(anchorYearOf(c)) }}</span>
        </li>
      </ul>
    </div>

    <div v-if="related.length" class="block" data-test="related">
      <span class="eyebrow">Related</span>
      <ul>
        <li v-for="r in related" :key="r.id">
          <a @click="goTo(r.id)">{{ r.name }}</a>
          <span v-if="badge(r)" class="kind">{{ badge(r) }}</span>
          <span class="year tnum">{{ yearOf(r.id) }}</span>
        </li>
      </ul>
    </div>

    <div v-if="seeAlso.length" class="block" data-test="see-also">
      <span class="eyebrow">See also</span>
      <ul>
        <li v-for="l in seeAlso" :key="l.id">
          <a @click="goTo(l.id)">{{ l.name }}</a>
          <span v-if="badge(l)" class="kind">{{ badge(l) }}</span>
          <span class="year tnum">{{ yearOf(l.id) }}</span>
        </li>
      </ul>
    </div>

    <!-- Outward references only. Anything pointing at another item in this
         corpus is a relation, and belongs in the sections above. -->
    <div v-if="e.links?.length" class="block">
      <span class="eyebrow">Read more</span>
      <p class="links">
        <a v-for="l in e.links" :key="l.label" :href="l.url" target="_blank" rel="noopener">
          {{ l.label }}
        </a>
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
    </template>
      </article>
    </Transition>
  </div>
</template>

<style scoped>
/* The host exists to hold the v-if, not to lay anything out: `display: contents`
   keeps it from generating a box, so the pill and the article go on resolving
   their `position: absolute` against the same containing block they always did. */
.panel-host {
  display: contents;
}

/* The article. It is the thing being read, so it gets the room: as wide as a
   comfortable measure allows, as tall as the two bars leave, and starting as
   close to its own top edge as the close buttons permit.
   `top` clears the title bar (50px of it) by 4px rather than by 12; the bottom
   clears the timeline by 12 rather than by 20; and the top padding is --s3
   rather than --s5, which is the dead band the title used to float in. */
.panel {
  position: absolute;
  top: calc(54px + var(--safe-t));
  left: calc(var(--s4) + var(--safe-l));
  width: min(400px, calc(100vw - 2 * var(--s4)));
  max-height: calc(100dvh - var(--rail-clear) - 66px - var(--safe-t));
  padding: var(--s3) var(--s5) var(--s5);
  z-index: var(--z-event-panel);
  animation: panel-in var(--slow);
}
/* A stepped event's article stops short of the corner the step strip is in.
   Without this a long step page reaches the bottom of the screen and paints
   over the one control that steps to the next step — on a phone that is the
   whole strip, and the reader would have to close the page to see it again.
   The band reserved is exactly the pill's row plus the strip's (tokens.css). */
.panel.has-strip {
  max-height: calc(100dvh - 66px - var(--safe-t) - var(--strip-clear) - var(--s1));
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

/* --- focus mode: the panel folded down to a bar ---------------------------
   Docked bottom-left, just clear of the timeline, so the map above it — which
   is the whole reason the panel got out of the way — is uninterrupted. It is a
   row of three targets: the name (expands), a chevron (expands), an X (closes,
   which also leaves the mode).

   Sized one notch below the article's own scale — a caption, not a headline.
   The pill is a label on a map the reader is looking *past* it at, so every
   dimension here is the panel's minus a step: the type is --t-md rather than
   --t-lg, the chip is eyebrow-sized, the buttons are 26px rather than 30. */
.pill {
  position: absolute;
  left: calc(var(--s4) + var(--safe-l));
  bottom: calc(var(--rail-clear) + var(--s2));
  z-index: var(--z-event-panel);
  display: flex;
  align-items: center;
  gap: var(--s1);
  /* Wider than the article's own pill used to be, because inside a focus it
     carries two names: the part being read and the whole it is part of. The
     back chip is capped below, so the extra room goes to the item's own name. */
  max-width: min(470px, calc(100vw - 2 * var(--s4)));
  padding: 3px 5px 3px var(--s2);
  border-radius: var(--r-pill);
  /* The step strip stacks on this without measuring it — see --pill-h. */
  min-height: var(--pill-h);
  box-sizing: border-box;
}
/* The way out of a part and back to the whole, on the pill: an arrow and the
   name of the context, kept to a third of the bar so the item the pill is
   actually about still reads first. It is the same control as `.back` in the
   article — one gesture, drawn twice at the two scales the panel comes in. */
.pill-back {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 140px;
  min-width: 0;
  padding: 4px 8px 4px 4px;
  margin-right: 2px;
  border: 0;
  border-right: 1px solid var(--line);
  border-radius: var(--r-pill) 0 0 var(--r-pill);
  background: none;
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.06em;
  color: var(--muted);
  cursor: pointer;
  transition: color var(--fast);
}
.pill-back:hover {
  color: var(--patina);
}
.pill-back-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pill-main {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  background: none;
  border: none;
  padding: 4px 2px;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.pill-name {
  font-family: var(--serif);
  font-size: var(--t-md);
  font-weight: 600;
  color: var(--frost);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color var(--fast);
}
.pill-main:hover .pill-name {
  color: #f0f5fb;
}
.pill-kind {
  flex: none;
  border: 1px solid var(--brass-line);
  border-radius: var(--r-pill);
  padding: 1px 7px;
  font-family: var(--cond);
  font-size: var(--t-eyebrow);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--brass);
}
.pill-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  color: var(--muted);
  cursor: pointer;
  transition:
    color var(--fast),
    background-color var(--fast),
    border-color var(--fast);
}
.pill-btn:hover {
  color: var(--frost);
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--line);
}
.pill-btn:active {
  transform: scale(0.94);
}

/* Folding the article down to the pill and back. Both directions run with
   `mode="out-in"`, so this is two half-transitions, not a morph — the article
   drops and fades as it goes, the pill rises into the same corner it lives in.
   Same durations and easing as every other panel (tokens.css). */
.panel-swap-enter-active,
.panel-swap-leave-active {
  transition:
    opacity var(--slow),
    transform var(--slow);
}
.panel-swap-enter-from,
.panel-swap-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.985);
}
/* A panel on its way out is a picture of a state that has already gone: it must
   not take a click. The half-second of overlap is short enough to look like one
   surface folding into another and long enough to hit by accident, and a hit
   used to run the *old* panel's handler against the new store — which is how a
   closed article's "Show on map" threw and how a stale pill closed a selection
   the reader had just made. */
.panel-swap-leave-active {
  pointer-events: none;
}
/* The article carries its own entrance animation; running both at once
   double-counts the fade. */
.panel-swap-enter-active.panel {
  animation: none;
}

/* the fold-down chevron sits beside the close button, not under it */
.close.minimise {
  right: calc(var(--s3) + 32px);
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

/* The title starts at the panel's own top edge now, which puts its first line
   level with the corner buttons — so the space they need is reserved on the
   line rather than found by luck. One button is 30px at right: --s3; the
   fold-down chevron in focus mode is a second one 32px further in. */
/* The same way out, on the article: a line above the title, which is where a
   reader looks for "where am I". It keeps clear of the corner buttons on its
   own line rather than trusting the title's padding to cover it. */
.back {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: calc(100% - 82px);
  margin: 0 0 4px;
  padding: 2px 0;
  border: 0;
  background: none;
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--patina);
  cursor: pointer;
  transition: color var(--fast);
}
.back:hover {
  color: #a5dcd2;
}
.back-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

h2 {
  margin: 0;
  font-family: var(--serif);
  font-weight: 600;
  font-size: var(--t-title);
  line-height: 1.24;
  letter-spacing: -0.005em;
  padding-right: 46px;
  text-wrap: balance;
}
.has-minimise h2 {
  padding-right: 78px;
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
/* what kind of article this is — quiet, since most of them are events. Used
   twice: in the date line for the article itself, and on a row in Related /
   See also, where the same chip the search results use says that the thing on
   the other end of a relation is a life or an idea rather than an event. */
.kind {
  flex: none;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  padding: 1px 8px;
  font-family: var(--cond);
  font-size: var(--t-xs);
  text-transform: uppercase;
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
  color: var(--frost-dim);
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
/* --- the step page ------------------------------------------------------
   A page inside the article, set apart by a rule and an indent rather than by
   a box: it is still this event's panel, and boxing it would read as a card
   about something else. The back control is reused verbatim from the focus
   breadcrumb (`.back`) — one gesture, one look, two places it can appear. */
.step-page {
  margin-top: var(--s4);
  padding-top: var(--s3);
  border-top: 1px solid var(--line-soft);
}
.step-page h3 {
  margin: 2px 0 0;
  font-family: var(--serif);
  font-weight: 600;
  font-size: var(--t-lg);
  line-height: 1.3;
  color: var(--frost);
}
.step-page .body {
  margin-top: var(--s2);
}

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
  align-items: baseline;
  gap: var(--s3);
  font-size: var(--t-md);
  padding: 3px 0;
}
/* the name takes the room; the kind chip and the year keep to the right edge */
.block li > a {
  flex: 1;
  min-width: 0;
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
  /* a bottom sheet, sitting just clear of the timeline. It grows with the
     desktop panel, but only to 62dvh: the map above it is the other half of
     what a phone is showing, and a sheet past two thirds stops being a sheet. */
  .panel {
    top: auto;
    bottom: calc(var(--rail-clear) + var(--s2));
    left: calc(var(--s3) + var(--safe-l));
    right: calc(var(--s3) + var(--safe-r));
    width: auto;
    max-height: 62dvh;
    padding: var(--s4) var(--s4) var(--s4);
    animation-name: sheet-in;
  }
  /* The sheet stands on the strip's row rather than on the rail. On a phone the
     sheet occupies the same corner the strip does, so without this the chips
     are simply not there while a step page is open — and the strip is how the
     reader gets to the NEXT step. */
  .panel.has-strip {
    bottom: calc(var(--strip-clear) + var(--s1));
    max-height: 62dvh;
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
  /* the pill spans the width the sheet did, still above the timeline. It shrinks
     with the desktop one, but not below a thumb: 38px is the smallest the two
     buttons can be and still be hit without aiming. */
  .pill {
    left: calc(var(--s3) + var(--safe-l));
    right: calc(var(--s3) + var(--safe-r));
    max-width: none;
    padding: 3px 5px 3px var(--s3);
  }
  .pill-btn {
    width: 38px;
    height: 38px;
  }
  .pill-main {
    flex: 1;
    min-width: 0;
    padding: 7px 2px;
  }
  .close.minimise {
    right: calc(var(--s2) + 42px);
  }
}
</style>
