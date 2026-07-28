<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsStore } from '../stores/settings'

const settings = useSettingsStore()
const label = computed(() => {
  const h = Math.floor(settings.sunHour)
  const m = Math.round((settings.sunHour - h) * 60)
  return `☀ ${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')} UTC`
})
</script>

<template>
  <div class="sun">
    <span>{{ label }}</span>
    <input v-model.number="settings.sunHour" type="range" min="0" max="24" step="0.25" />
  </div>
</template>

<style scoped>
.sun {
  position: absolute;
  right: 1rem;
  bottom: 80px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(10, 15, 25, 0.85);
  border: 1px solid #345;
  border-radius: 12px;
  padding: 4px 10px;
  color: #9ab;
  font-size: 0.8rem;
}
input { width: 120px; accent-color: #f80; }
</style>
