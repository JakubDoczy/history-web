"""Generates placeholder paleogeography textures with procedural terrain:
Chaikin-smoothed continents, noise-warped fractal coastlines, elevation-colored
land with hillshading, and depth-shaded oceans. Still stylized placeholders —
replace with real PALEOMAP/Scotese rasters when licensing is sorted."""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H = 4096, 2048
rng = np.random.default_rng(42)


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


def chaikin(pts, iterations=3):
    for _ in range(iterations):
        nxt = []
        for i in range(len(pts)):
            p, q = np.array(pts[i]), np.array(pts[(i + 1) % len(pts)])
            nxt += [tuple(0.75 * p + 0.25 * q), tuple(0.25 * p + 0.75 * q)]
        pts = nxt
    return pts


def px(lng, lat):
    return ((lng + 180) / 360 * W, (90 - lat) / 180 * H)


def blur(arr, radius):
    img = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(radius)), dtype=float) / 255


def ramp(t, stops):
    """Piecewise-linear color ramp; stops = [(t, (r,g,b)), ...]."""
    ts = [s[0] for s in stops]
    out = np.zeros((*t.shape, 3))
    for c in range(3):
        out[..., c] = np.interp(t, ts, [s[1][c] for s in stops])
    return out


def render(name, polys, seed):
    # 1) Land mask from smoothed polygons
    mask_img = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(mask_img)
    for p in polys:
        d.polygon([px(*pt) for pt in chaikin(p)], fill=255)
    mask = np.asarray(mask_img, dtype=float) / 255

    # 2) Fractal coastline: coarse drift + fine jitter warp of the mask lookup
    coarse, fine = W / 80, W / 250
    wx = (fractal_noise(6, seed=seed) - 0.5) * coarse + (fractal_noise(10, 0.7, seed + 5, 5) - 0.5) * fine
    wy = (fractal_noise(6, seed=seed + 1) - 0.5) * coarse + (fractal_noise(10, 0.7, seed + 6, 5) - 0.5) * fine
    ys, xs = np.indices((H, W), dtype=float)
    xi = ((xs + wx) % W).astype(int)
    yi = np.clip(ys + wy, 0, H - 1).astype(int)
    land = mask[yi, xi] > 0.5

    # 3) Elevation: interior height + ridged noise mountains
    interior = blur(land.astype(float), 120)
    interior /= max(interior.max(), 1e-6)
    ridges = 1 - np.abs(fractal_noise(seed=seed + 2) * 2 - 1)
    elev = np.clip(0.85 * interior * (0.3 + 0.75 * ridges) + 0.12 * fractal_noise(seed=seed + 3), 0, 1)

    # 4) Colors
    land_col = ramp(elev, [
        (0.00, (196, 178, 128)),  # coast sand
        (0.22, (110, 139, 78)),   # lowlands
        (0.45, (88, 110, 62)),    # forest
        (0.62, (139, 115, 84)),   # highlands
        (0.80, (156, 152, 148)),  # rock
        (0.95, (232, 236, 240)),  # snow
    ])
    coast_dist = blur(land.astype(float), 90)          # ~1 near land, fades seaward
    depth_t = np.clip(coast_dist * 2.4 + 0.18 * fractal_noise(seed=seed + 4), 0, 1)
    ocean_col = ramp(depth_t, [
        (0.00, (10, 26, 58)),     # abyss
        (0.45, (18, 44, 92)),     # open ocean
        (0.80, (52, 96, 148)),    # shelf
        (1.00, (96, 148, 186)),   # shallows
    ])

    # 5) Hillshade from elevation gradient (light from NW)
    gy, gx = np.gradient(blur(elev, 3) * 60)
    shade = np.clip(1.0 - 0.9 * (gx + gy), 0.62, 1.25)
    land_col *= shade[..., None]

    img = np.where(land[..., None], land_col, ocean_col)
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(
        f'public/textures/paleo/{name}.jpg', quality=88)
    print(name, 'ok')


antarctica = [(-180, -68), (180, -68), (180, -90), (-180, -90)]

render('250ma', [[
    (-45, 62), (5, 68), (35, 55), (20, 35), (45, 22), (25, 8), (48, -8),
    (30, -22), (52, -38), (28, -58), (-10, -68), (-42, -58), (-32, -30),
    (-48, -8), (-38, 18), (-50, 40),
]], seed=10)
render('150ma', [
    [(-75, 48), (-55, 62), (-10, 68), (40, 66), (70, 52), (45, 36), (0, 32), (-45, 34)],
    [(-70, -8), (-30, 6), (10, 2), (45, -12), (60, -30), (30, -55), (-15, -62), (-50, -45), (-72, -25)],
], seed=20)
render('65ma', [
    [(-140, 62), (-95, 70), (-70, 55), (-75, 35), (-100, 22), (-125, 35)],
    [(-82, 8), (-58, 4), (-52, -25), (-68, -50), (-85, -22)],
    [(-12, 55), (25, 66), (85, 70), (130, 62), (110, 38), (55, 32), (10, 40)],
    [(-15, 32), (32, 28), (45, -2), (24, -33), (-12, -28)],
    [(58, -12), (74, -8), (78, -28), (60, -32)],
    [(115, -22), (150, -18), (155, -40), (118, -44)],
    antarctica,
], seed=30)
render('20ma', [
    [(-150, 62), (-100, 70), (-70, 58), (-78, 32), (-102, 20), (-128, 35)],
    [(-82, 10), (-56, 4), (-50, -28), (-68, -54), (-84, -20)],
    [(-10, 55), (25, 68), (95, 72), (140, 62), (118, 36), (70, 24), (78, 8), (60, 18), (35, 30), (8, 38)],
    [(-16, 34), (34, 30), (50, 8), (40, -12), (22, -34), (-14, -30)],
    [(114, -14), (152, -12), (154, -38), (116, -40)],
    antarctica,
], seed=40)
