<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useEventStore } from '../stores/events'
import { formatTime, timeExtent } from '../lib/time'
import { NO_ACTIVE } from '../lib/listbox'
import type { SagaView } from '../lib/present/saga'
import {
  FULL_WINDOW,
  backPressesTo,
  crumbs,
  formatAt,
  layoutRail,
  markZ,
  minWindow,
  panWindow,
  railX,
  revealIn,
  spanUnit,
  stationAt,
  stations,
  stepBy,
  zoomWindow,
  type PlacedStation,
  type RailWindow,
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

const railEl = useTemplateRef('railEl')
const track = useTemplateRef('track')
const width = ref(1)
let resizeObs: ResizeObserver

/**
 * SAFARI'S OWN PINCH, refused.
 *
 * `touch-action: none` is the standard way to say "this gesture is mine", and
 * in Chrome it covers the pinch. WebKit does not: its page zoom is driven by a
 * gesture recogniser that touch-action has no say over, and the only thing that
 * stands it down is `preventDefault` on the non-standard `gesturestart` —
 * without which an iPhone answers a pinch on the rail by magnifying the page
 * AND cancelling the pointers the rail was tracking, which is the worst of both
 * (the rail does nothing and the reader is left in a zoomed page).
 *
 * Three events, because `gesturestart` alone leaves `gesturechange` free to
 * carry on scaling once a gesture has begun some other way. They do not exist
 * in Chrome, where these listeners are three no-ops. Not passive: an
 * `addEventListener` on an element defaults to non-passive, which is what
 * `preventDefault` needs, and these are named explicitly rather than folded
 * into the template so that stays true where a linter would otherwise "fix" it.
 */
const GESTURES = ['gesturestart', 'gesturechange', 'gestureend']
const refuse = (e: Event) => e.preventDefault()

onMounted(() => {
  width.value = track.value!.clientWidth
  resizeObs = new ResizeObserver(() => (width.value = track.value!.clientWidth))
  resizeObs.observe(track.value!)
  for (const g of GESTURES) railEl.value!.addEventListener(g, refuse)
})
onBeforeUnmount(() => {
  resizeObs.disconnect()
  for (const g of GESTURES) railEl.value?.removeEventListener(g, refuse)
})

/* --- the window: what part of the span is on screen -------------------------
   The era rail's grammar, on a saga's span (lib/present/sagaTimeline.ts, note
   4). It lives here and nowhere else: the rail is keyed by the saga
   (BottomRail.vue), so a descent gets a new component and opens fitted, which
   is the right answer — a child's span is a different question. */
const win = ref<RailWindow>(FULL_WINDOW)
/** The narrowest window this saga allows; 1 means "nothing to zoom into". */
const floor = computed(() => minWindow(props.saga.span))
const zoomable = computed(() => floor.value < 1)
const zoomed = computed(() => win.value.u1 - win.value.u0 < 0.999)

const rail = computed(() =>
  layoutRail(stations(props.saga.steps, props.saga.span), props.saga.span, width.value, win.value),
)
const ids = computed(() => rail.value.stations.map((s) => s.step.id))
const trail = computed(() => crumbs(events.focusTrail))
/**
 * The saga's own span, at the resolution its rule is drawn in: a war says
 * "1939 – 1945" and a campaign that ran seven weeks says "6 Jun – 25 Jul 1944",
 * which is the whole point of having dated it.
 */
const span = computed(() => {
  // The SAGA's own resolution, not the live rule's: the rule refines as the
  // reader zooms and this does not, because "what period is this saga" is not
  // a question about where the window happens to be. Zoomed into June 1944 the
  // live rule ruled in days, and a war that ran from 1939 read "1 Sep – 2 Sep
  // 1945".
  const unit = spanUnit(props.saga.span)
  const [a, b] = timeExtent(props.saga.span)
  if (unit !== 'month' && unit !== 'day') return formatTime(props.saga.span)
  return `${formatAt(a, unit)} – ${formatAt(b, unit, true)}`
})
const count = computed(() => {
  const n = props.saga.steps.length
  return `${n} ${n === 1 ? 'step' : 'steps'}`
})
/** A station's date, at the resolution the saga's own span supports. */
const dateOf = (s: PlacedStation) =>
  stationAt(s, props.saga.span, rail.value.stations.length)
/** A tick's pixel, through the same map the stations are placed by. */
const tickX = (u: number) => railX(u, rail.value.width, rail.value.win)
/** A drawn station's place in rail space — the window's own coordinate. */
const railSpaceOf = (s: PlacedStation) =>
  win.value.u0 + (s.x / Math.max(1, width.value)) * (win.value.u1 - win.value.u0)
/** Off the visible edge: still laid out (it is still a fact) but not a target. */
const MARGIN_PX = 24
const offWindow = (s: PlacedStation) => s.x < -MARGIN_PX || s.x > width.value + MARGIN_PX

/* --- zoom and pan: the era rail's gestures, on this span --------------------
   Wheel and pinch zoom about the point under the cursor, a drag pans, a
   double-tap takes one step in. All of it is the same one call into the pure
   window math, so what a gesture can and cannot do (never out past the padded
   span, never in past a rule that has stopped refining) is stated once. */
const ZOOM_STEP = 1.4
const DRAG_PX = 3
/** Has the reader moved the window yet? Only the hint reads this. */
const touched = ref(false)
let anim = 0

const slow = () => matchMedia('(prefers-reduced-motion: reduce)').matches
/** A short settle onto a new window — what panning a station into view looks like. */
function glide(to: RailWindow, ms = 240) {
  cancelAnimationFrame(anim)
  if (slow()) return void (win.value = to)
  const from = win.value
  const t0 = performance.now()
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / ms)
    const e = 1 - (1 - k) ** 3 // the same "arrive, don't land" shape as --ease
    win.value = { u0: from.u0 + (to.u0 - from.u0) * e, u1: from.u1 + (to.u1 - from.u1) * e }
    if (k < 1) anim = requestAnimationFrame(step)
  }
  anim = requestAnimationFrame(step)
}
function setWin(w: RailWindow) {
  cancelAnimationFrame(anim)
  win.value = w
  touched.value = true
}
const zoomBy = (k: number, at: number) =>
  zoomable.value && setWin(zoomWindow(win.value, k, at, floor.value))

