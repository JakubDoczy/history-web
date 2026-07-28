<script setup lang="ts">
import { useEventStore } from '../stores/events'
import { useTimeStore } from '../stores/time'
import { formatYear } from '../lib/time'
import { renderRichText } from '../lib/richtext'

const events = useEventStore()
const time = useTimeStore()

const when = () => {
  const e = events.selected!
  return e.end ? `${formatYear(e.start)} – ${formatYear(e.end)}` : formatYear(e.start)
}

function goTo(id: string) {
  const target = events.byId(id)
  if (!target) return
  events.select(id)
  time.setTime(target.start)
}

/** Delegated handler for internal links inside rendered rich text. */
function onBodyClick(ev: MouseEvent) {
  const id = (ev.target as HTMLElement).dataset?.event
  if (id) goTo(id)
}

function follow(link: { event?: string; url?: string }) {
  if (link.event) goTo(link.event)
  else if (link.url) window.open(link.url, '_blank')
}
</script>

<template>
  <aside v-if="events.selected" class="panel">
    <button class="close" @click="events.select()">×</button>

    <p v-if="events.selected.parent" class="crumb">
      ↑ <a @click="goTo(events.selected.parent!)">{{ events.byId(events.selected.parent!)?.name }}</a>
    </p>

    <h2>{{ events.selected.name }}</h2>
    <p class="when">{{ when() }}</p>
    <p class="tags">
      <span v-for="t in events.selected.tags" :key="t" class="tag" @click="events.toggleTag(t)">{{ t }}</span>
    </p>

    <figure v-if="events.selected.image">
      <img
        :src="events.selected.image.url"
        :alt="events.selected.image.caption ?? events.selected.name"
        @error="($event.target as HTMLElement).parentElement!.style.display = 'none'"
      />
      <figcaption v-if="events.selected.image.caption">{{ events.selected.image.caption }}</figcaption>
    </figure>

    <div v-if="events.selected.body" class="body" @click="onBodyClick" v-html="renderRichText(events.selected.body)" />
    <p v-else>{{ events.selected.summary }}</p>

    <p v-if="events.childrenOf(events.selected.id).length" class="children">
      Related:
      <a v-for="c in events.childrenOf(events.selected.id)" :key="c.id" @click="goTo(c.id)">{{ c.name }}</a>
    </p>

    <p v-if="events.selected.links?.length" class="links">
      <a v-for="l in events.selected.links" :key="l.label" @click.prevent="follow(l)">{{ l.label }}</a>
    </p>

    <button
      v-if="events.selected.parent || events.childrenOf(events.selected.id).length"
      class="family"
      @click="events.setParentFilter(events.selected.parent ?? events.selected.id)"
    >Filter to this event family</button>
  </aside>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 1rem;
  right: 1rem;
  width: min(340px, 85vw);
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
.crumb { margin: 0 0 0.5rem; font-size: 0.85rem; color: #9ab; }
.tag { display: inline-block; background: #234; border-radius: 4px; padding: 1px 8px; margin-right: 6px; font-size: 0.8rem; cursor: pointer; }
figure { margin: 0.5rem 0; }
img { width: 100%; border-radius: 6px; }
figcaption { font-size: 0.75rem; color: #9ab; }
.body :deep(p) { margin: 0.5rem 0; }
.body :deep(a), .children a, .links a, .crumb a { color: #6cf; margin-right: 0.75rem; cursor: pointer; text-decoration: underline; }
.family { margin-top: 0.5rem; background: #234; border: 1px solid #456; border-radius: 6px; color: #dde; padding: 4px 10px; cursor: pointer; }
</style>
