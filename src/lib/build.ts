/**
 * WHICH BUILD IS THIS — and is it still the one being served?
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 *
 * A deploy is not an update. GitHub Pages serves `index.html` with a ten-minute
 * `max-age`, a phone's browser keeps its own copy well past that, and a tab
 * left open on a home screen is never reloaded at all — so a device can run a
 * build from two rounds ago for days while the origin has verifiably had the
 * new one all along (the bundle hash on gh-pages was checked; it was current).
 *
 * That gap cost more than a stale screen. It cost the ability to *talk about*
 * the app: a reader reporting a fixed bug and a reader reporting a live one
 * wrote the same sentence, and nothing in the product could tell the two apart.
 *
 * So the app carries its own identity and can compare it with the server's:
 *
 *  1. `BUILD` is compiled INTO the bundle (`__BUILD_ID__` / `__BUILD_AT__`,
 *     substituted by vite.config.ts). It cannot be stale, because it is the
 *     same bytes as the code it describes. The settings footer prints it, so
 *     the answer to "which build are you on?" is a thing to read out rather
 *     than a thing to deduce.
 *  2. `version.json` sits beside index.html with the same two fields. It is
 *     ~60 bytes, so it can be re-fetched with `cache: 'no-store'` and a
 *     cache-busting query cheaply and often.
 *
 * Different ⇒ this tab is running a build the server has replaced. That is the
 * entire signal, and the only thing the app does with it is offer a reload.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------
 *
 * No service worker, no manifest, no PWA install path, no cache API. Those are
 * the machinery for controlling what a *browser* caches; the problem here is
 * one HTML document and one long-lived tab, and a service worker would add a
 * second, longer-lived cache with an update problem of its own — the classic
 * shape of this bug, not its cure. Two fields and a fetch is the whole design.
 *
 * The check NEVER reloads by itself. A page that reloads under a reader mid-
 * sentence is a worse fault than the one being fixed; the toast asks.
 */

/** The two facts that identify a build: the commit, and when it was compiled. */
export interface BuildStamp {
  /** `git rev-parse --short HEAD` at build time — or `nogit` without a repo. */
  id: string
  /** ISO-8601, to the second. */
  at: string
}

/**
 * THIS build. Substituted at compile time, so it is a constant in the emitted
 * JavaScript — there is no request, no timing and no failure mode.
 */
export const BUILD: BuildStamp = { id: __BUILD_ID__, at: __BUILD_AT__ }

/**
 * How the footer says it: "build a1b2c3d · 2026-08-06".
 *
 * The date rather than the whole timestamp, because it is read aloud down a
 * phone line to someone comparing it with a deploy log. The hash is what
 * actually identifies the build; the date is what makes it human.
 */
export const buildLabel = (b: BuildStamp = BUILD): string => `build ${b.id} · ${b.at.slice(0, 10)}`

/**
 * Where the server's copy lives, cache-busted.
 *
 * Both halves are needed and neither is enough: `cache: 'no-store'` is the
 * request's own instruction to the HTTP cache, and the `ts` query is what gets
 * past every *other* cache between here and the origin — a proxy, a service
 * worker someone else installed, a browser that treats no-store as advice on a
 * back/forward restore. A URL nothing has ever seen cannot be answered from
 * anything's cache.
 */
export const versionUrl = (base: string, now: number): string => `${base}version.json?ts=${now}`

/**
 * A served payload, if it is one.
 *
 * A 404 on GitHub Pages is `404.html` — this app's own index, served with a 200
 * on some configurations — so "the fetch resolved" says nothing. Anything that
 * is not an object with two string fields is NOT AN ANSWER, and the caller must
 * treat it as "no news": nagging a reader to reload because a CDN served an
 * error page would be the worst possible version of this feature.
 */
export function readStamp(v: unknown): BuildStamp | null {
  if (typeof v !== 'object' || v === null) return null
  const { id, at } = v as Record<string, unknown>
  if (typeof id !== 'string' || typeof at !== 'string' || !id || !at) return null
  return { id, at }
}

/**
 * Is the served build a DIFFERENT one from the running build?
 *
 * Different, not newer. There is no ordering to be had: a rollback is a deploy
 * too, and the tab holding code the server no longer serves is in exactly the
 * position the toast exists for. Both fields are compared because a rebuild of
 * a dirty tree carries the previous commit's hash — and that is precisely the
 * case where a stale device is hardest to spot by eye.
 */
export function isUpdate(served: unknown, mine: BuildStamp = BUILD): boolean {
  const s = readStamp(served)
  return !!s && (s.id !== mine.id || s.at !== mine.at)
}

/** While the tab is visible, ask again this often. */
export const POLL_MS = 5 * 60_000

/**
 * …but never twice inside this, whoever asks.
 *
 * The check is driven by three things that can all fire at once — the load,
 * the tab becoming visible, and the timer — and a reader flicking between apps
 * would otherwise issue a request per flick. One guard, in front of all three.
 */
export const MIN_GAP_MS = 10_000

/** Enough time since the last check? `last = 0` means "never asked". */
export const checkDue = (last: number, now: number, gap = MIN_GAP_MS): boolean =>
  last === 0 || now - last >= gap

/**
 * Ask the server what it is serving. Resolves to `null` on anything that is not
 * a clean answer — offline, a 500, an HTML error page, a truncated body — and
 * the caller's response to `null` is to do nothing at all and try again later.
 */
export async function fetchStamp(
  base: string,
  now: number,
  f: typeof fetch = fetch,
): Promise<BuildStamp | null> {
  try {
    const res = await f(versionUrl(base, now), { cache: 'no-store' })
    if (!res.ok) return null
    return readStamp(await res.json())
  } catch {
    return null
  }
}
