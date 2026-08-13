<script setup lang="ts">
/**
 * THE ARTICLE READER — a Wikipedia article, in this app's chrome, on a desktop.
 *
 * Every item in this corpus ends with the same sentence: *More at Wikipedia*.
 * Following it used to mean leaving — a new tab, a white page, a different
 * typeface, and the globe you were reading around left behind. The reader is
 * that link kept inside the app: the same article, set in the app's own serif
 * on the app's own dark sheet, over the globe it was opened from, with the map
 * and the panel exactly as they were when it closes.
 *
 * FOUR THINGS DECIDED HERE, EACH FOR A REASON WORTH WRITING DOWN.
 *
 * 1. DESKTOP ONLY, and the gate is the app's own 641px break
 *    (`SIDE_BY_SIDE_MIN_PX`, stores/events.ts — the same number every stylesheet
 *    in this app is written against). A modal that fills a phone with someone
 *    else's encyclopaedia is a worse Wikipedia than Wikipedia: no back gesture,
 *    no reading mode, no font control, no share sheet. On a phone the closer
 *    link stays what it has always been — a link to the site — and this
 *    component does not render at all. The gate is live, not read once: a
 *    window dragged narrow while the reader is open closes it, which is the
 *    only sane end state for a layout that no longer fits.
 *
 * 2. THE WALK IS A STACK, not a single article. Following a link inside the
 *    reader pushes; the back control in the header pops (`pushHistory` /
 *    `popHistory`, lib/wikiArticle.ts — pure, so their ordering rules are unit
 *    tested rather than inferred from a component). The stack lives here and
 *    dies with the component, because closing the reader ends the walk by
 *    definition. Scroll positions ride along with it, so coming back lands
 *    where the reader left, not at the top of a page they were halfway down.
 *
 * 3. ESCAPE CLOSES THIS FIRST. The app's Escape ladder (views/HomeView.vue)
 *    unwinds pop-overs and then focus mode, and neither is what a reader with a
 *    modal open means. The listener below is on `window` in the CAPTURE phase
 *    and stops the event: capture at the window is the first thing that runs
 *    for any key press anywhere in the document, so this layer is on top of the
 *    ladder by construction rather than by both files agreeing about an order.
 *
 * 4. THE USER'S CLICK INTENT IS RESPECTED EVERYWHERE. Every link in and out of
 *    the reader is a real `<a href>` at the live article, and a middle-click or
 *    a modifier-click is left alone to do what the browser has always done with
 *    one (`opensInReader`). The reader is offered on the plain click; it is
 *    never imposed on a gesture that meant "new tab".
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useUiStore } from '../stores/ui'
import { SIDE_BY_SIDE_MIN_PX } from '../stores/events'
import {
  canGoBack,
  currentRef,
  loadArticle,
  opensInReader,
  popHistory,
  pushHistory,
  titleText,
  type WikiArticle,
  type WikiRef,
} from '../lib/wikiArticle'

const ui = useUiStore()

/* --- the desktop gate, live -------------------------------------------- */
const media =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia(`(min-width: ${SIDE_BY_SIDE_MIN_PX}px)`)
    : null
const desktop = ref(media ? media.matches : true)
const onMedia = (e: MediaQueryListEvent) => {
  desktop.value = e.matches
  // A window dragged below the break while the reader is open: close it and
  // leave the reader on the panel they came from, which is the phone behaviour.
  if (!e.matches) ui.closeReader()
}

/* --- the walk ----------------------------------------------------------- */
const stack = ref<WikiRef[]>([])
const article = ref<WikiArticle | null>(null)
const failed = ref(false)
const loading = ref(false)
let inflight: AbortController | null = null

const here = computed(() => currentRef(stack.value) ?? ui.reader)
const heading = computed(() => (here.value ? titleText(here.value.title) : ''))
/** Always available, even before (and after) a fetch: the live page. */
const liveUrl = computed(() =>
  article.value?.pageUrl ??
  (here.value
    ? `https://${here.value.lang}.wikipedia.org/wiki/${encodeURIComponent(here.value.title)}`
    : 'https://en.wikipedia.org/'),
)
const back = computed(() => canGoBack(stack.value))

