import { MAX_TIME, type Year } from './time'

export interface Era {
  name: string
  start: Year
  end: Year
  color: string
}

/** ICS eras/periods, colors desaturated from the standard geological palette. */
export const GEOLOGIC: Era[] = [
  { name: 'Hadean', start: -4.567e9, end: -4.031e9, color: '#4a2b3d' },
  { name: 'Archean', start: -4.031e9, end: -2.5e9, color: '#6d3352' },
  { name: 'Proterozoic', start: -2.5e9, end: -538.8e6, color: '#8e4361' },
  { name: 'Cambrian', start: -538.8e6, end: -485.4e6, color: '#4c7a6a' },
  { name: 'Ordovician', start: -485.4e6, end: -443.8e6, color: '#3f7f74' },
  { name: 'Silurian', start: -443.8e6, end: -419.2e6, color: '#4d8a74' },
  { name: 'Devonian', start: -419.2e6, end: -358.9e6, color: '#5c8a63' },
  { name: 'Carboniferous', start: -358.9e6, end: -298.9e6, color: '#5a7f7a' },
  { name: 'Permian', start: -298.9e6, end: -251.9e6, color: '#7a6a55' },
  { name: 'Triassic', start: -251.9e6, end: -201.4e6, color: '#6b5a7d' },
  { name: 'Jurassic', start: -201.4e6, end: -145e6, color: '#3f7f8c' },
  { name: 'Cretaceous', start: -145e6, end: -66e6, color: '#5c8a5c' },
  { name: 'Paleogene', start: -66e6, end: -23.03e6, color: '#8a7a4a' },
  { name: 'Neogene', start: -23.03e6, end: -2.58e6, color: '#9a8a45' },
  { name: 'Quaternary', start: -2.58e6, end: MAX_TIME, color: '#a8964f' },
]

/** Human-history periods, shown instead of geology when zoomed in. */
export const HISTORICAL: Era[] = [
  { name: 'Stone Age', start: -3e6, end: -3300, color: '#5a5f6d' },
  { name: 'Bronze Age', start: -3300, end: -1200, color: '#7d6242' },
  { name: 'Iron Age', start: -1200, end: -550, color: '#67564d' },
  { name: 'Classical', start: -550, end: 500, color: '#6d6a4a' },
  { name: 'Medieval', start: 500, end: 1500, color: '#4f5a72' },
  { name: 'Early Modern', start: 1500, end: 1800, color: '#5f5273' },
  { name: 'Industrial', start: 1800, end: 1945, color: '#6a4f4f' },
  { name: 'Contemporary', start: 1945, end: MAX_TIME, color: '#48707a' },
]

/**
 * The third tier: named periods inside the historical eras, drawn in a thin
 * lane of their own once the window is narrow enough for them to have room.
 *
 * Two rules shape this table, and both cost it entries:
 *
 *  · **One lane, so no overlaps.** The famous periods of history overlap
 *    freely — the Crusades (1095–1291) run through the Mongol century, the
 *    Renaissance through the Age of Discovery through the Reformation, the
 *    Space Age inside the Cold War, the Warring States inside Hellenistic
 *    Greece. Drawn in one lane those would paint over each other, and packing
 *    them into several lanes needs four rows for the 16th century alone — more
 *    rail than exists. So this is a single thread: where two recognized
 *    periods cover the same years, the one that better characterises the
 *    stretch is kept and the other is left out (Warring States, Mongol Era,
 *    Age of Discovery, Scientific Revolution, Belle Époque and the Space Age
 *    all lose that way).
 *  · **Gaps are fine.** Nothing forces the thread to tile — the historical
 *    band above stays continuous and keeps naming the stretch, so an unnamed
 *    century simply shows empty lane rather than a period stretched to fill it.
 *
 * Dates are the conventional ones, in astronomical years (1 BCE = 0). The one
 * place a convention is trimmed is the Renaissance, usually given as
 * c. 1300–1600: its band ends where the Reformation begins, because those two
 * cannot both be in one lane and Reformation-era dates (1517–1648) are the
 * firmer pair.
 */
