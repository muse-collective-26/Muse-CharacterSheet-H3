# Muse Character Sheet H3

A ComfyUI custom node pack for generating consistent character turnaround sheets with **MiniMax H3**, using its Reference (Omni) mode. Give it up to 8 character/prop reference images (and optionally a reference video as an identity source), write a short pose/turnaround prompt using MiniMax's own CHUNK/CUT authoring format, and it renders one H3 call producing a clean multi-angle turnaround of your character. A second, companion node then lays the extracted turnaround frames out into one finished character sheet.

This pack registers two nodes:

- **Muse Character Sheet H3** — the generation node described below.
- **Muse Character Sheet Compositor** — takes the 5 individual frames extracted from a turnaround render (Close-up, Front, Left Profile, Right Profile, Back — each pulled out with its own `ImageFromBatch` node upstream) and composites them side by side onto one finished sheet, close-up shown full width and the other four given a centered crop to read as slimmer panels next to it. Set `target_aspect_ratio` (16:9, 4:3, 1:1, 3:2, 21:9) to have it solve the crop automatically instead of hand-tuning `body_width_pct`.

Built as a stripped-down, single-call derivative of Muse Collective's MiniMax H3 Director line — same CHUNK/CUT prompt-authoring UI and reference-mode prompt compiler, but permanently locked to one chunk, no chunk-splitting, no disk streaming, no Seed Hunt. It's meant to be small, fast, and easy to understand.

## Features

- **CHUNK/CUT prompt UI** — a plain-language box for describing each pose/angle in the turnaround, compiled automatically into MiniMax H3's six-section Reference-mode prompt format (subject definitions, summary, retention analysis, detailed description, soundscape, music).
- **Up to 8 character/prop reference images**, plus 1 Location reference, each with its own Retention setting (fully preserved, attribute transfer, weak reference, etc.).
- **Reference video as an identity source** — describe a person visible in an uploaded clip and the node builds a proper `<Subject N> is ... in <Video M>` reference, following MiniMax's own documented convention. Includes an in/out trim scrubber and a dedicated viewer.
- **RefMod support** (optional) — if the community `ComfyUI-MiniMaxH3Mod` package is installed, wire in a RefMod bundle for DiT-block-level identity injection, with the full parameter set (curve, scramble, graph presets) exposed.
- **Two-stage sampling** — an experimental low-res-then-upscale pass using a trained latent upscaler, for faster iteration.
- **Live generation preview** — per-step sampling preview plus a finished clip player, both on this node's own dedicated websocket/HTTP routes so it can run alongside other MiniMax H3 nodes without colliding.

## Requirements

**Choose Standard or Enhanced:** see [complete installation instructions](INSTALLATION.md)
and the [dependency installer](Installers/install_dependencies.py). Both workflows
use this same node pack. Enhanced adds Qwen Image 2.1 and DLSS; Standard does not
require DLSS. Third-party packages are installed separately, not bundled here.

**Install the required packages below before running the example workflow.** Some dependencies are called internally and may not be detected by ComfyUI's "Install Missing Custom Nodes". Others, including RMBG, appear as workflow nodes, including inside subgraphs. Check this list even if no missing nodes are reported.

- **ComfyUI** with native MiniMax H3 support (`comfy_extras.nodes_minimax_h3`) — ships with recent ComfyUI core builds.
- **PyAV** (`av`) and **psutil** Python packages.
- **[ComfyUI-RMBG](https://github.com/1038lab/ComfyUI-RMBG)** — required for the five background-removal nodes in the example character-sheet workflow. These use the **RMBG-2.0** model to remove the background from each extracted character view before assembling the sheet.
- **[Muse MiniMax H3 Unified Loader](https://github.com/muse-collective-26/Muse-MiniMax-H3-Unified-Loader)** — active in Enhanced; retained as a bypassed alternative in Standard, which uses its separate Models & Loras group.
- **[ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes)** — required by the Unified Loader for SageAttention support, which is on by default.
- **[ComfyUI-H3-Multishot](https://github.com/jlucasmcrell/ComfyUI-H3-Multishot)** — only required if you enable `two_stage_sampling` (registers `MinimaxH3LatentUpscaler3D`, `LTXVSeparateAVLatent`, `LTXVConcatAVLatent`). Off by default.
- **[ComfyUI-MiniMaxH3Mod](https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod)** (community package) — the provided workflows contain its loader, so install it to open them without a missing node. RefMod application is off by default. **Apply H3 RefMod** is called internally when enabled.

The node checks for each optional dependency at generation time and gives a clear error naming exactly what's missing, rather than failing to load.

## Installation

1. Clone (or download) this repo into your ComfyUI `custom_nodes` folder:
   ```
   git clone https://github.com/muse-collective-26/Muse-CharacterSheet-H3.git
   ```
2. Install the packages and Python requirements using [INSTALLATION.md](INSTALLATION.md).
   For Enhanced, complete the separate DLSS runtime setup there as well.
3. Restart ComfyUI.
4. Both nodes — **Muse Character Sheet H3** and **Muse Character Sheet Compositor** — appear under the `Muse Collective` category.

## Usage

1. Wire up `model`, `clip`, `vae`, `audio_vae` from your MiniMax H3 loader into **Muse Character Sheet H3**.
2. Drop reference images into the Ref 1–8 slots (Analyze each one to auto-fill its description, or type your own).
3. Write the pose/angle plan for the turnaround in the CUT timeline, then generate.
4. Extract the 5 turnaround frames from the rendered video (one `ImageFromBatch` per frame) and feed them into **Muse Character Sheet Compositor** to get one composed sheet.

## Example Workflow

- [H3 Character Sheet — Standard](workflows/H3%20Character%20Sheet.json): original generation and assembly workflow; existing filename retained.
- [H3 Character Sheet Enhanced](workflows/H3%20Character%20Sheet%20Enhanced.json): 8-step H3 with Ref2V Turbo LoRA, five Qwen refinement branches, DLSS image/video enhancement, and RGB conversion before background removal.

Both include corrected custom-node source metadata and setup notes. The Enhanced
workflow preserves the author's saved model selections: weights and reference
assets are not bundled. See [setup and DLSS instructions](INSTALLATION.md).

The compositor accepts both RGB and RGBA inputs without changing its node ID or
input/output interface. This supports background-removal outputs in both examples.
Structural and CPU regression tests are included; Enhanced is not yet certified
by a clean-install end-to-end GPU render.

[Muse Collective community](https://www.skool.com/muse-collective-7594)

## Status

Actively developed by Muse Collective. Expect changes.
