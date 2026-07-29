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
FRAMES = 40

# ---------- plates: modern shapes (equirect lng/lat), recognizable silhouettes ----------
PLATES = {
    'nam': [(-165, 65), (-155, 70), (-140, 70), (-125, 71), (-110, 72), (-95, 73), (-85, 72),
            (-75, 68), (-62, 60), (-65, 52), (-70, 45), (-75, 38), (-80, 31), (-86, 25),
            (-91, 18), (-96, 16), (-87, 12), (-83, 9), (-92, 13), (-101, 20), (-110, 26),
            (-118, 33), (-124, 41), (-127, 49), (-140, 58), (-155, 59)],
    'grl': [(-45, 60), (-52, 64), (-55, 68), (-52, 72), (-45, 77), (-35, 81), (-25, 80),
            (-20, 74), (-24, 68), (-32, 63), (-40, 60)],
    'sam': [(-78, 8), (-71, 12), (-63, 11), (-55, 6), (-48, 0), (-42, -5), (-38, -12),
            (-40, -20), (-48, -27), (-53, -34), (-58, -40), (-64, -47), (-70, -54),
            (-74, -51), (-72, -42), (-70, -32), (-70, -22), (-73, -14), (-79, -5), (-80, 3)],
    'eur': [(-9, 43), (-9, 51), (0, 58), (5, 61), (12, 62), (20, 70), (35, 68), (55, 73),
            (75, 73), (95, 76), (112, 74), (130, 72), (150, 70), (170, 66), (177, 63),
            (160, 60), (150, 54), (140, 47), (130, 42), (122, 34), (112, 24), (108, 16),
            (102, 9), (99, 14), (94, 21), (89, 25), (82, 28), (72, 31), (62, 27), (55, 26),
            (48, 30), (42, 37), (34, 38), (26, 37), (20, 40), (12, 40), (2, 42)],
    'afr': [(-17, 15), (-17, 22), (-12, 29), (-6, 35), (2, 37), (10, 37), (20, 33), (30, 32),
            (35, 27), (33, 22), (37, 17), (43, 12), (51, 12), (46, 4), (41, -3), (40, -12),
            (36, -19), (33, -27), (26, -34), (19, -35), (14, -29), (12, -18), (10, -8),
            (7, 0), (2, 5), (-5, 5), (-12, 8)],
    'ind': [(67, 24), (71, 30), (79, 32), (87, 28), (91, 23), (88, 21), (85, 15), (80, 8),
            (77, 7), (73, 14), (69, 20)],
    'aus': [(114, -22), (117, -15), (124, -12), (132, -11), (137, -14), (142, -11), (147, -16),
            (151, -24), (153, -30), (150, -37), (144, -39), (138, -36), (131, -32), (124, -33),
            (117, -32), (113, -27)],
    'ant': [(-60, -72), (-30, -70), (0, -69), (30, -68), (60, -67), (90, -67), (120, -68),
            (150, -70), (170, -73), (150, -80), (100, -83), (40, -85), (-20, -85), (-55, -82),
            (-70, -77)],
}

# ---------- per-era transforms (dlng, dlat, rotation°), keyed by Ma ----------
KEYS = {
    450: {'nam': (70, -30, -40), 'grl': (58, -26, -30), 'sam': (55, -15, -25),
          'eur': (-40, -25, 25), 'afr': (15, -25, 10), 'ind': (-20, -52, 10),
          'aus': (-45, -40, -30), 'ant': (25, 22, 0)},
    350: {'nam': (62, -18, -30), 'grl': (52, -16, -22), 'sam': (47, -6, -20),
          'eur': (-32, -16, 17), 'afr': (12, -12, 5), 'ind': (-17, -47, 7),
          'aus': (-40, -35, -25), 'ant': (22, 20, 0)},
    250: {'nam': (55, -8, -20), 'grl': (46, -7, -15), 'sam': (40, 4, -15),
          'eur': (-25, -8, 10), 'afr': (10, 2, 0), 'ind': (-15, -42, 5),
          'aus': (-35, -30, -20), 'ant': (20, 18, 0)},
    150: {'nam': (35, -5, -12), 'grl': (30, -4, -9), 'sam': (30, 2, -10),
          'eur': (-15, -5, 6), 'afr': (8, 1, 0), 'ind': (-12, -34, 4),
          'aus': (-28, -26, -15), 'ant': (14, 12, 0)},
    100: {'nam': (20, -3, -7), 'grl': (17, -2, -5), 'sam': (18, 0, -6),
          'eur': (-8, -3, 3), 'afr': (5, 0, 0), 'ind': (-8, -22, 2),
          'aus': (-20, -18, -10), 'ant': (8, 7, 0)},
    65: {'nam': (12, -2, -4), 'grl': (10, -1, -3), 'sam': (8, 0, -3),
         'eur': (-5, -2, 2), 'afr': (3, 0, 0), 'ind': (-5, -12, 0),
         'aus': (-14, -12, -6), 'ant': (4, 3, 0)},
    35: {'nam': (6, -1, -2), 'grl': (5, 0, -1), 'sam': (4, 0, -1),
         'eur': (-2, -1, 1), 'afr': (1, 0, 0), 'ind': (-2, -4, 0),
         'aus': (-8, -6, -3), 'ant': (2, 1, 0)},
    20: {'nam': (3, 0, -1), 'grl': (2, 0, 0), 'sam': (2, 0, 0),
         'eur': (-1, 0, 0), 'afr': (0, 0, 0), 'ind': (-1, -1, 0),
         'aus': (-4, -3, -1), 'ant': (1, 0, 0)},
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


def chaikin(pts, iterations=2):
    """Corner-cutting subdivision: coarse rings become smooth curves."""
    for _ in range(iterations):
        nxt = []
        for i in range(len(pts)):
            p, q = np.array(pts[i]), np.array(pts[(i + 1) % len(pts)])
            nxt += [tuple(0.75 * p + 0.25 * q), tuple(0.25 * p + 0.75 * q)]
        pts = nxt
    return pts


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
    return chaikin(out)


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
for i, ma in enumerate(np.linspace(450, 1, FRAMES)):
    tf = transform_at(ma)
    rings = [place(PLATES[p], *tf[p]) for p in PLATES]
    name = f'pf{i:02d}.jpg'
    render_frame(name, rings)
    frames.append({'time': int(-ma * 1e6), 'file': name})
    print(f'{name} @ {ma:.0f} Ma')

with open('src/data/paleoFrames.json', 'w') as f:
    json.dump(frames, f, indent=2)
print('frame list written')
