/**
 * THE READER'S SOURCE: a Wikipedia article, fetched in the reader's own browser
 * and cut down to this app's chrome.
 *
 * `lib/wikiImage.ts` is the sibling of this file and every CORS lesson written
 * at the top of it applies here word for word — the requests below are bare GETs
 * with no request headers at all, for exactly the reason stated there: a header
 * outside the CORS safelist turns the request into a pre-flighted one, and a
 * pre-flighted request cannot reliably follow the 30x that a *redirect article*
 * answers with, and roughly a third of the article links in this corpus are
 * redirects (`Aqueduct_(Roman)` → `Roman aqueduct`).
 *
 * WHY THREE ENDPOINTS, IN THIS ORDER
 *
 *  1. `…/api/rest_v1/page/html/<Title>` — Parsoid's HTML for the page. It is the
 *     one endpoint whose output is a *specified format* (the response carries a
 *     `profile="…/Specs/HTML/…"` content type), it is anonymous-CORS enabled like
 *     every other rest_v1 route, and it is the closest thing to "the article, as
 *     content": semantic HTML with real `<figure>`/`<figcaption>`, `<section>`
 *     per heading, and no skin around it. That is what we want, because we are
 *     re-typesetting it: everything Wikipedia's own skin would add is something
 *     this module would have to take away.
 *  2. `…/api/rest_v1/page/mobile-html/<Title>` — the Page Content Service's
 *     rendering. Second rather than first because it is a *product* rather than a
 *     format: it carries PCS's own chrome (collapsed sections, edit pencils,
 *     lazy-loaded images whose real URL hides in `data-src`), which is more for
 *     this module to strip, and its shape is allowed to change with the apps it
 *     is made for. But it is served by a different service from (1) and survives
 *     RESTBase being unhappy, which is exactly what a second link in a chain is
 *     for. The `data-src` promotion below exists for this endpoint alone.
 *  3. `…/w/api.php?action=parse&prop=text&…&origin=*` — the classic action API.
 *     Last because its HTML is the *skin's* HTML (thumb divs, edit sections,
 *     navboxes, a reference list of citation templates) and needs the most
 *     cutting. First-class in one respect, though: `origin=*` is the documented,
 *     long-lived way to get an anonymous cross-origin read out of MediaWiki, so
 *     if both REST routes are down or rate-limited, this is very likely still up.
 *     `redirects=1` makes it follow a redirect article server-side, so this link
 *     of the chain never depends on the browser following a 30x at all.
 *
 * WHAT COULD NOT BE VERIFIED HERE: the sandbox this was written in has no route
 * to wikipedia.org (the proxy answers rest_v1 from a cache and refuses the rest),
 * so no line below has been run against the live endpoints. Everything that
 * *can* be pinned down without them is: the URL shapes, the response shapes each
 * step reads, the fallback order, and the whole of the adaptation, which is pure
 * string → string and is unit-tested. The e2e serves captured/representative
 * fixtures from a stand-in origin mapped onto `en.wikipedia.org`, the same
 * technique tests/e2e/wikiImage.e2e.mjs uses.
 */

import { articleUrl, normalizeTitle, parseWikiUrl, refKey, type WikiRef } from './wikiImage'

export type { WikiRef }

/** Which endpoint an article's HTML came from. Reported so failures can name it. */
export type ArticleSourceName = 'rest-html' | 'mobile-html' | 'action-parse'

export interface ArticleSource {
  name: ArticleSourceName
  url: string
  /** How to get HTML out of this endpoint's response body. */
  kind: 'html' | 'action-json'
}

/** A fetched, adapted article, ready to be put in the reader. */
export interface WikiArticle {
  ref: WikiRef
  /** Adapted HTML: our tags, our classes, no Wikipedia chrome. */
  html: string
  /** Human-facing URL of the live page, for the header glyph and the footer. */
  pageUrl: string
  /** Which link of the chain answered. */
  source: ArticleSourceName
}

/* ------------------------------------------------------------------- URLs */

const langOf = (ref: WikiRef) =>
  /^[a-z]{2,3}(-[a-z0-9-]+)?$/i.test(ref.lang) ? ref.lang.toLowerCase() : 'en'

/** Parsoid page HTML. Same host and same rest_v1 base as the summary endpoint. */
export const restHtmlUrl = (ref: WikiRef): string =>
  `https://${langOf(ref)}.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(ref.title)}`

/** Page Content Service HTML — the apps' rendering. */
export const mobileHtmlUrl = (ref: WikiRef): string =>
  `https://${langOf(ref)}.wikipedia.org/api/rest_v1/page/mobile-html/${encodeURIComponent(ref.title)}`