const pointers = new Map<number, number>()
/** A drag is a pan, and the press that would have ended it is not a press. */
let panned = false
let tap = { t: 0, x: 0 }
const localX = (e: PointerEvent | WheelEvent) => e.clientX - track.value!.getBoundingClientRect().left
const pinch = () => {
  const [a, b] = [...pointers.values()]
  return Math.max(1, Math.abs(b - a))
}

function onWheel(e: WheelEvent) {
  zoomBy(e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, localX(e) / width.value)
}
function onPointerDown(e: PointerEvent) {
  pointers.set(e.pointerId, localX(e))
  panned = false
  // A SECOND FINGER MAKES IT THE TRACK'S GESTURE.
  //
  // Touch pointers are implicitly captured to whatever they landed on, which
  // for this rail is a station's <button>, its mark, or the SVG chevron inside
  // it — every one of them a descendant of the track, so the moves bubble here
  // and a pinch works. Until a finger leaves that subtree: a real thumb on a
  // 90px strip crosses the rail's edge constantly, and the moment it does its
  // events stop arriving and the pinch freezes half-done. Capturing both
  // pointers to the track is what makes the gesture survive the reader's actual
  // hands — the era rail (TimelineBar.vue) captures on every press for the same
  // reason. Only from the second finger, though: capturing the first would
  // retarget its `click` to the track and a press on a station would stop
  // opening it, which is what the era rail can afford and this cannot.
  if (pointers.size >= 2)
    for (const id of pointers.keys())
      try {
        track.value!.setPointerCapture(id)
      } catch {
        // that pointer ended without an event reaching us; the map is cleaned
        // up by the next up/cancel and there is nothing to capture
      }
}
function onPointerMove(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return
  if (pointers.size >= 2) {
    const before = pinch()
    pointers.set(e.pointerId, localX(e))
    const [a, b] = [...pointers.values()]
    panned = true
    return zoomBy(before / pinch(), (a + b) / 2 / width.value)
  }
  const x = localX(e)
  const dx = x - pointers.get(e.pointerId)!
  // Under the threshold the anchor is NOT moved, so a slow drag still accrues
  // to it: a tap that wanders two pixels stays a tap, and a press stays a press.
  if (!panned && Math.abs(dx) < DRAG_PX) return
  if (!panned) track.value!.setPointerCapture(e.pointerId)
  panned = true
  pointers.set(e.pointerId, x)
  setWin(panWindow(win.value, (-dx / width.value) * (win.value.u1 - win.value.u0)))
}
function onPointerUp(e: PointerEvent) {
  pointers.delete(e.pointerId)
  if (panned) return void setTimeout(() => (panned = false)) // the click follows
  if (pointers.size) return
  const [t, x] = [performance.now(), localX(e)]
  // A double-tap is one step in, held at the tap — a phone's wheel.
  if (t - tap.t < 340 && Math.abs(x - tap.x) < 28) {
    zoomBy(1 / (ZOOM_STEP * ZOOM_STEP), x / width.value)
    tap = { t: 0, x }
  } else tap = { t, x }
}
/**
 * The zoom control — and the affordance, which is most of its job.
 *
 * The era rail advertises its gestures with a grab cursor and an aria-label,
 * and a phone has neither. So the rail carries one visible control that says
 * the window can move: from rest it takes one step in, and once the window is
 * anything but the whole span it becomes the way back to it. One button, two
 * states, and the state is the readout.
 */
