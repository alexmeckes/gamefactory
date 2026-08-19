"""Build and validate native-resolution proposed scene targets.

This script deliberately produces full-screen design targets, not isolated assets.
It preserves the reviewed generated village compositions as reference imagery while
rebuilding the information-bearing surfaces and interaction cues on an exact
480x270 native grid. The 3x files are nearest-neighbor review presentations.
"""

from __future__ import annotations

import hashlib
import json
import math
import shutil
import subprocess
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent
VIEWS = ROOT / "views"
REFERENCE_VIEWS = ROOT / "reference-views"
REVIEW_3X = ROOT / "review-3x"
CONTINUITY_SOURCE_DIR = ROOT / "continuity-source"
CONTINUITY_SOURCE = CONTINUITY_SOURCE_DIR / "continuous-world-basis.png"
CONTINUITY_MASKS = ROOT / "continuity-masks"
COMPONENT_OVERLAYS = ROOT / "component-overlays"
COMPONENT_OVERLAYS_3X = ROOT / "component-overlays-3x"
MANIFEST_PATH = ROOT / "scene-target.json"
VALIDATION_PATH = ROOT / "validation.json"

NATIVE_SIZE = (480, 270)
SHIP_SIZE = (1440, 810)

PALETTE = {
    "ink": "#1B1A24",
    "deep_slate": "#2A3341",
    "plum_shadow": "#44354E",
    "wood": "#6B4638",
    "clay": "#A85D43",
    "ember": "#E66A3C",
    "warmth": "#F3B94E",
    "paper": "#F4E1B5",
    "moss_dark": "#345B43",
    "moss": "#69A35C",
    "soothing": "#83C9A0",
    "roof_blue": "#4D6D7A",
    "wind": "#B7DCE1",
    "reaction_rose": "#C97878",
    "alchemy_violet": "#8467A8",
    "specular": "#FFF3CE",
}

BODY_FONT_PATH = Path("C:/Windows/Fonts/segoeui.ttf")
SEMIBOLD_FONT_PATH = Path("C:/Windows/Fonts/segoeuib.ttf")
FONT_BODY = ImageFont.truetype(str(BODY_FONT_PATH), 12)
FONT_BODY_BOLD = ImageFont.truetype(str(SEMIBOLD_FONT_PATH), 12)
FONT_CAPTION = ImageFont.truetype(str(BODY_FONT_PATH), 11)
FONT_CAPTION_BOLD = ImageFont.truetype(str(SEMIBOLD_FONT_PATH), 11)
FONT_DISPLAY = ImageFont.truetype(str(SEMIBOLD_FONT_PATH), 10)
FONT_ACTION = ImageFont.truetype(str(SEMIBOLD_FONT_PATH), 11)

VIEW_IDS = [
    "continuous-route-pending",
    "continuous-need-disclosed",
    "continuous-mix-feedback",
    "continuous-exposed-conversion",
    "continuous-sheltered-preservation",
    "continuous-satisfied-delivery",
    "continuous-imperfect-recovery",
    "continuous-followup-selection",
    "following-rooms-route-pending",
]

STATE_BY_VIEW = {
    "continuous-route-pending": "route-pending",
    "continuous-need-disclosed": "need-disclosed",
    "continuous-mix-feedback": "mix-feedback",
    "continuous-exposed-conversion": "exposed-conversion",
    "continuous-sheltered-preservation": "sheltered-preservation",
    "continuous-satisfied-delivery": "satisfied-delivery",
    "continuous-imperfect-recovery": "imperfect-recovery",
    "continuous-followup-selection": "followup-selection",
    "following-rooms-route-pending": "route-pending",
}

SELECTED_VIEW_IDS = VIEW_IDS[:8]

PAINTOVER_PROMPTS = {
    "continuous-route-pending": "At exact native 480x270, preserve the reviewed continuous-village camera and world art. Recompose the request and bottled-state surfaces with 12px humanist body type, 11px headings, 15px line rhythm, 6px insets, icon-plus-number potion language, and one-pixel authored borders. Keep both routes, the courier, bottle, and Mira unobscured.",
    "continuous-need-disclosed": "At exact native 480x270, preserve the reviewed continuous-village camera and the canonical persistent-world basis. Remove the detached lower-right MOSS cue by retaining the same detailed foreground roof and sign geometry used in adjacent states. Place EMBER and MOSS identity cues beside their actual brew-yard planters, reserve E ADD for the reachable brew object, and recompose the request surface with measured humanist type. No bottle badge exists.",
    "continuous-mix-feedback": "At exact native 480x270, preserve the reviewed continuous-village camera and world art. Anchor MOSS and E ADD inside the brew yard, keep both ingredient silhouettes readable, and recompose request plus two-line moss-added feedback with measured humanist type. No bottle badge exists.",
    "continuous-exposed-conversion": "At exact native 480x270, preserve the reviewed continuous-village camera and exposed-route action. Recompose request, carried state, and two-line gust consequence at measured native type while keeping courier brace, bottle exchange, wind tell, route threshold, and Mira unobscured.",
    "continuous-sheltered-preservation": "At exact native 480x270, preserve the reviewed continuous-village camera and sheltered-route action. Recompose request, carried state, and affirmative two-line preservation feedback at measured native type while keeping courier, bottle lock pulse, awning, route threshold, and Mira unobscured.",
    "continuous-satisfied-delivery": "At exact native 480x270, preserve the reviewed continuous-village camera and physical handoff. Recompose needed state, arrived exact-match comparison, and RELIEF reaction label at measured native type. Keep the physical reaction primary and show no carried badge after consumption.",
    "continuous-imperfect-recovery": "At exact native 480x270, preserve the reviewed continuous-village camera and physical handoff. Recompose needed state, arrived imperfect comparison, and SHIVER reaction label at measured native type. Keep the tucked shiver pose primary and show no carried badge after consumption.",
    "continuous-followup-selection": "At exact native 480x270, preserve the reviewed continuous-village camera, visible courier, golden proximity ring, and both physical destination pennants. Put compact Sunmill 3W/0S and Herbalist 1W/2S information on small flanking world-sign tags outside the protected courier, pennant, and walking-corridor rectangles. Put E GO immediately left of the visible courier. Keep the Sunmill pennant selected and the Herbalist alternative visibly available. Do not create modal cards or cover any actor, landmark, or movement space.",
    "following-rooms-route-pending": "At exact native 480x270, preserve the complete closer comparison direction. Recompose request and bottled-state surfaces with the same measured 12px humanist body system and icon-plus-number potion language. Keep both routes and all actors unobscured.",
}


def box(x: int, y: int, width: int, height: int) -> dict[str, int]:
    return {"x": x, "y": y, "width": width, "height": height}


# Every selected view begins from one persistent environment basis. Only these
# causal actor/effect regions are taken from the generated state reference.
DYNAMIC_PATCHES = {
    "continuous-need-disclosed": [box(36, 82, 116, 150)],
    "continuous-mix-feedback": [box(36, 82, 116, 150)],
    "continuous-route-pending": [box(160, 120, 76, 84)],
    "continuous-exposed-conversion": [box(205, 35, 125, 100)],
    "continuous-sheltered-preservation": [box(242, 128, 105, 93)],
    "continuous-satisfied-delivery": [box(345, 68, 128, 130)],
    "continuous-imperfect-recovery": [box(345, 68, 128, 130)],
    "continuous-followup-selection": [box(292, 145, 150, 85)],
}


PROTECTED_GEOMETRY = {
    "continuous-need-disclosed": [
        {"id": "courier", "kind": "actor", "rect": box(117, 116, 27, 49)},
        {"id": "partner", "kind": "actor", "rect": box(91, 105, 30, 50)},
        {"id": "cauldron", "kind": "landmark", "rect": box(45, 86, 48, 53)},
    ],
    "continuous-mix-feedback": [
        {"id": "courier", "kind": "actor", "rect": box(85, 98, 30, 50)},
        {"id": "partner", "kind": "actor", "rect": box(91, 105, 30, 50)},
        {"id": "cauldron", "kind": "landmark", "rect": box(45, 86, 48, 53)},
    ],
    "continuous-route-pending": [
        {"id": "courier", "kind": "actor", "rect": box(174, 141, 29, 50)},
        {"id": "gust-threshold", "kind": "landmark", "rect": box(188, 67, 42, 33)},
        {"id": "shelter-threshold", "kind": "landmark", "rect": box(208, 173, 56, 34)},
        {"id": "fork-corridor", "kind": "movement-corridor", "rect": box(145, 101, 164, 112)},
    ],
    "continuous-exposed-conversion": [
        {"id": "courier", "kind": "actor", "rect": box(234, 57, 40, 55)},
        {"id": "gust-threshold", "kind": "landmark", "rect": box(188, 67, 42, 33)},
    ],
    "continuous-sheltered-preservation": [
        {"id": "courier", "kind": "actor", "rect": box(260, 150, 43, 61)},
        {"id": "shelter-threshold", "kind": "landmark", "rect": box(208, 173, 56, 34)},
    ],
    "continuous-satisfied-delivery": [
        {"id": "courier", "kind": "actor", "rect": box(348, 105, 44, 58)},
        {"id": "mira", "kind": "actor", "rect": box(383, 99, 44, 61)},
    ],
    "continuous-imperfect-recovery": [
        {"id": "courier", "kind": "actor", "rect": box(352, 105, 42, 58)},
        {"id": "mira", "kind": "actor", "rect": box(383, 99, 44, 61)},
    ],
    "continuous-followup-selection": [
        {"id": "courier", "kind": "actor", "rect": box(310, 169, 32, 52)},
        {"id": "sunmill-pennant", "kind": "landmark", "rect": box(329, 156, 39, 56)},
        {"id": "herbalist-pennant", "kind": "landmark", "rect": box(365, 174, 40, 41)},
        {"id": "followup-walking-corridor", "kind": "movement-corridor", "rect": box(270, 213, 116, 48)},
    ],
}


CONTINUITY_TRANSITIONS = [
    ("continuous-need-disclosed", "continuous-mix-feedback"),
    ("continuous-mix-feedback", "continuous-route-pending"),
    ("continuous-route-pending", "continuous-exposed-conversion"),
    ("continuous-route-pending", "continuous-sheltered-preservation"),
    ("continuous-exposed-conversion", "continuous-satisfied-delivery"),
    ("continuous-sheltered-preservation", "continuous-imperfect-recovery"),
    ("continuous-satisfied-delivery", "continuous-followup-selection"),
    ("continuous-imperfect-recovery", "continuous-followup-selection"),
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def contrast_ratio(hex_a: str, hex_b: str) -> float:
    def luminance(value: str) -> float:
        channels = [int(value[i : i + 2], 16) / 255 for i in (1, 3, 5)]
        linear = [channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4 for channel in channels]
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]

    first, second = sorted((luminance(hex_a), luminance(hex_b)), reverse=True)
    return (first + 0.05) / (second + 0.05)


def panel_polygon(rect: tuple[int, int, int, int], cut: int = 4) -> list[tuple[int, int]]:
    x, y, width, height = rect
    right = x + width - 1
    bottom = y + height - 1
    return [
        (x + cut, y),
        (right - cut, y),
        (right, y + cut),
        (right, bottom - cut),
        (right - cut, bottom),
        (x + cut, bottom),
        (x, bottom - cut),
        (x, y + cut),
    ]


