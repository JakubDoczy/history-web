<script setup lang="ts">
import GlobeView from '../components/GlobeView.vue'
import TopBar from '../components/TopBar.vue'
import TimelineBar from '../components/TimelineBar.vue'
import EventPanel from '../components/EventPanel.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
import SearchBox from '../components/SearchBox.vue'
import ScaleBar from '../components/ScaleBar.vue'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'

const ui = useUiStore()
const settings = useSettingsStore()
</script>

<template>
  <GlobeView />
  <TopBar />
  <SearchBox v-if="ui.search" />
  <SettingsPanel v-if="ui.settings" />
  <ScaleBar v-if="settings.scaleBar" />
  <EventPanel />
  <TimelineBar />
</template>
