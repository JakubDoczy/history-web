import { upscaleCloudMask } from './cloudUpscale'

/**
 * The cloud upscale, off the main thread.
 *
 * A 4096×2048 → 8192×4096 Lanczos-3 pass is a few hundred milliseconds even
 * compiled, which on the main thread would be a visible stall on a globe the
 * user is already dragging. Nothing here is clever: the decode has been done by
 * the caller (an ImageBitmap costs nothing to transfer), this draws it, filters
 * it and hands back bytes.
 */

export interface CloudUpscaleRequest {
  bitmap: ImageBitmap
  scale: number
}

export interface CloudUpscaleResponse {
  data: Uint8Array
  width: number
  height: number
  /** Wall time of the filter itself, for the console line the caller prints. */
  ms: number
}

/**
 * The worker global, typed by hand.
 *
 * Pulling in lib.webworker.d.ts would redefine half the DOM for every file in
 * the project; the two members this module touches are cheaper to state.
 */
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<CloudUpscaleRequest>) => void) | null
  postMessage(message: CloudUpscaleResponse | null, transfer?: Transferable[]): void
}

ctx.onmessage = (e: MessageEvent<CloudUpscaleRequest>) => {
  const { bitmap, scale } = e.data
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const g2d = canvas.getContext('2d', { willReadFrequently: false })
    if (!g2d) throw new Error('no 2d context')
    g2d.drawImage(bitmap, 0, 0)
    const src = g2d.getImageData(0, 0, bitmap.width, bitmap.height)
    const t0 = performance.now()
    const out = upscaleCloudMask(src, scale, true)
    const msg: CloudUpscaleResponse = { ...out, ms: performance.now() - t0 }
    ctx.postMessage(msg, [out.data.buffer as ArrayBuffer])
  } catch {
    // the caller keeps the texture it already has, so a failure here is silent
    ctx.postMessage(null)
  } finally {
    bitmap.close()
  }
}
