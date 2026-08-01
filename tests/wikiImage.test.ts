import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  parseWikiUrl,
  normalizeTitle,
  summaryUrl,
  articleUrl,
  refKey,
  wikiRefForEvent,
  thumbWidth,
  withThumbWidth,
  chooseWidth,
  pickImage,
  imageFromSummary,
  fetchWikiSummary,
  fetchWikiImage,
  clearWikiImageCache,
  wikiCacheStats,
  type WikiSummary,
} from '../src/lib/wikiImage'

/* ------------------------------------------------------------------ parsing */

describe('parseWikiUrl', () => {
  it('reads title and language from a plain article URL', () => {
    expect(parseWikiUrl('https://en.wikipedia.org/wiki/Neolithic_Revolution')).toEqual({
      lang: 'en',
      title: 'Neolithic_Revolution',
    })
  })

  it('accepts raw UTF-8 titles as they appear in the dataset', () => {
    expect(parseWikiUrl('https://en.wikipedia.org/wiki/Göbekli_Tepe')?.title).toBe('Göbekli_Tepe')
  })

  it('decodes percent-encoded titles to the same form', () => {
    expect(parseWikiUrl('https://en.wikipedia.org/wiki/G%C3%B6bekli_Tepe')?.title).toBe('Göbekli_Tepe')
  })

  it('drops fragments and query strings', () => {
    expect(parseWikiUrl('https://en.wikipedia.org/wiki/Jericho#History?x=1')?.title).toBe('Jericho')
    expect(parseWikiUrl('https://en.wikipedia.org/wiki/Jericho?action=raw')?.title).toBe('Jericho')
  })

  it('normalises spaces to underscores', () => {
    expect(parseWikiUrl('https://en.wikipedia.org/wiki/Walls of Jericho')?.title).toBe('Walls_of_Jericho')
  })

  it('reads the language from the subdomain, ignoring the mobile host', () => {
    expect(parseWikiUrl('https://de.wikipedia.org/wiki/Berlin')).toEqual({ lang: 'de', title: 'Berlin' })
    expect(parseWikiUrl('https://en.m.wikipedia.org/wiki/Berlin')).toEqual({ lang: 'en', title: 'Berlin' })
    expect(parseWikiUrl('https://fr.m.wikipedia.org/wiki/Paris')).toEqual({ lang: 'fr', title: 'Paris' })
  })

  it('falls back to en for host forms with no language label', () => {
    expect(parseWikiUrl('https://www.wikipedia.org/wiki/Earth')?.lang).toBe('en')
    expect(parseWikiUrl('https://wikipedia.org/wiki/Earth')?.lang).toBe('en')
  })

  it('supports the legacy index.php?title= form', () => {
    expect(parseWikiUrl('https://en.wikipedia.org/w/index.php?title=Rome&oldid=5')).toEqual({
      lang: 'en',
      title: 'Rome',
    })
  })

  it('rejects other hosts, including look-alikes', () => {
    expect(parseWikiUrl('https://example.com/wiki/Rome')).toBeNull()
    expect(parseWikiUrl('https://notwikipedia.org/wiki/Rome')).toBeNull()
    expect(parseWikiUrl('https://wikipedia.org.evil.com/wiki/Rome')).toBeNull()
    expect(parseWikiUrl('https://en.wikibooks.org/wiki/Rome')).toBeNull()
  })

  it('rejects non-http schemes and junk input', () => {
    expect(parseWikiUrl('javascript:alert(1)')).toBeNull()
    expect(parseWikiUrl('en.wikipedia.org/wiki/Rome')).toBeNull()
    expect(parseWikiUrl('')).toBeNull()
    expect(parseWikiUrl(undefined)).toBeNull()
    expect(parseWikiUrl(null)).toBeNull()
  })

  it('rejects non-article paths and namespaces', () => {
    expect(parseWikiUrl('https://en.wikipedia.org/wiki/')).toBeNull()
    expect(parseWikiUrl('https://en.wikipedia.org/')).toBeNull()
    expect(parseWikiUrl('https://en.wikipedia.org/wiki/File:Foo.jpg')).toBeNull()
    expect(parseWikiUrl('https://en.wikipedia.org/wiki/Category:Rome')).toBeNull()
    expect(parseWikiUrl('https://en.wikipedia.org/wiki/Special:Random')).toBeNull()
    expect(parseWikiUrl('https://en.wikipedia.org/wiki/Talk:Rome')).toBeNull()
  })

  it('keeps article titles that merely start with a namespace-looking word', () => {
    expect(parseWikiUrl('https://en.wikipedia.org/wiki/Filemaker')?.title).toBe('Filemaker')
    expect(parseWikiUrl('https://en.wikipedia.org/wiki/Categorical_imperative')?.title).toBe(
      'Categorical_imperative',
    )
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseWikiUrl('  https://en.wikipedia.org/wiki/Rome  ')?.title).toBe('Rome')
  })
})

