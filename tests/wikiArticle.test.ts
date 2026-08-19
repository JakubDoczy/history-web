import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  actionParseUrl,
  adaptArticleHtml,
  canGoBack,
  classifyHref,
  clearWikiArticleCache,
  currentRef,
  emitAs,
  endpointChain,
  fetchArticle,
  htmlFromActionParse,
  imageSrc,
  isChrome,
  loadArticle,
  mobileHtmlUrl,
  opensInReader,
  popHistory,
  pushHistory,
  restHtmlUrl,
  tokenize,
  WikiArticleError,
  type WikiRef,
} from '../src/lib/wikiArticle'

const EN: WikiRef = { lang: 'en', title: 'Roman_aqueduct' }
const adapt = (html: string, ref: WikiRef = EN) => adaptArticleHtml(html, { ref })

/* ------------------------------------------------------------------- URLs */

describe('the endpoint chain', () => {
  it('asks Parsoid page HTML first, mobile-html second, the action API last', () => {
    expect(endpointChain(EN).map((s) => s.name)).toEqual(['rest-html', 'mobile-html', 'action-parse'])
  })

  it('builds the rest_v1 URLs on the article language, with the title encoded', () => {
    expect(restHtmlUrl({ lang: 'en', title: 'Göbekli_Tepe' })).toBe(
      'https://en.wikipedia.org/api/rest_v1/page/html/G%C3%B6bekli_Tepe',
    )
    expect(mobileHtmlUrl({ lang: 'de', title: 'Köln' })).toBe(
      'https://de.wikipedia.org/api/rest_v1/page/mobile-html/K%C3%B6ln',
    )
  })

  it('sends the action API a literal origin=*, which is what makes it CORS-readable', () => {
    const url = actionParseUrl(EN)
    expect(url).toContain('origin=*')
    expect(url).not.toContain('origin=%2A')
    expect(url).toContain('action=parse')
    expect(url).toContain('prop=text')
    expect(url).toContain('redirects=1') // the redirect is followed server-side here
    expect(url).toContain('formatversion=2')
  })

  it('falls back to English for a nonsense language code', () => {
    expect(restHtmlUrl({ lang: 'not a lang', title: 'X' })).toContain('https://en.wikipedia.org/')
  })
})

describe('htmlFromActionParse', () => {
  it('reads formatversion=2, where text is a string', () => {
    expect(htmlFromActionParse({ parse: { text: '<p>hi</p>' } })).toBe('<p>hi</p>')
  })
  it('reads the legacy shape, where text is { "*": html }', () => {
    expect(htmlFromActionParse({ parse: { text: { '*': '<p>hi</p>' } } })).toBe('<p>hi</p>')
  })
  it('reads an API error as no HTML at all', () => {
    expect(htmlFromActionParse({ error: { code: 'missingtitle' } })).toBeNull()
    expect(htmlFromActionParse(null)).toBeNull()
    expect(htmlFromActionParse('<p>not json</p>')).toBeNull()
  })
})

/* --------------------------------------------------------------- tokenizer */

describe('the tokenizer', () => {
  it('splits tags, attributes and text', () => {
    const t = [...tokenize('<p class="a">hi <b>there</b></p>')]
    expect(t).toEqual([
      { kind: 'open', name: 'p', attrs: { class: 'a' }, selfClosing: false },
      { kind: 'text', text: 'hi ' },
      { kind: 'open', name: 'b', attrs: {}, selfClosing: false },
      { kind: 'text', text: 'there' },
      { kind: 'close', name: 'b' },
      { kind: 'close', name: 'p' },
    ])
  })

  it('treats a bare < in prose as text, not as a tag', () => {
    expect(adapt('<p>2 < 3 and 4 > 1</p>')).toBe('<p>2 < 3 and 4 > 1</p>')
  })

  it('reads single-quoted, unquoted and valueless attributes', () => {
    const [tok] = [...tokenize("<img src='a.png' width=12 hidden>")]
    expect(tok).toMatchObject({ attrs: { src: 'a.png', width: '12', hidden: '' } })
  })

  it('does not tokenize the contents of a style element', () => {
    const kinds = [...tokenize('<style>a > b { content: "<p>" }</style><p>x</p>')].map((t) => t.kind)
    // open style, close style, open p, text, close p — nothing from inside the CSS
    expect(kinds).toEqual(['open', 'close', 'open', 'text', 'close'])
  })

  it('skips comments and doctypes', () => {
    expect(adapt('<!DOCTYPE html><!-- <script>x</script> --><p>a</p>')).toBe('<p>a</p>')
  })
})

