"""
Muse Character Sheet H3 [2026-09-17]

Stripped-down, single-chunk derivative of Muse-MiniMax-Director-Combo-V2
(muse_minimax_director.py). That node is a giant multi-mode (Reference / First-
Last-Frame / Combo / Music Video), multi-chunk, disk-streaming Director. This
node is permanently hardcoded to exactly what one chunk of that node does when
mode=Reference (Omni) and there is no continuation, no disk streaming, and no
Seed Hunt — i.e. one real MiniMaxH3ReferenceToVideo call.

Kept from the source node:
  - The CHUNK/CUT timeline prompt-authoring UI, constrained to exactly one
    chunk (the JS side hardcodes chunkIdx=0 throughout rather than exposing an
    Add/Delete Chunk bar).
  - MiniMax's own six-section Reference-mode prompt compiler (subject
    definitions, summary, retention analysis, detailed description, overall
    soundscape, non-diegetic music) — ported verbatim from the source file's
    per-chunk compiler, since a subtly wrong port here would silently produce
    a broken prompt.
  - The two-stage sampling / trained latent-upscale pipeline
    (MinimaxH3LatentUpscaler3D), including the final-chunk transformer-unload
    fix that prevents a real OOM before the Stage-2 upscaler loads.
  - The live "Now Generating" per-step sampling preview and the finished
    "Chunk Preview" clip player, both re-pointed at this node's own HTTP route
    and websocket event names so they don't collide with Combo V2's, which
    stays installed side-by-side.
  - Reference (Omni) reference image / video / audio slots (up to 8 character
    images + 1 Location, 3 reference videos, 3 reference audio clips).

Deliberately dropped (see the porting brief this file was built from for the
full line-by-line accounting against the source):
  - The `mode` selector entirely — First/Last Frame, Combo and Music Video
    are not present in any form.
  - Multi-chunk splitting/continuation (color match, RIFE seam blending, audio
    level matching, motion-context carry, native Reference/FL frame-zero
    keyframe carry) — all of that machinery only ever activates on chunk_idx
    > 0 or from a previous chunk's own carried state, neither of which can
    exist here since this node always renders exactly one chunk.
  - Disk streaming / resume / project checkpoints and Seed Hunt (both the
    legacy all-or-nothing toggle and the newer candidate-count version) —
    dropped along with their four candidate_N outputs and final_video_path.
  - Prompt Gen (LLM-assisted prompt authoring) and Hybrid Storyboard Guides —
    separate features, out of scope for this node.
  - model_fl2va — this node only ever has one transformer input, `model`,
    used as a plain required (non-lazy) input.

Ported [2026-09-17] by Claude from Muse-MiniMax-Director-Combo-V2's
muse_minimax_director.py.
"""
import base64
import gc
import hashlib
import io as _io
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import time
import wave

import av
import comfy.model_management
import comfy.patcher_extension
import comfy.utils
import folder_paths
import latent_preview
import node_helpers
import numpy as np
import psutil
import torch
from PIL import Image, ImageOps
from aiohttp import web
from server import PromptServer

from comfy_extras.nodes_minimax_h3 import (
    MiniMaxH3ReferenceToVideo, align_frame_count, CANVAS_MULTIPLE,
)
from comfy_extras.nodes_resolution import AspectRatio, ASPECT_RATIOS

log = logging.getLogger(__name__)

# In-memory capability map for the finished "Chunk Preview" clip. The browser
# receives an opaque token rather than an arbitrary filesystem path, so the
# HTTP route below can only ever serve a file this node itself just wrote.
# [2026-09-17] Deliberately this node's OWN dict/route/event names, not a
# shared one with Muse-MiniMax-Director-Combo-V2 — that node stays installed
# side-by-side and must never collide with this one's tokens or websocket
# events.
_STREAMED_PREVIEW_FILES = {}

# [2026-09-09 / ported 2026-09-17] Final-chunk transformer unload right before
# the decode/mux finale. Confirmed on the source node to free real system RAM,
# not just VRAM, ahead of the VAEDecode call. Since this node only ever
# renders one chunk, that chunk is always "the final chunk" — this fires on
# every single run rather than only the last of several.
_MUSE_FINAL_CHUNK_UNLOAD = True


# ---------------------------------------------------------------------------
# Small utilities ported verbatim from the source file.
# ---------------------------------------------------------------------------

def _stream_safe_name(value):
    """Turn a user run label into one safe folder/file component."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip()).strip("._")
    return cleaned[:80] or "run"


def _atomic_torch_save(path, value):
    temp_path = f"{path}.tmp"
    torch.save(value, temp_path)
    os.replace(temp_path, path)


def _load_stream_chunk(path):
    # This file is created locally by this node, not accepted from uploads.
    try:
        return torch.load(path, map_location="cpu", weights_only=False)
    except TypeError:  # Compatibility with older PyTorch builds.
        return torch.load(path, map_location="cpu")


def _aligned_stream_waveform(payload, fps=24):
    """Align a saved chunk's audio to its own frame count before muxing."""
    waveform = payload["waveform"]
    sr = int(payload["sample_rate"])
    target = round(int(payload["frames"].shape[0]) / float(fps) * sr)
    missing = target - int(waveform.shape[-1])
    if missing > 0:
        log.warning("[MuseCharacterSheetH3] Padding %d missing audio samples "
                    "at this clip's end to prevent downstream sync drift.", missing)
        waveform = torch.nn.functional.pad(waveform, (0, missing))
    return waveform[..., :target]


def _encode_streamed_mp4(chunk_paths, output_path, fps=24, crf=14):
    """Encode one or more saved chunk(s) into a single playable MP4, never
    rebuilding a full timeline tensor in RAM to do it. Ported from the source
    node's streaming-assembly encoder — this node only ever calls it with a
    single-entry chunk_paths list (its one and only chunk's own saved
    preview payload), but the implementation itself is unchanged so the
    per-frame streaming-to-ffmpeg behavior stays exactly as tested there."""
    if not chunk_paths:
        raise RuntimeError("No completed chunk file to build a preview from.")

    first = _load_stream_chunk(chunk_paths[0])
    first_frames = first["frames"]
    if first_frames.ndim != 4 or first_frames.shape[0] == 0:
        raise RuntimeError("Chunk preview source has an empty video chunk.")
    height, width = int(first_frames.shape[1]), int(first_frames.shape[2])
    sample_rate = int(first["sample_rate"])
    first_waveform = first["waveform"]
    channels = int(first_waveform.shape[-2])
    del first_frames, first_waveform
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    partial_path = f"{output_path}.partial.mp4"
    video_only_path = f"{output_path}.video.partial.mp4"
    audio_wave_path = f"{output_path}.audio.partial.wav"
    for path in (partial_path, video_only_path, audio_wave_path):
        if os.path.exists(path):
            os.remove(path)

    ffmpeg_candidates = [
        shutil.which("ffmpeg"),
        os.path.join(sys.prefix, "Library", "bin", "ffmpeg.exe"),
        os.path.join(sys.prefix, "bin", "ffmpeg.exe"),
    ]
    ffmpeg_path = next((path for path in ffmpeg_candidates if path and os.path.isfile(path)), None)
    if not ffmpeg_path:
        raise RuntimeError("The Chunk Preview needs FFmpeg, but no ffmpeg executable "
                            "was found in ComfyUI's environment.")

    video_command = [
        ffmpeg_path, "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
        "-r", str(fps), "-i", "pipe:0", "-an",
        "-c:v", "libx264", "-preset", "slow", "-crf", str(int(crf)), "-pix_fmt", "yuv420p",
        video_only_path,
    ]
    process = subprocess.Popen(video_command, stdin=subprocess.PIPE)
    total_video_frames = 0
    try:
        with wave.open(audio_wave_path, "wb") as audio_file:
            audio_file.setnchannels(channels)
            audio_file.setsampwidth(2)
            audio_file.setframerate(sample_rate)
            for chunk_index, chunk_path in enumerate(chunk_paths):
                payload = first if chunk_index == 0 else _load_stream_chunk(chunk_path)
                if chunk_index == 0:
                    first = None
                frames = payload["frames"]
                if int(payload["sample_rate"]) != sample_rate:
                    raise RuntimeError("Chunk preview source has inconsistent audio sample rates.")
                if tuple(frames.shape[1:3]) != (height, width):
                    raise RuntimeError("Chunk preview source has inconsistent video resolutions.")
                total_video_frames += int(frames.shape[0])
                # Bound the transient bytes allocation to one frame, not a full clip.
                for frame_index in range(int(frames.shape[0])):
                    process.stdin.write(frames[frame_index:frame_index + 1].contiguous().numpy().tobytes())

                waveform = _aligned_stream_waveform(payload, fps)
                if waveform.ndim == 3:
                    waveform = waveform[0]
                if waveform.shape[0] == 1 and channels == 2:
                    waveform = waveform.repeat(2, 1)
                elif waveform.shape[0] > channels:
                    waveform = waveform[:channels]
                pcm = waveform.to(torch.float32).clamp(-1.0, 1.0).mul(32767.0).round().to(torch.int16)
                audio_file.writeframes(pcm.transpose(0, 1).contiguous().numpy().tobytes())
                del payload, frames, waveform, pcm
    except Exception:
        process.kill()
        process.wait()
        raise
    finally:
        if process.stdin:
            try:
                process.stdin.close()
            except OSError:
                if process.poll() in (None, 0):
                    raise
    return_code = process.wait()
    if return_code != 0:
        raise RuntimeError(f"FFmpeg video encode failed with exit code {return_code}.")

    video_duration = total_video_frames / float(fps)
    mux_command = [
        ffmpeg_path, "-y", "-loglevel", "error", "-i", video_only_path, "-i", audio_wave_path,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-af", "apad", "-t", f"{video_duration:.9f}", partial_path,
    ]
    subprocess.run(mux_command, check=True)

    # Windows (unlike Mac/Linux) refuses to rename a file over an existing
    # destination that anything currently has open — a video player, a
    # browser tab still showing the previous result, even an Explorer
    # thumbnail. That's usually transient, so retry briefly before treating
    # it as a real failure rather than hard-crashing on the first attempt.
    for attempt in range(5):
        try:
            os.replace(partial_path, output_path)
            break
        except PermissionError:
            if attempt == 4:
                raise PermissionError(
                    f"Could not replace {output_path} — something else has it open "
                    "(a video player, a browser tab showing it, Explorer's preview). "
                    "Close whatever's viewing that file and try again."
                )
            time.sleep(1.0)
    for path in (video_only_path, audio_wave_path):
        if os.path.isfile(path):
            os.remove(path)
    return output_path


def _push_chunk_preview(unique_id, stream_chunk_path, stream_run_dir, crf=14):
    """Encode the just-saved chunk payload into a small MP4 and push it live
    to the browser as the finished "Chunk Preview" clip. Reuses the same
    _STREAMED_PREVIEW_FILES token + view-streamed-video route pattern the
    source node uses, under this node's own route/event names. Never allowed
    to break the actual generation — any failure here is logged and
    swallowed, not raised."""
    if not unique_id:
        return
    try:
        preview_path = os.path.join(stream_run_dir, "chunk_0001_preview.mp4")
        chunk_mtime = os.path.getmtime(stream_chunk_path)
        if not (os.path.isfile(preview_path) and os.path.getmtime(preview_path) >= chunk_mtime):
            _encode_streamed_mp4([stream_chunk_path], preview_path, fps=24, crf=crf)
        stat = os.stat(preview_path)
        token_source = f"{preview_path}|{stat.st_mtime_ns}|{stat.st_size}".encode("utf-8")
        token = hashlib.sha256(token_source).hexdigest()
        _STREAMED_PREVIEW_FILES[token] = preview_path
        PromptServer.instance.send_sync("muse_character_sheet_h3_chunk_preview", {
            "node": str(unique_id),
            "chunk_index": 1,
            "token": token,
        })
    except Exception:
        log.warning(
            "[MuseCharacterSheetH3] Could not build the finished Chunk Preview "
            "(main generation is unaffected).", exc_info=True,
        )


def _push_ephemeral_chunk_preview(unique_id, frames, waveform, sample_rate):
    """Build the finished-clip preview from decoded frames/audio still in
    memory (this node never streams chunks to disk), persisting only a small
    temporary payload long enough to reuse the same MP4 encoder/event route
    as a durable checkpoint would have."""
    if not unique_id:
        return
    try:
        preview_dir = os.path.join(
            folder_paths.get_temp_directory(),
            "MuseCharacterSheetH3_ChunkPreviews",
            _stream_safe_name(str(unique_id)),
        )
        os.makedirs(preview_dir, exist_ok=True)
        payload_path = os.path.join(preview_dir, "chunk_0001.pt")
        payload = {
            "frames": frames.detach().to("cpu").clamp(0.0, 1.0).mul(255.0).round().to(torch.uint8),
            "waveform": waveform.detach().to("cpu", torch.float32),
            "sample_rate": int(sample_rate),
        }
        _atomic_torch_save(payload_path, payload)
        _push_chunk_preview(unique_id, payload_path, preview_dir)
    except Exception:
        log.warning(
            "[MuseCharacterSheetH3] Could not build the completed preview "
            "(main generation is unaffected).", exc_info=True,
        )


# ---------------------------------------------------------------------------
# [2026-09-08 / ported 2026-09-17] Native "Now Generating" live sampling
# preview — one frame per step, broadcast straight from this node's own
# sampling calls. Ported verbatim from the source file's mechanism (see its
# own long comment block for the full story on why it works: cloning the
# model and attaching an OUTER_SAMPLE wrapper before building a guider from
# it causes that wrapper to fire during this node's own internal
# SamplerCustomAdvanced calls). Only the event name changes, so it can't
# collide with Combo V2's identical mechanism running on the same server.
# ---------------------------------------------------------------------------
_MUSE_LIVE_PREVIEW_EVENT = "muse_character_sheet_h3_live_preview"
_MUSE_LIVE_PREVIEW_MAX_RES = 384
_MUSE_LIVE_PREVIEW_JPEG_QUALITY = 80
_MUSE_LIVE_PREVIEW_MAX_FRAMES = 124
_MUSE_LIVE_PREVIEW_FPS = 24
_MUSE_LIVE_PREVIEW_WEBP_QUALITY = 75


def _muse_decode_video_frames_l2rgb(x0, latent_format, max_frames, stride=1):
    """Ported from KJNodes' preview_override_node.py (_decode_video_frames_l2rgb)
    — bulk Latent2RGB decode across a video latent's own temporal dimension,
    rather than Latent2RGBPreviewer's single-frame-only decode_latent_to_preview.
    x0 is (B, C, T, H, W); returns a list of PIL Images, one per sampled frame."""
    if x0.ndim != 5:
        return []
    rgb_factors = getattr(latent_format, "latent_rgb_factors", None)
    if rgb_factors is None:
        return []
    try:
        reshape = getattr(latent_format, "latent_rgb_factors_reshape", None)
        if reshape is not None:
            x0 = reshape(x0)
        bias = getattr(latent_format, "latent_rgb_factors_bias", None)
        factors = torch.tensor(rgb_factors, device=x0.device, dtype=x0.dtype).transpose(0, 1)
        bias_t = torch.tensor(bias, device=x0.device, dtype=x0.dtype) if bias is not None else None
        x = x0[0]
        if stride > 1:
            x = x[:, ::stride]
        t_total = x.shape[1]
        if max_frames > 0 and max_frames < t_total:
            indices = np.linspace(0, t_total - 1, max_frames).round().astype(int).tolist()
            x = x[:, indices]
        x = x.movedim(0, -1)
        rgb = torch.nn.functional.linear(x, factors, bias=bias_t)
        rgb.add_(1.0).mul_(127.5).clamp_(0, 255)
        rgb_cpu = rgb.to(torch.uint8).cpu().numpy()
        return [Image.fromarray(rgb_cpu[i]) for i in range(rgb_cpu.shape[0])]
    except Exception:
        return []