describe('normalizeTitle', () => {
  it('collapses mixed separators and trims underscores', () => {
    expect(normalizeTitle('  Walls   of _ Jericho__')).toBe('Walls_of_Jericho')
  })
  it('survives a stray percent that is not an escape', () => {
    expect(normalizeTitle('100%_pure')).toBe('100%_pure')
  })
})

describe('summaryUrl / articleUrl', () => {
  it('builds the REST summary endpoint with an encoded title', () => {
    expect(summaryUrl({ lang: 'en', title: 'Neolithic_Revolution' })).toBe(
      'https://en.wikipedia.org/api/rest_v1/page/summary/Neolithic_Revolution',
    )
  })

  it('percent-encodes non-ASCII and slashes in titles', () => {
    expect(summaryUrl({ lang: 'en', title: 'Göbekli_Tepe' })).toBe(
      'https://en.wikipedia.org/api/rest_v1/page/summary/G%C3%B6bekli_Tepe',
    )
    expect(summaryUrl({ lang: 'en', title: 'AC/DC' })).toContain('AC%2FDC')
  })

  it('uses the article language', () => {
    expect(summaryUrl({ lang: 'de', title: 'Berlin' })).toBe(
      'https://de.wikipedia.org/api/rest_v1/page/summary/Berlin',
    )
  })

  it('falls back to en for an implausible language code', () => {
    expect(summaryUrl({ lang: 'not a language', title: 'Berlin' })).toContain('https://en.wikipedia.org/')
  })

  it('builds a human article URL for attribution', () => {
    expect(articleUrl({ lang: 'en', title: 'Jericho' })).toBe('https://en.wikipedia.org/wiki/Jericho')
  })

  it('keys the cache by language and title', () => {
    expect(refKey({ lang: 'en', title: 'Rome' })).toBe('en:Rome')
    expect(refKey({ lang: 'de', title: 'Rome' })).not.toBe(refKey({ lang: 'en', title: 'Rome' }))
  })
})

