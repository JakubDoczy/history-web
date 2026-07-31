import { resampleRGBA } from './lanczosWasm'
import type { PixelBuffer } from './lanczos'

/**
 * Sharpening the bundled cloud mask.
 *
 * clouds.jpg is 4096×2048 — half the angular resolution the base map gets, and
 * a mask the shader magnifies further by sampling it through a parallax offset.
 * Past the point where the globe fills a fair part of the screen the GPU is
 * doing bilinear magnification on it, so cloud edges arrive as visible facets:
 * straight lines between texels, at texel scale.
 *
 * Lanczos-3 to twice the size does not invent detail, but it reconstructs the
 * detail that is there with a windowed sinc instead of a tent, which is exactly
 * the difference between "blocky" and "soft" — and soft is what the shader's
 * unsharp pass (see uCloudSharp in globeSurface.ts) can then work with.
 *
 * The result is a *mask*: one meaningful channel. It is resampled as RGBA
 * because that is what the shared resampler speaks — the three redundant
 * channels cost time in the worker, not on the GPU, since only the red channel
 * is uploaded.
 */
export const CLOUD_UPSCALE = 2

export interface MaskBuffer {
  /** One byte per texel, row-major. */
  data: Uint8Array
  width: number
  height: number
}

/**
 * Red channel of an RGBA buffer, as a single-channel image.
 *
 * Uploading R8 rather than RGBA8 is a quarter of the texture memory for a map
 * the shader only ever reads `.r` from, and at 8192×4096 that is 32 MB against
 * 128 MB — worth one pass over the buffer.
 */
export function redChannel(src: PixelBuffer): MaskBuffer {
  const out = new Uint8Array(src.width * src.height)
  for (let i = 0; i < out.length; i++) out[i] = src.data[i * 4]
  return { data: out, width: src.width, height: src.height }
}

/**
 * Reverse the row order of a mask.
 *
 * The bundled JPEG is uploaded by three's TextureLoader with `flipY` on — the
 * shader's v axis therefore runs bottom-up — while `DataTexture` defaults it
 * off and is documented as ignoring it. Rather than depend on a flag whose
 * behaviour differs per texture class (and whose failure mode is a globe with
 * the southern hemisphere's weather over the north, which is subtle enough to
 * ship), the replacement is flipped here, in one pure function that can be
 * checked.
 */
export function flipRows(m: MaskBuffer): MaskBuffer {
  const out = new Uint8Array(m.data.length)
  for (let y = 0; y < m.height; y++) {
    out.set(m.data.subarray(y * m.width, (y + 1) * m.width), (m.height - 1 - y) * m.width)
  }
  return { data: out, width: m.width, height: m.height }
}

/**
 * Lanczos-3 the cloud mask up by `scale`, returning single-channel bytes.
 *
 * Pure, and pure by necessity: this runs in a worker, where the only way to
 * know it did the right thing is to have checked it somewhere else.
 */
export function upscaleCloudMask(src: PixelBuffer, scale = CLOUD_UPSCALE): MaskBuffer {
  const w = Math.max(1, Math.round(src.width * scale))
  const h = Math.max(1, Math.round(src.height * scale))
  return redChannel(resampleRGBA(src, w, h))
}
