<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, useTemplateRef } from 'vue'
import { useTimeStore } from '../stores/time'
import { useEventStore } from '../stores/events'
import { formatYear, toWarp, fromWarp, type Year } from '../lib/time'
import { bandsFor, subBandsFor, subLaneOpen, spanEraLabel } from '../lib/eras'
import { flagSide, mergedEdge } from '../lib/selection'

const time = useTimeStore()
const events = useEventStore()
const el = useTemplateRef('el')
const width = ref(1)

let resizeObs: ResizeObserver
onMounted(() => {
  width.value = el.value!.clientWidth
  resizeObs = new ResizeObserver(() => (width.value = el.value!.clientWidth))
  resizeObs.observe(el.value!)
})
onBeforeUnmount(() => resizeObs.disconnect())

const ws = () => toWarp(time.range.start)
const we = () => toWarp(time.range.end)
const toX = (t: Year) => ((toWarp(t) - ws()) / (we() - ws())) * width.value
const toT = (x: number): Year => fromWarp(ws() + (x / width.value) * (we() - ws()))

/** Ticks uniform in display space, each snapped to a locally-round year. */
const ticks = computed(() => {
  const [a, b] = [ws(), we()]
  const n = Math.max(2, Math.floor(width.value / 110))
  const out: Year[] = []
  for (let i = 0; i <= n; i++) {
    const u = a + ((b - a) * i) / n
    const local = fromWarp(u + (b - a) / n) - fromWarp(u)
    const step = 10 ** Math.floor(Math.log10(Math.max(1, Math.abs(local))))
    const t = Math.round(fromWarp(u) / step) * step
    if (t !== out[out.length - 1]) out.push(t)
  }
  return out
})

/** Era bands clipped to the visible window, in pixels. */
const clipped = (bands: ReturnType<typeof bandsFor>) =>
  bands.map((e) => {
    const x0 = Math.max(0, toX(e.start))
    const x1 = Math.min(width.value, toX(e.end))
    return { ...e, x: x0, w: Math.max(0, x1 - x0) }
  })

/** Era strata clipped to the visible window. */
const strata = computed(() => clipped(bandsFor(time.range.start, time.range.end)))

/**
 * The fine lane: named sub-periods, present only when zoomed in far enough.
 * It is a *second* row rather than a replacement for the strata above it,
 * because the sub-age thread has gaps in it — an unnamed century would leave
 * the rail with no era band at all, and the point of the strip is that you can
 * always read where you are.
 */
const subStrata = computed(() => clipped(subBandsFor(time.range.start, time.range.end)))

/** Whether the lane gets its row. Zoom decides, not content: see subLaneOpen. */
const subLane = computed(() => subLaneOpen(time.range.start, time.range.end))

/** The highlighted selection band, in pixels. */
const sel = computed(() => {
  const x0 = toX(time.selection.start)
  const x1 = toX(time.selection.end)
  return { x0, x1, w: Math.max(0, x1 - x0) }
})

/**
 * Cursor and selection edge, merged.
 *
 * The handle is a 9 px cap and the cursor a 1 px line with a knob that straddles
 * it, so a cursor sitting *on* an edge draws two glyphs a few pixels apart and
 * the ember one appears to be outside the band it is exactly on the boundary of.
 * Within `EDGE_MERGE_PX` the two become a single marker: the handle takes the
 * ember, the cursor drops its line and knob, and the flag — the only part that
 * says which year this is — hangs off the handle, pointing into the band.
 */
const merged = computed(() => mergedEdge(toX(time.currentTime), sel.value.x0, sel.value.x1))

/** Where the marker is drawn: snapped onto the edge when merged, so the year
 *  flag and the handle cannot disagree by the two pixels that started this. */
const markerX = computed(() =>
  merged.value === 'start' ? sel.value.x0 : merged.value === 'end' ? sel.value.x1 : toX(time.currentTime),
)
const flagFlipped = computed(() => flagSide(markerX.value, width.value, merged.value) === 'left')

/** The readout stands down when the cursor's flag would sit on top of it. */
const selLabelShown = computed(
  () => sel.value.w > 108 && Math.abs(toX(time.currentTime) - (sel.value.x0 + sel.value.x1) / 2) > 74,
)

/** One readout for the band: the years, plus the era(s) they cover when there is room. */
const selLabel = computed(() => {
  const years = `${formatYear(time.selection.start)} – ${formatYear(time.selection.end)}`
  return sel.value.w > 250
    ? `${spanEraLabel(time.selection.start, time.selection.end)} · ${years}`
    : years
})

/** Pointer x within the rail. Not offsetX: bands and handles are event targets
 *  of their own, and offsetX would then be measured from the wrong box. */