describe('wikiRefForEvent', () => {
  it('prefers the structured links[] entry', () => {
    const ev = {
      body: 'More at [Wikipedia](https://en.wikipedia.org/wiki/Body_Link).',
      links: [
        { label: 'Dawn of agriculture', event: 'agriculture' },
        { label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Neolithic_Revolution' },
      ],
    }
    expect(wikiRefForEvent(ev)?.title).toBe('Neolithic_Revolution')
  })

  it('falls back to the "More at [Wikipedia](...)" line in the body', () => {
    const ev = { body: 'Prose.\n\nMore at [Wikipedia](https://en.wikipedia.org/wiki/Jericho).' }
    expect(wikiRefForEvent(ev)?.title).toBe('Jericho')
  })

  it('keeps the parentheses of a disambiguated title in the body form', () => {
    // `[…](…/Early_Dynastic_Period_(Egypt))` — stopping at the first `(` yields
    // a truncated title that 404s, silently and forever.
    const ev = {
      body: 'More at [Wikipedia](https://en.wikipedia.org/wiki/Early_Dynastic_Period_(Egypt)).',
    }
    expect(wikiRefForEvent(ev)?.title).toBe('Early_Dynastic_Period_(Egypt)')
  })

  it('skips non-Wikipedia links in both places', () => {
    expect(
      wikiRefForEvent({
        body: 'See [NASA](https://nasa.gov/x) and [Wikipedia](https://en.wikipedia.org/wiki/Apollo_11).',
        links: [{ label: 'NASA', url: 'https://nasa.gov/x' }],
      })?.title,
    ).toBe('Apollo_11')
  })

  it('returns null when the event has no Wikipedia link at all', () => {
    expect(wikiRefForEvent({ body: 'Just prose.', links: [{ label: 'Parent', event: 'x' }] })).toBeNull()
    expect(wikiRefForEvent({})).toBeNull()
    expect(wikiRefForEvent(null)).toBeNull()
  })

  it('handles the real dataset shape verbatim', () => {
    const gobekli = {
      body: 'Part of [Dawn of agriculture](event:agriculture). Circles of T-shaped limestone pillars.\n\nMore at [Wikipedia](https://en.wikipedia.org/wiki/Göbekli_Tepe).',
      links: [
        { label: 'Dawn of agriculture', event: 'agriculture' },
        { label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Göbekli_Tepe' },
      ],
    }
    expect(wikiRefForEvent(gobekli)).toEqual({ lang: 'en', title: 'Göbekli_Tepe' })
  })
})

/* ------------------------------------------------------------------- widths */

const THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Foo.jpg/320px-Foo.jpg'
const SVG_THUMB =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Bar.svg/240px-Bar.svg.png'

describe('thumbWidth / withThumbWidth', () => {
  it('reads the rendered width out of a thumbnail URL', () => {
    expect(thumbWidth(THUMB)).toBe(320)
    expect(thumbWidth(SVG_THUMB)).toBe(240)
  })

  it('returns null for a non-thumbnail URL', () => {
    expect(thumbWidth('https://upload.wikimedia.org/wikipedia/commons/a/ab/Foo.jpg')).toBeNull()
  })

  it('rewrites only the width segment', () => {
    expect(withThumbWidth(THUMB, 800)).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Foo.jpg/800px-Foo.jpg',
    )
    expect(withThumbWidth(SVG_THUMB, 800)).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Bar.svg/800px-Bar.svg.png',
    )
  })

  it('does not touch a directory that happens to contain px-', () => {
    const tricky = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/12px-x/Foo.jpg/320px-Foo.jpg'
    expect(withThumbWidth(tricky, 640)).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/12px-x/Foo.jpg/640px-Foo.jpg',
    )
  })

  it('rounds and floors the requested width', () => {
    expect(withThumbWidth(THUMB, 640.6)).toContain('/641px-')
    expect(withThumbWidth(THUMB, 0)).toContain('/1px-')
  })

  it('passes a non-thumbnail URL through unchanged', () => {
    const original = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Foo.jpg'
    expect(withThumbWidth(original, 800)).toBe(original)
  })
})

describe('chooseWidth', () => {
  it('asks for what the layout wants when the original is bigger', () => {
    expect(chooseWidth(740, 4000)).toBe(740)
  })
  it('never asks for more than the original has', () => {
    expect(chooseWidth(1200, 500)).toBe(500)
  })
  it('clamps to a floor so tiny targets still give a usable picture', () => {
    expect(chooseWidth(40, 4000)).toBe(200)
  })
  it('clamps to a ceiling', () => {
    expect(chooseWidth(9999, 99999)).toBe(2000)
  })
  it('applies the original cap after the floor, so a tiny original wins', () => {
    expect(chooseWidth(40, 90)).toBe(90)
  })
  it('ignores a missing or nonsense original width', () => {
    expect(chooseWidth(600)).toBe(600)
    expect(chooseWidth(600, 0)).toBe(600)
    expect(chooseWidth(600, -5)).toBe(600)
  })
  it('falls back to the default for a non-numeric target', () => {
    expect(chooseWidth(NaN, 4000)).toBe(640)
  })
})

/* ------------------------------------------------------------------ summary */

