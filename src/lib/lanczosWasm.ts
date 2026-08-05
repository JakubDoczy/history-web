import { LANCZOS_WASM_BASE64 } from './lanczosBinary'
import { lanczosWeights, resampleLanczos3, type PixelBuffer } from './lanczos'

/**
 * The compiled Lanczos-3 kernel.
 *
 * The TypeScript version in ./lanczos.ts is the specification and the thing the
 * tests check; it is also 4487 ms for a 2048x1024 -> 4096x2048 upscale, which
 * is thirty-odd frames of stall. This module runs the same arithmetic in
 * WebAssembly (~50 ms measured, against ~120 ms before the kernel was
 * reworked) and falls back to the TS whenever the module cannot be
 * instantiated, so the pipeline never depends on it existing.
 *
 * A request that is exactly 2x on both axes — which, once imagery streams as a
 * fixed tile pyramid, is nearly all of them — goes to a second export with the
 * weights baked in, and never builds or uploads a weight table at all. Same
 * bytes out, measured bit-identical, ~1.3x faster; see the C for the numbers.
 *
 * The binary is inlined as base64 rather than shipped as a separate asset:
 * 8.7 kB compiled, 3.8 kB of it gzipped over the wire — 2.4 kB more than
 * before the 2x paths — is still under the cost of the extra request, and it
 * means the resampler has no load order to get wrong: no `await import`, no
 * half-ready state where a patch arrives before the kernel does.
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
    scratchP: number,
  ): void
  /** Exact 2x in both axes, weights baked in; `up` 1 to double, 0 to halve. */
  resample2?(
    srcP: number,
    srcW: number,
    srcH: number,
    dstP: number,
    tmpP: number,
    band: number,
    scratchP: number,
    up: number,
  ): void
}

/** Destination columns per band; see the C for why the intermediate is banded. */
const BAND = 128
/**
 * The 2x path wants a wider band than the general one — measured 1.10x at 128
 * and 1.32x at 256, where the general kernel is flat across the same sweep.
 * With the tap loops unrolled the per-band setup is a bigger share of the work,
 * and a wider band also writes the destination in longer runs. 256 costs 8 MB
 * of intermediate at the largest patch this app asks for; 512 measured the same
 * and 1024 a little better, neither worth the memory.
 */
const BAND_2X = 256

/** Taps per phase, upscale and downscale — must match the C. */
const TAPS_2X = [12, 6]

/**
 * Is this an exact 2x on both axes? 1 = magnify, 0 = reduce, -1 = neither.
 *
 * The tile pyramid only ever asks for these two, and only these two have a
 * weight table small enough to bake into the kernel. Anything else — including
 * a request that is 2x on one axis only — takes the general path.
 */
const exact2 = (sw: number, sh: number, w: number, h: number): number =>
  w === sw * 2 && h === sh * 2 ? 1 : sw === w * 2 && sh === h * 2 ? 0 : -1

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

/** Finished pixels, still sitting in the kernel's memory. */
interface KernelResult {
  pixels: Uint8Array
  width: number
  height: number
}

/** Run the kernel and leave the answer where it landed, or `null` if it cannot run. */
function runKernel(src: PixelBuffer, dstW: number, dstH: number): KernelResult | null {
  const k = lanczosKernel()
  if (!k) return null
  const w = Math.max(1, Math.round(dstW))
  const h = Math.max(1, Math.round(dstH))

  // the specialised kernel needs no tables at all, so they are not built either
  const fixed = k.resample2 ? exact2(src.width, src.height, w, h) : -1
  const band = fixed < 0 ? BAND : BAND_2X
  const x = fixed < 0 ? lanczosWeights(src.width, w) : undefined
  const y = fixed < 0 ? lanczosWeights(src.height, h) : undefined
  const taps = x ? x.taps : TAPS_2X[fixed]

  k.reset()
  const srcBytes = src.width * src.height * 4
  const dstBytes = w * h * 4
  const tmpBytes = band * src.height * 4 * 4
  // the widest source span one band can read: a whole row, plus the filter
  // hanging off both ends. `starts` never goes below -taps nor above srcW.
  const scratchBytes = (src.width + 2 * taps + 4) * 16
  const srcP = k.alloc(srcBytes)
  const dstP = k.alloc(dstBytes)
  const tmpP = k.alloc(tmpBytes)
  const scratchP = k.alloc(scratchBytes)
  const wxP = x ? k.alloc(x.weights.byteLength) : 0
  const sxP = x ? k.alloc(x.starts.byteLength) : 0
  const wyP = y ? k.alloc(y.weights.byteLength) : 0
  const syP = y ? k.alloc(y.starts.byteLength) : 0

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

  if (x && y) {
    new Float32Array(mem, wxP, x.weights.length).set(x.weights)
    new Int32Array(mem, sxP, x.starts.length).set(x.starts)
    new Float32Array(mem, wyP, y.weights.length).set(y.weights)
    new Int32Array(mem, syP, y.starts.length).set(y.starts)
    k.resample(
      srcP, src.width, src.height,
      dstP, w, h,
      wxP, sxP, x.taps,
      wyP, syP, y.taps,
      tmpP, band, scratchP,
    )
  } else {
    // `fixed` is 1 or 0 here, which is exactly the kernel's `up` flag
    k.resample2!(srcP, src.width, src.height, dstP, tmpP, band, scratchP, fixed)
  }

  return { pixels: new Uint8Array(k.memory.buffer, dstP, dstBytes), width: w, height: h }
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
  const r = runKernel(src, dstW, dstH)
  if (!r) return null
  const data = new Uint8ClampedArray(r.pixels.length)
  data.set(r.pixels)
  return { data, width: r.width, height: r.height }
}

/**
 * Resample, and read the result *where the kernel left it*.
 *
 * The copy `resampleLanczos3Wasm` makes is not free at the sizes this app
 * reaches: allocating and filling a 134 MB `Uint8ClampedArray` for an
 * 8192x4096 result measured 332 ms in a worker — longer than the filter that
 * produced it. A caller that is going to walk the pixels anyway (the cloud
 * mask keeps one channel in four) can walk them here instead and never
 * materialise the RGBA copy at all.
 *
 * `take` is handed a view into the kernel's linear memory and must not keep
 * it: the next resample overwrites those bytes, and a `memory.grow` detaches
 * the view outright. Read what you need, return a buffer of your own. Where
 * the kernel is unavailable `take` gets the TypeScript result's own array
 * instead, so the contract is the same on both paths.
 */
export function resampleRGBAView<T>(
  src: PixelBuffer,
  dstW: number,
  dstH: number,
  take: (pixels: Uint8Array | Uint8ClampedArray, width: number, height: number) => T,
): T {
  const r = runKernel(src, dstW, dstH)
  if (r) return take(r.pixels, r.width, r.height)
  const out = resampleLanczos3(src, dstW, dstH)
  return take(out.data, out.width, out.height)
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