const scrollBox = ref<HTMLElement | null>(null)
const dialog = ref<HTMLElement | null>(null)
/** Where the reader was on each entry of the stack, so back lands where it left. */
const scrolls: number[] = []

async function load(ref_: WikiRef) {
  inflight?.abort()
  const ctl = new AbortController()
  inflight = ctl
  article.value = null
  failed.value = false
  loading.value = true
  try {
    const got = await loadArticle(ref_, { signal: ctl.signal })
    if (ctl.signal.aborted) return
    article.value = got
  } catch {
    // Every reason is the same reason as far as the reader is concerned: the
    // article is not here. What they get is an apology and the live link — see
    // the template. `loadArticle` has already logged which endpoints said what.
    if (!ctl.signal.aborted) failed.value = true
  } finally {
    if (!ctl.signal.aborted) loading.value = false
  }
}

/** Follow a link inside the article. */
function go(next: WikiRef) {
  scrolls[stack.value.length - 1] = scrollBox.value?.scrollTop ?? 0
  const grown = pushHistory(stack.value, next)
  if (grown.length === stack.value.length) return // a link to the page we are on
  stack.value = grown
  void load(next)
  void nextTick(() => scrollBox.value?.scrollTo({ top: 0 }))
}

function goBack() {
  if (!back.value) return
  stack.value = popHistory(stack.value)
  const target = currentRef(stack.value)!
  const at = scrolls[stack.value.length - 1] ?? 0
  void load(target).then(() => restoreScroll(at))
}

/**
 * Put the reader back where it was on the page it is returning to.
 *
 * Set once and it does not stick: the article renders, but its pictures are
 * still arriving, so for a few frames the box is shorter than the offset asked
 * for and the browser clamps the assignment to whatever fits (measured: a
 * request for 905px landed at 358px). So it is re-asserted for a few frames,
 * and stops the moment it takes — or the moment the reader scrolls themselves,
 * because a scroll position fighting the wheel is worse than one that is wrong.
 */
function restoreScroll(top: number) {
  if (top <= 0) return
  let interrupted = false
  const onWheel = () => (interrupted = true)
  const until = performance.now() + RESTORE_WINDOW_MS
  scrollBox.value?.addEventListener('wheel', onWheel, { once: true, passive: true })
  const tick = () => {
    const el = scrollBox.value
    const done = !el || interrupted || Math.abs((el?.scrollTop ?? 0) - top) <= 1
    if (done || performance.now() > until) {
      el?.removeEventListener('wheel', onWheel)
      return
    }
    el.scrollTop = top
    requestAnimationFrame(tick)
  }
  void nextTick(() => requestAnimationFrame(tick))
}
/**
 * How long the restore keeps trying. Long enough for a page of pictures to
 * finish reserving its boxes on a slow machine, short enough that a reader who
 * never scrolls cannot notice it is still going.
 */
const RESTORE_WINDOW_MS = 1500

/**
 * A click anywhere in the rendered article. Internal links carry
 * `data-wiki-title` (put there by `adaptArticleHtml`); everything else is either
 * an external link, already `target="_blank" rel="noopener noreferrer"`, or not
 * a link at all.
 */
function onArticleClick(ev: MouseEvent) {
  const a = (ev.target as HTMLElement | null)?.closest?.('a[data-wiki-title]') as HTMLElement | null
  if (!a) return
  if (!opensInReader(ev, desktop.value)) return // a new tab was asked for: let it happen
  ev.preventDefault()
  go({ lang: a.dataset.wikiLang || 'en', title: a.dataset.wikiTitle || '' })
}

/* --- opening, closing, and the keyboard --------------------------------- */

/** What had focus before the reader opened, so closing hands it back. */
let restoreFocus: HTMLElement | null = null

