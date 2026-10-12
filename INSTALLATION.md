# Standard and Enhanced workflow setup

Install **Muse-CharacterSheet-H3 once**. It supplies `MuseCharacterSheetH3` and
`MuseCharacterSheetCompositor` for both workflows. The JSON files describe the
connections; opening them does **not** automatically install packages or models.

- **Standard:** `workflows/H3 Character Sheet.json` (existing download path retained).
- **Enhanced:** `workflows/H3 Character Sheet Enhanced.json`.

Enhanced adds five Qwen Image 2.1 refinement passes, five DLSS image passes,
RGB conversion before background removal, and a separate DLSS video output.
Standard does not execute these enhanced branches. Installing their dependencies
does not add enhancement processing to Standard.

## Required packages for the supplied workflows

| Package | Nodes supplied |
| --- | --- |
| [Muse Character Sheet H3](https://github.com/muse-collective-26/Muse-CharacterSheet-H3) | H3 generation and sheet compositor; bundled here |
| [Muse Unified Loader](https://github.com/muse-collective-26/Muse-MiniMax-H3-Unified-Loader) | Unified model loader |
| [KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | Set/Get, H3 attention and feed-forward patches |
| [RMBG](https://github.com/1038lab/ComfyUI-RMBG) | Background removal; follow its RMBG-2.0 model setup |
| [VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | Video Combine; also needs FFmpeg |
| [iTools](https://github.com/MohammadAboulEla/ComfyUI-iTools) | Preview Text |
| [WAS Node Suite (Revised)](https://github.com/ltdrdata/was-node-suite-comfyui) | Save Text File; Enhanced also uses Images to RGB |
| [Memory Cleanup](https://github.com/LAOGOU-666/Comfyui-Memory_Cleanup) | RAMCleanup and VRAMCleanup |
| [MiniMaxH3Mod](https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod) | RefMod loader present in both examples, even when use_refmod is off |
| [DLSS5 Enhancer](https://github.com/Blueforcer/ComfyUI-DLSS5-Enhancer) | Enhanced only: DLSS5 Settings and Enhance Images |

Use ComfyUI with native MiniMax H3 support. Enhanced also requires core
`TextEncodeQwenImage21`, `QwenImage21Cache`, `ComfySwitchNode` and `SeedNode`.
These are not separate Muse packages. Update ComfyUI if they are unavailable.
Subgraphs are included in the workflow, not separately installed custom nodes.

The workflow metadata identifies the correct providers. Manager can help with
visible missing nodes, but internal dependencies and native runtimes still need
the checks below. There is no Workflow Encrypt dependency.

## Install dependencies

First install this repository under `ComfyUI/custom_nodes/Muse-CharacterSheet-H3`.
Close the ComfyUI instance being configured. Use **that instance's Python**.
The helper installs missing packages alongside this one and their requirements;
it does not vendor third-party source, update ComfyUI, replace existing packages,
or download model weights. Existing PyTorch versions are constrained; incompatible
requirements stop installation rather than silently switching the GPU build.

### Windows portable

Open a terminal in the portable root containing `python_embeded` and `ComfyUI`.
Preview the plan:

```bat
python_embeded\python.exe ComfyUI\custom_nodes\Muse-CharacterSheet-H3\Installers\install_dependencies.py --comfyui ComfyUI --enhanced
```

Check the printed paths, then install:

```bat
python_embeded\python.exe ComfyUI\custom_nodes\Muse-CharacterSheet-H3\Installers\install_dependencies.py --comfyui ComfyUI --enhanced --install
```

Omit `--enhanced` for Standard-only installation. Non-portable users should
replace `python_embeded\python.exe` with their ComfyUI environment's Python and
pass the actual ComfyUI folder. Do not use an unrelated system Python.

Already installed packages are retained to protect local work. Update outdated
dependencies through their normal update mechanism, restart, and check again.
The helper is not a guarantee that old installed packages are compatible.

## DLSS 5 setup — Enhanced only

Follow the [upstream installation and requirements](https://github.com/Blueforcer/ComfyUI-DLSS5-Enhancer#installation).
This enhanced workflow targets the Windows native D3D12 runtime, not RunPod/Linux.
Check upstream GPU and driver compatibility before choosing Enhanced.

1. Install the DLSS5 node package (the helper above does this, or use Manager).
2. From the Windows portable root, run:

   ```bat
   python_embeded\python.exe ComfyUI\custom_nodes\ComfyUI-DLSS5-Enhancer\install_runtime.py
   ```

3. Read and accept the upstream runtime licensing notice if you agree. The setup
   downloads the separate runtime. It is not bundled in Muse's repository.
4. Restart ComfyUI. If using an existing external runtime, follow upstream's
   `--runtime-dir` instructions. Keep the workflow's DLSS controls unchanged.

Installing only the node pack is insufficient: it can appear on the canvas and
still fail at execution if its runtime is missing. Do not disable security
protection indiscriminately if a downloaded executable is flagged.

## Other conditional requirements

- SageAttention is enabled in the saved examples. KJNodes supplies its patch node,
  but the compatible [SageAttention](https://github.com/thu-ml/SageAttention)
  extension must also be installed for the user's GPU/PyTorch/CUDA environment.
  Do not assume a universal wheel works on every computer.
- Unified Loader Low VRAM/Balanced profiles require
  [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) and matching encoder/projector weights.
- Two-stage H3 sampling requires
  [ComfyUI-H3-Multishot](https://github.com/jlucasmcrell/ComfyUI-H3-Multishot)
  and a compatible latent upscaler. It is off in both examples.
- Analyze requires a configured vision-capable backend. You can type reference
  descriptions manually; downloading this workflow does not install an LLM server.

## Models and personal assets

Node installation is separate from model downloads. Select files that actually
exist in your installation. The examples contain the author's saved model and
reference selections; upload your own references and choose your own RefMods.
Paths pointing to the author's computer are not distributed assets.

For Enhanced, the supplied settings retain 8 H3 steps and the Ref2V 8-step Turbo
LoRA. The revised saved example uses 2 megapixels and also selects the author's
`Minimax_H3_Unlocked_V2.safetensors` extra LoRA at strength 1; that file is not
bundled. Select your own available weights before running. The maximum-quality
reference model is Singularity v1.3 INT8, with an INT8
H3 text encoder; Automatic may choose another profile according to VRAM.
Use the exact model creators' sources for those custom weights; they are not
bundled. The older FastVideo links in the general model notes are alternatives,
not downloads of the selected Singularity checkpoint.

The saved Unified Loader also retains `Both / Mixed` under Models to Load.
That selection may request the selected First/Last-frame model as well, even
though the character-sheet generator uses Reference mode. Review that loader
control and your installed models before running; the workflow does not download
them automatically.

Additional Qwen models: [Comfy-Org/Qwen-Image-2.1](https://huggingface.co/Comfy-Org/Qwen-Image-2.1).
Place diffusion weights in `models/diffusion_models`, encoders in
`models/text_encoders`, VAEs in `models/vae`, and LoRAs in `models/loras`.
Check the selected Qwen VAE and detailer LoRA in each refinement subgraph: custom
VAE/LoRA files are separate downloads, not included in Comfy-Org's base set.
H3 Turbo source: [lightx2v/Minimax-h3-Turbo](https://huggingface.co/lightx2v/Minimax-h3-Turbo).

No MysticXXX, GalaxyAce, Polyhedron, Realism, or detailer weights are bundled here.
Obtain the selected LoRAs from their creators, or deliberately select alternatives.

## Before rendering

Restart ComfyUI after installation, reload the workflow and resolve missing nodes
and models. Test Standard and Enhanced separately. Structural workflow checks and
dependency-script tests are not an end-to-end GPU render test.

[Muse Collective community](https://www.skool.com/muse-collective-7594)
