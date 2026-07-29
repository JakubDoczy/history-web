# Cloud Cover — Research & Plan

Status: v0.2 · 2026-07-29 — **outcome recorded, see §7**
Module: `src/clouds/` (self-contained; the globe consumes one interface)

## 1. Why the current implementation looks wrong

Two attempts (static noise texture, then structured noise + twin drifting decks) both
read as "a picture of clouds pasted on a ball". The reason is structural, not a
tuning problem:

| Real clouds seen from orbit | A textured shell |
|---|---|
| Have thickness — they break the silhouette at the limb | Limb stays a perfect circle |
| Self-shadow; sun-facing flanks are bright, away-flanks dark | Flat, uniformly lit |
| Catch sunlight *after* the ground below is dark | Terminator identical to ground |
| Turbulent, filamentary, constantly reorganising | Rigid pattern sliding around |

No amount of texture authoring fixes the first three, because they are consequences of
clouds being a **volume**, not a surface. And the fourth needs a field that *evolves*,
not one that translates.

So: two separate problems — **shape/evolution** (simulation) and **appearance**
(volumetric rendering). Treat them as separate layers with a clean boundary.

## 2. Research findings

**The industry-standard approach is Nubis** (Andrew Schneider, Guerrilla, SIGGRAPH
2015/2017/2023). Clouds are not meshes: they are a 3D density function built from
layered noise — a low-frequency Perlin–Worley mix defines the overall shape, and
higher-frequency Worley noise erodes the silhouette into wispy edges. A 2D *weather
map* controls coverage and cloud type per region, a height gradient blends cumulus /
stratus / cirrus profiles by altitude, and the renderer marches a ray through the
volume accumulating density and scattering. The original PS4 implementation rendered
an entire sky in about 2 ms.

**Raymarching is affordable if you cheat carefully.** Toft, Bowles & Zimmermann
(Studio Gobo) reduce step counts drastically by adding a randomly jittered offset per
pixel and applying temporal anti-aliasing to remove the resulting noise — visually
similar results at roughly 1/16 of the steps. This is what makes the technique viable
on a phone.

**Evolution is a standard GPU ping-pong simulation.** Semi-Lagrangian advection —
`f_new(x) = f_old(x − v·dt)` — with the field stored in two textures that alternate as
read/write targets each frame. Optional vorticity confinement re-amplifies the small
vortices that numerical viscosity smooths away.

**Real cloud data is freely available.** NASA's Global Imagery Browse Services (GIBS)
serve global full-resolution satellite imagery openly, in equirectangular EPSG:4326
among other projections, updated daily and typically available within a few hours of
observation, via WMTS/WMS with no API key. That makes a "real clouds, today" mode
possible — though it is only meaningful for the present, and this app spends most of
its time in the deep past.

Sources: guerrilla-games.com/read/nubis-authoring-real-time-volumetric-cloudscapes-with-the-decima-engine,
arxiv.org/pdf/1609.05344, nasa-gibs.github.io/gibs-api-docs, jamie-wong.com/2016/08/05/webgl-fluid-simulation.

## 3. Chosen architecture

Simulation and rendering split at a single interface: **the simulation owns a coverage
field; the renderer owns everything visual.**

```
src/clouds/
├── field.ts        # CPU reference simulation — pure, deterministic, unit-tested
├── wind.ts         # Earth's circulation belts + curl-noise turbulence
├── gpuField.ts     # same simulation, ping-pong FBOs (phase B)
├── cloudShell.ts   # volumetric raymarched shell (phase C)
├── shaders/        # GLSL: advection, cloud march
└── index.ts        # public interface — the only thing GlobeView imports
```

The public interface stays tiny, so any layer can be swapped without touching the app:

```ts
interface CloudSystem {
  update(dtSeconds: number): void
  setSun(dir: Vector3): void
  visible: boolean
  dispose(): void
}
```

### Why simulate rather than just use better noise

