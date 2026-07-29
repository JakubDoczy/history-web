<script setup lang="ts">
import GlobeView from '../components/GlobeView.vue'
import TopBar from '../components/TopBar.vue'
import TimelineBar from '../components/TimelineBar.vue'
import EventPanel from '../components/EventPanel.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
import SearchBox from '../components/SearchBox.vue'
import { useUiStore } from '../stores/ui'

const ui = useUiStore()
</script>

<template>
  <GlobeView />
  <TopBar />
  <SearchBox v-if="ui.search" />
  <SettingsPanel v-if="ui.settings" />
  <EventPanel />
  <TimelineBar />
</template>