/**
 * The action API's parse of the page.
 *
 * `origin=*` is what makes this readable cross-origin *anonymously* — it must go
 * over the wire as a literal `*`, so the query string is assembled by hand rather
 * than through `URLSearchParams`, which would percent-encode it to `%2A` and get
 * back a CORS error instead of an article. `formatversion=2` puts the HTML in
 * `parse.text` as a plain string (the legacy shape is `parse.text['*']`, which
 * `htmlFromActionParse` still accepts). `redirects=1` resolves a redirect article
 * server-side.
 */
export const actionParseUrl = (ref: WikiRef): string =>
  `https://${langOf(ref)}.wikipedia.org/w/api.php?action=parse&prop=text&page=${encodeURIComponent(
    ref.title,
  )}&redirects=1&formatversion=2&format=json&origin=*`

/** The chain, in the order it is tried. */
export function endpointChain(ref: WikiRef): ArticleSource[] {
  return [
    { name: 'rest-html', url: restHtmlUrl(ref), kind: 'html' },
    { name: 'mobile-html', url: mobileHtmlUrl(ref), kind: 'html' },
    { name: 'action-parse', url: actionParseUrl(ref), kind: 'action-json' },
  ]
}

/** Dev-only diagnostics, on the same terms as `wikiDebug` in wikiImage.ts. */
function debug(reason: string, detail?: unknown): void {
  if (import.meta.env.DEV) console.debug(`[wikiArticle] ${reason}`, detail ?? '')
}

/**
 * The HTML inside an `action=parse` response, for both shapes the API has
 * served: `parse.text` as a string (formatversion 2) and `{ '*': html }` (the
 * legacy one). Anything else — including the API's own `{ error: {...} }` — is
 * `null`, which the chain reads as "this link did not answer".
 */
export function htmlFromActionParse(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null
  const parse = (json as { parse?: unknown }).parse
  if (!parse || typeof parse !== 'object') return null
  const text = (parse as { text?: unknown }).text
  if (typeof text === 'string') return text
  if (text && typeof text === 'object' && typeof (text as { '*'?: unknown })['*'] === 'string')
    return (text as { '*': string })['*']
  return null
}

/* --------------------------------------------------------------- adaptation
 *
 * WHY THIS IS A STRING REWRITER AND NOT A DOM WALK.
 *
 * The obvious implementation is `new DOMParser().parseFromString(...)`, walk it,
 * hand the result to `v-html`. Two reasons it is not what is here:
 *
 *  · SAFETY. The input is third-party HTML that ends up inside the app's own
 *    document. `innerHTML` does not run `<script>`, but it very much runs an
 *    `<img onerror=…>`, and a DOM walk that *removes* what it recognises is a
 *    blocklist — it is wrong the moment Wikipedia (or something injected into a
 *    proxy on the reader's own network) contains something it does not know. The
 *    rewriter below is an ALLOWLIST in both directions: a tag not on the list
 *    does not survive, and an attribute not on the list does not survive. Nothing
 *    that is not `href`, `src`, `alt`, geometry or table structure reaches the
 *    document at all.
 *  · TESTABILITY. This is the part of the feature that is entirely ours, so it
 *    is the part that should be nailed down by fast unit tests. As string → string
 *    it runs in the same plain-node vitest as everything else in `lib/`.
 */

/** Tags whose entire subtree goes: chrome, scripts, controls, embedded media. */
const DROP_TAGS = new Set([
  'script', 'style', 'head', 'meta', 'link', 'base', 'title', 'noscript',
  'iframe', 'object', 'embed', 'param', 'applet', 'canvas', 'svg', 'math',
  'form', 'input', 'button', 'select', 'option', 'textarea', 'label',
  'audio', 'video', 'source', 'track', 'template', 'slot', 'frame', 'frameset',
])

/**
 * Tags that survive, mapped to what they are emitted as. Everything else that is
 * not dropped is UNWRAPPED — its children survive, it does not. That is the
 * right default for a rewriter over someone else's markup: an unknown wrapper is
 * usually a wrapper, and losing the text inside it would be the worse failure.
 */
const KEEP_TAGS = new Set([
  'p', 'br', 'hr', 'div', 'span', 'section', 'blockquote', 'q', 'cite', 'abbr',
  'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sub', 'sup', 'code', 'pre', 'kbd', 'samp', 'time',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'figure', 'figcaption', 'img', 'a',
])

