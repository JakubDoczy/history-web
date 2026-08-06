<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useEventStore } from '../stores/events'
import { formatTime } from '../lib/time'
import { NO_ACTIVE } from '../lib/listbox'
import type { SagaView } from '../lib/present/saga'
import {
  backPressesTo,
  crumbs,
  layoutRail,
  railX,
  stationTime,
  stations,
  stepBy,
  type PlacedStation,
} from '../lib/present/sagaTimeline'

/**
 * THE SAGA TIMELINE — the rail, while a saga is what the map is about.
 *
 * The era rail is a map of all of time and the whole of its grammar is
 * continuous: drag anywhere, land on any year. Inside a saga neither half of
 * that is true. There is one span — this event's — and what can be selected in
 * it is exactly the moments someone wrote down (lib/steps.ts, rule 2). So the
 * rail is REPLACED rather than decorated: this event's span, ruled in its own
 * unit, with its steps standing where they happened, and no era bands, no
 * selection handles, because none of those are statements about the thing on the
 * screen. The era rail comes back, untouched and holding the year it always
 * held, the moment the focus ends (components/BottomRail.vue).
 *
 * A DUAL SYSTEM, which is what the reader asked for in as many words. The rail
 * tells the truth about *when* — stations at their dates, over a rule of years
 * or months — and truth about when is not the same thing as an easy target for a
 * thumb. So beside it sits the plain way through: prev, next, and a list of
 * every step by name and date. Neither is a fallback for the other; the rail is
 * the picture and the list is the index.
 *
 * Everything with arithmetic in it is in lib/present/sagaTimeline.ts; what is
 * left here is the drawing and the gestures.
 */
const props = defineProps<{ saga: SagaView }>()
const events = useEventStore()

const track = useTemplateRef('track')
const width = ref(1)
let resizeObs: ResizeObserver
onMounted(() => {
  width.value = track.value!.clientWidth
  resizeObs = new ResizeObserver(() => (width.value = track.value!.clientWidth))
  resizeObs.observe(track.value!)
})
onBeforeUnmount(() => resizeObs.disconnect())

const rail = computed(() => layoutRail(stations(props.saga.steps, props.saga.span), props.saga.span, width.value))
const ids = computed(() => rail.value.stations.map((s) => s.step.id))
const trail = computed(() => crumbs(events.focusTrail))
const span = computed(() => formatTime(props.saga.span))
const count = computed(() => {
  const n = props.saga.steps.length
  return `${n} ${n === 1 ? 'step' : 'steps'}`
})
/** A station's date, at the resolution the axis is ruled in — never finer. */
const dateOf = (s: PlacedStation) => stationTime(s, props.saga.span, rail.value.axis.unit)
/** A tick's pixel, through the same map the stations are placed by. */
const tickX = (u: number) => railX(u, rail.value.width)

/* --- the cursor: what a press of Enter would take ---------------------------
   The cursor is not the selection. Arrows MOVE it and Enter takes it when the
   station is an ENTRANCE, rather than arrows selecting as they go, because
   walking past an entrance with the arrow keys would descend into it — often
   into an event with no steps at all, which takes this rail off the screen —
   and the reader would never reach the far end. A station that is a page of
   THIS saga has no such cost, so prev/next opens it as it passes: that is the
   click-through, and it is the common case for a saga of pages. */
const cursor = ref(NO_ACTIVE)
const stationId = (id: string) => `saga-station-${id}`
const cursorId = computed(() => {
  const s = rail.value.stations[cursor.value]
  return s ? stationId(s.step.id) : undefined
})

/** Whichever station the reader is asking about: the cursor, or the open step. */
const asked = (id: string) => id === events.stepId || cursorId.value === stationId(id)

/** Where prev/next counts from: the open step, else wherever the cursor is. */
const place = computed(() => events.stepId ?? rail.value.stations[cursor.value]?.step.id)
const canGo = (dir: 1 | -1) => !!stepBy(ids.value, place.value, dir)

/**
 * One press of prev/next — and of an arrow key, which is the same action.
 *
 * It always moves; whether it also OPENS is the entrance rule above. The
 * overview is the stop before the first step, so pressing prev from step one
 * lands on the whole of it rather than on nothing.
 */
