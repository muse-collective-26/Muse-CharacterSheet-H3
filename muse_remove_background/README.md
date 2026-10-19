# Muse Remove Background — 0.1.0 test build

This replaces **Remove Background (RMBG)**, not the Images to RGB converter. It bundles its processing engine and does not import the installed ComfyUI-RMBG or WAS node packs.

## Install and connect

Extract `Muse-Remove-Background` directly into your active ComfyUI `custom_nodes` folder. Restart ComfyUI and refresh the browser. Search for **Muse Remove Background**. Keep the existing installation until testing is complete; this package has its own node identifier and does not override RMBG globally.

Connect the enhanced image directly to **image**. Outputs are in the same order as RMBG: **IMAGE**, **MASK**, **MASK_IMAGE**. Reconnect any used outputs to their previous destinations. Copy your settings rather than copying positional widget values from the old node.

For the character-sheet workflow: use **Alpha**, connect IMAGE to the Muse sheet compositor, and choose white on the compositor. Alternatively choose **Color** and enter `#FFFFFF` to output an image already composited on white. No separate RGB converter is required before this node: grayscale/RGB/RGBA inputs are accepted.

## Dependencies and models

Uses the existing ComfyUI PyTorch, torchvision, NumPy and Pillow environment. If dependencies are missing, install this folder's requirements.txt with the Python interpreter belonging to that ComfyUI installation, not an unrelated system Python. Do not replace PyTorch blindly. INSPYRENET additionally requires `transparent-background`; it is imported only when selected.

Reuses `ComfyUI/models/RMBG` under ComfyUI's configured models directory. If model files are absent, the bundled engine downloads the selected model from the same upstream model repositories as the inspected RMBG integration: 1038lab/RMBG-2.0, 1038lab/inspyrenet, 1038lab/BEN, or 1038lab/BEN2 on Hugging Face. Some models include Python architecture code which is executed to load the model. No weights are included in this ZIP. Model access, download permissions and each model's terms still apply. This release does not certify those terms or remove hardware requirements.

Uses ComfyUI's selected device (CPU/CUDA/MPS), with no hard-coded drive or Windows-only shell commands. This test build is not yet verified on Desktop, RunPod, macOS or every model/dependency version.

## Compatibility changes

- Standard STRING colour widget instead of custom COLORCODE frontend widget.
- Colour names, short/long hex and PIL-supported colour strings accepted. Invalid colours use white with a visible console warning rather than aborting the completed mask calculation.
- Explicit default values for every optional input.
- RGB normalization before model inference, and batch dimension handling that preserves one-pixel-wide/high images.
- One image per inference batch to reduce peak memory; model unloading enabled by default.
- Lazy engine import so missing optional packages do not prevent node registration.
- Same image/mask output types and order. No unrelated nodes or monkey patches to global ComfyUI node registrations.

## Testing status

Automated tests exercise the real postprocessing engine with controlled synthetic masks (not real model inference): colour parsing/fallback, alpha and RGB outputs, batches, grayscale/RGBA input, blur/offset/inversion, output sizes and registration. A real character image render is still required before distributing as a verified replacement. No claim of universal compatibility is made.

## Attribution and licence

GPL-3.0; see LICENSE. `engine.py` is derived from 1038lab/ComfyUI-RMBG's `py/AILab_RMBG.py`, from the local installation inspected on 20 October 2026. Original copyright and attribution remain in that file. Muse changes are listed above. The integration code licence is separate from model licences; do not rely on the inherited engine header's model-licence summary as permission to use model weights.

Upstream: https://github.com/1038lab/ComfyUI-RMBG
