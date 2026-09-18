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

**ComfyUI's own "Install Missing Custom Nodes" will not catch any of the packages below.** They're looked up internally by this node's own code, not placed as separate nodes on the canvas, so nothing flags them as missing — you'll only find out when a render fails partway through with an error naming exactly what's missing.

- **ComfyUI** with native MiniMax H3 support (`comfy_extras.nodes_minimax_h3`) — ships with recent ComfyUI core builds.
- **PyAV** (`av`) and **psutil** Python packages.
- **[Muse MiniMax H3 Unified Loader](https://github.com/muse-collective-26/Muse-MiniMax-H3-Unified-Loader)** — loads `model`/`clip`/`vae` for this workflow.
- **[ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes)** — required by the Unified Loader for SageAttention support, which is on by default.
- **[ComfyUI-H3-Multishot](https://github.com/jlucasmcrell/ComfyUI-H3-Multishot)** — only required if you enable `two_stage_sampling` (registers `MinimaxH3LatentUpscaler3D`, `LTXVSeparateAVLatent`, `LTXVConcatAVLatent`). Off by default.
- **[ComfyUI-MiniMaxH3Mod](https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod)** (community package) — only required if you enable `use_refmod`. Add **Load H3 RefMods** (or **Create H3 RefMod** directly) to the canvas and wire its `mods` output into this node's `refmod_bundle` input — **Apply H3 RefMod** doesn't need placing separately, this node calls it internally. Off by default.

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
