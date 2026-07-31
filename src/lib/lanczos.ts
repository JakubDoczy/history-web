/**
 * Lanczos-3 resampling for the patch pipeline.
 *
 * Everything that magnifies imagery on the way to the screen is bilinear:
 * `drawImage` when a cached patch is composited into a finer canvas, and the
 * GPU's LinearFilter when the held texture is stretched while a fresh patch
 * loads. Bilinear magnification is a tent filter — it reconstructs a signal
 * with straight lines between samples, so edges arrive either soft or, at high
 * magnification, visibly faceted. Lanczos-3 reconstructs with a windowed sinc,
 * which keeps edges where they were and costs three taps either side.
 *
 * The whole thing is one pure function over pixel buffers, with no DOM in
 * sight, so it can be tested and — see `resampleRGBA` — swapped for a compiled
 * kernel without any caller noticing.
 */

/** Kernel radius. 3 is the usual choice: sharp, with tolerable ringing. */
export const LANCZOS_A = 3

/**
 * The Lanczos kernel: sinc(x) · sinc(x/a) inside the support, 0 outside.
 *
 * The value at 0 has to be written out rather than computed — sin(0)/0 is NaN,
 * and one NaN in a weight table poisons every pixel it touches.
 */
export function lanczos(x: number, a = LANCZOS_A): number {
  const t = Math.abs(x)
  if (t < 1e-8) return 1
  if (t >= a) return 0
  const px = Math.PI * t
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px)
}

export interface WeightTable {
  /** First source index each destination sample reads from. */
  starts: Int32Array
  /** `taps` weights per destination sample, row-major, already normalised. */
  weights: Float32Array
  /** Weights per destination sample; padded with zeros where the edge clamps. */
  taps: number
}

/**
 * Weights mapping `srcLen` samples to `dstLen`.
 *
 * Two things here are easy to get wrong and both are visible. The half-pixel
 * offsets put sample centres, not sample edges, at the centre of their
 * intervals — without them the image drifts by half a destination pixel, which
 * on a streamed patch reads as the imagery not lining up with the base map.
 * And on *downscale* the filter has to widen by the scale ratio, or it samples
 * a signal it has not band-limited and aliases; on upscale it stays at its
 * natural width.
 *
 * Weights are normalised per destination sample after the edge clamp, so a
 * sample whose support hangs off the edge still sums to exactly 1 and the
 * border neither darkens nor brightens.
 */
export function lanczosWeights(srcLen: number, dstLen: number, a = LANCZOS_A): WeightTable {
  const ratio = srcLen / dstLen
  const filterScale = Math.max(ratio, 1) // widen only when shrinking
  const support = a * filterScale
  // ceil(2·support) columns, not one more. The extra column is provably always
  // zero — `first` is ceil(centre − support), so the last column sits at
  // (first − centre + taps − 1)/filterScale ≥ support/filterScale = a, and the
  // kernel is exactly 0 from a outwards. It cost a seventh of every multiply in
  // the compiled kernel, which does not test weights for zero the way the
  // reference loop does.
  const taps = Math.max(1, Math.ceil(support * 2))
  const starts = new Int32Array(dstLen)
  const weights = new Float32Array(dstLen * taps)
  for (let i = 0; i < dstLen; i++) {
    const centre = (i + 0.5) * ratio - 0.5
    const first = Math.ceil(centre - support)
    starts[i] = first
    let sum = 0
    const base = i * taps
    for (let k = 0; k < taps; k++) {
      const w = lanczos((first + k - centre) / filterScale, a)
      weights[base + k] = w
      sum += w
    }
    if (sum !== 0) for (let k = 0; k < taps; k++) weights[base + k] /= sum
  }
  return { starts, weights, taps }
}

export interface PixelBuffer {
  data: Uint8ClampedArray
  width: number
  height: number
}

const clampIndex = (i: number, n: number) => (i < 0 ? 0 : i >= n ? n - 1 : i)

/**
 * One separable pass, source rows in and destination rows out.
 *
 * Separability is the whole reason this is affordable: a 2D Lanczos-3 kernel is
 * 49 taps per pixel, two 1D passes are 7 + 7. The intermediate is float so the
 * horizontal pass's ringing is not clipped to 0..255 before the vertical pass
 * sees it — clipping in between would leave a faint dark halo along every
 * bright edge that the second pass then smears.
 */
function pass(
  src: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  table: WeightTable,
  out: Float32Array,
): void {
  const { starts, weights, taps } = table
  for (let y = 0; y < srcH; y++) {
    const rowIn = y * srcW * 4
    const rowOut = y * dstW * 4
    for (let x = 0; x < dstW; x++) {
      const first = starts[x]
      const wBase = x * taps
      let r = 0
      let g = 0
      let b = 0
      let alpha = 0
      for (let k = 0; k < taps; k++) {
        const w = weights[wBase + k]
        if (w === 0) continue
        const p = rowIn + clampIndex(first + k, srcW) * 4
        r += w * src[p]
        g += w * src[p + 1]
        b += w * src[p + 2]
        alpha += w * src[p + 3]
      }
      const o = rowOut + x * 4
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
      out[o + 3] = alpha
    }
  }
}

/** Transpose an RGBA float image, so the vertical pass is another horizontal one. */
function transpose(src: Float32Array, w: number, h: number, out: Float32Array): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const o = (x * h + y) * 4
      out[o] = src[i]
      out[o + 1] = src[i + 1]
      out[o + 2] = src[i + 2]
      out[o + 3] = src[i + 3]
    }
  }
}

/**
 * Lanczos-3 resample of an RGBA buffer. Pure: same bytes in, same bytes out.
 *
 * Ringing is real — a windowed sinc overshoots at a hard edge — and it is
 * handled by the destination being `Uint8ClampedArray`, which saturates rather
 * than wrapping. An overshoot that wrapped would turn the bright side of a
 * coastline black, which is the one failure mode of this filter that is worse
 * than the blur it replaces.
 */
export function resampleLanczos3(src: PixelBuffer, dstW: number, dstH: number): PixelBuffer {
  const w = Math.max(1, Math.round(dstW))
  const h = Math.max(1, Math.round(dstH))
  const out = new Uint8ClampedArray(w * h * 4)
  if (src.width === w && src.height === h) {
    out.set(src.data.subarray(0, w * h * 4))
    return { data: out, width: w, height: h }
  }

  // byte source -> float, once
  const fSrc = new Float32Array(src.width * src.height * 4)
  for (let i = 0; i < fSrc.length; i++) fSrc[i] = src.data[i]

  // horizontal
  const hBuf = new Float32Array(w * src.height * 4)
  pass(fSrc, src.width, src.height, w, lanczosWeights(src.width, w), hBuf)
  // transpose, filter again, transpose back: one inner loop, both axes
  const tBuf = new Float32Array(w * src.height * 4)
  transpose(hBuf, w, src.height, tBuf)
  const vBuf = new Float32Array(w * h * 4)
  pass(tBuf, src.height, w, h, lanczosWeights(src.height, h), vBuf)
  const fOut = new Float32Array(w * h * 4)
  transpose(vBuf, h, w, fOut)

  for (let i = 0; i < out.length; i++) out[i] = fOut[i]
  return { data: out, width: w, height: h }
}
