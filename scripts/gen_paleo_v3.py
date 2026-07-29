"""Plate-drift texture frames: modern plate shapes + per-era rigid transforms
(translation + rotation), interpolated over ~30 frames so the crossfade between
adjacent frames reads as continental drift. Terrain rendering as in v2.
Writes frames to public/textures/paleo/ and the keyframe list to
src/data/paleoFrames.json. Placeholder geography — refine transforms/shapes or
swap in real reconstructions later."""
import json
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H = 2048, 1024
FRAMES = 30

# ---------- plates: modern shapes (equirect lng/lat) ----------
PLATES = {
    'nam': [(-150, 62), (-100, 70), (-70, 58), (-55, 48), (-78, 32), (-102, 20), (-118, 32), (-135, 48)],
    'sam': [(-80, 10), (-62, 6), (-52, -4), (-48, -26), (-58, -46), (-72, -52), (-82, -30), (-84, -8)],
    'eur': [(-10, 54), (20, 68), (60, 72), (110, 70), (140, 62), (120, 40), (90, 32), (60, 28), (35, 32), (5, 40)],
    'afr': [(-16, 34), (10, 36), (34, 30), (50, 10), (42, -8), (34, -24), (18, -34), (-2, -32), (-14, -6)],
    'ind': [(66, 24), (78, 28), (88, 22), (80, 8), (70, 8)],
    'aus': [(114, -14), (132, -10), (152, -14), (154, -36), (134, -38), (116, -34)],
    'ant': [(-40, -72), (30, -70), (100, -68), (160, -72), (120, -82), (0, -84), (-90, -80)],
}

# ---------- per-era transforms (dlng, dlat, rotation°), keyed by Ma ----------
KEYS = {
    250: {'nam': (55, -8, -20), 'sam': (40, 4, -15), 'eur': (-25, -8, 10), 'afr': (10, 2, 0),
          'ind': (-15, -42, 5), 'aus': (-35, -30, -20), 'ant': (20, 18, 0)},
    150: {'nam': (35, -5, -12), 'sam': (30, 2, -10), 'eur': (-15, -5, 6), 'afr': (8, 1, 0),
          'ind': (-12, -34, 4), 'aus': (-28, -26, -15), 'ant': (14, 12, 0)},
    100: {'nam': (20, -3, -7), 'sam': (18, 0, -6), 'eur': (-8, -3, 3), 'afr': (5, 0, 0),
          'ind': (-8, -22, 2), 'aus': (-20, -18, -10), 'ant': (8, 7, 0)},
    65: {'nam': (12, -2, -4), 'sam': (8, 0, -3), 'eur': (-5, -2, 2), 'afr': (3, 0, 0),
         'ind': (-5, -12, 0), 'aus': (-14, -12, -6), 'ant': (4, 3, 0)},
    35: {'nam': (6, -1, -2), 'sam': (4, 0, -1), 'eur': (-2, -1, 1), 'afr': (1, 0, 0),
         'ind': (-2, -4, 0), 'aus': (-8, -6, -3), 'ant': (2, 1, 0)},
    20: {'nam': (3, 0, -1), 'sam': (2, 0, 0), 'eur': (-1, 0, 0), 'afr': (0, 0, 0),
         'ind': (-1, -1, 0), 'aus': (-4, -3, -1), 'ant': (1, 0, 0)},
    0: {p: (0, 0, 0) for p in PLATES},
}
KEY_TIMES = sorted(KEYS)  # ascending Ma: 0 ... 250


def transform_at(ma):
    """Piecewise-linear interpolation of each plate's transform at `ma` Ma."""
    ts = KEY_TIMES
    hi = next((t for t in ts if t >= ma), ts[-1])
    lo = max((t for t in ts if t <= ma), default=ts[0])
    f = 0 if hi == lo else (ma - lo) / (hi - lo)
    return {
        p: tuple(a + (b - a) * f for a, b in zip(KEYS[lo][p], KEYS[hi][p]))
        for p in PLATES
    }


def place(ring, dlng, dlat, rot):
    """Rigid move of a plate + latitude-dependent equirect stretch correction."""
    cx = sum(p[0] for p in ring) / len(ring)
    cy = sum(p[1] for p in ring) / len(ring)
    cr, sr = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    out = []
    for lng, lat in ring:
        x, y = lng - cx, lat - cy
        lng2 = cx + x * cr - y * sr + dlng
        lat2 = max(-89, min(89, cy + x * sr + y * cr + dlat))
        # shapes were drawn already-projected at modern latitude; correct the
        # equirect stretch for the latitude they moved to
        stretch = math.cos(math.radians(lat)) / max(0.12, math.cos(math.radians(lat2)))
        out.append((cx + dlng + (lng2 - cx - dlng) * min(stretch, 6), lat2))
    return out