def _muse_encode_animated_webp(frames, fps, quality, max_res):
    """Ported from KJNodes' preview_override_node.py (_encode_animated_webp)."""
    if not frames:
        return None
    pil_frames = []
    for f in frames:
        pf = f if f.mode == "RGB" else f.convert("RGB")
        if max_res and max_res > 0 and (pf.width > max_res or pf.height > max_res):
            pf = ImageOps.contain(pf, (max_res, max_res), Image.LANCZOS)
        pil_frames.append(pf)
    duration_ms = max(1, int(round(1000 / max(1, fps))))
    buf = _io.BytesIO()
    try:
        pil_frames[0].save(
            buf, format="WEBP", save_all=True, append_images=pil_frames[1:],
            duration=duration_ms, loop=0, quality=quality, method=4,
        )
    except Exception:
        return None
    return base64.b64encode(buf.getvalue()).decode("ascii"), pil_frames[0].width, pil_frames[0].height


class _MuseChunkPreviewWrapper:
    """OUTER_SAMPLE wrapper (see module comment above) — decodes and
    broadcasts a short animated preview clip (or a single frame, for a still-
    image latent) per sampling step. Attached fresh per Stage-1/Stage-2 pass,
    so `unique_id` is baked in at attach time, not threaded through the
    sampler call itself."""

    def __init__(self, unique_id):
        self.unique_id = str(unique_id) if unique_id else None

    def __call__(self, executor, noise, latent_image, sampler, sigmas, denoise_mask, callback, disable_pbar, seed, latent_shapes):
        if not self.unique_id or PromptServer is None:
            return executor(noise, latent_image, sampler, sigmas, denoise_mask, callback, disable_pbar, seed, latent_shapes=latent_shapes)

        guider = executor.class_obj
        model_patcher = guider.model_patcher
        # latent_preview.get_previewer() respects the server's own
        # --preview-method setting and returns None outright if that's set to
        # anything restrictive. Fall back to building one directly from the
        # model's own latent_rgb_factors so this never silently goes dark
        # just because of a server-wide setting this node has no reason to
        # depend on — same fix as the source node's own copy of this wrapper.
        previewer = None
        try:
            previewer = latent_preview.get_previewer(model_patcher.load_device, model_patcher.model.latent_format)
        except Exception:
            previewer = None
        if previewer is None:
            try:
                lf = model_patcher.model.latent_format
                rgb_factors = getattr(lf, "latent_rgb_factors", None)
                if rgb_factors is not None:
                    previewer = latent_preview.Latent2RGBPreviewer(
                        rgb_factors,
                        getattr(lf, "latent_rgb_factors_bias", None),
                        getattr(lf, "latent_rgb_factors_reshape", None),
                    )
            except Exception:
                previewer = None

        original_callback = callback
        unique_id = self.unique_id

        def new_callback(step, x0, x, total_steps_):
            if previewer is not None:
                try:
                    # x0 arrives in the sampler's own packed/flat form, not a
                    # plain (B,C,T,H,W) video tensor — reshape it back using
                    # latent_shapes, same fix KJNodes' own preview node uses.
                    x0_view = x0
                    if latent_shapes and len(latent_shapes) > 0 and x0.ndim == 3:
                        target = latent_shapes[0]
                        if len(target) >= 3:
                            cut = 1
                            for d in target[1:]:
                                cut *= int(d)
                            x0_view = x0[:, :, :cut].reshape([x0.shape[0]] + list(target)[1:])
                    payload_image = None
                    payload_mime = "image/jpeg"
                    payload_w = payload_h = 0
                    frames = (
                        _muse_decode_video_frames_l2rgb(
                            x0_view, model_patcher.model.latent_format, _MUSE_LIVE_PREVIEW_MAX_FRAMES,
                        )
                        if x0_view.ndim == 5 else []
                    )
                    if len(frames) > 1:
                        encoded = _muse_encode_animated_webp(
                            frames, _MUSE_LIVE_PREVIEW_FPS, _MUSE_LIVE_PREVIEW_WEBP_QUALITY,
                            _MUSE_LIVE_PREVIEW_MAX_RES,
                        )
                        if encoded is not None:
                            payload_image, payload_w, payload_h = encoded
                            payload_mime = "image/webp"
                    if payload_image is None:
                        single_view = x0_view[:, :, :1] if x0_view.ndim == 5 else x0_view
                        pil_image = previewer.decode_latent_to_preview(single_view)
                        if pil_image is not None:
                            if pil_image.mode != "RGB":
                                pil_image = pil_image.convert("RGB")
                            if pil_image.width > _MUSE_LIVE_PREVIEW_MAX_RES or pil_image.height > _MUSE_LIVE_PREVIEW_MAX_RES:
                                pil_image.thumbnail(
                                    (_MUSE_LIVE_PREVIEW_MAX_RES, _MUSE_LIVE_PREVIEW_MAX_RES), Image.LANCZOS,
                                )
                            buf = _io.BytesIO()
                            pil_image.save(buf, format="JPEG", quality=_MUSE_LIVE_PREVIEW_JPEG_QUALITY)
                            payload_image = base64.b64encode(buf.getvalue()).decode("ascii")
                            payload_w, payload_h = pil_image.width, pil_image.height
                    if payload_image is not None:
                        PromptServer.instance.send_sync(_MUSE_LIVE_PREVIEW_EVENT, {
                            "node": unique_id,
                            "step": step + 1,
                            "total": total_steps_,
                            "image": payload_image,
                            "mime": payload_mime,
                            "w": payload_w,
                            "h": payload_h,
                        })
                except Exception:
                    log.warning(
                        "[MuseCharacterSheetH3] Live preview frame failed at step %d "
                        "(generation is unaffected).", step + 1, exc_info=True,
                    )
            if original_callback is not None:
                original_callback(step, x0, x, total_steps_)

        return executor(noise, latent_image, sampler, sigmas, denoise_mask, new_callback, disable_pbar, seed, latent_shapes=latent_shapes)


def _attach_chunk_live_preview(model, unique_id):
    """Returns a cloned model with the live-preview wrapper attached — call
    once right before building the guider that will actually sample it.
    Never raises: a failure here should cost a live preview, not the render."""
    if not unique_id:
        return model
    if PromptServer is None:
        return model
    try:
        wrapped = model.clone()
        wrapped.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.OUTER_SAMPLE,
            "muse_character_sheet_h3_live_preview",
            _MuseChunkPreviewWrapper(unique_id),
        )
        return wrapped
    except Exception:
        log.warning(
            "[MuseCharacterSheetH3] Could not attach the live preview wrapper "
            "(generation is unaffected, no live preview this run).", exc_info=True,
        )
        return model


# ---------------------------------------------------------------------------
# Prompt-compiler / reference-loading helpers, ported verbatim.
# ---------------------------------------------------------------------------

MAX_CHARACTER_SLOTS = 8
ASPECT_RATIO_OPTIONS = [a.value for a in AspectRatio]
SUPPORTED_MEGAPIXELS = (0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1.0, 1.2, 1.5, 1.8, 2.0)
_V4_FPS = 24


def _execute_comfy_node(node_class, **kwargs):
    """Invoke a ComfyUI node's main entrypoint, whether it is a comfy_api io.ComfyNode
    (classmethod 'execute') or a legacy node (instance method named by FUNCTION)."""
    if hasattr(node_class, "execute"):
        return node_class.execute(**kwargs)
    fn_name = getattr(node_class, "FUNCTION", None)
    instance = node_class()
    if fn_name and hasattr(instance, fn_name):
        return getattr(instance, fn_name)(**kwargs)
    raise RuntimeError(f"Could not determine how to execute node {node_class!r}")


def _unpack_node_result(out):
    """Normalise a node return (io.NodeOutput, tuple, list or dict) into a tuple of outputs."""
    if out is None:
        return ()
    for attr in ("result", "args", "values", "outputs"):
        if hasattr(out, attr):
            val = getattr(out, attr)
            if callable(val):
                try:
                    val = val()
                except Exception:
                    continue
            if isinstance(val, (tuple, list)):
                return tuple(val)
    if isinstance(out, (tuple, list)):
        return tuple(out)
    if isinstance(out, dict) and isinstance(out.get("result"), (tuple, list)):
        return tuple(out["result"])
    return (out,)


def _resolve_resolution(aspect_ratio: str, megapixels: float, multiple: int):
    """Exact port of the stock ResolutionSelector node's own formula."""
    w_ratio, h_ratio = ASPECT_RATIOS[AspectRatio(aspect_ratio)]
    total_pixels = megapixels * 1024 * 1024
    scale = math.sqrt(total_pixels / (w_ratio * h_ratio))
    width = round(w_ratio * scale / multiple) * multiple
    height = round(h_ratio * scale / multiple) * multiple
    return width, height