Earth's cloud pattern is not random — it is *structured by circulation*: a convective
band at the ITCZ, dry descending air in the subtropics, cyclones tracking eastward at
mid-latitudes on the polar front. A simulation that advects density through those wind
belts produces that structure for free, and keeps producing new arrangements of it, so
the planet never looks the same twice. That is the thing a static texture can never do.

### Why not just use NASA imagery

Kept as an optional mode, not the default: it is only correct for the present day, it
adds a network dependency and CORS risk, and the app is mostly a deep-time instrument.
Good for a "today" easter egg; wrong as the foundation.

## 4. Phased plan

**Phase A — Simulation core** *(CPU, headless, testable)*
Equirectangular scalar field advected by a wind field, with sources (ITCZ convection,
mid-latitude storm genesis) and sinks (subtropical subsidence, dissipation).
Pure TypeScript, deterministic given a seed, no WebGL. Unit tests: pure advection
transports in the wind direction, longitude wraps, mass conserves without sources,
density stays bounded, results are reproducible.
*Deliverable: an evolving coverage field, verifiable without a browser.*

**Phase B — GPU port**
Same maths in a fragment shader with ping-pong render targets so it runs at higher
resolution every frame. The CPU version stays as the correctness oracle: both must
agree within tolerance on identical inputs.

**Phase C — Volumetric shell**
Raymarch between two radii above the surface. Density = simulated coverage (the
weather map) × height gradient × Perlin–Worley detail noise. Lighting: Beer–Lambert
extinction along a short light march for self-shadowing, Henyey–Greenstein phase for
forward-scattered silver lining. Jittered start offsets + temporal blend to keep step
counts low on mobile. Quality tiers by device.

**Phase D — Polish and integration**
Clouds fade out in deep time (they are anachronistic detail at 250 Ma and hide the
plate drift). Wire to the existing sun direction and the settings toggle. Optional
GIBS "real clouds today" mode.

## 5. Risks

- **Mobile fill rate.** A full-screen raymarch on a phone is the main risk. Mitigation:
  half-resolution buffer, low step count with jitter + temporal blend, and a hard
  quality floor that falls back to the current textured shell.
- **WebGL2 availability** for float render targets in the ping-pong sim. Fallback: run
  the CPU sim at low resolution and upload, which is why Phase A is written first and
  kept.
- **Scope.** Phase C is the expensive one. Phases A and B are independently useful:
  even feeding the *existing* shell a simulated, evolving texture is a visible
  improvement over a rigid pattern.

## 6. Open questions

1. Should clouds persist across timeline scrubbing, or reseed per era?
2. Is a "weather" seeded by the current date (so today's globe matches today's sky)
   worth the GIBS dependency?
3. Do we ever want clouds to cast shadows on the surface? Cheap approximation exists
   (project coverage onto the day/night shader) — decide after Phase C.


## 7. Outcome

The volumetric shell (phase C) was built and rejected: at globe scale the slab has to
be exaggerated to hundreds of kilometres thick before raymarching shows anything, and
that thickness is exactly what makes it look wrong. Real clouds are ~10 km deep against
a 6371 km radius — from orbit they are a *film*, not a volume.

**Shipped instead:** a thin lit shell at 1.003 R using a satellite-derived coverage
mask, with the surface picking up cloud shadows offset along the sun ray. The fine
filament structure that procedural noise never achieved comes free, because the mask
is made from photographs. Lighting is ours: terminator matched to the ground shader,
warm band at sunrise/sunset, near-transparent night side.

Phases A/B (the coverage simulation) are **parked, not deleted** — `src/clouds/field.ts`
and `wind.ts` remain tested and exported, and could later modulate coverage over time
or drive weather for non-present eras. They are not in the render path.

Retired: `cloudShell.ts`, `noise3d.ts`, `shaders/cloud.glsl.ts`, `scripts/gen_clouds.py`.
