from PIL import Image, ImageDraw, ImageFont, ImageFilter
import subprocess, os

S = 1024
NAVY = (31, 56, 100, 255)
PAPER = (255, 255, 255, 255)
FOLD = (219, 227, 242, 255)
LINE = (154, 169, 196, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# --- app tile -------------------------------------------------------
pad, radius = 100, 185
d.rounded_rectangle((pad, pad, S - pad, S - pad), radius=radius, fill=NAVY)

# --- document silhouette (rounded rect with clipped corner) ---------
x0, y0, x1, y1 = 292, 226, 732, 798
fold = 104
mask = Image.new("L", (S, S), 0)
m = ImageDraw.Draw(mask)
m.rounded_rectangle((x0, y0, x1, y1), radius=36, fill=255)
m.polygon([(x1 - fold, y0 - 2), (x1 + 2, y0 - 2), (x1 + 2, y0 + fold)], fill=0)

# soft shadow behind the paper
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
shadow.paste(Image.new("RGBA", (S, S), (6, 14, 30, 120)), (0, 20), mask)
shadow = shadow.filter(ImageFilter.GaussianBlur(16))
img.alpha_composite(shadow)

# paper
img.paste(Image.new("RGBA", (S, S), PAPER), (0, 0), mask)

# folded flap in the clipped corner
flap = [(x1 - fold, y0), (x1 - fold + 4, y0 + fold - 4), (x1, y0 + fold)]
d.polygon(flap, fill=FOLD)
d.line([(x1 - fold, y0), (x1, y0 + fold)], fill=(196, 208, 230, 255), width=5, joint="curve")

# --- content lines --------------------------------------------------
d.rounded_rectangle((x0 + 62, y0 + 96, x0 + 250, y0 + 127), radius=15, fill=NAVY)
for i, w in enumerate((330, 330, 250)):
    yy = y0 + 190 + i * 78
    d.rounded_rectangle((x0 + 62, yy, x0 + 62 + w, yy + 22), radius=11, fill=LINE)

# --- £ badge --------------------------------------------------------
badge_r = 126
cx, cy = x1 - 24, y1 - 24
d.ellipse(
    (cx - badge_r, cy - badge_r, cx + badge_r, cy + badge_r),
    fill=NAVY, outline=(255, 255, 255, 255), width=16
)

font = None
for path, index in [("/System/Library/Fonts/SFNS.ttf", 0), ("/System/Library/Fonts/Helvetica.ttc", 0)]:
    if os.path.exists(path):
        try:
            font = ImageFont.truetype(path, 170, index=index)
            break
        except Exception:
            continue
if font is None:
    font = ImageFont.load_default()

text = "£"
bbox = d.textbbox((0, 0), text, font=font)
d.text(
    (cx - (bbox[2] - bbox[0]) / 2 - bbox[0], cy - (bbox[3] - bbox[1]) / 2 - bbox[1] - 10),
    text, font=font, fill=(255, 255, 255, 255)
)

img.save("icon-1024.png")

iconset = "AppIcon.iconset"
os.makedirs(iconset, exist_ok=True)
for size in (16, 32, 64, 128, 256, 512, 1024):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, f"icon_{size}x{size}.png"))
    if size * 2 <= 1024:
        img.resize((size * 2, size * 2), Image.LANCZOS).save(os.path.join(iconset, f"icon_{size}x{size}@2x.png"))

subprocess.run(["iconutil", "-c", "icns", "AppIcon.iconset", "-o", "AppIcon.icns"], check=True)
print("icon built")
