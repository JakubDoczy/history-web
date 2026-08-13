import { defineStore } from 'pinia'
import type { WikiRef } from '../lib/wikiArticle'

export const useUiStore = defineStore('ui', {
  state: () => ({
    search: false,
    settings: false,
    /**
     * THE ARTICLE READER'S SUBJECT, or `null` when it is not open.
     *
     * Only the article it *opened* on lives here: the walk from there — the
     * links the reader followed and the way back through them — belongs to the
     * component, which is mounted exactly as long as the walk lasts (see
     * components/WikiReader.vue and `pushHistory` in lib/wikiArticle.ts). Two
     * places would have to agree about it otherwise, and the store is the wrong
     * one of the two: nothing outside the reader can act on a stack it cannot
     * see, and closing the reader ends the walk by definition.
     *
     * Deliberately NOT cleared by `close()`. That closes the pop-overs, which
     * are the layer *below* this one: the reader is a modal over the whole app
     * and it is dismissed by its own affordances (its X, Escape, the scrim).
     */
    reader: null as WikiRef | null,
  }),
  actions: {
    toggle(panel: 'search' | 'settings') {
      const next = !this[panel]
      this.search = this.settings = false
      this[panel] = next
    },
    close() {
      this.search = this.settings = false
    },
    /**
     * Open the reader on an article. The pop-overs go with it: the reader takes
     * the whole screen behind a scrim, so a search box left open underneath it
     * would be a control the reader cannot reach and would find waiting when
     * they closed the reader again.
     */
    openReader(ref: WikiRef) {
      this.search = this.settings = false
      this.reader = ref
    },
    closeReader() {
      this.reader = null
    },
  },
})
