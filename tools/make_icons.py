"""Generate the extension icons and the Web Store promo tile.

    python3 tools/make_icons.py

Writes extension/icons/icon{16,32,48,128}.png and store/promo-440x280.png.
"""

import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLUE = (26, 115, 232, 255)
INK = (32, 33, 36, 255)
WHITE = (255, 255, 255, 255)
SS = 8  # supersample factor, downsampled with LANCZOS for clean edges

FONTS = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial Bold.ttf",
]


def glyph(size, radius=28, bg=BLUE):
    """The mark: a group pill above a page body."""
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = n / 128  # design in a 128 grid, scale up

    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=radius * u, fill=bg)
    d.rounded_rectangle([20 * u, 26 * u, 72 * u, 46 * u], radius=10 * u, fill=WHITE)
    d.rounded_rectangle([20 * u, 58 * u, 108 * u, 104 * u], radius=10 * u, fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


def load_font(size):
    for path in FONTS:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def promo():
    """440x280 small promo tile."""
    img = Image.new("RGB", (440, 280), (255, 255, 255))
    mark = glyph(120)
    img.paste(mark, (55, 80), mark)  # vertically centered: 80 + 60 = 140

    d = ImageDraw.Draw(img)
    font = load_font(30)
    d.text((195, 102), "Single-group", font=font, fill=INK)
    d.text((195, 140), "window", font=font, fill=BLUE)
    return img


if __name__ == "__main__":
    os.makedirs(f"{ROOT}/extension/icons", exist_ok=True)
    os.makedirs(f"{ROOT}/store", exist_ok=True)

    for size in (16, 32, 48, 128):
        glyph(size).save(f"{ROOT}/extension/icons/icon{size}.png")
        print(f"extension/icons/icon{size}.png")

    promo().save(f"{ROOT}/store/promo-440x280.png")
    print("store/promo-440x280.png")
