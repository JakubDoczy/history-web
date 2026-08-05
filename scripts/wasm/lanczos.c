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
 * Time it: node scripts/bench-lanczos.mjs — which also checks a candidate
 * against the TS reference before printing a number for it.
 */

#include <wasm_simd128.h>

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

/* The four channels are one v128 lane group, so each tap is a single
 * multiply-add. If a runtime lacks SIMD the module fails to instantiate and the
 * caller falls back to the TypeScript kernel, which is slow but correct. */
typedef float f4 __attribute__((vector_size(16)));

static inline f4 px(const u8 *row, int i) {
  i *= 4;
  return (f4){(float)row[i], (float)row[i + 1], (float)row[i + 2], (float)row[i + 3]};
}

/*
 * Four RGBA accumulators to sixteen destination bytes.
 *
 * This is `to_u8` on all sixteen channels at once and must stay exactly that:
 * add a half, truncate toward zero, clamp to 0..255. Truncation is what
 * `i32x4.trunc_sat` does, and the two narrows are the clamp — they saturate,
 * which matters because a windowed sinc genuinely overshoots at a hard edge and
 * a wrap there would turn the bright side of a coastline black. The scalar
 * version cost sixteen compares and sixteen byte stores per four pixels; this
 * is seven instructions and one store, and was the single largest win in this
 * file (~35%).
 */
static inline v128_t quad(f4 a, f4 b, f4 c, f4 d) {
  const f4 half = (f4){0.5f, 0.5f, 0.5f, 0.5f};
  v128_t i0 = wasm_i32x4_trunc_sat_f32x4((v128_t)(a + half));
  v128_t i1 = wasm_i32x4_trunc_sat_f32x4((v128_t)(b + half));
  v128_t i2 = wasm_i32x4_trunc_sat_f32x4((v128_t)(c + half));
  v128_t i3 = wasm_i32x4_trunc_sat_f32x4((v128_t)(d + half));
  return wasm_u8x16_narrow_i16x8(wasm_i16x8_narrow_i32x4(i0, i1),
                                 wasm_i16x8_narrow_i32x4(i2, i3));
}

/*
 * Separable resample, RGBA8 in and RGBA8 out.
 *
 * Destination columns are processed in bands, and the loop order inside a band
 * is chosen entirely for the cache. The obvious ordering — resample column x
 * for every row, then move to x+1 — walks the source down a column, one cache
 * line per pixel, and measured 820 ms where this one measures ~50. So the
 * horizontal pass runs row by row (the source is read the way it is stored) and
 * writes a band-wide float row; the vertical pass then runs output row by
 * output row, and the six source rows it needs are a few kilobytes that stay in
 * L1 across the whole band.
 *
 * A whole-image float intermediate would also be 128 MB at the largest patch
 * size this app can ask for; a band is a couple of megabytes.
 *
 * `scratch` holds the slice of the current source row that this band reads,
 * already widened to float and with the edge clamp already applied — see the
 * horizontal pass. Everything else the caller allocates is the obvious thing.
 *
 * Measured, 2048x1024 -> 4096x2048, best of eleven interleaved runs (node, on
 * the build machine): 118 ms before this round of work, 52 ms after. Things
 * tried that did *not* pay, so they are not tried again:
 *   - widening the source with explicit u8x16 -> f32x4 chains: within noise of
 *     the scalar convert loop, which clang already vectorises. +160 B
 *   - four destination pixels per horizontal iteration: within noise, +700 B
 *   - specialising the tap loop on the 6-tap upscale case with always_inline
 *     bodies: never better than the rolled loop, sometimes much worse, +2.5 kB
 *   - sixteen vertical accumulators instead of eight: 40% slower — register
 *     spills. Four is within noise of eight; eight pairs two stores per
 *     iteration, so it is what is here
 *   - bands of 256 or 512 columns: within noise of 128 for two to four times
 *     the intermediate, and 32 or 64 are clearly worse
 *   - relaxed-simd `f32x4.relaxed_madd`: 11% faster and, being a true FMA,
 *     actually bit-exact against the f64 reference. Declined anyway: Safari
 *     only has relaxed SIMD from 18.4, and a runtime that cannot instantiate
 *     this module falls all the way back to the 4487 ms TypeScript path. Five
 *     milliseconds in a worker is not worth that cliff, nor a second binary.
 */
