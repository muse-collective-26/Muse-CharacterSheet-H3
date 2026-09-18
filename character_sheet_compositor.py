# Muse Character Sheet Compositor. [2026-09-17]
#
# Takes the 5 individual frames extracted from a Muse CharacterSheet H3
# turnaround render (Close-up, Front, Left Profile, Right Profile, Back —
# each already pulled out via its own ImageFromBatch node upstream) and lays
# them out side by side on one sheet, matching the reference turnaround-sheet
# layout Andy provided.
#
# [2026-09-17] Rebuilt the layout twice. First version forced all 5 panels to
# the same fixed width and center-cropped every image to fill it — not what
# was wanted. Second version scaled every panel to a shared height and let
# each keep its own natural aspect ratio uncropped — but in Andy's real
# pipeline all 5 frames come from the same H3 video at the same resolution,
# so they're literally the same shape as files; nothing came out narrower.
# Confirmed with Andy directly: close_up is shown in full, uncropped, at its
# real width. front/left_profile/right_profile/back get a centered width
# crop (body_width_pct of their natural, height-scaled width) so they read
# as the "thinner panels" next to the uncropped close-up, matching the
# reference sheet's proportions on identically-shaped source frames.

import numpy as np
import torch
from PIL import Image

CATEGORY = "Muse Collective"

_BG_COLORS = {
    "white": (255, 255, 255),
    "black": (0, 0, 0),
    "mid gray": (128, 128, 128),
}


def _tensor_to_pil(image_tensor: torch.Tensor) -> Image.Image:
    # ComfyUI IMAGE tensors are (batch, H, W, C) float 0-1 — take the first
    # frame of whatever batch arrives (a single extracted frame is batch=1).
    frame = image_tensor[0].clamp(0.0, 1.0).mul(255.0).round().to(torch.uint8).cpu().numpy()
    return Image.fromarray(frame, mode="RGB")


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    arr = np.array(image.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _scale_to_height(image: Image.Image, panel_h: int, width_pct: float = 100.0) -> Image.Image:
    src_w, src_h = image.size
    if src_w <= 0 or src_h <= 0:
        return Image.new("RGB", (1, panel_h), (255, 255, 255))
    scale = panel_h / src_h
    new_w = max(1, round(src_w * scale))
    resized = image.resize((new_w, panel_h), Image.LANCZOS)
    if width_pct >= 100.0:
        return resized
    # Centered horizontal crop — trims equally off both sides, keeping the
    # subject (who's centered in these turnaround frames) centered too.
    crop_w = max(1, round(new_w * width_pct / 100.0))
    left = (new_w - crop_w) // 2
    return resized.crop((left, 0, left + crop_w, panel_h))


class MuseCharacterSheetCompositor:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "close_up": ("IMAGE",),
                "front": ("IMAGE",),
                "left_profile": ("IMAGE",),
                "right_profile": ("IMAGE",),
                "back": ("IMAGE",),
                "panel_height": ("INT", {"default": 1080, "min": 320, "max": 4096, "step": 8, "tooltip":
                    "Every panel is scaled to exactly this height. close_up is then shown at its full, "
                    "uncropped width; the other four get body_width_pct applied."}),
                "body_width_pct": ("INT", {"default": 60, "min": 20, "max": 100, "step": 1, "tooltip":
                    "Centered horizontal crop applied to front/left_profile/right_profile/back only "
                    "(as a % of their natural width at panel_height) so they read as thinner panels "
                    "next to the uncropped close_up. 100 = no crop, same width as close_up."}),
                "gap": ("INT", {"default": 12, "min": 0, "max": 200, "step": 2, "tooltip":
                    "Pixel spacing between panels, and around the outer edge."}),
                "background_color": (list(_BG_COLORS.keys()), {"default": "white", "tooltip":
                    "Fills the gaps and outer edge around the panels."}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("character_sheet",)
    FUNCTION = "execute"
    CATEGORY = CATEGORY

    def execute(self, close_up, front, left_profile, right_profile, back,
                panel_height, body_width_pct, gap, background_color):
        panel_h = max(1, int(panel_height))
        bg_rgb = _BG_COLORS.get(background_color, (255, 255, 255))

        panels = [_scale_to_height(_tensor_to_pil(close_up), panel_h, 100.0)] + [
            _scale_to_height(_tensor_to_pil(img), panel_h, float(body_width_pct))
            for img in (front, left_profile, right_profile, back)
        ]

        content_w = sum(p.width for p in panels) + gap * 4
        canvas_w = content_w + gap * 2
        canvas_h = panel_h + gap * 2

        sheet = Image.new("RGB", (canvas_w, canvas_h), bg_rgb)
        x = gap
        for panel in panels:
            sheet.paste(panel, (x, gap))
            x += panel.width + gap

        return (_pil_to_tensor(sheet),)


NODE_CLASS_MAPPINGS = {"MuseCharacterSheetCompositor": MuseCharacterSheetCompositor}
NODE_DISPLAY_NAME_MAPPINGS = {"MuseCharacterSheetCompositor": "Muse Character Sheet Compositor"}
