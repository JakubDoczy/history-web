import { describe, it, expect } from 'vitest'
import {
  BUILD,
  MIN_GAP_MS,
  POLL_MS,
  buildLabel,
  checkDue,
  fetchStamp,
  isUpdate,
  readStamp,
  versionUrl,
  type BuildStamp,
} from '../src/lib/build'

/**
 * THE BUILD STAMP — the answer to "which build is that device running?".
 *
 * GitHub Pages hands out index.html with a ten-minute max-age, a phone caches
 * it well past that, and a tab on a home screen is never reloaded at all, so a
 * device can run a build from two rounds ago while the origin has had the new
 * one all along. Everything here exists so the app can *tell*, and so it can
 * offer the reader the one thing that fixes it.
 */

const mine: BuildStamp = { id: 'a1b2c3d', at: '2026-08-06T09:12:00Z' }

describe('the stamp compiled into the bundle', () => {
  it('is two strings, and they are in the bundle rather than fetched', () => {
    expect(typeof BUILD.id).toBe('string')
    expect(typeof BUILD.at).toBe('string')
    expect(BUILD.id.length).toBeGreaterThan(0)
    // an ISO instant to the second — the half that tells two builds of one
    // commit apart, which is exactly the dirty-tree case
    expect(BUILD.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('says which build this is in a line a human can read out', () => {
    expect(buildLabel(mine)).toBe('build a1b2c3d · 2026-08-06')
    // the date, not the whole timestamp: it is read down a phone line and
    // compared with a deploy log, and the hash is what identifies it
    expect(buildLabel(mine)).not.toContain('T')
  })
})

describe('what the server says it is serving', () => {
  it('asks for a URL nothing between here and the origin has ever seen', () => {
    expect(versionUrl('/history-web/', 1754_400_000_000)).toBe(
      '/history-web/version.json?ts=1754400000000',
    )
    // two different moments are two different URLs — that is the whole point
    expect(versionUrl('/', 1)).not.toBe(versionUrl('/', 2))
  })

  /**
   * A 404 on GitHub Pages is this app's own index.html, and a captive portal
   * serves a login page for everything. "The fetch resolved" says nothing, so
   * anything that is not the two fields is NOT AN ANSWER.
   */
  it('refuses to read a stamp out of anything that is not one', () => {
    expect(readStamp({ id: 'abc', at: '2026-01-01T00:00:00Z' })).toEqual({
      id: 'abc',
      at: '2026-01-01T00:00:00Z',
    })
    for (const junk of [null, undefined, 0, '', 'abc', [], {}, { id: 'abc' }, { at: 'x' }, { id: 1, at: 2 }, { id: '', at: 'x' }])
      expect(readStamp(junk), JSON.stringify(junk) ?? 'undefined').toBeNull()
  })

  it('is news only when the two stamps differ — and silence otherwise', () => {
    expect(isUpdate({ ...mine }, mine)).toBe(false)
    expect(isUpdate({ id: 'ffffff1', at: mine.at }, mine)).toBe(true)
    // a rebuild of a dirty tree carries the previous commit's hash, and that is
    // precisely the case a reader cannot spot by eye
    expect(isUpdate({ id: mine.id, at: '2026-08-06T11:00:00Z' }, mine)).toBe(true)
  })

  /** Different, not newer: a rollback is a deploy, and the tab holding code the
   *  server no longer serves is exactly who the toast is for. */
  it('treats an older build on the server as news too', () => {
    expect(isUpdate({ id: 'older11', at: '2020-01-01T00:00:00Z' }, mine)).toBe(true)
  })

  it('never nags on an error page, an outage or a truncated body', () => {
    for (const junk of [null, 'not json', { hello: 'world' }, ['a1b2c3d']])
      expect(isUpdate(junk, mine)).toBe(false)
  })
})

describe('how often it is allowed to ask', () => {
  it('asks at once the first time and then not inside the guard', () => {
    expect(checkDue(0, 1_000_000)).toBe(true) // never asked
    expect(checkDue(1_000_000, 1_000_000 + MIN_GAP_MS - 1)).toBe(false)
    expect(checkDue(1_000_000, 1_000_000 + MIN_GAP_MS)).toBe(true)
  })

  it('polls on a scale of minutes, not seconds', () => {
    expect(POLL_MS).toBeGreaterThanOrEqual(60_000)
    expect(MIN_GAP_MS).toBeLessThan(POLL_MS)
  })
})

describe('fetching it', () => {
  const res = (body: unknown, ok = true) =>
    ({ ok, json: async () => body }) as unknown as Response

  it('sends the request past every cache there is', async () => {
    let seen: [string, RequestInit | undefined] = ['', undefined]
    await fetchStamp('/history-web/', 7, (async (u: string, o: RequestInit) => {
      seen = [u, o]
      return res({ id: 'x', at: 'y' })
    }) as unknown as typeof fetch)
    expect(seen[0]).toBe('/history-web/version.json?ts=7')
    expect(seen[1]?.cache).toBe('no-store')
  })

  it('is silent — not wrong — when the network is', async () => {
    const boom = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await fetchStamp('/', 1, boom)).toBeNull()
    expect(await fetchStamp('/', 1, (async () => res({}, false)) as unknown as typeof fetch)).toBeNull()
    expect(
      await fetchStamp('/', 1, (async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('<!doctype html>')
        },
      })) as unknown as typeof fetch),
    ).toBeNull()
  })
})
