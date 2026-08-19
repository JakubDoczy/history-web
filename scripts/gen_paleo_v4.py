"""Deep-time globe textures from real paleogeographic reconstructions.

SOURCE
------
PALEOMAP PaleoDEMs (Scotese, C.R. & Wright, N.M., 2018): 109 digital elevation
models of the Earth's surface from 0-541 Ma, reconstructed with the PALEOMAP
plate model. Zenodo DOI 10.5281/zenodo.5460860.

LICENSE: Creative Commons Attribution 4.0 International (CC BY 4.0).
ATTRIBUTION (shipped in the app's imagery credit line and textures/CREDITS.md):
    "Paleogeography: PALEOMAP PaleoDEMs — Scotese & Wright (2018), CC BY 4.0"

MIRROR
------
zenodo.org and earthbyte.org are both unreachable from the build sandbox, so the
DEMs are pulled from a GitHub mirror that redistributes the same CC BY data:

    https://github.com/afnleaf/paleomap3D

  * rs/wasm_modules/assets/big1deg.br
        brotli-compressed little-endian int16 elevations in metres, 109 maps
        concatenated, each 181x361 (lat -90..90, lon -180..180, node-registered,
        lat ascending). This is the 1-degree PaleoDEM, values unaltered.
  * rs/wasm_modules/__assets/earth_s/texture{N}.png
        the 6-arcminute PaleoDEM rendered to a 13-step elevation *class* image at
        3601x1801 — one pixel per DEM node, so no detail is lost. (The repo's
        earth_l/ is the same data drawn at 2x, and is missing three of the 109
        maps; earth_s has them all.) Elevation survives as the class it fell in,
        which is coarse vertically but keeps the full horizontal detail — the
        coastline, which is the class boundary at 0 m, is exact to ~0.1 degrees.

We use both: the 1-degree grid supplies true continuous elevation, the class
image supplies the detail and the sharp coastline. Frame N of the mirror is
SOURCE_AGES[N-1] Ma.

WHAT THIS RENDERS
-----------------
Per frame, at 2048x1024 (the size the surface shader wants):
  * hypsometric land tint, aridity-shifted by latitude belt + continentality, so
    Pangaea's interior reads as the desert it was and the tropics read wet
  * hillshade from the reconstructed elevation, so real orogens (the Central
    Pangaean Mountains at the Variscan suture, the Urals, later the Himalaya)
    are lit rather than invented
  * shallow shelf / epicontinental sea distinct from deep ocean, straight from
    the DEM's own bathymetry
  * ice caps where the reconstruction's paleolatitude and the age's climate
    state put them: Hirnantian and Late Paleozoic ice over south-polar Gondwana,
    none through the Mesozoic greenhouse, Antarctic ice from ~34 Ma (ICE_LIMITS)

Re-run from the repo root:  pip install numpy pillow brotli
                            python3 scripts/gen_paleo_v4.py
Downloads are cached in scripts/.cache/paleo/ (gitignored); pass --no-cache to
refetch. Writes public/textures/paleo/*.webp and src/data/paleoFrames.json.
Roughly 5 MB of source data in, 3.5 MB of frames out, a couple of minutes.

WebP, not JPEG: at quality 85 these come out within 0.2 dB PSNR of the JPEG 82
they replaced — measured against this renderer's own output, so the comparison is
against the truth rather than against another encode — and 36-47% smaller. The
browser floor here is WebGL2, which every WebP decoder predates.
"""

import argparse
import json
import os
import sys
import urllib.request

import numpy as np
from PIL import Image

W, H = 2048, 1024
MIRROR = 'https://raw.githubusercontent.com/afnleaf/paleomap3D/HEAD/'
DEM_PATH = 'rs/wasm_modules/assets/big1deg.br'
TEX_PATH = 'rs/wasm_modules/__assets/earth_s/texture{n}.png'
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache', 'paleo')
OUT_DIR = 'public/textures/paleo'
FRAMES_JSON = 'src/data/paleoFrames.json'

