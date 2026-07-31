import { resampleRGBA } from './lanczosWasm'
import type { PatchResampleRequest, PatchResampleResponse } from './patchResample'

/**
 * The imagery patch upscale, off the main thread.
 *
 * The caller has already cropped the patch into an ImageBitmap (free to
 * transfer), so all that happens here is readback, filter, and hand back an
 * ImageBitmap the compositor can draw straight onto its canvas. Returning a
 * bitmap rather than pixels matters: `putImageData` of two megapixels on the
 * main thread was itself a dropped frame.
 *
 * A failure answers with a null bitmap; the caller keeps the bilinear draw.
 */

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<PatchResampleRequest>) => void) | null
  postMessage(message: PatchResampleResponse, transfer?: Transferable[]): void
}

ctx.onmessage = (e: MessageEvent<PatchResampleRequest>) => {
  const { id, bitmap, dw, dh } = e.data
  try {
    const src = new OffscreenCanvas(bitmap.width, bitmap.height)
    const sctx = src.getContext('2d', { willReadFrequently: true })
    if (!sctx) throw new Error('no 2d context')
    sctx.drawImage(bitmap, 0, 0)
    const out = resampleRGBA(sctx.getImageData(0, 0, bitmap.width, bitmap.height), dw, dh)

    const dst = new OffscreenCanvas(out.width, out.height)
    const dctx = dst.getContext('2d')
    if (!dctx) throw new Error('no 2d context')
    dctx.putImageData(new ImageData(out.data, out.width, out.height), 0, 0)
    const result = dst.transferToImageBitmap()
    ctx.postMessage({ id, bitmap: result }, [result])
  } catch {
    ctx.postMessage({ id, bitmap: null })
  } finally {
    bitmap.close()
  }
}
