from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Image.open(ROOT / "design" / "ui-motifs-source.png").convert("RGBA")
OUT = ROOT / "assets" / "runtime" / "ui-v2"
OUT.mkdir(parents=True, exist_ok=True)

PALETTE = [
    (23, 22, 34), (35, 31, 48), (52, 48, 64), (76, 64, 79),
    (244, 230, 193), (208, 181, 137), (247, 201, 76), (220, 139, 48),
    (217, 87, 63), (142, 54, 50), (79, 139, 214), (49, 76, 137),
    (135, 85, 168), (83, 54, 112), (112, 167, 104), (53, 94, 72),
]

# Each motif is compiled into its final native-game dimensions. Runtime code
# places these images 1:1 and never stretches them.
MOTIFS = {
    "flame-crest": ((0, 0, 510, 510), (28, 28)),
    "ward-knot": ((514, 0, 1022, 510), (24, 24)),
    "moth-sigil": ((1026, 0, 1536, 510), (24, 24)),
    "wax-drip": ((0, 514, 510, 1024), (32, 10)),
    "corner-cap": ((514, 514, 1022, 1024), (8, 8)),
    "rivet": ((1026, 514, 1536, 1024), (5, 5)),
}


def is_green(pixel):
    red, green, blue, _alpha = pixel
    return green > 100 and green > red * 1.35 and green > blue * 1.35


def closest(rgb):
    red, green, blue = rgb
    return min(PALETTE, key=lambda color: (
        (red - color[0]) ** 2 * 0.30
        + (green - color[1]) ** 2 * 0.59
        + (blue - color[2]) ** 2 * 0.11
    ))


def compile_motif(name, source_bounds, target_size):
    image = SOURCE.crop(source_bounds)
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            pixels[x, y] = (red, green, blue, 0 if is_green((red, green, blue, alpha)) else 255)
    bounds = image.getchannel("A").getbbox()
    if not bounds:
        raise RuntimeError(f"{name} has no extracted pixels")
    image = image.crop(bounds)
    image.thumbnail(target_size, Image.Resampling.BOX)
    canvas = Image.new("RGBA", target_size, (0, 0, 0, 0))
    canvas.alpha_composite(image, ((target_size[0] - image.width) // 2, (target_size[1] - image.height) // 2))
    pixels = canvas.load()
    for y in range(canvas.height):
        for x in range(canvas.width):
            red, green, blue, alpha = pixels[x, y]
            if alpha < 128:
                pixels[x, y] = (0, 0, 0, 0)
            else:
                pixels[x, y] = (*closest((red, green, blue)), 255)
    canvas.save(OUT / f"{name}.png", optimize=True)


for motif_name, (motif_cell, motif_size) in MOTIFS.items():
    compile_motif(motif_name, motif_cell, motif_size)

print(f"compiled {len(MOTIFS)} fixed-scale UI motifs to {OUT}")
