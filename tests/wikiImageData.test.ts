import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type HistoricalEvent } from '../src/lib/events'
import { type EventManifest } from '../src/lib/eventChunks'
import { parseWikiUrl, summaryUrl, wikiRefForEvent, type WikiRef } from '../src/lib/wikiImage'

/**
 * The title-extraction half of the picture lookup, run over the actual shipped
 * dataset rather than over hand-written examples.
 *
 * The unit tests next door prove that `parseWikiUrl` handles fragments, mobile
 * hosts, percent-encoding and namespaces. They cannot prove that the dataset
 * only contains link shapes it handles — which is the failure that matters,
 * because a title this misreads is an event with no picture and no error. So
 * every event in every chunk goes through the exact production path, and the
 * expectation is total: all of them resolve, or the ones that do not are named
 * here on purpose.
 */
const DIR = join(__dirname, '..', 'public', 'data', 'events')
const readJson = (f: string) => JSON.parse(readFileSync(join(DIR, f), 'utf8'))
const manifest = readJson('manifest.json') as EventManifest
const all = [readJson(manifest.spine), ...manifest.chunks.map((c) => readJson(c.file))].flat() as HistoricalEvent[]

// The spine repeats events that also live in an era chunk; the store dedupes by
// id on merge, so the test looks at the same set the app does.
const events = [...new Map(all.map((e) => [e.id, e])).values()]

/**
 * Events that legitimately resolve to no article. Empty today: every event in
 * the dataset carries a `links[] → Wikipedia` entry. An addition here has to be
 * a deliberate choice, not an extraction bug that went unnoticed.
 */
const NO_ARTICLE: string[] = []

const refs = new Map<string, WikiRef>()
for (const e of events) {
  const ref = wikiRefForEvent(e)
  if (ref) refs.set(e.id, ref)
}

describe('the shipped dataset resolves to Wikipedia articles', () => {
  it('has the whole dataset to work with', () => {
    expect(events.length).toBeGreaterThanOrEqual(560)
  })

  it('yields an article title for every event, or a documented none', () => {
    const missing = events.filter((e) => !refs.has(e.id)).map((e) => e.id)
    expect(missing.sort()).toEqual([...NO_ARTICLE].sort())
  })

  it('finds the article in the structured links[] field, not by scraping prose', () => {
    // The body's "More at [Wikipedia](…)" line is a fallback. If it ever becomes
    // the only source for an event, markdown punctuation starts deciding titles.
    for (const e of events) {
      if (!refs.has(e.id)) continue
      const fromLinks = (e.links ?? []).map((l) => parseWikiUrl(l?.url)).find(Boolean)
      expect(fromLinks?.title, e.id).toBe(refs.get(e.id)!.title)
    }
  })

  it('produces clean titles: no fragment, query, stray encoding or edge separator', () => {
    for (const [id, ref] of refs) {
      expect(ref.title.length, id).toBeGreaterThan(0)
      expect(ref.title, id).not.toMatch(/[#?]/)
      expect(ref.title, id).not.toMatch(/%[0-9A-Fa-f]{2}/) // decoded exactly once
      expect(ref.title, id).not.toMatch(/\s/) // spaces are underscores by now
      expect(ref.title, id).not.toMatch(/^_|_$/)
      expect(ref.title, id).not.toMatch(/__/)
      // markdown link parsing must not have swallowed the sentence's full stop
      expect(ref.title, id).not.toMatch(/[,;:!]$/)
    }
  })

  it('keeps the trailing dot of a title that really ends in one', () => {
    // `Assassination_of_Martin_Luther_King_Jr.` — a naive "strip trailing
    // punctuation" pass would break this article and only this article.
    expect(refs.get('mlk-assassination')?.title).toBe('Assassination_of_Martin_Luther_King_Jr.')
  })

  it('is all English Wikipedia, so one endpoint serves the whole dataset', () => {
    for (const [id, ref] of refs) expect(ref.lang, id).toBe('en')
  })

  it('builds a well-formed, singly-encoded summary URL for every event', () => {
    for (const [id, ref] of refs) {
      const url = summaryUrl(ref)
      expect(url.startsWith('https://en.wikipedia.org/api/rest_v1/page/summary/'), id).toBe(true)
      const encoded = url.slice('https://en.wikipedia.org/api/rest_v1/page/summary/'.length)
      expect(encoded.length, id).toBeGreaterThan(0)
      // a path segment: any slash in the title is encoded (`HIV/AIDS`)
      expect(encoded, id).not.toMatch(/\//)
      expect(decodeURIComponent(encoded), id).toBe(ref.title)
      expect(() => new URL(url)).not.toThrow()
    }
  })

  it('covers the awkward real titles the dataset actually contains', () => {
    // one of each shape that has broken a URL builder before
    expect(summaryUrl(refs.get('gobekli-tepe')!)).toBe(
      'https://en.wikipedia.org/api/rest_v1/page/summary/G%C3%B6bekli_Tepe',
    )
    expect(summaryUrl(refs.get('aids-identified')!)).toBe(
      'https://en.wikipedia.org/api/rest_v1/page/summary/HIV%2FAIDS',
    )
    expect(summaryUrl(refs.get('egypt-unification')!)).toBe(
      'https://en.wikipedia.org/api/rest_v1/page/summary/Early_Dynastic_Period_(Egypt)',
    )
    expect(summaryUrl(refs.get('kpg-extinction')!)).toBe(
      'https://en.wikipedia.org/api/rest_v1/page/summary/Cretaceous%E2%80%93Paleogene_extinction_event',
    )
  })

  it('asks for each distinct article once, however many events point at it', () => {
    const keys = new Set([...refs.values()].map((r) => `${r.lang}:${r.title}`))
    expect(keys.size).toBeLessThanOrEqual(refs.size)
    expect(keys.size).toBeGreaterThan(500)
  })
})