const localX = (e: PointerEvent | WheelEvent) => e.clientX - el.value!.getBoundingClientRect().left

// --- selection handles: they own their pointer, so the rail never sees a pan ---
const dragEdge = ref<'start' | 'end' | null>(null)
let anchor: Year = 0 // the edge that stays put; a drag past it simply swaps the two

function onHandleDown(edge: 'start' | 'end', e: PointerEvent) {
  dragEdge.value = edge
  anchor = edge === 'start' ? time.selection.end : time.selection.start
  ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
}
function onHandleMove(e: PointerEvent) {
  if (!dragEdge.value) return
  time.setSelection(anchor, toT(localX(e)))
}
function onHandleUp(e: PointerEvent) {
  if (!dragEdge.value) return
  dragEdge.value = null
  ;(e.currentTarget as Element).releasePointerCapture(e.pointerId)
}

// --- interactions: drag = pan, pinch/wheel = zoom, click = set time ---
const pointers = new Map<number, number>()
let dragged = false
/**
 * The sub-age band a press landed on, if any — the rail's own pointer capture
 * means the *up* event is reported against the rail whatever it is over, so the
 * band has to be remembered from the press.
 *
 * A tap on the fine lane selects that period rather than setting the cursor;
 * a drag from it still pans, which is why this hangs off the existing gesture
 * instead of the band swallowing the pointer with `.stop`.
 */
let pressedSub: string | null = null
const subByName = computed(() => new Map(subStrata.value.map((s) => [s.name, s])))
const dist = () => {
  const [a, b] = [...pointers.values()]
  return Math.max(1, Math.abs(b - a))
}

function onPointerDown(e: PointerEvent) {
  pointers.set(e.pointerId, localX(e))
  dragged = false
  pressedSub =
    ((e.target as Element | null)?.closest?.('.band.sub') as HTMLElement | null)?.dataset.era ??
    null
  el.value!.setPointerCapture(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return
  if (pointers.size === 1) {
    const dx = localX(e) - pointers.get(e.pointerId)!
    if (Math.abs(dx) > 2) dragged = true
    time.pan(-dx / width.value)
  } else if (pointers.size === 2) {
    dragged = true
    const before = dist()
    pointers.set(e.pointerId, localX(e))
    const [a, b] = [...pointers.values()]
    time.zoom(before / dist(), (a + b) / 2 / width.value)
    return
  }
  pointers.set(e.pointerId, localX(e))
}
function onPointerUp(e: PointerEvent) {
  pointers.delete(e.pointerId)
  if (dragged || pointers.size) return
  const sub = pressedSub && subByName.value.get(pressedSub)
  // Tapping an age on the rail is the same statement as picking one from the
  // menu (TopBar.vue): a question about the world in that time, answered on a
  // clean map — so focus mode and the open panel go with it. Scrubbing the
  // cursor is not that statement and leaves both alone.
  if (sub) {
    events.dismiss()
    time.selectEra(sub)
  } else time.setTime(toT(localX(e)))
}
function onWheel(e: WheelEvent) {
  time.zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, localX(e) / width.value)
}
</script>