function go(dir: 1 | -1) {
  const at = stepBy(ids.value, place.value, dir)
  if (!at) return
  cursor.value = at.to ? ids.value.indexOf(at.to) : NO_ACTIVE
  if (at.to === undefined) return void events.selectStep()
  const s = rail.value.stations.find((x) => x.step.id === at.to)!
  if (s.kind === 'page') events.selectStep(s.step.id)
  else reveal(s.step.id)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    const s = rail.value.stations[cursor.value]
    if (!s) return
    e.preventDefault()
    return void events.selectStep(s.step.id)
  }
  const dir = { ArrowRight: 1, ArrowLeft: -1 }[e.key] as 1 | -1 | undefined
  if (dir === undefined) return // not ours — Escape still unwinds the mode (HomeView)
  e.preventDefault()
  go(dir)
}

/** Keep a station on screen: a phone's rail is wider than the phone (`railWidth`). */
async function reveal(id?: string) {
  if (!id) return
  await nextTick()
  track.value?.querySelector(`#${CSS.escape(stationId(id))}`)?.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
  })
}

// The rail follows the store, not only the reader: a step opened from anywhere
// (the list, a page's own link, a descent that landed here) scrolls into view,
// and the cursor lands on it so prev/next carries on from where they are.
watch(
  () => events.stepId,
  (id) => {
    // Back on the overview the cursor CLEARS: it is where the reader is, and
    // "the whole of it" is not one of the stations.
    cursor.value = rail.value.stations.findIndex((s) => s.step.id === id)
    reveal(id)
  },
)

/* --- the list: every step by name and date, one press away ------------------
   The rail's own targets are as wide as the moments are far apart, which on a
   crowded span is a few pixels. This is the control that owes the reader a row
   they can hit, in the order they happened, with the dates spelt out — and the
   overview at the top of it, because it is the first stop on the same walk. */
const listOpen = ref(false)
watch(
  () => [events.stepId, events.focus?.itemId],
  () => (listOpen.value = false),
)
function pick(id?: string) {
  listOpen.value = false
  events.selectStep(id)
}

/**
 * A crumb: the way back UP.
 *
 * The innermost crumb is where the reader already is, so pressing it means "the
 * whole of it" — the overview, which is the state of not being in a step and
 * the one thing a reader who has stepped in must never have to hunt for. An
 * ancestor is a focus to pop back to, spelt as presses of the ordinary ladder
 * (`backPressesTo`) so this adds no transition of its own.
 */
function goToCrumb(id: string, current: boolean) {
  if (current) return void events.selectStep()
  for (let i = backPressesTo(events.focusStack, events.selectedId, id); i > 0; i--)
    events.focusBack()
}
</script>

