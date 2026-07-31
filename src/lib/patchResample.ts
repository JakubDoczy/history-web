import { resampleRGBA } from './lanczosWasm'

/**
 * Magnifying a cached imagery patch, off the main thread.
 *
 * Lanczos-3 over a couple of megapixels is 100–250 ms even compiled (measured:
 * a single composite during a zoom was the longest main-thread task in the
 * app), and it used to run *inside the zoom handler* — the camera moved, the
 * composite was redrawn, and the resample went with it. That is a quarter of a
 * second of frozen input for a picture that is about to be replaced by the next
 * frame's anyway.
 *
 * So the sharpening is asynchronous now. The caller draws the patch with plain
 * `drawImage` (bilinear — soft, but instant) and asks for a resample; when the
 * sharp version arrives it redraws with it. Nothing about the *result* changes,
 * only when it lands.
 */

export interface Crop {
  x: number
  y: number
  w: number
  h: number
}

/** A resampled copy: which source rectangle it holds, and at what size. */
export interface Upscale {
  crop: Crop
  w: number
  h: number
}

/**
 * May a resampled copy be drawn for this geometry?
 *
 * Only if it is a picture of exactly this source rectangle at exactly this
 * size. A copy holds one crop rendered at one size; drawn into any other
 * destination it lands scaled and offset from the ground it belongs to — a
 * sharp ghost sitting over the correctly placed imagery, which is what a zoom
 * looked like from the field: "stretched and deformed".
 *
 * The rule used to allow 5% of drift on the destination and on three of the
 * crop's four numbers — the crop's *height* was not compared at all, so a copy
 * of a short strip could be stretched down a tall one without anything
 * noticing. The slack bought nothing real: the resampler is only asked to run
 * once the camera is still, and a still camera does not change the geometry.
 * Whole pixels, because that is the resolution the crop is taken at.
 */
export const upscaleFits = (held: Upscale | undefined, want: Upscale): held is Upscale => {
  if (!held) return false
  const same = (a: number, b: number) => Math.round(a) === Math.round(b)
  return (
    same(held.w, want.w) &&
    same(held.h, want.h) &&
    same(held.crop.x, want.crop.x) &&
    same(held.crop.y, want.crop.y) &&
    same(held.crop.w, want.crop.w) &&
    same(held.crop.h, want.crop.h)
  )
}

export interface PatchResampler {
  /** The visible crop of `image`, Lanczos-3'd to dw x dh, or undefined. */
  run(image: CanvasImageSource, crop: Crop, dw: number, dh: number): Promise<CanvasImageSource | undefined>
  dispose(): void
}

/** Message shapes shared with the worker. */
export interface PatchResampleRequest {
  id: number
  bitmap: ImageBitmap
  dw: number
  dh: number
}
export interface PatchResampleResponse {
  id: number
  bitmap: ImageBitmap | null
}

/**
 * The pixel round trip, in whichever thread it is asked for: crop -> ImageData
 * -> Lanczos-3 -> canvas.
 *
 * Kept here rather than in DetailImagery because both the worker and the
 * no-worker fallback need exactly the same steps, and a second copy of them is
 * a second chance to disagree about the crop.
 */
export function resampleOnCanvas(
  image: CanvasImageSource,
  crop: Crop,
  dw: number,
  dh: number,
): HTMLCanvasElement | undefined {
  if (typeof document === 'undefined' || typeof ImageData === 'undefined') return undefined
  const cw = Math.max(1, Math.round(crop.w))
  const ch = Math.max(1, Math.round(crop.h))
  try {
    const src = document.createElement('canvas')
    src.width = cw
    src.height = ch
    const sctx = src.getContext('2d', { willReadFrequently: true })
    // a stub canvas (tests) has no pixel readback; fall through to bilinear
    if (!sctx?.getImageData) return undefined
    sctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, cw, ch)
    const out = resampleRGBA(sctx.getImageData(0, 0, cw, ch), dw, dh)

    const dst = document.createElement('canvas')
    dst.width = out.width
    dst.height = out.height
    const dctx = dst.getContext('2d')
    if (!dctx?.putImageData) return undefined
    dctx.putImageData(new ImageData(out.data, out.width, out.height), 0, 0)
    return dst
  } catch {
    // a tainted canvas is the realistic failure here: readback throws, and the
    // bilinear path is a perfectly good answer
    return undefined
  }
}

/** Everything the worker path needs to exist before it is worth trying. */
const workerSupported = () =>
  typeof Worker !== 'undefined' &&
  typeof OffscreenCanvas !== 'undefined' &&
  typeof createImageBitmap === 'function'

/**
 * Worker-backed resampler.
 *
 * The crop is done by `createImageBitmap` (which decodes and copies off the
 * main thread), the filter runs in the worker, and what comes back is an
 * `ImageBitmap` — so the main thread's whole share of the work is one
 * `drawImage` of an already-finished picture. No `getImageData`, no
 * `putImageData`, no kernel.
 */
class WorkerResampler implements PatchResampler {
  private worker?: Worker
  private next = 1
  private waiting = new Map<number, (b: ImageBitmap | undefined) => void>()
  private broken = false

  private ensure(): Worker | undefined {
    if (this.broken) return undefined
    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('./patchResample.worker.ts', import.meta.url), {
          type: 'module',
        })
        this.worker.onmessage = (e: MessageEvent<PatchResampleResponse>) => {
          const done = this.waiting.get(e.data.id)
          this.waiting.delete(e.data.id)
          done?.(e.data.bitmap ?? undefined)
        }
        this.worker.onerror = () => this.fail()
      } catch {
        this.fail()
      }
    }
    return this.worker
  }

  /** One failure retires the worker for good; the fallback is always correct. */
  private fail() {
    this.broken = true
    this.worker?.terminate()
    this.worker = undefined
    for (const [, done] of this.waiting) done(undefined)
    this.waiting.clear()
  }

  async run(image: CanvasImageSource, crop: Crop, dw: number, dh: number) {
    const worker = this.ensure()
    if (!worker) return undefined
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(
        image as ImageBitmapSource,
        Math.round(crop.x),
        Math.round(crop.y),
        Math.max(1, Math.round(crop.w)),
        Math.max(1, Math.round(crop.h)),
      )
    } catch {
      return undefined // tainted or unsupported source: bilinear stands
    }
    if (this.broken) {
      bitmap.close()
      return undefined
    }
    const id = this.next++
    const done = new Promise<ImageBitmap | undefined>((resolve) => this.waiting.set(id, resolve))
    const msg: PatchResampleRequest = { id, bitmap, dw, dh }
    worker.postMessage(msg, [bitmap])
    return done
  }

  dispose() {
    this.fail()
  }
}

/**
 * Fallback for browsers (and tests) without workers or OffscreenCanvas: the
 * same filter, on the main thread, but *never* in the caller's task. The
 * deferral is the point — a zoom handler must return in a frame, and whatever
 * this costs is paid after it has.
 */
class DeferredResampler implements PatchResampler {
  private timers = new Set<ReturnType<typeof setTimeout>>()

  run(image: CanvasImageSource, crop: Crop, dw: number, dh: number) {
    return new Promise<CanvasImageSource | undefined>((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t)
        resolve(resampleOnCanvas(image, crop, dw, dh))
      }, 0)
      this.timers.add(t)
    })
  }

  dispose() {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }
}

export const createPatchResampler = (): PatchResampler =>
  workerSupported() ? new WorkerResampler() : new DeferredResampler()