/* -------------------------------------------------------------- the strip */

describe('what counts as chrome', () => {
  it('drops scripts, styles and embedded frames wholesale', () => {
    expect(isChrome('script', {})).toBe(true)
    expect(isChrome('iframe', {})).toBe(true)
    expect(isChrome('p', {})).toBe(false)
  })

  it('drops navboxes, edit sections, reference apparatus and the TOC', () => {
    for (const cls of [
      'navbox',
      'vertical-navbox',
      'mw-editsection',
      'reflist',
      'mw-references-wrap',
      'mw-cite-backlink',
      'reference',
      'toc',
      'metadata',
      'noprint',
    ])
      expect(isChrome('div', { class: cls })).toBe(true)
  })

  it('drops the coordinate blob an infobox carries, on this of all apps', () => {
    expect(isChrome('span', { class: 'geo-dec' })).toBe(true)
    expect(isChrome('span', { id: 'coordinates' })).toBe(true)
  })

  it('drops generated class families by prefix', () => {
    expect(isChrome('table', { class: 'ambox mbox-small' })).toBe(true)
    expect(isChrome('div', { class: 'pcs-edit-section-link-container' })).toBe(true)
  })

  it('keeps an ordinary paragraph with an unrelated class', () => {
    expect(isChrome('p', { class: 'mw-parser-output-thing' })).toBe(false)
  })

  it('never reads the document itself as chrome, whatever class a renderer hangs on it', () => {
    // mobile-html ships `<body class="… pcs-body">`; reading that as chrome
    // dropped the whole article and left the reader empty.
    expect(isChrome('body', { class: 'mw-body content mediawiki pcs-body' })).toBe(false)
    expect(isChrome('html', { class: 'client-js' })).toBe(false)
  })

  it("drops mobile-html's edit and footer furniture without dropping what it wraps", () => {
    expect(isChrome('div', { class: 'pcs-edit-section-header' })).toBe(true)
    expect(isChrome('div', { class: 'pcs-footer-container' })).toBe(true)
    expect(isChrome('figure', { class: 'pcs-widen-image-ancestor' })).toBe(false)
  })
})

