# Release notes

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

See the README quick start and INSTALLATION.md. Update this node pack, close ComfyUI, run Installers/Install-Windows.bat, then restart ComfyUI and refresh the browser. Download the updated Enhanced workflow separately; saved workflows do not automatically receive new model selections or defaults.

The dependency installer retains existing node folders rather than replacing them. Update an existing Unified Loader or other dependency through ComfyUI Manager or its normal Git update method. Back up local changes first.

### Validation and limits

Python/JavaScript checks and CPU regression tests accompany this release. Local single-stage and two-stage character-sheet renders have been exercised; this is not a clean-install certification across all GPUs. Enhanced DLSS requires its separate Windows runtime and license acceptance. Models and personal reference assets are not bundled. Polyhedron's Civitai listing is supplied, but its current download could not be independently verified.
