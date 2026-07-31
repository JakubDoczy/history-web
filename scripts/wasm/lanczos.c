/*
 * The hot half of the Lanczos-3 resampler, compiled to WebAssembly.
 *
 * The identical algorithm exists in TypeScript (src/lib/lanczos.ts) and is what
 * the unit tests check; this file exists only because that version measured
 * 4487 ms for a 2048x1024 -> 4096x2048 upscale on the build machine, against a
 * ~120 ms budget. Nothing here may differ from the TS in *result*, only in
 * speed — the tests compare the two on real buffers.
 *
 * Weight tables are computed in JS and handed in. That keeps sin() (and
 * therefore libm, which a freestanding wasm build does not have) out of this
 * file, and the tables are tiny: a few thousand floats against tens of millions
 * of multiply-adds.
 *
 * Build:  node scripts/build-lanczos-wasm.mjs   (regenerates the committed
 * base64 in src/lib/lanczosBinary.ts; clang is not needed for a normal build.)
 */

typedef unsigned char u8;

extern u8 __heap_base;
static unsigned int bump;

/* A bump allocator, reset before every call. There is exactly one caller, it
 * frees everything at once, and a real allocator would be more code than the
 * kernel it serves. */
__attribute__((export_name("reset"))) void reset(void) {
  bump = (((unsigned int)&__heap_base) + 15u) & ~15u;
}

__attribute__((export_name("alloc"))) unsigned int alloc(unsigned int n) {
  unsigned int p = bump;
  bump = (p + n + 15u) & ~15u;
  return p;
}

__attribute__((export_name("heapTop"))) unsigned int heapTop(void) { return bump; }

static inline int clampi(int v, int hi) { return v < 0 ? 0 : (v > hi ? hi : v); }

static inline u8 to_u8(float f) {
  int v = (int)(f + 0.5f);
  return (u8)(v < 0 ? 0 : (v > 255 ? 255 : v));
}

/*
 * Separable resample, RGBA8 in and RGBA8 out.
 *
 * Destination columns are processed in bands, and the loop order inside a band
 * is chosen entirely for the cache. The obvious ordering — resample column x
 * for every row, then move to x+1 — walks the source down a column, one cache
 * line per pixel, and measured 820 ms where this one measures ~150. So the
 * horizontal pass runs row by row (the source is read the way it is stored) and
 * writes a band-wide float row; the vertical pass then runs output row by
 * output row, and the six source rows it needs are a few kilobytes that stay in
 * L1 across the whole band.
 *
 * A whole-image float intermediate would also be 128 MB at the largest patch
 * size this app can ask for; a band is a couple of megabytes.
 *
 * The four channels are one v128 lane group, so each tap is a single
 * multiply-add. If a runtime lacks SIMD the module fails to instantiate and the
 * caller falls back to the TypeScript kernel, which is slow but correct.
 */
typedef float f4 __attribute__((vector_size(16)));

__attribute__((export_name("resample"))) void resample(
    unsigned int srcP, int srcW, int srcH,
    unsigned int dstP, int dstW, int dstH,
    unsigned int wxP, unsigned int sxP, int tapsX,
    unsigned int wyP, unsigned int syP, int tapsY,
    unsigned int tmpP, int band) {
  const u8 *src = (const u8 *)srcP;
  u8 *dst = (u8 *)dstP;
  const float *wx = (const float *)wxP;
  const int *sx = (const int *)sxP;
  const float *wy = (const float *)wyP;
  const int *sy = (const int *)syP;
  f4 *tmp = (f4 *)tmpP;

  for (int x0 = 0; x0 < dstW; x0 += band) {
    int x1 = x0 + band;
    if (x1 > dstW) x1 = dstW;
    int bw = x1 - x0;

    /* horizontal pass: tmp[y * bw + (x - x0)] */
    for (int y = 0; y < srcH; y++) {
      const u8 *row = src + (unsigned int)y * srcW * 4;
      f4 *out = tmp + (unsigned int)y * bw;
      for (int x = x0; x < x1; x++) {
        const float *w = wx + (unsigned int)x * tapsX;
        int first = sx[x];
        f4 acc = (f4){0.f, 0.f, 0.f, 0.f};
        for (int k = 0; k < tapsX; k++) {
          int i = clampi(first + k, srcW - 1) * 4;
          f4 px = (f4){(float)row[i], (float)row[i + 1], (float)row[i + 2], (float)row[i + 3]};
          acc += w[k] * px;
        }
        out[x - x0] = acc;
      }
    }

    /* vertical pass, straight into the destination */
    for (int y = 0; y < dstH; y++) {
      const float *w = wy + (unsigned int)y * tapsY;
      int first = sy[y];
      u8 *orow = dst + ((unsigned int)y * dstW + x0) * 4;
      for (int x = 0; x < bw; x++) {
        f4 acc = (f4){0.f, 0.f, 0.f, 0.f};
        for (int k = 0; k < tapsY; k++) {
          const f4 *row = tmp + (unsigned int)clampi(first + k, srcH - 1) * bw;
          acc += w[k] * row[x];
        }
        u8 *o = orow + x * 4;
        o[0] = to_u8(acc[0]);
        o[1] = to_u8(acc[1]);
        o[2] = to_u8(acc[2]);
        o[3] = to_u8(acc[3]);
      }
    }
  }
}