watch(
  () => ui.reader,
  (target) => {
    if (!target) {
      inflight?.abort()
      inflight = null
      stack.value = []
      scrolls.length = 0
      article.value = null
      failed.value = false
      // Back to the control that opened the reader — the closer link, or the
      // entry in the links strip. A modal that returns focus to <body> loses a
      // keyboard reader their place in the panel entirely.
      const el = restoreFocus
      restoreFocus = null
      void nextTick(() => el?.focus?.())
      return
    }
    restoreFocus = (document.activeElement as HTMLElement) ?? null
    stack.value = [target]
    scrolls.length = 0
    void load(target)
    void nextTick(() => dialog.value?.focus())
  },
  { immediate: true },
)

/**
 * ESCAPE, and the focus trap.
 *
 * Capture phase on `window`: this runs before HomeView's own Escape ladder for
 * any key press in the document, and `stopPropagation` keeps the press from
 * reaching it — one press closes one thing, and while a modal is up that thing
 * is the modal. Tab is trapped the ordinary way: the dialog is the only
 * reachable region while it is open, so a keyboard reader cannot tab out into a
 * globe they cannot see.
 */
function onKeydown(e: KeyboardEvent) {
  if (!ui.reader) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    ui.closeReader()
    return
  }
  if (e.key !== 'Tab') return
  const root = dialog.value
  if (!root) return
  const focusable = [
    ...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  ].filter((el) => el.offsetParent !== null || el === root)
  if (!focusable.length) {
    e.preventDefault()
    root.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement as HTMLElement | null
  if (e.shiftKey && (active === first || active === root || !root.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

onMounted(() => {
  media?.addEventListener('change', onMedia)
  window.addEventListener('keydown', onKeydown, true)
})
onBeforeUnmount(() => {
  media?.removeEventListener('change', onMedia)
  window.removeEventListener('keydown', onKeydown, true)
  inflight?.abort()
})
</script>

<template>
  <!-- Nothing at all below the break: on a phone the entry points are plain
       links to the site (see the head of this file). -->
  <Transition name="fade">
    <div
      v-if="ui.reader && desktop"
      class="reader-layer"
      data-test="wiki-reader-layer"
    >
      <!-- The scrim is what makes the globe inert while the reader is up: it
           takes every pointer event the map would otherwise get, and dims the
           app enough that the modal is plainly the subject. -->
      <div class="scrim" data-test="wiki-reader-scrim" @click="ui.closeReader()" />

      <div
        ref="dialog"
        class="sheet reader"
        data-test="wiki-reader"
        role="dialog"
        aria-modal="true"
        :aria-label="`${heading} — from Wikipedia`"
        tabindex="-1"
      >
        <header class="head">
          <button
            v-if="back"
            class="chip back"
            data-test="wiki-reader-back"
            title="Back"
            @click="goBack()"
          >
            <svg class="glyph" width="12" height="12" viewBox="-12 -12 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 0H-7M-2 -5L-7 0L-2 5" /></svg>
            <span class="chip-label">Back</span>
          </button>
          <div class="titles">
            <span class="eyebrow">Wikipedia</span>
            <h2 data-test="wiki-reader-title">{{ heading }}</h2>
          </div>
          <!-- The way OUT to the live page, from inside the reader: the article
               as Wikipedia serves it, with its history, its talk page and its
               edit button. A new tab, like every other external link here. -->
          <a
            class="icon-btn"
            data-test="wiki-reader-external"
            :href="liveUrl"
            target="_blank"
            rel="noopener noreferrer"
            title="Open on Wikipedia"
            aria-label="Open on Wikipedia"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14 4h6v6M20 4l-9 9" />
              <path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
            </svg>
          </a>
          <button
            class="icon-btn"
            data-test="wiki-reader-close"
            aria-label="Close"
            title="Close"
            @click="ui.closeReader()"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div ref="scrollBox" class="body scroll-y" data-test="wiki-reader-body" @click="onArticleClick">
          <p v-if="loading" class="state" data-test="wiki-reader-loading">Loading the article…</p>
          <!-- THE FAILURE PATH, and it is a normal one: three endpoints, a
               reader's own network, and a browser that may be offline. It says
               what happened in one sentence and hands over the link that always
               works. -->
          <div v-else-if="failed" class="state" data-test="wiki-reader-error">
            <p>Sorry — this article could not be loaded here.</p>
            <p>
              <a :href="liveUrl" target="_blank" rel="noopener noreferrer">Read it on Wikipedia</a>
            </p>
          </div>
          <div v-else-if="article" class="prose" v-html="article.html" />
        </div>

        <!-- WHOSE WORDS THESE ARE, in the same words the Settings panel uses
             (components/SettingsPanel.vue): the article is Wikipedia's and the
             licence rides with it wherever the text is shown, not only where
             our own adapted text is. Both links: the article it came from, and
             the licence it comes under. -->
        <footer class="foot" data-test="wiki-reader-attribution">
          From
          <a :href="liveUrl" target="_blank" rel="noopener noreferrer">Wikipedia</a>
          —
          <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">
            CC BY-SA 4.0
          </a>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.reader-layer {
  position: fixed;
  inset: 0;
  z-index: var(--z-reader);
  display: grid;
  place-items: center;
}
.scrim {
  position: absolute;
  inset: 0;
  background: rgba(4, 7, 13, 0.66);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

/* The window: most of the screen, and centred, because it is the only thing
   being read while it is up — but never edge to edge, so the globe it was
   opened from stays visible around it and the modal reads as a layer over the
   app rather than as a page the app navigated to. */
.reader {
  position: relative;
  width: min(920px, 86vw);
  height: 88vh;
  max-height: 88vh;
  /* Every dimension above is a dimension of the BOX. `.sheet` carries a 1px
     border, and without this the window is 922px wide and 88vh + 2px tall —
     the same content-box trap the article panel documents in EventPanel.vue. */
  box-sizing: border-box;
  display: grid;
  grid-template-rows: auto 1fr auto;
  overflow: hidden;
  animation: reader-in var(--slow);
}
@keyframes reader-in {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.99);
  }
}

/* --- chrome: sans, condensed labels, the app's own icon buttons ---------- */
.head {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: var(--s3) var(--s3) var(--s3) var(--s5);
  border-bottom: 1px solid var(--line);
  font-family: var(--sans);
}
.titles {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 1px;
}
.titles h2 {
  margin: 0;
  font-family: var(--sans);
  font-size: var(--t-title);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--frost);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 30px;
  padding: 0 11px 0 9px;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--frost-dim);
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
  transition:
    color var(--fast),
    border-color var(--fast),
    background-color var(--fast);
}
.chip:hover {
  color: var(--brass);
  border-color: var(--brass-line);
  background: var(--brass-soft);
}