export const SUB_AGES: Era[] = [
  // 10000–3300 BCE, ending exactly where the Bronze Age band above it begins
  { name: 'Neolithic', start: -9999, end: -3300, color: '#6a7a5f' },
  { name: 'Old Kingdom Egypt', start: -2685, end: -2180, color: '#8a7250' }, // 2686–2181 BCE
  { name: 'New Kingdom Egypt', start: -1549, end: -1068, color: '#6f7a55' }, // 1550–1069 BCE
  { name: 'Neo-Assyrian Empire', start: -910, end: -608, color: '#7a5f4f' }, // 911–609 BCE
  { name: 'Classical Greece', start: -479, end: -322, color: '#5b7f86' }, // 480–323 BCE
  { name: 'Hellenistic Period', start: -322, end: -30, color: '#63678c' }, // 323–31 BCE
  { name: 'Pax Romana', start: -26, end: 180, color: '#8a5a5a' }, // 27 BCE–180 CE
  { name: 'Migration Period', start: 375, end: 568, color: '#5f6b7f' },
  { name: 'Islamic Conquests', start: 632, end: 750, color: '#4f7a63' },
  { name: 'Viking Age', start: 793, end: 1066, color: '#4a6f8f' },
  { name: 'Crusades', start: 1095, end: 1291, color: '#8a6a4a' },
  { name: 'Renaissance', start: 1300, end: 1517, color: '#7a6a95' },
  { name: 'Reformation', start: 1517, end: 1648, color: '#57786a' },
  { name: 'Enlightenment', start: 1685, end: 1789, color: '#8a7f52' },
  { name: 'French Revolution', start: 1789, end: 1799, color: '#8a5566' },
  { name: 'Napoleonic Era', start: 1799, end: 1815, color: '#5d6f8f' },
  { name: 'Victorian Era', start: 1837, end: 1901, color: '#6b5a7a' },
  { name: 'World War I', start: 1914, end: 1918, color: '#6f6a5a' },
  { name: 'Roaring Twenties', start: 1920, end: 1929, color: '#9a7a52' },
  { name: 'Great Depression', start: 1929, end: 1939, color: '#5f6469' },
  { name: 'World War II', start: 1939, end: 1945, color: '#7a4f4f' },
  { name: 'Cold War', start: 1947, end: 1991, color: '#4f6a8a' },
  { name: 'Information Age', start: 1991, end: MAX_TIME, color: '#48807c' },
]

const within = (e: Era, t: Year) => t >= e.start && t < e.end

/** Finest-grained named era containing t (historical wins inside its range). */
export const eraAt = (t: Year): Era | undefined =>
  HISTORICAL.find((e) => within(e, t)) ?? GEOLOGIC.find((e) => within(e, t))

/** Historical eras a span touches, in order. */
export const erasOverlapping = (start: Year, end: Year): Era[] =>
  HISTORICAL.filter((e) => e.start < end && e.end > start)

/** Name for a span: one era, a run of them, or deep time when it predates the table. */
export function spanEraLabel(start: Year, end: Year): string {
  const hit = erasOverlapping(Math.min(start, end), Math.max(start, end))
  if (!hit.length) return 'Deep time'
  return hit.length === 1 ? hit[0].name : `${hit[0].name} – ${hit[hit.length - 1].name}`
}

/** Bands to draw for a window: human periods when zoomed in, geology otherwise. */
export const bandsFor = (start: Year, end: Year): Era[] => {
  const scale = end - start <= 20_000 ? HISTORICAL : GEOLOGIC
  return scale.filter((e) => e.start < end && e.end > start)
}

/**
 * Widest window that still gives the sub-age lane room, in years.
 *
 * Tuned by looking at the rail at a ladder of zooms, not by arithmetic: the
 * display warp makes a year near the present many times wider than a year in
 * antiquity, so what matters is how many names actually render. At 2000 years
 * of window, seven of them do on a 1280 px rail (Viking Age, Crusades,
 * Renaissance, Reformation, Enlightenment, Victorian Era, Cold War) — enough
 * for the lane to read as a row of periods rather than a row of chips, since
 * TimelineBar drops any name that will not fit whole.
 *
 * It also has to sit under the span of the home window (~2600 years and slowly
 * growing, since it ends at the present), so the lane is something zooming in
 * *reveals* rather than part of the opening view. One wheel step gets there.
 */
export const SUB_AGE_MAX_SPAN = 2000

/**
 * Whether to give the fine lane its row at all — a question of zoom only, never
 * of what happens to be in the window. The thread has gaps in it (1648–1685,
 * 1901–1914, most of prehistory), and if the lane came and went with them, then
 * panning through an unnamed stretch would shunt the ruler and the selection
 * band up and down under the cursor. Open the lane, then leave it open.
 */
export const subLaneOpen = (start: Year, end: Year): boolean => end - start <= SUB_AGE_MAX_SPAN

/** The fine lane's contents: named sub-periods the window touches, once it is
 *  narrow enough for them. Empty when it is not — and also in an unnamed
 *  stretch, which is why the lane's *presence* is `subLaneOpen`, not this. */
export const subBandsFor = (start: Year, end: Year): Era[] =>
  subLaneOpen(start, end) ? SUB_AGES.filter((e) => e.start < end && e.end > start) : []
