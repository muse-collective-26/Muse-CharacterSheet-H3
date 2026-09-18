# Muse Character Sheet H3

A ComfyUI custom node pack for generating consistent character turnaround sheets with **MiniMax H3**, using its Reference (Omni) mode. Give it up to 8 character/prop reference images (and optionally a reference video as an identity source), write a short pose/turnaround prompt using MiniMax's own CHUNK/CUT authoring format, and it renders one H3 call producing a clean multi-angle turnaround of your character. A second, companion node then lays the extracted turnaround frames out into one finished character sheet.

This pack registers two nodes:

- **Muse Character Sheet H3** — the generation node described below.
- **Muse Character Sheet Compositor** — takes the 5 individual frames extracted from a turnaround render (Close-up, Front, Left Profile, Right Profile, Back — each pulled out with its own `ImageFromBatch` node upstream) and composites them side by side onto one finished sheet, close-up shown full width and the other four given a centered crop to read as slimmer panels next to it.

Built as a stripped-down, single-call derivative of Muse Collective's MiniMax H3 Director line — same CHUNK/CUT prompt-authoring UI and reference-mode prompt compiler, but permanently locked to one chunk, no chunk-splitting, no disk streaming, no Seed Hunt. It's meant to be small, fast, and easy to understand.

## Features

- **CHUNK/CUT prompt UI** — a plain-language box for describing each pose/angle in the turnaround, compiled automatically into MiniMax H3's six-section Reference-mode prompt format (subject definitions, summary, retention analysis, detailed description, soundscape, music).
- **Up to 8 character/prop reference images**, plus 1 Location reference, each with its own Retention setting (fully preserved, attribute transfer, weak reference, etc.).
- **Reference video as an identity source** — describe a person visible in an uploaded clip and the node builds a proper `<Subject N> is ... in <Video M>` reference, following MiniMax's own documented convention. Includes an in/out trim scrubber and a dedicated viewer.
- **RefMod support** (optional) — if the community `ComfyUI-MiniMaxH3Mod` package is installed, wire in a RefMod bundle for DiT-block-level identity injection, with the full parameter set (curve, scramble, graph presets) exposed.
- **Two-stage sampling** — an experimental low-res-then-upscale pass using a trained latent upscaler, for faster iteration.
- **Live generation preview** — per-step sampling preview plus a finished clip player, both on this node's own dedicated websocket/HTTP routes so it can run alongside other MiniMax H3 nodes without colliding.

## Requirements

- **ComfyUI** with native MiniMax H3 support (`comfy_extras.nodes_minimax_h3`) — ships with recent ComfyUI core builds.
- **PyAV** (`av`) and **psutil** Python packages.
- **[ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo)** — only required if you enable `two_stage_sampling` (uses its `LTXVSeparateAVLatent`/`LTXVConcatAVLatent` nodes).
- **ComfyUI-MiniMaxH3Mod** (community package, install via ComfyUI Manager) — only required if you enable `use_refmod`.

The node checks for each optional dependency at generation time and gives a clear error naming exactly what's missing, rather than failing to load.

## Installation

1. Clone (or download) this repo into your ComfyUI `custom_nodes` folder:
   ```
   git clone https://github.com/muse-collective-26/Muse-CharacterSheet-H3.git
   ```
2. Restart ComfyUI.
3. Both nodes — **Muse Character Sheet H3** and **Muse Character Sheet Compositor** — appear under the `Muse Collective` category.

## Usage

1. Wire up `model`, `clip`, `vae`, `audio_vae` from your MiniMax H3 loader into **Muse Character Sheet H3**.
2. Drop reference images into the Ref 1–8 slots (Analyze each one to auto-fill its description, or type your own).
3. Write the pose/angle plan for the turnaround in the CUT timeline, then generate.
4. Extract the 5 turnaround frames from the rendered video (one `ImageFromBatch` per frame) and feed them into **Muse Character Sheet Compositor** to get one composed sheet.

## Status

Actively developed by Muse Collective. Expect changes.
