<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useEventStore } from '../stores/events'
import { formatTime } from '../lib/time'
import { NO_ACTIVE, stepActiveX } from '../lib/listbox'
import type { SagaView } from '../lib/present/saga'
import { backPressesTo, crumbs, layoutRail, stations } from '../lib/present/sagaTimeline'

/**
 * THE SAGA TIMELINE — the rail, while a saga is what the map is about.
 *
 * The era rail is a map of all of time and the whole of its grammar is
 * continuous: drag anywhere, land on any year. Inside a saga neither half of
 * that is true. There is one span — this event's — and what can be selected in
 * it is exactly the moments someone wrote down (lib/steps.ts, rule 2). So the
 * rail is REPLACED rather than decorated: a straight line of the saga's own
 * span with its steps as stations, and no year scrubbing, no era bands, no
 * selection handles, because none of those are statements about the thing on
 * the screen. The era rail comes back, untouched and holding the year it always
 * held, the moment the focus ends (components/BottomRail.vue).
 *
 * This replaces the step strip as well as the timeline. The strip was the same
 * eleven steps as a row of chips over the map, and two controls with the same
 * content and the same lifetime are one control drawn twice — the strip's real
 * failure was that eleven chips do not fit and it scrolled, which is a layout
 * the rail solves by being a rail (see `layoutRail`).
 *
 * Everything with arithmetic in it is in lib/present/sagaTimeline.ts; what is
 * left here is the drawing and the two gestures.
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

const rail = computed(() => layoutRail(stations(props.saga.steps, props.saga.span), width.value))
const trail = computed(() => crumbs(events.focusTrail))
const span = computed(() => formatTime(props.saga.span))
const count = computed(() => {
  const n = props.saga.steps.length
  return `${n} ${n === 1 ? 'step' : 'steps'}`
})

/* --- the keyboard: the same ring the search results use, laid on its side ----
   The cursor is not the selection. Arrows MOVE it and Enter takes it, rather
   than arrows selecting as they go, because most of a saga's stations can be
   entrances — walking past one with the arrow keys would descend into it and
   the reader would never reach the far end of the rail. */
const cursor = ref(NO_ACTIVE)
const stationId = (id: string) => `saga-station-${id}`
const cursorId = computed(() => {
  const s = rail.value.stations[cursor.value]
  return s ? stationId(s.step.id) : undefined
})

/** Whichever station the reader is asking about: the cursor, or the open step. */
const asked = (id: string) => id === events.stepId || cursorId.value === stationId(id)

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    const s = rail.value.stations[cursor.value]
    if (!s) return
    e.preventDefault()
    return void events.selectStep(s.step.id)
  }
  const next = stepActiveX(e.key, cursor.value, rail.value.stations.length)
  if (next === null) return // not ours — Escape still unwinds the mode (HomeView)
  e.preventDefault()
  cursor.value = next
  reveal(rail.value.stations[next]?.step.id)
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
// (the keyboard, a page's own link, a descent that landed here) scrolls into
// view, and the cursor lands on it so the arrows carry on from where they are.
watch(
  () => events.stepId,
  (id) => {
    const i = rail.value.stations.findIndex((s) => s.step.id === id)
    cursor.value = i
    reveal(id)
  },
)
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
    </div>

    <!-- THE TRACK. It scrolls only when the stations cannot all be pressable at
         the element's own width — a phone with eleven of them. -->
    <div ref="track" class="track">
      <div class="inner" :style="{ width: rail.width + 'px' }">
        <span class="axis" aria-hidden="true" />
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
          }"
          data-test="saga-station"
          :data-step="s.step.id"
          :data-entrance="s.kind === 'entrance' ? '' : undefined"
          role="tab"
          :aria-selected="events.stepId === s.step.id"
          :title="s.kind === 'entrance' ? `Go into ${s.step.name}` : s.step.name"
          :style="{ left: s.from + 'px', width: s.to - s.from + 'px' }"
          @click="events.selectStep(s.step.id)"
        >
          <!-- Where the moment really is, when the target had to be widened off
               it (see `layoutRail`): the rail says so rather than pretending. -->
          <span
            v-if="Math.abs(s.x - s.trueX) > 2"
            class="true"
            aria-hidden="true"
            :style="{ left: s.trueX - s.from + 'px' }"
          />
          <!-- A period is a stretch of the span, and says so: the band is the
               step's own end, which the step's window deliberately is not. -->
          <span
            v-if="s.band"
            class="band"
            aria-hidden="true"
            :style="{ left: s.band.x - s.from + 'px', width: s.band.w + 'px' }"
          />
          <span class="mark" :style="{ left: s.x - s.from + 'px' }">
            <span class="num tnum" aria-hidden="true">{{ s.ordinal }}</span>
            <!-- The descent cue, in the app's own stroke language (the strip's
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
               three states in which the reader is asking about ONE station, and
               there the label is shown whole, over its neighbours. -->
          <span
            class="label"
            :class="{ free: asked(s.step.id) || !s.labelPx, flip: s.flip }"
            :style="{
              left: s.x - s.from + 'px',
              top: 26 + s.row * 15 + 'px',
              maxWidth: (s.labelPx || 220) + 'px',
            }"
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
  overflow: hidden;
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
.axis {
  position: absolute;
  left: 0;
  right: 0;
  top: 15px;
  height: 1px;
  background: var(--line);
}

