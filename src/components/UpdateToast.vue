<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { BUILD, MIN_GAP_MS, POLL_MS, checkDue, fetchStamp, isUpdate } from '../lib/build'

/**
 * "NEW VERSION — RELOAD."
 *
 * The one piece of chrome that exists because of how this app is DELIVERED
 * rather than because of anything it is about. GitHub Pages hands out
 * index.html with a ten-minute max-age, a phone caches it well past that, and a
 * tab left open on a home screen is never reloaded at all — so a device can go
 * on running a build from two rounds ago while the origin has had the new one
 * the whole time. See lib/build.ts for the mechanism; this is the surface.
 *
 * WHAT IT IS ALLOWED TO DO. Ask. Nothing else. It does not reload on its own —
 * a page that reloads under a reader mid-sentence is a worse fault than the one
 * being fixed — and it does not come back once dismissed, because a reader who
 * said "not now" has answered the question for this build.
 *
 * WHEN IT ASKS. On load, on the tab becoming visible again (which is the case
 * that matters: the stale tab is by definition one that was in the background
 * for a day), and on a slow timer while it is visible. All three go through one
 * `MIN_GAP_MS` guard, so flicking between apps costs one request, not one per
 * flick. Nothing polls while the tab is hidden: a backgrounded tab that wakes
 * to fetch is a battery cost with no reader in front of it.
 *
 * It is deliberately small, dark and at the bottom — a system notice, not a
 * banner. It sits ABOVE the rail rather than over it, because the rail is where
 * the reader's thumb is, and it clears the safe area for the same reason.
 */
const show = ref(false)
/** Dismissed for this build: the reader has answered, and the answer stands. */
let done = false
let last = 0
let timer = 0

async function check() {
  if (done || show.value) return
  const now = Date.now()
  if (!checkDue(last, now, MIN_GAP_MS)) return
  last = now
  const served = await fetchStamp(import.meta.env.BASE_URL, now)
  // `null` — offline, a 500, an HTML error page — is NOT news. Silence.
  if (isUpdate(served, BUILD)) show.value = true
}

function onVisible() {
  if (document.visibilityState !== 'visible') return
  void check()
}

onMounted(() => {
  void check()
  document.addEventListener('visibilitychange', onVisible)
  timer = window.setInterval(() => document.visibilityState === 'visible' && void check(), POLL_MS)
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisible)
  clearInterval(timer)
})

const reload = () => location.reload()
function dismiss() {
  done = true
  show.value = false
}
</script>

<template>
  <Transition name="toast">
    <div v-if="show" class="toast" role="status" aria-live="polite" data-test="update-toast">
      <span class="msg">New version</span>
      <button class="go" data-test="update-reload" @click="reload">Reload</button>
      <button class="x" data-test="update-dismiss" aria-label="Dismiss" @click="dismiss">
        <svg
          class="glyph"
          width="11"
          height="11"
          viewBox="-12 -12 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.6"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M-6 -6L6 6M6 -6L-6 6" />
        </svg>
      </button>
    </div>
  </Transition>
</template>

<style scoped>
/* Above the rail, not over it: the rail is where the thumb lives, and a notice
   that has to be dismissed before the timeline can be touched is a modal
   wearing a toast's clothes. --rail-clear is the one token every other floating
   control is placed against (styles/tokens.css). */
.toast {
  position: absolute;
  bottom: calc(var(--rail-clear) + var(--s3));
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-toast);
  display: flex;
  align-items: center;
  gap: var(--s2);
  max-width: calc(100vw - 2 * var(--s3));
  box-sizing: border-box;
  padding: 7px 7px 7px var(--s3);
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  background: rgba(9, 14, 24, 0.94);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: var(--lift);
}
.msg {
  font-family: var(--cond);
  font-size: var(--t-sm);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--frost-dim);
  white-space: nowrap;
}
/* The action is the only lit thing in it. Outlined rather than filled: the saga
   CTA is the article's one filled brass control and this must not rival it. */
.go {
  flex: none;
  padding: 4px 12px;
  border: 1px solid var(--brass-line);
  border-radius: var(--r-pill);
  background: var(--brass-soft);
  color: var(--brass);
  font-family: var(--cond);
  font-size: var(--t-sm);
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
  transition:
    color var(--fast),
    border-color var(--fast),
    background-color var(--fast);
}
.go:hover {
  color: var(--void);
  background: var(--brass);
  border-color: var(--brass);
}
.x {
  flex: none;
  position: relative;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: none;
  color: var(--muted);
  cursor: pointer;
  transition: color var(--fast);
}
/* An icon is geometry, placed by translation off its box's centre — the rule in
   styles/tokens.css, and the reason .icon-c exists. */
.x > .glyph {
  position: absolute;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
}
.x:hover {
  color: var(--frost);
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--slow),
    transform var(--slow);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 10px);
}

@media (max-width: 640px) {
  .x {
    width: 32px;
    height: 32px;
  }
  .go {
    padding: 7px 14px;
  }
}
</style>