/** Void elements: they never open a subtree, whatever the source wrote. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
])

/** Elements whose content is not markup — skipped wholesale by the tokenizer. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])

/**
 * Attributes that survive, per element. Everything else goes, `class` and
 * `style` first among them: this reader has its own typography and the whole
 * point is that no Wikipedia rule reaches it. `data-mw`, `typeof`, `about`,
 * `rel`, `id` and the inline event handlers all go the same way, by not being
 * listed.
 *
 * `id` in particular: keeping it would let a fetched article collide with the
 * app's own ids, and the only thing it buys is same-page anchors, which the
 * link rules below neutralise anyway.
 */
const KEEP_ATTRS: Record<string, Set<string>> = {
  img: new Set(['src', 'alt', 'width', 'height']),
  a: new Set(['href']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
}

/**
 * CHROME, BY CLASS. A subtree carrying any of these goes.
 *
 * Matched on the class *token*, and by prefix where the class family is
 * generated (`mbox-`, `navbox-`, `pcs-`). What is in here, and why:
 *
 *  · `navbox` / `vertical-navbox` / `sistersitebox` / `metadata` / `ambox` /
 *    `mbox-*` / `noprint` / `nomobile` / `catlinks` / `printfooter` — navigation
 *    and maintenance furniture. None of it is the article.
 *  · `mw-editsection` / `mw-jump-link` / `mw-headline-anchor` — controls for
 *    editing and skipping, in a reader that can do neither.
 *  · `reference` (the inline `[12]`), `reflist` / `references` / `refbegin` /
 *    `mw-references-wrap` (the list itself) and `mw-cite-backlink` (the `↑`
 *    that jumps back up) — the citation apparatus. It is dropped as a unit
 *    because half of it is links to anchors this rewriter deliberately removes,
 *    and a footnote marker that goes nowhere is worse than no marker.
 *  · `toc` / `toctitle` — Wikipedia's own table of contents. The reader has the
 *    article's headings and a scrollbar.
 *  · `geo` / `geo-dec` / `geo-multi-punct` / `geo-default` / `geo-nondefault` /
 *    `coordinates` — the coordinate blob an infobox carries. This app *is* a
 *    map; a string of decimal degrees in the corner of a reader that opened
 *    from a pin is the one piece of Wikipedia furniture that is actively silly.
 *  · `mw-empty-elt` — the empty paragraphs Parsoid leaves behind.
 *  · `pcs-*` / `hide-when-compact` / `collapsible-block` — mobile-html's own
 *    chrome (see endpoint 2).
 */
const DROP_CLASSES = new Set([
  'navbox', 'vertical-navbox', 'navbox-inner', 'sistersitebox', 'metadata', 'ambox',
  'noprint', 'nomobile', 'catlinks', 'printfooter', 'mw-editsection', 'mw-jump-link',
  'mw-headline-anchor', 'reference', 'reflist', 'refbegin', 'references', 'mw-references-wrap',
  'mw-cite-backlink', 'toc', 'toctitle', 'toclimit-3', 'geo', 'geo-dec', 'geo-multi-punct',
  'geo-default', 'geo-nondefault', 'coordinates', 'mw-empty-elt', 'hide-when-compact',
  'collapsible-block', 'mw-kartographer-maplink', 'mw-indicators', 'shortdescription',
])
/**
 * Generated class families that are chrome.
 *
 * `pcs-` is named piece by piece rather than by its bare prefix, and that is a
 * bug fix rather than fussiness: mobile-html marks its own EDIT and FOOTER
 * furniture `pcs-…`, and also wraps every picture in `pcs-widen-image-ancestor`
 * and the whole document in `<body class="… pcs-body">`. A blanket `pcs-` drop
 * threw away the article and left the reader empty.
 */
const DROP_CLASS_PREFIXES = [
  'mbox-',
  'navbox-',
  'mw-editsection-',
  'ext-discussiontools-',
  'pcs-edit-section',
  'pcs-footer',
  'pcs-collapse-table',
  'pcs-fold',
]

/** `id` values that are chrome wherever they appear. */
const DROP_IDS = new Set(['coordinates', 'toc', 'siteSub', 'contentSub', 'jump-to-nav', 'References'])

/**
 * Class-driven RENAMING, applied before classes are thrown away.
 *
 * The action API (endpoint 3) writes a picture as
 * `<div class="thumb"><div class="thumbinner"><a><img></a><div class="thumbcaption">…`.
 * Parsoid writes the same picture as `<figure><img><figcaption>…`. Both are the
 * same thing, and the reader should style it once — so the divs are promoted to
 * the semantic elements Parsoid already uses, and the stylesheet only has to know
 * about `figure`.
 */
const RENAME_BY_CLASS: { class: string; to: string }[] = [
  { class: 'thumbcaption', to: 'figcaption' },
  { class: 'thumb', to: 'figure' },
  { class: 'gallerytext', to: 'figcaption' },
]

/** `magnify` is the little "enlarge" affordance inside a thumb caption. */
const DROP_CLASSES_ALL = new Set([...DROP_CLASSES, 'magnify'])

/**
 * Wrappers that exist only to be styled by a skin this reader does not load.
 * They are unwrapped rather than dropped — everything inside them is article —
 * and they are named because leaving them in puts a bare `<div>` between a
 * `<figure>` and its `<img>`, which is one more thing our own stylesheet would
 * have to know about.
 */
const UNWRAP_CLASSES = new Set(['thumbinner', 'mw-parser-output', 'mw-content-ltr', 'mw-body-content'])
/** …and the same, by family: everything else mobile-html wraps things in. */
const UNWRAP_CLASS_PREFIXES = ['pcs-']
/** Elements that are only ever wrappers, and so may be unwrapped by class. */
const GENERIC_CONTAINERS = new Set(['div', 'span', 'section', 'body', 'html'])

const classTokens = (attrs: Record<string, string>): string[] =>
  (attrs.class ?? '').split(/\s+/).filter(Boolean)

/** Is this element chrome rather than article? Pure, and the unit test's main target. */
export function isChrome(tag: string, attrs: Record<string, string>): boolean {
  if (DROP_TAGS.has(tag)) return true
  // The document's own structural elements are never chrome, whatever classes a
  // renderer hangs on them — mobile-html ships `<body class="… pcs-body">`, and
  // reading that as chrome dropped the entire article. They are unwrapped by
  // `emitAs` (they are not in KEEP_TAGS), which is the right outcome.
  if (tag === 'html' || tag === 'body') return false
  if (attrs.id && DROP_IDS.has(attrs.id)) return true
  for (const c of classTokens(attrs)) {
    if (DROP_CLASSES_ALL.has(c)) return true
    if (DROP_CLASS_PREFIXES.some((p) => c.startsWith(p))) return true
  }
  // Parsoid marks the edit-section link and the reference machinery with
  // `typeof`/`rel` rather than a class in some renderings.
  if (attrs.rel === 'mw:referencedBy') return true
  if ((attrs.typeof ?? '').includes('mw:Extension/references')) return true
  return false
}

/** What a rewritten element is emitted as, or `null` to unwrap it. */
export function emitAs(tag: string, attrs: Record<string, string>): string | null {
  const classes = classTokens(attrs)
  // Only a GENERIC container is unwrapped by its class. A `<figure>` that
  // happens to carry `pcs-widen-image-ancestor` is still a figure, and losing
  // the element would cost the picture its caption's relationship to it.
  if (GENERIC_CONTAINERS.has(tag)) {
    for (const c of classes) {
      if (UNWRAP_CLASSES.has(c)) return null
      if (UNWRAP_CLASS_PREFIXES.some((p) => c.startsWith(p))) return null
    }
  }
  for (const rule of RENAME_BY_CLASS) if (classes.includes(rule.class)) return rule.to
  return KEEP_TAGS.has(tag) ? tag : null
}

/* ------------------------------------------------------------------- links */

export type LinkTarget =
  /** Another article: it opens *in the reader*. */
  | { kind: 'internal'; ref: WikiRef; href: string }
  /** Off Wikipedia: a new tab, as everywhere else in this app. */
  | { kind: 'external'; href: string }
  /** Same-page anchors, edit links, `javascript:` — the `<a>` is unwrapped. */
  | { kind: 'strip' }

/**
 * Where an `<a href>` in fetched article HTML actually points, resolved against
 * the article it came from.
 *
 * The three input shapes that matter:
 *  · Parsoid writes internal links RELATIVE: `href="./Roman_aqueduct"`, with a
 *    `<base href="//en.wikipedia.org/wiki/">` in a `<head>` this module drops.
 *    So `./X` is resolved here, by hand, against the *article's own* language.
 *  · The action API writes them rooted: `href="/wiki/Roman_aqueduct"`.
 *  · Both write off-site links absolute, and protocol-relative (`//example.com`)
 *    still turns up in older wikitext.
 */
export function classifyHref(href: string | undefined, ref: WikiRef): LinkTarget {
  const raw = (href ?? '').trim()
  if (!raw) return { kind: 'strip' }
  if (raw.startsWith('#')) return { kind: 'strip' } // an anchor to an id we removed
  const lang = langOf(ref)

  // Parsoid's relative form, and the rooted form, are the same thing.
  let path: string | null = null
  if (raw.startsWith('./')) path = raw.slice(2)
  else if (raw.startsWith('/wiki/')) path = raw.slice('/wiki/'.length)
  if (path !== null) {
    // `/wiki/Foo#Bar` — the article is the target; the section anchor is lost
    // with the ids, and landing at the top of the right article beats not going.
    const title = normalizeTitle(path)
    if (!title) return { kind: 'strip' }
    // Re-read our own URL with the parser that already knows which namespaces
    // are articles: `File:`, `Category:`, `Help:` and the rest are links out of
    // the encyclopaedia's prose and into its machinery, and the picture wrapper
    // Parsoid puts around every image is one of them.
    const inner = parseWikiUrl(articleUrl({ lang, title }))
    if (!inner) return { kind: 'strip' }
    return { kind: 'internal', ref: inner, href: articleUrl(inner) }
  }

  // `//host/path` is an absolute link with the scheme left to the page, and it
  // has to be recognised BEFORE the rooted-path rule below — it starts with a
  // slash too, and reading it as a path would send every protocol-relative link
  // in the article to nowhere.
  const abs = raw.startsWith('//') ? `https:${raw}` : raw
  // `/w/index.php?title=X&action=edit`, `/w/load.php`, and friends: chrome.
  // (Everything rooted that was an article was already taken above.)
  if (abs === raw && raw.startsWith('/')) return { kind: 'strip' }

  if (!/^https?:\/\//i.test(abs)) return { kind: 'strip' } // mailto:, javascript:, data:
  if (/[?&]action=edit/.test(abs)) return { kind: 'strip' }
  const inner = parseWikiUrl(abs)
  if (inner) return { kind: 'internal', ref: inner, href: articleUrl(inner) }
  return { kind: 'external', href: abs }
}

/**
 * An image's real URL, or `null` if there is not one worth rendering.
 *
 * `//upload.wikimedia.org/...` is the shape both HTML endpoints emit, and
 * `upload.wikimedia.org` serves pictures with `access-control-allow-origin: *`,
 * so they load in our document exactly as they do in Wikipedia's. `data-src` is
 * mobile-html's lazy-loading placeholder: the visible `src` there is a 1×1
 * transparent GIF and the picture is in `data-src`, so it is promoted here — a
 * page of blank boxes is the whole failure mode of not doing it.
 *
 * Anything not served over https from a Wikimedia host is dropped rather than
 * proxied or hot-linked.
 */
export function imageSrc(attrs: Record<string, string>): string | null {
  const raw = (attrs['data-src'] || attrs.src || '').trim()
  if (!raw) return null
  const abs = raw.startsWith('//') ? `https:${raw}` : raw
  if (!/^https:\/\//i.test(abs)) return null
  try {
    const host = new URL(abs).hostname.toLowerCase()
    if (!/(^|\.)wikimedia\.org$/.test(host) && !/(^|\.)wikipedia\.org$/.test(host)) return null
  } catch {
    return null
  }
  return abs
}

/* --------------------------------------------------------------- tokenizer */

interface OpenTag {
  kind: 'open'
  name: string
  attrs: Record<string, string>
  selfClosing: boolean
}
type Token = OpenTag | { kind: 'close'; name: string } | { kind: 'text'; text: string }

const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g

/**
 * HTML → tokens. Not a compliant parser and does not try to be: what it has to
 * cope with is machine-generated markup from MediaWiki, which is well-formed and
 * quotes its attributes. What it does guarantee is that nothing it does not
 * understand can turn into an element downstream — an unparseable `<` is text.
 */
export function* tokenize(html: string): Generator<Token> {
  let i = 0
  const n = html.length
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      yield { kind: 'text', text: html.slice(i) }
      return
    }
    if (lt > i) yield { kind: 'text', text: html.slice(i, lt) }

    // comments, doctypes, processing instructions: skipped whole
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt)
      i = end < 0 ? n : end + 1
      continue
    }
    const closing = html.startsWith('</', lt)
    const nameStart = lt + (closing ? 2 : 1)
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(nameStart, nameStart + 64))
    if (!nameMatch) {
      // a bare `<` in prose: text, not a tag
      yield { kind: 'text', text: html.slice(lt, lt + 1) }
      i = lt + 1
      continue
    }
    const name = nameMatch[0].toLowerCase()
    let end = nameStart + nameMatch[0].length
    // find the tag's `>`, respecting quoted attribute values
    let quote = ''
    while (end < n) {
      const c = html[end]
      if (quote) {
        if (c === quote) quote = ''
      } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
      end++
    }
    const inner = html.slice(nameStart + nameMatch[0].length, end)
    i = Math.min(end + 1, n)

    if (closing) {
      yield { kind: 'close', name }
      continue
    }
    const attrs: Record<string, string> = {}
    ATTR.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ATTR.exec(inner))) {
      const key = m[1].toLowerCase()
      if (key === '/') continue
      attrs[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
    }
    const selfClosing = /\/\s*$/.test(inner) || VOID_TAGS.has(name)
    yield { kind: 'open', name, attrs, selfClosing }

    // raw-text elements: their content is not markup, so skip to the close tag
    // rather than tokenizing a stylesheet's `>` into elements. Searched with a
    // sticky-free regex over the ORIGINAL string — lower-casing the document per
    // `<style>` would copy a megabyte of article for every one of them.
    if (RAW_TEXT.has(name) && !selfClosing) {
      const re = new RegExp(`</${name}`, 'ig')
      re.lastIndex = i
      const m = re.exec(html)
      i = m ? m.index : n
    }
  }
}

