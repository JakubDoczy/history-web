export { CloudLayer } from './layer'
// Parked: a physically-motivated coverage simulation (advection through Earth's
// wind belts). Not in the render path — the shipped clouds use satellite imagery —
// but kept and tested for future use. See docs/plan-clouds.md.
export { CloudField, type CloudFieldOptions } from './field'
export { earthWind, beltWind, curlNoise, type Wind } from './wind'
