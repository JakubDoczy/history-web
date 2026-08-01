/**
 * Runtime lookup of a lead image for an event, from Wikipedia.
 *
 * The dataset deliberately stores no image URLs: a `upload.wikimedia.org` path
 * encodes the file's current name and thumbnail size, both of which change when
 * an article's lead image is replaced or renamed, and a stored one goes silently
 * wrong (missing, or worse, a picture of something else). The article link we
 * already carry is the stable identifier; the picture is derived from it at read
 * time through the REST summary endpoint, which is CORS-enabled for anonymous
 * requests:
 *
 *   https://en.wikipedia.org/api/rest_v1/page/summary/<title>
 *   → { title, description, extract, thumbnail: {source,width,height},
 *       originalimage: {...}, content_urls: { desktop: { page } } }
 *
 * Everything here fails to `null` rather than throwing: an event with no picture
 * is a normal, already-supported state of the panel.
 */

/** The parts of the summary response this module reads. Everything is optional. */
export interface WikiSummary {
  title?: string
  titles?: { canonical?: string; normalized?: string; display?: string }
  description?: string
  extract?: string
  thumbnail?: WikiImageSource
  originalimage?: WikiImageSource
  content_urls?: { desktop?: { page?: string }; mobile?: { page?: string } }
}

export interface WikiImageSource {
  source?: string
  width?: number
  height?: number
}

/** What the panel needs to render one picture. */
export interface WikiImage {
  url: string
  /** Intrinsic size of the *requested* rendering, when it can be derived — lets the panel reserve the box. */
  width?: number
  height?: number
  /** Short "what is this" line from the API (`description`), if any. */
  caption?: string
  /** Human-facing article URL, for the attribution link. */
  pageUrl: string
  /** Cache key part: the article this came from. */
  title: string
  lang: string
}

export interface WikiRef {
  lang: string
  /** Decoded, underscored article title, e.g. `Göbekli_Tepe`. */
  title: string
}

/** Thumbnails narrower than this are too small to be worth showing full-bleed. */
const MIN_WIDTH = 200
/** Wikimedia refuses absurd thumbnail requests; also our own sanity bound. */
const MAX_WIDTH = 2000
const DEFAULT_WIDTH = 640

/**
 * Namespaces that are not articles. A `File:` or `Category:` link has a summary
 * endpoint that either 404s or describes the wrong thing, so it is not worth a
 * request.
 */
const NON_ARTICLE =
  /^(file|image|category|special|help|template|talk|portal|wikipedia|wiktionary|media|mediawiki|user|draft|book|module)(_talk)?:/i

/* ------------------------------------------------------------------ parsing */

/**
 * Pull `{ lang, title }` out of a Wikipedia article URL, or `null` if the URL is
 * not one. Handles `/wiki/Title`, the legacy `index.php?title=`, mobile
 * (`en.m.wikipedia.org`) hosts, percent-encoding, fragments and query strings.
 */
export function parseWikiUrl(raw: string | undefined | null): WikiRef | null {
  if (!raw || typeof raw !== 'string') return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null

  const host = u.hostname.toLowerCase()
  if (!/(^|\.)wikipedia\.org$/.test(host)) return null
  // en.wikipedia.org / en.m.wikipedia.org / www.wikipedia.org / wikipedia.org
  const sub = host.replace(/\.?wikipedia\.org$/, '')
  const first = sub.split('.')[0]
  const lang = first && first !== 'www' && first !== 'm' ? first : 'en'

  let path = ''
  const m = /^\/wiki\/(.+)$/.exec(u.pathname)
  if (m) path = m[1]
  else if (/\/index\.php$/.test(u.pathname)) path = u.searchParams.get('title') ?? ''
  else return null

  const title = normalizeTitle(path)
  if (!title) return null
  if (NON_ARTICLE.test(title)) return null
  return { lang, title }
}

/**
 * Decode and canonicalise a raw title segment: percent-decoding, spaces to
 * underscores, collapsed separators, no fragment. Data in this repo carries both
 * raw UTF-8 (`Göbekli_Tepe`) and percent-encoded (`G%C3%B6bekli_Tepe`) forms.
 */
export function normalizeTitle(raw: string): string {
  let s = raw.split('#')[0].split('?')[0]
  try {
    s = decodeURIComponent(s)
  } catch {
    /* a stray % that is not an escape — keep the raw form rather than lose the title */
  }
  s = s.replace(/[\s_]+/g, '_').replace(/^_+|_+$/g, '')
  return s
}