# Ages of the 109 PaleoDEM maps, in Ma, in mirror file order (texture1 = 0 Ma).
SOURCE_AGES = [
    0, 4.47, 10.5, 14.9, 19.5, 25.6, 31.0, 35.9, 39.5, 44.5, 51.9, 56.0, 61.0,
    66.0, 69.0, 75.0, 80.8, 86.7, 91.9, 97.2, 102.6, 107.0, 111.0, 115.8, 121.8,
    127.2, 131.2, 136.4, 142.4, 145.0, 148.6, 154.7, 160.4, 164.8, 168.2, 172.2,
    178.4, 186.8, 190.8, 196.0, 201.3, 204.9, 213.2, 217.8, 222.4, 227.0, 232.0,
    233.6, 239.5, 244.6, 252.0, 256.0, 262.5, 265.1, 268.7, 275.0, 280.0, 286.8,
    292.6, 297.0, 301.3, 305.4, 311.1, 314.6, 319.2, 327.0, 330.9, 333.0, 338.8,
    344.0, 349.0, 354.0, 358.9, 365.6, 370.0, 375.0, 380.0, 385.2, 390.5, 395.0,
    400.0, 405.0, 409.2, 415.0, 421.1, 425.2, 430.4, 436.0, 441.2, 444.5, 449.1,
    455.7, 460.0, 465.0, 470.0, 475.0, 481.6, 485.4, 491.8, 495.5, 498.8, 505.0,
    510.0, 515.0, 520.0, 525.0, 530.0, 535.0, 541.0,
]

# The frames we ship. Every entry must be one of SOURCE_AGES — a frame time that
# is not a reconstruction age would be an interpolation we never computed. Spaced
# ~15-20 Myr, tightened where the map changes fast (Pangaea assembly, the
# breakup, the Cenozoic) and snapped to period boundaries people scrub to (541,
# 252, 145, 66).
#
# THREE SOURCE MAPS ARE AVOIDED: 239.5, 201.3 and 178.4 Ma. In each, the band
# the neighbouring maps store just BELOW sea level (the -50..0 m epicontinental
# shelf) is stored one 40 m quantum ABOVE it, so the map's shallow seas render
# as a plain of low land: at 239.5 Ma the shallow-sea band is 0.7% of the globe
# against ~6% in the maps 5 Myr either side, and the misplaced band sits at
# exactly +40 m. Crossfaded in a timeline, that is a continent's worth of sea
# flooding out and back within one frame — the "weird discontinuity around
# 200 Ma" a reader saw. Ocean depths in those maps match their neighbours, so
# it is not a whole-map datum shift that could be subtracted out; the maps are
# simply skipped for their nearest clean neighbour (239.5 → 233.6, and
# 178.4 → 172.2; 201.3 was never shipped).
AGES = [
    541.0, 515.0, 491.8, 470.0, 449.1, 430.4, 409.2, 390.5, 370.0, 358.9,
    338.8, 319.2, 301.3, 286.8, 268.7, 252.0, 233.6, 222.4, 204.9, 190.8,
    172.2, 164.8, 154.7, 145.0, 131.2, 115.8, 102.6, 91.9, 80.8, 69.0,
    66.0, 56.0, 44.5, 35.9, 25.6, 14.9, 4.47, 0.0,
]