describe('adaptArticleHtml — the cut', () => {
  it('removes a script and everything in it', () => {
    expect(adapt('<p>a</p><script>alert("<p>x</p>")</script><p>b</p>')).toBe('<p>a</p><p>b</p>')
  })

  it('removes a navbox and its whole subtree, keeping what follows', () => {
    const html = '<p>text</p><div class="navbox"><ul><li><a href="/wiki/X">X</a></li></ul></div><p>after</p>'
    expect(adapt(html)).toBe('<p>text</p><p>after</p>')
  })

  it('removes edit links and inline reference markers from a paragraph', () => {
    const html =
      '<h2>Aqueducts<span class="mw-editsection">[<a href="/w/index.php?title=X&action=edit">edit</a>]</span></h2>' +
      '<p>Water flowed<sup class="reference"><a href="#cite_note-1">[1]</a></sup> downhill.</p>'
    expect(adapt(html)).toBe('<h2>Aqueducts</h2><p>Water flowed downhill.</p>')
  })

  it('removes the reference list, backlinks and all', () => {
    const html =
      '<p>body</p><ol class="references"><li><span class="mw-cite-backlink"><a href="#cite_ref-1">↑</a></span> A citation.</li></ol>'
    expect(adapt(html)).toBe('<p>body</p>')
  })

  it('keeps headings, paragraphs, lists and tables', () => {
    const html =
      '<h2>H</h2><p>P</p><ul><li>one</li></ul><table><tr><th scope="col">A</th><td colspan="2">B</td></tr></table>'
    expect(adapt(html)).toBe(
      '<h2>H</h2><p>P</p><ul><li>one</li></ul><table><tr><th scope="col">A</th><td colspan="2">B</td></tr></table>',
    )
  })

  it('unwraps an element it does not know, rather than losing the text inside it', () => {
    expect(adapt('<article><p>kept</p></article>')).toBe('<p>kept</p>')
    expect(adapt('<marquee>words</marquee>')).toBe('words')
  })

  it('drops every attribute that is not on the allowlist — class, style, id, data-mw, on*', () => {
    const out = adapt(
      '<p class="mw-heading" style="color:red" id="x" data-mw="{}" onclick="steal()">a</p>',
    )
    expect(out).toBe('<p>a</p>')
  })

  it('cannot be talked into emitting an event handler through an attribute value', () => {
    const out = adapt('<img src="//upload.wikimedia.org/a.png" onerror="alert(1)" alt="\\" onerror=x">')
    expect(out).not.toContain('onerror')
    expect(out).toContain('src="https://upload.wikimedia.org/a.png"')
  })

  it('closes what the source left open, and ignores a stray close tag', () => {
    expect(adapt('<p>a<em>b')).toBe('<p>a<em>b</em></p>')
    expect(adapt('</div><p>a</p>')).toBe('<p>a</p>')
  })

  it('leaves no empty shells behind after the cut', () => {
    expect(adapt('<p><span class="navbox">x</span></p><p>real</p>')).toBe('<p>real</p>')
  })
})

/* --------------------------------------------------------------- demotion */

describe('adaptArticleHtml — demotion to our own chrome', () => {
  it('promotes the action API thumb divs to a semantic figure', () => {
    expect(emitAs('div', { class: 'thumb tright' })).toBe('figure')
    expect(emitAs('div', { class: 'thumbcaption' })).toBe('figcaption')
    const html =
      '<div class="thumb tright"><div class="thumbinner"><a href="/wiki/File:A.jpg"><img src="//upload.wikimedia.org/a.jpg" width="220" height="150"></a><div class="thumbcaption">A caption</div></div></div>'
    expect(adapt(html)).toBe(
      '<figure><img loading="lazy" decoding="async" src="https://upload.wikimedia.org/a.jpg" width="220" height="150"><figcaption>A caption</figcaption></figure>',
    )
  })

  it("keeps Parsoid's own figure as it stands", () => {
    const html =
      '<figure class="mw-default-size" typeof="mw:File/Thumb"><a href="./File:A.jpg" class="mw-file-description"><img resource="./File:A.jpg" src="//upload.wikimedia.org/a.jpg" width="320" height="200"></a><figcaption>Pont du Gard</figcaption></figure>'
    expect(adapt(html)).toBe(
      '<figure><img loading="lazy" decoding="async" src="https://upload.wikimedia.org/a.jpg" width="320" height="200"><figcaption>Pont du Gard</figcaption></figure>',
    )
  })

  it('lazily loads every picture it keeps', () => {
    expect(adapt('<img src="//upload.wikimedia.org/a.jpg">')).toContain('loading="lazy"')
  })

  it('unwraps a generic wrapper by class, but never an element that means something', () => {
    expect(emitAs('div', { class: 'pcs-widen-image-ancestor' })).toBeNull()
    expect(emitAs('div', { class: 'thumbinner' })).toBeNull()
    expect(emitAs('figure', { class: 'pcs-widen-image-ancestor' })).toBe('figure')
  })

  it('keeps a whole mobile-html picture: the figure, the promoted src and the caption', () => {
    const html =
      '<figure class="pcs-widen-image-ancestor"><span><img class="pcs-lazy-load-placeholder" src="data:image/gif;base64,R0lGOD" data-src="//upload.wikimedia.org/w/Wagram.jpg" width="640" height="420"></span><figcaption>Wagram, 1809.</figcaption></figure>'
    expect(adapt(html)).toBe(
      '<figure><span><img loading="lazy" decoding="async" src="https://upload.wikimedia.org/w/Wagram.jpg" width="640" height="420"></span><figcaption>Wagram, 1809.</figcaption></figure>',
    )
  })

  it("promotes mobile-html's data-src placeholder to a real src", () => {
    expect(imageSrc({ src: 'data:image/gif;base64,R0lGOD', 'data-src': '//upload.wikimedia.org/b.jpg' })).toBe(
      'https://upload.wikimedia.org/b.jpg',
    )
  })

  it('drops a picture served from anywhere but Wikimedia', () => {
    expect(imageSrc({ src: 'https://tracker.example.com/pixel.gif' })).toBeNull()
    expect(imageSrc({ src: 'data:image/png;base64,AAA' })).toBeNull()
    expect(adapt('<p>a<img src="https://evil.example/x.png">b</p>')).toBe('<p>ab</p>')
  })

  it('keeps only geometry and alt text on a picture', () => {
    const out = adapt('<img src="//upload.wikimedia.org/a.jpg" alt="An arch" width="10" height="4" srcset="x 2x" class="thumbimage">')
    expect(out).toBe(
      '<img loading="lazy" decoding="async" src="https://upload.wikimedia.org/a.jpg" alt="An arch" width="10" height="4">',
    )
  })
})

