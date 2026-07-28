/**
 * Tiny markdown subset → HTML, safe by construction (input is escaped first).
 * Supports: paragraphs (blank line), **bold**, *italic*,
 * [text](https://url) external links, [text](event:id) internal event links.
 */
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function renderRichText(src: string): string {
  return escapeHtml(src)
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/\[(.+?)\]\(event:([\w-]+)\)/g, '<a data-event="$2">$1</a>')
        .replace(/\[(.+?)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>'),
    )
    .map((p) => `<p>${p.trim()}</p>`)
    .join('')
}