/** The summary endpoint for an article. Title is encoded, `/` included. */
export function summaryUrl(ref: WikiRef): string {
  const lang = /^[a-z]{2,3}(-[a-z0-9-]+)?$/i.test(ref.lang) ? ref.lang.toLowerCase() : 'en'
  return `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(ref.title)}`
}

/** Human-facing article URL, used when the response omits `content_urls`. */
export function articleUrl(ref: WikiRef): string {
  return `https://${ref.lang}.wikipedia.org/wiki/${encodeURIComponent(ref.title)}`
}

/** Cache key. Two events pointing at one article share a single request. */
export const refKey = (ref: WikiRef) => `${ref.lang}:${ref.title}`

/**
 * Find the Wikipedia article an event points at. Events carry it twice — as a
 * `links[]` entry (`{ label: "Wikipedia", url }`) and inside the body as
 * `More at [Wikipedia](https://en.wikipedia.org/wiki/...)`. The structured field
 * wins; the body is the fallback for events that only have the prose form.
 */
export function wikiRefForEvent(
  event: { body?: string; links?: { label?: string; url?: string }[] } | null | undefined,
): WikiRef | null {
  if (!event) return null
  for (const l of event.links ?? []) {
    const ref = parseWikiUrl(l?.url)
    if (ref) return ref
  }
  for (const m of (event.body ?? '').matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)) {
    const ref = parseWikiUrl(m[1])
    if (ref) return ref
  }
  return null
}

/* ------------------------------------------------------------------- images */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * Thumbnail URLs look like
 *   .../commons/thumb/a/ab/Foo.jpg/320px-Foo.jpg
 *   .../commons/thumb/1/12/Bar.svg/320px-Bar.svg.png
 * The width lives only in that last segment's `NNNpx-` prefix, so asking for a
 * different rendering is a string edit — Wikimedia renders it on demand.
 */
const THUMB_SEGMENT = /\/(\d+)px-(?=[^/]*$)/

/** Width encoded in a thumbnail URL, or `null` if it is not a thumbnail URL. */
export function thumbWidth(url: string): number | null {
  const m = THUMB_SEGMENT.exec(url)
  return m ? Number(m[1]) : null
}

/** Rewrite a thumbnail URL to a different rendered width. Non-thumb URLs pass through. */
export function withThumbWidth(url: string, width: number): string {
  const w = Math.max(1, Math.round(width))
  return url.replace(THUMB_SEGMENT, `/${w}px-`)
}

/**
 * The width to actually request: what the layout wants, bounded by sanity, and
 * never above the original — Wikimedia will not upscale a raster, and asking for
 * more than the source has returns an error rather than a bigger picture.
 */
export function chooseWidth(targetWidth: number, originalWidth?: number): number {
  const want = clamp(Math.round(targetWidth) || DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH)
  if (originalWidth && originalWidth > 0) return Math.min(want, Math.round(originalWidth))
  return want
}

/**
 * Best image URL for a summary at roughly `targetWidth` CSS-or-device pixels, or
 * `null` when the article has no picture.
 */
export function pickImageUrl(summary: WikiSummary | null | undefined, targetWidth = DEFAULT_WIDTH): string | null {
  const thumb = summary?.thumbnail?.source
  const original = summary?.originalimage
  if (typeof thumb !== 'string' || !thumb) {
    return typeof original?.source === 'string' && original.source ? original.source : null
  }
  const width = chooseWidth(targetWidth, original?.width)
  const current = thumbWidth(thumb)
  if (current === null || current === width) return thumb // not a thumb URL, or already right
  return withThumbWidth(thumb, width)
}

/**
 * Turn a summary into everything the panel renders, keeping the aspect ratio of
 * the thumbnail so the box can be reserved before the bitmap arrives.
 */
