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
