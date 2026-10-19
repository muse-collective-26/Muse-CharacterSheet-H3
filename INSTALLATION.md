# H3 Character Sheet Enhanced

## What this workflow does

Generates a character-reference video, lets you select frames, refines the selected images using Qwen Image 2.1, applies DLSS enhancement, and assembles the character sheet.

The workflow includes five image-refinement branches and a separate DLSS-enhanced video output.

Opening the workflow does not automatically install its custom nodes, models or DLSS runtime.

## Installation

1. Download the complete [Muse Character Sheet H3 Windows package](https://github.com/muse-collective-26/Muse-CharacterSheet-H3/releases/download/v2026.10.19.2/Muse-CharacterSheet-H3-Windows.zip).
2. Extract the ZIP.
3. Place the package folder directly inside `ComfyUI/custom_nodes`.
4. Close ComfyUI.
5. Run the single `Install-Windows.bat` at the package root.
6. Confirm the dependency installation.
7. For Enhanced, complete the DLSS runtime setup offered by that same installer unless you already have a runtime configured.
8. Install the required model files, restart ComfyUI and refresh your browser.

Download the whole package—not the BAT file separately. Git must be installed and available on PATH.

The correct folder structure is:

`ComfyUI/custom_nodes/Muse-CharacterSheet-H3/__init__.py`

The BAT should be beside `__init__.py`, with the `Installers` folder alongside them.

If Windows creates an extra outer folder when extracting, use the inner package folder containing those files. Do not put a second copy of the node inside another copy.

A folder name ending in `-master` is accepted. Keep only one installed copy of the Muse Character Sheet node.

The installer installs missing dependencies and their Python requirements. It retains existing dependency folders rather than updating or replacing them. Model weights are not downloaded.

## Custom nodes used

| Package | Purpose |
| --- | --- |
| [Muse Character Sheet H3](https://github.com/muse-collective-26/Muse-CharacterSheet-H3) | Character generation and sheet assembly |
| [Muse Unified Loader](https://github.com/muse-collective-26/Muse-MiniMax-H3-Unified-Loader) | Active H3 model, encoder, VAE and LoRA loading |
| [KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | Set/Get nodes, image-size utilities and H3 memory-saving patches |
| [MiniMax H3 Latent Upscaler](https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler) | Required when two-stage sampling is enabled |
| [MiniMaxH3Mod](https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod) | RefMod loader |
| [RMBG](https://github.com/1038lab/ComfyUI-RMBG) | Background removal |
| [VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | Video output |
| [iTools](https://github.com/MohammadAboulEla/ComfyUI-iTools) | Prompt preview |
| [WAS Node Suite (Revised)](https://github.com/ltdrdata/was-node-suite-comfyui) | Text saving and RGB conversion |
| [Memory Cleanup](https://github.com/LAOGOU-666/Comfyui-Memory_Cleanup) | RAM and VRAM cleanup |
| [DLSS5 Enhancer](https://github.com/Blueforcer/ComfyUI-DLSS5-Enhancer) | Image and video enhancement; requires its separate runtime |

Use a ComfyUI version with native MiniMax H3 and Qwen Image 2.1 support.

Qwen refinement uses core nodes including `TextEncodeQwenImage21`, `QwenImage21Cache` and `ComfySwitchNode`. These are not separate Muse downloads.

Follow RMBG's model-installation instructions for its selected background-removal model.

## Saved generation settings

This workflow currently uses the Unified Loader connected to the character-sheet node.

- H3 model: `minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors`
- H3 text encoder: `qwen3vl_32b_minimax_h3_int8_convrot.safetensors`
- Video VAE: `minimax_h3_video_vae_fp16.safetensors`
- Audio VAE: `minimax_h3_audio_vae_fp32.safetensors`
- Aspect ratio: 9:16
- Base resolution: 0.5 megapixels
- Duration: 10 seconds
- Sampling: 8 steps, Euler, Simple
- Two-stage sampling: currently OFF
- Reference image size: maximum
- SageAttention: OFF
- High-Res Stability: OFF
- Model Attention Backend: Off
- Low-VRAM Attention: ON, 4 head chunks
- Chunk Feed-Forward: ON, 2 chunks, threshold 4096
- Pinned-memory cap: 10 GB

These describe the saved workflow, not settings you must use for every render.

The separate “Models & Loras” group is bypassed and disconnected. Its Singularity selection is not the model feeding the character-sheet node in this saved version.

The Unified Loader is saved as “Both / Mixed”, but its FL2VA output is not connected to the character-sheet node. The character-sheet generation uses the reference-model output.

## H3 models

Place the selected FastVideo model in:

`ComfyUI/models/diffusion_models/`

Required encoder and VAEs:

- [H3 INT8 text encoder](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors) → `ComfyUI/models/text_encoders/`
- [H3 video VAE](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors) → `ComfyUI/models/vae/`
- [H3 audio VAE](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors) → `ComfyUI/models/vae/`

Select the filenames available in your installation. Model files are not included in the workflow or installer.

## Selected H3 LoRAs

### Reference-mode Turbo

Saved filename:

`minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors`

Saved strength: 1.0.

[Download Reference-mode Turbo](https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors)

Place in `ComfyUI/models/loras/H3/`.

This is the REF2V version, not the FL2V version.

### Realism People

Saved filename:

`h3-realism-people-t2v-i2v-r2v.safetensors`

Saved strength: 0.75. Trigger word: `r34l1sm`.

[Download Realism People](https://huggingface.co/fal/MiniMax-H3-Realism-People-LoRA/resolve/main/h3-realism-people-t2v-i2v-r2v.safetensors)

Place in `ComfyUI/models/loras/H3/`.

### Polyhedron

Saved filename:

`polyhedron_minimax_h3_image_lora_v2__perfe8ct.safetensors`

Saved strength: 0.6. Trigger word: `perfe8ct`.

[Polyhedron creator listing](https://civitai.com/models/2899220)

Check the filename on the creator's page. The direct download has not been independently verified. If you do not have this LoRA, select `(disabled)` rather than leaving a missing filename selected.

Place in `ComfyUI/models/loras/H3/`.

The character-sheet trigger-word controls are enabled in this saved workflow with `r34l1sm, perfe8ct`. Keep those words consistent with the LoRAs you actually use.

## Two-stage sampling

Both single-stage and two-stage sampling are supported.

Two-stage sampling is OFF in this saved workflow. Its stored settings are:

- First pass: 2 steps
- Target resolution: 2 megapixels
- Temporal chunking: ON
- Upscaler model: `h3_upscaler_lms_v0.1_fp32.safetensors`

If you enable it, you need both:

1. The [MiniMax H3 Latent Upscaler node package](https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler), included in the dependency installer.
2. The [latent upscaler model](https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/latent_upscaler/h3_upscaler_lms_v0.1_fp32.safetensors), placed in `ComfyUI/models/latent_upscale_models/`.

H3 Multishot is not the package that supplies `MinimaxH3LatentUpscaler3D`.

## Qwen image refinement

The five refinement branches have these selected models:

- [Qwen Image 2.1 INT8 diffusion model](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors) → `ComfyUI/models/diffusion_models/`
- [Qwen 3 VL 8B INT8 encoder](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors) → `ComfyUI/models/text_encoders/`
- [Texture-Fix VAE for Qwen Image 2.1](https://huggingface.co/madebyollin/texture-fix-vae-for-qwen-image-2.1/resolve/main/texture_fix_vae_for_qwen_image_2.1_bf16.safetensors) → `ComfyUI/models/vae/`
- [Elusarcas Qwen 2.1 Detailer LoRA](https://huggingface.co/reverentelusarca/elusarcas-qwen-2.1-detail-enhancer-lora/resolve/main/elusarcas-qwen2-1-detailer-v1.safetensors) → `ComfyUI/models/loras/`

The refinement groups' exposed VAE selection is the Texture-Fix VAE. Their internal saved VAE defaults may still display the base Qwen VAE; use the exposed group controls when checking the selected model.

The saved refinement settings use 25 steps, CFG 1, Euler and Simple, with detailer LoRA strength 1.

## DLSS 5 runtime — required for enhancement

Installing the DLSS custom node alone is not enough. It also requires the separate native runtime.

This workflow's DLSS enhancement targets Windows. See the [DLSS node's requirements](https://github.com/Blueforcer/ComfyUI-DLSS5-Enhancer#installation) for GPU and driver compatibility.

The Muse Windows installer offers runtime setup after installing the node packages. Read the upstream licensing notice and confirm only if you agree.

If you skipped that step, open a terminal in the portable root containing `python_embeded` and `ComfyUI`, then run:

```bat
python_embeded\python.exe ComfyUI\custom_nodes\ComfyUI-DLSS5-Enhancer\install_runtime.py --url https://github.com/Merserk/dlss5-visual-enhancer/releases/download/v3.0/DLSS.5.Visual.Enhancer.v3.0.zip
```

This downloads approximately 467 MB.

The correct release path is `/v3.0/`, including the `v`. The older `/3.0/` download address returns 404.

The runtime is downloaded from its upstream project; its binaries are not bundled in Muse's package.

If you already have a compatible runtime elsewhere, the upstream installer also supports `--runtime-dir` to register its location.

Restart ComfyUI after setup. A visible DLSS node on the canvas does not mean its runtime has been installed.

## References and RefMods

Upload your own character-reference images. Saved reference filenames and preview paths from another computer are not included assets.

RefMods are optional. In this workflow:

- All eight RefMod selections are `(none)`.
- Use RefMod is OFF.

Do not select a RefMod unless its files are installed locally.

The Analyze feature needs a configured vision-capable backend. You can enter descriptions manually instead; installing this workflow does not install an analysis server.

## Before rendering

- Confirm the selected model and LoRA files exist.
- Supply your own character references.
- Check that the DLSS runtime setup completed.
- Leave SageAttention and High-Res Stability off unless you have installed a compatible SageAttention extension.
- Restart ComfyUI after installing custom nodes or runtime components.
- Refresh the browser after updating the Muse node.

Updating the node package does not replace settings or notes inside a workflow you already have open.

[Muse Collective community](https://www.skool.com/muse-collective-7594)
