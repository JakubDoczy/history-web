import { defineStore } from 'pinia'
import { visibleEvents, type HistoricalEvent, type EventFilter } from '../lib/events'
import { useTimeStore } from './time'
import rawEvents from '../data/events.json'

export const useEventStore = defineStore('events', {
  state: () => ({
    all: rawEvents as HistoricalEvent[],
    filter: {} as EventFilter,
    selectedId: undefined as string | undefined,
  }),
  getters: {
    visible(state): HistoricalEvent[] {
      const { range } = useTimeStore()
      return visibleEvents(state.all, range.start, range.end, state.filter)
    },
    selected: (s) => s.all.find((e) => e.id === s.selectedId),
    allTags: (s) => [...new Set(s.all.flatMap((e) => e.tags))].sort(),
  },
  actions: {
    select(id?: string) {
      this.selectedId = id
    },
    toggleTag(tag: string) {
      const tags = this.filter.tags ?? []
      this.filter.tags = tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag]
    },
  },
})
