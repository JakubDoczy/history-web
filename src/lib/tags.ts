/**
 * The controlled tag vocabulary. Extending it is a deliberate act: every tag
 * carries a pin colour, and the data tests reject anything outside this list.
 *
 * An event's FIRST tag is its primary tag — it decides the pin colour on the
 * globe. Order the rest freely.
 */
export const TAGS = [
  'biology',
  'climate',
  'culture',
  'disaster',
  'disease',
  'economy',
  'exploration',
  'extinction',
  'geology',
  'politics',
  'religion',
  'science',
  'technology',
  'war',
] as const

export type Tag = (typeof TAGS)[number]

/**
 * One hue per tag, spread around the wheel so neighbours on the globe stay
 * distinguishable on the dark basemap. Extinction is deliberately the one
 * grey — the theme is absence.
 */
export const TAG_COLORS: Record<Tag, string> = {
  war: '#e5484d',
  disaster: '#ff7a45',
  exploration: '#f5a623',
  politics: '#e3c341',
  economy: '#9fbf3b',
  biology: '#5fce6a',
  science: '#34d1bf',
  climate: '#29b6d8',
  technology: '#4c8dff',
  religion: '#8f7fe8',
  culture: '#cf6bd6',
  disease: '#ef5da8',
  geology: '#b0793f',
  extinction: '#7d8799',
}

export const primaryTag = (e: { tags: string[] }): Tag => e.tags[0] as Tag

export const tagColor = (tag: string): string => TAG_COLORS[tag as Tag] ?? '#8891a0'
