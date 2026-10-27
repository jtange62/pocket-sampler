"""Draws the app icon (a 4x4 pad grid in the app's row colours) to build/icon.ico."""
import colorsys
import os

from PIL import Image, ImageDraw

SIZE = 512
ROW_HUES = [8, 38, 168, 262]


def hsl(h, s, l):
    r, g, b = colorsys.hls_to_rgb(h / 360, l, s)
    return (round(r * 255), round(g * 255), round(b * 255), 255)


def draw():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([16, 16, SIZE - 16, SIZE - 16], radius=96, fill=(26, 28, 35, 255))
    pad, gap = 92, 18
    margin = (SIZE - (4 * pad + 3 * gap)) // 2
    for row in range(4):
        for col in range(4):
            x = margin + col * (pad + gap)
            y = margin + row * (pad + gap)
            colour = hsl(ROW_HUES[row] + col * 9, 0.62, 0.58)
            d.rounded_rectangle([x, y, x + pad, y + pad], radius=20, fill=colour)
    return img


if __name__ == "__main__":
    out_dir = os.path.join(os.path.dirname(__file__), "..", "build")
    os.makedirs(out_dir, exist_ok=True)
    img = draw()
    img.save(os.path.join(out_dir, "icon.png"))
    img.save(os.path.join(out_dir, "icon.ico"), sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
