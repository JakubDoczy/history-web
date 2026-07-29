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

const ui = useUiStore()
const settings = useSettingsStore()

const onKey = (e: KeyboardEvent) => e.key === 'Escape' && ui.close()
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <GlobeView />
  <div v-if="ui.search || ui.settings" class="backdrop" @click="ui.close()" />
  <TopBar />
  <SearchBox v-if="ui.search" />
  <SettingsPanel v-if="ui.settings" />
  <ScaleBar v-if="settings.scaleBar" />
  <EventPanel />
  <TimelineBar />
</template>

<style scoped>
.backdrop {
  position: absolute;
  inset: 0;
  z-index: 4;
}
</style>
