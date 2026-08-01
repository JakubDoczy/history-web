/**
 * Stub for `three/webgpu` — see ./README.md.
 *
 * three-globe reaches for a WebGPURenderer to run its tile/particle compute
 * path. This app renders through globe.gl's ordinary WebGL2 renderer and never
 * constructs one, so the whole WebGPU backend (a second full copy of three's
 * material and node system) is aliased out of the bundle in vite.config.ts.
 */

/** Thrown instead of building a WebGPU device, so the accident is legible. */
export class StubbedDependencyError extends Error {
  constructor(what) {
    super(
      `three/webgpu is stubbed out of this build, but three-globe just constructed ` +
        `${what}. That means a layer using the WebGPU compute path got enabled. To ` +
        `use it, remove the 'three/webgpu' entry from resolve.alias in vite.config.ts ` +
        `— see build/stubs/README.md.`,
    )
    this.name = 'StubbedDependencyError'
  }
}

export class WebGPURenderer {
  constructor() {
    throw new StubbedDependencyError('WebGPURenderer')
  }
}

export class StorageInstancedBufferAttribute {
  constructor() {
    throw new StubbedDependencyError('StorageInstancedBufferAttribute')
  }
}
