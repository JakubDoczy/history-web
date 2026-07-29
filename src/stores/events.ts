import { defineStore } from 'pinia'
import { EventIndex, type HistoricalEvent, type EventFilter } from '../lib/events'
import { useTimeStore } from './time'
import rawEvents from '../data/events.json'

const index = new EventIndex(rawEvents as HistoricalEvent[])

export const useEventStore = defineStore('events', {
  state: () => ({
    all: rawEvents as HistoricalEvent[],
    filter: {} as EventFilter,
    selectedId: undefined as string | undefined,
    maxVisible: 100,
  }),
  getters: {
    visible(state): HistoricalEvent[] {
      const { range } = useTimeStore()
      return index.query(range.start, range.end, state.filter, state.maxVisible)
    },
    selected: (s) => s.all.find((e) => e.id === s.selectedId),
    allTags: (s) => [...new Set(s.all.flatMap((e) => e.tags))].sort(),
    childrenOf: (s) => (id: string) => s.all.filter((e) => e.parent === id),
    byId: (s) => (id: string) => s.all.find((e) => e.id === id),
    search: (s) => (q: string) => {
      const needle = q.trim().toLowerCase()
      if (!needle) return [] as HistoricalEvent[]
      return s.all
        .filter((e) => e.name.toLowerCase().includes(needle) || e.tags.some((t) => t.includes(needle)))
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 8)
    },
  },
  actions: {
    select(id?: string) {
      this.selectedId = id
    },
    toggleTag(tag: string) {
      const tags = this.filter.tags ?? []
      this.filter.tags = tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag]
    },
    setParentFilter(id?: string) {
      this.filter.parent = id
    },
    clearFilter() {
      this.filter = {}
    },
  },
})