export function imageFromSummary(
  summary: WikiSummary | null | undefined,
  ref: WikiRef,
  targetWidth = DEFAULT_WIDTH,
): WikiImage | null {
  const url = pickImageUrl(summary, targetWidth)
  if (!url) return null

  const thumb = summary?.thumbnail
  const requested = thumbWidth(url)
  let width: number | undefined
  let height: number | undefined
  if (thumb?.width && thumb?.height && thumb.width > 0) {
    const ratio = thumb.height / thumb.width
    width = requested ?? thumb.width
    height = Math.round(width * ratio)
  } else if (summary?.originalimage?.width && summary.originalimage.height) {
    width = summary.originalimage.width
    height = summary.originalimage.height
  }

  const caption = typeof summary?.description === 'string' ? summary.description.trim() : ''
  const page = summary?.content_urls?.desktop?.page ?? summary?.content_urls?.mobile?.page
  return {
    url,
    width,
    height,
    caption: caption || undefined,
    pageUrl: typeof page === 'string' && /^https?:/.test(page) ? page : articleUrl(ref),
    title: summary?.titles?.normalized ?? summary?.title ?? ref.title,
    lang: ref.lang,
  }
}

/* -------------------------------------------------------------------- fetch */

interface Pending {
  promise: Promise<WikiSummary | null>
  controller: AbortController
  /** Live subscribers. The shared request is only aborted when the last one leaves. */
  refs: number
}

const cache = new Map<string, WikiSummary | null>()
const pending = new Map<string, Pending>()

/** Test seam and "start of session" reset. */
export function clearWikiImageCache(): void {
  for (const p of pending.values()) p.controller.abort()
  pending.clear()
  cache.clear()
}

/** Introspection for tests: how many articles are memoised, how many in flight. */
export const wikiCacheStats = () => ({ cached: cache.size, pending: pending.size })

export interface FetchOptions {
  targetWidth?: number
  signal?: AbortSignal
  /** Injection point for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Fetch (or replay from cache) the summary for an article.
 *
 * Two callers asking for the same article share one request. A caller that gives
 * up — the panel moved to another event — detaches; only when every caller has
 * detached is the underlying request actually aborted, so a fast A → B → A
 * bounce does not cancel the request A still needs.
 */
export async function fetchWikiSummary(ref: WikiRef, opts: FetchOptions = {}): Promise<WikiSummary | null> {
  const key = refKey(ref)
  if (cache.has(key)) return cache.get(key)!
  if (opts.signal?.aborted) return null

  let entry = pending.get(key)
  if (!entry) {
    const controller = new AbortController()
    const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
    const promise = (async () => {
      try {
        const res = await doFetch(summaryUrl(ref), {
          signal: controller.signal,
          headers: { accept: 'application/json' },
          // The endpoint is public and cache-friendly; no credentials, ever.
          credentials: 'omit',
          mode: 'cors',
        })
        if (!res?.ok) return null
        const json = (await res.json()) as unknown
        return json && typeof json === 'object' ? (json as WikiSummary) : null
      } catch {
        return null // network failure, CORS refusal, abort, malformed JSON — all "no picture"
      }
    })()
    entry = { promise, controller, refs: 0 }
    pending.set(key, entry)
    // Only a request that ran to completion is memoised; an aborted one must not
    // poison the cache with `null` for the rest of the session.
    void promise.then((value) => {
      if (pending.get(key) === entry) {
        pending.delete(key)
        if (!controller.signal.aborted) cache.set(key, value)
      }
    })
  }

  const self = entry
  self.refs++
  // Exactly one detach per subscriber, whether it leaves by aborting or by the
  // request finishing — a double decrement would abort a request others still want.
  let detached = false
  const detach = () => {
    if (detached) return
    detached = true
    self.refs--
    if (self.refs === 0 && pending.get(key) === self) {
      pending.delete(key)
      self.controller.abort()
    }
  }

  const signal = opts.signal
  if (!signal) {
    const value = await self.promise
    detached = true
    self.refs--
    return value
  }

  return await new Promise<WikiSummary | null>((resolve) => {
    const onAbort = () => {
      detach()
      resolve(null)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void self.promise.then((value) => {
      signal.removeEventListener('abort', onAbort)
      const aborted = signal.aborted
      if (!detached) {
        detached = true
        self.refs--
      }
      resolve(aborted ? null : value)
    })
  })
}

/**
 * The whole path: article URL → picture, or `null`. The panel calls exactly this.
 */
export async function fetchWikiImage(
  articleLink: string | WikiRef | null | undefined,
  opts: FetchOptions = {},
): Promise<WikiImage | null> {
  const ref = typeof articleLink === 'string' ? parseWikiUrl(articleLink) : (articleLink ?? null)
  if (!ref) return null
  const summary = await fetchWikiSummary(ref, opts)
  if (!summary || opts.signal?.aborted) return null
  return imageFromSummary(summary, ref, opts.targetWidth ?? DEFAULT_WIDTH)
}
