# Release notes

## 2026-10-19 — Updated Standard workflow

- Replaced `workflows/H3 Character Sheet.json` with Andy's supplied `H3 Character Sheet (1).json`, unchanged. Enhanced remains as previously updated.
- Rebuilt the existing Windows package with both current workflows; no additional workflow variants or installers added.

## 2026-10-19 — Updated default Enhanced workflow

- Replaced `workflows/H3 Character Sheet Enhanced.json` with Andy's supplied Enhanced (5) workflow, retaining its nodes, connections and saved settings.
- Corrected the Qwen detailer repository URL in its notes. No additional loaders were added.
- Standard remains unchanged: selected-frame composition and background removal without the Enhanced Qwen/DLSS processing.

## 2026-10-19 — DLSS runtime download correction

- The existing Windows installer now offers DLSS runtime setup using the working `v3.0` release URL, overriding the upstream script's broken `3.0` URL.
- Retains the upstream licensing notice and confirmation; users with an existing configured runtime may skip this step. No runtime binaries are bundled.
- Updated manual commands and workflow notes. The existing Windows ZIP is replaced in place, not published as another installer choice.

## 2026-10-19 — Installer correction

- Added the actual `Comfyui_Minimax_h3_latent_Upscaler` package to both Standard and Enhanced installer plans. H3 Multishot does not supply `MinimaxH3LatentUpscaler3D`.
- Corrected the installation guide and added a regression test for rerunning setup with every other dependency already installed.
- Rerun the corrected package's `Install-Windows.bat`, then restart ComfyUI. Upscaler model weights remain a separate download.
- Corrected the existing installer and Windows package in place; no separate installer is needed. The helper rejects an older manifest missing the required upscaler.
- The package has one BAT launcher, `Install-Windows.bat` at its root; removed the redundant forwarding BAT from Installers.

## 2026-10-19.2 — Portable templates and layout restoration

- Cleared personal RefMod selections in Standard and Enhanced templates; all eight slots start at `(none)`.
- Updated the five RMBG nodes in each template for the current `unload_model` input before background mode, retaining Color/white output. Update RMBG when using these templates.
- Set character-panel width before measuring height and recheck layout on unchanged-timeline restores; added regression checks for transient narrow hosts and stale tall dimensions. The user's exact collapsed-screen case still needs visual confirmation after browser refresh.
- Download the new workflow to receive template corrections; updating node code alone does not change a workflow already open in the browser.

## 2026-10-19.1 — Windows installer packaging fix

- Added a complete Windows ZIP with one package folder and a top-level Install-Windows.bat.
- Launcher searches ancestors for the intended ComfyUI rather than assuming a fixed folder depth.
- Detects double-nested folders and prints the exact inner package and destination before installing anything; no automatic file moves or overwrites.
- Detects incomplete downloads, supports folder names ending in -master and paths with spaces, and retains the old launcher as a forwarding shortcut.
- README, installation guide and Enhanced workflow notes now link to the complete Windows package. Models remain separate downloads.
- Added Windows PowerShell layout tests for valid, double-nested, incomplete and Downloads-folder installations. These tests do not install dependencies or render.

## 2026-10-19 — Character Sheet H3 update

- Clarified installation: download and extract the complete repository ZIP, place the entire package in custom_nodes, then run the included BAT from its Installers folder. Do not download the BAT separately.

- Updated Enhanced workflow and exact model download notes: Singularity v1.3 INT8, H3 INT8 encoder, Reference-mode 8-step Turbo, latent upscaler, Qwen refinement models, Texture-Fix VAE and detailer.
- SageAttention and High-Res Stability are off in the Enhanced template. Memory-saving attention/feed-forward chunking remains enabled. Existing user workflows are not rewritten.
- Added Windows dependency installer launcher. Includes Unified Loader, H3 Multishot and GGUF support alongside the workflow's other node packages; does not download model weights or install SageAttention binaries.
- Added visible trigger-word controls above Overall Style, saved with the timeline and applied after prompt overrides.
- Updated sampling-boundary memory cleanup, including compatibility with ComfyUI versions without model_prefetch. Fixed sampler registry lookup that caused `SamplerCustomAdvanced` NameError.
- Retained tested low-memory latent upscale processing and preservation of independent maximum-size references during two-stage sampling.
- Added append-only final_latent and refine_context outputs; original output indices remain unchanged.
- Isolated character-sheet CSS from Director V2 and retained live previews across workflow-tab reconstruction in the same browser session.
- Removed the unused experimental author-refine schedule; normal two-stage continuation remains.

### Install or update

See the README quick start and INSTALLATION.md. Update this node pack, close ComfyUI, run the root Install-Windows.bat, then restart ComfyUI and refresh the browser. Download the updated Enhanced workflow separately; saved workflows do not automatically receive new model selections or defaults.

The dependency installer retains existing node folders rather than replacing them. Update an existing Unified Loader or other dependency through ComfyUI Manager or its normal Git update method. Back up local changes first.

### Validation and limits

Python/JavaScript checks and CPU regression tests accompany this release. Local single-stage and two-stage character-sheet renders have been exercised; this is not a clean-install certification across all GPUs. Enhanced DLSS requires its separate Windows runtime and license acceptance. Models and personal reference assets are not bundled. Polyhedron's Civitai listing is supplied, but its current download could not be independently verified.
