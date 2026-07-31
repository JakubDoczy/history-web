/**
 * Bringing a map in after the globe is already on screen.
 *
 * First paint needs one texture: the day basemap. The night lights, the height
 * field and the cloud mask are all worth having and none of them is worth
 * waiting for — together they are 1.1 MB of download and 75 MB of texture
 * upload before anybody sees a planet. So they load afterwards, and each one
 * appears the moment it lands.
 *
 * "Appears" is the whole problem. A height field switching on in one frame
 * turns flat ground into lit terrain instantly; a cloud deck switching on drops
 * shadows across a continent between two frames. Both read as a fault rather
 * than as an arrival. Ramping the map's own strength over a few hundred
 * milliseconds costs one multiply per uniform and turns each into something
 * that looks intended.
 */

/** How long a deferred map takes to reach full strength once it lands. */
export const MAP_FADE_MS = 450

/**
 * One step of a linear ramp toward a target, for a frame of `dtMs`.
 *
 * Linear rather than exponential because a ramp has to *finish*: an
 * exponential approach never reaches 1, so the relief strength would sit
 * fractionally under the setting for ever and every frame would keep writing a
 * new uniform. Clamped at both ends, and tolerant of the absurd frame times a
 * backgrounded tab produces — a tab that was hidden for a minute should return
 * with the fade complete, not with a ramp that overshot to 40.
 */
export const fadeTowards = (
  current: number,
  target: number,
  dtMs: number,
  durationMs = MAP_FADE_MS,
): number => {
  const step = Math.max(0, dtMs) / Math.max(durationMs, 1)
  if (target > current) return Math.min(target, current + step)
  return Math.max(target, current - step)
}
