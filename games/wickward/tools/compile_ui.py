from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Image.open(ROOT / "design" / "ui-kit-source.png").convert("RGBA")
OUT = ROOT / "assets" / "runtime" / "ui"
OUT.mkdir(parents=True, exist_ok=True)

PALETTE = [
    (23, 22, 34), (35, 31, 48), (52, 48, 64), (76, 64, 79),
    (244, 230, 193), (208, 181, 137), (247, 201, 76), (220, 139, 48),
    (217, 87, 63), (142, 54, 50), (79, 139, 214), (49, 76, 137),
    (135, 85, 168), (83, 54, 112), (112, 167, 104), (53, 94, 72),
]

# ImageGen delivered a clean visual grid with intentionally unequal row heights.
# These source regions are pinned to ui-kit-source.png so white gutters never
# enter the extraction bounds or distort the downsampled component.
COMPONENTS = {
    "battle-frame": ((45, 55, 790, 260), (458, 177)),
    "primary-button": ((890, 55, 1600, 255), (107, 30)),
    "secondary-button": ((55, 345, 780, 545), (107, 30)),
    "formation-socket": ((1090, 295, 1360, 570), (60, 60)),
    "health-rail": ((45, 585, 790, 690), (54, 10)),
    "flame-lit": ((1160, 590, 1295, 700), (16, 16)),
    "flame-unlit": ((350, 745, 475, 880), (16, 16)),
    "result-plaque": ((870, 715, 1635, 930), (216, 91)),
}


def closest(rgb):
    red, green, blue = rgb
    return min(PALETTE, key=lambda color: (
        (red - color[0]) ** 2 * 0.30
        + (green - color[1]) ** 2 * 0.59
        + (blue - color[2]) ** 2 * 0.11
    ))


def is_green(pixel):
    red, green, blue, _alpha = pixel
    return green > 85 and green > red * 1.28 and green > blue * 1.28


def compile_component(name, source_bounds, target_size):
    image = SOURCE.crop(source_bounds)
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            pixels[x, y] = (red, green, blue, 0 if is_green((red, green, blue, alpha)) else 255)
    bounds = image.getchannel("A").getbbox()
    if not bounds:
        raise RuntimeError(f"{name} has no extracted pixels")
    image = image.crop(bounds).resize(target_size, Image.Resampling.BOX)
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            if alpha < 128:
                pixels[x, y] = (0, 0, 0, 0)
            else:
                color = closest((red, green, blue))
                pixels[x, y] = (*color, 255)
    image.save(OUT / f"{name}.png", optimize=True)


for component_name, (component_cell, component_size) in COMPONENTS.items():
    compile_component(component_name, component_cell, component_size)

print(f"compiled {len(COMPONENTS)} production UI elements to {OUT}")