<template>
  <div
    ref="el"
    class="rail"
    :class="{ subs: subLane }"
    aria-label="Timeline — drag to pan, scroll or pinch to zoom"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel.prevent="onWheel"
  >
    <!-- strata: the geological/historical column, laid horizontal -->
    <div class="strata">
      <div
        v-for="s in strata"
        :key="s.name"
        class="band"
        :title="s.name"
        :style="{ left: s.x + 'px', width: s.w + 'px', background: s.color }"
      >
        <!-- only label a band wide enough for the whole word; a clipped era name is worse than none -->
        <span v-if="s.w > s.name.length * 7 + 14">{{ s.name }}</span>
      </div>
    </div>

    <!-- sub-ages: the fine lane, only present when the window is narrow enough -->
    <div v-if="subLane" class="sub-strata">
      <div
        v-for="s in subStrata"
        :key="s.name"
        class="band sub"
        :title="`${s.name} — tap to select`"
        :data-era="s.name"
        :style="{ left: s.x + 'px', width: s.w + 'px', background: s.color }"
      >
        <span v-if="s.w > s.name.length * 7 + 14">{{ s.name }}</span>
      </div>
    </div>

    <div class="ruler">
      <div v-for="t in ticks" :key="t" class="tick" :style="{ left: toX(t) + 'px' }">
        <span class="tnum">{{ formatYear(t) }}</span>
      </div>
    </div>

    <!-- selection: the display filter. Patina, so it never reads as the ember cursor.
         The scrims outside it do most of the work — the band reads as the lit part. -->
    <!-- clamped to the rail: during an era fit the band is briefly wider than the
         window it is being flown into, and an unclamped right-hand scrim at a
         negative x would cover the whole rail rather than none of it -->
    <div class="scrim" :style="{ left: '0px', width: Math.min(width, Math.max(0, sel.x0)) + 'px' }" />
    <div
      class="scrim"
      :style="{ left: Math.min(width, Math.max(0, sel.x1)) + 'px', right: '0px' }"
    />
    <div class="sel" :style="{ left: sel.x0 + 'px', width: sel.w + 'px' }">
      <span v-if="selLabelShown" class="sel-label tnum">{{ selLabel }}</span>
    </div>
    <div
      v-for="edge in (['start', 'end'] as const)"
      :key="edge"
      class="handle"
      :class="[edge, { dragging: dragEdge === edge, merged: merged === edge }]"
      role="slider"
      :aria-label="`Selection ${edge}`"
      :aria-valuenow="time.selection[edge]"
      :style="{ left: (edge === 'start' ? sel.x0 : sel.x1) + 'px' }"
      @pointerdown.stop="onHandleDown(edge, $event)"
      @pointermove.stop="onHandleMove"
      @pointerup.stop="onHandleUp"
      @pointercancel.stop="onHandleUp"
    >
      <span class="grip" />
    </div>

    <div
      class="cursor"
      :class="{ flip: flagFlipped, merged: !!merged }"
      :style="{ left: markerX + 'px' }"
    >
      <span class="knob" />
      <span class="flag tnum">{{ formatYear(time.currentTime) }}</span>
    </div>
  </div>
</template>

<style scoped>
.rail {
  --band-h: 22px;
  --sub-h: 0px;
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: calc(var(--rail) + var(--safe-b));
  padding-bottom: var(--safe-b);
  box-sizing: border-box;
  background: linear-gradient(180deg, rgba(6, 10, 18, 0.55), rgba(6, 10, 18, 0.97) 42%);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-top: 1px solid var(--line);
  cursor: grab;
  touch-action: none;
  overflow: hidden;
  user-select: none;
  z-index: var(--z-timeline);
}
.rail:active {
  cursor: grabbing;
}
/* The fine lane costs 14px, and the rail cannot grow — panels above it are laid
   out against --rail. The main band gives up 6px of its height for it; the rest
   comes out of the ruler, which has the slack. */
.rail.subs {
  --band-h: 16px;
  --sub-h: 14px;
}

.strata {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--band-h);
  /* a hairline of shadow under the strip separates it from the ruler */
  box-shadow: 0 1px 0 rgba(6, 10, 18, 0.9);
}
.band {
  position: absolute;
  top: 0;
  height: 100%;
  display: grid;
  place-items: center;
  border-right: 1px solid rgba(6, 10, 18, 0.5);
  overflow: hidden;
}
/* darken the foot of each band so the label always has something to sit on */
.band::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(0, 0, 0, 0.28));
}
/* the fine lane: its own strip under the strata, dark where no period is named */
.sub-strata {
  position: absolute;
  top: var(--band-h);
  left: 0;
  right: 0;
  height: var(--sub-h);
  background: rgba(6, 10, 18, 0.6);
  box-shadow: 0 1px 0 rgba(6, 10, 18, 0.9);
}
.band.sub {
  border-right: 0;
  box-shadow: inset -1px 0 0 rgba(6, 10, 18, 0.5);
}
/* flatter than the strata above: the fine lane is a footnote to it, not a rival */
.band.sub::after {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(0, 0, 0, 0.2));
}
/* the fine lane is a control as well as a label: a tap on a period selects it */
.band.sub {
  cursor: pointer;
}
.band.sub:hover::after {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.2), rgba(0, 0, 0, 0.08));
}
.band.sub span {
  font-size: 9px;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.92);
  padding: 0 4px;
}

.band span {
  position: relative;
  font-family: var(--cond);
  font-size: var(--t-micro);
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.75);
  white-space: nowrap;
  padding: 0 6px;
}

.ruler {
  position: absolute;
  top: calc(var(--band-h) + var(--sub-h));
  bottom: var(--safe-b);
  left: 0;
  right: 0;
}
.tick {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--line-soft);
  pointer-events: none;
}
/* a stronger stub at the top of each gridline reads as a real ruler */
.tick::before {
  content: '';
  position: absolute;
  top: 0;
  left: -1px;
  width: 1px;
  height: 8px;
  background: var(--line);
}
.tick span {
  position: absolute;
  top: 5px;
  left: 7px;
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.06em;
  color: var(--frost-dim);
  white-space: nowrap;
}

