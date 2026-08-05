/**
 * Times the compiled Lanczos-3 kernel, and checks it still agrees with the
 * TypeScript reference before believing any of the numbers.
 *
 *   node scripts/bench-lanczos.mjs                  # the shipped kernel
 *   node scripts/bench-lanczos.mjs /tmp/other.c ... # candidates, side by side
 *   node scripts/bench-lanczos.mjs --ts             # include the TS reference
 *
 * A kernel that also exports `resample2` gets a second row for it: the exact-2x
 * specialisation, on the cases that are exactly 2x. Both rows are checked
 * against the reference, and the 2x row against the general one — it exists to
 * be faster, not to be different.
 *
 * A variant that disagrees with the reference by more than one quantisation
 * step is reported as WRONG and its time is not worth reading; the whole point
 * of the compiled path is that it is invisible.
 *
 * Node runs src/lib/lanczos.ts directly (type stripping), so the weight tables
 * here are the same code the app uses rather than a second copy that can drift.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, basename, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const { lanczosWeights, resampleLanczos3 } = await import(resolve(root, 'src/lib/lanczos.ts'))

const args = process.argv.slice(2)
const withTs = args.includes('--ts')
const files = args.filter((a) => !a.startsWith('--'))
if (files.length === 0) files.push(resolve(here, 'wasm/lanczos.c'))

const scratch = mkdtempSync(join(tmpdir(), 'lanczos-bench-'))

function compile(src) {
  const out = join(scratch, basename(src).replace(/\.c$/, '.wasm'))
  execFileSync('clang', [
    '--target=wasm32', '-O3', '-msimd128', '-flto', '-nostdlib', '-ffreestanding',
    '-Wl,--no-entry', '-Wl,--export-dynamic', '-Wl,--lto-O3', '-Wl,-z,stack-size=65536',
    '-o', out, src,
  ])
  const bytes = readFileSync(out)
  rmSync(out)
  return bytes
}

/**
 * One instantiated kernel, with the JS side of the call.
 *
 * Kernels are allowed to differ in how many buffers they want: a variant that
 * pre-widens source rows to float needs a scratch row the current one does not.
 * The extra argument is only passed when the export takes it, which keeps a
 * candidate from having to carry an unused parameter to be benchmarked.
 */
function load(bytes) {
  const mod = new WebAssembly.Module(bytes)

  // one instance per prepared case: they all allocate from the same bump heap
  // after the same reset, so a second case silently overwrites the first one's
  // weight tables and the first one then reads an index table full of pixels
  return (src, srcW, srcH, dstW, dstH, fixed) => {
    const e = new WebAssembly.Instance(mod, {}).exports
    if (fixed !== undefined && !e.resample2) return undefined
    const wantsScratch = e.resample.length > 14
    const x = fixed === undefined ? lanczosWeights(srcW, dstW) : null
    const y = fixed === undefined ? lanczosWeights(srcH, dstH) : null
    // BAND=512 node scripts/... to sweep; the 2x path likes a wider band than
    // the general one, so it has its own default, matching lanczosWasm.ts
    const BAND = Number(process.env.BAND ?? (fixed === undefined ? 128 : 256))
    e.reset()
    const srcBytes = srcW * srcH * 4
    const dstBytes = dstW * dstH * 4
    const srcP = e.alloc(srcBytes)
    const dstP = e.alloc(dstBytes)
    const tmpP = e.alloc(BAND * srcH * 16)
    const wxP = x ? e.alloc(x.weights.byteLength) : 0
    const sxP = x ? e.alloc(x.starts.byteLength) : 0
    const wyP = y ? e.alloc(y.weights.byteLength) : 0
    const syP = y ? e.alloc(y.starts.byteLength) : 0
    // widest possible source span a band can read: the whole row plus the
    // filter hanging off both ends
    const taps = x ? x.taps : fixed ? 6 : 12
    const scratchP = wantsScratch ? e.alloc((srcW + 2 * taps + 4) * 16) : 0

    const need = e.heapTop() + 64
    const pages = Math.ceil((need - e.memory.buffer.byteLength) / 65536)
    if (pages > 0) e.memory.grow(pages)

    const mem = e.memory.buffer
    new Uint8Array(mem, srcP, srcBytes).set(src.subarray(0, srcBytes))
    if (x) {
      new Float32Array(mem, wxP, x.weights.length).set(x.weights)
      new Int32Array(mem, sxP, x.starts.length).set(x.starts)
      new Float32Array(mem, wyP, y.weights.length).set(y.weights)
      new Int32Array(mem, syP, y.starts.length).set(y.starts)
    }

    const call = !x
      ? () => e.resample2(srcP, srcW, srcH, dstP, tmpP, BAND, scratchP, fixed)
      : wantsScratch
      ? () => e.resample(srcP, srcW, srcH, dstP, dstW, dstH, wxP, sxP, x.taps, wyP, syP, y.taps, tmpP, BAND, scratchP)
      : () => e.resample(srcP, srcW, srcH, dstP, dstW, dstH, wxP, sxP, x.taps, wyP, syP, y.taps, tmpP, BAND)

    return { call, read: () => new Uint8ClampedArray(new Uint8Array(e.memory.buffer, dstP, dstBytes)) }
  }
}

/** 1 where the request doubles both axes, 0 where it halves both, else -1. */
const exact2 = (sw, sh, dw, dh) =>
  dw === sw * 2 && dh === sh * 2 ? 1 : sw === dw * 2 && sh === dh * 2 ? 0 : -1