function fit() {
  if (!zoomable.value) return
  touched.value = true
  if (zoomed.value) glide(FULL_WINDOW)
  else setWin(zoomWindow(win.value, 1 / ZOOM_STEP, 0.5, floor.value))
}

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

/**
 * Keep a station on screen — by PANNING THE WINDOW to it, which is the only
 * thing "on screen" can mean now that the rail is exactly as wide as its
 * element. It is the second half of the dual system doing its job: the index
 * takes you to a step, and the picture follows so you can see where it is.
 *
 * A window that already holds the station is left alone, so walking prev/next
 * through the middle of a zoomed war does not jog the rail on every press.
 */
function reveal(id?: string) {
  const s = rail.value.stations.find((x) => x.step.id === id)
  if (!s) return
  const to = revealIn(win.value, railSpaceOf(s))
  if (to !== win.value) glide(to)
}

/** A press on a station — unless the press was the end of a pan (see `panned`). */
const press = (id: string) => !panned && events.selectStep(id)

// The rail follows the store, not only the reader: a step opened from anywhere
// (the list, a page's own link, a descent that landed here) is panned into
// view, and the cursor lands on it so prev/next carries on from where they are.
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
    ref="railEl"
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
          <svg v-if="i" class="glyph sep" width="8" height="8" viewBox="-12 -12 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M-3 -6L3 0L-3 6" /></svg>
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
        <!-- The window's own control, and the rail's one visible statement that
             the window can move at all (see `fit`). It stands down entirely on
             a saga with no extent, where there is nothing to zoom into. -->
        <button
          v-if="zoomable"
          class="nav-btn zoom-btn"
          data-test="saga-zoom"
          :class="{ on: zoomed, hint: !touched }"
          :aria-label="zoomed ? 'Fit the whole saga' : 'Zoom in'"
          :title="
            zoomed
              ? 'Fit the whole saga — drag to pan, scroll or pinch to zoom'
              : 'Zoom in — or scroll, pinch or double-tap the rail; drag to pan'
          "
          @click="fit()"
        >
          <svg
            width="12"
            height="12"
            viewBox="-12 -12 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <circle cx="-1.5" cy="-1.5" r="6.5" />
            <path d="M3.2 3.2L9 9" />
            <path v-if="!zoomed" d="M-1.5 -4.5v6M-4.5 -1.5h6" />
            <path v-else d="M-4.5 -1.5h6" />
          </svg>
          <span class="zoom-label">{{ zoomed ? 'Fit' : 'Zoom' }}</span>
        </button>
        <button
          class="nav-btn icon-c"
          data-test="saga-prev"
          :disabled="!canGo(-1)"
          title="Previous step"
          aria-label="Previous step"
          @click="go(-1)"
        >
          <svg class="glyph" width="13" height="13" viewBox="-12 -12 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 -6L-3 0L3 6" /></svg>
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
          <svg class="glyph" width="11" height="11" viewBox="-12 -12 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M-6 3L0 -3L6 3" /></svg>
        </button>
        <button
          class="nav-btn icon-c"
          data-test="saga-next"
          :disabled="!canGo(1)"
          title="Next step"
          aria-label="Next step"
          @click="go(1)"
        >
          <svg class="glyph" width="13" height="13" viewBox="-12 -12 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M-3 -6L3 0L-3 6" /></svg>
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
          <svg v-if="s.kind === 'entrance'" class="glyph row-in" width="11" height="11" viewBox="-12 -12 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M-3 -6L3 0L-3 6" /></svg>
        </button>
      </li>
    </ul>

    <!-- THE TRACK. Exactly as wide as the element, always: what used to be a
         scrolling rail on a phone is a WINDOW now, moved by the same gestures
         the era rail has (`onWheel`, `onPointerMove`) and clamped by the same
         pure functions everything else here is derived from. -->
    <div
      ref="track"
      class="track"
      :class="{ zoomed }"
      :data-window="`${win.u0.toFixed(4)},${win.u1.toFixed(4)}`"
      :aria-label="zoomable ? 'Drag to pan, scroll or pinch to zoom' : undefined"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <div class="inner" :class="{ dateless: rail.axis.unit === 'none' }">
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
          :title="rail.axis.unit === 'none' ? `${span} — dated to a single point, so the steps stand in order rather than at dates` : undefined"
        />
        <!-- A station. `--z` is WHICH MARK IS ON TOP, decided where it can be
             read and unit-tested (`markZ`) rather than by the order four rules
             of equal specificity happen to be written in: the open step
             outranks the cursor, which outranks a hover, which outranks the
             row — and in a pile-up that is the whole of "which step am I on". -->
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
          :tabindex="offWindow(s) ? -1 : 0"
          :title="`${s.step.name} · ${dateOf(s)}${s.kind === 'entrance' ? ' — go into it' : ''}`"
          :style="{
            left: s.x + 'px',
            top: `calc(var(--lane-1) + ${s.lane} * var(--lane-h))`,
            '--z': markZ({
              on: events.stepId === s.step.id,
              cursor: cursorId === stationId(s.step.id),
              lane: s.lane,
            }),
          }"
          @click="press(s.step.id)"
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
              class="glyph descend"
              width="11"
              height="11"
              viewBox="-12 -12 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M-6 -3L0 3L6 -3" />
            </svg>
          </span>
          <!-- The name AND ITS DATE, with the room the layout could find them.
               The date does not shrink: a rule two rows up is a picture of the
               span, not an answer to "when was this one", and on a phone the
               reader can see two of its labels at a time. Where the slot is too
               narrow for both (`dated`) the name goes alone and the date comes
               back with the whole label — which is `asked`, the three states in
               which the reader is asking about ONE station and it is drawn over
               its neighbours. -->
          <span
            class="label"
            :class="{ free: asked(s.step.id) || !s.labelPx, flip: s.flip }"
            :style="{ maxWidth: (s.labelPx || 220) + 'px' }"
          >
            <span class="label-name">{{ s.step.name }}</span>
            <i v-if="s.dated || asked(s.step.id) || !s.labelPx" class="label-at tnum">{{
              dateOf(s)
            }}</i>
          </span>
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
  /*
   * THE WHOLE RAIL IS THE RAIL'S, not just the picture in it.
   *
   * `touch-action: none` used to sit on `.track` alone, and on a desktop that
   * is indistinguishable from this. On a phone it is not: the rail is 116px
   * tall and the top 26 of them are the breadcrumb and the Zoom / ‹ / Steps / ›
   * row, which is where a thumb reaching for "the timeline" lands about a fifth
   * of the time — and that row said `touch-action: auto`, so a pinch that
   * caught it was not the rail's gesture at all but the BROWSER'S. Measured
   * with real Touch events (tests/e2e/sagaRail.e2e.mjs): two fingers on the
   * head row took the visual viewport from scale 1 to scale 5 and the rail's
   * window never moved. A synthesised wheel could never have found it, because
   * a wheel is not what touch-action is about.
   *
   * The era rail has always had this line on its ROOT (TimelineBar.vue) and
   * that is why it pinches: it is one box with no interactive header on it.
   * This is the same recipe, on a component that grew a header.
   *
   * WebKit needs the `gesturestart` refusal above as well — touch-action does
   * not stand Safari's page zoom down. Two mechanisms because there are two
   * browsers, not because either is a fallback for the other.
   */
  touch-action: none;
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
  /* Given back what the rail's blanket `touch-action: none` takes away: this is
     a scroller (a phone's stack can be three deep and the trail runs off the
     row), and exactly one direction of it is a scroll rather than a rail
     gesture. Same reason, other axis, for `.list` below. */
  touch-action: pan-x;
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
/* The zoom control, and with it the whole of the rail's "this moves" cue. Two
   slow breaths on first mount and then it is furniture: an affordance that goes
   on waving is a nag, and the reader who has already zoomed knows. */