/** The handful of entities an attribute value can carry. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/* -------------------------------------------------------------- the rewrite */

export interface AdaptOptions {
  /** The article the HTML is of — relative links are resolved against it. */
  ref: WikiRef
}

/**
 * Fetched article HTML → the HTML the reader renders.
 *
 * Everything the rest of this file sets up happens here, in one pass:
 *  · chrome subtrees (`isChrome`) are dropped whole;
 *  · known elements are kept, thumb divs are promoted to `<figure>`, and
 *    anything else is unwrapped — its text survives, its tag does not;
 *  · attributes are allowlisted per element, so no `class`, `style`, `id`,
 *    `data-mw` or `on*` reaches the document;
 *  · internal links are marked `data-wiki-title` (the reader intercepts them)
 *    and keep a real `href`, so middle-click and "copy link" still do the right
 *    thing; external links get `target="_blank" rel="noopener noreferrer"`;
 *  · images are resolved to their absolute Wikimedia URL and made lazy.
 */
export function adaptArticleHtml(html: string, opts: AdaptOptions): string {
  const out: string[] = []
  /** Open kept elements, innermost last — what a close tag is matched against. */
  const stack: { name: string; emitted: string | null }[] = []
  /** Depth inside a dropped subtree; > 0 means "emit nothing". */
  let dropDepth = 0
  /** Names of the dropped subtree's open elements, for matching its close tags. */
  const dropStack: string[] = []

  for (const t of tokenize(html)) {
    if (t.kind === 'text') {
      if (!dropDepth) out.push(t.text)
      continue
    }
    if (t.kind === 'open') {
      const { name, attrs } = t
      if (dropDepth) {
        if (!t.selfClosing) {
          dropDepth++
          dropStack.push(name)
        }
        continue
      }
      if (isChrome(name, attrs)) {
        if (!t.selfClosing) {
          dropDepth = 1
          dropStack.length = 0
          dropStack.push(name)
        }
        continue
      }
      // Asked before `emitAs`, which is class-driven: an `<img class="thumb">`
      // is still a picture, not a figure wrapper.
      if (name === 'img') {
        const src = imageSrc(attrs)
        if (src) {
          const alt = attrs.alt ? ` alt="${escapeAttr(attrs.alt)}"` : ''
          const w = /^\d+$/.test(attrs.width ?? '') ? ` width="${attrs.width}"` : ''
          const h = /^\d+$/.test(attrs.height ?? '') ? ` height="${attrs.height}"` : ''
          out.push(`<img loading="lazy" decoding="async" src="${escapeAttr(src)}"${alt}${w}${h}>`)
        }
        continue // void either way
      }
      const as = emitAs(name, attrs)
      if (as === 'a') {
        const target = classifyHref(attrs.href, opts.ref)
        if (target.kind === 'strip') {
          // Unwrap: the words stay, the link goes.
          if (!t.selfClosing) stack.push({ name, emitted: null })
          continue
        }
        const attr =
          target.kind === 'internal'
            ? ` href="${escapeAttr(target.href)}" data-wiki-title="${escapeAttr(target.ref.title)}" data-wiki-lang="${escapeAttr(target.ref.lang)}"`
            : ` href="${escapeAttr(target.href)}" target="_blank" rel="noopener noreferrer" data-wiki-external="1"`
        out.push(`<a${attr}>`)
        if (!t.selfClosing) stack.push({ name, emitted: 'a' })
        continue
      }
      if (as) {
        const allowed = KEEP_ATTRS[as]
        let rendered = `<${as}`
        if (allowed) {
          for (const [k, v] of Object.entries(attrs)) {
            if (allowed.has(k)) rendered += ` ${k}="${escapeAttr(v)}"`
          }
        }
        out.push(`${rendered}>`)
        if (!t.selfClosing && !VOID_TAGS.has(as)) stack.push({ name, emitted: as })
      } else if (!t.selfClosing) {
        stack.push({ name, emitted: null })
      }
      continue
    }
    // close
    if (dropDepth) {
      // Unwind the dropped subtree by name, tolerating markup that closes
      // sloppily: an unmatched close inside a drop cannot resurrect it.
      const at = dropStack.lastIndexOf(t.name)
      if (at >= 0) {
        dropDepth -= dropStack.length - at
        dropStack.length = at
        if (dropDepth < 0) dropDepth = 0
      }
      continue
    }
    let at = -1
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].name === t.name) {
        at = k
        break
      }
    }
    if (at < 0) continue // a stray close tag: ignore it entirely
    for (let k = stack.length - 1; k >= at; k--) {
      const frame = stack[k]
      if (frame.emitted) out.push(`</${frame.emitted}>`)
    }
    stack.length = at
  }
  // whatever the source left open, we close
  for (let k = stack.length - 1; k >= 0; k--) {
    const frame = stack[k]
    if (frame.emitted) out.push(`</${frame.emitted}>`)
  }

  return tidy(out.join(''))
}

