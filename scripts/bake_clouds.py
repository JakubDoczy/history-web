#!/usr/bin/env python3
"""
Bake a cloud normal + occlusion map from the coverage mask.

Why offline
-----------
The film used to model its own relief at runtime, by differencing the coverage
mask toward the sun and reading the result as a slope. That is two extra taps
per fragment for a cue that is weak by construction: the mask is a smooth
composite, its gradient is tiny, and a difference taken along *one* direction
carries no shape at all across it — so a cloud only ever showed a light and a
dark side, never a form. Baking the answer costs one tap, gives a real surface
normal in both axes at once, and can afford work no frame budget would stand: a
three-octave blur pyramid and a 64-sample horizon-scan occlusion over 8
megapixels, about 40 seconds here and zero on the client.

What comes out
--------------
One RGB image, sampled with exactly the same UV as the coverage mask:

  R, G  the heightfield's gradient in *texture* space, (dH/du, dH/dv), signed,
        centred on 0.5 and scaled so GRADIENT_SCALE is full deflection
  B     sky visibility, 1 = open sky above, lower in the creases between towers
        and in the low ground between cells

Coverage stays where it is, in clouds.jpg. That is not laziness: it is the only
high-frequency channel in the layer — it draws the silhouette — and it has a
runtime Lanczos upscale (lib/cloudUpscale.ts) and an R8 upload path built around
it being one channel. Packing all four into one RGBA map would either cost that
upscale or quadruple a 33 MB texture to 134 MB. Everything baked here is
low-frequency by construction (a blur pyramid and a difference of blurs), which
is also why this map ships at a quarter of the mask's resolution and still has
nothing to lose: at 1024x512 the finest octave sits right at Nyquist.

Conventions worth stating, because both are silently plausible when wrong:

 * Texture space, not tangent space. Equirectangular UV is anisotropic — one
   texel of u is cos(latitude) times the arc of one texel of v — so resolving
   the normal here would bake a latitude into every texel. The shader already
   carries a `cosLat` for the sun step and divides there, for free.
 * three's TextureLoader uploads with flipY on, so image row 0 is v = 1, the
   north pole. dH/dv is therefore *minus* the row derivative. Reversed, every
   cloud on the planet is lit from the south, which looks entirely convincing in
   a still.

Re-run with:  python3 scripts/bake_clouds.py
"""
from __future__ import annotations

import os
import sys
import time

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'public', 'textures', 'clouds.jpg')
OUT = os.path.join(ROOT, 'public', 'textures', 'clouds-nrm.webp')

# Output size, a quarter of the mask in each axis. See the note above: nothing
# in this map has detail finer than the smallest octave of the pyramid, which at
# this size lands at 0.75 texels of sigma. Measured, the full-resolution version
# of this file is 1.8 MB against 651 KB, for octaves that are not in the data.
OUT_W, OUT_H = 1024, 512

# The heightfield: a blur pyramid over the coverage mask.
#
# Coverage doubles as a height proxy because the asset is a composite rather
# than a segmentation — more cloud in a texel means more cloud *above* it. But
# coverage alone is a plateau with cliffs at its edges, and a plateau has no
# shading across the middle, which is exactly the painted-on look being fixed
# here. Summing progressively blurred copies turns each mass into a dome: the
# widest octave puts the crown of a continental cloud system at its centre, the
# narrowest keeps the individual cells legible on its flanks.
#
# Sigmas are in source texels; the mask is 4096x2048, so a texel is ~0.09° and
# sigma 24 is ~240 km, about the width of a real convective cluster.
OCTAVES = ((3.0, 0.28), (9.0, 0.36), (24.0, 0.36))

# Full deflection of the encoded gradient, in height units per source texel.
#
# Set from the data rather than by taste: over the pixels the film actually
# shows (coverage > 0.15) the gradient's median is 0.0046 and its 99th
# percentile is 0.032, so 0.035 spends the 8-bit range on the flanks that carry
# the shape and lets about 1% of the map clip. A tighter scale would quantise
# the median to single digits; a looser one wastes half the range on a tail.
GRADIENT_SCALE = 0.035

# How steep a full-deflection gradient is meant to render, as a tangent slope.
#
# This is the one number the shader and this script have to agree on, and it is
# why it is stated here rather than only there: the occlusion below is a
# *geometric* measurement of the same surface the shader is about to light, and
# an occlusion baked for a gentler or steeper relief than the one being shaded
# is worse than none — it darkens creases that the normals say are not there.
# Mirrored by CLOUD_DEPTH.normalRelief in src/lib/globeSurface.ts, and pinned by
# tests/shader.test.ts.
SHADER_RELIEF = 1.0

# The occlusion scan: directions, and how far along each to look, in output
# texels. Eight directions is where the banding stops being visible on a soft
# multiplier like this one; 26 texels is ~9°, past which a horizon on a cloud
# deck is the planet's own curvature rather than the weather.
AO_DIRS = ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1))
AO_RADII = (1, 2, 3, 5, 8, 12, 18, 26)


