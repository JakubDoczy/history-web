<script setup lang="ts">
import GlobeView from '../components/GlobeView.vue'
import { useTimeStore } from '../stores/time'
import { formatYear } from '../lib/time'

const time = useTimeStore()
</script>

<template>
  <GlobeView />
  <div class="readout">{{ formatYear(time.currentTime) }}</div>
</template>

<style scoped>
.readout {
  position: absolute;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  color: #fff;
  font-size: 1.25rem;
  text-shadow: 0 0 6px #000;
  user-select: none;
}
</style>
