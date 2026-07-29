<script setup lang="ts">
import { computed } from 'vue'
import { useEventStore } from '../stores/events'
import { useTimeStore } from '../stores/time'
import { formatYear } from '../lib/time'
import { renderRichText } from '../lib/richtext'

const events = useEventStore()
const time = useTimeStore()

const e = computed(() => events.selected!)
const when = computed(() =>
  e.value.end ? `${formatYear(e.value.start)} – ${formatYear(e.value.end)}` : formatYear(e.value.start),
)
const children = computed(() => events.childrenOf(e.value.id))

function goTo(id: string) {
  const target = events.byId(id)
  if (!target) return
  events.select(id)
  time.setTime(target.start)
}
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
  <article v-if="events.selected" class="sheet panel">
    <button class="close" aria-label="Close" @click="events.select()">×</button>

    <nav v-if="e.parent" class="crumb">
      <a @click="goTo(e.parent!)">{{ events.byId(e.parent!)?.name }}</a>
    </nav>

    <h2>{{ e.name }}</h2>
    <p class="when">{{ when }}</p>

    <figure v-if="e.image">
      <img
        :src="e.image.url"
        :alt="e.image.caption ?? e.name"
        @error="($event.target as HTMLElement).parentElement!.style.display = 'none'"
      />
      <figcaption v-if="e.image.caption">{{ e.image.caption }}</figcaption>
    </figure>

    <div v-if="e.body" class="body" @click="onBodyClick" v-html="renderRichText(e.body)" />
    <p v-else class="body"><span>{{ e.summary }}</span></p>

    <div v-if="children.length" class="block">
      <span class="eyebrow">Part of this event</span>
      <ul>
        <li v-for="c in children" :key="c.id">
          <a @click="goTo(c.id)">{{ c.name }}</a>
          <span class="year">{{ formatYear(c.start) }}</span>
        </li>
      </ul>
    </div>

    <div v-if="e.links?.length" class="block">
      <span class="eyebrow">Read more</span>
      <p class="links"><a v-for="l in e.links" :key="l.label" @click.prevent="follow(l)">{{ l.label }}</a></p>
    </div>

    <div class="tags">
      <button v-for="t in e.tags" :key="t" @click="events.toggleTag(t)">{{ t }}</button>
    </div>

    <button
      v-if="e.parent || children.length"
      class="family"
      @click="events.setParentFilter(e.parent ?? e.id)"
    >
      Show only this event family
    </button>
  </article>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 60px;
  left: 16px;
  width: min(360px, calc(100vw - 32px));
  max-height: calc(100% - var(--rail) - 76px);
  overflow-y: auto;
  padding: 18px 20px 20px;
  z-index: 5;
}
.close {
  position: absolute;
  top: 10px;
  right: 12px;
  background: none;
  border: none;
  color: var(--muted);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
.close:hover { color: var(--frost); }

.crumb { margin-bottom: 6px; }
.crumb a::before { content: '↑ '; }
h2 {
  margin: 0;
  font-family: var(--serif);
  font-weight: 600;
  font-size: 21px;
  line-height: 1.25;
  padding-right: 20px;
}
.when {
  margin: 4px 0 14px;
  font-family: var(--cond);
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--brass);
}
figure { margin: 0 0 14px; }
img { width: 100%; border-radius: 8px; display: block; }
figcaption { margin-top: 6px; font-size: 11px; color: var(--muted); font-style: italic; }

.body { font-family: var(--serif); font-size: 14.5px; line-height: 1.62; color: #dde5f0; }
.body :deep(p) { margin: 0 0 0.85em; }

.block { margin-top: 16px; display: grid; gap: 6px; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
li { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; }
.year { color: var(--muted); font-family: var(--cond); font-size: 11px; }
a { color: var(--patina); cursor: pointer; text-decoration: none; border-bottom: 1px solid rgba(111, 179, 168, 0.4); }
a:hover { color: var(--frost); border-color: var(--frost); }
.links a { margin-right: 14px; }
.body :deep(a) { color: var(--patina); cursor: pointer; text-decoration: none; border-bottom: 1px solid rgba(111, 179, 168, 0.4); }

.tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 16px; }
.tags button {
  font-family: var(--cond);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  padding: 2px 10px;
  cursor: pointer;
}
.tags button:hover { color: var(--brass); border-color: var(--brass); }

.family {
  margin-top: 14px;
  width: 100%;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--frost);
  padding: 7px;
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color 0.15s var(--ease);
}
.family:hover { border-color: var(--brass); color: var(--brass); }

@media (max-width: 640px) {
  .panel {
    top: auto;
    bottom: calc(var(--rail) + 12px);
    left: 16px;
    right: 16px;
    width: auto;
    max-height: 52vh;
  }
}
</style>
