"""Generates placeholder paleogeography textures. Replace with real
PALEOMAP/Scotese rasters when licensing is sorted (see docs/plan-phase1.md)."""
from PIL import Image, ImageDraw, ImageFilter

W, H = 2048, 1024
OCEAN = (22, 54, 102)
LAND = (139, 124, 84)
SHELF = (60, 105, 150)

def px(lng, lat):
    return ((lng + 180) / 360 * W, (90 - lat) / 180 * H)

def render(name, polys):
    img = Image.new('RGB', (W, H), OCEAN)
    d = ImageDraw.Draw(img)
    shelf = Image.new('L', (W, H), 0)
    ds = ImageDraw.Draw(shelf)
    for p in polys:
        ds.polygon([px(*pt) for pt in p], fill=255)
    halo = shelf.filter(ImageFilter.MaxFilter(15)).filter(ImageFilter.GaussianBlur(6))
    img.paste(Image.new('RGB', (W, H), SHELF), mask=halo)
    for p in polys:
        d.polygon([px(*pt) for pt in p], fill=LAND)
    img = img.filter(ImageFilter.GaussianBlur(1.5))
    img.save(f'public/textures/paleo/{name}.jpg', quality=85)
    print(name, 'ok')

antarctica = [(-180, -68), (180, -68), (180, -90), (-180, -90)]

render('250ma', [[
    (-45, 62), (5, 68), (35, 55), (20, 35), (45, 22), (25, 8), (48, -8),
    (30, -22), (52, -38), (28, -58), (-10, -68), (-42, -58), (-32, -30),
    (-48, -8), (-38, 18), (-50, 40),
]])
render('150ma', [
    [(-75, 48), (-55, 62), (-10, 68), (40, 66), (70, 52), (45, 36), (0, 32), (-45, 34)],
    [(-70, -8), (-30, 6), (10, 2), (45, -12), (60, -30), (30, -55), (-15, -62), (-50, -45), (-72, -25)],
])
render('65ma', [
    [(-140, 62), (-95, 70), (-70, 55), (-75, 35), (-100, 22), (-125, 35)],
    [(-82, 8), (-58, 4), (-52, -25), (-68, -50), (-85, -22)],
    [(-12, 55), (25, 66), (85, 70), (130, 62), (110, 38), (55, 32), (10, 40)],
    [(-15, 32), (32, 28), (45, -2), (24, -33), (-12, -28)],
    [(58, -12), (74, -8), (78, -28), (60, -32)],
    [(115, -22), (150, -18), (155, -40), (118, -44)],
    antarctica,
])
render('20ma', [
    [(-150, 62), (-100, 70), (-70, 58), (-78, 32), (-102, 20), (-128, 35)],
    [(-82, 10), (-56, 4), (-50, -28), (-68, -54), (-84, -20)],
    [(-10, 55), (25, 68), (95, 72), (140, 62), (118, 36), (70, 24), (78, 8), (60, 18), (35, 30), (8, 38)],
    [(-16, 34), (34, 30), (50, 8), (40, -12), (22, -34), (-14, -30)],
    [(114, -14), (152, -12), (154, -38), (116, -40)],
    antarctica,
])
