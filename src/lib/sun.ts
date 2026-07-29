/** Longitude directly under the sun for a given UTC hour (equinox approximation). */
export const subsolarLongitude = (utcHour: number): number => {
  const lng = (12 - utcHour) * 15
  return ((lng + 540) % 360) - 180 // wrap to [-180, 180)
}

/** Visual moon longitude: trails the sun by ~110° (waxing gibbous) on a slightly inclined orbit. */
export const moonLongitude = (utcHour: number): number => {
  const lng = subsolarLongitude(utcHour) - 110
  return ((lng + 540) % 360) - 180
}
export const moonLatitude = (lng: number): number => 12 * Math.sin((lng * Math.PI) / 180)

/**
 * How lit-up civilization is at a given year: 0 before ~1850 (no electric
 * lighting visible from space), growing to 1 at the present. Slow start,
 * accelerating — mirrors electrification then urban sprawl.
 */
export const cityLightsFactor = (year: number): number =>
  Math.min(1, Math.max(0, (year - 1850) / 176)) ** 1.6