const summary = (over: Partial<WikiSummary> = {}): WikiSummary => ({
  title: 'Göbekli Tepe',
  description: 'Archaeological site in Turkey',
  extract: 'Göbekli Tepe is a Neolithic archaeological site…',
  thumbnail: { source: THUMB, width: 320, height: 213 },
  originalimage: {
    source: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Foo.jpg',
    width: 3000,
    height: 2000,
  },
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/G%C3%B6bekli_Tepe' } },
  ...over,
})

/**
 * These cases assert `pickImage`'s *first-choice URL*. They used to go through a
 * `pickImageUrl` wrapper in the library; nothing in the app called it, so the
 * wrapper is gone and the unwrapping happens here instead.
 */
const pickImageUrl = (summary: WikiSummary | null | undefined, targetWidth?: number): string | null =>
  pickImage(summary, targetWidth)?.url ?? null

describe('pickImage: the URL to try first', () => {
  it('upgrades the thumbnail to the requested width', () => {
    expect(pickImageUrl(summary(), 740)).toContain('/740px-')
  })

  it('caps at the original width', () => {
    expect(pickImageUrl(summary({ originalimage: { source: 'x', width: 480, height: 300 } }), 1200)).toContain(
      '/480px-',
    )
  })

  it('leaves the URL alone when the thumbnail is already the right size', () => {
    expect(pickImageUrl(summary(), 320)).toBe(THUMB)
  })

  it('uses a small originalimage when there is no thumbnail', () => {
    const small = { source: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Small.jpg', width: 900, height: 600 }
    expect(pickImageUrl(summary({ thumbnail: undefined, originalimage: small }), 740)).toBe(small.source)
  })

  it('refuses a full-size original: a 3000px scan is not a 330px panel picture', () => {
    // The summary carries no rendered thumbnail here, and the only other URL is
    // the original file itself — tens of megabytes for a box 330 CSS px wide.
    expect(pickImageUrl(summary({ thumbnail: undefined }), 740)).toBeNull()
  })

  it('skips a disambiguation page, whose "thumbnail" is the namespace icon', () => {
    expect(pickImageUrl(summary({ type: 'disambiguation' }), 740)).toBeNull()
  })

  it('returns null when the article has no picture at all', () => {
    expect(pickImageUrl(summary({ thumbnail: undefined, originalimage: undefined }), 740)).toBeNull()
    expect(pickImageUrl({}, 740)).toBeNull()
    expect(pickImageUrl(null)).toBeNull()
    expect(pickImageUrl(undefined)).toBeNull()
  })

  it('is defensive about wrong types in the response', () => {
    expect(pickImageUrl({ thumbnail: { source: 42 as unknown as string } })).toBeNull()
    expect(pickImageUrl({ thumbnail: {}, originalimage: {} })).toBeNull()
    expect(pickImageUrl({ thumbnail: { source: '' } })).toBeNull()
  })

  it('handles a thumbnail URL that is not in thumb form', () => {
    const flat = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Flat.png'
    expect(pickImageUrl(summary({ thumbnail: { source: flat, width: 500, height: 400 } }), 900)).toBe(flat)
  })
})

/* ------------------------------------------------- the upgrade is a guess */

describe('pickImage: an edited thumbnail URL never replaces the promised one', () => {
  it('keeps the API thumbnail as a fallback whenever it rewrites the width', () => {
    expect(pickImage(summary(), 740)).toEqual({
      url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Foo.jpg/740px-Foo.jpg',
      fallbackUrl: THUMB,
    })
  })

  it('does not rewrite when the response does not say how wide the original is', () => {
    // Without originalimage.width the request could ask the thumbnailer to
    // scale up, which it answers with a 404 rather than a bigger picture.
    expect(pickImage(summary({ originalimage: undefined }), 740)).toEqual({ url: THUMB })
  })

  it('does not rewrite a URL that is not in canonical NNNpx- thumb form', () => {
    // multi-page renderings (`lossy-page1-320px-…`) and video posters are named
    // differently; the width segment is not ours to edit.
    const page = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Doc.pdf/lossy-page1-320px-Doc.pdf.jpg'
    expect(pickImage(summary({ thumbnail: { source: page, width: 320, height: 240 } }), 740)).toEqual({
      url: page,
    })
  })

  it('does not rewrite when the original is no bigger than the thumbnail', () => {
    const s = summary({ originalimage: { source: 'x', width: 320, height: 213 } })
    expect(pickImage(s, 740)).toEqual({ url: THUMB })
  })

  it('never asks for a downgrade when the panel is narrower than the thumbnail', () => {
    expect(pickImage(summary(), 220)).toEqual({ url: THUMB })
  })

  it('an SVG rendering upgrades like any other thumbnail', () => {
    const s = summary({
      thumbnail: { source: SVG_THUMB, width: 240, height: 240 },
      originalimage: {
        source: 'https://upload.wikimedia.org/wikipedia/commons/1/12/Bar.svg',
        width: 512,
        height: 512,
      },
    })
    expect(pickImage(s, 740)).toEqual({
      url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Bar.svg/512px-Bar.svg.png',
      fallbackUrl: SVG_THUMB,
    })
  })

  it('carries the fallback through to the rendered image', () => {
    const img = imageFromSummary(summary(), { lang: 'en', title: 'X' }, 740)!
    expect(img.fallbackUrl).toBe(THUMB)
  })

  it('leaves fallbackUrl unset when the URL was not touched', () => {
    expect(imageFromSummary(summary(), { lang: 'en', title: 'X' }, 220)!.fallbackUrl).toBeUndefined()
  })
})

describe('imageFromSummary', () => {
  const ref = { lang: 'en', title: 'Göbekli_Tepe' }

  it('returns url, caption, attribution and reserved box', () => {
    const img = imageFromSummary(summary(), ref, 740)!
    expect(img.url).toContain('/740px-')
    expect(img.caption).toBe('Archaeological site in Turkey')
    expect(img.pageUrl).toBe('https://en.wikipedia.org/wiki/G%C3%B6bekli_Tepe')
    expect(img.width).toBe(740)
    // aspect ratio of the thumbnail is preserved: 320x213 → 740x493
    expect(img.height).toBe(Math.round((740 * 213) / 320))
  })

  it('derives the attribution URL when content_urls is missing', () => {
    const img = imageFromSummary(summary({ content_urls: undefined }), ref, 740)!
    expect(img.pageUrl).toBe('https://en.wikipedia.org/wiki/G%C3%B6bekli_Tepe')
  })

  it('ignores a content_urls page that is not http(s)', () => {
    const img = imageFromSummary(
      summary({ content_urls: { desktop: { page: 'javascript:alert(1)' } } }),
      ref,
      740,
    )!
    expect(img.pageUrl).toBe('https://en.wikipedia.org/wiki/G%C3%B6bekli_Tepe')
  })

  it('omits the caption when the API has no description', () => {
    expect(imageFromSummary(summary({ description: undefined }), ref)!.caption).toBeUndefined()
    expect(imageFromSummary(summary({ description: '   ' }), ref)!.caption).toBeUndefined()
  })

  it('does not use the long extract as a caption', () => {
    const img = imageFromSummary(summary(), ref)!
    expect(img.caption).not.toContain('Neolithic archaeological site')
  })

  it('falls back to the original size when the thumbnail has no dimensions', () => {
    const img = imageFromSummary(summary({ thumbnail: { source: THUMB } }), ref, 740)!
    expect(img.width).toBe(3000)
    expect(img.height).toBe(2000)
  })

  it('returns null when there is no picture', () => {
    expect(imageFromSummary({ description: 'x' }, ref)).toBeNull()
  })
})

/* ------------------------------------------------------- fetching and cache */

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const notFound = () =>
  ({ ok: false, status: 404, json: async () => ({ title: 'Not found' }) }) as unknown as Response
const status = (code: number) =>
  ({ ok: false, status: code, json: async () => ({}) }) as unknown as Response

/** A fetch whose responses resolve only when the test says so. */
function deferredFetch() {
  const calls: { url: string; signal?: AbortSignal; settle: (r: Response) => void; fail: (e: unknown) => void }[] = []
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const entry = { url: String(input), signal: init?.signal ?? undefined, settle: resolve, fail: reject }
      calls.push(entry)
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('fetchWikiSummary', () => {
  beforeEach(() => clearWikiImageCache())

  it('requests the summary endpoint and returns the parsed body', async () => {
    const impl = vi.fn(async () => ok(summary())) as unknown as typeof fetch
    const got = await fetchWikiSummary({ lang: 'en', title: 'Jericho' }, { fetchImpl: impl })
    expect(got?.description).toBe('Archaeological site in Turkey')
    expect(vi.mocked(impl).mock.calls[0][0]).toBe(
      'https://en.wikipedia.org/api/rest_v1/page/summary/Jericho',
    )
  })

  /* The endpoint 301s a non-normalised title and 302s a redirect article, and a
     browser will not follow a redirect on a request that needed a CORS
     pre-flight. So the request has to stay simple: GET, no request headers. */
  it('asks with a bare, never-pre-flighted GET that follows redirects', async () => {
    const impl = vi.fn(async () => ok(summary())) as unknown as typeof fetch
    await fetchWikiSummary({ lang: 'en', title: 'Jericho' }, { fetchImpl: impl })
    const init = vi.mocked(impl).mock.calls[0][1]!
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.headers).toBeUndefined()
    expect(init.redirect ?? 'follow').toBe('follow')
    expect(init.credentials).toBe('omit')
    expect(init.mode).toBe('cors')
  })

  it('memoises by title for the session — a second ask makes no request', async () => {
    const impl = vi.fn(async () => ok(summary())) as unknown as typeof fetch
    const ref = { lang: 'en', title: 'Jericho' }
    await fetchWikiSummary(ref, { fetchImpl: impl })
    await fetchWikiSummary(ref, { fetchImpl: impl })
    expect(vi.mocked(impl)).toHaveBeenCalledTimes(1)
    expect(wikiCacheStats()).toEqual({ cached: 1, pending: 0 })
  })

  it('caches a miss too, so a missing article is asked for once', async () => {
    const impl = vi.fn(async () => notFound()) as unknown as typeof fetch
    await fetchWikiSummary({ lang: 'en', title: 'Nope' }, { fetchImpl: impl })
    const second = await fetchWikiSummary({ lang: 'en', title: 'Nope' }, { fetchImpl: impl })
    expect(second).toBeNull()
    expect(vi.mocked(impl)).toHaveBeenCalledTimes(1)
  })

  /* A missing article is a fact; a failed request is a moment. Remembering the
     second is how one bad minute leaves a whole session with no pictures. */
  it('does not remember a network failure — the next open asks again', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const ref = { lang: 'en', title: 'Jericho' }
    expect(await fetchWikiSummary(ref, { fetchImpl: impl })).toBeNull()
    expect(wikiCacheStats().cached).toBe(0)

    const second = vi.fn(async () => ok(summary())) as unknown as typeof fetch
    expect(await fetchWikiSummary(ref, { fetchImpl: second })).not.toBeNull()
    expect(vi.mocked(second)).toHaveBeenCalledTimes(1)
  })

  it('does not remember a 503, a 429 or any other transient HTTP answer', async () => {
    for (const code of [429, 500, 502, 503]) {
      clearWikiImageCache()
      const impl = vi.fn(async () => status(code)) as unknown as typeof fetch
      expect(await fetchWikiSummary({ lang: 'en', title: 'X' }, { fetchImpl: impl })).toBeNull()
      expect(wikiCacheStats().cached).toBe(0)
    }
  })

  it('does remember a 404 and a 410 — those articles will not appear later', async () => {
    for (const code of [404, 410]) {
      clearWikiImageCache()
      const impl = vi.fn(async () => status(code)) as unknown as typeof fetch
      const ref = { lang: 'en', title: 'Gone' }
      await fetchWikiSummary(ref, { fetchImpl: impl })
      await fetchWikiSummary(ref, { fetchImpl: impl })
      expect(vi.mocked(impl)).toHaveBeenCalledTimes(1)
      expect(wikiCacheStats().cached).toBe(1)
    }
  })

  it('remembers an article that simply has no picture', async () => {
    const impl = vi.fn(async () => ok({ type: 'standard', title: 'HIV/AIDS' })) as unknown as typeof fetch
    const ref = { lang: 'en', title: 'HIV/AIDS' }
    await fetchWikiSummary(ref, { fetchImpl: impl })
    await fetchWikiSummary(ref, { fetchImpl: impl })
    expect(vi.mocked(impl)).toHaveBeenCalledTimes(1)
  })

  it('keeps different languages apart', async () => {
    const impl = vi.fn(async () => ok(summary())) as unknown as typeof fetch
    await fetchWikiSummary({ lang: 'en', title: 'Rome' }, { fetchImpl: impl })
    await fetchWikiSummary({ lang: 'de', title: 'Rome' }, { fetchImpl: impl })
    expect(vi.mocked(impl)).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent asks for the same article into one request', async () => {
    const { impl, calls } = deferredFetch()
    const ref = { lang: 'en', title: 'Jericho' }
    const a = fetchWikiSummary(ref, { fetchImpl: impl })
    const b = fetchWikiSummary(ref, { fetchImpl: impl })
    expect(calls).toHaveLength(1)
    calls[0].settle(ok(summary()))
    expect((await a)?.title).toBe('Göbekli Tepe')
    expect((await b)?.title).toBe('Göbekli Tepe')
  })

  it('returns null and aborts the request when the only caller gives up', async () => {
    const { impl, calls } = deferredFetch()
    const ctl = new AbortController()
    const p = fetchWikiSummary({ lang: 'en', title: 'Jericho' }, { fetchImpl: impl, signal: ctl.signal })
    ctl.abort()
    expect(await p).toBeNull()
    expect(calls[0].signal?.aborted).toBe(true)
    expect(wikiCacheStats().pending).toBe(0)
  })

  it('does not cache an aborted request as "no picture"', async () => {
    const { impl, calls } = deferredFetch()
    const ref = { lang: 'en', title: 'Jericho' }
    const ctl = new AbortController()
    const p = fetchWikiSummary(ref, { fetchImpl: impl, signal: ctl.signal })
    ctl.abort()
    await p
    expect(wikiCacheStats().cached).toBe(0)

    // the next open of the same event asks again, and succeeds
    const p2 = fetchWikiSummary(ref, { fetchImpl: impl })
    calls[1].settle(ok(summary()))
    expect(await p2).not.toBeNull()
  })

  it('one caller aborting does not cancel a request another caller still needs', async () => {
    const { impl, calls } = deferredFetch()
    const ref = { lang: 'en', title: 'Jericho' }
    const ctl = new AbortController()
    const doomed = fetchWikiSummary(ref, { fetchImpl: impl, signal: ctl.signal })
    const keeper = fetchWikiSummary(ref, { fetchImpl: impl })
    ctl.abort()
    expect(await doomed).toBeNull()
    expect(calls[0].signal?.aborted).toBe(false)
    calls[0].settle(ok(summary()))
    expect(await keeper).not.toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('survives a rapid A → B → A bounce with the A request intact', async () => {
    const { impl, calls } = deferredFetch()
    const a = { lang: 'en', title: 'A' }
    const b = { lang: 'en', title: 'B' }
    const c1 = new AbortController()
    const c2 = new AbortController()
    const first = fetchWikiSummary(a, { fetchImpl: impl, signal: c1.signal })
    c1.abort() // user moved to B
    const second = fetchWikiSummary(b, { fetchImpl: impl, signal: c2.signal })
    c2.abort() // user moved back to A
    const third = fetchWikiSummary(a, { fetchImpl: impl })
    expect(await first).toBeNull()
    expect(await second).toBeNull()
    calls[calls.length - 1].settle(ok(summary()))
    expect(await third).not.toBeNull()
  })

  it('returns null immediately for an already-aborted signal, without fetching', async () => {
    const impl = vi.fn(async () => ok(summary())) as unknown as typeof fetch
    const ctl = new AbortController()
    ctl.abort()
    expect(await fetchWikiSummary({ lang: 'en', title: 'X' }, { fetchImpl: impl, signal: ctl.signal })).toBeNull()
    expect(vi.mocked(impl)).not.toHaveBeenCalled()
  })

  it('still serves an aborting caller from cache', async () => {
    const impl = vi.fn(async () => ok(summary())) as unknown as typeof fetch
    const ref = { lang: 'en', title: 'Jericho' }
    await fetchWikiSummary(ref, { fetchImpl: impl })
    const ctl = new AbortController()
    const p = fetchWikiSummary(ref, { fetchImpl: impl, signal: ctl.signal })
    ctl.abort()
    expect(await p).not.toBeNull() // resolved from cache before the signal mattered
  })

  it('returns null on a network failure', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    expect(await fetchWikiSummary({ lang: 'en', title: 'X' }, { fetchImpl: impl })).toBeNull()
  })

  it('returns null on an HTTP error', async () => {
    const impl = vi.fn(async () => notFound()) as unknown as typeof fetch
    expect(await fetchWikiSummary({ lang: 'en', title: 'X' }, { fetchImpl: impl })).toBeNull()
  })

  it('returns null on a body that is not JSON', async () => {
    const impl = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    })) as unknown as typeof fetch
    expect(await fetchWikiSummary({ lang: 'en', title: 'X' }, { fetchImpl: impl })).toBeNull()
  })

  it('returns null on a JSON body that is not an object', async () => {
    const impl = vi.fn(async () => ok('nope')) as unknown as typeof fetch
    expect(await fetchWikiSummary({ lang: 'en', title: 'X' }, { fetchImpl: impl })).toBeNull()
  })

  it('clearWikiImageCache forgets everything and aborts what is in flight', async () => {
    const { impl, calls } = deferredFetch()
    void fetchWikiSummary({ lang: 'en', title: 'Jericho' }, { fetchImpl: impl })
    expect(wikiCacheStats().pending).toBe(1)
    clearWikiImageCache()
    expect(wikiCacheStats()).toEqual({ cached: 0, pending: 0 })
    expect(calls[0].signal?.aborted).toBe(true)
  })
})

