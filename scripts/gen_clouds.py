"""Procedural cloud cover with structure: domain-warped ridged noise for
filaments, explicit cyclonic spirals in the storm-track latitudes, and real
climate belts (ITCZ, dry subtropics, mid-latitude storms, polar cap).
High contrast — solid white cloud against genuinely clear sky."""
import numpy as np
from PIL import Image, ImageFilter

W, H = 4096, 2048
rng = np.random.default_rng(7)


def fractal(octaves=9, persistence=0.55, seed=0, first=0):
    r = np.random.default_rng(seed)
    out, amp, total = np.zeros((H, W)), 1.0, 0.0
    for o in range(first, octaves):
        g = Image.fromarray((r.random((2 * 2**o, 4 * 2**o)) * 255).astype(np.uint8))
        out += np.asarray(g.resize((W, H), Image.BICUBIC), dtype=float) / 255 * amp
        total += amp
        amp *= persistence
    return out / total


YS, XS = np.indices((H, W), dtype=np.float32)
LAT = 90 - YS / H * 180


def sample(field, dx, dy):
    """Sample `field` at displaced coordinates (wraps in longitude)."""
    xi = ((XS + dx) % W).astype(np.int32)
    yi = np.clip(YS + dy, 0, H - 1).astype(np.int32)
    return field[yi, xi]


# --- base field: ridged multifractal gives filaments rather than blobs ---
base = 1 - np.abs(fractal(9, 0.55, seed=1) * 2 - 1)
detail = fractal(10, 0.6, seed=2, first=3)

# --- domain warp: displace lookups by another noise field -> swirled wisps ---
warp = W / 55
field = base * 0.7 + detail * 0.3
field = sample(field, (fractal(6, 0.6, seed=3) - 0.5) * warp,
               (fractal(6, 0.6, seed=4) - 0.5) * warp * 0.5)
field = sample(field, (fractal(8, 0.5, seed=5) - 0.5) * warp * 0.3,
               (fractal(8, 0.5, seed=6) - 0.5) * warp * 0.2)

# --- cyclonic spirals in the storm tracks ---
spiral_dx = np.zeros((H, W), dtype=np.float32)
spiral_dy = np.zeros((H, W), dtype=np.float32)
cyclone_mass = np.zeros((H, W), dtype=np.float32)
for _ in range(14):
    lat0 = rng.uniform(28, 62) * rng.choice([-1, 1])
    lng0 = rng.uniform(-180, 180)
    cx, cy = (lng0 + 180) / 360 * W, (90 - lat0) / 180 * H
    scale = rng.uniform(90, 190)
    spin = np.sign(lat0) * rng.uniform(2.6, 4.4)  # opposite hemispheres spin opposite

    dx = (XS - cx + W / 2) % W - W / 2
    dy = YS - cy
    r = np.hypot(dx, dy) + 1e-3
    falloff = np.exp(-r / scale)
    theta = spin * falloff
    ct, st = np.cos(theta), np.sin(theta)
    spiral_dx += (dx * ct - dy * st - dx) * 0.9
    spiral_dy += (dx * st + dy * ct - dy) * 0.9
    cyclone_mass = np.maximum(cyclone_mass, falloff * np.exp(-((r / scale - 0.55) ** 2) / 0.18))

field = sample(field, spiral_dx, spiral_dy)
field = np.clip(field + cyclone_mass * 0.45, 0, 1)

# --- climate belts ---
belts = (
    1.00 * np.exp(-((LAT - 4) ** 2) / (2 * 8.5**2))
    + 0.18 * np.exp(-((np.abs(LAT) - 27) ** 2) / (2 * 9**2))
    + 0.92 * np.exp(-((np.abs(LAT) - 54) ** 2) / (2 * 13**2))
    + 0.50 * np.exp(-((np.abs(LAT) - 82) ** 2) / (2 * 11**2))
)
density = field * (0.30 + 1.05 * belts)

# --- high contrast: solid cloud vs genuinely clear sky ---
# thresholds by percentile so coverage is deterministic: ~45% clear, ~20% solid
lo, hi = np.percentile(density, [50, 80])
alpha = np.clip((density - lo) / (hi - lo), 0, 1)
alpha = alpha * alpha * (3 - 2 * alpha)
alpha = np.asarray(
    Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)),
    dtype=np.float32,
) / 255

rgba = np.zeros((H, W, 4), dtype=np.uint8)
rgba[..., :3] = 255
rgba[..., 3] = (alpha * 255).astype(np.uint8)
Image.fromarray(rgba).save('public/textures/clouds.png')

bump = (np.clip(alpha * 1.15, 0, 1) * 255).astype(np.uint8)
Image.fromarray(bump).save('public/textures/clouds_bump.jpg', quality=90)

print(f'clouds ok - mean {alpha.mean():.2f}, clear sky {(alpha < 0.05).mean():.0%}, solid {(alpha > 0.8).mean():.0%}')


# --- thin high cirrus: zonally stretched wisps, drift faster for parallax ---
cirrus = fractal(9, 0.6, seed=21)
cirrus = sample(cirrus, (fractal(5, 0.6, seed=22) - 0.5) * W / 12, np.zeros((H, W), np.float32))
cirrus = (cirrus + np.roll(cirrus, 40, axis=1) + np.roll(cirrus, -40, axis=1)) / 3  # smear zonally
cirrus *= 0.35 + 0.9 * np.exp(-((np.abs(LAT) - 45) ** 2) / (2 * 26 ** 2))
clo, chi = np.percentile(cirrus, [72, 96])
ca = np.clip((cirrus - clo) / (chi - clo), 0, 1)
ca = (ca * ca * (3 - 2 * ca)) * 0.55
rgba2 = np.zeros((H, W, 4), dtype=np.uint8)
rgba2[..., :3] = 255
rgba2[..., 3] = (ca * 255).astype(np.uint8)
Image.fromarray(rgba2).save('public/textures/cirrus.png')
print(f'cirrus ok - mean {ca.mean():.2f}')