/** Something with edges, gradients and noise — a flat field would flatter a filter. */
function image(w, h) {
  const data = new Uint8ClampedArray(w * h * 4)
  let s = 12345
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const land = Math.sin(x * 0.013) + Math.cos(y * 0.017) > 0.2 ? 1 : 0
      const shade = 60 + 120 * land + 40 * Math.sin(x * 0.11) * Math.cos(y * 0.07) + rnd() * 30
      data[i] = shade
      data[i + 1] = shade * 0.85 + 20 * land
      data[i + 2] = shade * 0.6 + 60 * (1 - land)
      data[i + 3] = 255
    }
  }
  return data
}

const time1 = (fn) => {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}

const stats = (ts) => {
  const s = [...ts].sort((a, b) => a - b)
  return { median: s[s.length >> 1], best: s[0] }
}

const CASES = [
  [2048, 1024, 4096, 2048, 'basemap 2x'],
  [1024, 512, 2048, 1024, 'patch 2x'],
  [700, 420, 1400, 840, 'patch 2x odd'],
  [1024, 1024, 2048, 2048, '1024\u00b2 up'],
  [2048, 2048, 4096, 4096, '2048\u00b2 up'],
  [2048, 2048, 1024, 1024, '2048\u00b2 down'],
]

// correctness first, on sizes small enough for the reference to be affordable
const CHECKS = [
  [64, 48, 151, 97],
  [40, 40, 17, 23],
  [31, 17, 31, 17],
  [129, 71, 258, 142],
  [64, 48, 128, 96], // exact 2x, both directions, including the odd-sized
  [65, 49, 130, 98], // bands the specialised path has to get right at the edge
  [64, 48, 32, 24],
  [130, 98, 65, 49],
]

const REPS = Number(process.env.REPS ?? 7)

const rows = []
for (const file of files) {
  const bytes = compile(file)
  const make = load(bytes)
  const fixedRuns = {}
  let worst = 0
  let worst2 = 0 // the 2x path against the general one: must be 0, not "close"
  for (const [sw, sh, dw, dh] of CHECKS) {
    const src = image(sw, sh)
    const ref = resampleLanczos3({ data: src, width: sw, height: sh }, dw, dh)
    const k = make(src, sw, sh, dw, dh)
    k.call()
    const got = k.read()
    for (let i = 0; i < ref.data.length; i++) worst = Math.max(worst, Math.abs(got[i] - ref.data[i]))
    const fixed = exact2(sw, sh, dw, dh)
    const k2 = fixed < 0 ? undefined : make(src, sw, sh, dw, dh, fixed)
    if (!k2) continue
    k2.call()
    const got2 = k2.read()
    for (let i = 0; i < got.length; i++) worst2 = Math.max(worst2, Math.abs(got[i] - got2[i]))
  }
  const runs = {}
  for (const [sw, sh, dw, dh, label] of CASES) {
    const src = image(sw, sh)
    const k = make(src, sw, sh, dw, dh)
    k.call() // warm
    runs[label] = { call: k.call, ts: [] }
    const fixed = exact2(sw, sh, dw, dh)
    const k2 = fixed < 0 ? undefined : make(src, sw, sh, dw, dh, fixed)
    if (!k2) continue
    k2.call()
    fixedRuns[label] = { call: k2.call, ts: [] }
  }
  rows.push({ name: basename(file), size: bytes.length, worst, runs })
  if (Object.keys(fixedRuns).length)
    rows.push({ name: '  \u2514 exact 2x', size: 0, worst: worst2, runs: fixedRuns })
}

if (withTs) {
  const runs = {}
  for (const [sw, sh, dw, dh, label] of CASES) {
    const buf = { data: image(sw, sh), width: sw, height: sh }
    runs[label] = { call: () => resampleLanczos3(buf, dw, dh), ts: [] }
  }
  rows.push({ name: 'lanczos.ts (reference)', size: 0, worst: 0, runs })
}

/*
 * Round-robin, not variant-by-variant. A shared machine drifts over the minute
 * a sweep takes, and measuring one candidate to completion before starting the
 * next hands the whole of that drift to whichever ran during the busy patch —
 * a 30% swing was routine here. Interleaving spreads it across all of them.
 */
for (let rep = 0; rep < REPS; rep++) {
  for (const r of rows) {
    for (const label of Object.keys(r.runs)) {
      if (r.name.endsWith('reference)') && rep >= 3) continue // it is 20x slower; three is plenty
      r.runs[label].ts.push(time1(r.runs[label].call))
    }
  }
}
for (const r of rows) {
  r.times = {}
  for (const [label, run] of Object.entries(r.runs)) r.times[label] = stats(run.ts)
}

const pad = (s, n) => String(s).padEnd(n)
const num = (v) => v.toFixed(1).padStart(8)
console.log()
console.log(
  pad('variant', 26) + pad('bytes', 8) + pad('err', 5) + CASES.map(([, , , , l]) => pad(l, 14)).join(''),
)
console.log('-'.repeat(26 + 8 + 5 + CASES.length * 14))
for (const r of rows) {
  console.log(
    pad(r.name, 26) +
      pad(r.size || '-', 8) +
      pad(r.worst > 1 ? `WRONG(${r.worst})` : r.worst, 5) +
      CASES.map(([, , , , l]) =>
        pad(r.times[l] ? num(r.times[l].best) + ' ' + num(r.times[l].median).trim() : '-', 14),
      ).join(''),
  )
}
console.log(`\nbest / median ms of ${REPS} interleaved reps`)
console.log('err = worst byte disagreement with the TS reference (must be <= 1);')
console.log('      on an "exact 2x" row, with the general kernel above it (must be 0)')
rmSync(scratch, { recursive: true, force: true })