describe('fetchWikiImage', () => {
  beforeEach(() => clearWikiImageCache())

  it('goes from an article URL to a rendered picture', async () => {
    const impl = vi.fn(async () => ok(summary())) as unknown as typeof fetch
    const img = await fetchWikiImage('https://en.wikipedia.org/wiki/Göbekli_Tepe', {
      fetchImpl: impl,
      targetWidth: 700,
    })
    expect(img?.url).toContain('/700px-')
    expect(img?.caption).toBe('Archaeological site in Turkey')
    expect(img?.pageUrl).toContain('en.wikipedia.org/wiki/')
  })

  it('returns null for a link that is not a Wikipedia article, without fetching', async () => {
    const impl = vi.fn(async () => ok(summary())) as unknown as typeof fetch
    expect(await fetchWikiImage('https://nasa.gov/x', { fetchImpl: impl })).toBeNull()
    expect(await fetchWikiImage(null, { fetchImpl: impl })).toBeNull()
    expect(vi.mocked(impl)).not.toHaveBeenCalled()
  })

  it('returns null when the article exists but has no picture', async () => {
    const impl = vi.fn(async () => ok({ title: 'X', description: 'y' })) as unknown as typeof fetch
    expect(await fetchWikiImage('https://en.wikipedia.org/wiki/X', { fetchImpl: impl })).toBeNull()
  })

  it('returns null when the caller aborted mid-flight', async () => {
    const { impl } = deferredFetch()
    const ctl = new AbortController()
    const p = fetchWikiImage('https://en.wikipedia.org/wiki/X', { fetchImpl: impl, signal: ctl.signal })
    ctl.abort()
    expect(await p).toBeNull()
  })
})