<template>
  <nav
    class="rail saga"
    data-test="saga-timeline"
    tabindex="0"
    role="tablist"
    aria-orientation="horizontal"
    :aria-label="`Steps of ${saga.name}`"
    :aria-activedescendant="cursorId"
    @keydown="onKeydown"
  >
    <!-- THE BREADCRUMB. It names the stack and it is the way back up it: one
         crumb per focus context, innermost last, and the innermost one is the
         overview of the saga the rail is drawing. -->
    <div class="head">
      <div class="crumbs">
        <template v-for="(c, i) in trail" :key="c.id">
          <span v-if="i" class="sep" aria-hidden="true">▸</span>
          <button
            class="crumb"
            :class="{ current: c.current, on: c.current && !events.stepId }"
            data-test="saga-crumb"
            :data-crumb="c.id"
            :data-step="c.current ? 'overview' : undefined"
            :aria-pressed="c.current && !events.stepId"
            :title="c.current ? `${c.name} — the whole of it` : `Back to ${c.name}`"
            @click="goToCrumb(c.id, c.current)"
          >
            {{ c.name }}
          </button>
        </template>
      </div>
      <span class="meta tnum" data-test="saga-span">{{ span }} · {{ count }}</span>

      <!-- THE OTHER HALF OF THE DUAL SYSTEM. Three plain targets at the rail's
           edge: back one, the whole list, forward one. -->
      <div class="nav">
        <button
          class="nav-btn"
          data-test="saga-prev"
          :disabled="!canGo(-1)"
          title="Previous step"
          aria-label="Previous step"
          @click="go(-1)"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <button
          class="nav-btn list-btn"
          data-test="saga-list-toggle"
          :class="{ on: listOpen }"
          :aria-expanded="listOpen"
          :title="`All ${count}`"
          @click="listOpen = !listOpen"
        >
          <span class="list-label">Steps</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
        </button>
        <button
          class="nav-btn"
          data-test="saga-next"
          :disabled="!canGo(1)"
          title="Next step"
          aria-label="Next step"
          @click="go(1)"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </div>
    </div>

    <!-- THE LIST. Over the rail rather than in it: the rail is a fixed box the
         panels above are laid out against (see `.rail` below), so the one
         control that has to be as long as the saga opens upward out of it. -->
    <div v-if="listOpen" class="list-shade" @click="listOpen = false" />
    <ul v-if="listOpen" class="list scroll-y" data-test="saga-list">
      <li>
        <button class="row" :class="{ on: !events.stepId }" data-test="saga-list-item" data-step="overview" @click="pick()">
          <span class="row-num tnum" aria-hidden="true">·</span>
          <span class="row-name">Overview</span>
          <span class="row-at tnum">{{ span }}</span>
        </button>
      </li>
      <li v-for="s in rail.stations" :key="s.step.id">
        <button
          class="row"
          :class="{ on: events.stepId === s.step.id, entrance: s.kind === 'entrance' }"
          data-test="saga-list-item"
          :data-step="s.step.id"
          @click="pick(s.step.id)"
        >
          <span class="row-num tnum" aria-hidden="true">{{ s.ordinal }}</span>
          <span class="row-name">{{ s.step.name }}</span>
          <span class="row-at tnum">{{ dateOf(s) }}</span>
          <svg v-if="s.kind === 'entrance'" class="row-in" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </li>
    </ul>

    <!-- THE TRACK. It scrolls only when the stations cannot be told apart at the
         element's own width — a phone with eleven of them. -->
    <div ref="track" class="track">
      <div class="inner" :class="{ dateless: rail.axis.unit === 'none' }" :style="{ width: rail.width + 'px' }">
        <!-- THE RULE. The era rail's idiom at a saga's scale: a gridline down
             the whole track, a stronger stub at the axis, the label beside it. -->
        <span
          v-for="t in rail.axis.ticks"
          :key="t.label + t.u"
          class="tick"
          :class="{ major: t.major }"
          data-test="saga-tick"
          aria-hidden="true"
          :style="{ left: tickX(t.u) + 'px' }"
          ><i class="tnum">{{ t.label }}</i></span
        >
        <span
          class="axis"
          :title="rail.axis.unit === 'none' ? `${span} — dated to the year, so the steps stand in the proportion they were authored` : undefined"
        />
        <button
          v-for="s in rail.stations"
          :id="stationId(s.step.id)"
          :key="s.step.id"
          class="station"
          :class="{
            on: events.stepId === s.step.id,
            entrance: s.kind === 'entrance',
            cursor: cursorId === stationId(s.step.id),
            named: !!s.labelPx,
            hung: s.lane > 0,
          }"
          data-test="saga-station"
          :data-step="s.step.id"
          :data-lane="s.lane"
          :data-entrance="s.kind === 'entrance' ? '' : undefined"
          role="tab"
          :aria-selected="events.stepId === s.step.id"
          :title="`${s.step.name} · ${dateOf(s)}${s.kind === 'entrance' ? ' — go into it' : ''}`"
          :style="{ left: s.x + 'px', top: `calc(var(--lane-1) + ${s.lane} * var(--lane-h))` }"
          @click="events.selectStep(s.step.id)"
        >
          <!-- The stem: a hairline from the axis down to the mark, so a station
               that had to hang below the rule still points at its own moment. -->
          <span
            class="stem"
            aria-hidden="true"
            :style="{
              height: `calc(var(--lane-1) - var(--spine) - var(--mark) / 2 + ${s.lane} * var(--lane-h))`,
            }"
          />
          <!-- A period is a stretch of the span, and says so: the band is the
               step's own end, which the step's window deliberately is not. -->
          <span v-if="s.band" class="band" aria-hidden="true" :style="{ width: s.band.w + 'px' }" />
          <span class="mark">
            <span class="num tnum" aria-hidden="true">{{ s.ordinal }}</span>
            <!-- The descent cue, in the app's own stroke language (the list's
                 chevron, the pill's restore arrow): another layer, this way. -->
            <svg
              v-if="s.kind === 'entrance'"
              class="descend"
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </span>
          <!-- The name, with the room the layout could find it. `asked` is the
               states in which the reader is asking about ONE station, and there
               the label is shown whole, over its neighbours. -->
          <span
            class="label"
            :class="{ free: asked(s.step.id) || !s.labelPx, flip: s.flip }"
            :style="{ maxWidth: (s.labelPx || 220) + 'px' }"
            >{{ s.step.name }}</span
          >
        </button>
      </div>
    </div>
  </nav>