def blur(a: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur that knows the map wraps in longitude and does not in latitude."""
    return gaussian_filter(a, sigma, mode=['nearest', 'wrap'])


def heightfield(cover: np.ndarray) -> np.ndarray:
    h = np.zeros_like(cover)
    for sigma, weight in OCTAVES:
        h += weight * blur(cover, sigma)
    return h / sum(w for _, w in OCTAVES)


def gradients(h: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Central differences per source texel, in (u, v). See the flipY note above."""
    du = 0.5 * (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1))
    dv = -0.5 * (np.vstack([h[1:], h[-1:]]) - np.vstack([h[:1], h[:-1]]))
    return du, dv


def occlusion(h: np.ndarray, slopeScale: float) -> np.ndarray:
    """
    Sky visibility, by horizon scan.

    For each of eight directions, walk outward and keep the steepest rise seen;
    sin(atan(slope)) of that is the fraction of that direction's sky the deck
    has taken away. Averaged over the directions it is an ambient occlusion in
    the only sense that matters here — how much of the dome above a point is
    still sky — and unlike a cavity map (blur minus self, which is what the
    first draft of this used) it does not mistake the outer fringe of a cloud
    for a crevice: a fringe is *below* its neighbourhood but nothing stands over
    it, and the scan can tell the difference.
    """
    occ = np.zeros_like(h)
    for dy, dx in AO_DIRS:
        length = np.hypot(dy, dx)
        best = np.zeros_like(h)
        for s in AO_RADII:
            step = np.roll(np.roll(h, -dx * s, axis=1), -dy * s, axis=0)
            np.maximum(best, (step - h) * slopeScale / (s * length), out=best)
        occ += best / np.sqrt(1.0 + best * best)
    return np.clip(1.0 - occ / len(AO_DIRS), 0.0, 1.0)


def box_down(a: np.ndarray, w: int, h: int) -> np.ndarray:
    """Exact area average; the source has to be an integer multiple of the target."""
    sy, sx = a.shape[0] // h, a.shape[1] // w
    if a.shape != (h * sy, w * sx):
        raise SystemExit(f'source {a.shape} is not an integer multiple of {(h, w)}')
    return a.reshape(h, sy, w, sx).mean(axis=(1, 3))


def main() -> None:
    t0 = time.time()
    cover = np.asarray(Image.open(SRC).convert('L'), dtype=np.float32) / 255.0
    src_h, src_w = cover.shape
    ratio = src_w / OUT_W
    h = heightfield(cover)
    du, dv = gradients(h)

    visible = cover > 0.15  # where the film is opaque enough to show any of this
    mag = np.concatenate([np.abs(du)[visible], np.abs(dv)[visible]])
    pct = np.percentile(mag, [50, 90, 99, 99.9])
    print(f'source {src_w}x{src_h} -> {OUT_W}x{OUT_H}')
    print('  |gradient| over visible cloud, p50/p90/p99/p99.9: '
          + ' '.join(f'{p:.5f}' for p in pct))
    print(f'  scale {GRADIENT_SCALE}: {100 * float((mag > GRADIENT_SCALE).mean()):.2f}% clips')

    # The occlusion runs on the output grid, and its slope scale is derived from
    # the two constants the shader uses, so the geometry it measures is the
    # geometry that will be lit: a full-deflection gradient is SHADER_RELIEF of
    # slope, and one output texel is `ratio` source texels wide.
    height = box_down(h, OUT_W, OUT_H)
    ao = occlusion(height, SHADER_RELIEF / (GRADIENT_SCALE * ratio))
    lit = box_down(cover, OUT_W, OUT_H) > 0.15
    print(f'  sky visibility over cloud: mean {ao[lit].mean():.3f} '
          f'p5 {np.percentile(ao[lit], 5):.3f} min {ao.min():.3f}')

    # The gradient is per source texel; an output texel is `ratio` of them wide,
    # so both the value and its full scale grow by the same factor and the
    # encoded number is unchanged. Written out rather than cancelled so that
    # changing OUT_W cannot silently rescale the relief.
    du, dv = box_down(du, OUT_W, OUT_H) * ratio, box_down(dv, OUT_W, OUT_H) * ratio
    full = GRADIENT_SCALE * ratio
    enc = lambda g: np.clip(0.5 + 0.5 * g / full, 0.0, 1.0)

    rgb = np.stack([enc(du), enc(dv), ao], axis=-1)
    img = Image.fromarray(np.round(rgb * 255).astype(np.uint8), 'RGB')
    # Lossless, and not negotiable: lossy WebP encodes YUV 4:2:0, and the two
    # gradient channels land in the chroma planes it halves. Measured at q95 the
    # decoded gradient is off by up to 5.5% of full scale, against a *median*
    # signal of 13% — a normal map through chroma subsampling comes back as
    # blocky lighting.
    img.save(OUT, lossless=True, quality=100, method=6)
    print(f'wrote {OUT}  {os.path.getsize(OUT) / 1024:.0f} KiB  in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    sys.exit(main())