# ---------- terrain rendering (v2 pipeline, shared noise across frames) ----------
def fractal_noise(octaves=9, persistence=0.55, seed=0, first_octave=0):
    r = np.random.default_rng(seed)
    out = np.zeros((H, W))
    amp, total = 1.0, 0.0
    for o in range(first_octave, octaves):
        gw, gh = 4 * 2**o, 2 * 2**o
        layer = Image.fromarray((r.random((gh, gw)) * 255).astype(np.uint8))
        layer = layer.resize((W, H), Image.BICUBIC)
        out += np.asarray(layer, dtype=float) / 255 * amp
        total += amp
        amp *= persistence
    return out / total


def blur(arr, radius):
    img = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(radius)), dtype=float) / 255


def ramp(t, stops):
    ts = [s[0] for s in stops]
    out = np.zeros((*t.shape, 3))
    for c in range(3):
        out[..., c] = np.interp(t, ts, [s[1][c] for s in stops])
    return out


def px(lng, lat):
    return ((lng + 180) / 360 * W, (90 - lat) / 180 * H)


# static world noise so terrain doesn't flicker between frames
coarse, fine = W / 80, W / 250
WX = (fractal_noise(6, seed=42) - 0.5) * coarse + (fractal_noise(10, 0.7, 47, 5) - 0.5) * fine
WY = (fractal_noise(6, seed=43) - 0.5) * coarse + (fractal_noise(10, 0.7, 48, 5) - 0.5) * fine
RIDGES = 1 - np.abs(fractal_noise(seed=44) * 2 - 1)
DETAIL = fractal_noise(seed=45)
DEPTH_N = fractal_noise(seed=46)
YS, XS = np.indices((H, W), dtype=float)
XI = ((XS + WX) % W).astype(int)
YI = np.clip(YS + WY, 0, H - 1).astype(int)

LAND_RAMP = [
    (0.00, (196, 178, 128)), (0.22, (110, 139, 78)), (0.45, (88, 110, 62)),
    (0.62, (139, 115, 84)), (0.80, (156, 152, 148)), (0.95, (232, 236, 240)),
]
OCEAN_RAMP = [
    (0.00, (10, 26, 58)), (0.45, (18, 44, 92)), (0.80, (52, 96, 148)), (1.00, (96, 148, 186)),
]


def render_frame(name, rings):
    mask_img = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(mask_img)
    for ring in rings:
        for shift in (-360, 0, 360):  # antimeridian-safe
            d.polygon([px(lng + shift, lat) for lng, lat in ring], fill=255)
    mask = np.asarray(mask_img, dtype=float) / 255
    land = mask[YI, XI] > 0.5

    interior = blur(land.astype(float), 60)
    interior /= max(interior.max(), 1e-6)
    elev = np.clip(0.85 * interior * (0.3 + 0.75 * RIDGES) + 0.12 * DETAIL, 0, 1)
    land_col = ramp(elev, LAND_RAMP)

    coast = blur(land.astype(float), 45)
    depth_t = np.clip(coast * 2.4 + 0.18 * DEPTH_N, 0, 1)
    ocean_col = ramp(depth_t, OCEAN_RAMP)

    gy, gx = np.gradient(blur(elev, 2) * 60)
    shade = np.clip(1.0 - 0.9 * (gx + gy), 0.62, 1.25)
    land_col *= shade[..., None]

    img = np.where(land[..., None], land_col, ocean_col)
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(
        f'public/textures/paleo/{name}', quality=82)


frames = []
for i, ma in enumerate(np.linspace(250, 1, FRAMES)):
    tf = transform_at(ma)
    rings = [place(PLATES[p], *tf[p]) for p in PLATES]
    name = f'pf{i:02d}.jpg'
    render_frame(name, rings)
    frames.append({'time': int(-ma * 1e6), 'file': name})
    print(f'{name} @ {ma:.0f} Ma')

with open('src/data/paleoFrames.json', 'w') as f:
    json.dump(frames, f, indent=2)
print('frame list written')
