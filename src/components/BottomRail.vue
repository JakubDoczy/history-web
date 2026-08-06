<script setup lang="ts">
import { computed } from 'vue'
import { useEventStore } from '../stores/events'
import { sagaViewOf } from '../lib/present/saga'
import TimelineBar from './TimelineBar.vue'
import SagaTimeline from './SagaTimeline.vue'

/**
 * WHICH RAIL IS AT THE BOTTOM OF THE SCREEN — one decision, in one place.
 *
 * There are two of them and they are alternatives, not layers: the era rail is
 * a map of all of time, and the saga rail is a map of one event's span (see
 * components/SagaTimeline.vue for why the second cannot simply be a mode of the
 * first — none of the era rail's grammar survives inside a saga). What must not
 * happen is each of them deciding for itself whether it is on, because then
 * "which timeline is mounted" is a predicate written twice, and the frame on
 * which the two copies disagree is a frame with two rails or none.
 *
 * So this component exists to hold the question and nothing else. It has no
 * state; the answer is a resolution of the focus store — is the thing the map
 * is about a saga? — through the same resolver the pins, the pill and the panel
 * ask (`sagaViewOf`), and the resolved model is handed down as a prop so the
 * saga rail cannot go looking for a second opinion. The alternative shapes were
 * a mode switch inside TimelineBar (which would put the era rail's ResizeObserver,
 * pointer capture and pan/zoom gestures in the same component as a control that
 * has none of them) and a v-if in HomeView (which is the same predicate, but
 * written where every other unrelated thing is also mounted).
 *
 * The era rail is UNMOUNTED while a saga is up, rather than hidden. It holds no
 * state of its own — the window, the selection band and the cursor all live in
 * the time store — so it comes back showing exactly what it showed, including
 * the rule that the selected year is inside the window; and unmounting is what
 * guarantees its gestures cannot fire against a map that is not about time any
 * more.
 */
const events = useEventStore()

/** The saga on the map, or nothing — which is also "show the era rail". */
const saga = computed(() => sagaViewOf(events.focused))
</script>

<template>
  <!-- Keyed by the saga, because a descent is not a redraw of this rail: it is
       a different span, different stations, a different thing being read. The
       key re-anchors it whole — scroll, keyboard cursor and entrance — rather
       than leaving the component to unpick which of its own state survived. -->
  <SagaTimeline v-if="saga" :key="saga.id" :saga="saga" />
  <TimelineBar v-else />
</template>
