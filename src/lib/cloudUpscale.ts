import { resampleRGBAView } from './lanczosWasm'
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
 * is uploaded. They are at least never copied: see `upscaleCloudMask`.
 */
export const CLOUD_UPSCALE = 2

/**
 * Whether that upscale is worth its cost on this device.
 *
 * It is not free, and the bill lands in one piece: 8192×4096 single-channel is
 * a 33 MB texture upload plus its mip chain, on the main thread, measured as
 * the single longest stall in the app. On a machine with room to spare that is
 * a one-off price for permanently smoother cloud edges. On a 4 GB phone it is a
 * third of a frame budget's worth of jank *and* 45 MB of texture memory that
 * the streamed imagery patch then has to compete for — to sharpen a layer that
 * fades out entirely as the camera closes in.
 *
 * So the rule is the plain one: skip it unless the device has both the texture
 * limit to hold the result and memory it will not miss.
 */
export const cloudUpscaleWorthIt = (deviceMemoryGb?: number, maxTextureSize = 8192): boolean =>
  maxTextureSize >= 8192 && (deviceMemoryGb ?? 8) > 4

export interface MaskBuffer {
  /** One byte per texel, row-major. */
  data: Uint8Array
  width: number
  height: number
}

/**
 * Red channel of an RGBA buffer, as a single-channel image, optionally
 * bottom-up.
 *
 * Uploading R8 rather than RGBA8 is a quarter of the texture memory for a map
 * the shader only ever reads `.r` from, and at 8192×4096 that is 32 MB against
 * 128 MB — worth one pass over the buffer.
 *
 * The row flip is a parameter rather than a second function because it is free
 * here and was not free as a second pass: reversing the rows afterwards read
 * and wrote another 33 MB, measured at 26 ms in the worker, to move bytes that
 * this loop was already touching. Why the flip is needed at all: the bundled
 * JPEG is uploaded by three's TextureLoader with `flipY` on — the shader's v
 * axis therefore runs bottom-up — while `DataTexture` defaults it off and is
 * documented as ignoring it. Rather than depend on a flag whose behaviour
 * differs per texture class (and whose failure mode is a globe with the
 * southern hemisphere's weather over the north, which is subtle enough to
 * ship), the replacement is flipped here, where it can be checked.
 */
export function redChannel(
  // deliberately structural, not `PixelBuffer`: the caller below hands this a
  // view into the resampler's own memory, which is a plain Uint8Array
  src: { data: ArrayLike<number>; width: number; height: number },
  flip = false,
): MaskBuffer {
  const { width, height } = src
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    let i = y * width * 4
    let o = (flip ? height - 1 - y : y) * width
    for (let x = 0; x < width; x++, i += 4, o++) out[o] = src.data[i]
  }
  return { data: out, width, height }
}

/**
 * Lanczos-3 the cloud mask up by `scale`, returning single-channel bytes —
 * bottom-up when `flip`, which is what the DataTexture upload wants.
 *
 * The three channels this throws away are never copied out of the resampler:
 * `resampleRGBAView` reads them where the kernel left them. At 8192x4096 the
 * copy this avoids is 134 MB and measured 332 ms, against ~200 ms for the
 * filter itself — the buffer shuffling really was the larger half of this
 * path.
 *
 * Pure, and pure by necessity: this runs in a worker, where the only way to
 * know it did the right thing is to have checked it somewhere else.
 */
export function upscaleCloudMask(
  src: PixelBuffer,
  scale = CLOUD_UPSCALE,
  flip = false,
): MaskBuffer {
  const w = Math.max(1, Math.round(src.width * scale))
  const h = Math.max(1, Math.round(src.height * scale))
  return resampleRGBAView(src, w, h, (pixels, width, height) =>
    redChannel({ data: pixels, width, height }, flip),
  )
}