__attribute__((export_name("resample"))) void resample(
    unsigned int srcP, int srcW, int srcH,
    unsigned int dstP, int dstW, int dstH,
    unsigned int wxP, unsigned int sxP, int tapsX,
    unsigned int wyP, unsigned int syP, int tapsY,
    unsigned int tmpP, int band, unsigned int scratchP) {
  const u8 *src = (const u8 *)srcP;
  u8 *dst = (u8 *)dstP;
  const float *wx = (const float *)wxP;
  const int *sx = (const int *)sxP;
  const float *wy = (const float *)wyP;
  const int *sy = (const int *)syP;
  f4 *tmp = (f4 *)tmpP;
  f4 *scratch = (f4 *)scratchP;

  for (int x0 = 0; x0 < dstW; x0 += band) {
    int x1 = x0 + band;
    if (x1 > dstW) x1 = dstW;
    int bw = x1 - x0;

    /* The source columns this band reads, as an unclamped range. `sx` is
     * non-decreasing, so the first and last destination columns of the band
     * bracket it. */
    int sFirst = sx[x0];
    int span = sx[x1 - 1] + tapsX - sFirst;
    int lead = -sFirst;
    if (lead < 0) lead = 0;
    if (lead > span) lead = span;
    int mid = srcW - sFirst;
    if (mid < lead) mid = lead;
    if (mid > span) mid = span;

    /*
     * Horizontal pass: tmp[y * bw + (x - x0)].
     *
     * The row is widened to float once, into `scratch`, with the out-of-range
     * ends filled from the edge pixel — so the tap loop below does no clamp, no
     * byte load and no int-to-float convert, which between them were a third of
     * this pass. The slice is small (a band's worth of destination columns
     * divided by the scale, plus the filter's reach), so widening it once per
     * band per row costs about one extra pass over the source in total.
     */
    for (int y = 0; y < srcH; y++) {
      const u8 *row = src + (unsigned int)y * srcW * 4;
      f4 lo = px(row, 0), hi = px(row, srcW - 1);
      for (int j = 0; j < lead; j++) scratch[j] = lo;
      for (int j = lead; j < mid; j++) scratch[j] = px(row, sFirst + j);
      for (int j = mid; j < span; j++) scratch[j] = hi;

      f4 *out = tmp + (unsigned int)y * bw;
      for (int x = x0; x < x1; x++) {
        const float *w = wx + (unsigned int)x * tapsX;
        const f4 *p = scratch + (sx[x] - sFirst);
        f4 acc = (f4){0.f, 0.f, 0.f, 0.f};
        for (int k = 0; k < tapsX; k++) acc += w[k] * p[k];
        out[x - x0] = acc;
      }
    }

    /* Vertical pass, straight into the destination, eight pixels at a time. */
    for (int y = 0; y < dstH; y++) {
      const float *w = wy + (unsigned int)y * tapsY;
      int first = sy[y];
      u8 *orow = dst + ((unsigned int)y * dstW + x0) * 4;
      int x = 0;
      for (; x + 8 <= bw; x += 8) {
        f4 a0 = (f4){0.f, 0.f, 0.f, 0.f}, a1 = a0, a2 = a0, a3 = a0;
        f4 a4 = a0, a5 = a0, a6 = a0, a7 = a0;
        for (int k = 0; k < tapsY; k++) {
          const f4 *r = tmp + (unsigned int)clampi(first + k, srcH - 1) * bw + x;
          float wk = w[k];
          a0 += wk * r[0]; a1 += wk * r[1]; a2 += wk * r[2]; a3 += wk * r[3];
          a4 += wk * r[4]; a5 += wk * r[5]; a6 += wk * r[6]; a7 += wk * r[7];
        }
        wasm_v128_store(orow + x * 4, quad(a0, a1, a2, a3));
        wasm_v128_store(orow + x * 4 + 16, quad(a4, a5, a6, a7));
      }
      /* A band narrower than eight columns only happens at the right edge. */
      for (; x < bw; x++) {
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

/*
 * ---- Exact 2x: the only two ratios a fixed tile pyramid ever asks for -------
 *
 * A tiled source is always shown at its own resolution or at one pyramid step
 * away, so the general path's per-call weight table — thousands of floats,
 * computed with sin() in JS, uploaded, then read back one tap at a time — is
 * the same handful of numbers every time. Written down, the table stops being
 * built, uploaded and indexed: twenty-four floats in the data section, one
 * cache line, and the tap loops go straight-line.
 *
 * Derivation, from `lanczosWeights` in src/lib/lanczos.ts; this is that
 * function evaluated by hand, not a second filter.
 *
 *   Up, n -> 2n. ratio 1/2, so the filter keeps its natural width: support 3,
 *   6 taps. centre(i) = i/2 - 1/4, first(i) = ceil(centre - 3), so the tap
 *   offsets are k - 2.75 when i is even and k - 2.25 when it is odd: two
 *   phases, the second the first reversed. start(i) = ((i + 1) >> 1) - 3.
 *
 *   Down, 2n -> n. ratio 2, so the filter widens by 2 to band-limit: support 6,
 *   12 taps. centre(i) = 2i + 1/2, start(i) = 2i - 5, tap offsets (k - 5.5)/2 —
 *   independent of i, so a single phase, and those offsets are exactly the two
 *   upscale phases interleaved. Hence W_DOWN[2j + p] == W_UP[p][j] / 2, halved
 *   because each phase normalises to 1 and the interleaving carries both. (The
 *   design note called this "6 taps at stride 2"; the stride is the *source*
 *   step between destination samples. The kernel itself is 12 contiguous taps,
 *   and anything narrower would alias.)
 *
 * Each phase sums to 1 after normalisation, as the general path's do, and the
 * values below are the float32 the general path would have been handed — so
 * the two agree to the byte, borders included. `bench-lanczos.mjs` checks that
 * ("err" is 0 on the 2x row, not "<= 1"), and so does the unit test.
 *
 * Measured, best of nine interleaved reps, node on the build machine, general
 * kernel at its own best band (128) against this one at 256:
 *
 *   2048x1024 -> 4096x2048   92 ms -> 73 ms   1.25x
 *   1024x512  -> 2048x1024   23 ms -> 18 ms   1.26x
 *   1024x1024 -> 2048x2048   45 ms -> 37 ms   1.22x
 *   2048x2048 -> 4096x4096  182 ms -> 147 ms  1.24x
 *   2048x2048 -> 1024x1024   45 ms -> 41 ms   1.11x   (down, 12 taps)
 *
 * plus, on the JS side, no weight table is built (two `lanczosWeights` calls,
 * thousands of sin()) or uploaded.
 *
 * A quarter, not the several-fold a bakeable weight table suggests, and the
 * reason is worth writing down: the general kernel was already multiply-add
 * bound, not lookup bound. 2x up is 36 multiply-adds per source pixel however
 * they are addressed, and wasm's baseline SIMD has no FMA, so each is two
 * instructions. What the specialisation actually removes is loop overhead, the
 * `starts` load, and the weight indirection — about a tenth — and then the
 * unrolled body turns out to scale with band width where the general one does
 * not, which is the rest. The remaining factor of ~3 against the machine's
 * peak is v8's codegen and only relaxed-simd FMA would touch it; still
 * declined, for the reason in the general kernel's notes.
 *
 * Tried and rejected here:
 *   - a rolling 8-row intermediate instead of the full-height band, so the
 *     float rows never leave L1 (fixed ratios make the window statically
 *     small, which is the one thing the general path cannot do): 0.75x. The
 *     tmp round trip is not the bottleneck, and interleaving the two passes
 *     costs more than the traffic it saves. Worth knowing, because it is the
 *     first thing this specialisation suggests.
 *   - pairing the two output rows of a phase pair so the seven source rows
 *     they share are loaded once: the loads were never the limit — 8 pixels of
 *     vertical pass is 48 loads against 96 multiply-adds. Not measured, not
 *     worth the second vertical loop.
 *
 * Cost: 8.7 kB compiled against 2.5 kB (3.8 kB gzipped against 1.3 kB), of
 * which the 12-tap downscale is about half. All of it is the unrolled bodies.
 */
#define TAPS_UP 6
#define TAPS_DOWN 12

static const float W_UP[2][TAPS_UP] = {
    {0.00737827085f, -0.0679972619f, 0.271010578f, 0.892770767f, -0.133274630f, 0.0301122852f},
    {0.0301122852f, -0.133274630f, 0.892770767f, 0.271010578f, -0.0679972619f, 0.00737827085f},
};
static const float W_DOWN[1][TAPS_DOWN] = {
    {0.00368913542f, 0.0150561426f, -0.0339986309f, -0.0666373149f, 0.135505289f, 0.446385384f,
     0.446385384f, 0.135505289f, -0.0666373149f, -0.0339986309f, 0.0150561426f, 0.00368913542f},
};

/*
 * The bands, the pre-widened scratch row and the edge clamp are the general
 * path's, unchanged — that is what makes the borders match rather than nearly
 * match. What is different: `taps` and `phases` arrive as literals through
 * always_inline, so the tap loops unroll; and both destination loops step by
 * `phases`, so the phase — and therefore which six or twelve weights are in
 * play — is fixed inside each body instead of being an index computed per
 * pixel. Each weight ends up a fixed operand at a known address rather than a
 * lookup into a table the caller supplied.
 *
 * `restrict` is what lets the horizontal pass keep a scratch pixel across the
 * two phases that share it: without it the store into `tmp` might have been the
 * next load from `scratch`, and every tap reloads. Worth ~5%, and it is honest
 * — `resample2` hands out four disjoint slices of a bump heap.
 *
 * Requires dstW and dstH to be multiples of `phases`, which the 2x case gives
 * for free; `resample2` is the only caller and it checks.
 */
static inline __attribute__((always_inline)) void fixed2(
    const u8 *restrict src, int srcW, int srcH, u8 *restrict dst, int dstW, int dstH,
    f4 *restrict tmp, int band, f4 *restrict scratch, const float *wt, int taps, int phases) {
/* First source sample destination i reads; see the derivation above. */
#define FIRST(i) (phases == 2 ? ((((i) + 1) >> 1) - 3) : (2 * (i) - 5))
  band -= band % phases;
  if (band < phases) band = phases;

  for (int x0 = 0; x0 < dstW; x0 += band) {
    int x1 = x0 + band;
    if (x1 > dstW) x1 = dstW;
    int bw = x1 - x0;

    int sFirst = FIRST(x0);
    int span = FIRST(x1 - 1) + taps - sFirst;
    int lead = -sFirst;
    if (lead < 0) lead = 0;
    if (lead > span) lead = span;
    int mid = srcW - sFirst;
    if (mid < lead) mid = lead;
    if (mid > span) mid = span;

    for (int y = 0; y < srcH; y++) {
      const u8 *row = src + (unsigned int)y * srcW * 4;
      f4 lo = px(row, 0), hi = px(row, srcW - 1);
      for (int j = 0; j < lead; j++) scratch[j] = lo;
      for (int j = lead; j < mid; j++) scratch[j] = px(row, sFirst + j);
      for (int j = mid; j < span; j++) scratch[j] = hi;

      f4 *out = tmp + (unsigned int)y * bw;
      for (int x = x0; x < x1; x += phases) {
        for (int q = 0; q < phases; q++) {
          const float *w = wt + q * taps;
          const f4 *p = scratch + (FIRST(x + q) - sFirst);
          f4 acc = (f4){0.f, 0.f, 0.f, 0.f};
          for (int k = 0; k < taps; k++) acc += w[k] * p[k];
          out[x + q - x0] = acc;
        }
      }
    }

    for (int y = 0; y < dstH; y += phases) {
      for (int q = 0; q < phases; q++) {
        const float *w = wt + q * taps;
        int first = FIRST(y + q);
        /* The rows this destination row reads, edge clamp resolved once each
         * rather than once per group of eight — with `taps` constant these stay
         * in registers, and it is another ~7%. */
        const f4 *rp[TAPS_DOWN];
        for (int k = 0; k < taps; k++) rp[k] = tmp + (unsigned int)clampi(first + k, srcH - 1) * bw;
        u8 *orow = dst + ((unsigned int)(y + q) * dstW + x0) * 4;
        int x = 0;
        for (; x + 8 <= bw; x += 8) {
          f4 a0 = (f4){0.f, 0.f, 0.f, 0.f}, a1 = a0, a2 = a0, a3 = a0;
          f4 a4 = a0, a5 = a0, a6 = a0, a7 = a0;
          for (int k = 0; k < taps; k++) {
            const f4 *r = rp[k] + x;
            float wk = w[k];
            a0 += wk * r[0]; a1 += wk * r[1]; a2 += wk * r[2]; a3 += wk * r[3];
            a4 += wk * r[4]; a5 += wk * r[5]; a6 += wk * r[6]; a7 += wk * r[7];
          }
          wasm_v128_store(orow + x * 4, quad(a0, a1, a2, a3));
          wasm_v128_store(orow + x * 4 + 16, quad(a4, a5, a6, a7));
        }
        for (; x < bw; x++) {
          f4 acc = (f4){0.f, 0.f, 0.f, 0.f};
          for (int k = 0; k < taps; k++) acc += w[k] * rp[k][x];
          u8 *o = orow + x * 4;
          o[0] = to_u8(acc[0]);
          o[1] = to_u8(acc[1]);
          o[2] = to_u8(acc[2]);
          o[3] = to_u8(acc[3]);
        }
      }
    }
  }
#undef FIRST
}

/*
 * Exact 2x in both axes: `up` non-zero doubles, zero halves. The destination
 * size is implied and the weights are already here, so nothing crosses the
 * boundary but pixels and scratch — the caller skips building and uploading
 * two weight tables as well as skipping the general kernel.
 *
 * A request that is not exactly 2x is refused rather than approximated; the
 * caller has the general path for those.
 */
__attribute__((export_name("resample2"))) void resample2(
    unsigned int srcP, int srcW, int srcH, unsigned int dstP,
    unsigned int tmpP, int band, unsigned int scratchP, int up) {
  int dstW = up ? srcW * 2 : srcW / 2;
  int dstH = up ? srcH * 2 : srcH / 2;
  if (dstW < 1 || dstH < 1) return;
  if (!up && ((srcW | srcH) & 1)) return;
  if (up)
    fixed2((const u8 *)srcP, srcW, srcH, (u8 *)dstP, dstW, dstH, (f4 *)tmpP, band,
           (f4 *)scratchP, (const float *)W_UP, TAPS_UP, 2);
  else
    fixed2((const u8 *)srcP, srcW, srcH, (u8 *)dstP, dstW, dstH, (f4 *)tmpP, band,
           (f4 *)scratchP, (const float *)W_DOWN, TAPS_DOWN, 1);
}