</template>

<style scoped>
/* The same box the era rail occupies, to the pixel: the panels above it are
   laid out against --rail, and a taller rail inside a focus would push the
   article off its own bottom edge on the frame the mode is entered. */
.rail {
  /* The track's vertical grammar, in one place: the rule at the top, then the
     lanes hanging under it. A lane costs --lane-h and there are at most
     MAX_LANES of them (lib/present/sagaTimeline.ts), which is what makes them
     fit the box above. */
  --tick-h: 14px;
  --spine: 15px;
  --lane-1: 26px;
  --lane-h: 16px;
  --mark: 16px;
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: calc(var(--rail) + var(--safe-b));
  padding: 0 0 var(--safe-b);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, rgba(6, 10, 18, 0.55), rgba(6, 10, 18, 0.97) 42%);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-top: 1px solid var(--line);
  user-select: none;
  z-index: var(--z-timeline);
  animation: rail-in var(--slow);
}
.rail:focus-visible {
  outline: none;
  box-shadow: inset 0 1px 0 var(--brass-line);
}
@keyframes rail-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

/* --- the breadcrumb row --- */
.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--s2);
  height: 24px;
  padding: 0 var(--s3);
  border-bottom: 1px solid var(--line-soft);
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.crumbs::-webkit-scrollbar {
  display: none;
}
.crumb {
  flex: none;
  max-width: 42vw;
  padding: 1px 6px;
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.08em;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition:
    color var(--fast),
    background-color var(--fast);
}
.crumb:hover {
  color: var(--patina);
  background: rgba(255, 255, 255, 0.05);
}
/* The innermost crumb is where the reader IS — the saga this rail is drawing —
   so it is set in the app's reading face rather than in its control face. */
.crumb.current {
  font-family: var(--serif);
  font-size: var(--t-md);
  letter-spacing: 0;
  color: var(--frost);
}
.crumb.current.on {
  color: var(--brass);
}
.sep {
  flex: none;
  font-size: 9px;
  color: var(--line);
}
.meta {
  flex: none;
  margin-left: auto;
  font-family: var(--cond);
  font-size: var(--t-eyebrow);
  font-weight: 500;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
}