/* ------------------------------------------------------------ link rewrite */

describe('classifyHref', () => {
  it("resolves Parsoid's relative form to an article in the reader", () => {
    expect(classifyHref('./Pont_du_Gard', EN)).toEqual({
      kind: 'internal',
      ref: { lang: 'en', title: 'Pont_du_Gard' },
      href: 'https://en.wikipedia.org/wiki/Pont_du_Gard',
    })
  })

  it('resolves the rooted form the action API writes', () => {
    expect(classifyHref('/wiki/Pont_du_Gard', EN)).toMatchObject({ kind: 'internal' })
  })

  it('resolves relative links in the article language, not always English', () => {
    const de = classifyHref('./Köln', { lang: 'de', title: 'Rom' })
    expect(de).toMatchObject({ kind: 'internal', ref: { lang: 'de', title: 'Köln' } })
  })

  it('drops the section anchor and goes to the article', () => {
    expect(classifyHref('/wiki/Pont_du_Gard#History', EN)).toMatchObject({
      kind: 'internal',
      ref: { lang: 'en', title: 'Pont_du_Gard' },
    })
  })

  it('treats an absolute Wikipedia link as internal too', () => {
    expect(classifyHref('https://en.wikipedia.org/wiki/Nimes', EN)).toMatchObject({ kind: 'internal' })
  })

  it('sends anything else out to a new tab', () => {
    expect(classifyHref('https://example.org/a', EN)).toEqual({
      kind: 'external',
      href: 'https://example.org/a',
    })
    expect(classifyHref('//example.org/a', EN)).toEqual({
      kind: 'external',
      href: 'https://example.org/a',
    })
  })

  it('strips same-page anchors, edit links, machinery and dangerous schemes', () => {
    expect(classifyHref('#cite_note-1', EN)).toEqual({ kind: 'strip' })
    expect(classifyHref('/w/index.php?title=X&action=edit', EN)).toEqual({ kind: 'strip' })
    expect(classifyHref('https://en.wikipedia.org/w/index.php?title=X&action=edit', EN)).toEqual({
      kind: 'strip',
    })
    expect(classifyHref('javascript:alert(1)', EN)).toEqual({ kind: 'strip' })
    expect(classifyHref('mailto:a@b.c', EN)).toEqual({ kind: 'strip' })
    expect(classifyHref(undefined, EN)).toEqual({ kind: 'strip' })
  })

  it('strips links out of the prose and into the machinery: File:, Category:, Help:', () => {
    expect(classifyHref('./File:A.jpg', EN)).toEqual({ kind: 'strip' })
    expect(classifyHref('/wiki/Category:Roman_aqueducts', EN)).toEqual({ kind: 'strip' })
    expect(classifyHref('/wiki/Help:Contents', EN)).toEqual({ kind: 'strip' })
  })
})

