<script setup lang="ts">
import { onMounted, watchEffect } from 'vue'
import { useEventStore } from './stores/events'
import { useTimeStore } from './stores/time'
import { firstFrame } from './lib/firstFrame'

const events = useEventStore()
const time = useTimeStore()

// Event data streams in era-sized chunks; the visible window decides which.
//
// It starts once the globe has drawn, not on mount. The manifest, the spine and
// six chunks used to be requested alongside the basemap, and none of them draws
// anything until there is a planet to put pins on — so all they did to the first
// frame was take bandwidth off it. Pins arriving a beat after the planet is also
// the order they read in. See lib/firstFrame.ts (which has a deadline, so a page
// with no globe on it still gets its events).
onMounted(() => firstFrame.whenDrawn(() => events.init()))
watchEffect(() => events.ensure(time.range.start, time.range.end))

// And focus mode ends when its subject leaves the timeline. The two stores are
// composed here, as they are above and as the era pickers do it (TopBar.vue):
// time knows nothing about events, events do not watch the clock, and this file
// is already where "the window moved, so…" is spelled out.
//
// The band, not the cursor: the band is what culls the pins, so it is what says
// whether the focused item is on screen at all. Stepping through the stages of
// an operation moves the cursor alone and never disturbs the mode.
watchEffect(() => events.dropFocusOffTimeline(time.selection.start, time.selection.end))
</script>

<template>
  <RouterView />
</template>