/* --- the article: the app's own reading typography ---------------------- */
.body {
  padding: var(--s4) var(--s5) var(--s5);
  min-height: 0;
}
.prose {
  font-family: var(--serif);
  font-size: 15.5px;
  line-height: 1.7;
  color: #dbe4f1;
  max-width: 72ch;
  margin: 0 auto;
  hyphens: auto;
}
.state {
  font-family: var(--serif);
  font-size: 15px;
  color: var(--frost-dim);
  max-width: 72ch;
  margin: 0 auto;
}
.state a {
  color: var(--patina);
}

/* Everything below is the DEMOTION: fetched markup carries no classes of its
   own by the time it gets here (see `adaptArticleHtml`), so the whole of its
   appearance is these element rules — which are the panel's own, one notch
   larger for a window this size. */
.prose :deep(p) {
  margin: 0 0 0.95em;
}
.prose :deep(h1),
.prose :deep(h2),
.prose :deep(h3),
.prose :deep(h4),
.prose :deep(h5),
.prose :deep(h6) {
  font-family: var(--cond);
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--frost);
  margin: 1.8em 0 0.5em;
  padding-bottom: 0.4em;
  border-bottom: 1px solid var(--line-soft);
}
.prose :deep(h1),
.prose :deep(h2) {
  font-size: var(--t-md);
}
.prose :deep(h3),
.prose :deep(h4),
.prose :deep(h5),
.prose :deep(h6) {
  font-size: var(--t-sm);
  border-bottom: 0;
}
.prose :deep(strong),
.prose :deep(b) {
  color: #f0f5fb;
  font-weight: 600;
}
.prose :deep(em),
.prose :deep(i) {
  color: #e7eef8;
}
.prose :deep(ul),
.prose :deep(ol) {
  margin: 0 0 0.95em;
  padding-left: 1.2em;
}
.prose :deep(li) {
  margin-bottom: 0.3em;
}
.prose :deep(dl) {
  margin: 0 0 0.95em;
}
.prose :deep(dt) {
  color: var(--frost);
  font-weight: 600;
}
.prose :deep(dd) {
  margin: 0 0 0.5em 1.2em;
  color: var(--frost-dim);
}
.prose :deep(blockquote) {
  margin: 0 0 0.95em;
  padding-left: var(--s3);
  border-left: 2px solid var(--line);
  color: var(--frost-dim);
  font-style: italic;
}
.prose :deep(a) {
  color: var(--patina);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: var(--patina-line);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  transition:
    color var(--fast),
    text-decoration-color var(--fast);
}
.prose :deep(a:hover) {
  color: #a5dcd2;
  text-decoration-color: currentColor;
}
/* An external link says so, quietly: inside a reader where most links stay
   here, the ones that leave are worth marking. */
