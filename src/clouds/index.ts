// Parked: a physically-motivated coverage simulation (advection through Earth's
// wind belts). Not in the render path — the shipped clouds use a satellite-derived
// mask composited in the globe surface shader. See docs/plan-clouds.md.
export { CloudField, type CloudFieldOptions } from './field'
export { earthWind, beltWind, curlNoise, type Wind } from './wind'