/* --- prev / list / next: the plain way through --- */
.nav {
  flex: none;
  /* above the list's click-away shade, so the toggle stays a toggle and the
     arrows keep working with the list open */
  position: relative;
  z-index: 2;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
}
.meta + .nav {
  margin-left: var(--s2);
}
.nav-btn {
  display: grid;
  grid-auto-flow: column;
  align-items: center;
  gap: 3px;
  height: 20px;
  min-width: 22px;
  padding: 0 4px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: rgba(13, 20, 32, 0.6);
  color: var(--frost-dim);
  cursor: pointer;
  transition:
    color var(--fast),
    border-color var(--fast),
    background-color var(--fast);
}
.nav-btn:hover:not(:disabled) {
  border-color: var(--brass-line);
  color: var(--brass);
}
.nav-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.nav-btn.on {
  border-color: var(--brass);
  color: var(--brass);
  background: var(--brass-soft);
}
.list-label {
  font-family: var(--cond);
  font-size: var(--t-eyebrow);
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.list-btn.on svg {
  transform: rotate(180deg);
}

/* --- the list, opened upward out of the rail --- */
.list-shade {
  position: fixed;
  inset: 0;
  z-index: 1;
}
.list {
  position: absolute;
  z-index: 2;
  right: var(--s3);
  bottom: 100%;
  margin: 0 0 var(--s2);
  padding: var(--s1);
  width: min(340px, calc(100vw - 2 * var(--s3)));
  max-height: min(46vh, 340px);
  box-sizing: border-box;
  list-style: none;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--lift);
  animation: list-in var(--fast);
}
@keyframes list-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.row {
  display: grid;
  grid-template-columns: 18px 1fr auto auto;
  align-items: center;
  gap: var(--s2);
  width: 100%;
  min-height: 32px;
  padding: 4px var(--s2);
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--frost-dim);
  text-align: left;
  cursor: pointer;
  transition:
    color var(--fast),
    background-color var(--fast);
}
.row:hover {
  color: var(--frost);
  background: rgba(255, 255, 255, 0.06);
}
.row.on {
  color: var(--brass);
  background: var(--brass-soft);
}
.row-num {
  font-family: var(--cond);
  font-size: var(--t-micro);
  color: var(--muted);
  text-align: right;
}
.row.on .row-num {
  color: var(--brass);
}
.row-name {
  font-size: var(--t-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-at {
  font-family: var(--cond);
  font-size: var(--t-micro);
  letter-spacing: 0.06em;
  color: var(--muted);
  white-space: nowrap;
}
.row-in {
  color: var(--brass);
  opacity: 0.8;
}

/* --- the track --- */
.track {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}
.track::-webkit-scrollbar {
  display: none;
}
.inner {
  position: relative;
  height: 100%;
}
/* THE AXIS: the span itself, drawn straight. Dashed when the saga is dated to a
   single year — there is no rule on it because there is no extent to divide,
   and a dashed line says so without a sentence (see `axisTicks`). */
.axis {
  position: absolute;
  left: 0;
  right: 0;
  top: var(--spine);
  height: 1px;
  background: var(--line);
}
.inner.dateless .axis {
  background: repeating-linear-gradient(90deg, var(--line) 0 4px, transparent 4px 8px);
}
/* A tick: the era rail's gridline, its stub and its label, at a saga's scale. */
.tick {
  position: absolute;
  top: var(--tick-h);
  bottom: 0;
  border-left: 1px solid var(--line-soft);
  pointer-events: none;
}
.tick::before {
  content: '';
  position: absolute;
  top: 0;
  left: -1px;
  width: 1px;
  height: 8px;
  background: var(--line);
}
.tick.major::before {
  background: var(--frost-dim);
  opacity: 0.5;
}
.tick i {
  position: absolute;
  bottom: 100%;
  left: 4px;
  font-family: var(--cond);
  font-size: var(--t-micro);
  font-style: normal;
  letter-spacing: 0.06em;
  color: var(--muted);
  white-space: nowrap;
}
.tick.major i {
  color: var(--frost-dim);
}

/* A station is its mark: a small box centred on the moment it happened, in the
   lane the layout could find it. Nothing widens it — see `layoutRail`. */
.station {
  position: absolute;
  width: 24px;
  height: 24px;
  margin: -12px 0 0 -12px;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.station:hover,
.station.on,
.station.cursor {
  z-index: 3; /* a crowded mark comes to the front when it is asked about */
}
.stem {
  position: absolute;
  left: 11px;
  bottom: calc(50% + var(--mark) / 2);
  width: 1px;
  background: var(--line);
}
.mark {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: grid;
  place-items: center;
  width: var(--mark);
  height: var(--mark);
  /* over a neighbour's label, and over its OWN when the label is shown whole:
     the number in the mark is how a station is told from the next one. */
  z-index: 3;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: rgba(6, 10, 18, 0.92);
  color: var(--muted);
  transition:
    color var(--fast),
    border-color var(--fast),
    background-color var(--fast);
}
.num {
  font-family: var(--cond);
  font-size: var(--t-micro);
  line-height: 1;
}
.station:hover .mark {
  border-color: var(--brass-line);
  color: var(--brass);
}
/* An ENTRANCE is a way down into another item, and reads as one before it is
   pressed: the brass edge of the list's entrance row, and its chevron. */
.station.entrance .mark {
  border-color: var(--brass-line);
}
/* The cursor: a ring around the mark, which is not the same claim as the filled
   mark below — it says "this is what Enter would take". */
.station.cursor .mark {
  border-color: var(--brass);
  color: var(--brass);
  box-shadow: 0 0 0 3px var(--brass-soft);
}
/* WHERE THE READER IS. Last, because it outranks every other state on the rail
   and all four are written at the same specificity: the open step is normally
   under the cursor as well, and with the cursor's rule after this one the brass
   number was being drawn in brass on the brass fill. */
.station.on .mark {
  border-color: var(--brass);
  background: var(--brass);
  color: var(--void);
  box-shadow: 0 0 10px rgba(227, 167, 88, 0.5);
}
/* A badge on the mark's shoulder rather than a glyph under it: the room beside
   the mark belongs to the label, and a chevron sitting in it would be read as
   part of the name it was directly beside. */
.descend {
  position: absolute;
  right: -6px;
  bottom: -5px;
  border-radius: 50%;
  background: rgba(6, 10, 18, 0.92);
  color: var(--brass);
  opacity: 0.9;
}
.station.on .descend {
  color: var(--brass);
  opacity: 1;
}

/* A period's band: from the step's own start to its own end, along its lane —
   under the mark's own row rather than through it, so it underlines the name
   instead of striking it out. */
.band {
  position: absolute;
  top: calc(50% + var(--mark) / 2 - 3px);
  left: 50%;
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--patina), rgba(111, 179, 168, 0.25));
  opacity: 0.75;
}

.label {
  position: absolute;
  top: 50%;
  /* clear of the mark, and of the 5px the free label's own ground reaches back */
  left: calc(50% + var(--mark) / 2 + 6px);
  transform: translateY(-50%);
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.03em;
  color: var(--frost-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* A map label's halo: the rule's gridlines and a neighbouring period's band
     both pass behind these names, and the dark ground cut around each glyph is
     what keeps the line from reading as a strike-through. */
  text-shadow:
    0 0 3px var(--void),
    0 0 2px var(--void);
  transition: color var(--fast);
  pointer-events: none;
}
.station.on .label {
  color: var(--brass);
}
.station:hover .label,
.station.cursor .label {
  color: var(--frost);
}
/* A name with no room of its own, or one the reader is asking about: it is
   shown WHOLE, over its neighbours, on a ground of its own so it can be read
   there. Hidden until asked when the layout found it no room at all. */
.label.free {
  overflow: visible;
  max-width: none !important;
  z-index: 2;
  padding: 1px 5px;
  margin: -1px -5px;
  border-radius: var(--r-sm);
  background: rgba(6, 10, 18, 0.92);
  box-shadow: 0 0 0 1px var(--line-soft);
}
/* At the right-hand end a whole name hangs the other way off its mark, so it is
   read rather than clipped and the rail is not made to scroll by a hover. */
.label.free.flip {
  left: auto;
  right: calc(50% + var(--mark) / 2 + 6px);
  text-align: right;
}
.station:not(.named) .label {
  opacity: 0;
}
.station:not(.named):hover .label,
.station.on .label,
.station.cursor .label {
  opacity: 1;
}

@media (max-width: 640px) {
  /* A phone's rail is 8px shorter, and its lanes give the pixels up: the rule
     and the marks are the two things that cannot. */
  .rail {
    --lane-1: 24px;
    --lane-h: 14px;
    --mark: 14px;
  }
  /* The crumb keeps its own row's width and ellipses — a phone's stack can be
     three deep and the controls still have to be reachable beside it. */
  .crumb {
    max-width: 30vw;
  }
  .meta {
    display: none;
  }
  .list-label {
    display: none;
  }
  .nav-btn {
    height: 22px;
    min-width: 26px;
  }
  .row {
    min-height: 40px;
  }
  .label {
    font-size: var(--t-micro);
  }
}
</style>
