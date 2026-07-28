import { describe, it, expect } from 'vitest'
import { renderRichText } from '../src/lib/richtext'

describe('renderRichText', () => {
  it('escapes HTML in the source', () => {
    expect(renderRichText('<script>alert(1)</script>')).not.toContain('<script>')
  })

  it('renders paragraphs, bold and italic', () => {
    expect(renderRichText('One **two**\n\n*three*')).toBe(
      '<p>One <strong>two</strong></p><p><em>three</em></p>',
    )
  })

  it('renders external links with safe attributes', () => {
    expect(renderRichText('[wiki](https://en.wikipedia.org/wiki/X)')).toBe(
      '<p><a href="https://en.wikipedia.org/wiki/X" target="_blank" rel="noopener">wiki</a></p>',
    )
  })

  it('renders internal event links as data attributes, not hrefs', () => {
    expect(renderRichText('see [WWII](event:ww2)')).toBe('<p>see <a data-event="ww2">WWII</a></p>')
  })

  it('does not treat javascript: urls as links', () => {
    expect(renderRichText('[x](javascript:alert(1))')).not.toContain('href')
  })
})