/* A station is its whole slab — the half-open window it owns (see
   `layoutRail`), which is why a press anywhere between two marks lands on the
   earlier one rather than on nothing. Full height, so the target is a thumb's
   worth in both axes without any of it being drawn. */
.station {
  position: absolute;
  top: 0;
  bottom: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.mark {
  position: absolute;
  top: 8px;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  margin-left: -8px;
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
/* Where the reader is. It outranks every other state on the rail. */
.station.on .mark {
  border-color: var(--brass);
  background: var(--brass);
  color: var(--void);
  box-shadow: 0 0 10px rgba(227, 167, 88, 0.5);
}
/* The keyboard cursor: a ring around the mark, which is not the same claim as
   the filled mark above — it says "this is what Enter would take". */
.station.cursor .mark {
  border-color: var(--brass);
  color: var(--brass);
  box-shadow: 0 0 0 3px var(--brass-soft);
}
/* An ENTRANCE is a way down into another item, and reads as one before it is
   pressed: the brass edge of the strip's entrance chip, and its chevron. */
.station.entrance .mark {
  border-color: var(--brass-line);
}
/* A badge on the mark's shoulder rather than a glyph under it: the row below
   the marks belongs to the labels, and a chevron sitting in it would be read as
   part of the name it was directly above. */
.descend {
  position: absolute;
  right: -8px;
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

/* A period's band: from the step's own start to its own end, on the axis. */
.band {
  position: absolute;
  top: 14px;
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--patina), rgba(111, 179, 168, 0.25));
  opacity: 0.75;
}
/* The moment the target was widened away from (see `layoutRail`). */
.true {
  position: absolute;
  top: 11px;
  width: 1px;
  height: 9px;
  background: var(--line);
}

.label {
  position: absolute;
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.03em;
  color: var(--frost-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transform: translateX(-6px);
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
/* At the right-hand end a whole name hangs the other way off its mark, so it is
   read rather than clipped and the rail is not made to scroll by a hover. */
.label.free.flip {
  transform: translateX(calc(-100% + 6px));
  text-align: right;
}
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
.station:not(.named) .label {
  opacity: 0;
}
.station:not(.named):hover .label,
.station.on .label,
.station.cursor .label {
  opacity: 1;
}

@media (max-width: 640px) {
  /* The crumb keeps its own row's width and ellipses — a phone's stack can be
     three deep and the span still has to be readable beside it. */
  .crumb {
    max-width: 38vw;
  }
  .meta {
    display: none;
  }
  .label {
    font-size: var(--t-micro);
  }
}
</style>
