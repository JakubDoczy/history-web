<script setup lang="ts">
import GlobeView from '../components/GlobeView.vue'
import TopBar from '../components/TopBar.vue'
import TimelineBar from '../components/TimelineBar.vue'
import EventPanel from '../components/EventPanel.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
import SearchBox from '../components/SearchBox.vue'
import ScaleBar from '../components/ScaleBar.vue'
import { useSettingsStore } from '../stores/settings'
import { onMounted, onBeforeUnmount } from 'vue'
import { useUiStore } from '../stores/ui'
import { useEventStore } from '../stores/events'

const ui = useUiStore()
const settings = useSettingsStore()
const events = useEventStore()

/**
 * Escape unwinds the app one layer at a time, outermost first: an open pop-over,
 * then focus mode. It deliberately stops there rather than going on to clear the
 * selection — one key press should undo one thing, and losing the article you
 * were reading because you wanted the map back is not what was asked for.
 */
const onKey = (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return
  if (ui.search || ui.settings) ui.close()
  else if (events.focus) events.exitFocus()
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
  <EventPanel />
  <TimelineBar />
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