.zoom-btn.hint {
  animation: zoom-hint 2s var(--ease) 0.7s 2;
}
@keyframes zoom-hint {
  30% {
    border-color: var(--brass-line);
    color: var(--brass);
  }
  70% {
    border-color: var(--brass-line);
    color: var(--brass);
  }
}
.zoom-label {
  font-family: var(--cond);
  font-size: var(--t-eyebrow);
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
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
  /* The index is the control that has to be as long as the saga, so it scrolls
     — and it is inside the rail, whose `touch-action: none` would otherwise
     make a phone's flick through eleven steps do nothing at all. */
  touch-action: pan-y;
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

/* --- the track ---
   A window, not a scroller. `touch-action: none` is what makes the gestures
   the rail's own rather than the browser's — the same line the era rail
   carries, and for the same reason: a horizontal drag here is a pan over a
   span, and a pinch is a zoom, and neither may also be a page scroll. */
.track {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  touch-action: none;
  cursor: grab;
}
.track:active {
  cursor: grabbing;
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
  /* The priority is computed (`markZ`); this is only where it lands. */
  z-index: var(--z, 1);
}
/* A hover is a question, so it comes forward — but not past the answer: the
   open step (40) and the cursor (30) are set from --z by the rules below. */
.station:hover {
  z-index: 20;
}
.station.cursor,
.station.on {
  z-index: var(--z);
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
    background-color var(--fast),
    scale var(--fast);
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
/* …and it is LIFTED, in the app's brass language: a ring of the rail's own
   ground punches it out of whatever it has landed in the middle of, and the
   shadow under it says the mark is a layer above the pile rather than the
   brightest thing in it. In a three-deep crowd that is the difference between
   "which one am I on" being answered by colour alone and being answered. */
.station.on .mark {
  border-color: var(--brass);
  background: var(--brass);
  color: var(--void);
  box-shadow:
    0 0 0 3px rgba(6, 10, 18, 0.92),
    0 2px 8px rgba(0, 0, 0, 0.65),
    0 0 12px rgba(227, 167, 88, 0.55);
  /* `scale`, not `transform`: the mark is centred by a translate it must keep. */
  scale: 1.12;
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
  /* A row of two, because the two parts do not give room up equally: the NAME
     truncates and the DATE never does. A single ellipsised string would have
     eaten the date first, which is the one thing the reader asked for. */
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.03em;
  color: var(--frost-dim);
  white-space: nowrap;
  overflow: hidden;
  /* A map label's halo: the rule's gridlines and a neighbouring period's band
     both pass behind these names, and the dark ground cut around each glyph is
     what keeps the line from reading as a strike-through. */
  text-shadow:
    0 0 3px var(--void),
    0 0 2px var(--void);
  transition: color var(--fast);
  pointer-events: none;
}
.label-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.label-at {
  flex: none;
  font-size: var(--t-micro);
  font-style: normal;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.station.on .label {
  color: var(--brass);
}
.station.on .label-at {
  color: var(--brass);
  opacity: 0.85;
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
  justify-content: flex-end;
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
  /* A PHONE'S RAIL IS THE TALLER ONE (tokens.css: --rail under a saga).
     It has more to say than the era rail does — a rule, three lanes of marks,
     and a dated name beside each of them — and at 84px it said all of it in
     14px rows with the names touching the lane below. The extra pixels go
     into the lanes, which is where the crowding was. */
  .rail {
    --lane-1: 32px;
    --lane-h: 22px;
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
  .list-label,
  .zoom-label {
    display: none;
  }
  /* With their words gone these are icon buttons, so their glyphs are placed
     the way every other icon-only control's is — by geometry, not by asking a
     grid where the middle of a box with a hidden child in it is. See the icon
     rule in styles/tokens.css, and the pill's chevron, which is why it exists. */
  .list-btn,
  .zoom-btn {
    position: relative;
    padding: 0;
  }
  .list-btn > .glyph,
  .zoom-btn > .glyph {
    position: absolute;
    top: 50%;
    left: 50%;
    translate: -50% -50%;
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