/* --- selection band + handles --- */
.scrim {
  position: absolute;
  top: 0;
  bottom: var(--safe-b);
  background: rgba(6, 10, 18, 0.55);
  pointer-events: none; /* scrims and band are readouts; only the handles take input */
}
.sel {
  position: absolute;
  top: calc(var(--band-h) + var(--sub-h));
  bottom: var(--safe-b);
  background: linear-gradient(180deg, rgba(111, 179, 168, 0.22), rgba(111, 179, 168, 0.06));
  box-shadow: inset 0 1px 0 rgba(111, 179, 168, 0.28);
  pointer-events: none;
}
/* the readout sits in the empty lane between the tick numbers and the cursor flag */
.sel-label {
  position: absolute;
  top: 26px;
  left: 50%;
  transform: translateX(-50%);
  font-family: var(--cond);
  font-size: var(--t-micro);
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--patina);
  white-space: nowrap;
  text-shadow: 0 1px 3px rgba(6, 10, 18, 0.9);
}
/* the lane pushes the selection band down; the readout stays where it was, in
   the gap between the tick numbers and the cursor flag — the only space for it */
.rail.subs .sel-label {
  top: 18px;
}

.handle {
  position: absolute;
  top: 0;
  bottom: var(--safe-b);
  width: 40px; /* touch target; the visible grip inside is a hairline */
  display: grid;
  align-items: center;
  cursor: ew-resize;
  touch-action: none;
}
/* Each target reaches outward from its edge rather than straddling it, so the
   two never overlap — a selection squeezed to its minimum width still has two
   separately grabbable handles on a touch screen. */
.handle.start {
  margin-left: -34px;
  justify-items: end;
}
.handle.end {
  margin-left: -6px;
  justify-items: start;
}
.grip {
  position: relative;
  width: 3px;
  height: 100%;
  background: var(--patina);
  box-shadow: 0 0 8px rgba(111, 179, 168, 0.45);
  transition: background-color var(--fast);
}
/* a stubby cap top and bottom reads as something you can take hold of */
.grip::before,
.grip::after {
  content: '';
  position: absolute;
  left: -3px;
  width: 9px;
  height: 12px;
  background: var(--patina);
  border-radius: 2px;
}
.grip::before {
  top: 0;
}
.grip::after {
  bottom: 0;
}
.handle:hover .grip,
.handle.dragging .grip {
  background: #9fe0d4;
}
.handle:hover .grip::before,
.handle:hover .grip::after,
.handle.dragging .grip::before,
.handle.dragging .grip::after {
  background: #9fe0d4;
}

/* --- the merged marker ---
   One glyph, not two: the handle borrows the cursor's ember and its glow, and
   the cursor gives up everything except the flag — which is the only part that
   says *which year*, and which now hangs off the handle. Nothing moves by more
   than the few pixels the two were apart, so the merge reads as the pair
   snapping together rather than as a mode change. */
.handle.merged .grip,
.handle.merged .grip::before,
.handle.merged .grip::after {
  background: var(--ember);
}
.handle.merged .grip {
  box-shadow: 0 0 10px rgba(226, 101, 62, 0.7);
}
.handle.merged:hover .grip,
.handle.merged.dragging .grip,
.handle.merged:hover .grip::before,
.handle.merged:hover .grip::after,
.handle.merged.dragging .grip::before,
.handle.merged.dragging .grip::after {
  background: #f4a07a;
}

.cursor {
  position: absolute;
  top: 0;
  bottom: var(--safe-b);
  width: 1px;
  background: var(--ember);
  box-shadow: 0 0 10px rgba(226, 101, 62, 0.7);
  pointer-events: none;
}
/* merged: the handle is the marker now, so the line and its knob would only be
   the second glyph again — three pixels wide and just outside the band. */
.cursor.merged {
  background: transparent;
  box-shadow: none;
}
.cursor.merged .knob {
  display: none;
}
/* clear of the handle's cap (9px), which the plain cursor does not have to be */
.cursor.merged .flag {
  left: 13px;
}
.cursor.merged.flip .flag {
  left: auto;
  right: 13px;
}
.knob {
  position: absolute;
  top: -1px;
  left: -3px;
  width: 7px;
  height: 7px;
  background: var(--ember);
  border-radius: 0 0 4px 4px;
}
.flag {
  position: absolute;
  bottom: 9px;
  left: 6px;
  font-family: var(--cond);
  font-size: var(--t-xs);
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--void);
  background: var(--ember);
  padding: 2px 7px;
  border-radius: 4px;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(226, 101, 62, 0.35);
}
/* near the right edge the label would be clipped, so hang it on the other side */
.cursor.flip .flag {
  left: auto;
  right: 6px;
}
</style>
