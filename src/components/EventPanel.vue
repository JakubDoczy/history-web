<script setup lang="ts">
import { useEventStore } from '../stores/events'
import { useTimeStore } from '../stores/time'
import { formatYear } from '../lib/time'

const events = useEventStore()
const time = useTimeStore()

const when = () => {
  const e = events.selected!
  return e.end ? `${formatYear(e.start)} – ${formatYear(e.end)}` : formatYear(e.start)
}

function follow(link: { event?: string; url?: string }) {
  if (link.event) {
    events.select(link.event)
    const target = events.all.find((e) => e.id === link.event)
    if (target) time.setTime(target.start)
  } else if (link.url) {
    window.open(link.url, '_blank')
  }
}
</script>

<template>
  <aside v-if="events.selected" class="panel">
    <button class="close" @click="events.select()">×</button>
    <h2>{{ events.selected.name }}</h2>
    <p class="when">{{ when() }}</p>
    <p class="tags">
      <span v-for="t in events.selected.tags" :key="t" class="tag" @click="events.toggleTag(t)">{{ t }}</span>
    </p>
    <p>{{ events.selected.summary }}</p>
    <p v-if="events.selected.links?.length" class="links">
      <a v-for="l in events.selected.links" :key="l.label" @click.prevent="follow(l)">{{ l.label }}</a>
    </p>
  </aside>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 1rem;
  right: 1rem;
  width: min(320px, 85vw);
  max-height: calc(100% - 8rem);
  overflow-y: auto;
  background: rgba(10, 15, 25, 0.92);
  border: 1px solid #345;
  border-radius: 8px;
  padding: 1rem;
  color: #dde;
}
.close { position: absolute; top: 4px; right: 8px; background: none; border: none; color: #9ab; font-size: 1.4rem; cursor: pointer; }
h2 { margin: 0 0 0.25rem; font-size: 1.1rem; }
.when { color: #f80; margin: 0 0 0.5rem; }
.tag { display: inline-block; background: #234; border-radius: 4px; padding: 1px 8px; margin-right: 6px; font-size: 0.8rem; cursor: pointer; }
.links a { color: #6cf; margin-right: 1rem; cursor: pointer; text-decoration: underline; }
</style>
