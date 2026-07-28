/** Longitude directly under the sun for a given UTC hour (equinox approximation). */
export const subsolarLongitude = (utcHour: number): number => {
  const lng = (12 - utcHour) * 15
  return ((lng + 540) % 360) - 180 // wrap to [-180, 180)
}
