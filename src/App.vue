<script setup lang="ts">
import { onMounted, watchEffect } from 'vue'
import { useEventStore } from './stores/events'
import { useTimeStore } from './stores/time'

const events = useEventStore()
const time = useTimeStore()

// Event data streams in era-sized chunks; the visible window decides which.
onMounted(() => events.init())
watchEffect(() => events.ensure(time.range.start, time.range.end))
</script>

<template>
  <RouterView />
</template>
