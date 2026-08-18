from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "runtime"
OUT.mkdir(parents=True, exist_ok=True)

PALETTE = [
    (23, 22, 34), (35, 31, 48), (52, 48, 64), (76, 64, 79),
    (244, 230, 193), (208, 181, 137), (247, 201, 76), (220, 139, 48),
    (217, 87, 63), (142, 54, 50), (79, 139, 214), (49, 76, 137),
    (135, 85, 168), (83, 54, 112), (112, 167, 104), (53, 94, 72),
]

SOURCES = {
    "red-warden": ROOT / "assets/source/red-warden/red-warden-001.cutout.png",
    "blue-seer": ROOT / "assets/source/blue-seer/blue-seer-001.cutout.png",
    "gold-chime": ROOT / "assets/source/gold-chime/gold-chime-001.cutout.png",
    "soot-moth": ROOT / "assets/source/soot-moth/soot-moth-001.cutout.png",
    "needle-moth": ROOT / "assets/source/needle-moth/needle-moth-001.cutout.png",
    "ash-moth": ROOT / "assets/source/ash-moth/ash-moth-001.cutout.png",
}


def nearest_color(pixel):
    red, green, blue = pixel
    return min(PALETTE, key=lambda color: (
        (red - color[0]) ** 2 * 0.30
        + (green - color[1]) ** 2 * 0.59
        + (blue - color[2]) ** 2 * 0.11
    ))


def compile_sprite(name, path):
    source = Image.open(path).convert("RGBA")
    alpha = source.getchannel("A").point(lambda value: 255 if value >= 96 else 0)
    bounds = alpha.getbbox()
    if not bounds:
        raise RuntimeError(f"{name} has no opaque pixels")
    source = source.crop(bounds)
    alpha = alpha.crop(bounds)
    maximum_width, maximum_height = (48, 54) if "moth" not in name else (54, 48)
    scale = min(maximum_width / source.width, maximum_height / source.height)
    size = (max(1, round(source.width * scale)), max(1, round(source.height * scale)))
    source = source.resize(size, Image.Resampling.BOX)
    alpha = alpha.resize(size, Image.Resampling.NEAREST)
    pixels = source.load()
    mask = alpha.load()
    for y in range(source.height):
        for x in range(source.width):
            if mask[x, y] == 0:
                pixels[x, y] = (0, 0, 0, 0)
            else:
                red, green, blue = nearest_color(pixels[x, y][:3])
                pixels[x, y] = (red, green, blue, 255)
    canvas = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    left = (64 - source.width) // 2
    top = 61 - source.height
    canvas.alpha_composite(source, (left, top))
    canvas.save(OUT / f"{name}.png", optimize=True)


for sprite_name, sprite_path in SOURCES.items():
    compile_sprite(sprite_name, sprite_path)

print(f"compiled {len(SOURCES)} production sprites to {OUT}")