def _fit_image_to_target(tensor: torch.Tensor, target_w: int, target_h: int, method: str) -> torch.Tensor:
    """Resizes an [N,H,W,C] IMAGE tensor to exactly (target_h, target_w), using
    one of three standard fit strategies. Only the "stretch" method is
    actually used by this node (in _rebuild_refs_conditioning_for_stage2's
    Stage-2 image-reference rebuild), but the full function is ported so that
    call site's own logic matches the source exactly."""
    if tensor is None:
        return None
    if str(method or "").strip().lower() == "original":
        return tensor
    n, h, w, c = tensor.shape
    if h == target_h and w == target_w:
        return tensor
    chw = tensor.permute(0, 3, 1, 2)
    if method == "stretch":
        resized = torch.nn.functional.interpolate(chw, size=(target_h, target_w), mode="bilinear", align_corners=False)
        return resized.permute(0, 2, 3, 1).clamp(0, 1)
    scale = max(target_w / w, target_h / h) if method == "crop" else min(target_w / w, target_h / h)
    new_w = max(1, round(w * scale))
    new_h = max(1, round(h * scale))
    resized = torch.nn.functional.interpolate(chw, size=(new_h, new_w), mode="bilinear", align_corners=False)
    resized = resized.permute(0, 2, 3, 1).clamp(0, 1)
    if method == "crop":
        top = max(0, (new_h - target_h) // 2)
        left = max(0, (new_w - target_w) // 2)
        return resized[:, top:top + target_h, left:left + target_w, :]
    canvas = torch.zeros((n, target_h, target_w, c), dtype=resized.dtype)
    top = max(0, (target_h - new_h) // 2)
    left = max(0, (target_w - new_w) // 2)
    canvas[:, top:top + new_h, left:left + new_w, :] = resized
    return canvas


def _make_uniform_preview_batch(images):
    """Batch differently sized native references for the optional IMAGE output.

    H3 conditioning never uses this batch; it receives the original tensors one by
    one. ComfyUI IMAGE batches, however, require identical H/W dimensions. Centre-pad
    separate output copies to the largest native canvas so ref_images_used remains
    usable without cropping, stretching, or changing the actual H3 reference path.
    """
    images = [image for image in images if image is not None and image.ndim == 4 and image.shape[0] > 0]
    if not images:
        return None
    max_h = max(int(image.shape[1]) for image in images)
    max_w = max(int(image.shape[2]) for image in images)
    padded = []
    for image in images:
        for frame in image:
            frame = frame.unsqueeze(0)
            _, h, w, c = frame.shape
            if h == max_h and w == max_w:
                padded.append(frame)
                continue
            corner_colour = torch.stack((
                frame[0, 0, 0], frame[0, 0, w - 1],
                frame[0, h - 1, 0], frame[0, h - 1, w - 1],
            )).mean(dim=0)
            canvas = corner_colour.view(1, 1, 1, c).expand(1, max_h, max_w, c).clone()
            top = (max_h - h) // 2
            left = (max_w - w) // 2
            canvas[:, top:top + h, left:left + w, :] = frame
            padded.append(canvas)
    return torch.cat(padded, dim=0)


def _load_image_source(b64_or_url: str, filename: str = "") -> torch.Tensor:
    if not b64_or_url:
        return None
    try:
        b64_str = b64_or_url
        if "," in b64_str:
            b64_str = b64_str.split(",", 1)[1]
        img_bytes = base64.b64decode(b64_str)
        img = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
        arr = np.array(img, dtype=np.float32) / 255.0
        return torch.from_numpy(arr).unsqueeze(0)
    except Exception as e:
        log.warning("[MuseCharacterSheetH3] Could not decode reference image %s: %s", filename, e)
        return None


def _load_character_image(entry: dict):
    """Character/background reference images upload through a small file-path
    string in timeline_data, not embedded base64 (that blew past the
    browser's per-entry workflow draft-autosave budget). Falls back to legacy
    inline base64 for cards saved before that change."""
    if entry.get("file"):
        file_path = _resolve_path(entry["file"])
        if not file_path or not os.path.exists(file_path):
            log.warning("[MuseCharacterSheetH3] Reference image not found: %s", entry.get("name", entry.get("file", "")))
            return None
        try:
            img = Image.open(file_path).convert("RGB")
            arr = np.array(img, dtype=np.float32) / 255.0
            return torch.from_numpy(arr).unsqueeze(0)
        except Exception as e:
            log.warning("[MuseCharacterSheetH3] Could not load reference image %s: %s", entry.get("name", ""), e)
            return None
    if entry.get("image_b64"):
        return _load_image_source(entry["image_b64"], entry.get("name", ""))
    return None


def _parse_timeline(timeline_data: str) -> dict:
    try:
        data = json.loads(timeline_data) if timeline_data and timeline_data.strip() else {}
    except Exception as e:
        log.warning("[MuseCharacterSheetH3] Could not parse timeline_data: %s", e)
        data = {}
    data.setdefault("characters", [])
    data.setdefault("chunks", [])
    data.setdefault("locations", [])
    data.setdefault("refVideos", [])
    data.setdefault("refAudios", [])
    return data


def _resolve_location_for_chunk(locations: list, chunk_number: int):
    """Return the latest Location whose start chunk is <= this chunk."""
    active = None
    active_start = -1
    for entry in locations or []:
        if not isinstance(entry, dict) or not (entry.get("file") or entry.get("image_b64")):
            continue
        try:
            start = max(1, int(entry.get("chunk", 1) or 1))
        except (TypeError, ValueError):
            start = 1
        if start <= int(chunk_number) and start >= active_start:
            active = entry
            active_start = start
    return active


def _resolve_path(rel: str) -> str:
    """Reference video/audio clips are uploaded through ComfyUI's own
    /upload/image endpoint (works for any file type despite the name) into
    the input dir; same multi-base fallback lookup as the source node."""
    if not rel:
        return ""
    input_dir = folder_paths.get_input_directory()
    for base in (input_dir, os.path.join(input_dir, "musedirector"), os.path.join(input_dir, "muse")):
        p = os.path.join(base, os.path.basename(rel))
        if os.path.exists(p):
            return p
    p = os.path.join(input_dir, rel)
    return p if os.path.exists(p) else ""


def _load_ref_video_tensor(entry: dict, max_frames: int = 362):
    """Decode a selected reference-video window at H3's native 24fps, sampling
    the complete selected time window into the nearest valid H3 frame count
    (5+17n) so real duration is preserved without just truncating frames."""
    file_path = _resolve_path(entry.get("file", ""))
    if not file_path or not os.path.exists(file_path):
        log.warning("[MuseCharacterSheetH3] Reference video not found: %s", entry.get("fileName", entry.get("file", "")))
        return None
    start_sec = float(entry.get("trimStartSec", 0) or 0)
    end_sec = entry.get("trimEndSec")
    frames = []
    try:
        with av.open(file_path) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            if end_sec is None:
                if stream.duration is not None and stream.time_base:
                    end_sec = float(stream.duration * stream.time_base)
                elif container.duration is not None:
                    end_sec = float(container.duration / av.time_base)
            if end_sec is None:
                end_sec = start_sec + (max_frames / 24.0)
            end_sec = max(start_sec + (5.0 / 24.0), float(end_sec))
            selected_duration = end_sec - start_sec

            valid_counts = list(range(5, max_frames + 1, 17))
            requested_count = max(5, min(max_frames, round(selected_duration * 24.0)))
            target_count = min(valid_counts, key=lambda n: abs(n - requested_count))
            if target_count == 1:
                target_times = [start_sec]
            else:
                target_times = [
                    start_sec + selected_duration * i / (target_count - 1)
                    for i in range(target_count)
                ]
            target_idx = 0
            last_rgb = None
            if stream.time_base:
                seek_pts = int(max(0, start_sec - 0.5) / float(stream.time_base))
            else:
                seek_pts = int(max(0, start_sec - 0.5) * av.time_base)
            container.seek(seek_pts, stream=stream, backward=True)
            for frame in container.decode(stream):
                frame_time = frame.time
                if frame_time is None and frame.pts is not None and stream.time_base:
                    frame_time = float(frame.pts * stream.time_base)
                if frame_time is None:
                    frame_time = 0.0
                if frame_time < start_sec - 0.01:
                    continue
                if frame_time > end_sec + 0.01:
                    break
                last_rgb = frame.to_ndarray(format="rgb24")
                while target_idx < target_count and target_times[target_idx] <= frame_time + 0.0005:
                    frames.append(last_rgb.copy())
                    target_idx += 1
                if target_idx >= target_count:
                    break
            while target_idx < target_count and last_rgb is not None:
                frames.append(last_rgb.copy())
                target_idx += 1
    except Exception as exc:
        log.warning("[MuseCharacterSheetH3] Reference video decode error (%s): %s", entry.get("fileName", ""), exc)
        return None
    if not frames:
        return None
    frames_np = np.array(frames, dtype=np.float32) / 255.0
    return torch.from_numpy(frames_np)


def _load_ref_audio_clip(entry: dict, target_sr: int = 44100):
    """Decodes the [trimStartSec, trimEndSec) window of an uploaded reference
    audio clip into an AUDIO dict, for H3's ref_audios input."""
    file_path = _resolve_path(entry.get("file", ""))
    if not file_path or not os.path.exists(file_path):
        log.warning("[MuseCharacterSheetH3] Reference audio not found: %s", entry.get("fileName", entry.get("file", "")))
        return None
    start_sec = float(entry.get("trimStartSec", 0) or 0)
    end_sec = entry.get("trimEndSec")
    try:
        clip_frames = []
        with av.open(file_path) as container:
            if not container.streams.audio:
                return None
            stream = container.streams.audio[0]
            resampler = av.AudioResampler(format="fltp", layout="stereo", rate=target_sr)
            for frame in container.decode(stream):
                for rf in resampler.resample(frame):
                    clip_frames.append(torch.from_numpy(rf.to_ndarray()))
            for rf in resampler.resample(None):
                clip_frames.append(torch.from_numpy(rf.to_ndarray()))
        if not clip_frames:
            return None
        waveform = torch.cat(clip_frames, dim=1)  # [2, samples]
        start_sample = max(0, min(int(start_sec * target_sr), waveform.shape[1]))
        end_sample = waveform.shape[1] if end_sec is None else max(start_sample, min(int(float(end_sec) * target_sr), waveform.shape[1]))
        trimmed = waveform[:, start_sample:end_sample]
        if trimmed.shape[1] == 0:
            return None
        return {"waveform": trimmed.unsqueeze(0), "sample_rate": target_sr}
    except Exception as exc:
        log.warning("[MuseCharacterSheetH3] Reference audio decode error (%s): %s", entry.get("fileName", ""), exc)
        return None


def _effective_character_entries(shared, local=None):
    """Keep UI slot positions; explicit sharing-off never leaks into a chunk.

    Missing shared flags retain legacy behavior. Filled local cards override
    their matching slot without modifying the shared library.
    """
    shared, local = shared or [], local or []
    result = []
    for idx in range(MAX_CHARACTER_SLOTS):
        own = local[idx] if idx < len(local) else None
        entry = shared[idx] if idx < len(shared) else None
        if own and (own.get("file") or own.get("image_b64")):
            result.append(own)
        else:
            result.append(entry if entry and entry.get("shared") is not False else None)
    return result


def _build_character_subjects(tdata: dict):
    """Character reference images become both H3's ref_images (dense fill-order
    Picture tags) AND <Subject N> definitions citing them. Returns
    (ref_images, subject_lines, retention_meta, subject_number_by_char_index).
    """
    characters = tdata.get("characters", [])[:MAX_CHARACTER_SLOTS]

    ref_images = {}
    subject_lines = []
    retention_meta = []
    subject_number_by_char_index = {}

    for idx, ch in enumerate(characters):
        if not ch or not (ch.get("file") or ch.get("image_b64")):
            continue
        tensor = _load_character_image(ch)
        if tensor is None:
            continue
        slot = len(ref_images)
        ref_images[f"ref_image_{slot}"] = tensor
        picture_n = slot + 1
        subject_n = len(subject_lines) + 1
        subject_number_by_char_index[idx] = subject_n
        desc = (ch.get("description") or "").strip()
        if desc:
            subject_lines.append(f"<Subject {subject_n}> is {desc} (from `<Picture {picture_n}>`).")
        else:
            subject_lines.append(f"<Subject {subject_n}> is the subject shown in `<Picture {picture_n}>`.")
        retention = ch.get("retention") or "fully_preserved"
        retention_meta.append((subject_n, picture_n, retention))

    return ref_images, subject_lines, retention_meta, subject_number_by_char_index


# [2026-09-18] Every free-text box in this node lets you write "REF 1", "REF 2"
# etc. in plain English — nobody hand-types a raw H3 tag anywhere else, the
# compiler resolves it under the hood (see _find_subject_shot_appearances'
# own "ref\s*#?\s*(\d+)" matching for CUT/shot text). refmod_description used
# to be the one exception, requiring a hand-typed `<Picture N>` — a real
# inconsistency, and confusing besides: N depends on dense fill-order among
# whatever's actually populated (RefMod always empties Ref 1's slot, so Ref 2
# might be Picture 1, not Picture 2). This resolves the same plain "REF N"
# convention automatically instead, using whatever Picture number that Ref
# slot genuinely computes to right now.
_REF_MENTION_RE = re.compile(r'\bref(?:erence)?\s*#?\s*(\d+)\b', re.IGNORECASE)


def _resolve_ref_mentions_to_pictures(text: str, picture_number_by_char_index: dict) -> str:
    if not text:
        return text

    def _replace(m: "re.Match") -> str:
        char_idx = int(m.group(1)) - 1
        picture_n = picture_number_by_char_index.get(char_idx)
        # Left unresolved (not guessed) when that Ref slot isn't actually a
        # populated picture right now — e.g. Ref 1 itself while RefMod owns
        # it, or a typo'd slot number.
        return f"`<Picture {picture_n}>`" if picture_n is not None else m.group(0)

    return _REF_MENTION_RE.sub(_replace, text)


_DIALOGUE_RE = re.compile(r'"([^"]*)"')
_REPEATED_PUNCT_RE = re.compile(r'([.!?,])\1+')
_DECORATIVE_RE = re.compile(r'[~]{2,}|[*_#]+')


def _collapse_repeated_punct(m: "re.Match") -> str:
    """A run of 3 literal periods is a real ellipsis ("...got it.") — a
    meaningful pause, not decorative repeated punctuation like "!!!" or "??".
    Keep exactly "..." for a run of 3+ periods; collapse everything else."""
    ch = m.group(1)
    if ch == '.' and len(m.group(0)) >= 3:
        return '...'
    return ch


def _format_timestamp(seconds: float) -> str:
    """MM:SS.mmm, per MiniMax's own shot-marker format ('[Shot N] At MM:SS.mmm, ...')."""
    seconds = max(0.0, seconds)
    minutes = int(seconds // 60)
    remainder = seconds - minutes * 60
    return f"{minutes:02d}:{remainder:06.3f}"


def _normalize_dialogue_text(text: str) -> str:
    """Per the guide's own §5.4 rules: standardize punctuation to basic marks,
    strip decorative/repeated punctuation, end complete statements with ./?/!."""
    text = text.strip()
    text = _DECORATIVE_RE.sub('', text)
    text = _REPEATED_PUNCT_RE.sub(_collapse_repeated_punct, text)
    text = text.rstrip(',').strip()
    if text and text[-1] not in '.!?':
        text += '.'
    return text


def _wrap_dialogue(text: str, language: str, speaker_ids: list | None = None,
                   subject_ids: list | None = None, audio_ids: list | None = None) -> str:
    """Wraps every "..."-quoted span in a CUT's text as <d>[Language] ...</d>,
    the guide's required dialogue/lyric tag — leaves everything outside quotes
    (including any <Subject N>/<Picture N>/<Video N>/<Audio N> tags) untouched."""
    quote_index = 0
    def _sub(m):
        nonlocal quote_index
        inner = _normalize_dialogue_text(m.group(1))
        tag = f"<d>[{language}] {inner}</d>"
        if speaker_ids is not None and quote_index < len(speaker_ids):
            speaker_id = speaker_ids[quote_index]
            if isinstance(speaker_id, int) and speaker_id > 0:
                subject_id = subject_ids[quote_index] if subject_ids is not None and quote_index < len(subject_ids) else None
                audio_id = audio_ids[quote_index] if audio_ids is not None and quote_index < len(audio_ids) else None
                if isinstance(subject_id, int) and subject_id > 0:
                    if isinstance(audio_id, int) and audio_id > 0:
                        tag = (
                            f"<Subject {subject_id}> (S{speaker_id}), using the voice timbre "
                            f"and measured delivery from <Audio {audio_id}>: {tag}"
                        )
                    else:
                        tag = f"<Subject {subject_id}> (S{speaker_id}): {tag}"
                else:
                    tag += f" (S{speaker_id})"
        quote_index += 1
        return tag
    return _DIALOGUE_RE.sub(_sub, text)


_SUBJECT_TAG_RE = re.compile(r'<Subject (\d+)>')


def _find_subject_shot_appearances(chunk_segments: list, subject_map=None, style_text="") -> dict:
    """Collect explicit subject requests, not every available reference image."""
    appearances = {}
    shot_num = 0
    for seg in chunk_segments:
        text = (seg.get("prompt") or "").strip()
        if not text:
            continue
        shot_num += 1
        requested = {int(m.group(1)) for m in _SUBJECT_TAG_RE.finditer(text + " " + style_text)}
        if subject_map is not None:
            for match in re.finditer(r'\bref(?:erence)?\s*#?\s*(\d+)\b', text + " " + style_text, re.IGNORECASE):
                n = subject_map.get(int(match.group(1)) - 1)
                if n is not None:
                    requested.add(n)
            if _DIALOGUE_RE.search(text):
                for char_idx in _seg_all_speaker_indices(seg):
                    n = subject_map.get(char_idx)
                    if n is not None:
                        requested.add(n)
            requested.intersection_update(subject_map.values())
        for n in sorted(requested):
            shots = appearances.setdefault(n, [])
            if shot_num not in shots:
                shots.append(shot_num)
    return appearances


def _presence_phrase(subject_n: int, appearances: dict, total_shots: int) -> str:
    """"(present throughout)" only when a subject's tag genuinely appears in every
    shot of the chunk — otherwise the guide's own "(appears in [Shot N], ...)" format."""
    shots = appearances.get(subject_n, [])
    if not shots:
        return "(referenced in this shot)"
    if total_shots > 0 and len(shots) >= total_shots:
        return "(present throughout)"
    return "(appears in " + ", ".join(f"[Shot {s}]" for s in shots) + ")"


def _seg_speaker_indices(seg: dict) -> list:
    """A CUT's speaking characters — the current multi-select field, with a
    fallback to the older single-speaker field."""
    idxs = seg.get("speakerCharIdxs")
    if isinstance(idxs, list) and idxs:
        return idxs
    legacy = seg.get("speakerCharIdx")
    return [legacy] if legacy is not None else []


def _seg_dialogue_speaker_indices(seg: dict):
    entries = seg.get("dialogueSpeakers")
    if not isinstance(entries, list):
        return None
    result = []
    for entry in entries:
        idx = entry.get("speakerCharIdx") if isinstance(entry, dict) else entry
        result.append(idx if isinstance(idx, int) and idx >= 0 else None)
    return result


def _seg_all_speaker_indices(seg: dict) -> list:
    line_idxs = _seg_dialogue_speaker_indices(seg)
    if line_idxs is None:
        return _seg_speaker_indices(seg)
    return list(dict.fromkeys(idx for idx in line_idxs if isinstance(idx, int)))


def _seg_video_reference(seg: dict):
    """Returns a CUT's explicit reference-video request, or None."""
    raw_slot = seg.get("videoRefSlot")
    if raw_slot is None or raw_slot == "":
        return None
    try:
        ui_slot = int(raw_slot)
    except (TypeError, ValueError):
        return None
    if ui_slot < 0 or ui_slot > 2:
        return None
    mode = seg.get("videoRefMode") or "motion"
    if mode not in ("motion", "camera", "motion_camera"):
        mode = "motion"
    raw_target = seg.get("videoRefTargetCharIdx")
    target_char_idx = None
    if raw_target is not None and raw_target != "":
        try:
            target_char_idx = int(raw_target)
        except (TypeError, ValueError):
            target_char_idx = None
        if target_char_idx is not None and not (0 <= target_char_idx < MAX_CHARACTER_SLOTS):
            target_char_idx = None
    return {
        "ui_slot": ui_slot,
        "mode": mode,
        "target_char_idx": target_char_idx,
    }


def _cut_video_guidance_text(video_tag: str, mode: str, target_subject_n,
                             timing_mode: str = "free", local_start: float = 0.0,
                             duration: float = 0.0) -> str:
    """Official-tagged, content-safe wording injected into one [Shot N]."""
    clauses = []
    if mode in ("motion", "motion_camera"):
        if target_subject_n is not None:
            target = f"<Subject {target_subject_n}>"
            clauses.append(
                f"Following the motion in `{video_tag}`, {target} performs the action described in this shot. "
                f"Use only movement timing and body mechanics from `{video_tag}`; preserve {target}'s identity, "
                "face, clothing and the current setting"
            )
        else:
            clauses.append(
                f"The action in this shot follows the motion in `{video_tag}`. Use only movement timing and body "
                f"mechanics from `{video_tag}`; preserve the current subjects, clothing and setting"
            )
    if mode in ("camera", "motion_camera"):
        clauses.append(
            f"The camera movement in this shot follows `{video_tag}`. Use only its camera trajectory and timing; "
            "do not copy its visible people, clothing, location or lighting"
        )
    if timing_mode == "match_ref" and duration > 0:
        local_end = local_start + duration
        clauses.append(
            f"Use the complete selected action from `{video_tag}` only within this shot, from local "
            f"{_format_timestamp(local_start)} through {_format_timestamp(local_end)}; do not begin that "
            "referenced action before this shot or continue it after this shot ends"
        )
    return ". ".join(c.rstrip(". ") for c in clauses) + "." if clauses else ""


def _build_summary_sentence(subject_tags: list, video_continuity_tag: str, carry_audio_tag: str) -> str:
    """One plain-English sentence naming the chunk's subjects."""
    if not subject_tags:
        base = "The target video follows the shot description below."
    elif len(subject_tags) == 1:
        base = f"The target video shows {subject_tags[0]}."
    else:
        base = f"The target video shows {', '.join(subject_tags[:-1])} and {subject_tags[-1]}."
    extras = []
    if video_continuity_tag:
        extras.append(f"continuing directly from {video_continuity_tag}")
    if carry_audio_tag:
        extras.append(f"carrying {carry_audio_tag} forward")
    if extras:
        base = base.rstrip(".") + ", " + ", ".join(extras) + "."
    return base


_CHUNK_OVERRIDE_HEADER_RE = re.compile(
    r'^[\-‐-―]{2,}\s*Chunk\s+(\d+)\s*/\s*(\d+)\b',
    re.IGNORECASE,
)


def _select_chunk_from_prompt_override(prompt_override: str, chunk_idx: int, num_chunks: int) -> str:
    """Select one V1.4-style Chunk N/M override section. Headerless text
    remains backward-compatible and is reused unchanged."""
    lines = prompt_override.splitlines()
    headers = []
    for line_index, line in enumerate(lines):
        match = _CHUNK_OVERRIDE_HEADER_RE.match(line.strip())
        if match:
            headers.append((line_index, int(match.group(1))))
    if not headers:
        return prompt_override.strip()

    sections = {}
    for index, (line_index, chunk_number) in enumerate(headers):
        end = headers[index + 1][0] if index + 1 < len(headers) else len(lines)
        sections[chunk_number] = "\n".join(lines[line_index + 1:end]).strip()
    target = int(chunk_idx) + 1
    if target in sections:
        return sections[target]
    highest = max(sections)
    log.warning(
        "[MuseCharacterSheetH3] prompt_override has no Chunk %d/%d section; "
        "reusing Chunk %d.", target, num_chunks, highest,
    )
    return sections[highest]


def _assemble_six_section_prompt(subject_lines: list, summary_line: str, retention_lines: list,
                                  style_line: str, shot_lines: list,
                                  soundscape_text: str, music_text: str) -> str:
    """Assembles MiniMax's own six required sections, in their required order,
    for a single H3 Reference (Omni) mode generation call: subject_definitions,
    summary, retention_analysis, detailed_description, overall_soundscape,
    non_diegetic_music."""
    parts = []
    if subject_lines:
        parts.append("subject_definitions:\n" + "\n".join(subject_lines))
    if summary_line:
        parts.append("summary:\n" + summary_line)
    if retention_lines:
        parts.append("retention_analysis:\n" + "\n".join(retention_lines))
    desc_lines = ([style_line] if style_line else []) + shot_lines
    if desc_lines:
        parts.append("detailed_description:\n" + "\n".join(desc_lines))
    parts.append("overall_soundscape:\n" + (soundscape_text.strip() if soundscape_text else "N/A"))
    parts.append("non_diegetic_music:\n" + (music_text.strip() if music_text else "N/A"))
    return "\n\n".join(parts)


def _bucket_segments_into_chunks(tdata: dict, duration_seconds: float, chunk_duration_seconds: float):
    """[2026-09-17] Reused unmodified from the source file even though this
    node only ever has one chunk — calling it with chunk_duration_seconds ==
    duration_seconds always resolves num_chunks to exactly 1, and reusing
    this working, tested function is lower-risk than reimplementing its
    per-segment weight/timing math from scratch. Returns (buckets,
    chunk_lengths, bounds), each a length-1 list."""
    saved_chunks = tdata.get("chunks") or []

    chunk_size = max(0.5, chunk_duration_seconds)
    num_chunks = max(1, math.ceil(duration_seconds / chunk_size))

    bounds = []
    cursor = 0.0
    for i in range(num_chunks):
        end = duration_seconds if i == num_chunks - 1 else min(duration_seconds, cursor + chunk_size)
        bounds.append([cursor, end])
        cursor = end

    min_chunk_seconds = 4.0
    while len(bounds) > 1 and (bounds[-1][1] - bounds[-1][0]) < min_chunk_seconds:
        bounds[-2][1] = bounds[-1][1]
        bounds.pop()

    num_chunks = len(bounds)
    buckets = []
    for i, (b_start, b_end) in enumerate(bounds):
        chunk_segments = list((saved_chunks[i].get("segments") if i < len(saved_chunks) else None) or [])
        chunk_dur = b_end - b_start
        total_weight = sum(float(s.get("weight", 1) or 1) for s in chunk_segments) or 1.0
        seg_cursor = b_start
        for seg in chunk_segments:
            seg["_abs_start"] = seg_cursor
            seg_duration = (float(seg.get("weight", 1) or 1) / total_weight) * chunk_dur
            seg["_duration_seconds"] = seg_duration
            seg_cursor += seg_duration
        buckets.append(chunk_segments)

    chunk_lengths = [end - start for start, end in bounds]
    return buckets, chunk_lengths, bounds


# [2026-09-06 / ported 2026-09-17] The Stage-2 upscale runs through a trained
# latent-upscale network (MinimaxH3LatentUpscaler3D), which needs its own
# model-folder scan, same as the source node.
_LATENT_UPSCALE_MODEL_FOLDER = "latent_upscale_models"
if _LATENT_UPSCALE_MODEL_FOLDER not in folder_paths.folder_names_and_paths:
    folder_paths.add_model_folder_path(
        _LATENT_UPSCALE_MODEL_FOLDER,
        os.path.join(folder_paths.models_dir, _LATENT_UPSCALE_MODEL_FOLDER),
    )


def _scan_latent_upscale_models():
    names = [
        name for name in folder_paths.get_filename_list(_LATENT_UPSCALE_MODEL_FOLDER)
        if os.path.splitext(name)[1].lower() in (".pth", ".safetensors")
    ]
    return names if names else [f"(place a model in ComfyUI/models/{_LATENT_UPSCALE_MODEL_FOLDER}/)"]


def _latent_resize_ref_block(blk, tgt_w_latent, tgt_h_latent):
    """Legacy-fallback path for one visual minimax_refs block: no original
    source pixels are available to re-encode fresh, so just latent-space
    resize the EXISTING (Stage-1-resolution) latent up to the Stage-2 canvas."""
    old_samples = blk["latent"]["samples"] if isinstance(blk["latent"], dict) else blk["latent"]
    is_video = old_samples.dim() == 5  # [B, C, T, H, W] vs a plain image latent's [B, C, H, W]
    if is_video:
        b, c, t, h, w = old_samples.shape
        flat = old_samples.movedim(2, 1).reshape(b * t, c, h, w)
        flat = comfy.utils.common_upscale(flat, int(tgt_w_latent), int(tgt_h_latent), "bicubic", "disabled")
        new_samples = flat.reshape(b, t, c, int(tgt_h_latent), int(tgt_w_latent)).movedim(1, 2)
    else:
        new_samples = comfy.utils.common_upscale(
            old_samples, int(tgt_w_latent), int(tgt_h_latent), "bicubic", "disabled")
    new_blk = dict(blk)
    new_blk["latent"] = {"samples": new_samples} if isinstance(blk["latent"], dict) else new_samples
    new_blk["latent_h"] = int(tgt_h_latent)
    new_blk["latent_w"] = int(tgt_w_latent)
    return new_blk


def _rebuild_keyframe_conditioning_for_stage2(
        positive, vae, chunk_first, chunk_last,
        tgt_w_latent, tgt_h_latent, frame_count, guide_frames=None):
    """This node never has a first/last keyframe or guide frames (Reference
    mode only, no Hybrid Guides), so chunk_first/chunk_last/guide_frames are
    always None here and this is always a no-op — ported anyway per the
    porting brief, since it's called unconditionally whenever
    two_stage_sampling is on and a future First/Last-style extension of this
    node would need it."""
    if chunk_first is None and chunk_last is None and not guide_frames:
        return positive
    frame_count = int(frame_count)
    if frame_count < 1:
        raise ValueError(f"Invalid Stage 2 keyframe frame_count: {frame_count}")
    tgt_w_px, tgt_h_px = int(tgt_w_latent) * 16, int(tgt_h_latent) * 16
    rebuilt = []
    if chunk_first is not None:
        img = _fit_image_to_target(chunk_first[:1], tgt_w_px, tgt_h_px, "stretch")
        rebuilt.append({"resolved_frame_index": 0, "latent": vae.encode(img)})
    for guide in (guide_frames or []):
        image = guide.get("image")
        if image is None:
            continue
        img = _fit_image_to_target(image[:1], tgt_w_px, tgt_h_px, "center")
        rebuilt.append({
            "resolved_frame_index": int(guide["frame_idx"]),
            "latent": vae.encode(img),
        })
    return node_helpers.conditioning_set_values(positive, {
        "minimax_keyframes": rebuilt,
        "minimax_frame_count": frame_count,
    })


def _rebuild_refs_conditioning_for_stage2(
        positive, vae, tgt_w_latent, tgt_h_latent, ref_image_size="match",
        chunk_ref_images=None, chunk_ref_videos=None):
    """Stage 1's minimax_refs visual latents are real VAE-encoded latents
    sized relative to Stage 1's generation resolution — two-stage sampling's
    mid-run upscale enlarges the generated video latent but leaves reference
    conditioning at that lower resolution unless rebuilt here, which is a
    genuine reference-detail/token-density shortfall (confirmed on the
    source node via a real two-stage vs single-stage render comparison).

    Reference VIDEOS are deliberately left untouched — their own sizing
    function never depends on the generation's width/height, so re-running a
    video ref through it at Stage-1 vs Stage-2 dimensions is identical. Only
    image refs (ref_image_size == "match" scales by generation pixel area)
    actually need rebuilding.

    Whenever the ORIGINAL reference image pixels used to build this chunk
    are still in scope (chunk_ref_images), each image ref block is rebuilt
    from scratch: re-resized to the Stage-2 canvas with H3's own image-ref
    sizing rule and freshly VAE-encoded. Falls back to
    _latent_resize_ref_block (a plain latent-space resize) only when no
    original pixel is available. No-op when there's no minimax_refs at all.
    """
    existing_refs = positive[0][1].get("minimax_refs") if positive else None
    if not existing_refs:
        return positive

    orig_images = list((chunk_ref_images or {}).values())
    tgt_w_px, tgt_h_px = int(tgt_w_latent) * 16, int(tgt_h_latent) * 16
    img_cursor = 0
    fresh_count, fallback_count = 0, 0
    new_refs = []
    for blk in existing_refs:
        if blk.get("kind") != "image":
            new_refs.append(blk)
            continue
        src = orig_images[img_cursor] if img_cursor < len(orig_images) else None
        img_cursor += 1
        if src is None:
            new_refs.append(_latent_resize_ref_block(blk, tgt_w_latent, tgt_h_latent))
            fallback_count += 1
            continue
        h, w = src.shape[1], src.shape[2]
        if ref_image_size == "match":
            scale = min(1.0, math.sqrt((tgt_w_px * tgt_h_px) / (w * h)))
        else:
            scale = min(1.0, 768 / min(w, h))
        tw = max(CANVAS_MULTIPLE, round(w * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        th = max(CANVAS_MULTIPLE, round(h * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        resized = _fit_image_to_target(src[:1], tw, th, "stretch")
        z = vae.encode(resized)
        new_blk = dict(blk)
        new_blk["latent_h"], new_blk["latent_w"], new_blk["latent"] = th // 16, tw // 16, z
        new_refs.append(new_blk)
        fresh_count += 1

    if fresh_count:
        log.info("[MuseCharacterSheetH3] Stage 2: freshly re-encoded %d Stage-2 visual "
                  "reference(s) from source pixels.", fresh_count)
    if fallback_count:
        log.info("[MuseCharacterSheetH3] Stage 2: scaled %d existing reference latent(s) "
                  "as legacy fallback (no original source pixels in scope).", fallback_count)

    return node_helpers.conditioning_set_values(positive, {"minimax_refs": new_refs})


# ---------------------------------------------------------------------------
# The node itself.
# ---------------------------------------------------------------------------

class MuseCharacterSheetH3:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "audio_vae": ("VAE", {"tooltip": "Needed for final audio decode — H3 always builds a joint audio+video latent internally, even though this is Reference mode."}),
                "aspect_ratio": (ASPECT_RATIO_OPTIONS, {"default": AspectRatio.WIDESCREEN_V.value}),
                "megapixels": ("FLOAT", {"default": 0.5, "min": 0.2, "max": 2.0, "step": 0.02}),
                "multiple": ("INT", {"default": 32, "min": 8, "max": 128, "step": 4, "advanced": True}),
                "duration_seconds": ("FLOAT", {"default": 10.0, "min": 3.0, "max": 15.0, "step": 0.5,
                    "tooltip": "Length of this generation call. H3's own trained range tops out around "
                               "15s per call (its own node source flags longer as untested) — this node "
                               "always renders exactly one H3 call, no chunking/splitting."}),
                "ref_image_size": (["match", "max"], {
                    "default": "max",
                    "tooltip": "'match' scales references down to the generation's pixel area (faster). "
                               "'max' keeps up to a 2048px short edge for stronger identity fidelity, but "
                               "reference tokens ride every sampling step so it's several times slower.",
                }),
                "seed": ("INT", {"default": 100, "min": 0, "max": 0xffffffffffffffff}),
                "use_prompt_override": ("BOOLEAN", {"default": False, "tooltip":
                    "When on, the prompt is replaced with whatever's wired into prompt_override, exactly as "
                    "typed — the timeline's characters/CUTs/soundscape are ignored for prompt purposes "
                    "(reference images and sampling still work normally). For someone who already has a "
                    "fully-formatted H3 prompt and wants to skip this node's own compiler entirely, same as "
                    "typing directly into the stock node's prompt box."}),
                "steps": ("INT", {"default": 8, "min": 1, "max": 100}),
                "sampler_name": (["res_multistep", "euler", "euler_ancestral", "dpmpp_2m"], {"default": "euler"}),
                "scheduler": (["simple", "normal", "beta", "sgm_uniform"], {"default": "simple"}),
                "two_stage_sampling": ("BOOLEAN", {"default": False, "tooltip":
                    "Experimental. Runs the first few steps at a lower resolution, upscales the "
                    "video latent directly (no VAE round-trip), then finishes the remaining steps "
                    "at full resolution on the same continuous noise schedule. Off keeps the "
                    "single-pass behavior exactly as-is."}),
                "two_stage_first_pass_steps": ("INT", {"default": 2, "min": 1, "max": 6, "tooltip":
                    "How many of the total steps run at the lower resolution before the upscale. "
                    "2 is the reference workflow's own saved default (2-3 is the tested range); "
                    "more than 3 risks the low-res pass locking in a broken composition before "
                    "the upscale can recover it."}),
                "two_stage_latent_upscale_model": (_scan_latent_upscale_models(), {
                    "default": "minimax_h3_latent_upscaler_3d_fp16.safetensors",
                    "tooltip":
                    "Which trained latent-upscale checkpoint to use (from "
                    "ComfyUI/models/latent_upscale_models/). Real learned network, not interpolation."}),
                "two_stage_target_megapixels": ("FLOAT", {"default": 2.0, "min": 0.2, "max": 2.0, "step": 0.01, "tooltip":
                    "Target resolution for the Stage-2 upscale, in megapixels. Aspect ratio is preserved "
                    "and the result is aligned to MiniMax H3's 32-pixel canvas grid."}),
                "two_stage_enable_temporal_chunking": ("BOOLEAN", {"default": True, "tooltip":
                    "Only used when two_stage_sampling is on. The Stage-2 latent upscaler "
                    "(MinimaxH3LatentUpscaler3D) internally splits long chunks into overlapping "
                    "temporal pieces and blends them, rather than upscaling the whole clip as one "
                    "piece. Off (default) upscales it in one piece — slower/more VRAM, but skips the "
                    "internal overlap-blend. On splits into overlapping temporal pieces instead."}),
                "timeline_data": ("STRING", {"default": "{}", "multiline": False}),
                # [2026-09-18] FIXED POSITIONING BUG: these three were originally
                # inserted BEFORE timeline_data, which used to be the true last
                # widget — that shifted timeline_data's position in the saved
                # widgets_values array for every workflow saved before this change,
                # so ComfyUI read the wrong (empty) slot for it on load and the
                # authored CUT prompts appeared to vanish. Moved to genuinely be
                # after timeline_data — restores its original position, and any
                # node instance saved while the bug was live needs deleting and
                # recreating fresh (this fix can't repair an already-corrupted
                # saved instance, same rule as every other widget-ordering bug
                # this project has hit).
                #
                # Optional RefMod override — off by default, no effect at all
                # unless both use_refmod is on AND a bundle is actually wired into
                # refmod_bundle below. Ported from the community
                # ComfyUI-MiniMaxH3Mod pack (github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod):
                # injects a pre-extracted RefMod's reference latents into the H3
                # conditioning ADDITIVELY, alongside the normal Ref 1-8 image
                # conditioning — not a replacement for it.
                "use_refmod": ("BOOLEAN", {"default": False, "tooltip":
                    "Off (default): normal Ref 1-8 image conditioning only, unchanged. On: also runs "
                    "the conditioning through Apply H3 RefMod using whatever's wired into refmod_bundle "
                    "— requires ComfyUI-MiniMaxH3Mod installed and a bundle actually connected, or this "
                    "raises an error rather than silently doing nothing."}),
                "refmod_retention": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip":
                    "Only used when use_refmod is on. Same scale as the Ref-slot Retention dropdown: "
                    "1.0 = fully_preserved, 0.7 = partially_preserved, 0.4 = attribute_transfer, "
                    "0.15 = weak_reference."}),
                # [2026-09-18] Confirmed with Andy directly what this needs to say: when
                # RefMod is active, Subject 1's definition line is REPLACED (not just the
                # <Picture N> citation stripped) — it becomes "<Subject 1> {mod name},
                # {this text}." starting with the mod's own name (read straight off
                # refmod_bundle, not typed), matching the format RefMod's own prompt_hint
                # output uses. This box is where the supplementary description goes —
                # outfit/styling for THIS render — since the mod's own auto-hint text
                # ("realistic person, natural human appearance, casual stylish outfit")
                # is too generic to rely on.
                "refmod_description": ("STRING", {"default": "", "multiline": True, "tooltip":
                    "Only used when use_refmod is on. Replaces the Ref 1 description entirely — the "
                    "Subject 1 line becomes '<Subject 1> {mod name}, {this text}.' Describe what she's "
                    "wearing/how she's styled for this render (outfit, hair styling, accessories) — the "
                    "mod itself only carries identity (face/hair color), not wardrobe. To borrow an outfit "
                    "from an uploaded Ref image, write plain English like every other box in this node — "
                    "e.g. 'wearing the outfit from REF 2' — it resolves to the correct <Picture N> tag "
                    "automatically; never type a raw <Picture N>/<Subject N> tag yourself."}),
                # [2026-09-18] Full Apply H3 RefMod parameter set, exposed rather than
                # hardcoded — this node calls that node's own execute() classmethod
                # directly, so every one of these maps 1:1 onto a widget on the real
                # "Apply H3 RefMod" node. Appended here, strictly after refmod_description
                # (the true end of "required" at the time this was written).
                "refmod_override": ("BOOLEAN", {"default": False, "tooltip":
                    "Only used when use_refmod is on. When on, pulls retention + curve from a saved "
                    "config baked into the mod (via Fix H3 RefMod Config) instead of the widgets below, "
                    "for whichever mod in the bundle has one — matches Apply H3 RefMod's own 'override'."}),
                "refmod_curve_direction": (["constant", "concept_at_start", "concept_at_middle",
                    "concept_at_end", "concept_at_ends"], {"default": "constant", "tooltip":
                    "Only used when use_refmod is on and refmod_override is off. Weighting envelope "
                    "across the mod's own stacked ref frames — matches Apply H3 RefMod's curve_direction."}),
                "refmod_curve_shape": (["linear", "ease", "sigmoid", "tanh", "quadratic", "cubic",
                    "exponential", "stair", "elastic", "bump", "dip"], {"default": "linear", "tooltip":
                    "Only used when use_refmod is on and refmod_override is off. How the weighting "
                    "envelope travels between its endpoints — matches Apply H3 RefMod's curve_shape."}),
                "refmod_curve_value": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip":
                    "Only used when use_refmod is on and refmod_override is off. Curve endpoint weight — "
                    "matches Apply H3 RefMod's curve_value."}),
                "refmod_scramble_seed": ("INT", {"default": -1, "min": -1, "max": 2147483647, "tooltip":
                    "Only used when use_refmod is on. -1 = off (all refs in saved order). With 2+ refs in "
                    "the bundle, a seed >= 0 shuffles/subsets the ref order — matches Apply H3 RefMod's "
                    "scramble_seed."}),
                "refmod_scramble_mode": (["shuffle", "subset", "legacy_subset"], {"default": "shuffle", "tooltip":
                    "Only used when use_refmod is on and refmod_scramble_seed >= 0. Matches Apply H3 "
                    "RefMod's scramble_mode."}),
                "refmod_scramble_keep": ("INT", {"default": 1, "min": 1, "max": 80, "tooltip":
                    "Only used when use_refmod is on, refmod_scramble_seed >= 0, and refmod_scramble_mode "
                    "is 'subset'. Refs retained. Matches Apply H3 RefMod's scramble_keep."}),
                "refmod_max_total_tokens": ("INT", {"default": 0, "min": 0, "max": 1048576, "tooltip":
                    "Only used when use_refmod is on. Total reference token budget after copies; 0 "
                    "disables the limit. Matches Apply H3 RefMod's max_total_tokens."}),
                "refmod_graph_preset": ("STRING", {"default": "", "tooltip":
                    "Only used when use_refmod is on. Optional: type the exact name of a saved graph "
                    "preset (in models/refmods/graph_presets/) to use instead of the curve widgets above. "
                    "Leave blank for '(none)' — matches Apply H3 RefMod's graph_preset."}),
                "refmod_save_preset_as": ("STRING", {"default": "", "tooltip":
                    "Only used when use_refmod is on. Optional: type a name to save the current "
                    "(resolved) curve as a new graph preset PNG when this runs. Leave blank to skip — "
                    "matches Apply H3 RefMod's save_preset_as."}),
            },
            "optional": {
                "prompt_override": ("STRING", {"forceInput": True, "tooltip":
                    "Wire in any plain text node (e.g. a Text Multiline node) with an already-formatted H3 "
                    "prompt. Only takes effect when use_prompt_override is on."}),
                "refmod_bundle": ("H3_REF_MODS", {"tooltip":
                    "Wire in the 'mods' output from Load H3 RefMods (or Create H3 RefMod directly). "
                    "Only used when use_refmod is on."}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "STRING", "IMAGE", "AUDIO", "AUDIO", "AUDIO")
    RETURN_NAMES = ("images", "audio", "compiled_prompt", "ref_images_used",
                     "ref_audio_1_used", "ref_audio_2_used", "ref_audio_3_used")
    FUNCTION = "execute"
    CATEGORY = "Muse Collective"
    DESCRIPTION = (
        "Single H3 Reference (Omni) call: one CHUNK/CUT timeline, the six-section "
        "reference-mode prompt compiler, two-stage sampling, and live/finished preview — "
        "a stripped single-chunk derivative of Muse Minimax Director Combo V2."
    )

    def execute(self, model, clip, vae, audio_vae, aspect_ratio, megapixels, multiple,
                duration_seconds, ref_image_size, seed, use_prompt_override, steps,
                sampler_name, scheduler, two_stage_sampling, two_stage_first_pass_steps,
                two_stage_latent_upscale_model, two_stage_target_megapixels,
                two_stage_enable_temporal_chunking, timeline_data,
                use_refmod, refmod_retention, refmod_description,
                refmod_override=False, refmod_curve_direction="constant",
                refmod_curve_shape="linear", refmod_curve_value=1.0,
                refmod_scramble_seed=-1, refmod_scramble_mode="shuffle",
                refmod_scramble_keep=1, refmod_max_total_tokens=0,
                refmod_graph_preset="", refmod_save_preset_as="",
                prompt_override=None, refmod_bundle=None, unique_id=None):
        tdata = _parse_timeline(timeline_data)

        requested_megapixels = float(megapixels)
        megapixels = min(SUPPORTED_MEGAPIXELS, key=lambda value: abs(value - requested_megapixels))
        if not math.isclose(megapixels, requested_megapixels, rel_tol=0.0, abs_tol=1e-9):
            log.info(
                "[MuseCharacterSheetH3] Snapped megapixels from %s to supported value %s.",
                requested_megapixels, megapixels,
            )

        width, height = _resolve_resolution(aspect_ratio, megapixels, multiple)
        # [2026-09-18] Confirmed with Andy: when RefMod is active it fully OWNS
        # Ref 1's identity slot — Ref 1's own image (if any lingers in saved
        # data) must not also get fed as <Picture 1>, and its UI box is grayed
        # out to match (see the JS side). Excluding index 0 here lets the
        # existing fill-order logic in _build_character_subjects naturally
        # shift Ref 2 (etc.) up to <Picture 1>/<Subject 1> — then the RefMod's
        # own synthetic subject gets prepended as the new Subject 1 below,
        # renumbering everything else by one.
        effective_characters = _effective_character_entries(tdata.get("characters"))
        refmod_retention_line = None
        if use_refmod and refmod_bundle:
            effective_characters = list(effective_characters)
            effective_characters[0] = None
        char_ref_images, subject_lines, subject_retention_meta, subject_number_by_char_index = _build_character_subjects(
            {**tdata, "characters": effective_characters})
        if use_refmod and refmod_bundle:
            # Captured before the RefMod renumbering below rebinds
            # subject_number_by_char_index to shifted *subject* numbers —
            # picture_n and subject_n are identical at this point (both just
            # counted the same populated characters in the same loop), so
            # this is genuinely the idx -> picture_n map, unaffected by
            # RefMod's later +1 subject-number shift (RefMod never consumes
            # a picture slot, so picture numbers themselves never move).
            picture_number_by_char_index = dict(subject_number_by_char_index)
            refmod_name = refmod_bundle[0][0].name
            refmod_desc = _resolve_ref_mentions_to_pictures(
                (refmod_description or "").strip().rstrip("."), picture_number_by_char_index)
            refmod_line = (f"<Subject 1> {refmod_name}, {refmod_desc}."
                           if refmod_desc else f"<Subject 1> {refmod_name}.")
            subject_lines = [
                re.sub(r"^<Subject (\d+)>", lambda m: f"<Subject {int(m.group(1)) + 1}>", line)
                for line in subject_lines
            ]
            # [2026-09-18] CORRECTED: this used to skip a retention_analysis line
            # for the RefMod subject entirely, reasoning that its strength is
            # controlled by refmod_retention at the conditioning level instead.
            # Confirmed wrong two ways: (1) MiniMax's own reference-mode guide
            # requires "one line for each reference label" in retention_analysis —
            # this isn't optional formatting, (2) a real A/B render test (three
            # identical outputs across fully_preserved/attribute_transfer/
            # weak_reference on a competing Ref 2, despite each one genuinely
            # reaching the compiled prompt) confirmed an incomplete section makes
            # the model disregard retention guidance entirely, not just for the
            # missing subject. Content is whatever's typed in refmod_description
            # (Andy's own call, not a fixed phrase this node injects) — falls back
            # to a plain factual line when that's empty.
            refmod_retention_text = refmod_desc or "identity fully retained from the reference"
            refmod_retention_line = f"<Subject 1>{{presence}}: fully_preserved - {refmod_retention_text}."
            subject_retention_meta = [(subj_n + 1, pic_n, ret) for subj_n, pic_n, ret in subject_retention_meta]
            subject_number_by_char_index = {idx: n + 1 for idx, n in subject_number_by_char_index.items()}
            subject_number_by_char_index[0] = 1
            subject_lines = [refmod_line] + subject_lines
        subject_count = len(subject_lines)
        dialogue_language = (tdata.get("dialogue_language") or "English").strip() or "English"
        locations = list(tdata.get("locations") or [])

        # Static reference-image set actually used for <Picture N> tagging —
        # exposed as a real output so other nodes can reuse the exact same
        # reference photos, same as the source node's ref_images_used.
        ref_images_used_list = list(char_ref_images.values())
        first_location = _resolve_location_for_chunk(locations, 1)
        if first_location:
            bg_tensor = _load_character_image(first_location)
            if bg_tensor is not None:
                ref_images_used_list.append(bg_tensor)
        ref_images_used = _make_uniform_preview_batch(ref_images_used_list)
        if ref_images_used is None:
            ref_images_used = torch.zeros((0, height, width, 3))

        # [2026-09-17] chunk_duration_seconds == duration_seconds so this
        # always resolves to exactly one bucket/chunk — see
        # _bucket_segments_into_chunks's own docstring.
        buckets, chunk_lengths, chunk_bounds = _bucket_segments_into_chunks(
            tdata, duration_seconds, duration_seconds,
        )
        num_chunks = len(buckets)

        log.info(
            "[MuseCharacterSheetH3] %dx%d, seed=%d, ~%.1fs call, two_stage=%s.",
            width, height, seed, duration_seconds, two_stage_sampling,
        )

        from nodes import NODE_CLASS_MAPPINGS
        if use_refmod:
            MiniMaxH3RefModApply = NODE_CLASS_MAPPINGS.get("MiniMaxH3RefModApply")
            if MiniMaxH3RefModApply is None:
                raise RuntimeError(
                    "use_refmod is on but ComfyUI-MiniMaxH3Mod isn't installed "
                    "(github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod) — install it, "
                    "restart ComfyUI, or turn use_refmod off."
                )
            if refmod_bundle is None:
                raise RuntimeError(
                    "use_refmod is on but nothing is wired into refmod_bundle — connect "
                    "Load H3 RefMods' 'mods' output, or turn use_refmod off."
                )
        else:
            MiniMaxH3RefModApply = None
        RandomNoise = NODE_CLASS_MAPPINGS["RandomNoise"]
        BasicGuider = NODE_CLASS_MAPPINGS["BasicGuider"]
        KSamplerSelect = NODE_CLASS_MAPPINGS["KSamplerSelect"]
        BasicScheduler = NODE_CLASS_MAPPINGS["BasicScheduler"]
        SamplerCustomAdvanced = NODE_CLASS_MAPPINGS["SamplerCustomAdvanced"]
        VAEDecode = NODE_CLASS_MAPPINGS["VAEDecode"]
        VAEDecodeAudio = NODE_CLASS_MAPPINGS["VAEDecodeAudio"]
        SplitSigmas = NODE_CLASS_MAPPINGS["SplitSigmas"] if two_stage_sampling else None
        DisableNoise = NODE_CLASS_MAPPINGS["DisableNoise"] if two_stage_sampling else None
        LTXVSeparateAVLatent = NODE_CLASS_MAPPINGS["LTXVSeparateAVLatent"] if two_stage_sampling else None
        LTXVConcatAVLatent = NODE_CLASS_MAPPINGS["LTXVConcatAVLatent"] if two_stage_sampling else None
        MinimaxH3LatentUpscaler3D = None
        if two_stage_sampling:
            MinimaxH3LatentUpscaler3D = NODE_CLASS_MAPPINGS.get("MinimaxH3LatentUpscaler3D")
            if MinimaxH3LatentUpscaler3D is None:
                raise RuntimeError(
                    "two_stage_sampling is on but 'MinimaxH3LatentUpscaler3D' isn't registered — "
                    "install Comfyui_Minimax_h3_latent_Upscaler into custom_nodes."
                )
            if not two_stage_latent_upscale_model or str(two_stage_latent_upscale_model).startswith("("):
                raise RuntimeError(
                    "two_stage_sampling is on but no trained latent-upscale model is selected — "
                    "place a checkpoint in ComfyUI/models/latent_upscale_models/."
                )

        sampler = _unpack_node_result(_execute_comfy_node(KSamplerSelect, sampler_name=sampler_name))[0]

        # User-provided reference videos/audio — uploaded and scrub-trimmed in
        # the timeline UI, decoded here from disk. Key by the original UI
        # slot: a CUT may select Ref Video 2 while Ref Video 1 is empty.
        selected_ref_video_slots = set()
        for bucket in buckets:
            for seg in bucket:
                raw_slot = seg.get("videoRefSlot")
                try:
                    selected_slot = int(raw_slot)
                except (TypeError, ValueError):
                    continue
                if 0 <= selected_slot < 3 and (seg.get("prompt") or "").strip():
                    selected_ref_video_slots.add(selected_slot)
        # [2026-09-18] Ported from MiniMaxH3-Director-V1.5: a Ref Video slot can
        # also define a <Subject N> identity (per MiniMax's own reference-mode
        # guide — "<Subject N> is the young blonde woman in <Video M>" is a
        # documented, official pattern, not a workaround). That's independent of
        # whether any CUT actually selected the clip for motion/camera guidance,
        # so a slot with a typed identity description needs to load even with
        # zero CUT selections — otherwise a pure identity-source video would
        # never even get decoded.
        raw_ref_videos = (tdata.get("refVideos") or [])[:3]
        for ui_idx, entry in enumerate(raw_ref_videos):
            if entry and (entry.get("description") or "").strip():
                selected_ref_video_slots.add(ui_idx)
        user_ref_videos = {}  # ui_index -> (frames_tensor, paired_audio_dict_or_None, entry_dict)
        for ui_idx, entry in enumerate(raw_ref_videos):
            if ui_idx not in selected_ref_video_slots or not entry or not entry.get("file"):
                continue
            tensor = _load_ref_video_tensor(entry)
            if tensor is None:
                continue
            paired_audio = _load_ref_audio_clip(entry) if entry.get("includeAudio") else None
            user_ref_videos[ui_idx] = (tensor, paired_audio, entry)

        user_ref_audios = []  # list of (AUDIO dict, entry_dict, original_ui_index)
        for ui_idx, entry in enumerate((tdata.get("refAudios") or [])[:3]):
            if not entry or not entry.get("file"):
                continue
            clip_audio = _load_ref_audio_clip(entry)
            if clip_audio is not None:
                user_ref_audios.append((clip_audio, entry, ui_idx))

        final_images = None
        final_audio = None
        compiled_prompt = ""

        # [2026-09-17] Ported AS A LOOP even though buckets always has exactly
        # one entry (chunk_idx always 0) — reusing the source node's tested
        # per-chunk loop body verbatim, with every chunk_idx>0 / continuation
        # branch it had stripped out, is lower-risk than flattening this into
        # non-loop code and accidentally dropping something.
        for chunk_idx, chunk_segments in enumerate(buckets):
            saved_chunks = tdata.get("chunks") or []
            this_chunk_data = saved_chunks[chunk_idx] if chunk_idx < len(saved_chunks) else {}

            # Stable per-chunk image overlay. A local card keeps the same Ref
            # number and replaces only that slot; empty local slots inherit
            # the shared card.
            #
            # [2026-09-17] REMOVED the localCharacters/localRefVideos/localRefAudios
            # override branches that used to live here. This node has exactly one
            # chunk and no UI anywhere to set or clear those per-chunk "local
            # override" fields (they only exist as a schema leftover from the
            # source multi-chunk node, or from an old Combo V2 project JSON
            # carried into timeline_data) — but the old code still silently
            # preferred them over the real, visible Ref 1-8/Location/Ref Video/
            # Ref Audio slots whenever they happened to be present. Confirmed as
            # the actual root cause of a real bug: a stale `localCharacters[0]`
            # left over in a saved workflow's timeline_data (an old leather-
            # jacket test photo) silently overrode the correctly-configured,
            # currently-visible Ref 1 on every single render, with no way to see
            # or clear it from the panel. Always use the shared/visible data now.
            chunk_char_ref_images = char_ref_images
            chunk_subject_lines_base = subject_lines
            chunk_subject_retention_meta = subject_retention_meta
            chunk_subject_number_by_char_index = subject_number_by_char_index
            chunk_subject_count = subject_count
            chunk_user_ref_videos = dict(user_ref_videos)
            chunk_user_ref_audios = list(user_ref_audios)

            chunk_len_seconds = chunk_lengths[chunk_idx]
            visible_chunk_length = align_frame_count(max(5, round(chunk_len_seconds * _V4_FPS)))
            chunk_length = visible_chunk_length
            chunk_start_sec = chunk_bounds[chunk_idx][0]

            style_line = (this_chunk_data.get("style_line") or "").strip()
            scene_anchors = [
                (entry.get("sceneAnchor") or "").strip()
                for _tensor, _paired, entry in chunk_user_ref_videos.values()
                if (entry.get("sceneAnchor") or "").strip()
            ]
            if scene_anchors:
                style_line = ((style_line + " ") if style_line else "") + " ".join(scene_anchors)

            chunk_seed = int(seed)
            if chunk_seed < 0 or chunk_seed > 0xffffffffffffffff:
                raise RuntimeError(f"Seed {chunk_seed} is outside the supported range.")

            # -----------------------------------------------------------
            # Six-section Reference (Omni) prompt compile — ported verbatim
            # from the source node's own per-chunk compiler.
            # -----------------------------------------------------------
            # RefMod's synthetic Subject 1 (if active) is already baked into
            # subject_lines_base/subject_count at the top of execute() — the
            # renumbering there is shared/done-once, not per-chunk (this node
            # only ever has one chunk anyway, but the source of truth is the
            # top-level build, not here).
            chunk_subject_lines = list(chunk_subject_lines_base)
            chunk_subject_tags = [f"<Subject {i + 1}>" for i in range(chunk_subject_count)]

            subject_shot_appearances = _find_subject_shot_appearances(
                chunk_segments, chunk_subject_number_by_char_index, style_line)
            total_shots = sum(1 for s in chunk_segments if (s.get("prompt") or "").strip())

            video_presence_shot = 0
            for presence_seg in chunk_segments:
                if not (presence_seg.get("prompt") or "").strip():
                    continue
                video_presence_shot += 1
                presence_request = _seg_video_reference(presence_seg)
                if presence_request is None or presence_request["ui_slot"] not in chunk_user_ref_videos:
                    continue
                target_subject_n = chunk_subject_number_by_char_index.get(presence_request["target_char_idx"])
                if target_subject_n is not None:
                    shots = subject_shot_appearances.setdefault(target_subject_n, [])
                    if video_presence_shot not in shots:
                        shots.append(video_presence_shot)

            # [2026-09-18] Confirmed real bug: a subject only got a retention_analysis
            # line if its own <Subject N>/"REF N" tag literally appeared in the CUT
            # text — but a borrowed-attribute subject (e.g. an outfit reference cited
            # only as "<Picture N>" from INSIDE another subject's own definition line,
            # never mentioned as its own "REF N" anywhere) was silently dropped
            # entirely, taking its retention marker (e.g. attribute_transfer) with it.
            # With no retention_analysis line at all, H3 got zero instruction on how
            # much of that picture to reuse — confirmed via a real render where the
            # outfit reference photo's own model appeared instead of the intended
            # RefMod identity. A subject cited by Picture number from within another
            # subject's own text counts as referenced too, even without its own tag.
            # _cross_cited_subjects tracks a DIFFERENT thing than "appears in this
            # shot" — a subject whose own Picture is cited from INSIDE ANOTHER
            # subject's own definition line (e.g. an outfit reference: "wearing the
            # outfit shown in <Picture 1>") is an attribute DONOR, not an
            # independently visible character, regardless of whether its plain
            # "REF N" text also happens to appear elsewhere (e.g. a Style-box
            # sentence like "Ref 1 is wearing the outfit only from Ref 2" — that
            # sentence is what correctly puts it in subject_shot_appearances too,
            # via the normal REF-N matching, but it must NOT be counted as its own
            # depicted subject for that reason).
            # [2026-09-18] CORRECTED: the first version of this searched the WHOLE
            # combined subject text for "<Picture N>", including each subject's
            # OWN line — but every populated Ref always self-cites its own picture
            # in its own definition ("<Subject 3> is ... (from `<Picture 2>`)."),
            # so a genuine second/third character was self-matching and getting
            # wrongly excluded from the summary too. Confirmed via a real render:
            # adding a real Subject 3 alongside the RefMod+outfit pair made it
            # vanish from "The target video shows..." even though nothing actually
            # cross-cited it. Fixed to only count a citation from a DIFFERENT
            # subject's own line, never a subject's citation of itself.
            _picture_owner = {_pic_n: _subj_n for _subj_n, _pic_n, _ret in chunk_subject_retention_meta}
            _cross_cited_subjects = set()
            for _i, _line in enumerate(chunk_subject_lines):
                _owner_n = _i + 1
                for _m in re.finditer(r"<Picture (\d+)>", _line):
                    _cited_owner = _picture_owner.get(int(_m.group(1)))
                    if _cited_owner is not None and _cited_owner != _owner_n:
                        _cross_cited_subjects.add(_cited_owner)
            for _subj_n in _cross_cited_subjects:
                subject_shot_appearances.setdefault(_subj_n, [])

            chunk_retention_lines = [
                f"<Subject {subject_n}> {_presence_phrase(subject_n, subject_shot_appearances, total_shots)}: "
                f"{retention} - matches `<Picture {picture_n}>`."
                for subject_n, picture_n, retention in chunk_subject_retention_meta
                if subject_n in subject_shot_appearances
            ]
            if refmod_retention_line:
                chunk_retention_lines.insert(0, refmod_retention_line.format(
                    presence=f" {_presence_phrase(1, subject_shot_appearances, total_shots)}"))
            chunk_audio_subject_lines = []
            chunk_audio_retention_lines = []
            task_flags = set()

            speaker_assign = {}
            for seg in chunk_segments:
                seg_text = (seg.get("prompt") or "").strip()
                if not seg_text:
                    continue
                if not (_DIALOGUE_RE.search(seg_text) or _SUBJECT_TAG_RE.search(seg_text)):
                    continue
                for char_idx in _seg_all_speaker_indices(seg):
                    if char_idx in chunk_subject_number_by_char_index:
                        subj_n = chunk_subject_number_by_char_index[char_idx]
                        if subj_n not in speaker_assign:
                            speaker_assign[subj_n] = len(speaker_assign) + 1

            chunk_ref_videos = {}
            chunk_ref_video_audios = {}
            video_slot = 0
            video_continuity_tag = None
            audio_tag_counter = 0
            chunk_video_requests = {}
            cut_video_guidance = {}
            request_shot_num = 0
            for request_seg in chunk_segments:
                if not (request_seg.get("prompt") or "").strip():
                    continue
                request_shot_num += 1
                request = _seg_video_reference(request_seg)
                if request is None:
                    continue
                ui_slot = request["ui_slot"]
                if ui_slot not in chunk_user_ref_videos:
                    log.warning(
                        "[MuseCharacterSheetH3] CUT %d selected Ref Video %d, but that slot "
                        "has no decodable uploaded clip; ignoring it.",
                        request_shot_num, ui_slot + 1,
                    )
                    continue
                request["seg"] = request_seg
                request["shot_num"] = request_shot_num
                chunk_video_requests.setdefault(ui_slot, []).append(request)

            for ui_idx in sorted(chunk_user_ref_videos):
                v, paired_audio, meta = chunk_user_ref_videos[ui_idx]
                if video_slot > 2:
                    log.warning("[MuseCharacterSheetH3] ref_video slots full (3 max) — dropping an extra "
                                "user reference video.")
                    break
                tag_n = video_slot + 1
                video_tag = f"<Video {tag_n}>"
                chunk_ref_videos[f"ref_video_{video_slot}"] = v
                if ui_idx in chunk_video_requests:
                    usages = []
                    for request in chunk_video_requests[ui_idx]:
                        target_subject_n = chunk_subject_number_by_char_index.get(request["target_char_idx"])
                        request_seg = request["seg"]
                        local_start = max(0.0, float(request_seg.get("_abs_start", chunk_start_sec)) - chunk_start_sec)
                        guidance = _cut_video_guidance_text(
                            video_tag, request["mode"], target_subject_n,
                            request_seg.get("videoRefTiming") or "free",
                            local_start,
                            float(request_seg.get("_duration_seconds", 0.0) or 0.0),
                        )
                        if guidance:
                            cut_video_guidance[id(request["seg"])] = guidance
                        target_label = f"<Subject {target_subject_n}>" if target_subject_n is not None else "whole shot"
                        usages.append(f"{request['mode']} for {target_label} in [Shot {request['shot_num']}]")
                        if request["mode"] in ("motion", "motion_camera"):
                            task_flags.add("motion reference")
                        if request["mode"] in ("camera", "motion_camera"):
                            task_flags.add("camera reference")
                    usage_text = "; ".join(usages)
                    chunk_retention_lines.append(
                        f"`{video_tag}` (CUT-scoped motion/camera guide): weak_reference - {usage_text}. "
                        "Retain only the requested movement mechanics and/or camera trajectory; do not reuse "
                        "the source performer's identity, face, clothing, setting, lighting or audio."
                    )
                # [2026-09-18] Ported from MiniMaxH3-Director-V1.5: a Ref Video slot
                # with a typed identity description defines its own <Subject N>,
                # citing this video as its source — per MiniMax's own reference-mode
                # guide's documented pattern ("<Subject N> is the young blonde woman
                # in <Video M>"). Independent of the CUT-guidance block above; a video
                # can supply identity, motion guidance, or both at once.
                v_desc = (meta.get("description") or "").strip().rstrip(".")
                if v_desc:
                    subj_n = len(chunk_subject_tags) + 1
                    chunk_subject_tags.append(f"<Subject {subj_n}>")
                    chunk_subject_lines.append(f"<Subject {subj_n}> is {v_desc} (from `{video_tag}`).")
                    v_retention = meta.get("retention") or "fully_preserved"
                    chunk_retention_lines.append(
                        f"<Subject {subj_n}> (from `{video_tag}`): {v_retention} - {v_desc}.")
                if paired_audio is not None:
                    chunk_ref_video_audios[f"ref_video_audio_{video_slot}"] = paired_audio
                    audio_tag_counter += 1
                    chunk_audio_subject_lines.append(f"<Audio {audio_tag_counter}> is the audio of `{video_tag}`.")
                    chunk_audio_retention_lines.append(
                        f"<Audio {audio_tag_counter}>: reference - guides voice timbre/delivery without "
                        "copying the original signal."
                    )
                    task_flags.add("audio reference")
                video_slot += 1

            chunk_ref_audios = {}
            voice_audio_tag_by_subject = {}
            audio_slot = 0
            carry_audio_tag = None
            for clip_audio, meta, ui_idx in chunk_user_ref_audios:
                if audio_slot > 2:
                    log.warning("[MuseCharacterSheetH3] ref_audio slots full (3 max) — dropping an extra "
                                "reference audio clip.")
                    break
                chunk_ref_audios[f"ref_audio_{audio_slot}"] = clip_audio
                audio_tag_counter += 1
                a_desc = (meta.get("description") or "").strip()
                a_retention = meta.get("retention") or "reference"
                paired_subj_n = chunk_subject_number_by_char_index.get(ui_idx)
                if a_retention == "reference" and paired_subj_n is not None:
                    voice_audio_tag_by_subject[paired_subj_n] = audio_tag_counter
                if paired_subj_n is not None:
                    sx = speaker_assign.get(paired_subj_n)
                    subject_tag = f"`<Subject {paired_subj_n}>`" + (f" (S{sx})" if sx else "")
                elif a_desc:
                    subject_tag = f"the Subject described as: {a_desc}"
                else:
                    subject_tag = "the Subject"
                if a_retention == "fully_copy":
                    chunk_audio_subject_lines.append(
                        f"<Audio {audio_tag_counter}> is {subject_tag}'s exact recorded dialogue, reused verbatim.")
                    chunk_audio_retention_lines.append(
                        f"<Audio {audio_tag_counter}>: fully_copy - performance and lip movement follow the exact recording.")
                elif a_retention == "partially_copy":
                    chunk_audio_subject_lines.append(
                        f"<Audio {audio_tag_counter}> is a partial voice reference for {subject_tag}.")
                    chunk_audio_retention_lines.append(
                        f"<Audio {audio_tag_counter}>: partially_copy - dialogue carries selected traits from the recording.")
                elif a_retention == "weak_reference":
                    chunk_audio_subject_lines.append(
                        f"<Audio {audio_tag_counter}> is a loose vocal-style reference for {subject_tag}.")
                    chunk_audio_retention_lines.append(
                        f"<Audio {audio_tag_counter}>: weak_reference - only a loose vocal style is retained.")
                else:
                    chunk_audio_subject_lines.append(
                        f"<Audio {audio_tag_counter}> is the voice-timbre reference for {subject_tag}.")
                    chunk_audio_retention_lines.append(
                        f"<Audio {audio_tag_counter}>: reference - the target speaker follows "
                        f"<Audio {audio_tag_counter}>'s voice timbre and measured delivery "
                        "without copying the original signal.")
                task_flags.add("audio reuse" if a_retention in ("fully_copy", "partially_copy") else "audio reference")
                audio_slot += 1

            # Characters, the active Location and CUT-selected ref videos are
            # independent references — this node never has a continuation
            # anchor (single chunk only), so unlike the source node no
            # <Picture N> slot is ever reserved for one.
            chunk_ref_images = dict(chunk_char_ref_images)
            next_visual_slot = len(chunk_ref_images)
            shot1_prefix = ""

            # [2026-09-17] Same fix as the localCharacters removal above — no
            # localLocations override, always use the visible shared Location slot.
            active_location = _resolve_location_for_chunk(locations, chunk_idx + 1)
            if active_location and (active_location.get("file") or active_location.get("image_b64")):
                if next_visual_slot >= 9:
                    raise ValueError(
                        "Reference-image limit exceeded: Ref images and the active Location "
                        "share H3's 9 image slots."
                    )
                tensor = _load_character_image(active_location)
                if tensor is not None:
                    chunk_ref_images[f"ref_image_{next_visual_slot}"] = tensor
                    bg_picture_n = next_visual_slot + 1
                    bg_subj_n = len(chunk_subject_tags) + 1
                    chunk_subject_tags.append(f"<Subject {bg_subj_n}>")
                    bg_desc = (active_location.get("description") or "").strip()
                    if bg_desc:
                        chunk_subject_lines.append(f"<Subject {bg_subj_n}> is {bg_desc} (from `<Picture {bg_picture_n}>`).")
                    else:
                        chunk_subject_lines.append(f"<Subject {bg_subj_n}> is the setting shown in `<Picture {bg_picture_n}>`.")
                    bg_retention = active_location.get("retention") or "fully_preserved"
                    bg_presence = _presence_phrase(bg_subj_n, subject_shot_appearances, total_shots)
                    chunk_retention_lines.append(
                        f"<Subject {bg_subj_n}> {bg_presence}: {bg_retention} - matches `<Picture {bg_picture_n}>`.")
                    location_relation = (
                        f"The action takes place inside <Subject {bg_subj_n}>; "
                        f"use `<Picture {bg_picture_n}>` as the complete surrounding "
                        "environment and preserve it throughout this chunk. "
                    )
                    shot1_prefix = location_relation + shot1_prefix
                    next_visual_slot += 1

            task_bits = ["reference generation"]
            for t in ("video editing", "video continuation", "motion reference", "camera reference",
                      "keyframe completion", "audio reuse", "audio reference"):
                if t in task_flags:
                    task_bits.append(t)
            # [2026-09-18] Confirmed real bug via a real render + user report: an
            # attribute-donor subject (an outfit reference cited only via
            # <Picture N> from inside another subject's own definition) was being
            # listed here as if it were its own independently visible character —
            # "The target video shows <Subject 1> and <Subject 2>." when only
            # Subject 1 should ever appear on screen; Subject 2 only lends an
            # attribute. Excluded via _cross_cited_subjects (computed above)
            # regardless of whether its own "REF N" text also appears elsewhere
            # (e.g. the Style-box outfit-transfer sentence) — that's what
            # correctly earns it a retention_analysis line, but must not also
            # earn it a place in "who this video shows."
            summary_line = f"[{' + '.join(task_bits)}] " + _build_summary_sentence(
                [tag for tag in chunk_subject_tags
                 if (int(_SUBJECT_TAG_RE.fullmatch(tag).group(1)) in subject_shot_appearances
                     or int(_SUBJECT_TAG_RE.fullmatch(tag).group(1)) > chunk_subject_count)
                 and int(_SUBJECT_TAG_RE.fullmatch(tag).group(1)) not in _cross_cited_subjects],
                video_continuity_tag, carry_audio_tag)
            if voice_audio_tag_by_subject:
                voice_links = [
                    f"<Audio {audio_n}> as the voice-timbre reference for <Subject {subject_n}>"
                    for subject_n, audio_n in voice_audio_tag_by_subject.items()
                ]
                summary_line += " The dialogue uses " + ", and ".join(voice_links) + "."

            shot_lines = []
            shot_idx = 0
            for seg in chunk_segments:
                text = (seg.get("prompt") or "").strip()
                if not text:
                    continue
                shot_idx += 1
                video_guidance = cut_video_guidance.get(id(seg), "")
                if video_guidance:
                    text = f"{video_guidance} {text}"
                line_speakers = _seg_dialogue_speaker_indices(seg)
                speaker_idxs = _seg_all_speaker_indices(seg)
                tagged_any = False
                for char_idx in speaker_idxs:
                    subj_n = chunk_subject_number_by_char_index.get(char_idx)
                    s_n = speaker_assign.get(subj_n) if subj_n is not None else None
                    if not s_n:
                        continue
                    subj_tag = f"<Subject {subj_n}>"
                    if subj_tag in text:
                        text = text.replace(subj_tag, f"{subj_tag} (S{s_n})")
                        tagged_any = True
                if line_speakers is None and not tagged_any and len(speaker_idxs) == 1:
                    subj_n = chunk_subject_number_by_char_index.get(speaker_idxs[0])
                    s_n = speaker_assign.get(subj_n) if subj_n is not None else None
                    if s_n:
                        if shot_idx == 1 and shot1_prefix:
                            text = f"<Subject {subj_n}> (S{s_n}): {text}"
                        else:
                            text = f"<Subject {subj_n}> (S{s_n}) continues: {text}"
                if line_speakers is not None:
                    speaker_ids = []
                    dialogue_subject_ids = []
                    dialogue_audio_ids = []
                    for char_idx in line_speakers:
                        subj_n = chunk_subject_number_by_char_index.get(char_idx) if isinstance(char_idx, int) else None
                        dialogue_subject_ids.append(subj_n)
                        dialogue_audio_ids.append(voice_audio_tag_by_subject.get(subj_n))
                        speaker_ids.append(speaker_assign.get(subj_n) if subj_n is not None else None)
                    text = _wrap_dialogue(
                        text, dialogue_language, speaker_ids,
                        dialogue_subject_ids, dialogue_audio_ids)
                else:
                    text = _wrap_dialogue(text, dialogue_language)
                if shot_idx == 1:
                    shot_lines.append(f"[Shot 1] {shot1_prefix}{text}")
                else:
                    start_in_chunk = max(0.0, seg.get("_abs_start", 0.0) - chunk_start_sec)
                    shot_lines.append(f"[Shot {shot_idx}] At {_format_timestamp(start_in_chunk)}, {text}")

            soundscape_text = (this_chunk_data.get("overall_soundscape") or "").strip()
            music_text = (this_chunk_data.get("non_diegetic_music") or "").strip()

            chunk_prompt = _assemble_six_section_prompt(
                chunk_subject_lines + chunk_audio_subject_lines, summary_line,
                chunk_retention_lines + chunk_audio_retention_lines,
                style_line, shot_lines, soundscape_text, music_text,
            )

            if use_prompt_override and (prompt_override or "").strip():
                chunk_prompt = _select_chunk_from_prompt_override(prompt_override, 0, 1)

            compiled_prompt = chunk_prompt

            log.info("[MuseCharacterSheetH3] seed=%d, length=%d frames.", chunk_seed, chunk_length)

            out = _execute_comfy_node(
                MiniMaxH3ReferenceToVideo,
                clip=clip, vae=vae, audio_vae=audio_vae, prompt=chunk_prompt,
                width=width, height=height, length=chunk_length, ref_image_size=ref_image_size,
                ref_images=chunk_ref_images if chunk_ref_images else None,
                ref_videos=chunk_ref_videos if chunk_ref_videos else None,
                ref_video_audios=chunk_ref_video_audios if chunk_ref_video_audios else None,
                ref_audios=chunk_ref_audios if chunk_ref_audios else None,
            )
            chunk_shifted_model = model
            positive, latent = _unpack_node_result(out)[:2]

            if use_refmod and refmod_bundle and MiniMaxH3RefModApply is not None:
                # Additive — this runs alongside the normal Ref 1-8 image
                # conditioning above, not instead of it. See Apply H3 RefMod's
                # own docstring: appends the mod's reference latent(s) to the
                # conditioning's refs, same mechanism as a reference image/video.
                refmod_out = _execute_comfy_node(
                    MiniMaxH3RefModApply,
                    conditioning=positive, mods=refmod_bundle,
                    retention=float(refmod_retention),
                    curve_direction=refmod_curve_direction, curve_shape=refmod_curve_shape,
                    curve_value=float(refmod_curve_value),
                    scramble_seed=int(refmod_scramble_seed), override=bool(refmod_override),
                    scramble_mode=refmod_scramble_mode, scramble_keep=int(refmod_scramble_keep),
                    max_total_tokens=int(refmod_max_total_tokens),
                    graph_preset=refmod_graph_preset or "", save_preset_as=refmod_save_preset_as or "",
                )
                positive = _unpack_node_result(refmod_out)[0]

            chunk_shifted_model = _attach_chunk_live_preview(chunk_shifted_model, unique_id)
            guider = _unpack_node_result(_execute_comfy_node(BasicGuider, model=chunk_shifted_model, conditioning=positive))[0]
            full_sigmas = _unpack_node_result(_execute_comfy_node(
                BasicScheduler, model=chunk_shifted_model, scheduler=scheduler, steps=steps, denoise=1.0,
            ))[0]

            if not two_stage_sampling:
                noise = _unpack_node_result(_execute_comfy_node(RandomNoise, noise_seed=chunk_seed))[0]
                sampled = _unpack_node_result(_execute_comfy_node(
                    SamplerCustomAdvanced, noise=noise, guider=guider, sampler=sampler,
                    sigmas=full_sigmas, latent_image=latent,
                ))[0]
            else:
                # Two-stage: a few steps at this call's normal resolution, a
                # direct latent-space upscale of the video half only (audio
                # is split out and put straight back untouched, never
                # resampled), then the remaining steps continue on the same
                # noise schedule at the higher resolution. Ported verbatim
                # (including the unload_all_models() call and its comment)
                # from the source node — this fixed a real OOM bug there.
                split_step = max(1, min(int(two_stage_first_pass_steps), steps - 1))
                high_sigmas, low_sigmas = _unpack_node_result(_execute_comfy_node(
                    SplitSigmas, sigmas=full_sigmas, step=split_step,
                ))[:2]

                noise1 = _unpack_node_result(_execute_comfy_node(RandomNoise, noise_seed=chunk_seed))[0]
                pass1_raw, pass1_denoised = _unpack_node_result(_execute_comfy_node(
                    SamplerCustomAdvanced, noise=noise1, guider=guider, sampler=sampler,
                    sigmas=high_sigmas, latent_image=latent,
                ))[:2]

                # Video comes from the clean (denoised) estimate — that's what
                # actually gets upscaled. Audio comes from the raw
                # continuation state, preserving its own natural
                # in-progress denoising trajectory.
                video_for_upscale = _unpack_node_result(_execute_comfy_node(
                    LTXVSeparateAVLatent, av_latent=pass1_denoised,
                ))[0]
                audio_carry = _unpack_node_result(_execute_comfy_node(
                    LTXVSeparateAVLatent, av_latent=pass1_raw,
                ))[1]

                video_samples = video_for_upscale["samples"]
                cur_h_latent, cur_w_latent = video_samples.shape[-2], video_samples.shape[-1]
                try:
                    comfy.model_management.unload_all_models()
                except Exception:
                    log.warning("[MuseCharacterSheetH3] could not unload "
                                "the main model before the Stage-2 upscaler — "
                                "continuing anyway.")

                upscaled_result = _unpack_node_result(_execute_comfy_node(
                    MinimaxH3LatentUpscaler3D,
                    latent={"samples": video_samples},
                    model_name=two_stage_latent_upscale_model,
                    mode={"mode": "megapixels", "megapixels": float(two_stage_target_megapixels)},
                    align=CANVAS_MULTIPLE,
                    enable_temporal_chunking=bool(two_stage_enable_temporal_chunking),
                    force_unload=True,
                    device="cuda",
                    precision="fp16",
                ))[0]
                upscaled_samples = upscaled_result["samples"]
                tgt_h, tgt_w = upscaled_samples.shape[-2], upscaled_samples.shape[-1]
                eff_x = tgt_w / cur_w_latent if cur_w_latent else 0.0
                eff_y = tgt_h / cur_h_latent if cur_h_latent else 0.0
                upscaled_video = dict(video_for_upscale)
                upscaled_video["samples"] = upscaled_samples
                upscaled_video["noise_mask"] = torch.ones_like(upscaled_samples)
                log.info(
                    "[MuseCharacterSheetH3] two-stage upscale (MinimaxH3LatentUpscaler3D): "
                    "latent %dx%d -> %dx%d (requested %.2f MP, effective %.3fx/%.3fx)",
                    cur_w_latent, cur_h_latent, tgt_w, tgt_h,
                    float(two_stage_target_megapixels), eff_x, eff_y,
                )

                positive_stage2 = _rebuild_refs_conditioning_for_stage2(
                    positive, vae, tgt_w, tgt_h,
                    ref_image_size=ref_image_size,
                    chunk_ref_images=chunk_ref_images,
                    chunk_ref_videos=chunk_ref_videos,
                )
                positive_stage2 = _rebuild_keyframe_conditioning_for_stage2(
                    positive_stage2, vae, None, None,
                    tgt_w, tgt_h, chunk_length, guide_frames=None,
                )
                stage2_guider = _unpack_node_result(_execute_comfy_node(
                    BasicGuider, model=chunk_shifted_model,
                    conditioning=positive_stage2,
                ))[0]

                # Reference workflow's exact structure: before recombining
                # with audio, the upscaled video alone goes through one more
                # SamplerCustomAdvanced call at a near-single-point sigma
                # slice, reusing the SAME noise/seed as pass 1.
                tiny_sigmas = _unpack_node_result(_execute_comfy_node(
                    SplitSigmas, sigmas=low_sigmas, step=0,
                ))[0]
                video_primed = _unpack_node_result(_execute_comfy_node(
                    SamplerCustomAdvanced, noise=noise1, guider=stage2_guider, sampler=sampler,
                    sigmas=tiny_sigmas, latent_image=upscaled_video,
                ))[0]

                recombined = _unpack_node_result(_execute_comfy_node(
                    LTXVConcatAVLatent, video_latent=video_primed, audio_latent=audio_carry,
                ))[0]

                # The real final pass uses DisableNoise, not reused RandomNoise
                # — verified directly against the reference graph.
                noise2 = _unpack_node_result(_execute_comfy_node(DisableNoise))[0]
                sampled = _unpack_node_result(_execute_comfy_node(
                    SamplerCustomAdvanced, noise=noise2, guider=stage2_guider, sampler=sampler,
                    sigmas=low_sigmas, latent_image=recombined,
                ))[0]

            # [2026-09-09 / ported 2026-09-17] Final-chunk transformer unload
            # before the decode/mux finale — this node's one and only chunk is
            # always "the final chunk", so this always fires.
            if _MUSE_FINAL_CHUNK_UNLOAD:
                try:
                    _av_before = psutil.virtual_memory().available / 2**30
                    _seen = set()
                    for _m in (chunk_shifted_model, model):
                        if _m is None or id(_m) in _seen:
                            continue
                        _seen.add(id(_m))
                        comfy.model_management.unload_model_and_clones(_m)
                    gc.collect()
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    _av_after = psutil.virtual_memory().available / 2**30
                    log.info(
                        "[unload-exp] final-chunk transformer unload: RAM free "
                        "%.1f GB before -> %.1f GB after (delta %+.1f GB)",
                        _av_before, _av_after, _av_after - _av_before,
                    )
                except Exception as _exc:
                    log.warning("[unload-exp] final-chunk unload failed, continuing: %s", _exc)

            chunk_images = _unpack_node_result(_execute_comfy_node(VAEDecode, samples=sampled, vae=vae))[0]
            chunk_audio = _unpack_node_result(_execute_comfy_node(VAEDecodeAudio, samples=sampled, vae=audio_vae))[0]

            new_frames = chunk_images
            waveform = chunk_audio["waveform"]

            _push_ephemeral_chunk_preview(unique_id, new_frames, waveform, chunk_audio["sample_rate"])

            final_images = new_frames
            final_audio = {"waveform": waveform, "sample_rate": chunk_audio["sample_rate"]}

        ref_audio_outputs = [None, None, None]
        for clip_audio, _entry, ui_idx in user_ref_audios:
            ref_audio_outputs[ui_idx] = clip_audio

        return (final_images, final_audio, compiled_prompt, ref_images_used, *ref_audio_outputs)


@PromptServer.instance.routes.get("/muse_character_sheet_h3/view_streamed_video")
async def muse_character_sheet_h3_view_streamed_video_endpoint(request):
    token = (request.query.get("token") or "").strip()
    path = _STREAMED_PREVIEW_FILES.get(token)
    if not path or not os.path.isfile(path):
        raise web.HTTPNotFound(text="Chunk preview is no longer available.")
    return web.FileResponse(path, headers={"Content-Type": "video/mp4"})


# [2026-09-17] Ported from Muse-MiniMax-Director-Combo-V2 — the per-image
# "Analyze" button (writes a reference slot's description via a vision-LLM)
# was mistakenly dropped from the original single-chunk port along with the
# unrelated Prompt-Gen/LLM-assist system. This is a separate, self-contained
# feature: one HTTP route + one provider-agnostic HTTP-calling helper, no
# dependency on anything else that got cut.
_MUSE_H3_PROVIDER_DEFAULTS = {
    "ollama": {"url": "http://127.0.0.1:11434", "model": "huihui_ai/qwen3.5-abliterated:2b"},
    "lmstudio": {"url": "http://127.0.0.1:1234", "model": ""},
    "custom": {"url": "", "model": ""},
    "gemini": {"url": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-2.5-flash"},
}

_MUSE_H3_ANALYZE_PROMPT = (
    "Look at the image and write exactly one sentence describing it, in the form: a short "
    "identity noun phrase, then a comma, then a detail clause of distinguishing features.\n\n"
    "If the image shows the same subject repeated across a grid or multiple panels — a "
    "character turnaround/reference sheet with several poses, angles, or close-ups of one "
    "person — describe that ONE subject as a single coherent person, based on what's "
    "consistent across every panel.\n\n"
    "Describe only the subject itself — never the background, backdrop, studio setting, "
    "location, or how they are posed or positioned in the photo. This applies to every image, "
    "not just grids: a plain white backdrop, a bedroom, a street, a specific pose or camera "
    "angle are all part of how this particular reference photo happens to be taken, not part of "
    "the subject's own appearance, and must never appear in the description — regardless of "
    "whether the subject is clothed or nude.\n\n"
    "If the main subject is a person/character, the identity phrase should be something like "
    "'the young woman' or 'the man with the beard', and the detail clause should cover, "
    "concisely: hair (color, length, style), skin tone if distinctive, build, and — if clothed "
    "— everything they're wearing from head to toe: top, bottom, footwear, and any accessories "
    "such as jewelry, hats, bags, or glasses. If the subject is nude, say so plainly as part of "
    "the detail clause instead of describing clothing. Only include what's actually visible; "
    "skip any category that isn't shown (e.g. no visible footwear) rather than guessing or "
    "inventing one. If the main subject IS a place or setting — the image itself is a "
    "background/location reference, not a person or object photographed in front of one — the "
    "identity phrase should be something like 'the coffee-shop environment' or 'the rooftop at "
    "night', and the detail clause should cover the distinctive fixtures, colors, and lighting. "
    "If it's an object, the identity phrase should name it, and the detail clause should cover "
    "its shape, color, material, and distinctive details. Do not start with 'a photo of' or "
    "similar. Do not state which category you chose. Output only the single sentence, nothing "
    "else."
)


def _muse_h3_resolve_provider(data):
    provider = (data.get("provider") or "ollama").lower()
    defs = _MUSE_H3_PROVIDER_DEFAULTS.get(provider, _MUSE_H3_PROVIDER_DEFAULTS["ollama"])
    supplied_base_url = (data.get("base_url") or "").strip()
    supplied_model = (data.get("model") or "").strip()

    if provider == "gemini":
        if supplied_model and ":" in supplied_model:
            log.warning(
                "[MuseCharacterSheetH3] Ignoring inherited local model %r for Gemini; using %s.",
                supplied_model, defs["model"],
            )
            supplied_model = ""
        if supplied_base_url and (
            "127.0.0.1" in supplied_base_url.lower()
            or "localhost" in supplied_base_url.lower()
        ):
            log.warning(
                "[MuseCharacterSheetH3] Ignoring inherited local Base URL for Gemini; using Google's endpoint."
            )
            supplied_base_url = ""

    base_url = (supplied_base_url or defs["url"]).rstrip("/")
    model = supplied_model or defs["model"]
    return provider, base_url, model


async def _muse_h3_call_vlm(provider, base_url, model_name, system_prompt, image_b64_list, max_tokens=4096):
    """Returns (ok: bool, text_or_error: str)."""
    import aiohttp

    cleaned_b64_list = []
    for b64 in (image_b64_list or []):
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        cleaned_b64_list.append(b64)

    if provider in ("lmstudio", "custom") and not model_name:
        return False, f"No model name set for {provider}. Enter your loaded model's name."

    try:
        async with aiohttp.ClientSession() as session:
            if provider == "ollama":
                payload = {
                    "model": model_name, "prompt": system_prompt,
                    "images": cleaned_b64_list, "stream": False, "keep_alive": 0,
                    "options": {"num_predict": int(max_tokens)},
                }
                async with session.post(f"{base_url}/api/generate", json=payload, timeout=120) as response:
                    if response.status != 200:
                        err_txt = await response.text()
                        return False, f"Ollama HTTP {response.status}: {err_txt}"
                    resp_json = await response.json()
                    generated_text = (resp_json.get("response") or "").strip()
            elif provider == "gemini":
                api_key = os.environ.get("GEMINI_API_KEY")
                if not api_key:
                    return False, "GEMINI_API_KEY environment variable is not set. Set it and restart ComfyUI."
                content = [{"type": "text", "text": system_prompt}]
                for b64 in cleaned_b64_list:
                    content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
                payload = {
                    "model": model_name,
                    "messages": [{"role": "user", "content": content}],
                    "max_tokens": int(max_tokens), "stream": False, "reasoning_effort": "none",
                }
                headers = {"Authorization": f"Bearer {api_key}"}
                async with session.post(f"{base_url}/chat/completions", json=payload, headers=headers, timeout=120) as response:
                    if response.status != 200:
                        err_txt = await response.text()
                        return False, f"Gemini HTTP {response.status}: {err_txt}"
                    resp_json = await response.json()
                    try:
                        msg = resp_json["choices"][0]["message"]
                        generated_text = (msg.get("content") or "").strip()
                    except (KeyError, IndexError, TypeError):
                        return False, "Unexpected response shape from Gemini."
            else:
                content = [{"type": "text", "text": system_prompt}]
                for b64 in cleaned_b64_list:
                    content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
                payload = {
                    "model": model_name,
                    "messages": [{"role": "user", "content": content}],
                    "max_tokens": int(max_tokens), "stream": False,
                }
                async with session.post(f"{base_url}/v1/chat/completions", json=payload, timeout=120) as response:
                    if response.status != 200:
                        err_txt = await response.text()
                        return False, f"{provider} HTTP {response.status}: {err_txt}"
                    resp_json = await response.json()
                    try:
                        msg = resp_json["choices"][0]["message"]
                        generated_text = (msg.get("content") or "").strip()
                        if not generated_text:
                            generated_text = (msg.get("reasoning_content") or "").strip()
                    except (KeyError, IndexError, TypeError):
                        return False, f"Unexpected response shape from {provider}."
    except aiohttp.ClientConnectorError:
        return False, f"Could not connect to {provider} at {base_url}. Make sure the server is running and reachable."

    if "<think>" in generated_text:
        generated_text = generated_text.split("</think>")[-1].strip()
    return True, generated_text


@PromptServer.instance.routes.post("/muse_character_sheet_h3/analyze_character")
async def muse_character_sheet_h3_analyze_character_endpoint(request):
    try:
        data = await request.json()
        image_b64 = data.get("image_b64", "")
        char_index = int(data.get("char_index", 0))
        provider, base_url, model_name = _muse_h3_resolve_provider(data)

        if provider == "off":
            return web.json_response({"status": "error", "message": "Analyze is set to Off / Manual."})
        if not image_b64:
            return web.json_response({"status": "error", "message": "No image provided for analysis."})

        b64_list = image_b64 if isinstance(image_b64, list) else [image_b64]

        log.info("[MuseCharacterSheetH3] Analyzing reference %d via %s (%s, model '%s')...",
                 char_index + 1, provider, base_url, model_name)

        ok, result = await _muse_h3_call_vlm(provider, base_url, model_name, _MUSE_H3_ANALYZE_PROMPT, b64_list)
        if not ok:
            return web.json_response({"status": "error", "message": result})

        log.info("[MuseCharacterSheetH3] Reference analysis complete: %s", result)
        return web.json_response({"status": "success", "description": result})

    except Exception as e:
        log.error("[MuseCharacterSheetH3] Failed to analyze reference: %s", e)
        return web.json_response({"status": "error", "message": str(e)}, status=500)


NODE_CLASS_MAPPINGS = {"MuseCharacterSheetH3": MuseCharacterSheetH3}

NODE_DISPLAY_NAME_MAPPINGS = {"MuseCharacterSheetH3": "Muse CharacterSheet H3"}