.prose :deep(a[data-wiki-external])::after {
  content: '↗';
  font-family: var(--sans);
  font-size: 0.8em;
  margin-left: 2px;
  color: var(--muted);
}
.prose :deep(figure) {
  margin: var(--s4) 0;
}
.prose :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--r-md);
  display: block;
  background: rgba(255, 255, 255, 0.03);
}
.prose :deep(figcaption) {
  font-family: var(--sans);
  font-size: var(--t-sm);
  line-height: 1.5;
  color: var(--muted);
  margin-top: var(--s2);
}
.prose :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: var(--s4) 0;
  font-family: var(--sans);
  font-size: var(--t-sm);
  color: var(--frost-dim);
  display: block;
  overflow-x: auto;
}
.prose :deep(th),
.prose :deep(td) {
  border: 1px solid var(--line-soft);
  padding: 6px 9px;
  text-align: left;
  vertical-align: top;
}
.prose :deep(th) {
  color: var(--frost);
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: rgba(255, 255, 255, 0.03);
}
.prose :deep(caption) {
  caption-side: top;
  text-align: left;
  color: var(--muted);
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding-bottom: var(--s2);
}
.prose :deep(hr) {
  border: 0;
  border-top: 1px solid var(--line-soft);
  margin: var(--s5) 0;
}
.prose :deep(code),
.prose :deep(pre) {
  font-size: 0.9em;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 4px;
}
.prose :deep(code) {
  padding: 1px 5px;
}
.prose :deep(pre) {
  padding: var(--s2) var(--s3);
  overflow-x: auto;
}
.prose :deep(sup),
.prose :deep(sub) {
  font-size: 0.75em;
}

/* --- the licence, at the foot, in the same quiet type Settings uses ------ */
.foot {
  padding: var(--s2) var(--s5);
  border-top: 1px solid var(--line);
  font-family: var(--cond);
  font-size: var(--t-xs);
  letter-spacing: 0.06em;
  color: var(--muted);
}
.foot a {
  color: var(--frost-dim);
  text-decoration: underline;
  text-decoration-color: var(--line);
  text-underline-offset: 3px;
}
.foot a:hover {
  color: var(--brass);
}
</style>