describe('adaptArticleHtml — links in the output', () => {
  it('marks an internal link for the reader and keeps a real href on it', () => {
    const out = adapt('<p><a href="./Pont_du_Gard" title="Pont du Gard">the bridge</a></p>')
    expect(out).toBe(
      '<p><a href="https://en.wikipedia.org/wiki/Pont_du_Gard" data-wiki-title="Pont_du_Gard" data-wiki-lang="en">the bridge</a></p>',
    )
  })

  it('opens an external link in a new tab, safely', () => {
    const out = adapt('<p><a href="https://example.org/a" class="external">source</a></p>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('data-wiki-external="1"')
  })

  it('unwraps a stripped link but keeps its words', () => {
    expect(adapt('<p>see <a href="#cite_note-3">note</a> here</p>')).toBe('<p>see note here</p>')
  })
})

/* ------------------------------------------------------- the fallback chain */

/** A fetch stub: a map of URL substring → what that endpoint does. */
function stubFetch(handlers: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = []
  const impl = (async (url: string | URL) => {
    const u = String(url)
    calls.push(u)
    for (const [needle, fn] of Object.entries(handlers)) if (u.includes(needle)) return await fn()
    throw new Error(`unstubbed ${u}`)
  }) as unknown as typeof fetch
  return { impl, calls }
}

const htmlRes = (html: string) => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
const jsonRes = (json: unknown) =>
  new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
const status = (code: number) => new Response('nope', { status: code })
const ARTICLE = `<p>${'Water flowed downhill for sixty kilometres, on a gradient of one in three thousand. '.repeat(3)}</p>`

describe('fetchArticle — the fallback chain', () => {
  beforeEach(() => clearWikiArticleCache())

  it('uses Parsoid HTML when it answers, and asks nothing else', async () => {
    const { impl, calls } = stubFetch({ '/page/html/': () => htmlRes(ARTICLE) })
    const article = await fetchArticle(EN, { fetchImpl: impl })
    expect(article.source).toBe('rest-html')
    expect(article.html).toContain('Water flowed downhill')
    expect(calls).toHaveLength(1)
  })

  it('falls to mobile-html when the first endpoint fails', async () => {
    const { impl, calls } = stubFetch({
      '/page/html/': () => status(503),
      '/page/mobile-html/': () => htmlRes(ARTICLE),
    })
    const article = await fetchArticle(EN, { fetchImpl: impl })
    expect(article.source).toBe('mobile-html')
    expect(calls).toHaveLength(2)
  })

  it('falls all the way to the action API, and reads its JSON', async () => {
    const { impl, calls } = stubFetch({
      '/page/html/': () => {
        throw new TypeError('Failed to fetch')
      },
      '/page/mobile-html/': () => status(404),
      '/w/api.php': () => jsonRes({ parse: { title: 'Roman aqueduct', text: ARTICLE } }),
    })
    const article = await fetchArticle(EN, { fetchImpl: impl })
    expect(article.source).toBe('action-parse')
    expect(article.html).toContain('Water flowed downhill')
    expect(calls).toHaveLength(3)
  })

  it('tries the next endpoint when one answers with nothing usable', async () => {
    const { impl } = stubFetch({
      '/page/html/': () => htmlRes('<div class="navbox">only chrome</div>'),
      '/page/mobile-html/': () => htmlRes(ARTICLE),
    })
    expect((await fetchArticle(EN, { fetchImpl: impl })).source).toBe('mobile-html')
  })

  it('throws once every link of the chain has failed, saying what each said', async () => {
    const { impl } = stubFetch({
      '/page/html/': () => status(404),
      '/page/mobile-html/': () => status(404),
      '/w/api.php': () => jsonRes({ error: { code: 'missingtitle' } }),
    })
    const err = await fetchArticle(EN, { fetchImpl: impl }).catch((e) => e)
    expect(err).toBeInstanceOf(WikiArticleError)
    expect(err.attempts.map((a: { source: string }) => a.source)).toEqual([
      'rest-html',
      'mobile-html',
      'action-parse',
    ])
    expect(err.attempts[0].reason).toContain('404')
  })

  it('never sends a request header, so the request is never pre-flighted', async () => {
    const seen: RequestInit[] = []
    const impl = (async (_u: string, init: RequestInit) => {
      seen.push(init)
      return htmlRes(ARTICLE)
    }) as unknown as typeof fetch
    await fetchArticle(EN, { fetchImpl: impl })
    expect(seen[0].headers).toBeUndefined()
    expect(seen[0].credentials).toBe('omit')
    expect(seen[0].redirect).toBe('follow')
    expect(seen[0].mode).toBe('cors')
  })

  it('carries the live page URL for the attribution', async () => {
    const { impl } = stubFetch({ '/page/html/': () => htmlRes(ARTICLE) })
    const article = await fetchArticle({ lang: 'en', title: 'Göbekli_Tepe' }, { fetchImpl: impl })
    expect(article.pageUrl).toBe('https://en.wikipedia.org/wiki/G%C3%B6bekli_Tepe')
  })

  it('gives up immediately once the caller has aborted', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const { impl, calls } = stubFetch({ '/page/html/': () => htmlRes(ARTICLE) })
    await expect(fetchArticle(EN, { fetchImpl: impl, signal: ctl.signal })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe('loadArticle — the session cache', () => {
  beforeEach(() => clearWikiArticleCache())

  it('serves a revisit without a second request, which is what makes back instant', async () => {
    const { impl, calls } = stubFetch({ '/page/html/': () => htmlRes(ARTICLE) })
    await loadArticle(EN, { fetchImpl: impl })
    await loadArticle(EN, { fetchImpl: impl })
    expect(calls).toHaveLength(1)
  })

  it('does not remember a failure', async () => {
    const fail = stubFetch({
      '/page/html/': () => status(500),
      '/page/mobile-html/': () => status(500),
      '/w/api.php': () => status(500),
    })
    await expect(loadArticle(EN, { fetchImpl: fail.impl })).rejects.toBeInstanceOf(WikiArticleError)
    const ok = stubFetch({ '/page/html/': () => htmlRes(ARTICLE) })
    expect((await loadArticle(EN, { fetchImpl: ok.impl })).source).toBe('rest-html')
  })
})

/* ------------------------------------------------------------- the history */

describe('the reader history stack', () => {
  const a: WikiRef = { lang: 'en', title: 'A' }
  const b: WikiRef = { lang: 'en', title: 'B' }

  it('starts with nowhere to go back to', () => {
    expect(canGoBack([a])).toBe(false)
    expect(currentRef([a])).toEqual(a)
  })

  it('pushes a followed link and can come back from it', () => {
    const two = pushHistory([a], b)
    expect(two).toEqual([a, b])
    expect(canGoBack(two)).toBe(true)
    expect(currentRef(two)).toEqual(b)
    expect(popHistory(two)).toEqual([a])
  })

  it('ignores a link to the article already open, so back never looks broken', () => {
    expect(pushHistory([a, b], { lang: 'en', title: 'B' })).toEqual([a, b])
  })

  it('keeps a revisit as a separate step, the way a browser does', () => {
    expect(pushHistory([a, b], a)).toEqual([a, b, a])
  })

  it('will not pop the last entry: the bottom of the stack is the reader closing', () => {
    expect(popHistory([a])).toEqual([a])
    expect(popHistory([])).toEqual([])
  })

  it('does not mutate the stack it is given', () => {
    const start = [a]
    pushHistory(start, b)
    expect(start).toEqual([a])
  })
})

/* -------------------------------------------------------------- the intent */

describe('opensInReader', () => {
  it('opens on an unmodified primary click', () => {
    expect(opensInReader({ button: 0 })).toBe(true)
    expect(opensInReader({})).toBe(true)
  })

  it('leaves a middle click to the browser', () => {
    expect(opensInReader({ button: 1 })).toBe(false)
  })

  it('leaves every modifier click to the browser', () => {
    for (const mod of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const)
      expect(opensInReader({ button: 0, [mod]: true })).toBe(false)
  })

  // Round 65: the desktop flag is gone — the reader has a phone shape of its
  // own now, so the decision is about the gesture alone on every form factor.
  it('leaves a secondary click to the browser too', () => {
    expect(opensInReader({ button: 2 })).toBe(false)
  })
})

/* --------------------------------------------------------- a whole document */

describe('a whole Parsoid document', () => {
  const DOC = `<!DOCTYPE html>
<html prefix="dc: http://purl.org/dc/terms/"><head><base href="//en.wikipedia.org/wiki/"/>
<title>Roman aqueduct</title><meta charset="utf-8"/><link rel="stylesheet" href="/w/load.php"/>
<script>window.RLQ=[]</script></head>
<body class="mw-content-ltr" dir="ltr">
<section data-mw-section-id="0"><p id="mwAQ">The Romans built <a rel="mw:WikiLink" href="./Aqueduct_(water_supply)" title="Aqueduct">aqueducts</a><sup class="reference"><a href="#cite_note-1">[1]</a></sup> across the empire.</p>
<figure class="mw-default-size" typeof="mw:File/Thumb"><a href="./File:Pont.jpg"><img resource="./File:Pont.jpg" src="//upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Pont.jpg/320px-Pont.jpg" width="320" height="213"/></a><figcaption>The Pont du Gard</figcaption></figure></section>
<section data-mw-section-id="1"><h2 id="Construction">Construction<span class="mw-editsection"><a href="/w/index.php?title=Roman_aqueduct&amp;action=edit&amp;section=1">edit</a></span></h2>
<ul><li>Gradient of 1 in 4800</li><li>See <a href="https://example.org/x" rel="mw:ExtLink" class="external text">an outside source</a></li></ul></section>
<div class="navbox" role="navigation"><table><tr><td><a href="./Roman_engineering">Roman engineering</a></td></tr></table></div>
<span id="coordinates">43°56′50″N</span>
</body></html>`

  const out = adapt(DOC)

  it('keeps the prose, the heading, the list and the picture', () => {
    expect(out).toContain('The Romans built')
    expect(out).toContain('<h2>Construction</h2>')
    expect(out).toContain('<li>Gradient of 1 in 4800</li>')
    expect(out).toContain('src="https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Pont.jpg/320px-Pont.jpg"')
    expect(out).toContain('<figcaption>The Pont du Gard</figcaption>')
  })

  it('leaks no Wikipedia chrome: no head, no script, no navbox, no edit link, no coordinates', () => {
    for (const gone of ['<head', '<script', 'RLQ', 'load.php', 'navbox', 'Roman engineering', 'action=edit', '43°56', 'class=', 'style=', 'data-mw'])
      expect(out).not.toContain(gone)
  })

  it('turns the wiki link into a reader link and the outside one into a new tab', () => {
    expect(out).toContain('data-wiki-title="Aqueduct_(water_supply)"')
    expect(out).toContain('<a href="https://example.org/x" target="_blank" rel="noopener noreferrer"')
  })

  it('drops the footnote marker with the apparatus it points at', () => {
    expect(out).not.toContain('[1]')
    expect(out).not.toContain('cite_note')
  })
})

describe('the adaptation is not quadratic on a real-sized article', () => {
  it('adapts a megabyte in well under a second', () => {
    const block =
      '<section><h2>Section<span class="mw-editsection">[edit]</span></h2><p>Prose with a <a href="./Link">link</a> and a <sup class="reference"><a href="#c">[1]</a></sup> marker.</p><div class="navbox">chrome</div></section>'
    const big = block.repeat(2600) // ~1 MB
    const t0 = Date.now()
    const out = adaptArticleHtml(big, { ref: EN })
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(out).not.toContain('navbox')
  })
})

describe('dev diagnostics', () => {
  it('says which endpoint served an article, on the console, in dev only', async () => {
    clearWikiArticleCache()
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { impl } = stubFetch({ '/page/html/': () => htmlRes(ARTICLE) })
    await fetchArticle(EN, { fetchImpl: impl })
    // vitest runs with import.meta.env.DEV true; in a production build these
    // calls and their strings compile away entirely.
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
