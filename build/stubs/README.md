# Dead-dependency stubs

`three-globe` (pulled in by `globe.gl`) imports three subsystems at the top of its
bundle that this app never reaches:

| module | what it powers in three-globe | do we use it? |
| --- | --- | --- |
| `h3-js` | the **hex-bin** and **hexed-polygon** layers | no |
| `three/webgpu` | the WebGPU compute path for **tile/particle** layers | no — we render with WebGL2 |
| `three/tsl` | the shader-node language that path is written in | no |

(`three-render-objects`, also under globe.gl, imports `three/webgpu` too.)

ES imports are unconditional, so a bundler has to include all three even though
every call site sits inside a layer we never enable. Measured, they were **196 kB
brotli** of a 515 kB bundle — more than a third of the JavaScript, for code that
can never run:

```
main chunk, brotli   before 515,153   after 319,452   -195,701 (-38%)
main chunk, raw      before 2,260,920 after 1,366,122 -894,798 (-40%)
```

Marginal cost of putting one back (brotli, measured by un-aliasing it alone):
`h3-js` ~54 kB, `three/webgpu` + `three/tsl` ~125 kB together — un-aliasing
either one of that pair pulls in both, since the WebGPU renderer is written in
TSL.

`vite.config.ts` aliases the three module ids to the files here. Each export is a
throwing shim, so "we never call this" is checked at runtime instead of assumed:
if a future change *does* enable one of those layers, the failure is a named
error naming the alias to delete rather than a mystery `undefined is not a
function`.

**To re-enable one:** delete its entry from `resolve.alias` in `vite.config.ts`
(and, if nothing else needs it, the stub file). No app code changes.
