/**
 * Stub for `h3-js` — see ./README.md.
 *
 * three-globe imports these four for its hexBin and hexPolygon layers. This app
 * draws neither, so the real library (Uber's H3, an asm.js blob) is aliased out
 * of the bundle in vite.config.ts.
 */

/** Thrown instead of doing H3 work, so an accidental hexbin layer says so. */
export class StubbedDependencyError extends Error {
  constructor(fn) {
    super(
      `h3-js is stubbed out of this build, but three-globe just called ${fn}(). ` +
        `That means a hexBin/hexPolygon layer got enabled. To use it, remove the ` +
        `'h3-js' entry from resolve.alias in vite.config.ts — it costs ~54 kB ` +
        `brotli. See build/stubs/README.md.`,
    )
    this.name = 'StubbedDependencyError'
  }
}

export const latLngToCell = () => {
  throw new StubbedDependencyError('latLngToCell')
}
export const cellToLatLng = () => {
  throw new StubbedDependencyError('cellToLatLng')
}
export const cellToBoundary = () => {
  throw new StubbedDependencyError('cellToBoundary')
}
export const polygonToCells = () => {
  throw new StubbedDependencyError('polygonToCells')
}
