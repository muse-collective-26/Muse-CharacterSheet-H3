"""User-chosen output paths, with ComfyUI's output directory as the default.

No WAS dependency, administrator privileges, whitelist changes, model downloads
required. Existing files are never overwritten.
"""
import os
from pathlib import Path, PureWindowsPath
import re
import time
from datetime import datetime

import folder_paths

VERSION = "1.1.0"
DEFAULT_FOLDER = "Muse Collective/MiniMax H3 Prompt/{date}"
_RESERVED = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", re.I)
_INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_EXTENSIONS = (".txt", ".md", ".json", ".csv", ".log")


def _component(value, label, allow_empty=False):
    value = str(value)
    if allow_empty and not value:
        return value
    if (not value or value in (".", "..") or _INVALID.search(value)
            or value.endswith((" ", ".")) or _RESERVED.match(value)):
        raise ValueError(f"Muse Save Text: {label} must be a plain filename component, "
                         "without path separators, reserved names or special path characters.")
    return value


def _destination(subfolder):
    # Read on every save: custom --output-directory and desktop configuration win.
    root = Path(folder_paths.get_output_directory()).expanduser().resolve()
    raw = str(subfolder).replace("{date}", datetime.now().strftime("%Y-%m-%d"))
    raw = raw.replace("[time(%Y-%m-%d)]", datetime.now().strftime("%Y-%m-%d"))
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in ('"', "'"):
        raw = raw[1:-1]
    raw = os.path.expandvars(raw)
    if os.name != 'nt' and PureWindowsPath(raw).drive:
        raise ValueError("Muse Save Text: this ComfyUI runs on Linux/macOS. Use a path on that machine, "
                         "such as /workspace/output, not a Windows drive path.")
    if os.name == 'nt' and PureWindowsPath(raw).drive and not PureWindowsPath(raw).root:
        raise ValueError("Muse Save Text: use a full drive path, such as D:/Prompts, not D:Prompts.")
    requested = Path(raw).expanduser()
    destination = (requested if requested.is_absolute() else root / requested).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    return destination


def save_text(text, subfolder=DEFAULT_FOLDER, filename_prefix="MiniMaxPrompt",
              filename_suffix="", filename_number_padding=4, file_extension=".txt"):
    if not isinstance(text, str):
        raise ValueError("Muse Save Text: connect a STRING text output to the text input.")
    prefix = _component(filename_prefix, "filename prefix")
    suffix = _component(filename_suffix, "filename suffix", allow_empty=True)
    padding = int(filename_number_padding)
    if not 1 <= padding <= 8:
        raise ValueError("Muse Save Text: number padding must be between 1 and 8.")
    if file_extension not in _EXTENSIONS:
        raise ValueError("Muse Save Text: choose a supported text-file extension.")
    # Encode before creating a file, so invalid Unicode cannot leave an empty output.
    data = text.encode("utf-8")
    destination = _destination(subfolder)
    pattern = re.compile(re.escape(prefix + "_") + r"(\d+)" + re.escape(suffix + file_extension) + "$", re.I)
    highest = 0
    for entry in destination.iterdir():
        match = pattern.fullmatch(entry.name)
        if match:
            highest = max(highest, int(match.group(1)))
    counter = highest + 1
    for _ in range(10000):
        path = destination / f"{prefix}_{counter:0{padding}d}{suffix}{file_extension}"
        if len(path.name.encode("utf-8")) > 240:
            raise ValueError("Muse Save Text: shorten the filename prefix or suffix.")
        # Exclusive creation works across threads/processes, without a shared .tmp
        # file or replacement of existing files (a frequent Windows lock problem).
        for attempt in range(6):
            try:
                handle = path.open("xb")
                break
            except FileExistsError:
                handle = None
                break
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(min(0.1 * 2 ** attempt, 0.8))
        if handle is None:
            counter += 1
            continue
        try:
            with handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            # Only remove the new file we successfully created, never an older output.
            try:
                path.unlink()
            except OSError:
                pass
            raise
        return path
    raise RuntimeError("Muse Save Text: too many simultaneous filename collisions; please retry.")


class MuseSaveText:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "text": ("STRING", {"forceInput": True}),
            "path": ("STRING", {"default": DEFAULT_FOLDER,
                "tooltip": "Any writable folder on the ComfyUI machine: D:/Prompts, a network share, or /workspace/prompts. Blank uses ComfyUI output. Relative paths are inside output. {date} adds today's date."}),
            "filename_prefix": ("STRING", {"default": "MiniMaxPrompt"}),
            "filename_suffix": ("STRING", {"default": ""}),
            "filename_number_padding": ("INT", {"default": 4, "min": 1, "max": 8}),
            "file_extension": (list(_EXTENSIONS),),
        }}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("text", "saved_path")
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "Muse/Files"
    DESCRIPTION = "Save UTF-8 text to any writable folder you choose, with automatic numbering. Blank path uses ComfyUI output. No WAS or whitelist required."

    def save(self, text, path=DEFAULT_FOLDER, filename_prefix="MiniMaxPrompt",
             filename_suffix="", filename_number_padding=4, file_extension=".txt", subfolder=None):
        # Accept older API prompts from v1.0 without silently losing their folder.
        requested_path = subfolder if subfolder is not None else path
        try:
            path = save_text(text, requested_path, filename_prefix, filename_suffix,
                             filename_number_padding, file_extension)
        except OSError as exc:
            raise RuntimeError(
                "Muse Save Text could not write to the selected folder "
                f"({requested_path or folder_paths.get_output_directory()}). Check that the folder is writable "
                f"and the disk has free space. System message: {exc}"
            ) from exc
        print(f"[Muse Save Text] Saved: {path}")
        return {"ui": {"text": [f"Saved: {path}"]}, "result": (text, str(path))}
