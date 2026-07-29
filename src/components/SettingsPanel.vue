<script setup lang="ts">
import { useEventStore } from '../stores/events'
import { useNationStore } from '../stores/nations'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useViewStore } from '../stores/view'

const events = useEventStore()
const nations = useNationStore()
const settings = useSettingsStore()
const ui = useUiStore()
const view = useViewStore()

const detailNote = {
  idle: 'Loads sharper NASA tiles as you zoom in.',
  loading: 'Loading tiles…',
  ready: 'Sharper tiles loaded for this area.',
  unavailable: 'NASA imagery unreachable — showing the base map.',
}

const on = (t: string) => events.filter.tags?.includes(t) ?? false
const hour = () => {
  const h = Math.floor(settings.sunHour)
  return `${String(h % 24).padStart(2, '0')}:${String(Math.round((settings.sunHour - h) * 60)).padStart(2, '0')} UTC`
}
</script>

<template>
  <aside class="sheet panel">
    <div class="head">
      <span class="eyebrow">Settings</span>
      <button class="close" aria-label="Close settings" @click="ui.close()">×</button>
    </div>

    <section>
      <span class="eyebrow">Event tags</span>
      <p class="hint">Showing {{ events.filter.tags?.length ? 'selected' : 'all' }} events.</p>
      <div class="chips">
        <button v-for="t in events.allTags" :key="t" :class="{ on: on(t) }" @click="events.toggleTag(t)">
          {{ t }}
        </button>
      </div>
      <button v-if="events.filter.tags?.length || events.filter.parent" class="reset" @click="events.clearFilter()">
        Clear filters
      </button>
    </section>

    <section>
      <span class="eyebrow">Atmosphere</span>
      <label class="row">
        <input type="checkbox" :checked="settings.clouds" @change="settings.toggle('clouds')" />
        <span>Cloud cover</span>
      </label>
      <label class="row">
        <input type="checkbox" :checked="settings.atmosphere" @change="settings.toggle('atmosphere')" />
        <span>Atmospheric glow</span>
      </label>
      <p class="hint">Both fade out as you zoom in close.</p>
    </section>

    <section>
      <span class="eyebrow">Imagery</span>
      <label class="row">
        <input type="checkbox" :checked="settings.detail" @change="settings.toggle('detail')" />
        <span>Stream high-detail imagery</span>
      </label>
      <p class="hint">{{ detailNote[view.detailStatus] }}</p>
      <p class="hint">Available from 1930 onward — earlier than that, satellite imagery would show modern cities.</p>
      <label class="row">
        <input type="checkbox" :checked="settings.scaleBar" @change="settings.toggle('scaleBar')" />
        <span>Show scale bar</span>
      </label>
    </section>

    <section>
      <span class="eyebrow">Imagery</span>
      <label class="row">
        <input type="checkbox" :checked="settings.detail" @change="settings.toggle('detail')" />
        <span>Stream high-resolution detail when zoomed in</span>
      </label>
      <p class="hint">Satellite tiles from NASA GIBS. Uses network data.</p>
    </section>

    <section>
      <span class="eyebrow">Nation borders</span>
      <label class="row">
        <input type="checkbox" :checked="nations.showExtremes" @change="nations.toggleExtremes()" />
        <span>Show largest and smallest extent in view</span>
      </label>
    </section>

    <section>
      <span class="eyebrow">Sunlight</span>
      <p class="hint">{{ hour() }}</p>
      <input v-model.number="settings.sunHour" class="slider" type="range" min="0" max="24" step="0.25" />
    </section>
  </aside>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 60px;
  right: 16px;
  width: min(300px, calc(100vw - 32px));
  padding: 14px;
  display: grid;
  gap: 18px;
  z-index: 6;
}
.head { display: flex; justify-content: space-between; align-items: center; }
.close { background: none; border: none; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer; }
.close:hover { color: var(--frost); }
section { display: grid; gap: 8px; }
.hint { margin: 0; font-size: 12px; color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chips button {
  font-family: var(--cond);
  font-size: 12px;
  letter-spacing: 0.06em;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  padding: 3px 11px;
  cursor: pointer;
  transition: all 0.15s var(--ease);
}
.chips button:hover { color: var(--frost); border-color: var(--muted); }
.chips button.on { color: var(--void); background: var(--brass); border-color: var(--brass); }
.reset {
  justify-self: start;
  background: none;
  border: none;
  color: var(--brass);
  font-size: 12px;
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
}
.row { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--frost); cursor: pointer; }
.row input { accent-color: var(--brass); }
.slider { width: 100%; accent-color: var(--brass); }
@media (max-width: 640px) {
  .panel { top: auto; bottom: calc(var(--rail) + 12px); left: 16px; right: 16px; width: auto; }
}
</style>
