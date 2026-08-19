<script setup lang="ts">
import GlobeView from '../components/GlobeView.vue'
import TopBar from '../components/TopBar.vue'
import BottomRail from '../components/BottomRail.vue'
import EventPanel from '../components/EventPanel.vue'
import PointChip from '../components/PointChip.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
import SearchBox from '../components/SearchBox.vue'
import ScaleBar from '../components/ScaleBar.vue'
import ModeToggle from '../components/ModeToggle.vue'
import UpdateToast from '../components/UpdateToast.vue'
import WikiReader from '../components/WikiReader.vue'
import { useSettingsStore } from '../stores/settings'
import { onMounted, onBeforeUnmount } from 'vue'
import { useUiStore } from '../stores/ui'
import { useEventStore } from '../stores/events'

const ui = useUiStore()
const settings = useSettingsStore()
const events = useEventStore()

/**
 * Escape unwinds the app one layer at a time, outermost first: an open pop-over,
 * then focus mode — and focus mode is itself a stack, so `focusBack` takes one
 * rung of that (the part being read inside a saga, then the saga
 * itself, then whatever it was opened from). It deliberately stops before
 * clearing the selection — one key press should undo one thing, and losing the
 * article you were reading because you wanted the map back is not what was
 * asked for.
 *
 * ABOVE THIS LADDER SITS THE ARTICLE READER (components/WikiReader.vue). It is
 * a modal, so while it is open Escape means "close the modal" and nothing else;
 * it takes the press in the CAPTURE phase on `window` and stops it, so nothing
 * here runs. Stated rather than duplicated: this file has no test for the
 * reader's state, and the layering is a property of when the two listeners run.
 */
const onKey = (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return
  if (ui.search || ui.settings) ui.close()
  else if (events.focus) events.focusBack()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <GlobeView />
  <Transition name="fade">
    <div v-if="ui.search || ui.settings" class="backdrop" @click="ui.close()" />
  </Transition>
  <TopBar />
  <Transition name="pop">
    <SearchBox v-if="ui.search" />
  </Transition>
  <Transition name="pop">
    <SettingsPanel v-if="ui.settings" />
  </Transition>
  <Transition name="fade">
    <ScaleBar v-if="settings.scaleBar" />
  </Transition>
  <!-- Globe or map, on the edge of the screen where the thing it changes is.
       The same `settings.mode` the Display panel writes — one setting, shown
       in two places. See components/ModeToggle.vue. -->
  <ModeToggle />
  <EventPanel />
  <!-- The info chip a clicked POINT opens — a named place, not an event, so
       not the event panel. See components/PointChip.vue and lib/points.ts. -->
  <PointChip />
  <BottomRail />
  <!-- The Wikipedia article, read inside the app, on a desktop. Mounted here
       rather than inside the panel that opens it: it is a modal over the whole
       window (scrim included), and the panel is one of the things it covers.
       See components/WikiReader.vue. -->
  <WikiReader />
  <!-- Not about the world on the map: about the page itself. See
       components/UpdateToast.vue and lib/build.ts. -->
  <UpdateToast />
</template>

<style scoped>
.backdrop {
  position: absolute;
  inset: 0;
  z-index: var(--z-backdrop);
}
@media (max-width: 640px) {
  /* on a small screen the open panel is the subject; dim what's behind it */
  .backdrop {
    background: rgba(6, 10, 18, 0.42);
  }
}
</style>