/**
 * Cosmetic pass over the rewritten string: elements that are empty *after* the
 * cut (a paragraph that held only a navbox, a list item that held only an edit
 * link) would otherwise show up as gaps in a body with generous margins.
 */
function tidy(html: string): string {
  let prev = ''
  let s = html
  const EMPTY = /<(p|li|ul|ol|div|span|figcaption|figure|table|tr|td|th|section|dl|blockquote)>\s*<\/\1>/g
  while (prev !== s) {
    prev = s
    s = s.replace(EMPTY, '')
  }
  // Runs of blank lines between elements, which MediaWiki's HTML is full of,
  // collapse to one newline. Whitespace *inside* a line is left alone: it is the
  // article's own, and `<pre>` renders it.
  return s.replace(/[ \t]*\n\s*/g, '\n').trim()
}

/* ------------------------------------------------------------------- fetch */

/** Why the reader has nothing to show. Carried to the apology, and logged. */
export class WikiArticleError extends Error {
  constructor(
    message: string,
    /** What each link of the chain answered, in order. */
    readonly attempts: { source: ArticleSourceName; reason: string }[] = [],
  ) {
    super(message)
    this.name = 'WikiArticleError'
  }
}

export interface FetchArticleOptions {
  signal?: AbortSignal
  /** Injection point for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * One article, through the chain, adapted.
 *
 * Every link is tried in order and the first that yields usable HTML wins. A
 * failure at one link is *not* fatal — 404 included, because the three endpoints
 * do not agree on what is missing (REST can 404 a page the action API parses
 * happily, e.g. while RESTBase's storage is catching up with a rename). Only
 * when all three have failed does this throw, and the reader turns that into a
 * short apology with a plain link to the live page.
 */
export async function fetchArticle(
  ref: WikiRef,
  opts: FetchArticleOptions = {},
): Promise<WikiArticle> {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const attempts: { source: ArticleSourceName; reason: string }[] = []

  for (const source of endpointChain(ref)) {
    if (opts.signal?.aborted) throw new WikiArticleError('aborted', attempts)
    try {
      const res = await doFetch(source.url, {
        // No request headers, for the reason at the top of this file and in
        // lib/wikiImage.ts: a simple GET is never pre-flighted, and a
        // pre-flighted request cannot be relied on to follow the redirect a
        // redirect-article answers with.
        method: 'GET',
        credentials: 'omit',
        mode: 'cors',
        redirect: 'follow',
        signal: opts.signal,
      })
      if (!res?.ok) {
        attempts.push({ source: source.name, reason: `HTTP ${res?.status}` })
        continue
      }
      let html: string | null
      if (source.kind === 'action-json') {
        const json = (await res.json()) as unknown
        html = htmlFromActionParse(json)
      } else {
        html = await res.text()
      }
      if (!html || html.length < MIN_USEFUL_HTML) {
        attempts.push({ source: source.name, reason: `empty response (${html?.length ?? 0} bytes)` })
        continue
      }
      const adapted = adaptArticleHtml(html, { ref })
      if (adapted.length < MIN_USEFUL_HTML) {
        // The endpoint answered, but there was no article left after the cut —
        // a disambiguation stub, or a rendering this module does not understand.
        attempts.push({ source: source.name, reason: `nothing left after adaptation` })
        continue
      }
      debug(`served by ${source.name}`, refKey(ref))
      return { ref, html: adapted, pageUrl: articleUrl(ref), source: source.name }
    } catch (err) {
      if (opts.signal?.aborted) throw new WikiArticleError('aborted', attempts)
      attempts.push({ source: source.name, reason: String(err) })
    }
  }
  debug('every endpoint failed', attempts)
  throw new WikiArticleError(`could not load ${refKey(ref)}`, attempts)
}

/**
 * Below this many bytes, "HTML" is an error page, an empty stub, or a rendering
 * this module cut down to nothing — in all three cases the next link of the
 * chain is worth trying.
 */
const MIN_USEFUL_HTML = 120

/* ------------------------------------------------------------------- cache */

const articles = new Map<string, WikiArticle>()

/** Test seam, and "start of session". */
export function clearWikiArticleCache(): void {
  articles.clear()
}

/**
 * Fetch, or replay a page the reader has already been on this session — which is
 * what makes the back control instant, and what stops a walk of five articles
 * and back again from being ten requests.
 */
export async function loadArticle(
  ref: WikiRef,
  opts: FetchArticleOptions = {},
): Promise<WikiArticle> {
  const key = refKey(ref)
  const hit = articles.get(key)
  if (hit) return hit
  const article = await fetchArticle(ref, opts)
  articles.set(key, article)
  return article
}

/* --------------------------------------------------------- the history stack
 *
 * The reader is a browser of one document at a time and its own back control is
 * the only way out of a walk into the encyclopaedia. Kept as a plain array with
 * pure operations so the ordering rules are unit-testable, rather than as
 * imperative pushes on a ref inside the component.
 */

export type ReaderHistory = readonly WikiRef[]

/**
 * Follow a link. Re-entering the article already on top is a no-op — a page
 * that links to itself (Wikipedia does, in infoboxes and hatnotes) must not
 * grow the stack, or "back" would appear to do nothing.
 */
export function pushHistory(stack: ReaderHistory, ref: WikiRef): WikiRef[] {
  const top = stack[stack.length - 1]
  if (top && refKey(top) === refKey(ref)) return [...stack]
  return [...stack, ref]
}

/** Back one step. At the bottom of the stack nothing moves — the caller closes. */
export function popHistory(stack: ReaderHistory): WikiRef[] {
  return stack.length <= 1 ? [...stack] : stack.slice(0, -1)
}

/**
 * An article title as a HEADING: `G%C3%B6bekli_Tepe` → `Göbekli Tepe`.
 *
 * The reader's own header has to name the page before a byte of it has arrived
 * — that is the whole difference between a modal that opened and a modal that is
 * broken — and the only thing known at that moment is the title in the link.
 */
export function titleText(title: string): string {
  let s = title
  try {
    s = decodeURIComponent(s)
  } catch {
    /* a stray % that is not an escape: show the raw title rather than nothing */
  }
  return s.replace(/_/g, ' ').trim()
}

export const canGoBack = (stack: ReaderHistory): boolean => stack.length > 1
export const currentRef = (stack: ReaderHistory): WikiRef | undefined => stack[stack.length - 1]

/* ------------------------------------------------------------ click intent */

/** The parts of a mouse event the decision below reads. */
export interface ClickIntent {
  button?: number
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

/**
 * Does this click open the READER, or does it belong to the browser?
 *
 * The entry points are real `<a href>`s to the live article, and that is
 * deliberate: a reader who middle-clicks, cmd-clicks or shift-clicks is asking
 * their browser for a tab or a window, and an app that swallows that is an app
 * that has broken a twenty-year-old contract. So the reader opens on exactly one
 * gesture — an unmodified primary click — and every other one is left alone to
 * do what it has always done: go to Wikipedia.
 *
 * Through round 64 this also took a `desktop` flag and said no below the app's
 * 641px break, on the argument that a modal filling a phone is a worse
 * Wikipedia than Wikipedia. Round 65 built the phone its own reading — a
 * full-screen sheet in the app's chrome (WikiReader.vue) — so the offer is now
 * the same on both form factors and the flag is gone. What a phone tap gives up
 * (reading mode, the share sheet) still exists one press away behind the
 * reader's own "Open on Wikipedia" glyph.
 */
export function opensInReader(e: ClickIntent): boolean {
  if ((e.button ?? 0) !== 0) return false
  return !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
}
