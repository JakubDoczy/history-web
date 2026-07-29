"""Procedural cloud cover: fractal noise shaped into real latitude belts
(equatorial ITCZ, clear subtropics, mid-latitude storm tracks). Writes an RGBA
cloud map and a matching grayscale bump map."""
import numpy as np
from PIL import Image, ImageFilter

W, H = 2048, 1024


def fractal(octaves=8, persistence=0.58, seed=0):
    r = np.random.default_rng(seed)
    out, amp, total = np.zeros((H, W)), 1.0, 0.0
    for o in range(octaves):
        g = Image.fromarray((r.random((2 * 2**o, 4 * 2**o)) * 255).astype(np.uint8))
        out += np.asarray(g.resize((W, H), Image.BICUBIC), dtype=float) / 255 * amp
        total += amp
        amp *= persistence
    return out / total


lat = np.linspace(90, -90, H)[:, None] * np.ones((1, W))
# cloudiness by latitude: ITCZ band, dry horse latitudes, storm tracks, polar cap
belts = (
    1.00 * np.exp(-((lat - 4) ** 2) / (2 * 9**2))     # ITCZ
    + 0.22 * np.exp(-((np.abs(lat) - 28) ** 2) / (2 * 10**2))  # subtropics (sparse)
    + 0.85 * np.exp(-((np.abs(lat) - 55) ** 2) / (2 * 14**2))  # storm tracks
    + 0.45 * np.exp(-((np.abs(lat) - 82) ** 2) / (2 * 12**2))  # polar
)

n = fractal(seed=11)
swirl = fractal(6, 0.65, seed=12)
density = np.clip((n * 0.65 + swirl * 0.35) * (0.35 + 0.95 * belts) - 0.14, 0, 1)
density = np.asarray(
    Image.fromarray((density * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2)),
    dtype=float,
) / 255
alpha = np.clip(density * 2.1, 0, 1) ** 0.95

rgba = np.zeros((H, W, 4), dtype=np.uint8)
rgba[..., :3] = 255
rgba[..., 3] = (alpha * 255).astype(np.uint8)
Image.fromarray(rgba).save('public/textures/clouds.png')

# bump: thicker cloud = higher, so lighting picks out billows
bump = (np.clip(density * 1.4, 0, 1) * 255).astype(np.uint8)
Image.fromarray(bump).save('public/textures/clouds_bump.jpg', quality=88)
print(f'clouds ok — mean cover {alpha.mean():.2f}')