# The 13 colours the mirror's class images use, and the elevation range each one
# means (metres). Two of the deep-ocean colours drifted by one unit between the
# mirror's renders, so classification is nearest-colour rather than exact match.
CLASS_COLOR = np.array([
    (8, 14, 48), (31, 45, 71), (42, 60, 99), (52, 75, 117), (87, 120, 179),
    (79, 166, 66), (52, 122, 42), (0, 83, 11), (61, 55, 4), (128, 84, 17),
    (151, 122, 68), (182, 181, 181), (238, 238, 238),
], dtype=np.float32)
CLASS_RANGE = [
    (-13000, -6000), (-6000, -3000), (-3000, -150), (-150, -50), (-50, 0),
    (0, 75), (75, 150), (150, 400), (400, 1000), (1000, 2000), (2000, 3200),
    (3200, 5000), (5000, 10500),
]
CLASS_MID = np.array([(a + b) / 2 for a, b in CLASS_RANGE], dtype=np.float32)
LAND_CLASS = 5      # first class above sea level
SHELF_CLASS = 3     # classes 3..4 are the -150..0 m shelf

# Equatorward limit of continental ice, in degrees of paleolatitude, per
# hemisphere: 90 means no ice cap. Interpolated between the listed ages.
# Hirnantian Gondwana ice (~445 Ma), the Late Paleozoic Ice Age peaking ~330-300
# Ma, a Mesozoic-early Cenozoic greenhouse with no polar caps, Antarctic
# glaciation from the Eocene-Oligocene transition, northern ice only in the
# Quaternary. (Scotese's Paleoclimate Atlas; Montanez & Poulsen 2013 for the
# LPIA; Zachos et al. 2001 for the Cenozoic.)
ICE_LIMITS = [
    # age Ma, south limit, north limit
    (541.0, 90, 90),
    (460.0, 90, 90),
    (449.1, 72, 90),
    (444.5, 60, 90),
    (436.0, 78, 90),
    (425.0, 90, 90),
    (375.0, 90, 90),
    (358.9, 76, 90),
    (344.0, 66, 90),
    (330.9, 58, 90),
    (301.3, 56, 90),
    (286.8, 64, 90),
    (268.7, 76, 90),
    (256.0, 90, 90),
    (44.5, 90, 90),
    (35.9, 80, 90),
    (25.6, 74, 90),
    (14.9, 70, 90),
    (4.47, 68, 90),
    (0.0, 66, 72),
]

# Greenhouse offset applied to the mountain snowline (metres): high when the
# planet was hot, negative in the icehouses. Same intervals as ICE_LIMITS.
SNOWLINE_OFFSET = [
    (541.0, 900), (449.1, 300), (444.5, -300), (420.0, 700), (358.9, 100),
    (330.9, -400), (301.3, -400), (268.7, 0), (252.0, 700), (200.0, 1000),
    (90.0, 1100), (56.0, 1200), (35.9, 400), (14.9, 0), (0.0, 0),
]

# Tuned against public/textures/base/earth-blue-marble.webp at 0 Ma: the paleo
# frames crossfade into that image, so their palette has to be its neighbour.
# These sit low on purpose: the globe's "enhanced" visuals lift midtones and
# push chroma (see the grade in lib/globeSurface.ts), and a ramp that already
# reads right flat comes out of it bleached.
LAND_RAMP = [
    (-50, (40, 68, 38)), (0, (45, 73, 40)), (150, (57, 84, 44)),
    (400, (80, 94, 50)), (900, (108, 106, 64)), (1800, (122, 106, 75)),
    (3000, (117, 101, 89)), (4200, (160, 158, 154)), (5400, (238, 242, 244)),
]
ARID_RAMP = [
    (-50, (127, 110, 78)), (0, (136, 118, 84)), (150, (153, 134, 97)),
    (400, (162, 141, 101)), (900, (158, 134, 94)), (1800, (150, 120, 82)),
    (3000, (137, 111, 90)), (4200, (164, 160, 154)), (5400, (238, 242, 244)),
]
OCEAN_RAMP = [
    (-9000, (7, 21, 52)), (-5000, (9, 27, 64)), (-3000, (12, 34, 76)),
    (-1200, (17, 45, 92)), (-400, (24, 60, 112)), (-150, (36, 84, 138)),
    (-50, (58, 112, 164)), (0, (80, 136, 182)),
]
ICE_COLOR = np.array([238, 242, 246], dtype=np.float32)
SEA_ICE_COLOR = np.array([208, 220, 230], dtype=np.float32)