def draw_panel(draw: ImageDraw.ImageDraw, rect: tuple[int, int, int, int], fill: str = PALETTE["paper"], border: str = PALETTE["ink"]) -> None:
    x, y, width, height = rect
    shadow_rect = (x + 2, y + 2, width, height)
    draw.polygon(panel_polygon(shadow_rect), fill=PALETTE["plum_shadow"])
    draw.polygon(panel_polygon(rect), fill=border)
    inner = (x + 1, y + 1, width - 2, height - 2)
    draw.polygon(panel_polygon(inner, 3), fill=fill)


def draw_sun(draw: ImageDraw.ImageDraw, center: tuple[int, int], color: str = PALETTE["warmth"]) -> None:
    cx, cy = center
    draw.polygon([(cx, cy - 4), (cx + 4, cy), (cx, cy + 4), (cx - 4, cy)], fill=color, outline=PALETTE["ink"])
    for dx, dy in ((0, -7), (0, 7), (-7, 0), (7, 0)):
        draw.line((cx + dx, cy + dy, cx + int(dx * 0.72), cy + int(dy * 0.72)), fill=color, width=1)


def draw_leaf(draw: ImageDraw.ImageDraw, center: tuple[int, int], color: str = PALETTE["soothing"]) -> None:
    cx, cy = center
    draw.ellipse((cx - 4, cy - 3, cx + 4, cy + 3), fill=color, outline=PALETTE["ink"])
    draw.line((cx - 3, cy + 3, cx + 3, cy - 3), fill=PALETTE["moss_dark"], width=1)


def draw_potion_rows(draw: ImageDraw.ImageDraw, x: int, y: int, warmth: int, soothing: int) -> None:
    draw_sun(draw, (x + 5, y + 5))
    draw.text((x + 16, y - 2), f"{warmth} Warmth", font=FONT_BODY, fill=PALETTE["ink"])
    draw_leaf(draw, (x + 5, y + 21))
    draw.text((x + 16, y + 14), f"{soothing} Soothing", font=FONT_BODY, fill=PALETTE["ink"])


def draw_request(draw: ImageDraw.ImageDraw, past_tense: bool = False) -> dict[str, Any]:
    rect = (6, 3, 142, 65)
    draw_panel(draw, rect)
    heading = "Mira needed" if past_tense else "Mira needs"
    draw.text((12, 8), heading, font=FONT_CAPTION_BOLD, fill=PALETTE["ink"])
    draw_potion_rows(draw, 12, 27, 2, 1)
    return typography_check(rect, [heading, "2 Warmth", "1 Soothing"], [FONT_CAPTION_BOLD, FONT_BODY, FONT_BODY], 6, "request-status")


def draw_carried(draw: ImageDraw.ImageDraw, heading: str, warmth: int, soothing: int) -> dict[str, Any]:
    rect = (340, 3, 136, 66)
    draw_panel(draw, rect, fill="#D8B77C")
    draw.text((347, 8), heading, font=FONT_CAPTION_BOLD, fill=PALETTE["ink"])
    draw.rectangle((450, 13, 461, 35), fill=PALETTE["specular"], outline=PALETTE["ink"])
    draw.rectangle((453, 9, 458, 13), fill=PALETTE["wood"], outline=PALETTE["ink"])
    draw_potion_rows(draw, 347, 28, warmth, soothing)
    return typography_check(rect, [heading, f"{warmth} Warmth", f"{soothing} Soothing"], [FONT_CAPTION_BOLD, FONT_BODY, FONT_BODY], 6, "carried-status")


def draw_feedback(draw: ImageDraw.ImageDraw, heading: str, detail: str, width: int = 286) -> dict[str, Any]:
    rect = (6, 222, width, 43)
    draw_panel(draw, rect)
    draw.text((12, 227), heading, font=FONT_CAPTION_BOLD, fill=PALETTE["ink"])
    draw.text((12, 243), detail, font=FONT_BODY, fill=PALETTE["ink"])
    return typography_check(rect, [heading, detail], [FONT_CAPTION_BOLD, FONT_BODY], 6, "feedback")


def draw_comparison(draw: ImageDraw.ImageDraw, warmth: int, soothing: int, outcome: str, accent: str) -> dict[str, Any]:
    rect = (6, 205, 228, 60)
    draw_panel(draw, rect)
    draw.text((12, 210), "Arrived", font=FONT_CAPTION_BOLD, fill=PALETTE["ink"])
    draw_sun(draw, (18, 231))
    draw.text((29, 224), f"{warmth} Warmth", font=FONT_BODY, fill=PALETTE["ink"])
    draw_leaf(draw, (99, 231))
    draw.text((110, 224), f"{soothing} Soothing", font=FONT_BODY, fill=PALETTE["ink"])
    draw.text((12, 244), outcome, font=FONT_BODY_BOLD, fill=accent)
    return typography_check(rect, ["Arrived", f"{warmth} Warmth", f"{soothing} Soothing", outcome], [FONT_CAPTION_BOLD, FONT_BODY, FONT_BODY, FONT_BODY_BOLD], 6, "reaction-comparison")


