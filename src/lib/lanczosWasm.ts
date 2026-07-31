import { LANCZOS_WASM_BASE64 } from './lanczosBinary'
import { lanczosWeights, resampleLanczos3, type PixelBuffer } from './lanczos'

/**
 * The compiled Lanczos-3 kernel.
 *
 * The TypeScript version in ./lanczos.ts is the specification and the thing the
 * tests check; it is also 4487 ms for a 2048x1024 -> 4096x2048 upscale, which
 * is thirty-odd frames of stall. This module runs the same arithmetic in
 * WebAssembly (~90 ms measured) and falls back to the TS whenever the module
 * cannot be instantiated, so the pipeline never depends on it existing.
 *
 * The binary is inlined as base64 rather than shipped as a separate asset:
 * 1.7 kB compiled is under the cost of the extra request, and it means the
 * resampler has no load order to get wrong — no `await import`, no half-ready
 * state where a patch arrives before the kernel does.
 */

interface Kernel {
  memory: WebAssembly.Memory
  reset(): void
  alloc(n: number): number
  heapTop(): number
  resample(
    srcP: number,
    srcW: number,
    srcH: number,
    dstP: number,
    dstW: number,
    dstH: number,
    wxP: number,
    sxP: number,
    tapsX: number,
    wyP: number,
    syP: number,
    tapsY: number,
    tmpP: number,
    band: number,
  ): void
}

/** Destination columns per band; see the C for why the intermediate is banded. */
const BAND = 128

let kernel: Kernel | null | undefined // undefined = not tried yet, null = unavailable

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Base64 to bytes, by hand.
 *
 * `atob` would do, and is what runs when it exists; the fallback is here
 * because this module is imported by tests and by anything that type-checks
 * without a DOM, and eight lines is cheaper than a dependency or a build-time
 * branch.
 */
const decode = (b64: string): Uint8Array => {
  if (typeof atob === 'function') {
    const s = atob(b64)
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
  }
  const clean = b64.replace(/=+$/, '')
  const out = new Uint8Array((clean.length * 3) >> 2)
  let acc = 0
  let bits = 0
  let n = 0
  for (const ch of clean) {
    acc = (acc << 6) | ALPHABET.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  return out
}

/** Instantiate once. Any failure is remembered as "unavailable", never retried. */
export function lanczosKernel(): Kernel | null {
  if (kernel !== undefined) return kernel
  kernel = null
  try {
    const mod = new WebAssembly.Module(decode(LANCZOS_WASM_BASE64))
    const inst = new WebAssembly.Instance(mod, {})
    const e = inst.exports as unknown as Kernel
    if (e.memory && typeof e.resample === 'function') kernel = e
  } catch {
    // no WebAssembly, a CSP that forbids it, or a corrupt binary: the caller
    // has a working fallback, so this is not worth reporting
  }
  return kernel
}

/**
 * Lanczos-3 resample through the compiled kernel, or `null` if it is not
 * available. Same contract as `resampleLanczos3`.
 */
export function resampleLanczos3Wasm(
  src: PixelBuffer,
  dstW: number,
  dstH: number,
): PixelBuffer | null {
  const k = lanczosKernel()
  if (!k) return null
  const w = Math.max(1, Math.round(dstW))
  const h = Math.max(1, Math.round(dstH))

  const x = lanczosWeights(src.width, w)
  const y = lanczosWeights(src.height, h)

  k.reset()
  const srcBytes = src.width * src.height * 4
  const dstBytes = w * h * 4
  const tmpBytes = BAND * src.height * 4 * 4
  const srcP = k.alloc(srcBytes)
  const dstP = k.alloc(dstBytes)
  const tmpP = k.alloc(tmpBytes)
  const wxP = k.alloc(x.weights.byteLength)
  const sxP = k.alloc(x.starts.byteLength)
  const wyP = k.alloc(y.weights.byteLength)
  const syP = k.alloc(y.starts.byteLength)

  // grow *before* taking any view: WebAssembly.Memory.grow detaches every
  // existing ArrayBuffer view, so a view captured earlier would silently write
  // into nothing
  const need = k.heapTop() + 64
  const pages = Math.ceil((need - k.memory.buffer.byteLength) / 65536)
  if (pages > 0) {
    try {
      k.memory.grow(pages)
    } catch {
      return null // out of address space; the TS path allocates from the JS heap
    }
  }

  const mem = k.memory.buffer
  new Uint8Array(mem, srcP, srcBytes).set(src.data.subarray(0, srcBytes))
  new Float32Array(mem, wxP, x.weights.length).set(x.weights)
  new Int32Array(mem, sxP, x.starts.length).set(x.starts)
  new Float32Array(mem, wyP, y.weights.length).set(y.weights)
  new Int32Array(mem, syP, y.starts.length).set(y.starts)

  k.resample(
    srcP, src.width, src.height,
    dstP, w, h,
    wxP, sxP, x.taps,
    wyP, syP, y.taps,
    tmpP, BAND,
  )

  const data = new Uint8ClampedArray(dstBytes)
  data.set(new Uint8Array(k.memory.buffer, dstP, dstBytes))
  return { data, width: w, height: h }
}

/**
 * The one entry point the app uses: Lanczos-3 resampling, compiled where that
 * is possible and interpreted where it is not.
 *
 * Pure — the same buffer in gives the same bytes out, on either path, which is
 * what lets the tests hold the two against each other.
 */
export function resampleRGBA(src: PixelBuffer, dstW: number, dstH: number): PixelBuffer {
  return resampleLanczos3Wasm(src, dstW, dstH) ?? resampleLanczos3(src, dstW, dstH)
}