def fetch(rel, name, use_cache=True):
    """Mirror file -> local path, cached between runs."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if use_cache and os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    url = MIRROR + rel
    print(f'  fetch {url}')
    with urllib.request.urlopen(url, timeout=120) as r, open(path, 'wb') as f:
        f.write(r.read())
    return path


def load_dem(use_cache=True):
    """All 109 one-degree PaleoDEMs as (109, 181, 361) metres, north-up."""
    import brotli  # only needed for the source data, not for rendering

    raw = brotli.decompress(open(fetch(DEM_PATH, 'big1deg.br', use_cache), 'rb').read())
    dem = np.frombuffer(raw, dtype='<i2').reshape(-1, 181, 361).astype(np.float32)
    if len(dem) != len(SOURCE_AGES):
        raise SystemExit(f'mirror has {len(dem)} maps, expected {len(SOURCE_AGES)}')
    # lat is ascending in the source; the pole row itself is filled with zeros.
    dem = dem[:, ::-1, :]
    dem[:, 0, :] = dem[:, 1, :]
    dem[:, -1, :] = dem[:, -2, :]
    return dem


def load_classes(n, use_cache=True):
    """Class index per pixel of the 6-arcminute render (7200x3600 uint8)."""
    path = fetch(TEX_PATH.format(n=n), f'texture{n}.png', use_cache)
    rgb = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    # nearest of 13 colours, done as one broadcast per colour to stay in memory
    best = np.full(rgb.shape[:2], 1e18, dtype=np.float32)
    idx = np.zeros(rgb.shape[:2], dtype=np.uint8)
    for i, c in enumerate(CLASS_COLOR):
        d = ((rgb - c) ** 2).sum(-1)
        hit = d < best
        best = np.where(hit, d, best)
        idx = np.where(hit, np.uint8(i), idx)
    # The source's own polar rows are degenerate: every longitude at |lat| > 89.5
    # carries the pole's single value, which is stored as 0 m and so classifies
    # as shallow sea. Left alone it paints a blue ring over polar Gondwana and
    # over Antarctica. Extend the last honest row instead.
    edge = max(2, round(idx.shape[0] / 240))  # ~0.75 degrees
    idx[:edge] = idx[edge]
    idx[-edge:] = idx[-edge - 1]
    return idx


def resize_f(arr, w=W, h=H, mode=Image.BOX):
    return np.asarray(Image.fromarray(arr.astype(np.float32), 'F').resize((w, h), mode))


def _box(arr, r, axis):
    if r < 1:
        return arr
    if axis == 1:  # longitude wraps: the map's left edge really does touch its right
        pad = np.concatenate([arr[:, -r:], arr, arr[:, :r + 1]], axis=1)
    else:
        pad = np.concatenate([arr[:1].repeat(r, 0), arr, arr[-1:].repeat(r + 1, 0)], axis=0)
    c = np.cumsum(pad, axis=axis, dtype=np.float32)
    n = arr.shape[axis]
    if axis == 1:
        return (c[:, 2 * r + 1:2 * r + 1 + n] - c[:, :n]) / (2 * r + 1)
    return (c[2 * r + 1:2 * r + 1 + n] - c[:n]) / (2 * r + 1)


def blur(arr, sigma):
    """Gaussian-ish blur: three box passes, longitude wrapped. PIL's own blur
    cannot take a float image, and everything here is metres, not bytes."""
    r = max(int(round(sigma * 1.2)), 0)
    out = arr.astype(np.float32)
    for _ in range(3):
        out = _box(_box(out, r, 1), r, 0)
    return out


def ramp(t, stops):
    xs = [s[0] for s in stops]
    out = np.empty((*t.shape, 3), dtype=np.float32)
    for c in range(3):
        out[..., c] = np.interp(t, xs, [s[1][c] for s in stops])
    return out


def lerp_table(table, age):
    """Linear interpolation over a table of (age, *values), any age order."""
    rows = sorted(table, key=lambda r: r[0])
    ages = [r[0] for r in rows]
    return [np.interp(age, ages, [r[i] for r in rows]) for i in range(1, len(rows[0]))]


LAT = (90 - (np.arange(H, dtype=np.float32) + 0.5) * 180 / H)[:, None]
ABSLAT = np.abs(LAT)


def elevation(dem_slice, cls):
    """True elevation at 2048x1024: 1-degree values carry the level, the
    6-arcminute classes carry the detail (they only know their own band, so only
    their departure from a 1-degree-wide blur of themselves is used)."""
    lo = resize_f(dem_slice, mode=Image.BICUBIC)
    hi = resize_f(CLASS_MID[cls])
    return blur(lo + (hi - blur(hi, 6.0)) * 0.75, 1.0)


LON = ((np.arange(W, dtype=np.float32) + 0.5) * 360 / W - 180)[None, :]

# Ice sheets are not zones of latitude. A few harmonics of longitude push the
# margin around by a few degrees so the cap has a coastline-ish outline instead
# of a ruled line across the map.
ICE_WOBBLE = sum(
    a * np.sin(np.radians(LON * k + p)) for k, a, p in
    [(1, 2.4, 40), (2, 1.7, 200), (3, 1.1, 95), (5, 0.7, 310)]
)


def refine(mask):
    """Round the source's staircase without moving the coast.

    The deep-time DEMs are drawn coarsely — whole degrees in places — and a
    mask off them staircases visibly at 2048 wide; a straight blur (what this
    used to be) softens the steps but keeps every corner, which photographed as
    blocky terraces along the Tethys shelf. Blur wide instead, pull the 0.5
    level set back out, and anti-alias that: the level set of a symmetric blur
    runs through the middle of each step, so the corners become curves while
    the coast stays where the data put it. The restore slope (x3) is gentle on
    purpose — a hard threshold would drop islets smaller than the blur radius,
    and the Panthalassic arcs are made of exactly those.
    """
    m = blur(mask, 2.2)
    m = np.clip((m - 0.5) * 3.0 + 0.5, 0, 1)
    return np.clip(blur(m, 1.0), 0, 1)


def masks(cls):
    """Land and shelf coverage at output size, staircase rounded.

    Cumulative masks, differenced — refining the shelf BAND directly would
    erase it wherever it is narrower than the smoothing radius, and the whole
    point of the shelf is that it hugs the coast.
    """
    land = refine(np.clip(resize_f((cls >= LAND_CLASS).astype(np.float32)), 0, 1))
    wet = refine(np.clip(resize_f((cls >= SHELF_CLASS).astype(np.float32)), 0, 1))
    return land, np.clip(wet - land, 0, 1)


def render(age, dem_slice, cls):
    land, shelf = masks(cls)
    elev = elevation(dem_slice, cls)

    # --- climate: how dry is this pixel ---------------------------------------
    # Subtropical high belts near 25 degrees, wet tropics, and continentality --
    # the further from any ocean, the drier. Pangaea is the extreme case and the
    # reason its interior should not be painted green.
    belt = np.exp(-(((ABSLAT - 25.0) / 13.0) ** 2))
    wet_tropics = np.exp(-((LAT / 12.0) ** 2))
    # ~1000 km of smoothing: how far from open ocean this pixel sits, which is
    # the whole reason a supercontinent's middle is a desert.
    inland = np.clip(blur(land, 52.0), 0, 1)
    inland = np.clip((inland - 0.42) / 0.5, 0, 1)
    # capped below 1: even the driest interior keeps some of the hypsometric
    # green under it, so a continent the size of Pangaea is not one flat wash
    arid = np.clip((0.50 * belt + 0.70 * inland) * (1 - 0.75 * wet_tropics) - 0.16, 0, 0.85)
    arid *= np.clip(1.25 - ABSLAT / 55.0, 0, 1)  # no hot deserts at the poles
    arid = np.clip(arid, 0, 1)

    land_col = ramp(elev, LAND_RAMP) * (1 - arid[..., None]) + ramp(elev, ARID_RAMP) * arid[..., None]
    ocean_col = ramp(np.minimum(elev, 0), OCEAN_RAMP)
    ocean_col += (np.array([16, 26, 30], dtype=np.float32) * shelf[..., None])  # brighten the shelf

    # --- relief ---------------------------------------------------------------
    # Baked in, because the shader's own relief map is the *modern* height field
    # and is faded out over deep time (see modernShare in src/lib/paleo.ts).
    gy, gx = np.gradient(blur(elev, 1.2))
    # A degree of longitude shrinks towards the poles; without the cosine the
    # last few rows would be all gradient and the caps would strobe.
    gx = gx / np.maximum(np.cos(np.radians(LAT)), 0.35)
    slope = (gx * 0.55 - gy * 0.55) / 190.0        # sun from the north-west
    slope *= np.clip((88.0 - ABSLAT) / 4.0, 0, 1)
    land_col *= np.clip(1.0 + slope, 0.55, 1.45)[..., None]
    ocean_col *= np.clip(1.0 + slope * 0.35, 0.85, 1.15)[..., None]

    # --- ice ------------------------------------------------------------------
    # Shading is already applied: ice goes on top with a much flatter light of
    # its own, or every terrace in the source DEM shows through the ice sheet as
    # a dark streak.
    south_lim, north_lim = lerp_table(ICE_LIMITS, age)
    (snow_off,) = lerp_table(SNOWLINE_OFFSET, age)
    limit = np.where(LAT < 0, south_lim, north_lim) + ICE_WOBBLE
    # Ice sheets grow off the highlands first, so height buys latitude.
    reach = ABSLAT + np.clip(elev, 0, 3000) / 900.0
    polar = np.clip((reach - limit) / 6.0, 0, 1)
    snowline = 5300 - 5100 * (ABSLAT / 90.0) ** 1.6 + snow_off
    alpine = np.clip((elev - snowline) / 700.0, 0, 1)
    ice = np.maximum(polar, alpine)
    ice_light = np.clip(1.0 + slope * 0.15, 0.95, 1.06)[..., None]
    land_col = land_col * (1 - ice[..., None]) + ICE_COLOR * ice_light * ice[..., None]

    sea_ice = np.clip((ABSLAT - (limit + 5)) / 8.0, 0, 1) * 0.9
    ocean_col = ocean_col * (1 - sea_ice[..., None]) + SEA_ICE_COLOR * sea_ice[..., None]

    img = ocean_col * (1 - land[..., None]) + land_col * land[..., None]

    # Every pixel of the top and bottom rows is the same point on the globe;
    # leaving them different makes a spinning pinwheel at each pole.
    w = np.clip((ABSLAT - 86.0) / 4.0, 0, 1)
    img = img * (1 - w[..., None]) + img.mean(axis=1, keepdims=True) * w[..., None]
    return np.clip(img, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# The DRAWN twin of each frame: the same reconstruction printed in the drawn
# map's own palette (src/lib/drawnTile.ts, PAPER), so that map mode's deep time
# is a page of the same atlas rather than a photograph run through a duotone —
# which is what the shader's paper grade made of these, and it read as grey
# porridge: a paleo frame's land is midtone and its ocean is dark, so ink-by-
# luminance put sea and land within a few steps of each other. Here the sea is
# the duck-egg wash, the land is parchment, the shelf is the shoreline wash
# (driven by the real bathymetry), and the coast is the pen. Restated as
# literals because this file cannot import TypeScript; tests/drawnMap.test.ts
# guards the TS side and scripts/gen_paleo_v4.py is the only other holder.
D_SEA = np.array((177, 191, 187), np.float32)     # PAPER.ocean  #b1bfbb
D_WASH = np.array((154, 170, 166), np.float32)    # PAPER.wash[2] #9aaaa6
D_LAND = np.array((236, 226, 200), np.float32)    # PAPER.land   #ece2c8
D_INK = np.array((46, 37, 25), np.float32)        # PAPER.ink    #2e2519
D_HIGH = np.array((141, 125, 92), np.float32)     # PAPER.fleckDark #8d7d5c
D_ICE = np.array((247, 242, 230), np.float32)     # paper, a step toward white
D_GRAT = np.array((70, 56, 36), np.float32)       # PAPER.graticule (α 0.16)


def render_drawn(age, dem_slice, cls):
    """One deep-time frame as the drawn atlas would print it.

    Same masks and elevation as the photographic render, different medium:
      * open sea flat duck-egg; the shelf deepens toward the shoreline-wash
        tone by real bathymetry, which is the engraved coastal band the tiles
        draw — here it is the Sundaland-sized epicontinental seas that carry it
      * land is parchment, highlands tinted toward the paper's own dark fibre,
        relief as a whisper of the same — a drawing suggests mountains, it does
        not photograph them
      * ice is pale paper (the caps must survive, they are geography here)
      * a 10-degree graticule under the ink, same pen and alpha as the tiles
      * coastline ink from the mask's own transition band: the anti-aliased
        edge is ~2 px wide, and land*(1-land) peaks exactly on it
    """
    land, shelf = masks(cls)
    elev = elevation(dem_slice, cls)

    # --- the sea, and the wash where it shallows -----------------------------
    coast_t = np.clip((elev + 300.0) / 300.0, 0, 1) ** 1.4       # bathymetric
    coastal = np.clip(blur(land, 4.0) * 1.8, 0, 1)               # hugs the pen
    wash = np.maximum(coast_t, coastal * 0.7) * (1 - land)
    sea_col = D_SEA + (D_WASH - D_SEA) * wash[..., None]

    # --- the land ------------------------------------------------------------
    h = np.clip(elev / 3200.0, 0, 1) ** 1.3
    land_col = D_LAND + (D_HIGH - D_LAND) * (h * 0.5)[..., None]
    gy, gx = np.gradient(blur(elev, 1.2))
    gx = gx / np.maximum(np.cos(np.radians(LAT)), 0.35)
    slope = (gx * 0.55 - gy * 0.55) / 190.0
    slope *= np.clip((88.0 - ABSLAT) / 4.0, 0, 1)
    land_col *= np.clip(1.0 + slope * 0.35, 0.87, 1.08)[..., None]

    # --- ice, in paper -------------------------------------------------------
    south_lim, north_lim = lerp_table(ICE_LIMITS, age)
    (snow_off,) = lerp_table(SNOWLINE_OFFSET, age)
    limit = np.where(LAT < 0, south_lim, north_lim) + ICE_WOBBLE
    reach = ABSLAT + np.clip(elev, 0, 3000) / 900.0
    polar = np.clip((reach - limit) / 6.0, 0, 1)
    snowline = 5300 - 5100 * (ABSLAT / 90.0) ** 1.6 + snow_off
    alpine = np.clip((elev - snowline) / 700.0, 0, 1)
    ice = np.maximum(polar, alpine)
    land_col = land_col * (1 - ice[..., None]) + D_ICE * ice[..., None]

    img = sea_col * (1 - land[..., None]) + land_col * land[..., None]

    # --- graticule, under the ink --------------------------------------------
    # Same pen and alpha as the drawn tiles (PAPER.graticule at 0.16), one
    # output pixel wide. Faded at the poles, where meridians crowd.
    ppd_x, ppd_y = W / 360.0, H / 180.0
    dx = np.abs(((np.arange(W) + 0.5) / ppd_x + 5.0) % 10.0 - 5.0) * ppd_x
    dy = np.abs(((np.arange(H) + 0.5) / ppd_y + 5.0) % 10.0 - 5.0) * ppd_y
    ga = np.maximum(np.clip(1.0 - dx, 0, 1)[None, :] * np.clip((80.0 - ABSLAT) / 10.0, 0, 1),
                    np.clip(1.0 - dy, 0, 1)[:, None] * np.ones((1, W), np.float32)) * 0.16
    img = img * (1 - ga[..., None]) + D_GRAT * ga[..., None]

    # --- the pen -------------------------------------------------------------
    edge = np.clip(land * (1 - land) * 4.0, 0, 1) ** 1.5
    img = img * (1 - (edge * 0.85)[..., None]) + D_INK * (edge * 0.85)[..., None]

    w = np.clip((ABSLAT - 86.0) / 4.0, 0, 1)
    img = img * (1 - w[..., None]) + img.mean(axis=1, keepdims=True) * w[..., None]
    return np.clip(img, 0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-cache', action='store_true', help='refetch source data')
    ap.add_argument('--quality', type=int, default=85, help='WebP quality')
    ap.add_argument('--only', type=float, nargs='*', help='render just these ages (Ma)')
    args = ap.parse_args()

    if not os.path.isdir(OUT_DIR):
        raise SystemExit(f'run from the repo root: {OUT_DIR} not found')
    unknown = [a for a in AGES if a not in SOURCE_AGES]
    if unknown:
        raise SystemExit(f'not reconstruction ages: {unknown}')

    dem = load_dem(not args.no_cache)
    ages = sorted(AGES, reverse=True)  # oldest first, so frame order is time order
    if not args.only:
        for f in os.listdir(OUT_DIR):
            if f.startswith(('pf', 'pd')) and f.endswith(('.jpg', '.webp')):
                os.remove(os.path.join(OUT_DIR, f))

    frames, total = [], 0
    for i, age in enumerate(ages):
        n = SOURCE_AGES.index(age) + 1
        name = f'pf{i:02d}.webp'
        drawn_name = f'pd{i:02d}.webp'
        # 0 Ma is the present, but the frame list ends with the real modern
        # basemap pinned at 10 ka; giving the two the same time would divide by a
        # zero-length interval. Half a frame of slack, invisible at this scale.
        # round, not truncate: int(-131.2 * 1e6) lands a year short of the age
        year = -50_000 if age == 0 else round(-age * 1e6)
        frames.append({'time': year, 'file': name, 'drawn': drawn_name, 'ma': age})
        if args.only and age not in args.only:
            continue
        cls = load_classes(n, not args.no_cache)
        img = render(age, dem[n - 1], cls)
        path = os.path.join(OUT_DIR, name)
        # method=6 is libwebp's slowest search; it costs seconds per frame in a
        # script that is run by hand and saves ~4% on every download forever.
        Image.fromarray(img).save(path, format='WEBP', quality=args.quality, method=6)
        kb = os.path.getsize(path) / 1024
        # The drawn twin: three flat washes and a pen compress far better than a
        # photograph, and quality 80 is transparent on them — measured 46 dB
        # PSNR against its own render, where the photographic frame's q85 is 42.
        dimg = render_drawn(age, dem[n - 1], cls)
        dpath = os.path.join(OUT_DIR, drawn_name)
        Image.fromarray(dimg).save(dpath, format='WEBP', quality=80, method=6)
        dkb = os.path.getsize(dpath) / 1024
        total += kb + dkb
        print(f'{name}  {age:>6} Ma  (map {n:>3})  {kb:6.0f} KB  + drawn {dkb:5.0f} KB')

    if not args.only:
        with open(FRAMES_JSON, 'w') as f:
            json.dump([{k: fr[k] for k in ('time', 'ma', 'file', 'drawn')} for fr in frames], f, indent=2)
            f.write('\n')
    print(f'{len(ages)} frames, {total / 1024:.2f} MB total', file=sys.stderr)


if __name__ == '__main__':
    main()