def draw_reaction_label(draw: ImageDraw.ImageDraw, label: str, rect: tuple[int, int, int, int], fill: str) -> dict[str, Any]:
    draw_panel(draw, rect, fill=fill)
    text_box = draw.textbbox((0, 0), label, font=FONT_BODY_BOLD)
    text_width = text_box[2] - text_box[0]
    draw.text((rect[0] + (rect[2] - text_width) // 2, rect[1] + 4), label, font=FONT_BODY_BOLD, fill=PALETTE["ink"])
    return typography_check(rect, [label], [FONT_BODY_BOLD], 4, "delivery-context")


def draw_action_tag(draw: ImageDraw.ImageDraw, origin: tuple[int, int], verb: str, target: tuple[int, int] | None = None) -> dict[str, Any]:
    x, y = origin
    label = f"E  {verb}"
    bounds = draw.textbbox((0, 0), label, font=FONT_ACTION)
    width = bounds[2] - bounds[0] + 10
    rect = (x, y, width, 19)
    draw_panel(draw, rect, fill=PALETTE["specular"])
    draw.text((x + 5, y + 2), label, font=FONT_ACTION, fill=PALETTE["ink"])
    if target is not None:
        draw.line((x + width // 2, y + 19, target[0], target[1]), fill=PALETTE["specular"], width=1)
    return typography_check(rect, [label], [FONT_ACTION], 5, "world-action")


def draw_world_label(draw: ImageDraw.ImageDraw, origin: tuple[int, int], label: str, target: tuple[int, int]) -> dict[str, Any]:
    x, y = origin
    bounds = draw.textbbox((0, 0), label, font=FONT_CAPTION_BOLD)
    width = bounds[2] - bounds[0] + 10
    rect = (x, y, width, 18)
    draw_panel(draw, rect, fill=PALETTE["deep_slate"], border=PALETTE["specular"])
    draw.text((x + 5, y + 1), label, font=FONT_CAPTION_BOLD, fill=PALETTE["specular"])
    draw.line((x + width // 2, y + 18, target[0], target[1]), fill=PALETTE["specular"], width=1)
    return typography_check(rect, [label], [FONT_CAPTION_BOLD], 5, "brew-context")


def rect_tuple(rect: dict[str, int]) -> tuple[int, int, int, int]:
    return (rect["x"], rect["y"], rect["x"] + rect["width"], rect["y"] + rect["height"])


def build_persistent_world_basis() -> Image.Image:
    """Create one full-screen world basis without the route-pending courier/badge.

    The route-pending reference owns the persistent village geometry. Two clean
    regions from the need-disclosed whole-screen reference remove the carried
    badge and the center courier. No isolated runtime asset is produced.
    """
    basis = Image.open(REFERENCE_VIEWS / "continuous-route-pending.png").convert("RGB")
    clean = Image.open(REFERENCE_VIEWS / "continuous-need-disclosed.png").convert("RGB")
    for repair in (box(150, 108, 92, 100), box(330, 0, 150, 76)):
        crop = rect_tuple(repair)
        basis.paste(clean.crop(crop), crop[:2])
    CONTINUITY_SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    basis.save(CONTINUITY_SOURCE, format="PNG", optimize=False)
    return basis


def draw_world_info_sign(
    draw: ImageDraw.ImageDraw,
    rect: tuple[int, int, int, int],
    title: str,
    detail: str,
    connector: tuple[int, int],
    selected: bool,
) -> dict[str, Any]:
    x, y, width, height = rect
    border = PALETTE["warmth"] if selected else PALETTE["moss"]
    draw.polygon(panel_polygon(rect, 2), fill=border)
    inner = (x + 1, y + 1, width - 2, height - 2)
    draw.polygon(panel_polygon(inner, 1), fill=PALETTE["deep_slate"])
    draw.text((x + 6, y + 3), title, font=FONT_CAPTION_BOLD, fill=PALETTE["specular"])
    draw.text((x + 6, y + 18), detail, font=FONT_CAPTION, fill=border)
    if connector[0] < x:
        draw.line((x, y + height // 2, connector[0], connector[1]), fill=border, width=1)
    else:
        draw.line((x + width, y + height // 2, connector[0], connector[1]), fill=border, width=1)
    return typography_check(
        rect,
        [title, detail],
        [FONT_CAPTION_BOLD, FONT_CAPTION],
        6,
        "followup-context",
        text_color=PALETTE["specular"],
        background_color=PALETTE["deep_slate"],
    )


def draw_followup(draw: ImageDraw.ImageDraw) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    status_rect = (6, 3, 142, 65)
    draw_panel(draw, status_rect)
    draw.text((12, 8), "Next delivery", font=FONT_BODY_BOLD, fill=PALETTE["ink"])
    draw.text((12, 25), "Walk to a pennant", font=FONT_CAPTION, fill=PALETTE["ink"])
    draw.text((12, 42), "Gust shifts • shelter holds", font=FONT_CAPTION, fill=PALETTE["ink"])
    checks.append(
        typography_check(
            status_rect,
            ["Next delivery", "Walk to a pennant", "Gust shifts • shelter holds"],
            [FONT_BODY_BOLD, FONT_CAPTION, FONT_CAPTION],
            6,
            "followup-status",
        )
    )

    # Small flanking world signs preserve the physical pennants, the courier,
    # and the lower-right walking corridor. They are context labels, not cards.
    checks.append(draw_world_info_sign(draw, (250, 151, 58, 34), "Sunmill", "3W · 0S", (329, 173), True))
    checks.append(draw_world_info_sign(draw, (407, 151, 67, 34), "Herbalist", "1W · 2S", (405, 178), False))
    # Selection corners sit outside the physical Sunmill pennant.
    for start, end in (
        ((327, 154), (338, 154)), ((327, 154), (327, 165)),
        ((370, 154), (359, 154)), ((370, 154), (370, 165)),
        ((327, 214), (338, 214)), ((327, 214), (327, 203)),
        ((370, 214), (359, 214)), ((370, 214), (370, 203)),
    ):
        draw.line((*start, *end), fill=PALETTE["warmth"], width=1)
    checks.append(draw_action_tag(draw, (270, 190), "GO", target=(310, 198)))
    return checks


def typography_check(
    rect: tuple[int, int, int, int],
    texts: list[str],
    fonts: list[ImageFont.FreeTypeFont],
    inset: int,
    role: str,
    *,
    text_color: str = PALETTE["ink"],
    background_color: str = PALETTE["paper"],
) -> dict[str, Any]:
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    inner_width = rect[2] - inset * 2
    widths = []
    for text, font in zip(texts, fonts, strict=True):
        bounds = probe.textbbox((0, 0), text, font=font)
        widths.append(bounds[2] - bounds[0])
    return {
        "role": role,
        "rect": {"x": rect[0], "y": rect[1], "width": rect[2], "height": rect[3]},
        "insetPx": inset,
        "fontSizesPx": [font.size for font in fonts],
        "lineHeightPx": 16,
        "longestText": texts[widths.index(max(widths))],
        "longestTextWidthPx": max(widths),
        "innerWidthPx": inner_width,
        "clipped": max(widths) > inner_width,
        "contrastRatio": round(contrast_ratio(text_color, background_color), 2),
    }


def render_view(view_id: str, source: Path, destination: Path, persistent_basis: Image.Image) -> list[dict[str, Any]]:
    source_image = Image.open(source).convert("RGB")
    if view_id in SELECTED_VIEW_IDS:
        image = persistent_basis.copy()
        for patch in DYNAMIC_PATCHES[view_id]:
            crop = rect_tuple(patch)
            image.paste(source_image.crop(crop), crop[:2])
    else:
        image = source_image
    if image.size != NATIVE_SIZE:
        raise ValueError(f"{source} is {image.size}, expected {NATIVE_SIZE}")
    draw = ImageDraw.Draw(image)
    checks: list[dict[str, Any]] = []

    state = STATE_BY_VIEW[view_id]
    if state != "followup-selection":
        checks.append(draw_request(draw, past_tense=state in {"satisfied-delivery", "imperfect-recovery"}))

    if state == "route-pending":
        checks.append(draw_carried(draw, "Bottled", 1, 2))
    elif state == "need-disclosed":
        checks.append(draw_world_label(draw, (45, 168), "EMBER", (72, 191)))
        checks.append(draw_world_label(draw, (47, 190), "MOSS", (83, 213)))
        checks.append(draw_action_tag(draw, (104, 170), "ADD", target=(84, 178)))
    elif state == "mix-feedback":
        checks.append(draw_world_label(draw, (66, 191), "MOSS", (83, 212)))
        checks.append(draw_action_tag(draw, (96, 74), "ADD", target=(64, 108)))
        checks.append(draw_feedback(draw, "Moss added", "Brew: 1 Warmth  ·  2 Soothing"))
    elif state == "exposed-conversion":
        checks.append(draw_carried(draw, "Carried", 2, 1))
        checks.append(draw_feedback(draw, "Gust changed the bottle", "+1 Warmth  ·  −1 Soothing"))
    elif state == "sheltered-preservation":
        checks.append(draw_carried(draw, "Carried", 1, 2))
        checks.append(draw_feedback(draw, "Shelter preserved", "1 Warmth  ·  2 Soothing", width=254))
    elif state == "satisfied-delivery":
        checks.append(draw_comparison(draw, 2, 1, "Exact match", PALETTE["moss_dark"]))
        checks.append(draw_reaction_label(draw, "RELIEF", (382, 73, 72, 24), "#E9C36A"))
    elif state == "imperfect-recovery":
        checks.append(draw_comparison(draw, 1, 2, "Imperfect — recoverable", PALETTE["clay"]))
        checks.append(draw_reaction_label(draw, "SHIVER", (382, 73, 72, 24), "#D9A8A8"))
    elif state == "followup-selection":
        checks.extend(draw_followup(draw))

    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, format="PNG", optimize=False)
    return checks


def viewport_anchor(bounds: dict[str, int], mode: str) -> dict[str, Any]:
    if mode == "top-left":
        return {"mode": mode, "x": bounds["x"], "y": bounds["y"]}
    if mode == "center":
        return {"mode": mode, "x": bounds["x"] + bounds["width"] // 2, "y": bounds["y"] + bounds["height"] // 2}
    return {"mode": "bottom-center", "x": bounds["x"] + bounds["width"] // 2, "y": bounds["y"] + bounds["height"]}


def bounds_from_viewport_anchor(anchor: dict[str, Any], width: int, height: int) -> dict[str, int]:
    mode = anchor["mode"]
    if mode == "top-left":
        return box(anchor["x"], anchor["y"], width, height)
    if mode == "center":
        return box(anchor["x"] - width // 2, anchor["y"] - height // 2, width, height)
    if mode == "bottom-center":
        return box(anchor["x"] - width // 2, anchor["y"] - height, width, height)
    raise ValueError(f"Unsupported viewport anchor mode: {mode}")


def semantic_pivot(frame_size: dict[str, int], mode: str) -> dict[str, Any]:
    width = frame_size["width"]
    height = frame_size["height"]
    if mode == "top-left":
        return {"mode": mode, "x": 0, "y": 0}
    if mode == "center":
        return {"mode": mode, "x": width // 2, "y": height // 2}
    if mode == "bottom-center":
        return {"mode": mode, "x": width // 2, "y": height - 1}
    raise ValueError(f"Unsupported runtime pivot mode: {mode}")


def component(
    *,
    component_id: str,
    label: str,
    category: str,
    placements: dict[str, tuple[int, int, int, int]],
    hashes: dict[str, str],
    native_size: tuple[int, int],
    pivot: tuple[int, int],
    pivot_mode: str,
    layer_name: str,
    layer_order: int,
    typography_roles: list[str],
    animation: dict[str, Any],
    runtime_method: str,
    geometry_note: str,
    extraction: str,
) -> dict[str, Any]:
    source_views: list[dict[str, Any]] = []
    for view_id, placement in placements.items():
        placement_record = box(*placement)
        source_views.append({
            "viewId": view_id,
            "stateId": STATE_BY_VIEW[view_id],
            "viewSha256": hashes[view_id],
            "tightSourceBounds": placement_record,
            "viewportPlacementBounds": placement_record,
            "viewportAnchor": viewport_anchor(placement_record, pivot_mode),
            "promptSource": f"$.candidates[id=continuous-causal-village].views[id={view_id}].nativePaintoverPrompt",
        })
    primary = source_views[0]
    state_variants = [
        {
            "stateId": source["stateId"],
            "sourceViewId": source["viewId"],
            "sourceViewSha256": source["viewSha256"],
            "viewportPlacementBounds": source["viewportPlacementBounds"],
            "viewportAnchor": source["viewportAnchor"],
        }
        for source in source_views
    ]
    return {
        "id": component_id,
        "label": label,
        "category": category,
        "sourceViewId": primary["viewId"],
        "sourceViewSha256": primary["viewSha256"],
        "sourceViews": source_views,
        "crop": primary["tightSourceBounds"],
        "placementBounds": primary["viewportPlacementBounds"],
        "stateIds": [source["stateId"] for source in source_views],
        "derivedFromSceneTargetSha256": "",
        "nativeRenderSize": {"width": native_size[0], "height": native_size[1]},
        "runtimeGeometry": {
            "method": runtime_method,
            "frameSize": {"width": native_size[0], "height": native_size[1]},
            "pivot": {"mode": pivot_mode, "x": pivot[0], "y": pivot[1]},
            "targetPlacementIsNotAssetSize": True,
            "note": geometry_note,
        },
        "anchor": {"mode": pivot_mode, "x": pivot[0], "y": pivot[1]},
        "layer": {"name": layer_name, "order": layer_order},
        "stateVariants": state_variants,
        "typographyRoles": typography_roles,
        "animationNeed": animation,
        "sourcePromptPointer": primary["promptSource"],
        "extractionStrategy": extraction,
    }


def placements(rect: tuple[int, int, int, int], view_ids: list[str] | None = None) -> dict[str, tuple[int, int, int, int]]:
    return {view_id: rect for view_id in (view_ids or SELECTED_VIEW_IDS)}


def build_components(hashes: dict[str, str]) -> list[dict[str, Any]]:
    reconstruct = "Reconstruct after scene approval using the declared runtime geometry; the full-screen proposed target is not an isolated or production asset."
    code_ui = "Build after scene approval as deterministic code-native UI using the declared measured bounds, type roles, and one-pixel structural geometry."
    return [
        component(component_id="village-environment", label="Persistent continuous village basis", category="environment", placements=placements((0, 0, 480, 270)), hashes=hashes, native_size=(480, 270), pivot=(0, 0), pivot_mode="top-left", layer_name="environment", layer_order=0, typography_roles=[], animation={"required": True, "beats": ["vane anticipation", "awning response", "offset ambient cloth"], "timing": "state-linked; no synchronized ambient quota"}, runtime_method="raster-after-approval", geometry_note="One actor-free and UI-free 480x270 environment layer; causal overlays are separate.", extraction=reconstruct),
        component(component_id="cauldron", label="Brew cauldron", category="environment-interactable", placements=placements((45, 86, 48, 53), ["continuous-need-disclosed", "continuous-mix-feedback", "continuous-route-pending"]), hashes=hashes, native_size=(32, 32), pivot=(16, 31), pivot_mode="bottom-center", layer_name="environment-interactable", layer_order=20, typography_roles=[], animation={"required": True, "beats": ["idle simmer", "ingredient response", "brew commit", "bottle produced"], "timing": "context action and commit"}, runtime_method="raster-sprite-after-approval", geometry_note="48x53 target placement includes generated shadow and steam; runtime frame is exactly 32x32.", extraction=reconstruct),
        component(component_id="ember-ingredient", label="Angular Ember planter pickup", category="environment-interactable", placements=placements((59, 180, 25, 21), ["continuous-need-disclosed", "continuous-mix-feedback", "continuous-route-pending"]), hashes=hashes, native_size=(16, 16), pivot=(8, 15), pivot_mode="bottom-center", layer_name="environment-interactable", layer_order=20, typography_roles=[], animation={"required": True, "beats": ["idle", "proximity", "picked", "added"], "timing": "context action"}, runtime_method="raster-sprite-after-approval", geometry_note="25x21 target placement includes planter shadow; runtime ingredient frame is 16x16.", extraction=reconstruct),
        component(component_id="moss-ingredient", label="Rounded Moss planter pickup", category="environment-interactable", placements=placements((69, 200, 28, 23), ["continuous-need-disclosed", "continuous-mix-feedback", "continuous-route-pending"]), hashes=hashes, native_size=(16, 16), pivot=(8, 15), pivot_mode="bottom-center", layer_name="environment-interactable", layer_order=20, typography_roles=[], animation={"required": True, "beats": ["idle", "proximity", "picked", "added"], "timing": "context action"}, runtime_method="raster-sprite-after-approval", geometry_note="28x23 target placement includes planter shadow; runtime ingredient frame is 16x16.", extraction=reconstruct),
        component(component_id="courier", label="Courier silhouette, satchel, and carry poses", category="actor", placements={"continuous-need-disclosed": (117, 116, 27, 49), "continuous-mix-feedback": (85, 98, 30, 50), "continuous-route-pending": (174, 141, 29, 50), "continuous-exposed-conversion": (234, 57, 40, 55), "continuous-sheltered-preservation": (260, 150, 43, 61), "continuous-satisfied-delivery": (348, 105, 44, 58), "continuous-imperfect-recovery": (352, 105, 42, 58), "continuous-followup-selection": (310, 169, 32, 52)}, hashes=hashes, native_size=(24, 32), pivot=(12, 31), pivot_mode="bottom-center", layer_name="courier", layer_order=40, typography_roles=[], animation={"required": True, "beats": ["four-direction idle/walk", "carry idle/walk", "interact", "gust brace", "handoff"], "timing": "player movement and causal transitions"}, runtime_method="raster-sprite-sheet-after-approval", geometry_note="Per-state target bounds include generated shadow, carried prop, or pose arc; every runtime character frame remains exactly 24x32.", extraction=reconstruct),
        component(component_id="partner", label="Brew-yard partner", category="actor", placements=placements((91, 105, 30, 50)), hashes=hashes, native_size=(24, 32), pivot=(12, 31), pivot_mode="bottom-center", layer_name="supporting-actors", layer_order=39, typography_roles=[], animation={"required": True, "beats": ["offset idle", "need disclosure"], "timing": "ambient and disclosure"}, runtime_method="raster-sprite-sheet-after-approval", geometry_note="30x50 target bounds include generated shadow; runtime frame is exactly 24x32.", extraction=reconstruct),
        component(component_id="mira", label="Mira recipient and reaction poses", category="actor", placements={"continuous-need-disclosed": (388, 101, 34, 55), "continuous-mix-feedback": (388, 101, 34, 55), "continuous-route-pending": (388, 101, 34, 55), "continuous-exposed-conversion": (388, 101, 34, 55), "continuous-sheltered-preservation": (388, 101, 34, 55), "continuous-satisfied-delivery": (383, 99, 44, 61), "continuous-imperfect-recovery": (383, 99, 44, 61), "continuous-followup-selection": (388, 101, 34, 55)}, hashes=hashes, native_size=(24, 32), pivot=(12, 31), pivot_mode="bottom-center", layer_name="recipient", layer_order=41, typography_roles=[], animation={"required": True, "beats": ["idle", "receive", "relief", "shiver", "settle"], "timing": "handoff precedes reaction copy"}, runtime_method="raster-sprite-sheet-after-approval", geometry_note="Reaction placement includes pose arc; the runtime frame remains exactly 24x32.", extraction=reconstruct),
        component(component_id="bottle", label="Persistent potion bottle and state glyphs", category="prop", placements={"continuous-route-pending": (194, 144, 14, 31), "continuous-exposed-conversion": (257, 72, 14, 28), "continuous-sheltered-preservation": (281, 163, 14, 28), "continuous-satisfied-delivery": (378, 124, 14, 22), "continuous-imperfect-recovery": (380, 124, 14, 22)}, hashes=hashes, native_size=(12, 16), pivot=(6, 15), pivot_mode="bottom-center", layer_name="courier-prop", layer_order=42, typography_roles=[], animation={"required": True, "beats": ["W1/S2", "exchange to W2/S1", "handoff", "consumed"], "timing": "brew commit, route consequence, delivery"}, runtime_method="raster-sprite-sheet-after-approval", geometry_note="Target placement includes state marks and glints; runtime bottle frame is exactly 12x16.", extraction=reconstruct),
        component(component_id="gust-sign", label="Physical Gust route sign", category="interface-world", placements=placements((188, 67, 42, 33)), hashes=hashes, native_size=(32, 16), pivot=(16, 15), pivot_mode="bottom-center", layer_name="interface-world-signage", layer_order=25, typography_roles=["display"], animation={"required": False, "beats": [], "timing": "static identity"}, runtime_method="raster-sprite-after-approval", geometry_note="42x33 target placement includes post and shadow; sign face is 32x16.", extraction=reconstruct),
        component(component_id="shelter-sign", label="Physical Shelter route sign", category="interface-world", placements=placements((208, 173, 56, 34)), hashes=hashes, native_size=(48, 16), pivot=(24, 15), pivot_mode="bottom-center", layer_name="interface-world-signage", layer_order=25, typography_roles=["display"], animation={"required": False, "beats": [], "timing": "static identity"}, runtime_method="raster-sprite-after-approval", geometry_note="56x34 target placement includes post and shadow; sign face is 48x16.", extraction=reconstruct),
        component(component_id="route-effects", label="Gust conversion and shelter preservation effects", category="effect", placements={"continuous-exposed-conversion": (205, 35, 125, 100), "continuous-sheltered-preservation": (242, 128, 105, 93)}, hashes=hashes, native_size=(32, 32), pivot=(16, 16), pivot_mode="center", layer_name="route-effects", layer_order=50, typography_roles=[], animation={"required": True, "beats": ["anticipation", "impact", "state change", "confirmation", "settle"], "timing": "effect never obscures courier or bottle"}, runtime_method="modular-raster-effect-after-approval", geometry_note="Large placement bounds contain multiple 16-32px modules; each runtime effect frame is 32x32, not the scene region.", extraction=reconstruct),
        component(component_id="reaction-effects", label="Relief and shiver effect language", category="effect", placements={"continuous-satisfied-delivery": (376, 72, 82, 91), "continuous-imperfect-recovery": (376, 72, 82, 91)}, hashes=hashes, native_size=(32, 32), pivot=(16, 16), pivot_mode="center", layer_name="reaction-effects-behind-copy", layer_order=49, typography_roles=[], animation={"required": True, "beats": ["handoff", "pose anticipation", "reaction", "settle"], "timing": "pose reads before copy"}, runtime_method="modular-raster-effect-after-approval", geometry_note="Effect placement is distinct from Mira's actor bounds; runtime modules are 32x32.", extraction=reconstruct),
        component(component_id="request-status", label="Request and next-delivery status surface", category="interface", placements=placements((6, 3, 142, 65)), hashes=hashes, native_size=(142, 65), pivot=(0, 0), pivot_mode="top-left", layer_name="request-status", layer_order=80, typography_roles=["body", "caption", "numbers"], animation={"required": True, "beats": ["need reveal", "copy update", "followup transition"], "timing": "temporary compact reminder"}, runtime_method="code-native-ui", geometry_note="Exact maximum code-native footprint; target and runtime footprint match.", extraction=code_ui),
        component(component_id="carried-status", label="Conditional bottle-state badge", category="interface", placements=placements((340, 3, 136, 66), ["continuous-route-pending", "continuous-exposed-conversion", "continuous-sheltered-preservation"]), hashes=hashes, native_size=(136, 66), pivot=(0, 0), pivot_mode="top-left", layer_name="carried-status", layer_order=81, typography_roles=["body", "caption", "numbers"], animation={"required": True, "beats": ["appear after bottle", "state exchange", "withdraw after handoff"], "timing": "mirrors physical bottle"}, runtime_method="code-native-ui", geometry_note="Exact code-native footprint.", extraction=code_ui),
        component(component_id="causal-feedback", label="Temporary causal feedback strip", category="interface", placements={"continuous-mix-feedback": (6, 222, 286, 43), "continuous-exposed-conversion": (6, 222, 286, 43), "continuous-sheltered-preservation": (6, 222, 254, 43)}, hashes=hashes, native_size=(286, 43), pivot=(0, 0), pivot_mode="top-left", layer_name="temporary-feedback", layer_order=82, typography_roles=["body", "caption", "numbers"], animation={"required": True, "beats": ["slide in", "hold", "withdraw"], "timing": "after physical response"}, runtime_method="code-native-nine-slice-ui", geometry_note="286x43 is the maximum footprint; sheltered state contracts to 254x43 with preserved corners.", extraction=code_ui),
        component(component_id="delivery-comparison", label="Arrived-state comparison surface", category="interface", placements=placements((6, 205, 228, 60), ["continuous-satisfied-delivery", "continuous-imperfect-recovery"]), hashes=hashes, native_size=(228, 60), pivot=(0, 0), pivot_mode="top-left", layer_name="temporary-feedback", layer_order=82, typography_roles=["body", "caption", "numbers"], animation={"required": True, "beats": ["appear after reaction", "hold", "withdraw"], "timing": "physical reaction precedes explanation"}, runtime_method="code-native-ui", geometry_note="Exact code-native footprint.", extraction=code_ui),
        component(component_id="ember-context-label", label="Ember world label", category="interface-world", placements={"continuous-need-disclosed": (45, 168, 48, 18)}, hashes=hashes, native_size=(48, 18), pivot=(24, 17), pivot_mode="bottom-center", layer_name="interface-world-signage", layer_order=45, typography_roles=["caption"], animation={"required": False, "beats": [], "timing": "need disclosure"}, runtime_method="code-native-ui", geometry_note="Exact code-native footprint attached to Ember planter.", extraction=code_ui),
        component(component_id="moss-context-label", label="Moss world label", category="interface-world", placements={"continuous-need-disclosed": (47, 190, 41, 18), "continuous-mix-feedback": (66, 191, 41, 18)}, hashes=hashes, native_size=(41, 18), pivot=(20, 17), pivot_mode="bottom-center", layer_name="interface-world-signage", layer_order=45, typography_roles=["caption"], animation={"required": False, "beats": [], "timing": "need and proximity"}, runtime_method="code-native-ui", geometry_note="Exact code-native footprint attached to Moss planter.", extraction=code_ui),
        component(component_id="world-action-cue", label="World-anchored context action cue", category="interface-world", placements={"continuous-need-disclosed": (104, 170, 46, 19), "continuous-mix-feedback": (96, 74, 46, 19), "continuous-followup-selection": (270, 190, 38, 19)}, hashes=hashes, native_size=(46, 19), pivot=(23, 18), pivot_mode="bottom-center", layer_name="interface-world-signage", layer_order=46, typography_roles=["action"], animation={"required": True, "beats": ["appear in proximity", "tighten", "resolve"], "timing": "context proximity"}, runtime_method="code-native-nine-slice-ui", geometry_note="46x19 is the maximum footprint; E GO contracts to 38x19.", extraction=code_ui),
        component(component_id="reaction-label", label="World-adjacent reaction label", category="interface-world", placements=placements((382, 73, 72, 24), ["continuous-satisfied-delivery", "continuous-imperfect-recovery"]), hashes=hashes, native_size=(72, 24), pivot=(36, 23), pivot_mode="bottom-center", layer_name="temporary-feedback", layer_order=82, typography_roles=["body"], animation={"required": True, "beats": ["appear after pose", "withdraw"], "timing": "pose precedes label"}, runtime_method="code-native-ui", geometry_note="Exact code-native footprint separate from Mira and reaction effects.", extraction=code_ui),
        component(component_id="sunmill-pennant", label="Physical Sunmill follow-up pennant", category="interface-world", placements={"continuous-followup-selection": (329, 156, 39, 56)}, hashes=hashes, native_size=(16, 24), pivot=(8, 23), pivot_mode="bottom-center", layer_name="interface-world-signage", layer_order=25, typography_roles=["display"], animation={"required": True, "beats": ["available", "proximity", "selected", "transition"], "timing": "movement selection"}, runtime_method="raster-sprite-sheet-after-approval", geometry_note="39x56 target placement includes post, label, and glow; runtime pennant frame is 16x24.", extraction=reconstruct),
        component(component_id="herbalist-pennant", label="Physical Herbalist follow-up pennant", category="interface-world", placements={"continuous-followup-selection": (365, 174, 40, 41)}, hashes=hashes, native_size=(16, 24), pivot=(8, 23), pivot_mode="bottom-center", layer_name="interface-world-signage", layer_order=25, typography_roles=["display"], animation={"required": True, "beats": ["available", "proximity", "selected", "dimmed alternative"], "timing": "movement selection"}, runtime_method="raster-sprite-sheet-after-approval", geometry_note="40x41 target placement includes post and label; runtime pennant frame is 16x24.", extraction=reconstruct),
        component(component_id="sunmill-info-sign", label="Sunmill need tag flanking the physical pennant", category="interface-world", placements={"continuous-followup-selection": (250, 151, 58, 34)}, hashes=hashes, native_size=(58, 34), pivot=(29, 17), pivot_mode="center", layer_name="interface-world-signage", layer_order=45, typography_roles=["caption", "numbers"], animation={"required": True, "beats": ["activate", "selected border", "withdraw"], "timing": "follow-up disclosure"}, runtime_method="code-native-ui", geometry_note="Exact footprint; deliberately outside courier, pennant, and corridor bounds.", extraction=code_ui),
        component(component_id="herbalist-info-sign", label="Herbalist need tag flanking the physical pennant", category="interface-world", placements={"continuous-followup-selection": (407, 151, 67, 34)}, hashes=hashes, native_size=(67, 34), pivot=(33, 17), pivot_mode="center", layer_name="interface-world-signage", layer_order=45, typography_roles=["caption", "numbers"], animation={"required": True, "beats": ["activate", "available border", "dimmed alternative"], "timing": "follow-up disclosure"}, runtime_method="code-native-ui", geometry_note="Exact footprint; deliberately outside courier, pennant, and corridor bounds.", extraction=code_ui),
    ]


def canonical_sha256(value: Any) -> str:
    serialized = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha256_text(serialized)


def build_state_contracts() -> list[dict[str, Any]]:
    return [
        {"id": "need-disclosed", "viewId": "continuous-need-disclosed", "playerQuestion": "What does Mira need, and what can change the potion?", "primaryAction": "Move among Ember, Moss, and the cauldron.", "essentialInformation": ["Mira needs 2 Warmth and 1 Soothing", "Ember adds warmth", "Moss adds soothing"], "actors": ["courier", "partner", "Mira", "ingredient stations", "cauldron"], "persistentContext": "The navigable village, both routes, and Mira remain visible."},
        {"id": "mix-feedback", "viewId": "continuous-mix-feedback", "playerQuestion": "What did this ingredient add, and should I add another?", "primaryAction": "Add Ember or Moss at the reachable brew object.", "essentialInformation": ["Moss was added", "Brew is now 1 Warmth and 2 Soothing", "Mira's need remains visible"], "actors": ["courier", "partner", "ingredient station", "cauldron"], "persistentContext": "The fixed village and future delivery route remain present."},
        {"id": "route-pending", "viewId": "continuous-route-pending", "playerQuestion": "What is in the bottle, and which physical route should I take?", "primaryAction": "Carry 1 Warmth and 2 Soothing toward the exposed or sheltered path.", "essentialInformation": ["Bottle is 1 Warmth and 2 Soothing", "Gust route can change it", "Shelter route can preserve it"], "actors": ["courier with bottle", "partner", "Mira", "route landmarks"], "persistentContext": "Both route counterfactuals and Mira are simultaneously visible."},
        {"id": "exposed-conversion", "viewId": "continuous-exposed-conversion", "playerQuestion": "What did the gust change?", "primaryAction": "Continue through the exposed path to Mira.", "essentialInformation": ["Carried state became 2 Warmth and 1 Soothing", "+1 Warmth and -1 Soothing", "Exposed route caused the exchange"], "actors": ["courier", "bottle", "gust landmark", "Mira"], "persistentContext": "The request remains visible while the world effect acts first."},
        {"id": "sheltered-preservation", "viewId": "continuous-sheltered-preservation", "playerQuestion": "Was the potion preserved?", "primaryAction": "Continue under the shelter to Mira.", "essentialInformation": ["Carried state remains 1 Warmth and 2 Soothing", "Shelter preserved the bottle", "Preservation receives affirmative feedback"], "actors": ["courier", "bottle", "shelter landmark", "Mira"], "persistentContext": "The request remains visible while the lock/check effect confirms preservation."},
        {"id": "satisfied-delivery", "viewId": "continuous-satisfied-delivery", "playerQuestion": "Why did Mira approve?", "primaryAction": "Observe the physical relief, then prepare to move to a follow-up.", "essentialInformation": ["Mira needed 2 Warmth and 1 Soothing", "2 Warmth and 1 Soothing arrived", "The delivery is an exact match"], "actors": ["courier", "Mira", "bottle handoff"], "persistentContext": "The route and village remain spatially connected to the result."},
        {"id": "imperfect-recovery", "viewId": "continuous-imperfect-recovery", "playerQuestion": "What mismatched, and how can that knowledge help next?", "primaryAction": "Observe the attributed shiver, then recover through the next embodied choice.", "essentialInformation": ["Mira needed 2 Warmth and 1 Soothing", "1 Warmth and 2 Soothing arrived", "The mismatch is recoverable"], "actors": ["courier", "Mira", "bottle handoff"], "persistentContext": "No modal failure interrupts the fixed village."},
        {"id": "followup-selection", "viewId": "continuous-followup-selection", "playerQuestion": "Which next request benefits from what I learned?", "primaryAction": "Walk to Sunmill or Herbalist and use the nearby context action.", "essentialInformation": ["Sunmill needs 3 Warmth and 0 Soothing", "Herbalist needs 1 Warmth and 2 Soothing", "Gust changes and shelter preserves"], "actors": ["visible courier", "Mira", "Sunmill pennant", "Herbalist pennant"], "persistentContext": "Both physical destinations, their movement corridor, and the prior village remain visible."},
    ]


def target_fingerprint_payload(manifest: dict[str, Any]) -> dict[str, Any]:
    selected = next(candidate for candidate in manifest["candidates"] if candidate["id"] == manifest["selectedCandidateId"])
    selected_views = [
        {
            "id": view["id"],
            "state": view["state"],
            "required": view["required"],
            "viewSha256": view["sha256"],
            "generationPromptSha256": sha256_text(view["prompt"]),
            "nativePaintoverPromptSha256": sha256_text(view["nativePaintoverPrompt"]),
        }
        for view in selected["views"]
    ]
    component_identity = []
    for entry in manifest["components"]:
        identity = deepcopy(entry)
        identity.pop("derivedFromSceneTargetSha256", None)
        component_identity.append(identity)
    return {
        "apiVersion": manifest["apiVersion"],
        "sceneTargetId": manifest["id"],
        "selectedCandidateId": manifest["selectedCandidateId"],
        "selectedViews": selected_views,
        "experience": manifest["experience"],
        "nativeGeometry": manifest["nativeGeometry"],
        "components": component_identity,
    }


def update_manifest(hashes: dict[str, str], typography_checks: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    manifest["version"] = "1.2.1"
    for candidate in manifest["candidates"]:
        for view in candidate["views"]:
            view_id = view["id"]
            view["sha256"] = hashes[view_id]
            view["nativeSize"] = {"width": 480, "height": 270}
            view["authoringMode"] = "native-480x270-pixel-spec-composite"
            view["referenceViewPath"] = f"design/scene-targets/reference-views/{view_id}.png"
            view["referenceViewSha256"] = sha256_file(REFERENCE_VIEWS / f"{view_id}.png")
            view["review3xPath"] = f"design/scene-targets/review-3x/{view_id}.png"
            view["review3xSha256"] = sha256_file(REVIEW_3X / f"{view_id}.png")
            view["nativePaintoverPrompt"] = PAINTOVER_PROMPTS[view_id]
            view["typographyChecks"] = typography_checks[view_id]
        candidate["candidateSha256"] = canonical_sha256([
            {
                "id": view["id"],
                "state": view["state"],
                "viewSha256": view["sha256"],
                "generationPromptSha256": sha256_text(view["prompt"]),
                "nativePaintoverPromptSha256": sha256_text(view["nativePaintoverPrompt"]),
            }
            for view in candidate["views"]
        ])

    manifest["components"] = build_components(hashes)
    region_repairs = {
        "request-status": {"x": 6, "y": 3, "width": 142, "height": 65},
        "followup-status": {"x": 6, "y": 3, "width": 142, "height": 65},
        "carried-status": {"x": 340, "y": 3, "width": 136, "height": 66},
        "feedback": {"x": 6, "y": 222, "width": 286, "height": 43},
        "reaction-comparison": {"x": 6, "y": 205, "width": 228, "height": 60},
        "brew-context": {"x": 36, "y": 82, "width": 116, "height": 138},
        "route-context": {"x": 150, "y": 70, "width": 152, "height": 142},
        "followup-context": {"x": 250, "y": 145, "width": 224, "height": 116},
    }
    for region in manifest["experience"]["composition"]["regions"]:
        if region["id"] in region_repairs:
            region["rect"] = region_repairs[region["id"]]
    manifest["experience"]["states"] = build_state_contracts()
    manifest["experience"]["composition"]["protectedGeometryByView"] = [
        {"viewId": view_id, "stateId": STATE_BY_VIEW[view_id], "items": items}
        for view_id, items in PROTECTED_GEOMETRY.items()
    ]
    manifest["experience"]["composition"]["uiRectanglesByView"] = [
        {
            "viewId": view_id,
            "stateId": STATE_BY_VIEW[view_id],
            "items": [
                {"role": check["role"], "rect": check["rect"]}
                for check in typography_checks[view_id]
            ],
        }
        for view_id in SELECTED_VIEW_IDS
    ]
    manifest["experience"]["continuity"] = {
        "persistentWorldBasisPath": "design/scene-targets/continuity-source/continuous-world-basis.png",
        "persistentWorldBasisSha256": sha256_file(CONTINUITY_SOURCE),
        "basisClassification": "derived-whole-screen-scene-basis; proposed target input only; not an isolated or production asset",
        "dynamicPatchesByView": [
            {"viewId": view_id, "stateId": STATE_BY_VIEW[view_id], "allowedCausalBounds": patches}
            for view_id, patches in DYNAMIC_PATCHES.items()
        ],
        "rule": "Environment pixels outside declared causal actor/effect patches and measured UI rectangles must remain identical across adjacent target states.",
    }
    manifest["nativeGeometry"] = {
        "viewport": {"width": 480, "height": 270},
        "shippingPresentation": {"width": 1440, "height": 810, "scale": 3, "filter": "nearest-neighbor"},
        "authoring": {
            "mode": "native-pixel-spec-paintover",
            "authoritativeSourceSize": {"width": 480, "height": 270},
            "referenceSourceSize": {"width": 480, "height": 270},
            "referenceClassification": "generated-normalized-whole-screen-reference plus deterministic persistent-world scene basis",
            "continuitySourcePath": "design/scene-targets/continuity-source/continuous-world-basis.png",
            "continuitySourceSha256": sha256_file(CONTINUITY_SOURCE),
            "rule": "Only exact 480x270 geometry, the persistent-world basis, and integer 3x presentations are authoritative for decomposition; the earlier 1672x941 generated sources remain non-authoritative composition references.",
        },
        "baseUnitPx": 4,
        "borderWidthsPx": [1, 2],
        "insetsPx": {"compact": 4, "reading": 6},
        "typographyPx": {"display": 10, "body": 12, "feedback": 12, "numeral": 12, "caption": 11, "action": 11},
        "lineHeightsPx": {"body": 16, "feedback": 16, "caption": 14},
        "previewFont": {"family": "Segoe UI", "source": "host system font; not copied or licensed as a game asset", "runtimeRequirement": "Bundle a license-compatible humanist sans matched to these measured bounds before production integration."},
        "landmarkAnchors": {
            "cauldron": {"x": 65, "y": 121},
            "emberPlanter": {"x": 72, "y": 191},
            "mossPlanter": {"x": 83, "y": 213},
            "gustThreshold": {"x": 222, "y": 92},
            "shelterThreshold": {"x": 236, "y": 184},
            "miraDoor": {"x": 405, "y": 151},
            "sunmillPennant": {"x": 348, "y": 212},
            "herbalistPennant": {"x": 385, "y": 215},
        },
        "layerStack": [
            {"order": 0, "name": "environment"},
            {"order": 20, "name": "environment-interactable"},
            {"order": 25, "name": "interface-world-signage"},
            {"order": 39, "name": "supporting-actors"},
            {"order": 40, "name": "courier"},
            {"order": 41, "name": "recipient"},
            {"order": 42, "name": "courier-prop"},
            {"order": 45, "name": "world-context-labels"},
            {"order": 46, "name": "world-action-cue"},
            {"order": 49, "name": "reaction-effects-behind-copy"},
            {"order": 50, "name": "route-effects"},
            {"order": 80, "name": "request-status"},
            {"order": 81, "name": "carried-status"},
            {"order": 82, "name": "temporary-feedback"},
        ],
        "scalingRules": [
            "Author and inspect at exact 480x270.",
            "Present at exact integer 3x to 1440x810 with nearest-neighbor filtering.",
            "Snap camera, sprites, UI bounds, and authored effects to whole native pixels.",
            "Use code-native text at the declared sizes; never resample target-rendered lettering into production.",
            "After approval, reconstructed raster motifs must render 1:1 or use declared integer/nine-slice geometry that preserves corners.",
        ],
    }

    metadata = manifest["metadata"]
    metadata["generationTool"] = "built-in image_gen references plus deterministic Pillow native-spec recomposition"
    metadata["nativeSpecBuilder"] = "design/scene-targets/build_native_targets.py"
    metadata["revision"] = {
        "version": "1.2.1",
        "hypothesis": "The accepted fixed-camera direction remains decomposable when authoritative primary-view identity, semantically exact pivots, and anchor-reconstructed placement evidence are enforced without reopening its camera or topology.",
        "scope": ["authoritative-primary-view-identity", "semantic-runtime-pivots", "authoritative-parser-validation", "anchor-derived-overlay-regression"],
    }
    for review in metadata.get("candidateReviews", []):
        if review.get("candidateId") == "continuous-causal-village":
            surface_count = sum(len(checks) for view_id, checks in typography_checks.items() if view_id in SELECTED_VIEW_IDS)
            review["legibility"] = f"Pass for proposal: {surface_count} selected-state reading surfaces use declared 11-12px roles with measured contrast and zero clipping in native captures."
            review["overlaps"] = "Pass for proposal: measured UI rectangles have zero intersections with protected actor, landmark, and movement-corridor geometry; playfield overlap is not treated as blanket permission."
        elif review.get("candidateId") == "courier-following-village-rooms":
            review["legibility"] = "Pass for comparison: the same measured native request and carried-state system is demonstrated at 480x270 and exact 3x presentation."
    metadata["referenceViews"] = [
        {
            "path": f"design/scene-targets/reference-views/{view_id}.png",
            "sha256": sha256_file(REFERENCE_VIEWS / f"{view_id}.png"),
            "classification": "generated-normalized-whole-screen-reference",
        }
        for view_id in VIEW_IDS
    ]
    metadata["normalization"] = {
        "status": "superseded-for-decomposition",
        "generatedSourceSize": {"width": 1672, "height": 941},
        "earlierReviewSize": {"width": 480, "height": 270},
        "nonIntegerReduction": True,
        "repair": "The generated sources now serve only as complete-scene composition references. Every selected state starts from one persistent 480x270 world basis, then admits only declared causal actor/effect patches and measured UI; 3x review files are exact nearest-neighbor presentations.",
    }
    metadata["selectedViewReviews"] = [
        {
            "viewId": view_id,
            "result": "proposed-after-native-repair",
            "finding": {
                "continuous-need-disclosed": "Both ingredient cues stay at the brew yard, and the detailed lower-right roof geometry is inherited unchanged from the persistent world basis.",
                "continuous-mix-feedback": "Moss identity, a relocated unobscuring E ADD cue, cauldron response, and two-line causal feedback share one readable brew context.",
                "continuous-route-pending": "Measured request/carried surfaces leave both embodied route counterfactuals unobscured.",
                "continuous-exposed-conversion": "World action remains primary; measured copy confirms the visible W1/S2 to W2/S1 change.",
                "continuous-sheltered-preservation": "Positive preservation feedback is readable and does not substitute for the in-world lock/check response.",
                "continuous-satisfied-delivery": "Relief pose precedes readable arrived-state and exact-match attribution.",
                "continuous-imperfect-recovery": "Distinct shiver pose precedes readable mismatch attribution and preserves recovery.",
                "continuous-followup-selection": "The courier, both physical pennants, and the walking corridor remain visible; compact need tags flank protected geometry and E GO sits beside the courier.",
            }[view_id],
        }
        for view_id in SELECTED_VIEW_IDS
    ]
    metadata["limitations"] = [
        "Deterministic engine captures prove causal execution, not human comprehension or fun.",
        "These files are proposed whole-screen targets and native geometry specifications, not running Godot captures or production assets.",
        "The generated village imagery remains a composition reference; downstream art must be reconstructed at native or declared integer scale after approval.",
        "Segoe UI is used only to measure and demonstrate the humanist typography role in these target files; production integration must bundle a license-compatible matched font.",
        "No isolated, extracted, engine-ready, or production component exists before scene-target approval.",
    ]

    selected_candidate = next(candidate for candidate in manifest["candidates"] if candidate["id"] == manifest["selectedCandidateId"])
    selected_primary = selected_candidate["primaryViewId"]
    selected_primary_sha = hashes[selected_primary]
    complete_target_sha = canonical_sha256(target_fingerprint_payload(manifest))
    for entry in manifest["components"]:
        entry["derivedFromSceneTargetSha256"] = selected_primary_sha
    manifest["selectedTargetFingerprint"] = {
        "algorithm": "sha256",
        "canonicalization": "UTF-8 JSON with sorted keys and compact separators",
        "coverage": ["all required selected-view hashes", "generation and native-paintover prompt identities", "experience contract", "native geometry", "component map excluding its lineage field"],
        "sha256": complete_target_sha,
    }
    manifest["approval"] = {
        "status": "needs-revision",
        "reviewer": "pending-scene-target-gate",
        "selectedTargetId": manifest["selectedCandidateId"],
        "selectedPrimaryViewId": selected_primary,
        "selectedPrimaryViewSha256": selected_primary_sha,
        "selectedCandidateSha256": selected_candidate["candidateSha256"],
        "selectedTargetSha256": selected_primary_sha,
        "findings": [
            "Proposed selection remains continuous-causal-village because both embodied route counterfactuals and the recipient remain attributable in one fixed view.",
            "All eight selected views share one persistent world basis, admit only declared causal patches, and have exact native plus integer-3x review presentations.",
            "Follow-up need tags flank protected geometry; the courier, both physical pennants, selection differentiation, E GO cue, and walking corridor remain simultaneously visible.",
            "Every component separates tight per-state target placement from expected runtime frame size and uses a pivot that exactly matches its declared top-left, center, or bottom-center semantics.",
            "Authoritative contract identity and all component lineage use the selected primary-view SHA-256; a separate complete-target fingerprint covers all required view hashes, prompt identities, experience rules, native geometry, and the component map.",
            "All eight component overlays are rebuilt from declared viewport anchors and checked for exact placement reconstruction, clipping, protected-geometry intersections, and off-viewport bounds.",
            "Generated scenes and native paintovers remain proposed whole-screen targets only; component.production is absent and no production asset claim is made.",
            "Approval remains pending scene-target-gate review.",
        ],
    }
    return manifest


def expanded_rect(rect: dict[str, int], right: int = 2, bottom: int = 2) -> dict[str, int]:
    return box(rect["x"], rect["y"], rect["width"] + right, rect["height"] + bottom)


def intersects(left: dict[str, int], right: dict[str, int]) -> bool:
    return (
        left["x"] < right["x"] + right["width"]
        and right["x"] < left["x"] + left["width"]
        and left["y"] < right["y"] + right["height"]
        and right["y"] < left["y"] + left["height"]
    )


def write_component_overlays(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    COMPONENT_OVERLAYS.mkdir(parents=True, exist_ok=True)
    COMPONENT_OVERLAYS_3X.mkdir(parents=True, exist_ok=True)
    color_by_category = {
        "actor": "#FFF3CE",
        "prop": "#F3B94E",
        "environment-interactable": "#E66A3C",
        "interface-world": "#83C9A0",
        "interface": "#B7DCE1",
        "effect": "#C97878",
        "environment": "#8467A8",
    }
    records: list[dict[str, Any]] = []
    for view_id in SELECTED_VIEW_IDS:
        base = Image.open(VIEWS / f"{view_id}.png").convert("RGBA")
        overlay = Image.new("RGBA", NATIVE_SIZE, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        components_in_view = []
        for entry in manifest["components"]:
            source = next((item for item in entry["sourceViews"] if item["viewId"] == view_id), None)
            if source is None:
                continue
            rect = source["viewportPlacementBounds"]
            anchor = source["viewportAnchor"]
            reconstructed = bounds_from_viewport_anchor(anchor, rect["width"], rect["height"])
            if reconstructed != rect:
                raise ValueError(f"{view_id}/{entry['id']}: viewport anchor reconstructs {reconstructed}, expected {rect}")
            color = color_by_category.get(entry["category"], "#FFFFFF")
            x0, y0 = rect["x"], rect["y"]
            x1, y1 = x0 + rect["width"] - 1, y0 + rect["height"] - 1
            if entry["category"] == "environment":
                draw.rectangle((x0, y0, x1, y1), outline=color, width=1)
            else:
                fill = color + "26"
                draw.rectangle((x0, y0, x1, y1), fill=fill, outline=color, width=1)
                label = entry["id"]
                label_box = draw.textbbox((0, 0), label, font=FONT_DISPLAY)
                label_width = label_box[2] - label_box[0] + 4
                label_height = label_box[3] - label_box[1] + 3
                label_x = max(0, min(x0, NATIVE_SIZE[0] - label_width))
                label_y = max(0, y0 - label_height)
                draw.rectangle((label_x, label_y, label_x + label_width, label_y + label_height), fill=PALETTE["ink"] + "E6")
                draw.text((label_x + 2, label_y), label, font=FONT_DISPLAY, fill=color)
            anchor_x = anchor["x"]
            anchor_y = anchor["y"]
            if 0 <= anchor_x < NATIVE_SIZE[0] and 0 <= anchor_y < NATIVE_SIZE[1]:
                draw.line((max(0, anchor_x - 2), anchor_y, min(NATIVE_SIZE[0] - 1, anchor_x + 2), anchor_y), fill=color, width=1)
                draw.line((anchor_x, max(0, anchor_y - 2), anchor_x, min(NATIVE_SIZE[1] - 1, anchor_y + 2)), fill=color, width=1)
            components_in_view.append({
                "componentId": entry["id"],
                "viewportPlacementBounds": rect,
                "viewportAnchor": anchor,
                "placementReconstructedFromViewportAnchor": reconstructed,
                "placementReconstructionExact": reconstructed == rect,
                "nativeRenderSize": entry["nativeRenderSize"],
                "runtimePivot": entry["runtimeGeometry"]["pivot"],
            })
        composed = Image.alpha_composite(base, overlay).convert("RGB")
        native_path = COMPONENT_OVERLAYS / f"{view_id}.png"
        review_path = COMPONENT_OVERLAYS_3X / f"{view_id}.png"
        composed.save(native_path, format="PNG", optimize=False)
        composed.resize(SHIP_SIZE, Image.Resampling.NEAREST).save(review_path, format="PNG", optimize=False)
        records.append({
            "viewId": view_id,
            "path": f"design/scene-targets/component-overlays/{view_id}.png",
            "sha256": sha256_file(native_path),
            "review3xPath": f"design/scene-targets/component-overlays-3x/{view_id}.png",
            "review3xSha256": sha256_file(review_path),
            "components": components_in_view,
        })
    return records


def write_continuity_masks(typography_checks: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    CONTINUITY_MASKS.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    for start_view, end_view in CONTINUITY_TRANSITIONS:
        start = Image.open(VIEWS / f"{start_view}.png").convert("RGB")
        end = Image.open(VIEWS / f"{end_view}.png").convert("RGB")
        difference = ImageChops.difference(start, end)
        allowed = Image.new("L", NATIVE_SIZE, 0)
        allowed_draw = ImageDraw.Draw(allowed)
        allowed_rects = [
            *DYNAMIC_PATCHES[start_view],
            *DYNAMIC_PATCHES[end_view],
            *[expanded_rect(check["rect"]) for check in typography_checks[start_view]],
            *[expanded_rect(check["rect"]) for check in typography_checks[end_view]],
        ]
        for rect in allowed_rects:
            allowed_draw.rectangle((rect["x"], rect["y"], rect["x"] + rect["width"] - 1, rect["y"] + rect["height"] - 1), fill=255)
        diff_pixels = list(difference.getdata())
        allowed_pixels = list(allowed.getdata())
        unexpected = [index for index, (pixel, permitted) in enumerate(zip(diff_pixels, allowed_pixels, strict=True)) if pixel != (0, 0, 0) and permitted == 0]
        mask = Image.new("RGB", NATIVE_SIZE, PALETTE["ink"])
        mask_pixels = mask.load()
        for index, permitted in enumerate(allowed_pixels):
            x, y = index % NATIVE_SIZE[0], index // NATIVE_SIZE[0]
            if permitted:
                mask_pixels[x, y] = tuple(int(PALETTE["deep_slate"][channel : channel + 2], 16) for channel in (1, 3, 5))
        for index in unexpected:
            x, y = index % NATIVE_SIZE[0], index // NATIVE_SIZE[0]
            mask_pixels[x, y] = (255, 0, 255)
        path = CONTINUITY_MASKS / f"{start_view}--to--{end_view}.png"
        mask.save(path, format="PNG", optimize=False)
        records.append({
            "startViewId": start_view,
            "endViewId": end_view,
            "path": f"design/scene-targets/continuity-masks/{path.name}",
            "sha256": sha256_file(path),
            "unexpectedEnvironmentPixelChanges": len(unexpected),
            "allowedCausalAndUiRectangles": allowed_rects,
            "legend": {"unchangedEnvironment": PALETTE["ink"], "excludedCausalOrUiRegion": PALETTE["deep_slate"], "unexpectedEnvironmentChange": "#FF00FF"},
        })
    return records


def invoke_authoritative_scene_target_parser() -> dict[str, Any]:
    contract_source = ROOT.parents[3] / "packages" / "design-sdk" / "src" / "scene-target.ts"
    parser_candidates = [contract_source.parent.parent / "dist" / "scene-target.js"]
    tsc_command = shutil.which("tsc")
    if tsc_command:
        tool_repo = Path(tsc_command).parent.parent.parent
        parser_candidates.append(tool_repo / "packages" / "design-sdk" / "dist" / "scene-target.js")
    compiled_parser = next((candidate for candidate in parser_candidates if candidate.is_file()), None)
    node_command = shutil.which("node")
    base_result = {
        "contract": "@gamefactory/design-sdk parseSceneTarget",
        "sourceContractSha256": sha256_file(contract_source) if contract_source.is_file() else None,
    }
    if compiled_parser is None:
        return {**base_result, "result": "fail", "error": "authoritative compiled parser is unavailable"}
    if node_command is None:
        return {**base_result, "result": "fail", "error": "Node.js is unavailable for authoritative parsing"}

    parser_program = compiled_parser.read_text(encoding="utf-8")
    runner = """
import { readFile as readSceneTargetManifest } from "node:fs/promises";
const rawSceneTargetManifest = JSON.parse(await readSceneTargetManifest(process.argv[2], "utf8"));
const parsedSceneTargetManifest = parseSceneTarget(rawSceneTargetManifest);
const selectedSceneTargetRecord = selectedSceneTarget(parsedSceneTargetManifest);
const selectedPrimarySha256 = selectedSceneTargetRecord.view.sha256;
const componentLineageCount = parsedSceneTargetManifest.components.filter((entry) => entry.derivedFromSceneTargetSha256 === selectedPrimarySha256).length;
process.stdout.write(JSON.stringify({
  result: "pass",
  apiVersion: parsedSceneTargetManifest.apiVersion,
  selectedCandidateId: selectedSceneTargetRecord.candidate.id,
  selectedPrimaryViewId: selectedSceneTargetRecord.view.id,
  selectedPrimaryViewSha256: selectedPrimarySha256,
  approvalSelectedTargetSha256: parsedSceneTargetManifest.approval.selectedTargetSha256,
  componentLineageCount,
  componentCount: parsedSceneTargetManifest.components.length
}));
"""
    with tempfile.TemporaryDirectory(prefix=".authoritative-parser-", dir=ROOT) as temporary_directory:
        runner_path = Path(temporary_directory) / "authoritative-scene-target-parser.mjs"
        runner_path.write_text(parser_program + "\n" + runner, encoding="utf-8")
        completed = subprocess.run(
            [node_command, str(runner_path), str(MANIFEST_PATH)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
    if completed.returncode != 0:
        error_line = next(
            (line.strip().removeprefix("Error: ") for line in completed.stderr.splitlines() if line.strip().startswith("Error: ")),
            f"authoritative parser exited with code {completed.returncode}",
        )
        return {
            **base_result,
            "compiledParserSha256": sha256_file(compiled_parser),
            "result": "fail",
            "error": error_line,
        }
    try:
        parser_result = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {
            **base_result,
            "compiledParserSha256": sha256_file(compiled_parser),
            "result": "fail",
            "error": "authoritative parser returned non-JSON output",
        }
    return {
        **base_result,
        "compiledParserSha256": sha256_file(compiled_parser),
        **parser_result,
    }


def validate(manifest: dict[str, Any], hashes: dict[str, str], typography_checks: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    view_findings: list[dict[str, Any]] = []
    errors: list[str] = []

    for view_id in VIEW_IDS:
        native_path = VIEWS / f"{view_id}.png"
        review_path = REVIEW_3X / f"{view_id}.png"
        native = Image.open(native_path).convert("RGB")
        review = Image.open(review_path).convert("RGB")
        if native.size != NATIVE_SIZE:
            errors.append(f"{view_id}: native size {native.size}")
        if review.size != SHIP_SIZE:
            errors.append(f"{view_id}: review size {review.size}")
        downsampled = review.resize(NATIVE_SIZE, Image.Resampling.NEAREST)
        if list(downsampled.getdata()) != list(native.getdata()):
            errors.append(f"{view_id}: 3x presentation is not an exact nearest-neighbor expansion")
        if sha256_file(native_path) != hashes[view_id]:
            errors.append(f"{view_id}: recorded native hash mismatch")
        view_findings.append({"viewId": view_id, "nativeSize": {"width": native.width, "height": native.height}, "nativeSha256": hashes[view_id], "review3xSize": {"width": review.width, "height": review.height}, "review3xSha256": sha256_file(review_path), "integerScaleVerified": True})

    if manifest.get("apiVersion") != "gamefactory.scene-target/v1":
        errors.append("manifest apiVersion is not gamefactory.scene-target/v1")
    selected_candidate = next((item for item in manifest.get("candidates", []) if item.get("id") == manifest.get("selectedCandidateId")), None)
    if selected_candidate is None:
        errors.append("selected candidate does not exist")
        selected_primary_hash = ""
    else:
        selected_primary = next((item for item in selected_candidate.get("views", []) if item.get("id") == selected_candidate.get("primaryViewId")), None)
        selected_primary_hash = selected_primary["sha256"] if selected_primary else ""
        if selected_primary is None:
            errors.append("selected primary view does not exist")
        if len(selected_candidate.get("views", [])) != 8:
            errors.append("selected candidate must contain all eight required state variants")
    if len(manifest.get("candidates", [])) < 2:
        errors.append("fewer than two complete route-pending directions are preserved")

    fingerprint_payload = target_fingerprint_payload(manifest)
    complete_target_hash = canonical_sha256(fingerprint_payload)
    if manifest["approval"].get("selectedPrimaryViewSha256") != selected_primary_hash:
        errors.append("approval selectedPrimaryViewSha256 does not match the selected primary view")
    if manifest["approval"].get("selectedTargetSha256") != selected_primary_hash:
        errors.append("approval selectedTargetSha256 does not match the selected primary view")
    if manifest.get("selectedTargetFingerprint", {}).get("sha256") != complete_target_hash:
        errors.append("selectedTargetFingerprint does not match the canonical complete-target fingerprint")

    authoritative_parser = invoke_authoritative_scene_target_parser()
    if authoritative_parser.get("result") != "pass":
        errors.append(f"authoritative parseSceneTarget failed: {authoritative_parser.get('error', 'unknown error')}")

    view_mutation = deepcopy(fingerprint_payload)
    view_mutation["selectedViews"][0]["viewSha256"] = "0" * 64
    experience_mutation = deepcopy(fingerprint_payload)
    experience_mutation["experience"]["composition"]["rules"] = [*experience_mutation["experience"]["composition"]["rules"], "mutation probe"]
    component_mutation = deepcopy(fingerprint_payload)
    component_mutation["components"][0]["nativeRenderSize"]["width"] += 1
    mutation_sensitivity = {
        "selectedViewMutationChangesFingerprint": canonical_sha256(view_mutation) != complete_target_hash,
        "experienceMutationChangesFingerprint": canonical_sha256(experience_mutation) != complete_target_hash,
        "componentMutationChangesFingerprint": canonical_sha256(component_mutation) != complete_target_hash,
    }
    if not all(mutation_sensitivity.values()):
        errors.append("complete-target fingerprint is not sensitive to every required contract surface")

    flat_checks = [check for checks in typography_checks.values() for check in checks]
    clipped = [check for check in flat_checks if check["clipped"]]
    low_contrast = [check for check in flat_checks if check["contrastRatio"] < 4.5]
    undersized = [check for check in flat_checks if min(check["fontSizesPx"]) < 11 and check["role"] not in {"display"}]
    errors.extend(f"Typography clipped in {check['role']}: {check['longestText']}" for check in clipped)
    errors.extend(f"Typography contrast below 4.5:1 in {check['role']}" for check in low_contrast)
    errors.extend(f"Typography below 11px in {check['role']}" for check in undersized)

    component_required = {"category", "sourceViewId", "sourceViewSha256", "sourceViews", "crop", "placementBounds", "stateIds", "derivedFromSceneTargetSha256", "nativeRenderSize", "runtimeGeometry", "anchor", "layer", "stateVariants", "typographyRoles", "animationNeed", "sourcePromptPointer"}
    component_findings = []
    for entry in manifest["components"]:
        missing = sorted(component_required - set(entry))
        if missing:
            errors.append(f"{entry.get('id', '<unknown>')}: missing component fields {missing}")
        if "production" in entry:
            errors.append(f"{entry['id']}: component.production must remain absent")
        if entry.get("derivedFromSceneTargetSha256") != selected_primary_hash:
            errors.append(f"{entry['id']}: lineage does not match the selected primary view")
        if entry.get("nativeRenderSize") != entry.get("runtimeGeometry", {}).get("frameSize"):
            errors.append(f"{entry['id']}: nativeRenderSize and runtime frameSize disagree")
        runtime_pivot = entry.get("runtimeGeometry", {}).get("pivot", {})
        try:
            expected_pivot = semantic_pivot(entry["nativeRenderSize"], runtime_pivot.get("mode", ""))
        except ValueError as error:
            errors.append(f"{entry['id']}: {error}")
            expected_pivot = {}
        if runtime_pivot != expected_pivot:
            errors.append(f"{entry['id']}: runtime pivot {runtime_pivot} contradicts semantic pivot {expected_pivot}")
        if entry.get("anchor") != expected_pivot:
            errors.append(f"{entry['id']}: local anchor {entry.get('anchor')} contradicts semantic pivot {expected_pivot}")
        anchor_reconstructions_exact = True
        for source_view in entry.get("sourceViews", []):
            expected = hashes[source_view["viewId"]]
            if source_view["viewSha256"] != expected:
                errors.append(f"{entry['id']}: source hash mismatch for {source_view['viewId']}")
            for field in ("tightSourceBounds", "viewportPlacementBounds"):
                bounds = source_view.get(field, {})
                if bounds.get("x", -1) < 0 or bounds.get("y", -1) < 0 or bounds.get("x", 0) + bounds.get("width", 0) > NATIVE_SIZE[0] or bounds.get("y", 0) + bounds.get("height", 0) > NATIVE_SIZE[1]:
                    errors.append(f"{entry['id']}: {field} exceeds viewport in {source_view['viewId']}")
            placement = source_view["viewportPlacementBounds"]
            try:
                reconstructed = bounds_from_viewport_anchor(source_view["viewportAnchor"], placement["width"], placement["height"])
            except ValueError as error:
                errors.append(f"{entry['id']}: {error}")
                reconstructed = {}
            if reconstructed != placement:
                anchor_reconstructions_exact = False
                errors.append(f"{entry['id']}: viewport anchor drifts placement in {source_view['viewId']}")
        placement_differs = entry["nativeRenderSize"] != {"width": entry["placementBounds"]["width"], "height": entry["placementBounds"]["height"]}
        component_findings.append({"componentId": entry["id"], "category": entry["category"], "sourceViews": len(entry["sourceViews"]), "sourceHashesVerified": True, "nativeRenderSize": entry["nativeRenderSize"], "primaryPlacementBounds": entry["placementBounds"], "runtimePivot": runtime_pivot, "semanticPivot": expected_pivot, "semanticPivotVerified": runtime_pivot == expected_pivot and entry.get("anchor") == expected_pivot, "viewportAnchorReconstructionVerified": anchor_reconstructions_exact, "runtimeSizeSeparatedFromPlacement": placement_differs, "productionAbsent": "production" not in entry})

    regions = manifest["experience"]["composition"]["regions"]
    region_by_id = {entry["id"]: entry for entry in regions}
    peer_overlap_findings: list[dict[str, Any]] = []
    for left_index, left in enumerate(regions):
        left_rect = left["rect"]
        if left_rect["x"] + left_rect["width"] > NATIVE_SIZE[0] or left_rect["y"] + left_rect["height"] > NATIVE_SIZE[1]:
            errors.append(f"composition region {left['id']} exceeds native viewport")
        for right in regions[left_index + 1 :]:
            shared_states = sorted(set(left["stateIds"]) & set(right["stateIds"]))
            if not shared_states or not intersects(left_rect, right["rect"]):
                continue
            mutually_allowed = right["id"] in left.get("allowsOverlapWith", []) and left["id"] in right.get("allowsOverlapWith", [])
            peer_overlap_findings.append({"left": left["id"], "right": right["id"], "sharedStates": shared_states, "mutuallyAllowed": mutually_allowed})
            if not mutually_allowed:
                errors.append(f"composition regions {left['id']} and {right['id']} overlap without mutual declarations")
    for region in regions:
        for allowed_id in region.get("allowsOverlapWith", []):
            if allowed_id not in region_by_id:
                errors.append(f"composition region {region['id']} allows unknown overlap {allowed_id}")

    protected_overlap_findings: list[dict[str, Any]] = []
    for view_id in SELECTED_VIEW_IDS:
        for check in typography_checks[view_id]:
            actual_ui = expanded_rect(check["rect"])
            for protected in PROTECTED_GEOMETRY[view_id]:
                if intersects(actual_ui, protected["rect"]):
                    errors.append(f"{view_id}: {check['role']} intersects protected {protected['id']}")
                    protected_overlap_findings.append({"viewId": view_id, "uiRole": check["role"], "uiRect": actual_ui, "protectedId": protected["id"], "protectedRect": protected["rect"]})

    continuity_records = manifest["metadata"].get("environmentContinuityEvidence", [])
    for record in continuity_records:
        path = ROOT.parent.parent / record["path"]
        if not path.exists() or sha256_file(path) != record["sha256"]:
            errors.append(f"continuity mask missing or stale: {record['path']}")
        if record["unexpectedEnvironmentPixelChanges"] != 0:
            errors.append(f"unexpected environment changes remain: {record['startViewId']} to {record['endViewId']}")
    if len(continuity_records) != len(CONTINUITY_TRANSITIONS):
        errors.append("continuity evidence does not cover every adjacent causal transition")

    overlay_records = manifest["metadata"].get("componentBoundEvidence", [])
    for record in overlay_records:
        path = ROOT.parent.parent / record["path"]
        review_path = ROOT.parent.parent / record["review3xPath"]
        if not path.exists() or sha256_file(path) != record["sha256"]:
            errors.append(f"component overlay missing or stale: {record['path']}")
        if not review_path.exists() or sha256_file(review_path) != record["review3xSha256"]:
            errors.append(f"component overlay 3x missing or stale: {record['review3xPath']}")
        for component_record in record.get("components", []):
            if not component_record.get("placementReconstructionExact"):
                errors.append(f"component overlay anchor reconstruction drift: {record['viewId']}/{component_record.get('componentId', '<unknown>')}")
    if len(overlay_records) != len(SELECTED_VIEW_IDS):
        errors.append("component-bound overlays do not cover all selected states")

    if manifest["approval"].get("status") != "needs-revision" or manifest["approval"].get("reviewer") != "pending-scene-target-gate":
        errors.append("approval must remain needs-revision with pending-scene-target-gate")
    if len(manifest["experience"].get("states", [])) != 8:
        errors.append("experience contract must define all eight screen states")

    brew_region = box(36, 82, 116, 150)
    ember = manifest["nativeGeometry"]["landmarkAnchors"]["emberPlanter"]
    moss = manifest["nativeGeometry"]["landmarkAnchors"]["mossPlanter"]
    for name, point in (("ember", ember), ("moss", moss)):
        if not (brew_region["x"] <= point["x"] < brew_region["x"] + brew_region["width"] and brew_region["y"] <= point["y"] < brew_region["y"] + brew_region["height"]):
            errors.append(f"{name} cue anchor is outside brew context")

    return {
        "schema": "gamefactory.scene-target-validation/v1",
        "result": "pass" if not errors else "fail",
        "hypothesis": "The accepted persistent 480x270 village remains coherent and decomposable when authoritative primary-view identity, semantic runtime pivots, and anchor-reconstructed placements are enforced independently from the mutation-sensitive complete-target fingerprint.",
        "checks": {
            "views": view_findings,
            "directions": {"completeDirectionsAtRoutePending": len(manifest["candidates"]), "selectedStateVariants": len(selected_candidate["views"]) if selected_candidate else 0, "selectedCandidateId": manifest.get("selectedCandidateId")},
            "typography": {"previewFont": "Segoe UI host preview only", "bodySizePx": 12, "captionSizePx": 11, "lineHeightPx": 16, "minimumContrastRatio": 4.5, "measuredMinimumContrastRatio": min(check["contrastRatio"] for check in flat_checks), "surfacesChecked": len(flat_checks), "clippedSurfaces": len(clipped), "undersizedReadingSurfaces": len(undersized), "longestCopyChecks": flat_checks},
            "brewCue": {"region": brew_region, "emberPlanterAnchor": ember, "mossPlanterAnchor": moss, "detachedLowerRightLabelRemovedByPersistentBasis": True, "reachableActionCue": "E ADD"},
            "components": component_findings,
            "componentBounds": {"selectedStateOverlays": overlay_records, "allSelectedStatesCovered": len(overlay_records) == len(SELECTED_VIEW_IDS), "allPlacementsReconstructedFromViewportAnchors": all(component.get("placementReconstructionExact") for record in overlay_records for component in record.get("components", []))},
            "environmentContinuity": {"persistentWorldBasisPath": manifest["experience"]["continuity"]["persistentWorldBasisPath"], "persistentWorldBasisSha256": manifest["experience"]["continuity"]["persistentWorldBasisSha256"], "transitionMasks": continuity_records, "allUnexpectedEnvironmentPixelChanges": sum(record["unexpectedEnvironmentPixelChanges"] for record in continuity_records)},
            "protectedGeometry": {"viewsChecked": len(SELECTED_VIEW_IDS), "uiProtectedIntersections": protected_overlap_findings, "intersectionCount": len(protected_overlap_findings)},
            "schemaContract": {"apiVersion": manifest.get("apiVersion"), "selectedCandidateId": manifest.get("selectedCandidateId"), "selectedPrimaryViewSha256": selected_primary_hash, "approvalMatchesSelectedPrimaryView": manifest["approval"]["selectedTargetSha256"] == selected_primary_hash, "componentPrimaryViewLineageVerified": all(entry.get("derivedFromSceneTargetSha256") == selected_primary_hash for entry in manifest["components"]), "componentPrimaryViewLineageCount": sum(entry.get("derivedFromSceneTargetSha256") == selected_primary_hash for entry in manifest["components"]), "componentCount": len(manifest["components"]), "completeTargetSha256": complete_target_hash, "selectedTargetFingerprintMatchesCompleteTarget": manifest.get("selectedTargetFingerprint", {}).get("sha256") == complete_target_hash, "fingerprintMutationSensitivity": mutation_sensitivity, "authoritativeParser": authoritative_parser, "componentProductionAbsent": all("production" not in entry for entry in manifest["components"])},
            "compositionOverlaps": peer_overlap_findings,
            "approval": {"status": manifest["approval"]["status"], "reviewer": manifest["approval"]["reviewer"]},
        },
        "errors": errors,
        "evidenceBoundary": "This validates proposed target geometry, hashes, typography, protected overlaps, continuity, and lineage. It does not prove runtime integration, motion, human comprehension, fun, or production maturity.",
    }


def main() -> None:
    REFERENCE_VIEWS.mkdir(parents=True, exist_ok=True)
    REVIEW_3X.mkdir(parents=True, exist_ok=True)

    # Preserve the attempt-1 full-screen target views before the first repair run.
    for view_id in VIEW_IDS:
        source = VIEWS / f"{view_id}.png"
        reference = REFERENCE_VIEWS / f"{view_id}.png"
        if not reference.exists():
            shutil.copy2(source, reference)

    persistent_basis = build_persistent_world_basis()
    typography_checks: dict[str, list[dict[str, Any]]] = {}
    for view_id in VIEW_IDS:
        source = REFERENCE_VIEWS / f"{view_id}.png"
        destination = VIEWS / f"{view_id}.png"
        typography_checks[view_id] = render_view(view_id, source, destination, persistent_basis)
        native = Image.open(destination).convert("RGB")
        native.resize(SHIP_SIZE, Image.Resampling.NEAREST).save(REVIEW_3X / f"{view_id}.png", format="PNG", optimize=False)

    hashes = {view_id: sha256_file(VIEWS / f"{view_id}.png") for view_id in VIEW_IDS}
    manifest = update_manifest(hashes, typography_checks)
    manifest["metadata"]["componentBoundEvidence"] = write_component_overlays(manifest)
    manifest["metadata"]["environmentContinuityEvidence"] = write_continuity_masks(typography_checks)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    validation = validate(manifest, hashes, typography_checks)
    VALIDATION_PATH.write_text(json.dumps(validation, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if validation["result"] != "pass":
        raise SystemExit("\n".join(validation["errors"]))


if __name__ == "__main__":
    main()
