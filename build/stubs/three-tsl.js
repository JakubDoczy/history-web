/**
 * Stub for `three/tsl` — see ./README.md.
 *
 * three-globe writes its WebGPU compute kernel (a KDE heatmap) in three's shader
 * node language. It only touches these thirteen names, and only from inside that
 * kernel, which this app never runs — so the node system is aliased out of the
 * bundle in vite.config.ts.
 *
 * Every export is callable and throws: three-globe reads them off the namespace
 * and *then* calls them, so a bare property read has to succeed for the error to
 * come from the call site rather than from destructuring.
 */

/** Thrown instead of building a shader node, so the accident is legible. */
export class StubbedDependencyError extends Error {
  constructor(fn) {
    super(
      `three/tsl is stubbed out of this build, but three-globe just called ${fn}(). ` +
        `That means a layer using the WebGPU compute path (the TSL heatmap kernel) ` +
        `got enabled. To use it, remove the 'three/tsl' and 'three/webgpu' entries ` +
        `from resolve.alias in vite.config.ts — see build/stubs/README.md.`,
    )
    this.name = 'StubbedDependencyError'
  }
}

const stub = (name) => {
  const f = () => {
    throw new StubbedDependencyError(name)
  }
  return f
}

export const Fn = stub('Fn')
export const If = stub('If')
export const Loop = stub('Loop')
export const uniform = stub('uniform')
export const storage = stub('storage')
export const float = stub('float')
export const instanceIndex = stub('instanceIndex')
export const sqrt = stub('sqrt')
export const sin = stub('sin')
export const cos = stub('cos')
export const asin = stub('asin')
export const exp = stub('exp')
export const negate = stub('negate')
