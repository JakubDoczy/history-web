"""Generates a simple procedural moon texture."""
import random
from PIL import Image, ImageDraw, ImageFilter

random.seed(7)
W, H = 1024, 512
img = Image.new('RGB', (W, H), (150, 148, 145))
d = ImageDraw.Draw(img)
for _ in range(500):
    x, y = random.uniform(0, W), random.uniform(0, H)
    r = random.uniform(2, 26) * (0.5 + abs(y / H - 0.5))
    shade = random.randint(-28, 14)
    c = tuple(max(0, min(255, 150 + shade + o)) for o in (0, -2, -5))
    d.ellipse([x - r, y - r, x + r, y + r], fill=c)
img = img.filter(ImageFilter.GaussianBlur(2))
img.save('public/textures/moon.jpg', quality=85)
print('moon ok')
