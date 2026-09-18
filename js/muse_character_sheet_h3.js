// Muse Character Sheet H3 — timeline UI. [2026-09-17]
//
// Stripped, single-chunk derivative of Muse-MiniMax-Director-Combo-V2's timeline
// editor (muse_minimax_director.js), ported for the MuseCharacterSheetH3 node.
// See muse_character_sheet_h3.py's module docstring for the full KEEP/DROP
// accounting against the source file. In short: this node is permanently
// Reference (Omni) mode, exactly one chunk (no mode selector, no Add/Delete
// Chunk bar — chunkIdx is hardcoded to 0 throughout, matching the Python side's
// own single-chunk loop), no disk streaming, no Seed Hunt, no Prompt Gen /
// LLM-assist features (those need backend routes this node's Python file does
// not register).
//
// mode/clip/vae/duration_seconds/ref_image_size/etc. are real native widgets
// declared in the Python node — this file re-skins them into boxed sections
// rather than managing separate state for them. Character/location reference
// images and reference video/audio clips are real uploaded files (via
// ComfyUI's own /upload/image endpoint) with scrub + Set In/Out trim controls
// where relevant — file path + trim window live in timeline_data; Python
// resolves/decodes them (with PyAV for video/audio) at execute time.
//
// [2026-09-17] Judgment call: the source node keeps BOTH a "Shared References"
// pool and a per-chunk "local override" panel, because a multi-chunk timeline
// can want chunk 2 to use a different costume/location than chunk 1. This node
// only ever has one chunk, so that shared/local distinction has nothing to
// differ from — only the Shared References panel is built here. This matches
// the Python side, which never populates localCharacters/localLocations/
// localRefVideos/localRefAudios, so _effective_character_entries always
// resolves to the shared entries.
const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

// [2026-09-17] Must match _MUSE_LIVE_PREVIEW_EVENT in muse_character_sheet_h3.py
// exactly — the native "Now Generating" live sampling preview event name.
// Deliberately its own name/route, distinct from Combo V2's identical
// mechanism, so the two nodes' websocket events/HTTP routes never collide
// even though both packages stay installed side by side.
const _MUSE_LIVE_PREVIEW_EVENT = "muse_character_sheet_h3_live_preview";
const _MUSE_CHUNK_PREVIEW_EVENT = "muse_character_sheet_h3_chunk_preview";
const _MUSE_VIEW_ROUTE = "/muse_character_sheet_h3/view_streamed_video";

const MAX_CHARACTER_SLOTS = 8;
const MAX_LOCATION_SLOTS = 7;
const REF_AV_SLOTS = 3;
const SUPPORTED_MEGAPIXELS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1.0, 1.2, 1.5, 1.8, 2.0];
const HIDDEN_WIDGET_NAMES = ["timeline_data"];
const BOXED_WIDGET_NAMES = [
  "duration_seconds", "aspect_ratio", "megapixels", "multiple",
  "steps", "sampler_name", "scheduler", "seed", "control_after_generate", "use_prompt_override",
  "two_stage_sampling", "two_stage_first_pass_steps", "two_stage_latent_upscale_model",
  "two_stage_target_megapixels", "two_stage_enable_temporal_chunking",
  "use_refmod", "refmod_retention", "refmod_description",
  "refmod_override", "refmod_curve_direction", "refmod_curve_shape", "refmod_curve_value",
  "refmod_scramble_seed", "refmod_scramble_mode", "refmod_scramble_keep",
  "refmod_max_total_tokens", "refmod_graph_preset", "refmod_save_preset_as",
  "ref_image_size",
];
// Floor for a single CUT's typed-in duration. Deliberately small — this only
// bounds one CUT's own length, not how much room redistributing it needs
// elsewhere (see _buildCutBlock's duration input, which pulls/gives that
// difference across every other CUT in the chunk at once).
const MIN_CUT_SECONDS = 0.3;

// The node's whole panel is one big addDOMWidget HTML overlay sitting on top
// of LiteGraph's own canvas — a mouse wheel over any of it lands on this DOM
// tree first, never reaching the canvas below, so hovering the node to zoom
// (ComfyUI's normal wheel behavior everywhere else) silently did nothing.
// There's no code anywhere deliberately blocking it; the DOM element is just
// in the way. Forwarding a cloned wheel event on to app.canvas.canvas lets
// LiteGraph's own existing zoom handler take it from there, exactly as if
// the cursor were over blank canvas — genuinely scrollable/interactive
// elements (textareas, dropdowns, number/range inputs, video scrubbers, a
// scrollable inner panel) are left alone so they keep working normally.
function enableCanvasZoomOverDOM(root) {
  root.addEventListener(
    "wheel",
    (event) => {
      const target = event.target;
      const interactive = target?.closest?.(
        "textarea, select, input[type='number'], input[type='range'], " +
        "video, [contenteditable='true'], [data-wheel-interactive='true']"
      );
      if (interactive) return;

      // Preserve intentionally scrollable inner panels.
      let element = target;
      while (element && element !== root) {
        const style = getComputedStyle(element);
        const scrollable =
          /(auto|scroll)/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight;
        if (scrollable) return;
        element = element.parentElement;
      }

      const canvas = app?.canvas?.canvas;
      if (!canvas) return;

      event.preventDefault();
      event.stopPropagation();
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaZ: event.deltaZ,
          deltaMode: event.deltaMode,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          bubbles: true,
          cancelable: true,
        })
      );
    },
    { passive: false }
  );
}

// Fixed-vocabulary retention markers from MiniMax's own reference-mode prompt
// guide (retention_analysis section) — visual markers apply to Subject/Picture/
// Video, audio markers apply to Audio. Values are the literal English tokens the
// guide requires; labels are just the friendlier on-screen text.
const VISUAL_RETENTION_OPTIONS = [
  { value: "fully_preserved", label: "fully preserved" },
  { value: "partially_preserved", label: "partially preserved" },
  { value: "attribute_transfer", label: "attribute transfer" },
  { value: "weak_reference", label: "weak reference" },
];
// Labels describe intent in plain terms ("what do you want this audio to do"),
// not H3's own internal vocabulary — the underlying `value` is still the exact
// literal token H3's retention_analysis section requires, unchanged.
const AUDIO_RETENTION_OPTIONS = [
  { value: "reference", label: "Voice Reference — new dialogue, same voice" },
  { value: "fully_copy", label: "Lip Sync — drive dialogue from this exact recording" },
  { value: "partially_copy", label: "Partial Voice Match — some traits carried over" },
  { value: "weak_reference", label: "Weak Reference — loose vibe only, not their real voice" },
];

const CUT_COLORS = [
  { bar: "#4F8EF7", glow: "rgba(79,142,247,0.35)" },
  { bar: "#33C481", glow: "rgba(51,196,129,0.35)" },
  { bar: "#F0665B", glow: "rgba(240,102,91,0.35)" },
  { bar: "#B26BF7", glow: "rgba(178,107,247,0.35)" },
  { bar: "#F7B94F", glow: "rgba(247,185,79,0.35)" },
  { bar: "#4FD1F7", glow: "rgba(79,209,247,0.35)" },
];

const ICON_UPLOAD = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
const ICON_TRASH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const ICON_DRAG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.6"/><circle cx="16" cy="6" r="1.6"/><circle cx="8" cy="12" r="1.6"/><circle cx="16" cy="12" r="1.6"/><circle cx="8" cy="18" r="1.6"/><circle cx="16" cy="18" r="1.6"/></svg>`;
const ICON_PLUS = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const ICON_PLAY = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 21 12 6 21 6 3"/></svg>`;
const ICON_PAUSE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;

// [2026-09-17] CSS ported near-verbatim from Combo V2's injectStyles() — the
// porting brief explicitly says not to spend time pruning it, and every rule
// here is still exactly the same visual language this node wants. Only the
// <style> element's own guard id changed (to "musecharsheeth3-styles"), so
// this node's stylesheet actually gets injected even when Combo V2's
// identically-named ".musecombo-v2-*" ruleset already exists on the page —
// the class names themselves are deliberately left unchanged (same design,
// harmless if both happen to be present) rather than renamed wholesale.
function injectStyles() {
  if (document.getElementById("musecharsheeth3-styles")) return;
  const style = document.createElement("style");
  style.id = "musecharsheeth3-styles";
  style.textContent = `
  .musecombo-v2-root {
    display: flex; flex-direction: column; gap: 14px;
    background: linear-gradient(180deg, #10141c 0%, #0a0c12 100%);
    border: 1px solid #3a3a48; border-radius: 12px;
    padding: 14px; box-sizing: border-box; width: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #e4e4ea;
  }
  .musecombo-v2-section-title {
    font-size: 12.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: #7a7a8c; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;
  }
  .musecombo-v2-section-title .musecombo-v2-badge {
    background: #ff4d4d22; color: #ff6b6b; border-radius: 4px; padding: 1px 6px;
    font-size: 10.5px; letter-spacing: 0.04em;
  }
  .musecombo-v2-gear-hint { color: #6a6a7c; font-size: 11.5px; line-height: 1.4; }

  /* Boxed settings panel */
  .musecombo-v2-boxes-row { display: flex; gap: 10px; flex-wrap: wrap; }
  .musecombo-v2-box {
    flex: 1; min-width: 170px; background: #1e1e26; border: 1px solid #3a3a48;
    border-top: 3px solid #3a3a48; border-radius: 10px; padding: 10px 12px; box-sizing: border-box;
  }
  .musecombo-v2-box-generation { border-top-color: #4F8EF7; }
  .musecombo-v2-box-resolution { border-top-color: #33C481; }
  .musecombo-v2-box-sampling { border-top-color: #F0665B; }
  .musecombo-v2-box-reference { border-top-color: #B26BF7; }
  .musecombo-v2-box-title {
    font-size: 11.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: #6a6a7a; margin-bottom: 8px;
  }
  .musecombo-v2-box-row {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 5px 0; border-top: 1px solid #22222b;
  }
  .musecombo-v2-box-row:first-of-type { border-top: none; }
  .musecombo-v2-box-row label { font-size: 12px; color: #9a9aa8; white-space: nowrap; }
  .musecombo-v2-box-select, .musecombo-v2-box-number {
    background: #101015; border: 1px solid #2e2e3a; border-radius: 6px; color: #e4e4ea;
    font-size: 12.5px; padding: 4px 6px; max-width: 62%; box-sizing: border-box;
  }
  .musecombo-v2-box-select option { background: #1a1a22; color: #e4e4ea; font-size: 12.5px; }
  .musecombo-v2-box-checkbox { width: 15px; height: 15px; accent-color: #4F8EF7; cursor: pointer; }
  .musecombo-v2-box-select:focus, .musecombo-v2-box-number:focus { outline: none; border-color: #4F8EF7; }

  .musecombo-v2-style-input {
    width: 100%; box-sizing: border-box; background: #1a1a22; border: 1px solid #2e2e3a;
    border-radius: 8px; color: #e4e4ea; padding: 8px 10px; font-size: 16px; resize: vertical;
    min-height: 36px; font-family: inherit;
  }
  .musecombo-v2-style-input:focus { outline: none; border-color: #4F8EF7; }

  /* Timeline / ruler */
  .musecombo-v2-chunks-wrap { display: flex; flex-direction: column; gap: 14px; }
  .musecombo-v2-chunk-section {
    border: 1px solid #2e2e3a; border-radius: 10px; padding: 10px; background: #16161c;
  }
  .musecombo-v2-chunk-heading {
    font-size: 12.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: #9a9aae; margin-bottom: 8px;
  }
  .musecombo-v2-chunk-heading-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px 16px;
    margin-bottom: 8px; flex-wrap: wrap;
  }
  .musecombo-v2-chunk-heading-row .musecombo-v2-chunk-heading { margin-bottom: 0; }
  .musecombo-v2-chunk-actions { display: flex; align-items: center; gap: 10px; flex-wrap: nowrap; }
  .musecombo-v2-chunk-seed { color: #aab5c8; font-size: 11.5px; font-weight: 650; letter-spacing: 0; text-transform: none; }
  .musecombo-v2-chunk-style-wrap { margin-bottom: 10px; }
  .musecombo-v2-chunk-style-title-row { display: flex; align-items: center; gap: 6px; }
  .musecombo-v2-ruler-wrap { position: relative; }
  .musecombo-v2-ruler {
    position: relative; height: 20px; margin-bottom: 4px; border-bottom: 1px solid #3a3a48;
  }
  .musecombo-v2-ruler-tick {
    position: absolute; top: 0; bottom: 0; width: 1px; background: #3a3a48;
  }
  .musecombo-v2-ruler-tick-minor {
    position: absolute; top: 65%; bottom: 0; width: 1px; background: #2a2a34;
  }
  .musecombo-v2-ruler-tick-label {
    position: absolute; top: 0; font-size: 11px; font-weight: 650; color: #ffffff; transform: translateX(2px);
  }
  .musecombo-v2-track {
    display: flex; height: 118px; border-radius: 10px; overflow: hidden; border: 1px solid #3a3a48;
    background: #18181f;
  }
  .musecombo-v2-cut-block {
    position: relative; display: flex; flex-direction: column; min-width: 40px;
    border-right: 1px solid #0d0d11; cursor: grab; box-sizing: border-box;
  }
  .musecombo-v2-cut-block.musecombo-v2-dragging { opacity: 0.35; }
  .musecombo-v2-cut-block.musecombo-v2-drag-over { box-shadow: inset 3px 0 0 #fff; }
  .musecombo-v2-cut-bar { height: 4px; width: 100%; flex-shrink: 0; }
  .musecombo-v2-cut-head {
    display: flex; align-items: center; justify-content: space-between; padding: 5px 7px 3px 7px;
    flex-shrink: 0;
  }
  .musecombo-v2-cut-label { font-size: 12px; font-weight: 700; letter-spacing: 0.02em; white-space: nowrap; display: flex; align-items: center; gap: 3px; }
  .musecombo-v2-cut-duration-input {
    width: 44px; background: #14141a; border: 1px solid #2a2a35; border-radius: 3px;
    color: #d4d4dc; font-size: 11px; font-weight: 700; font-family: inherit;
    padding: 1px 2px; text-align: right; -moz-appearance: textfield;
  }
  .musecombo-v2-cut-duration-input::-webkit-outer-spin-button,
  .musecombo-v2-cut-duration-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .musecombo-v2-cut-duration-input:focus { outline: none; border-color: #4F8EF7; }
  .musecombo-v2-cut-duration-unit { color: #7a7a8c; font-weight: 400; }
  .musecombo-v2-cut-actions { display: flex; align-items: center; gap: 5px; color: #5a5a6a; flex-shrink: 0; }
  .musecombo-v2-cut-actions svg { display: block; }
  .musecombo-v2-cut-del { cursor: pointer; }
  .musecombo-v2-cut-del:hover { color: #ff6b6b; }
  .musecombo-v2-cut-text {
    width: 100%; flex: 1; box-sizing: border-box; background: transparent; border: none; color: #d4d4dc;
    font-size: 14.5px; line-height: 1.4; padding: 0 7px 8px 7px; resize: none; font-family: inherit;
  }
  .musecombo-v2-cut-text:focus { outline: none; }
  .musecombo-v2-cut-resize {
    position: absolute; top: 0; right: -4px; bottom: 0; width: 8px; cursor: ew-resize; z-index: 4;
  }
  .musecombo-v2-cut-resize:hover, .musecombo-v2-cut-resize.musecombo-v2-active { background: rgba(255,255,255,0.08); }
  .musecombo-v2-add-cut-bar {
    width: 100%; box-sizing: border-box; margin-top: 6px; padding: 9px;
    border: 2px solid #8a4d68; border-radius: 8px; background: #b06b8a;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    cursor: pointer; color: #fff; font-weight: 700; font-size: 13px; transition: all 0.15s ease;
  }
  .musecombo-v2-add-cut-bar:hover { color: #fff; background: #c383a0; border-color: #b06b8a; }
  .musecombo-v2-add-cut-bar svg { display: block; }
  .musecombo-v2-track-hint { font-size: 11px; color: #4a4a58; margin-top: 5px; }

  /* References row — grid, not flex-wrap. auto-fit collapses empty column
     tracks so the real columns always stretch to consume 100% width. */
  .musecombo-v2-char-row {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap: 10px;
  }
  .musecombo-v2-char-slot {
    background: #1e1e26; border: 2px solid #D1A6FA; border-radius: 10px;
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
    padding: 5px; cursor: pointer; position: relative; transition: all 0.15s ease; box-sizing: border-box;
  }
  .musecombo-v2-char-slot:hover { border-color: #4F8EF7; background: #1a1c24; }
  .musecombo-v2-char-slot.musecombo-v2-filled {
    border-color: #B26BF7;
    box-shadow: 0 0 0 1px rgba(178,107,247,0.2);
  }
  .musecombo-v2-char-slot.musecombo-v2-bg-slot { border-color: #F7B94F99; }
  .musecombo-v2-char-slot.musecombo-v2-bg-slot:hover { border-color: #F7B94F; }
  .musecombo-v2-char-slot.musecombo-v2-char-slot-disabled {
    cursor: default; opacity: 0.45; border-style: dashed; border-color: #5a5a6a; background: #16161c;
  }
  .musecombo-v2-char-slot.musecombo-v2-char-slot-disabled:hover { border-color: #5a5a6a; background: #16161c; }
  .musecombo-v2-char-label {
    position: absolute; top: 4px; left: 5px; font-size: 10px; font-weight: 700;
    color: #fff; background: rgba(0,0,0,0.55); border-radius: 4px; padding: 1px 4px;
    z-index: 2; pointer-events: none;
  }
  .musecombo-v2-char-placeholder { color: #4a4a58; font-size: 10.5px; text-align: center; margin-top: 20px; line-height: 1.4; }
  .musecombo-v2-char-preview { width: 100%; height: 60px; border-radius: 6px; overflow: hidden; background: #0a0a0d; margin-top: 15px; }
  .musecombo-v2-char-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .musecombo-v2-char-del {
    position: absolute; top: 3px; right: 3px; width: 16px; height: 16px; border-radius: 50%;
    background: rgba(0,0,0,0.6); color: #fff; border: none; display: flex; align-items: center;
    justify-content: center; cursor: pointer; z-index: 3; font-size: 12.5px; line-height: 1;
  }
  .musecombo-v2-char-del:hover { background: #d33; }
  .musecombo-v2-analyze-btn {
    margin-top: 4px; width: 100%; background: #232330; border: 1px solid #3a3a48; color: #b8b8c8;
    border-radius: 6px; padding: 3px 0; font-size: 10.5px; cursor: pointer; transition: all 0.15s ease;
  }
  .musecombo-v2-analyze-btn:hover { background: #2a2a38; color: #fff; border-color: #4F8EF7; }
  .musecombo-v2-analyze-btn.musecombo-v2-loading { opacity: 0.6; pointer-events: none; }
  .musecombo-v2-clear-chunks-btn {
    padding: 8px 0; font-size: 12.5px; font-weight: 650;
    color: #ffb4b4; background: #3a1a1a; border: 1px solid #7a3a3a;
  }
  .musecombo-v2-clear-chunks-btn:hover { color: #fff; background: #522525; border-color: #d86868; }
  .musecombo-v2-desc-input {
    margin-top: 4px; width: 100%; box-sizing: border-box; background: #101015; border: 1px solid #26262f;
    border-radius: 5px; color: #c8c8d4; font-size: 12px; padding: 3px 4px; resize: vertical;
    min-height: 28px; font-family: inherit; line-height: 1.3;
  }

  /* Reference video / audio slots */
  .musecombo-v2-av-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
  .musecombo-v2-av-slot {
    flex: 1; min-width: 220px; background: #1e1e26; border-radius: 10px;
    padding: 8px 10px; box-sizing: border-box; position: relative; transition: border-color 0.15s ease;
  }
  .musecombo-v2-av-slot-video { border: 2px solid #4F8EF799; }
  .musecombo-v2-av-slot-video:hover { border-color: #4F8EF7; }
  .musecombo-v2-av-slot-video.musecombo-v2-filled { border-color: #4F8EF7; box-shadow: 0 0 0 1px rgba(79,142,247,0.25); }
  .musecombo-v2-av-slot-audio { border: 2px solid #FF8800; }
  .musecombo-v2-av-slot-audio:hover { border-color: #ffa733; }
  .musecombo-v2-av-slot-audio.musecombo-v2-filled { border-color: #ffa733; box-shadow: 0 0 0 1px rgba(255,136,0,0.3); }
  .musecombo-v2-av-slot-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .musecombo-v2-av-slot-label { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: #7a7a8c; text-transform: uppercase; }
  .musecombo-v2-av-slot-del {
    width: 16px; height: 16px; border-radius: 50%; background: #232330; color: #fff; border: none;
    display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 12.5px; line-height: 1;
  }
  .musecombo-v2-av-slot-del:hover { background: #d33; }
  .musecombo-v2-av-placeholder {
    color: #4a4a58; font-size: 11px; text-align: center; padding: 14px 0; cursor: pointer;
    display: flex; flex-direction: column; align-items: center; gap: 4px;
  }
  .musecombo-v2-av-placeholder:hover { color: #4F8EF7; }
  .musecombo-v2-av-media video { width: 100%; max-height: 90px; border-radius: 6px; background: #000; display: block; }
  .musecombo-v2-av-canvas { width: 100%; height: 40px; display: block; border-radius: 6px; background: #0a0a0d; }
  .musecombo-v2-av-scrub-row { display: flex; align-items: center; gap: 6px; margin: 6px 0 4px 0; }
  .musecombo-v2-av-play-btn {
    width: 22px; height: 22px; border-radius: 50%; background: #232330; border: 1px solid #3a3a48;
    color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer;
    flex-shrink: 0; padding: 0;
  }
  .musecombo-v2-av-play-btn:hover { background: #2a2a38; border-color: #4F8EF7; }
  .musecombo-v2-av-scrub { flex: 1; margin: 0; accent-color: #4F8EF7; cursor: pointer; }
  .musecombo-v2-av-trim-row { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
  .musecombo-v2-av-trim-btn {
    flex: 1; background: #232330; border: 1px solid #3a3a48; color: #b8b8c8; border-radius: 6px;
    padding: 3px 0; font-size: 10.5px; cursor: pointer;
  }
  .musecombo-v2-av-trim-btn:hover { background: #2a2a38; color: #fff; border-color: #4F8EF7; }
  .musecombo-v2-av-trim-input {
    flex: 1; width: 0; min-width: 0; background: #101015; border: 1px solid #2e2e3a; border-radius: 6px;
    color: #d8d8e0; font-size: 10.5px; padding: 3px 4px; text-align: center;
  }
  .musecombo-v2-av-trim-input:focus { outline: none; border-color: #4F8EF7; }
  .musecombo-v2-av-trim-readout { font-size: 15px; font-weight: 700; color: #ffffff; text-align: center; margin-top: 6px; }
  .musecombo-v2-av-filename { font-size: 10px; color: #5a5a6a; margin-top: 3px; word-break: break-all; }

  /* Small secondary selectors (retention markers, video role, CUT speaker) */
  .musecombo-v2-mini-row {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin-top: 6px;
  }
  .musecombo-v2-mini-row label { font-size: 12.5px; color: #8a8a98; }
  .musecombo-v2-mini-select {
    background: #101015; border: 1px solid #2e2e3a; border-radius: 5px; color: #d4d4dc;
    font-size: 13.5px; padding: 4px 7px; max-width: 62%; box-sizing: border-box;
  }
  .musecombo-v2-mini-select option { background: #1a1a22; color: #e4e4ea; font-size: 13.5px; }
  /* [2026-09-18] The character ref grid (Ref N) can pack down to a narrow
     128px column (repeat(auto-fit, minmax(128px,1fr))) — there, the select's
     content-driven width could still push past its 62% cap and spill over
     the slot's edge, unlike the video row above which never had this
     problem. Scoped to just the char slots: label on top, select full-width
     below, both centered, so it can't overflow regardless of column width. */
  .musecombo-v2-char-slot .musecombo-v2-mini-row {
    flex-direction: column; align-items: center; justify-content: flex-start; gap: 4px;
  }
  .musecombo-v2-char-slot .musecombo-v2-mini-select { max-width: 100%; width: 100%; text-align: center; }

  .musecombo-v2-dialogue-speakers { padding-top: 5px; }
  .musecombo-v2-dialogue-speaker-row { display:flex; align-items:center; gap:6px; padding:4px 7px; flex-wrap:wrap; border-top:1px solid #24242d; }
  .musecombo-v2-dialogue-line { min-width:160px; max-width:48%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#d4d4dc; font-size:12.5px; }
  .musecombo-v2-dialogue-speaker-label { font-size:12.5px; color:#8a8a98; white-space:nowrap; }
  .musecombo-v2-speaker-chip {
    background: #101015; border: 1px solid #2e2e3a; border-radius: 20px; color: #8a8a98;
    font-size: 12px; padding: 3px 10px; cursor: pointer; transition: all 0.15s ease;
  }
  .musecombo-v2-speaker-chip:hover { border-color: #4F8EF7; color: #d4d4dc; }
  .musecombo-v2-speaker-chip-active { background: #4F8EF722; border-color: #4F8EF7; color: #cfe0ff; }
  .musecombo-v2-cut-video-guide {
    margin: 0 7px 8px 7px; padding: 6px 8px; border-radius: 7px;
    border: 1px solid #2a5149; background: #0d1d1c;
  }
  .musecombo-v2-cut-video-guide .musecombo-v2-mini-row { margin-top: 3px; }
  .musecombo-v2-cut-video-guide-note { margin-top: 5px; color: #6f9f98; font-size: 11.5px; line-height: 1.35; }
  .musecombo-v2-cut-lock-badge {
    display: inline-flex; align-items: center; margin-left: 7px; padding: 1px 6px;
    border: 1px solid #54c8b0; border-radius: 10px; color: #8be4d2;
    background: #12332e; font-size: 10.5px; line-height: 1.4; vertical-align: middle;
  }
  .musecombo-v2-cut-block.musecombo-v2-reference-locked { box-shadow: inset 0 0 0 1px rgba(84,200,176,.45); }

  .musecombo-v2-lang-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 0; border-top: 1px solid #22222b; }
  .musecombo-v2-lang-row label { font-size: 12px; color: #9a9aa8; white-space: nowrap; }
  .musecombo-v2-lang-input {
    background: #101015; border: 1px solid #2e2e3a; border-radius: 6px; color: #e4e4ea;
    font-size: 12px; padding: 4px 6px; max-width: 62%; box-sizing: border-box;
  }

  /* 2026 UI refresh ------------------------------------------------------- */
  .musecombo-v2-root {
    --musecombo-v2-bg: linear-gradient(180deg, #10141c 0%, #0a0c12 100%);
    --musecombo-v2-panel: #111824;
    --musecombo-v2-panel-2: #151d2a;
    --musecombo-v2-border: #2b374b;
    --musecombo-v2-muted: #8994a8;
    gap: 12px; padding: 12px;
    background: var(--musecombo-v2-bg);
    border-color: #303b50; border-radius: 14px;
    box-shadow: 0 18px 55px rgba(0,0,0,.32);
  }
  .musecombo-v2-app-header {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    min-height: 42px; padding: 2px 6px 8px; border-bottom: 1px solid #253044;
  }
  .musecombo-v2-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .musecombo-v2-brand-mark {
    display: grid; place-items: center; width: 40px; height: 40px; flex: 0 0 40px;
    border-radius: 8px; color: #e9ddff; font-size: 18px; overflow: hidden;
    background: #0f042e; box-shadow: 0 0 20px rgba(45,15,90,.5);
  }
  .musecombo-v2-brand-title { color: #f4f1fa; font-size: 17px; font-weight: 750; letter-spacing: -.01em; }
  .musecombo-v2-header-status { color: #c985ef; font-size: 11.5px; text-align: right; }

  .musecombo-v2-boxes-row.musecombo-v2-settings-grid {
    display: grid; grid-template-columns: repeat(4, minmax(190px, 1fr)); gap: 10px;
  }
  .musecombo-v2-box {
    min-width: 0; background: linear-gradient(145deg, rgba(22,30,43,.98), rgba(14,21,32,.98));
    border: 1px solid var(--musecombo-v2-border); border-top-width: 1px; border-radius: 10px;
    padding: 10px 12px;
  }
  .musecombo-v2-settings-grid .musecombo-v2-box { position: relative; overflow: hidden; }
  .musecombo-v2-settings-grid .musecombo-v2-box::before {
    content: ""; position: absolute; inset: 0 0 auto; height: 42px; pointer-events: none;
    background: linear-gradient(90deg, var(--musecombo-v2-accent-soft), transparent 85%);
  }
  .musecombo-v2-box-generation { --musecombo-v2-accent: #9b79ee; --musecombo-v2-accent-soft: rgba(112,78,187,.32); border-color: #64519a; }
  .musecombo-v2-box-resolution { --musecombo-v2-accent: #58ddd4; --musecombo-v2-accent-soft: rgba(27,142,137,.28); border-color: #287a78; }
  .musecombo-v2-box-sampling { --musecombo-v2-accent: #f3a536; --musecombo-v2-accent-soft: rgba(180,96,24,.30); border-color: #8c5b25; }
  .musecombo-v2-box-reference { --musecombo-v2-accent: #ed6da8; --musecombo-v2-accent-soft: rgba(166,48,104,.30); border-color: #834568; }
  .musecombo-v2-box-analyze {
    --musecombo-v2-accent: #c985ef; --musecombo-v2-accent-soft: rgba(140,80,190,.28); border-color: #7a4f96;
    display: flex; flex-direction: column; gap: 6px;
  }
  .musecombo-v2-settings-grid .musecombo-v2-box-analyze { grid-column: 1 / -1; }
  .musecombo-v2-box-title {
    position: relative; min-height: 24px; display: flex; align-items: center; gap: 8px;
    color: var(--musecombo-v2-accent, #a9b4c8); font-size: 12px; letter-spacing: .055em;
  }
  .musecombo-v2-title-index {
    display: inline-grid; place-items: center; width: 24px; height: 24px;
    border-radius: 5px; color: #fff; background: var(--musecombo-v2-accent, #6d778a);
    font-size: 11px; font-weight: 800; letter-spacing: 0;
  }
  .musecombo-v2-box-row { position: relative; min-height: 28px; border-top-color: rgba(255,255,255,.045); }
  .musecombo-v2-box-row label { color: #d8dce5; }
  .musecombo-v2-box-select, .musecombo-v2-box-number, .musecombo-v2-lang-input, .musecombo-v2-mini-select {
    background: rgba(7,12,20,.55); border-color: #2b3748; min-height: 28px;
  }
  .musecombo-v2-box-checkbox { appearance: none; width: 30px; height: 17px; border-radius: 20px;
    background: #3a4351; position: relative; transition: .16s ease; }
  .musecombo-v2-box-checkbox::after { content: ""; position: absolute; width: 13px; height: 13px;
    left: 2px; top: 2px; border-radius: 50%; background: #e8edf5; transition: .16s ease; }
  .musecombo-v2-box-checkbox:checked { background: #c34483; }
  .musecombo-v2-box-checkbox:checked::after { transform: translateX(13px); }

  .musecombo-v2-section-shell, .musecombo-v2-reference-workspace {
    background: linear-gradient(145deg, rgba(17,24,36,.96), rgba(10,17,27,.98));
    border: 1px solid #334056; border-radius: 10px; padding: 10px; box-sizing: border-box;
  }
  .musecombo-v2-section-title { color: #7bdbe0; margin: 0; min-height: 30px; font-size: 12px; }
  .musecombo-v2-section-title .musecombo-v2-badge { background: rgba(243,165,54,.13); color: #e9ae51; }
  .musecombo-v2-chunks-wrap { gap: 12px; }
  .musecombo-v2-chunk-section { border-color: #ffffff; background: var(--musecombo-v2-bg); padding: 10px; }
  .musecombo-v2-chunk-heading { color: #ffffff; }

  .musecombo-v2-chunk-style-wrap { display:flex; flex-direction:column; gap:10px; min-width:0; }
  /* Soundscape & Music box is hidden on this node — Overall Style is the
     wrap's only card now, so stretch it (and its textarea) to fill the same
     height as the Now Generating/Chunk Preview column beside it. */
  .musecombo-v2-creative-style-fill { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
  .musecombo-v2-creative-style-fill .musecombo-v2-style-input { flex: 1 1 auto; min-height: 0 !important; }
  .musecombo-v2-creative-card {
    min-width: 0; border: 1px solid #285c83; border-radius: 9px; padding: 9px 10px;
    background: linear-gradient(145deg, rgba(18,34,52,.92), rgba(12,22,34,.88));
  }
  .musecombo-v2-creative-card.musecombo-v2-creative-sound { border-color: #287877; background: linear-gradient(145deg, rgba(13,48,52,.72), rgba(10,27,35,.88)); }
  .musecombo-v2-chunk-top-row {
    display: grid; grid-template-columns: minmax(320px, .72fr) minmax(560px, 1.28fr); gap: 14px;
    align-items: stretch; margin-bottom: 10px;
  }
  .musecombo-v2-creative-card.musecombo-v2-creative-preview {
    border-color: #6a4fa8; background: linear-gradient(145deg, rgba(40,28,58,.85), rgba(22,16,34,.9));
    display: flex; flex-direction: column; gap: 6px; min-width: 0; min-height: 0;
  }
  .musecombo-v2-creative-card.musecombo-v2-preview-split { flex-direction: row; gap: 10px; }
  .musecombo-v2-preview-col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .musecombo-v2-chunk-preview-status { font-size: 11px; color: #b9a8dd; flex: 0 0 auto; }
  .musecombo-v2-live-preview-status { color: #ff9d6f; }
  .musecombo-v2-chunk-preview-video {
    width: 100%; flex: 1 1 auto; min-height: 300px; background: #000; border-radius: 7px;
    border: 1px solid #4a3878; object-fit: contain;
  }
  .musecombo-v2-live-preview-img {
    width: 100%; flex: 1 1 auto; min-height: 300px; background: #000; border-radius: 7px;
    border: 1px solid #4a3878; object-fit: contain;
  }
  .musecombo-v2-creative-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .musecombo-v2-creative-field { min-width: 0; }
  .musecombo-v2-creative-field .musecombo-v2-box-title { color: #80deda; }
  .musecombo-v2-style-input { background: rgba(7,12,20,.45); border-color: #2b3a4e; min-height: 76px !important; font-size: 12.5px; line-height: 1.45; }
  .musecombo-v2-track {
    height: auto; min-height: 240px; align-items: stretch; border-color: #39465a;
    background: #101722; gap: 6px; padding: 6px; box-sizing: border-box; overflow: visible;
  }
  .musecombo-v2-cut-block {
    min-height: 240px; border: 1px solid #3b485a; border-radius: 7px;
    overflow: hidden; background: #17202d;
  }
  .musecombo-v2-cut-text { flex: 1 0 132px; min-height: 132px; font-size: 16px; line-height: 1.5; padding: 4px 10px 10px; }
  .musecombo-v2-cut-video-guide { flex: 0 0 auto; }

  .musecombo-v2-reference-workspace { width: 100%; }
  .musecombo-v2-reference-section {
    width: 100%; box-sizing: border-box; margin-top: 10px; padding: 10px;
    border: 1px solid #277b83; border-radius: 9px;
    background: linear-gradient(145deg, rgba(12,43,49,.68), rgba(10,24,33,.90));
  }
  .musecombo-v2-reference-section:first-child { margin-top: 0; }
  .musecombo-v2-reference-section-title {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    margin-bottom: 8px; color: #69e0df; font-size: 12px; font-weight: 750;
    letter-spacing: .055em; text-transform: uppercase;
  }
  .musecombo-v2-reference-section-subtitle { color: #77869c; font-size: 10.5px; font-weight: 500; text-transform: none; letter-spacing: 0; }
  .musecombo-v2-char-row { grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 7px; }
  .musecombo-v2-char-slot { min-width: 0; min-height: 300px; border-width: 1px; border-style: dashed; background: rgba(10,18,28,.72); }
  .musecombo-v2-char-slot:not(.musecombo-v2-filled) { justify-content: center; }
  .musecombo-v2-char-slot:not(.musecombo-v2-filled) .musecombo-v2-char-placeholder { margin-top: 0; }
  .musecombo-v2-char-preview { position: relative; flex: 1 0 160px; min-height: 160px; height: auto; margin-top: 0; }
  .musecombo-v2-char-preview img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center; }
  .musecombo-v2-av-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 8px; }
  /* [2026-09-18] Only two real elements left in this row (Ref Video 1's own
     slot + its viewer) once audio is hidden — the multi-slot auto-fit grid
     above was sized for up to 5 items and leaves empty unused track space
     with just two, rather than actually stretching them to fill the row.
     !important since this row already matches the grid rule above at equal
     selector specificity and needs to win regardless of source order. */
  /* [2026-09-18] Corrected: the base rule's flex-wrap:wrap (line 357) was
     still in effect since this override never touched that property, so
     the slot + viewer wrapped onto two rows instead of sitting side by
     side in two columns. min-height was also too tall. Fixed: nowrap, a
     sane column height, and min-width:0 on the viewer so a flex item's
     content size can't force a wrap. */
  /* [2026-09-18] Equal-width columns (flex:1 1 0 on both), and align-items
     flex-start instead of stretch — stretching the slot to match a fixed
     row height squeezed its filename/toggle/two textareas/buttons into
     that height and clipped the lower ones (their drag handles included),
     since the slot has more content than the viewer. The viewer alone
     gets the fixed 300px height (matching the reference character slots);
     the slot is left free to size to its own natural content height. */
  .musecombo-v2-av-row.musecombo-v2-av-row-video-only { display: flex !important; flex-wrap: nowrap; align-items: flex-start; }
  .musecombo-v2-av-row-video-only > .musecombo-v2-av-slot-video { flex: 1 1 0; min-width: 0; }
  .musecombo-v2-av-row-video-only > .musecombo-v2-video-viewer { flex: 1 1 0; min-width: 0; height: 300px; }
  .musecombo-v2-av-slot { width: 100%; min-width: 0; min-height: 176px; background: rgba(9,17,27,.64); }
  .musecombo-v2-av-slot-video, .musecombo-v2-av-slot-audio { border-width: 1px; }
  .musecombo-v2-reference-help { margin: 8px 2px 0; color: #708096; font-size: 10.5px; line-height: 1.45; }

  /* Readability pass: designed to remain legible when the graph is viewed from
     a little distance, rather than relying on browser/canvas zoom. */
  .musecombo-v2-root { font-size: 14px; line-height: 1.45; }
  .musecombo-v2-brand-title { font-size: 19px; }
  .musecombo-v2-header-status { font-size: 13px; }
  .musecombo-v2-box-title, .musecombo-v2-section-title, .musecombo-v2-reference-section-title,
  .musecombo-v2-chunk-heading { font-size: 13.5px; }
  .musecombo-v2-box-row label, .musecombo-v2-lang-row label, .musecombo-v2-mini-row label { font-size: 13.5px; }
  .musecombo-v2-box-select, .musecombo-v2-box-number, .musecombo-v2-lang-input,
  .musecombo-v2-mini-select { font-size: 13.5px; }
  .musecombo-v2-style-input, .musecombo-v2-cut-text, .musecombo-v2-desc-input { font-size: 14px; }
  .musecombo-v2-cut-label, .musecombo-v2-av-slot-label { font-size: 13px; }
  .musecombo-v2-track-hint, .musecombo-v2-reference-help, .musecombo-v2-gear-hint,
  .musecombo-v2-reference-section-subtitle { font-size: 12.5px; }
  .musecombo-v2-char-label, .musecombo-v2-char-placeholder, .musecombo-v2-analyze-btn,
  .musecombo-v2-av-placeholder { font-size: 12px; }
  .musecombo-v2-ruler-tick-label { font-size: 13px; }
  .musecombo-v2-cut-label { font-size: 16px; }
  .musecombo-v2-cut-duration-input { width:54px; font-size:15px; }
  .musecombo-v2-dialogue-line, .musecombo-v2-dialogue-speaker-label { font-size:15px; }
  .musecombo-v2-dialogue-speaker-row { gap:8px; padding:7px 10px; }
  .musecombo-v2-speaker-chip { font-size:14.5px; padding:5px 12px; }
  .musecombo-v2-chunk-preview-status { font-size:13px; }

  .musecombo-v2-number-control { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex: 1; min-width: 0; }
  .musecombo-v2-number-control .musecombo-v2-box-number { width: 68px; flex: 0 0 68px; max-width: none; text-align: right; }
  .musecombo-v2-number-control .musecombo-v2-box-select { width: 72px; flex: 0 0 72px; max-width: none; }
  .musecombo-v2-number-control-plain { justify-content: flex-end; }
  .musecombo-v2-number-control-plain .musecombo-v2-box-number,
  .musecombo-v2-number-control-plain .musecombo-v2-box-select {
    flex: 1 1 auto; width: 100%; max-width: 220px; text-align: right; font-weight: 650;
  }

  .musecombo-v2-chunk-section {
    border: 2px solid #ffffff;
    box-shadow: 0 0 0 1px rgba(255,255,255,.14), inset 0 1px 0 rgba(255,255,255,.08);
  }
  .musecombo-v2-chunk-heading { color: #ffffff; font-weight: 850; text-shadow: 0 0 12px rgba(255,255,255,.2); }

  @media (max-width: 980px) {
    .musecombo-v2-boxes-row.musecombo-v2-settings-grid { grid-template-columns: repeat(2, minmax(210px, 1fr)); }
    .musecombo-v2-chunk-style-wrap { grid-template-columns: 1fr; }
    .musecombo-v2-chunk-top-row { grid-template-columns: 1fr; }
    .musecombo-v2-char-row { grid-template-columns: repeat(5, minmax(82px, 1fr)); }
  }
  @media (max-width: 640px) {
    .musecombo-v2-boxes-row.musecombo-v2-settings-grid { grid-template-columns: 1fr; }
    .musecombo-v2-creative-fields, .musecombo-v2-av-row { grid-template-columns: 1fr; }
    .musecombo-v2-char-row { grid-template-columns: repeat(2, minmax(88px, 1fr)); }
    .musecombo-v2-header-status { display: none; }
  }

  .musecombo-v2-main-grid { display: flex; align-items: flex-start; gap: 16px; width: 100%; box-sizing: border-box; }
  .musecombo-v2-left-col {
    display: flex; flex-direction: column; gap: 12px;
    flex: 0 0 33%; max-width: 33%; min-width: 320px; box-sizing: border-box;
  }
  .musecombo-v2-left-col .musecombo-v2-boxes-row.musecombo-v2-settings-grid {
    display: flex; flex-direction: column; gap: 12px; width: 100%;
  }
  .musecombo-v2-left-col .musecombo-v2-box { width: 100%; box-sizing: border-box; }
  .musecombo-v2-left-col .musecombo-v2-box-title { font-size: 16px; min-height: 32px; }
  .musecombo-v2-left-col .musecombo-v2-title-index { width: 28px; height: 28px; font-size: 13px; }
  .musecombo-v2-left-col .musecombo-v2-box-row label { font-size: 15px; }
  .musecombo-v2-left-col .musecombo-v2-box-select, .musecombo-v2-left-col .musecombo-v2-box-number,
  .musecombo-v2-left-col .musecombo-v2-lang-input, .musecombo-v2-left-col .musecombo-v2-mini-select {
    font-size: 15px; min-height: 34px;
  }
  .musecombo-v2-left-col .musecombo-v2-box { padding: 14px 16px; }
  .musecombo-v2-left-col .musecombo-v2-box-checkbox { width: 36px; height: 20px; }
  .musecombo-v2-left-col .musecombo-v2-box-checkbox::after { width: 16px; height: 16px; }
  .musecombo-v2-left-col .musecombo-v2-box-checkbox:checked::after { transform: translateX(16px); }


  .musecombo-v2-right-col { display: flex; flex-direction: column; gap: 10px; flex: 1 1 0%; min-width: 0; box-sizing: border-box; }
  .musecombo-v2-right-col .musecombo-v2-section-title { margin: 0; }
  .musecombo-v2-right-col .musecombo-v2-chunks-wrap { gap: 12px; }

  .musecombo-v2-chunk-collapse-btn {
    width: auto; padding: 11px 22px; font-size: 15px; font-weight: 750; border-radius: 8px;
    color: #d8e8ff; background: #2a4a7a; border: 2px solid #4F8EF7; white-space: nowrap;
  }
  .musecombo-v2-chunk-collapse-btn:hover { color: #fff; background: #3a5f9a; border-color: #6fa8ff; }

  @media (max-width: 900px) {
    .musecombo-v2-main-grid { flex-direction: column; }
    .musecombo-v2-left-col { flex: 1 1 auto; max-width: 100%; }
  }
  `;
  document.head.appendChild(style);
}

// Proven-safe widget hider, ported verbatim from Combo V2's copy of the same
// function (itself copied from LTXInfiniteDirector's muse_director_v2.js).
function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  if (!w.options) w.options = {};
  w.options.hidden = true;

  if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
    w.computeSize = () => [0, -4]; // -4 cancels ComfyUI's hardcoded 4px widget padding
    if (!w._hiddenDrawHooked) {
      w._origDraw = w.hasOwnProperty("draw") ? w.draw : undefined;
      w._hiddenDrawHooked = true;
    }
    w.draw = () => {};
  }

  if (w.element) w.element.style.display = "none";
  if (w.callback) w.callback(w.value);
}

// Reference video/audio clips are real uploaded files (not base64, unlike the small
// character portraits) — same ComfyUI /upload/image endpoint LTX Director's own
// audio/video tracks use (it accepts any file type despite the name).
async function uploadRefFile(file) {
  const body = new FormData();
  body.append("image", file);
  body.append("subfolder", "musedirector");
  const resp = await api.fetchApi("/upload/image", { method: "POST", body });
  if (resp.status !== 200) throw new Error("Upload failed: " + resp.status);
  const data = await resp.json();
  const subfolder = data.subfolder || "";
  return { file: subfolder ? subfolder + "/" + data.name : data.name, fileName: file.name };
}

function comfyViewUrl(entryFile) {
  const idx = entryFile.lastIndexOf("/");
  const subfolder = idx >= 0 ? entryFile.slice(0, idx) : "";
  const name = idx >= 0 ? entryFile.slice(idx + 1) : entryFile;
  return api.apiURL(`/view?filename=${encodeURIComponent(name)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
}

async function urlToB64(url) {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function extractAudioPeaks(file, numPeaks = 120) {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  const channelData = audioBuffer.getChannelData(0);
  const peaks = [];
  const step = Math.max(1, Math.floor(channelData.length / numPeaks));
  for (let i = 0; i < numPeaks; i++) {
    let max = 0;
    for (let j = 0; j < step; j++) {
      const val = Math.abs(channelData[i * step + j] || 0);
      if (val > max) max = val;
    }
    peaks.push(max);
  }
  return { peaks, duration: audioBuffer.duration };
}

class CharacterSheetH3TimelineEditor {
  constructor(node) {
    this.node = node;
    this.timelineDataWidget = node.widgets.find((w) => w.name === "timeline_data");
    this.realWidgets = {};
    for (const name of BOXED_WIDGET_NAMES) {
      const w = node.widgets.find((x) => x.name === name);
      if (w) this.realWidgets[name] = w;
    }
    this.timeline = this._loadState();
    this.container = document.createElement("div");
    this.container.className = "musecombo-v2-root";
    this._executionLayoutHandler = (event) => {
      const id = event.detail?.node_id ?? event.detail?.node;
      if (id == null || String(id) === String(this.node.id)) this._scheduleNodeResize();
    };
    api.addEventListener("execution_error", this._executionLayoutHandler);
    api.addEventListener("execution_interrupted", this._executionLayoutHandler);
    enableCanvasZoomOverDOM(this.container);
    injectStyles();

    // Live per-chunk preview — pushed from Python the moment the (one and
    // only) chunk finishes. Must exist BEFORE build() below: build() renders
    // the chunk card immediately, and _buildChunkPreviewBox writes into this
    // map the moment it runs.
    this._chunkPreviewVideoEls = {};
    // "Now Generating" live sampling preview — one WebP/JPEG frame per step,
    // broadcast natively from this node's own Python (no third-party
    // preview-override node required, no VAE).
    this._liveChunkPreviewImgEls = {};
    this.build();
    this._chunkPreviewHandler = (event) => {
      const detail = event.detail || {};
      if (String(detail.node) !== String(this.node.id)) return;
      const chunkIdx = Number(detail.chunk_index) - 1;
      if (!Number.isInteger(chunkIdx) || chunkIdx < 0) return;
      const chunk = this.timeline.chunks?.[chunkIdx];
      if (chunk) {
        chunk._previewToken = detail.token;
        this.commitChanges();
      }
      this._applyChunkPreview(chunkIdx, detail.token);
    };
    api.addEventListener(_MUSE_CHUNK_PREVIEW_EVENT, this._chunkPreviewHandler);
    this._liveChunkPreviewHandler = (event) => {
      const detail = event.detail || {};
      if (String(detail.node) !== String(this.node.id)) return;
      if (!detail.image) return;
      this._applyLiveChunkPreview(0, detail);
    };
    api.addEventListener(_MUSE_LIVE_PREVIEW_EVENT, this._liveChunkPreviewHandler);
  }

  // Pushes a fresh live sampling frame straight into an already-built chunk
  // card's <img>, without a full re-render. Safe no-op if that chunk's card
  // isn't currently built.
  _applyLiveChunkPreview(chunkIdx, detail) {
    const img = this._liveChunkPreviewImgEls[chunkIdx];
    if (!img) return;
    // Each step sends a short animated WebP (a real multi-frame clip decoded
    // from the video latent) — <img> plays an animated WebP natively, no
    // <video> element needed. mime falls back to jpeg for the rare
    // single-frame case (e.g. a still-image latent with no temporal
    // dimension to animate).
    img.src = `data:${detail.mime || "image/jpeg"};base64,${detail.image}`;
    img.hidden = false;
    const status = img.previousSibling;
    if (status?.classList?.contains("musecombo-v2-live-preview-status")) {
      const total = detail.total ? ` / ${detail.total}` : "";
      status.textContent = `Now Generating — step ${detail.step || "?"}${total}`;
    }
  }

  // Pushes a fresh token straight into the already-built chunk card's
  // <video> without a full renderTimeline() — the DOM element persists
  // across unrelated edits elsewhere.
  _applyChunkPreview(chunkIdx, token) {
    const video = this._chunkPreviewVideoEls[chunkIdx];
    if (!video || !token) return;
    video.src = api.apiURL(`${_MUSE_VIEW_ROUTE}?token=${encodeURIComponent(token)}`);
    video.load();
    const status = video.previousSibling;
    if (status?.classList?.contains("musecombo-v2-chunk-preview-status")) {
      status.textContent = "Rendered";
    }
  }

  // [2026-09-18] Root cause, found by reading LiteGraph's own source
  // (LGraphNode.ts, _arrangeWidgets): "In Vue mode, the DOM is the source
  // of truth for node sizing — the ResizeObserver feeds measurements back
  // to the layout store. Allowing LiteGraph to also call setSize() here
  // creates an infinite feedback loop." This ComfyUI build runs in Vue
  // nodes mode (already checked elsewhere in this file, see hideWidget),
  // which has its OWN built-in DOM-size sync for exactly this reason. Every
  // manual setSize() call this class made was a second, competing writer
  // fighting that native one — the "two layers" (the node's actual drawn
  // rectangle staying tall, the DOM content correctly shrinking on top of
  // it) was that conflict, not a timing bug to debounce harder. In Vue
  // mode we now do nothing and let the framework own it, exactly as
  // designed; the manual path stays only as a fallback for a non-Vue-mode
  // LiteGraph, where nothing else will ever resize this DOM widget's node.
  _attachAutoResize(timelineWidget) {
    this.timelineWidget = timelineWidget;
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
    if (window.LiteGraph?.vueNodesMode) return;
    this._resizeDebounce = setTimeout(() => {
      this._resizeDebounce = null;
      this._resizeOnce();
      if (typeof ResizeObserver !== "undefined" && this.container) {
        this._resizeObserver = new ResizeObserver(() => this._scheduleNodeResize());
        this._resizeObserver.observe(this.container);
      }
    }, 300);
  }

  _resizeOnce() {
    if (window.LiteGraph?.vueNodesMode) return;
    if (!this.timelineWidget || !this.node?.setSize || !this.container) return;
    const contentHeight = Math.max(this.container.offsetHeight || 0, this.container.scrollHeight || 0, 640);
    // Cache this real, settled measurement for computeSize (see onNodeCreated)
    // to echo back — decoupled from this.size so it can't feed LiteGraph's
    // own grow-only arrange loop, only updated here, on an actual measurement.
    this._cachedContentHeight = contentHeight;
    const width = Math.max(this.node.size?.[0] || 1480, 1480);
    const height = Math.ceil(contentHeight + 70);
    if (!this.node.size || Math.abs(this.node.size[1] - height) > 2 || this.node.size[0] !== width) {
      this.node.setSize([width, height]);
      this.node.setDirtyCanvas?.(true, true);
    }
  }

  // Debounced entry point for the live observer (content genuinely changing
  // during editing) — waits for ticks to stop for a quiet period rather than
  // reacting to every one, so it can't chase an external animation either.
  // No-op in Vue nodes mode, same as _resizeOnce.
  _scheduleNodeResize() {
    if (window.LiteGraph?.vueNodesMode) return;
    if (!this.timelineWidget || !this.node?.setSize) return;
    if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
    this._resizeDebounce = setTimeout(() => {
      this._resizeDebounce = null;
      this._resizeOnce();
    }, 250);
  }

  // [2026-09-17] Substantially simplified versus the source node's
  // _loadState — this is a brand-new node with no legacy saved workflows to
  // migrate, and no mode/streaming/Prompt-Gen/Seed-Hunt fields to default.
  // Still defensive against a malformed/misaligned timeline_data value, same
  // reasoning as the source (a widgets_values positional mismatch on a
  // future widget addition could otherwise hand this a bare number/string).
  _loadState() {
    let parsed = {};
    try {
      parsed = JSON.parse(this.timelineDataWidget?.value || "{}");
    } catch (e) {
      parsed = {};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn("[MuseCharacterSheetH3] timeline_data wasn't a valid object (got:", parsed,
        ") — resetting this node to a blank timeline.");
      parsed = {};
    }
    if (!Array.isArray(parsed.characters)) parsed.characters = [];
    // Exactly one chunk, always — no Add/Delete Chunk here.
    if (!Array.isArray(parsed.chunks) || parsed.chunks.length === 0) {
      parsed.chunks = [this._blankChunk()];
    }
    parsed.chunks = [parsed.chunks[0]];
    const chunk = parsed.chunks[0];
    if (!Array.isArray(chunk.segments) || chunk.segments.length === 0) chunk.segments = [{ prompt: "", weight: 1 }];
    chunk.segments.forEach((s) => {
      if (!s.weight) s.weight = 1;
      const videoRefSlot = s.videoRefSlot === null || s.videoRefSlot === undefined || s.videoRefSlot === ""
        ? NaN : Number(s.videoRefSlot);
      s.videoRefSlot = Number.isInteger(videoRefSlot) && videoRefSlot >= 0 && videoRefSlot < REF_AV_SLOTS
        ? videoRefSlot : null;
      if (!["motion", "camera", "motion_camera"].includes(s.videoRefMode)) s.videoRefMode = "motion";
      if (!["free", "match_ref"].includes(s.videoRefTiming)) s.videoRefTiming = "free";
      const targetCharIdx = s.videoRefTargetCharIdx === null || s.videoRefTargetCharIdx === undefined || s.videoRefTargetCharIdx === ""
        ? NaN : Number(s.videoRefTargetCharIdx);
      s.videoRefTargetCharIdx = Number.isInteger(targetCharIdx)
        && targetCharIdx >= 0 && targetCharIdx < MAX_CHARACTER_SLOTS ? targetCharIdx : null;
    });
    if (typeof chunk.style_line !== "string") chunk.style_line = "";
    if (typeof chunk.overall_soundscape !== "string") chunk.overall_soundscape = "";
    if (typeof chunk.non_diegetic_music !== "string") chunk.non_diegetic_music = "";

    const hasLocations = Object.prototype.hasOwnProperty.call(parsed, "locations");
    if (!Array.isArray(parsed.locations)) parsed.locations = [];
    if (!hasLocations || parsed.locations.length === 0) parsed.locations.push({ chunk: 1 });
    if (!Array.isArray(parsed.refVideos)) parsed.refVideos = [];
    while (parsed.refVideos.length < REF_AV_SLOTS) parsed.refVideos.push(null);
    if (!Array.isArray(parsed.refAudios)) parsed.refAudios = [];
    while (parsed.refAudios.length < REF_AV_SLOTS) parsed.refAudios.push(null);
    // dialogue_language feeds every <d>[Language]...</d> dialogue tag.
    if (typeof parsed.dialogue_language !== "string" || !parsed.dialogue_language) parsed.dialogue_language = "English";
    return parsed;
  }

  commitChanges() {
    if (this.timelineDataWidget) {
      this.timelineDataWidget.value = JSON.stringify(this.timeline);
      // Keep onConfigure's no-op-rebuild check in sync with live edits too —
      // otherwise any edit made since the last onConfigure would make the
      // *next* one (e.g. a plain tab switch) see a "changed" value and
      // trigger an unnecessary full rebuild, even though the live DOM
      // already reflects this exact edit.
      this._lastConfiguredRawTimelineData = this.timelineDataWidget.value;
    }
    this.node.setDirtyCanvas(true, true);
  }

  // ── Save / Load timeline as a standalone JSON file ──────────────────────
  _downloadTimelineJSON(filename) {
    const timelineOnly = structuredClone(this.timeline);
    const blob = new Blob([JSON.stringify(timelineOnly, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.endsWith(".json") ? filename : filename + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async _saveTimelineWithPicker(suggestedName) {
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: "JSON file", accept: { "application/json": [".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(this.timeline, null, 2));
        await writable.close();
        return;
      } catch (err) {
        if (err.name === "AbortError") return;
        console.error("[MuseCharacterSheetH3] Save dialog failed, falling back to direct download", err);
      }
    }
    this._downloadTimelineJSON(suggestedName);
  }

  saveTimeline() {
    this._saveTimelineWithPicker("muse_character_sheet_h3_timeline.json");
  }

  saveTimelineAs() {
    if (window.showSaveFilePicker) {
      this._saveTimelineWithPicker("muse_character_sheet_h3_timeline.json");
      return;
    }
    const name = prompt("Save timeline as:", "muse_character_sheet_h3_timeline.json");
    if (name) this._downloadTimelineJSON(name);
  }

  loadTimelineFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("File doesn't contain a valid timeline object.");
        }
        this.timelineDataWidget.value = JSON.stringify(parsed);
        this.timeline = this._loadState();
        this.commitChanges();
        this.build();
      } catch (err) {
        console.error("[MuseCharacterSheetH3] Failed to load timeline file", err);
        alert("Couldn't load that file as a timeline — see console for details.");
      }
    };
    input.click();
  }

  build() {
    this.container.innerHTML = "";

    const appHeader = document.createElement("div");
    appHeader.className = "musecombo-v2-app-header";
    const brand = document.createElement("div");
    brand.className = "musecombo-v2-brand";
    brand.innerHTML = `<span class="musecombo-v2-brand-mark">&#127917;</span><span class="musecombo-v2-brand-title">Muse Character Sheet H3</span>`;
    appHeader.appendChild(brand);
    const headerStatus = document.createElement("div");
    headerStatus.className = "musecombo-v2-header-status";
    headerStatus.textContent = "Reference (Omni)  •  Up to 8 images + Location, 3 videos, 3 audio clips";
    appHeader.appendChild(headerStatus);
    this.container.appendChild(appHeader);

    const mainGrid = document.createElement("div");
    mainGrid.className = "musecombo-v2-main-grid";

    const leftCol = document.createElement("div");
    leftCol.className = "musecombo-v2-left-col";
    leftCol.appendChild(this._buildSettingsBoxes());

    mainGrid.appendChild(leftCol);

    const rightCol = document.createElement("div");
    rightCol.className = "musecombo-v2-right-col";

    const cutsTitle = document.createElement("div");
    cutsTitle.className = "musecombo-v2-section-title";
    cutsTitle.innerHTML = `&#9986;&nbsp; Timeline / Cuts <span class="musecombo-v2-badge">drag edges to time, drag blocks to reorder</span>`;
    rightCol.appendChild(cutsTitle);

    this.chunksWrap = document.createElement("div");
    this.chunksWrap.className = "musecombo-v2-chunks-wrap";
    rightCol.appendChild(this.chunksWrap);

    mainGrid.appendChild(rightCol);
    this.container.appendChild(mainGrid);

    this.renderTimeline();
    this._scheduleNodeResize();
  }

  // ── Boxed settings panel (re-skins the real native widgets) ────────────────
  _buildSettingsBoxes() {
    const row = document.createElement("div");
    row.className = "musecombo-v2-boxes-row musecombo-v2-settings-grid";

    row.appendChild(this._buildGenerationBox());
    row.appendChild(this._buildResolutionBox());
    row.appendChild(this._buildSamplingBox());
    row.appendChild(this._buildReferenceBox());
    row.appendChild(this._buildRefModBox());
    row.appendChild(this._buildTimelineBox());
    return row;
  }

  // [2026-09-18] Its own card, not a Sampling sub-section — confirmed with
  // Andy directly after building it the wrong way once already. Off by
  // default (use_refmod=false); with nothing wired into refmod_bundle it has
  // zero effect on generation.
  _buildRefModBox() {
    const box = document.createElement("div");
    box.className = "musecombo-v2-box musecombo-v2-box-refmod";

    const title = document.createElement("div");
    title.className = "musecombo-v2-box-title";
    title.innerHTML = `<span class="musecombo-v2-title-index">05</span><span>RefMod Override</span>`;
    box.appendChild(title);

    const hint = document.createElement("div");
    hint.className = "musecombo-v2-reference-help";
    hint.style.marginTop = "0";
    hint.textContent = "Optional, off by default. Needs ComfyUI-MiniMaxH3Mod installed and a bundle "
      + "wired into the refmod_bundle input (Load H3 RefMods' 'mods' output). Runs alongside the normal "
      + "Ref 1-8 image conditioning below, not instead of it — but replaces Subject 1's whole prompt "
      + "definition with the mod's own name plus the description typed below.";
    box.appendChild(hint);

    if (this.realWidgets.use_refmod) {
      box.appendChild(this._boolRow("Enable RefMod Override", this.realWidgets.use_refmod,
        () => this.renderReferences()));
    }
    if (this.realWidgets.refmod_retention) {
      box.appendChild(this._numberRow("RefMod Retention", this.realWidgets.refmod_retention));
    }
    if (this.realWidgets.refmod_description) {
      const descLabel = document.createElement("div");
      descLabel.className = "musecombo-v2-box-title";
      descLabel.style.cssText = "margin-top:8px;font-size:11px;opacity:0.75;";
      descLabel.textContent = "Description (outfit / styling for this render)";
      box.appendChild(descLabel);

      const widget = this.realWidgets.refmod_description;
      const textarea = document.createElement("textarea");
      textarea.className = "musecombo-v2-style-input";
      textarea.style.minHeight = "52px";
      textarea.placeholder = "e.g. wearing a black leather jacket over a white top, hair down and "
        + "loose. The mod only carries identity (face/hair color) — not wardrobe. To borrow an outfit "
        + "from an uploaded Ref image, just write plain English, e.g. 'wearing the outfit from REF 2' — "
        + "same as any CUT/shot box, no brackets needed, it resolves automatically.";
      textarea.value = widget.value || "";
      textarea.addEventListener("input", () => {
        widget.value = textarea.value;
        if (widget.callback) widget.callback(widget.value);
        this.node.setDirtyCanvas(true, true);
      });
      box.appendChild(textarea);
    }

    // [2026-09-18] Full Apply H3 RefMod parameter set, exposed rather than
    // hardcoded — this node calls that node's own execute() classmethod
    // directly with these values, so every row here maps 1:1 onto a widget
    // on the real "Apply H3 RefMod" node (confirmed against a live screenshot
    // of it). Grouped under its own divider so the common controls above
    // (Enable / Retention / Description) stay uncluttered.
    const advDivider = document.createElement("div");
    advDivider.className = "musecombo-v2-box-title";
    advDivider.style.cssText = "margin-top:12px;font-size:11px;opacity:0.75;";
    advDivider.textContent = "Advanced (matches Apply H3 RefMod's own widgets)";
    box.appendChild(advDivider);

    if (this.realWidgets.refmod_override) {
      box.appendChild(this._boolRow("Override (use mod's saved config)", this.realWidgets.refmod_override));
    }
    if (this.realWidgets.refmod_curve_direction) {
      box.appendChild(this._selectRow("Curve Direction", this.realWidgets.refmod_curve_direction));
    }
    if (this.realWidgets.refmod_curve_shape) {
      box.appendChild(this._selectRow("Curve Shape", this.realWidgets.refmod_curve_shape));
    }
    if (this.realWidgets.refmod_curve_value) {
      box.appendChild(this._numberRow("Curve Value", this.realWidgets.refmod_curve_value));
    }
    if (this.realWidgets.refmod_scramble_seed) {
      box.appendChild(this._numberRow("Scramble Seed", this.realWidgets.refmod_scramble_seed, null, 1));
    }
    if (this.realWidgets.refmod_scramble_mode) {
      box.appendChild(this._selectRow("Scramble Mode", this.realWidgets.refmod_scramble_mode));
    }
    if (this.realWidgets.refmod_scramble_keep) {
      box.appendChild(this._numberRow("Scramble Keep", this.realWidgets.refmod_scramble_keep, null, 1));
    }
    if (this.realWidgets.refmod_max_total_tokens) {
      box.appendChild(this._numberRow("Max Total Tokens", this.realWidgets.refmod_max_total_tokens, null, 1));
    }
    if (this.realWidgets.refmod_graph_preset) {
      box.appendChild(this._refModStringRow("Graph Preset (name, blank = none)", this.realWidgets.refmod_graph_preset));
    }
    if (this.realWidgets.refmod_save_preset_as) {
      box.appendChild(this._refModStringRow("Save Preset As (blank = skip)", this.realWidgets.refmod_save_preset_as));
    }
    return box;
  }

  // Plain single-line text input bound to a real STRING widget — same wrapper
  // _numberRow/_seedRow use, so it sits sized/positioned like every other row.
  _refModStringRow(labelText, widget) {
    const rowEl = document.createElement("div");
    rowEl.className = "musecombo-v2-box-row";
    const label = document.createElement("label");
    label.textContent = labelText;
    rowEl.appendChild(label);

    const controls = document.createElement("div");
    controls.className = "musecombo-v2-number-control musecombo-v2-number-control-plain";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "musecombo-v2-box-number";
    input.value = widget.value || "";
    input.addEventListener("input", () => {
      widget.value = input.value;
      if (widget.callback) widget.callback(widget.value);
      this.node.setDirtyCanvas(true, true);
    });
    controls.appendChild(input);
    rowEl.appendChild(controls);
    return rowEl;
  }

  _buildGenerationBox() {
    const box = document.createElement("div");
    box.className = "musecombo-v2-box musecombo-v2-box-generation";

    const title = document.createElement("div");
    title.className = "musecombo-v2-box-title";
    title.innerHTML = `<span class="musecombo-v2-title-index">01</span><span>Generation</span>`;
    box.appendChild(title);

    if (this.realWidgets.duration_seconds) {
      // [2026-09-18] widget.options.step read back as 5 here, not the 0.5
      // set in Python — same x10 legacy encoding already worked around for
      // INT widgets below, evidently also hitting this FLOAT one. Passing
      // the real step explicitly (like the Steps/First-Pass Steps rows do)
      // bypasses it instead of trusting options.step.
      box.appendChild(this._numberRow("Length (s)", this.realWidgets.duration_seconds, () => {
        this.renderTimeline(); this.renderReferences();
      }, 0.5));
    }

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "musecombo-v2-analyze-btn musecombo-v2-clear-chunks-btn";
    clearBtn.style.width = "100%";
    clearBtn.style.marginTop = "8px";
    clearBtn.textContent = "Clear CUTs / Reset Timeline";
    clearBtn.title = "Wipes every CUT, prompt, style, soundscape and music back to a single blank CUT — like a brand-new node's timeline. Length and every reference (Ref 1-8 images, Location, reference video/audio) are untouched.";
    clearBtn.addEventListener("click", () => this._resetChunk());
    box.appendChild(clearBtn);

    return box;
  }

  // Wipes the single chunk's CUTs/prompts/style/soundscape/music back to one
  // blank starter CUT (the same shape _blankChunk gives a brand-new node).
  // Every reference — Ref 1-8 images, Location, reference video/audio and
  // their descriptions — lives outside timeline.chunks entirely and is
  // untouched by this.
  _resetChunk() {
    const chunk = this.timeline.chunks[0];
    const hasContent = chunk.segments?.some((s) => (s.prompt || "").trim())
      || (chunk.style_line || "").trim()
      || (chunk.overall_soundscape || "").trim()
      || (chunk.non_diegetic_music || "").trim();
    if (hasContent && !confirm(
      "Clear every CUT, prompt, style, soundscape and music back to a single blank CUT? "
      + "Reference images, video and audio are left untouched. This cannot be undone."
    )) {
      return;
    }
    this.timeline.chunks[0] = this._blankChunk();
    this.commitChanges();
    this.renderTimeline();
    this.renderReferences();
  }

  _buildResolutionBox() {
    const box = document.createElement("div");
    box.className = "musecombo-v2-box musecombo-v2-box-resolution";

    const title = document.createElement("div");
    title.className = "musecombo-v2-box-title";
    title.innerHTML = `<span class="musecombo-v2-title-index">02</span><span>Resolution</span>`;
    box.appendChild(title);

    if (this.realWidgets.aspect_ratio) box.appendChild(this._selectRow("Aspect Ratio", this.realWidgets.aspect_ratio));
    if (this.realWidgets.megapixels) box.appendChild(this._discreteNumberRow("Megapixels", this.realWidgets.megapixels, SUPPORTED_MEGAPIXELS));
    if (this.realWidgets.multiple) box.appendChild(this._numberRow("Multiple Of", this.realWidgets.multiple));
    return box;
  }

  _buildSamplingBox() {
    const box = document.createElement("div");
    box.className = "musecombo-v2-box musecombo-v2-box-sampling";

    const title = document.createElement("div");
    title.className = "musecombo-v2-box-title";
    title.innerHTML = `<span class="musecombo-v2-title-index">03</span><span>Sampling</span>`;
    box.appendChild(title);

    if (this.realWidgets.sampler_name) box.appendChild(this._selectRow("Sampler", this.realWidgets.sampler_name));
    if (this.realWidgets.scheduler) box.appendChild(this._selectRow("Scheduler", this.realWidgets.scheduler));
    if (this.realWidgets.steps) box.appendChild(this._numberRow("Steps", this.realWidgets.steps, undefined, 1));
    if (this.realWidgets.seed) box.appendChild(this._seedRow(this.realWidgets.seed));
    if (this.realWidgets.control_after_generate) box.appendChild(this._selectRow("After Generate", this.realWidgets.control_after_generate));
    if (this.realWidgets.use_prompt_override) box.appendChild(this._boolRow("Prompt Override (from socket)", this.realWidgets.use_prompt_override));

    if (this.realWidgets.two_stage_sampling) {
      const twoStageDivider = document.createElement("div");
      twoStageDivider.className = "musecombo-v2-box-title";
      twoStageDivider.style.cssText = "margin-top:10px;font-size:11px;opacity:0.75;";
      twoStageDivider.textContent = "Two-Stage Sampling (experimental)";
      box.appendChild(twoStageDivider);
      box.appendChild(this._boolRow("Enable Two-Stage Sampling", this.realWidgets.two_stage_sampling));
      if (this.realWidgets.two_stage_first_pass_steps) {
        box.appendChild(this._numberRow("First-Pass Steps", this.realWidgets.two_stage_first_pass_steps, undefined, 1));
      }
      if (this.realWidgets.two_stage_latent_upscale_model) {
        box.appendChild(this._selectRow("Upscale Model", this.realWidgets.two_stage_latent_upscale_model));
      }
      if (this.realWidgets.two_stage_target_megapixels) {
        // Same fixed option set as the main "Resolution" megapixels dropdown
        // (SUPPORTED_MEGAPIXELS) — not a free-typed number, per Andy's request.
        box.appendChild(this._discreteNumberRow("Target Megapixels", this.realWidgets.two_stage_target_megapixels, SUPPORTED_MEGAPIXELS));
      }
      if (this.realWidgets.two_stage_enable_temporal_chunking) {
        box.appendChild(this._boolRow("Upscale: Temporal Chunking", this.realWidgets.two_stage_enable_temporal_chunking));
      }
    }
    return box;
  }

  _buildReferenceBox() {
    this.refBox = document.createElement("div");
    this.refBox.className = "musecombo-v2-box musecombo-v2-box-reference";

    const title = document.createElement("div");
    title.className = "musecombo-v2-box-title";
    title.innerHTML = `<span class="musecombo-v2-title-index">04</span><span>Image Settings</span>`;
    this.refBox.appendChild(title);

    if (this.realWidgets.ref_image_size) {
      this.refBox.appendChild(this._selectRow("Ref Image Size", this.realWidgets.ref_image_size));
    }
    this.refBox.appendChild(this._dialogueLanguageRow());
    return this.refBox;
  }

  _buildTimelineBox() {
    const panel = document.createElement("div");
    panel.className = "musecombo-v2-box musecombo-v2-box-analyze";

    const boxTitle = document.createElement("div");
    boxTitle.className = "musecombo-v2-box-title";
    boxTitle.innerHTML = `<span class="musecombo-v2-title-index">06</span><span>Timeline &amp; Analyze</span>`;
    panel.appendChild(boxTitle);

    const fileBtnRow1 = document.createElement("div");
    fileBtnRow1.style.display = "flex";
    fileBtnRow1.style.gap = "6px";
    const saveBtn = document.createElement("button");
    saveBtn.className = "musecombo-v2-analyze-btn";
    saveBtn.style.width = "auto";
    saveBtn.style.flex = "1";
    saveBtn.textContent = "Save Timeline";
    saveBtn.addEventListener("click", () => this.saveTimeline());
    const saveAsBtn = document.createElement("button");
    saveAsBtn.className = "musecombo-v2-analyze-btn";
    saveAsBtn.style.width = "auto";
    saveAsBtn.style.flex = "1";
    saveAsBtn.textContent = "Save Timeline As";
    saveAsBtn.addEventListener("click", () => this.saveTimelineAs());
    const loadBtn = document.createElement("button");
    loadBtn.className = "musecombo-v2-analyze-btn";
    loadBtn.style.width = "auto";
    loadBtn.style.flex = "1";
    loadBtn.textContent = "Load Timeline";
    loadBtn.addEventListener("click", () => this.loadTimelineFile());
    fileBtnRow1.appendChild(saveBtn);
    fileBtnRow1.appendChild(saveAsBtn);
    fileBtnRow1.appendChild(loadBtn);
    panel.appendChild(fileBtnRow1);

    panel.appendChild(this._miniSelectRow(
      "Display Mode",
      this.timeline.display_mode || "seconds",
      [{ value: "seconds", label: "Seconds" }, { value: "frames", label: "Frames" }],
      (v) => { this.timeline.display_mode = v; this.renderTimeline(); },
    ));

    const filenamesRow = document.createElement("div");
    filenamesRow.className = "musecombo-v2-box-row";
    const filenamesLabel = document.createElement("label");
    filenamesLabel.textContent = "Show Filenames";
    filenamesRow.appendChild(filenamesLabel);
    const filenamesCheckbox = document.createElement("input");
    filenamesCheckbox.type = "checkbox";
    filenamesCheckbox.className = "musecombo-v2-box-checkbox";
    filenamesCheckbox.checked = this.timeline.show_filenames !== false;
    filenamesCheckbox.addEventListener("change", () => {
      this.timeline.show_filenames = filenamesCheckbox.checked;
      this.commitChanges();
      this.renderReferences();
    });
    filenamesRow.appendChild(filenamesCheckbox);
    panel.appendChild(filenamesRow);

    const analyzeHeading = document.createElement("div");
    analyzeHeading.className = "musecombo-v2-gear-hint";
    analyzeHeading.style.fontWeight = "700";
    analyzeHeading.style.color = "#9a9aae";
    analyzeHeading.style.marginTop = "4px";
    analyzeHeading.textContent = "ANALYZE BACKEND";
    panel.appendChild(analyzeHeading);

    const providerOptions = [
      { value: "ollama", label: "Ollama (local)" },
      { value: "lmstudio", label: "LM Studio (local)" },
      { value: "gemini", label: "Gemini / Google" },
      { value: "custom", label: "Custom (OpenAI-compatible)" },
      { value: "off", label: "Off / Manual only" },
    ];

    const providerRow = document.createElement("div");
    providerRow.className = "musecombo-v2-box-row";
    const providerLabel = document.createElement("label");
    providerLabel.textContent = "Provider";
    providerRow.appendChild(providerLabel);
    const providerSelect = document.createElement("select");
    providerSelect.className = "musecombo-v2-box-select";
    for (const opt of providerOptions) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      providerSelect.appendChild(o);
    }
    providerSelect.value = this.timeline.analyze_provider || "ollama";
    providerSelect.addEventListener("change", () => {
      this.timeline.analyze_provider = providerSelect.value;
      this.commitChanges();
    });
    providerRow.appendChild(providerSelect);
    panel.appendChild(providerRow);

    const urlRow = document.createElement("div");
    urlRow.className = "musecombo-v2-box-row";
    const urlLabel = document.createElement("label");
    urlLabel.textContent = "Base URL";
    urlRow.appendChild(urlLabel);
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "musecombo-v2-box-number";
    urlInput.style.width = "100%";
    urlInput.placeholder = "blank = provider default";
    urlInput.value = this.timeline.analyze_base_url || "";
    urlInput.addEventListener("change", () => {
      this.timeline.analyze_base_url = urlInput.value.trim();
      this.commitChanges();
    });
    urlRow.appendChild(urlInput);
    panel.appendChild(urlRow);

    const modelRow = document.createElement("div");
    modelRow.className = "musecombo-v2-box-row";
    const modelLabel = document.createElement("label");
    modelLabel.textContent = "Model";
    modelRow.appendChild(modelLabel);
    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.className = "musecombo-v2-box-number";
    modelInput.style.width = "100%";
    modelInput.placeholder = "blank = provider default";
    modelInput.value = this.timeline.analyze_model || "";
    modelInput.addEventListener("change", () => {
      this.timeline.analyze_model = modelInput.value.trim();
      this.commitChanges();
    });
    modelRow.appendChild(modelInput);
    panel.appendChild(modelRow);

    const analyzeHint = document.createElement("div");
    analyzeHint.className = "musecombo-v2-gear-hint";
    analyzeHint.textContent = "Controls the Analyze button on every reference slot. Ollama/LM Studio run locally, no API key needed — but small local models follow detailed instructions less reliably than larger hosted ones. Gemini needs GEMINI_API_KEY set as an environment variable before starting ComfyUI. Custom expects an OpenAI-compatible /chat/completions endpoint.";
    panel.appendChild(analyzeHint);

    return panel;
  }

  _selectRow(labelText, widget, onChange) {
    const rowEl = document.createElement("div");
    rowEl.className = "musecombo-v2-box-row";
    const label = document.createElement("label");
    label.textContent = labelText;
    rowEl.appendChild(label);

    const select = document.createElement("select");
    select.className = "musecombo-v2-box-select";
    let opts = widget.options?.values;
    if (!Array.isArray(opts)) opts = Array.isArray(widget.options) ? widget.options : [];
    (opts || []).forEach((v) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = v;
      if (v === widget.value) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener("change", () => {
      widget.value = select.value;
      if (widget.callback) widget.callback(select.value);
      this.node.setDirtyCanvas(true, true);
      if (onChange) onChange();
    });
    rowEl.appendChild(select);
    return rowEl;
  }

  _numberRow(labelText, widget, onChange, stepOverride) {
    const rowEl = document.createElement("div");
    rowEl.className = "musecombo-v2-box-row";
    const label = document.createElement("label");
    label.textContent = labelText;
    rowEl.appendChild(label);

    const min = widget.options?.min ?? 1;
    const max = widget.options?.max ?? 15;
    // ComfyUI stores options.step in its legacy x10 convention (step:10
    // means "increment by 1") — confirmed on both INT widgets (Steps,
    // First-Pass Steps) and, as of 2026-09-18, the duration_seconds FLOAT
    // widget too (Python step=0.5 read back here as 5). Taking it literally
    // as the HTML <input step> makes the native spinner jump 10x too far.
    // Callers that know their widget's real step pass stepOverride
    // explicitly rather than trusting options.step.
    const step = stepOverride ?? (widget.options?.step ?? 0.5);
    const controls = document.createElement("div");
    controls.className = "musecombo-v2-number-control musecombo-v2-number-control-plain";

    const input = document.createElement("input");
    input.type = "number";
    input.className = "musecombo-v2-box-number";
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = widget.value;

    const commitValue = (value, runLayoutCallback) => {
      let parsed = parseFloat(value);
      if (!Number.isFinite(parsed)) return;
      parsed = Math.min(max, Math.max(min, parsed));
      // [2026-09-18] Snap to this widget's own step grid (relative to min)
      // so the arrows/scroll-wheel always move in clean increments (e.g.
      // Length: 3, 3.5, 4...) even if the stored value predates this step
      // (an older saved workflow) — the native spinner otherwise just adds
      // `step` to whatever off-grid value is already there, producing the
      // "weird numbers" this was reported for.
      const snapped = min + Math.round((parsed - min) / step) * step;
      const decimals = (String(step).split(".")[1] || "").length;
      parsed = Number(snapped.toFixed(decimals));
      widget.value = parsed;
      input.value = parsed;
      if (widget.callback) widget.callback(widget.value);
      this.node.setDirtyCanvas(true, true);
      if (runLayoutCallback && onChange) onChange();
    };
    input.addEventListener("change", () => {
      commitValue(input.value, true);
    });
    controls.appendChild(input);
    rowEl.appendChild(controls);
    return rowEl;
  }

  _discreteNumberRow(labelText, widget, allowedValues, onChange) {
    const values = allowedValues.map(Number);
    const nearestIndex = (raw) => {
      const value = Number(raw);
      let best = 0;
      for (let i = 1; i < values.length; i++) {
        if (Math.abs(values[i] - value) < Math.abs(values[best] - value)) best = i;
      }
      return best;
    };

    const rowEl = document.createElement("div");
    rowEl.className = "musecombo-v2-box-row";
    const label = document.createElement("label");
    label.textContent = labelText;
    rowEl.appendChild(label);

    const controls = document.createElement("div");
    controls.className = "musecombo-v2-number-control musecombo-v2-number-control-plain";

    const select = document.createElement("select");
    select.className = "musecombo-v2-box-select";
    values.forEach((value, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = String(value);
      select.appendChild(option);
    });

    const initialIndex = nearestIndex(widget.value);
    widget.value = values[initialIndex];
    select.value = String(initialIndex);

    const commitIndex = (rawIndex, runLayoutCallback) => {
      const parsedIndex = Number.parseInt(rawIndex, 10);
      const index = Number.isFinite(parsedIndex)
        ? Math.max(0, Math.min(values.length - 1, parsedIndex))
        : 0;
      widget.value = values[index];
      select.value = String(index);
      if (widget.callback) widget.callback(widget.value);
      this.node.setDirtyCanvas(true, true);
      if (runLayoutCallback && onChange) onChange();
    };
    select.addEventListener("change", () => commitIndex(select.value, true));

    controls.appendChild(select);
    rowEl.appendChild(controls);
    return rowEl;
  }

  _boolRow(labelText, widget, onChange) {
    const rowEl = document.createElement("div");
    rowEl.className = "musecombo-v2-box-row";
    const label = document.createElement("label");
    label.textContent = labelText;
    rowEl.appendChild(label);

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "musecombo-v2-box-checkbox";
    input.checked = !!widget.value;
    input.addEventListener("change", () => {
      widget.value = input.checked;
      if (widget.callback) widget.callback(widget.value);
      this.node.setDirtyCanvas(true, true);
      if (onChange) onChange();
    });
    rowEl.appendChild(input);
    return rowEl;
  }

  // Small secondary select bound directly to a timeline_data object field (not a
  // real ComfyUI widget) — used for retention markers, used-for/timing pickers
  // and a couple of node-local display toggles, none of which are node inputs.
  _miniSelectRow(labelText, currentValue, options, onChange) {
    const rowEl = document.createElement("div");
    rowEl.className = "musecombo-v2-mini-row";
    rowEl.addEventListener("click", (e) => e.stopPropagation());
    const label = document.createElement("label");
    label.textContent = labelText;
    rowEl.appendChild(label);

    const select = document.createElement("select");
    select.className = "musecombo-v2-mini-select";
    options.forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === currentValue) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener("change", () => {
      onChange(select.value);
      this.commitChanges();
    });
    rowEl.appendChild(select);
    return rowEl;
  }

  // Feeds every <d>[Language]...</d> dialogue tag in the compiled prompt — lives in
  // timeline_data, not a real widget.
  _dialogueLanguageRow() {
    const rowEl = document.createElement("div");
    rowEl.className = "musecombo-v2-lang-row";
    const label = document.createElement("label");
    label.textContent = "Dialogue Language";
    rowEl.appendChild(label);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "musecombo-v2-lang-input";
    input.value = this.timeline.dialogue_language || "English";
    input.addEventListener("input", () => {
      this.timeline.dialogue_language = input.value || "English";
      this.commitChanges();
    });
    rowEl.appendChild(input);
    return rowEl;
  }

  _seedRow(widget) {
    const rowEl = document.createElement("div");
    rowEl.className = "musecombo-v2-box-row";
    const label = document.createElement("label");
    label.textContent = "Seed";
    rowEl.appendChild(label);

    // Same wrapper _numberRow uses, so this sits sized/positioned exactly
    // like every other numeric row instead of stretching to its own width.
    const controls = document.createElement("div");
    controls.className = "musecombo-v2-number-control musecombo-v2-number-control-plain";

    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.pattern = "[0-9]*";
    input.className = "musecombo-v2-box-number";
    input.value = String(widget.value);
    input.addEventListener("change", () => {
      const digits = input.value.replace(/[^0-9]/g, "");
      input.value = digits || "0";
      widget.value = Number(digits || "0");
      if (widget.callback) widget.callback(widget.value);
      this.node.setDirtyCanvas(true, true);
    });
    controls.appendChild(input);
    rowEl.appendChild(controls);

    // ComfyUI's native "control_after_generate" mutates widget.value directly
    // right after each queued prompt, not through widget.callback. Re-defining
    // the property with our own accessor catches every future write, from any
    // source, and mirrors it into the input live.
    let currentValue = widget.value;
    Object.defineProperty(widget, "value", {
      configurable: true,
      get: () => currentValue,
      set: (v) => {
        currentValue = v;
        if (document.activeElement !== input) input.value = String(v);
      },
    });

    return rowEl;
  }

  // ── Timeline / ruler ─────────────────────────────────────────────────────
  get durationSeconds() {
    return this.realWidgets.duration_seconds ? Number(this.realWidgets.duration_seconds.value) || 10 : 10;
  }

  _formatDuration(seconds) {
    if (this.timeline.display_mode === "frames") {
      return Math.round(seconds * 24) + "f";
    }
    return seconds.toFixed(1) + "s";
  }

  // Deliberately blank style_line/overall_soundscape/non_diegetic_music on a
  // reset rather than leaving stale wording behind unnoticed.
  _blankChunk() {
    return {
      segments: [{ prompt: "", weight: 1 }],
      style_line: "",
      overall_soundscape: "",
      non_diegetic_music: "",
    };
  }

  renderTimeline() {
    this.chunksWrap.innerHTML = "";
    this.tracks = [];
    this.chunksWrap.appendChild(this._buildChunkSection(0, this.durationSeconds));
  }

  _buildChunkSection(chunkIdx, chunkDurSeconds) {
    const chunk = this.timeline.chunks[chunkIdx];
    const wrap = document.createElement("div");
    wrap.className = "musecombo-v2-chunk-section";

    const headingRow = document.createElement("div");
    headingRow.className = "musecombo-v2-chunk-heading-row";
    const heading = document.createElement("div");
    heading.className = "musecombo-v2-chunk-heading";
    const activeSeed = Number(this.realWidgets.seed?.value ?? 0);
    heading.textContent = "SHOT";
    const seedLabel = document.createElement("span");
    seedLabel.className = "musecombo-v2-chunk-seed";
    seedLabel.textContent = `Seed ${activeSeed}`;
    heading.append("  ", seedLabel);
    headingRow.appendChild(heading);

    const actions = document.createElement("div");
    actions.className = "musecombo-v2-chunk-actions";
    // Collapse toggle — persists on the chunk itself so it survives
    // renderTimeline() re-renders triggered by unrelated edits.
    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "musecombo-v2-analyze-btn musecombo-v2-chunk-collapse-btn";
    const setCollapseLabel = () => { collapseBtn.textContent = chunk.collapsed ? "▸ Show" : "▾ Hide"; };
    setCollapseLabel();
    collapseBtn.title = "Show or hide this section's contents";
    collapseBtn.addEventListener("click", () => {
      chunk.collapsed = !chunk.collapsed;
      setCollapseLabel();
      contentWrap.style.display = chunk.collapsed ? "none" : "";
      this.commitChanges();
    });
    actions.appendChild(collapseBtn);
    headingRow.appendChild(actions);
    wrap.appendChild(headingRow);

    const contentWrap = document.createElement("div");
    contentWrap.className = "musecombo-v2-chunk-content";
    if (chunk.collapsed) contentWrap.style.display = "none";
    wrap.appendChild(contentWrap);

    const topRow = document.createElement("div");
    topRow.className = "musecombo-v2-chunk-top-row";
    topRow.appendChild(this._buildChunkStyleSoundBlock(chunkIdx, chunk));
    topRow.appendChild(this._buildChunkPreviewBox(chunkIdx, chunk));
    contentWrap.appendChild(topRow);

    // References panel lives inside this (only) chunk now — there's no
    // second chunk that could ever want a different costume/location, so
    // the old shared-vs-local-override split collapsed to just this one
    // panel. See the [2026-09-17] note at the top of this file.
    this.chunkRefsArea = document.createElement("div");
    this.chunkRefsArea.className = "musecombo-v2-reference-workspace musecombo-v2-reference-workspace-inchunk";
    contentWrap.appendChild(this.chunkRefsArea);
    this.renderReferences();

    const rulerWrap = document.createElement("div");
    rulerWrap.className = "musecombo-v2-ruler-wrap";
    contentWrap.appendChild(rulerWrap);

    const ruler = document.createElement("div");
    ruler.className = "musecombo-v2-ruler";
    const tickCount = Math.min(20, Math.max(4, Math.round(chunkDurSeconds)));
    for (let t = 0; t <= tickCount; t++) {
      const pct = (t / tickCount) * 100;
      const tick = document.createElement("div");
      tick.className = "musecombo-v2-ruler-tick";
      tick.style.left = pct + "%";
      ruler.appendChild(tick);
      const lbl = document.createElement("div");
      lbl.className = "musecombo-v2-ruler-tick-label";
      lbl.style.left = pct + "%";
      lbl.textContent = this._formatDuration((t / tickCount) * chunkDurSeconds);
      ruler.appendChild(lbl);
      if (t < tickCount) {
        for (let m = 1; m <= 9; m++) {
          const minorPct = ((t + m / 10) / tickCount) * 100;
          const minorTick = document.createElement("div");
          minorTick.className = "musecombo-v2-ruler-tick-minor";
          minorTick.style.left = minorPct + "%";
          ruler.appendChild(minorTick);
        }
      }
    }
    rulerWrap.appendChild(ruler);

    const track = document.createElement("div");
    track.className = "musecombo-v2-track";
    this.tracks[chunkIdx] = track;
    rulerWrap.appendChild(track);

    const totalWeight = chunk.segments.reduce((s, seg) => s + (seg.weight || 1), 0) || 1;
    chunk.segments.forEach((seg, i) => {
      track.appendChild(this._buildCutBlock(chunkIdx, seg, i, totalWeight, chunkDurSeconds));
    });

    const addBar = document.createElement("div");
    addBar.className = "musecombo-v2-add-cut-bar";
    addBar.innerHTML = ICON_PLUS + "<span>Add an extra cut</span>";
    addBar.title = "Add CUT";
    addBar.addEventListener("click", () => {
      const segs = chunk.segments;
      const lastSeg = segs[segs.length - 1];
      const lastWeight = lastSeg ? (lastSeg.weight || 1) : 0;
      if (lastSeg && lastWeight > 0.35) {
        const borrowed = Math.max(0.15, Math.min(lastWeight * 0.3, lastWeight - 0.15));
        lastSeg.weight = lastWeight - borrowed;
        segs.push({ prompt: "", weight: borrowed });
      } else {
        segs.push({ prompt: "", weight: 1 });
      }
      this.commitChanges();
      this.renderTimeline();
    });
    contentWrap.appendChild(addBar);

    return wrap;
  }

  // Style / Overall Soundscape / Non-Diegetic Music for the (one) chunk.
  _buildChunkStyleSoundBlock(chunkIdx, chunk) {
    const wrap = document.createElement("div");
    wrap.className = "musecombo-v2-chunk-style-wrap";

    const styleCard = document.createElement("div");
    styleCard.className = "musecombo-v2-creative-card musecombo-v2-creative-style";
    const styleTitleRow = document.createElement("div");
    styleTitleRow.className = "musecombo-v2-chunk-style-title-row";
    const styleLabel = document.createElement("div");
    styleLabel.className = "musecombo-v2-box-title";
    styleLabel.textContent = "✦ Overall Style";
    styleTitleRow.appendChild(styleLabel);
    styleCard.appendChild(styleTitleRow);

    const styleInput = document.createElement("textarea");
    styleInput.className = "musecombo-v2-style-input";
    styleInput.style.minHeight = "26px";
    styleInput.placeholder = "e.g. Photorealistic, warm golden-hour light, cinematic shallow depth of field... (lighting/palette/camera feel — not location, that belongs in this shot's own CUT text)";
    styleInput.value = chunk.style_line || "";
    styleInput.addEventListener("input", () => {
      chunk.style_line = styleInput.value;
      this.commitChanges();
    });
    styleCard.appendChild(styleInput);
    styleCard.classList.add("musecombo-v2-creative-style-fill");
    wrap.appendChild(styleCard);

    // [2026-09-17] Soundscape & Music box hidden per Andy's request — this
    // node's prompts are silent-void turnaround shots, not scored/ambient
    // scenes, so the fields had nothing to say. chunk.overall_soundscape/
    // chunk.non_diegetic_music are left alone (untouched, not deleted) —
    // the Python compiler already treats them as optional/blank-safe, so an
    // existing saved value from before this change still compiles fine.

    return wrap;
  }

  // [2026-09-17] Was a two-column "Now Generating" live view + "Chunk
  // Preview" finished-clip player side by side — Andy asked to drop the
  // Chunk Preview column and just have one area, so this now only builds
  // the live view (it already covers both "in progress" and, once a
  // websocket chunk-preview event lands, effectively idles at the last
  // frame it showed).
  _buildChunkPreviewBox(chunkIdx, chunk) {
    const outer = document.createElement("div");
    outer.className = "musecombo-v2-creative-card musecombo-v2-creative-preview";

    const liveCol = document.createElement("div");
    liveCol.className = "musecombo-v2-preview-col";
    const liveTitle = document.createElement("div");
    liveTitle.className = "musecombo-v2-box-title";
    liveTitle.textContent = "◉ Now Generating";
    liveCol.appendChild(liveTitle);
    const liveStatus = document.createElement("div");
    liveStatus.className = "musecombo-v2-chunk-preview-status musecombo-v2-live-preview-status";
    liveStatus.textContent = "Idle";
    liveCol.appendChild(liveStatus);
    const liveImg = document.createElement("img");
    liveImg.className = "musecombo-v2-live-preview-img";
    liveCol.appendChild(liveImg);
    this._liveChunkPreviewImgEls[chunkIdx] = liveImg;

    outer.appendChild(liveCol);
    return outer;
  }

  // ── CUT block, dialogue speakers, video guide ───────────────────────────
  _quotedDialogue(text) {
    return Array.from(String(text || "").matchAll(/"([^"]*)"/g)).map((m) => m[1].trim());
  }

  _speakerSlotsForChunk(chunkIdx) {
    const chunk = this.timeline.chunks[chunkIdx] || {};
    return Array.from({length: MAX_CHARACTER_SLOTS}, (_, i) => i).filter((i) => {
      const shared = this.timeline.characters?.[i];
      return !!(shared && (shared.file || shared.image_b64));
    });
  }

  _syncDialogueSpeakers(seg) {
    const quotes = this._quotedDialogue(seg.prompt);
    const old = Array.isArray(seg.dialogueSpeakers) ? seg.dialogueSpeakers : [];
    const queues = new Map();
    old.forEach((entry) => {
      if (!entry || typeof entry.text !== "string") return;
      if (!queues.has(entry.text)) queues.set(entry.text, []);
      queues.get(entry.text).push(entry.speakerCharIdx ?? null);
    });
    const legacy = Array.isArray(seg.speakerCharIdxs) && seg.speakerCharIdxs.length === 1
      ? seg.speakerCharIdxs[0] : (Number.isInteger(seg.speakerCharIdx) ? seg.speakerCharIdx : null);
    seg.dialogueSpeakers = quotes.map((quote, index) => {
      const queue = queues.get(quote);
      const preserved = queue?.length ? queue.shift() : old[index]?.speakerCharIdx;
      return {text: quote, speakerCharIdx: Number.isInteger(preserved) ? preserved : legacy};
    });
    return seg.dialogueSpeakers;
  }

  _buildDialogueSpeakerRows(chunkIdx, seg) {
    const wrap = document.createElement("div");
    wrap.className = "musecombo-v2-dialogue-speakers";
    const slots = this._speakerSlotsForChunk(chunkIdx);
    this._syncDialogueSpeakers(seg).forEach((assignment) => {
      const row = document.createElement("div");
      row.className = "musecombo-v2-dialogue-speaker-row";
      const line = document.createElement("div");
      line.className = "musecombo-v2-dialogue-line";
      line.textContent = `“${assignment.text}”`;
      line.title = assignment.text;
      row.appendChild(line);
      const label = document.createElement("span");
      label.className = "musecombo-v2-dialogue-speaker-label";
      label.textContent = "Who's speaking:";
      row.appendChild(label);
      slots.forEach((slotIdx) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "musecombo-v2-speaker-chip" + (assignment.speakerCharIdx === slotIdx ? " musecombo-v2-speaker-chip-active" : "");
        chip.textContent = `Ref ${slotIdx + 1}`;
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          assignment.speakerCharIdx = assignment.speakerCharIdx === slotIdx ? null : slotIdx;
          this.commitChanges();
          this.renderTimeline();
        });
        row.appendChild(chip);
      });
      wrap.appendChild(row);
    });
    return wrap;
  }

  // A reference video is an H3 conditioning input for the whole render call, so
  // CUT-level control is implemented in two coordinated parts: only clips
  // selected by at least one CUT are sent to H3, and the compiled [Shot N]
  // receives an explicit instruction limiting that clip to motion, camera, or
  // both. Targeting a Ref character transfers movement without importing the
  // reference performer's face, clothes or background.
  _referenceWindowDuration(seg) {
    if (!Number.isInteger(seg?.videoRefSlot)) return null;
    const entry = this.timeline.refVideos?.[seg.videoRefSlot];
    if (!entry) return null;
    const start = Math.max(0, Number(entry.trimStartSec) || 0);
    const rawEnd = entry.trimEndSec ?? entry.sourceDurationSec;
    const end = Number(rawEnd);
    if (!Number.isFinite(end) || end <= start) return null;
    return end - start;
  }

  _isReferenceTimingLocked(seg) {
    return seg?.videoRefTiming === "match_ref" && this._referenceWindowDuration(seg) !== null;
  }

  _chunkDurationAtIndex(chunkIdx) {
    return Math.max(0, this.durationSeconds);
  }

  // Convert the chunk's existing proportional weights to real seconds, reserve
  // every Match Ref In/Out cut at its selected reference duration, then scale
  // only the unlocked cuts into the time left over.
  _rebalanceChunkForReferenceLocks(chunkIdx, showWarning = true) {
    const chunk = this.timeline.chunks?.[chunkIdx];
    const chunkDuration = this._chunkDurationAtIndex(chunkIdx);
    if (!chunk || !chunk.segments?.length || chunkDuration <= 0) return false;

    const oldTotal = chunk.segments.reduce((sum, seg) => sum + Math.max(0.001, Number(seg.weight) || 1), 0) || 1;
    const oldSeconds = chunk.segments.map((seg) => Math.max(0.001, Number(seg.weight) || 1) / oldTotal * chunkDuration);
    const lockedDurations = new Map();
    let lockedTotal = 0;
    chunk.segments.forEach((seg) => {
      if (!this._isReferenceTimingLocked(seg)) return;
      const duration = this._referenceWindowDuration(seg);
      lockedDurations.set(seg, duration);
      lockedTotal += duration;
    });

    const unlocked = chunk.segments.filter((seg) => !lockedDurations.has(seg));
    const minimumUnlockedSeconds = 0.15;
    const remaining = chunkDuration - lockedTotal;
    const impossible = remaining < -0.001
      || (unlocked.length === 0 && Math.abs(remaining) > 0.02)
      || (unlocked.length > 0 && remaining < minimumUnlockedSeconds * unlocked.length);
    if (impossible) {
      if (showWarning) {
        alert(`The locked reference cuts need ${lockedTotal.toFixed(2)}s, which cannot fit inside this ${chunkDuration.toFixed(2)}s clip. Shorten a reference In/Out window or unlock another cut.`);
      }
      return false;
    }

    const oldUnlockedTotal = chunk.segments.reduce((sum, seg, idx) =>
      sum + (lockedDurations.has(seg) ? 0 : oldSeconds[idx]), 0);
    chunk.segments.forEach((seg, idx) => {
      if (lockedDurations.has(seg)) {
        seg.weight = lockedDurations.get(seg);
      } else if (oldUnlockedTotal > 0) {
        seg.weight = oldSeconds[idx] / oldUnlockedTotal * Math.max(0, remaining);
      } else {
        seg.weight = remaining / Math.max(1, unlocked.length);
      }
    });
    return true;
  }

  _syncReferenceLocksForSlot(refSlot, showWarning = true) {
    const chunkIdx = 0;
    const chunk = this.timeline.chunks[chunkIdx];
    if (!(chunk.segments || []).some((seg) => seg.videoRefSlot === refSlot && seg.videoRefTiming === "match_ref")) {
      return true;
    }
    const chunkDuration = this._chunkDurationAtIndex(chunkIdx);
    let lockedTotal = 0;
    let unlockedCount = 0;
    for (const seg of chunk.segments || []) {
      if (this._isReferenceTimingLocked(seg)) lockedTotal += this._referenceWindowDuration(seg);
      else unlockedCount += 1;
    }
    const remaining = chunkDuration - lockedTotal;
    if (remaining < -0.001
        || (unlockedCount === 0 && Math.abs(remaining) > 0.02)
        || (unlockedCount > 0 && remaining < 0.15 * unlockedCount)) {
      if (showWarning) {
        alert(`The updated reference window cannot fit inside this ${chunkDuration.toFixed(2)}s clip. Its locked cuts need ${lockedTotal.toFixed(2)}s.`);
      }
      return false;
    }
    this._rebalanceChunkForReferenceLocks(chunkIdx, false);
    return true;
  }

  _buildCutVideoGuide(chunkIdx, seg) {
    const available = [];
    for (let i = 0; i < REF_AV_SLOTS; i++) {
      const entry = this.timeline.refVideos?.[i];
      if (entry && entry.file) available.push(i);
    }
    if (available.length === 0) return null;

    if (!available.includes(seg.videoRefSlot)) seg.videoRefSlot = null;
    if (!["motion", "camera", "motion_camera"].includes(seg.videoRefMode)) seg.videoRefMode = "motion";
    if (!Number.isInteger(seg.videoRefTargetCharIdx)) seg.videoRefTargetCharIdx = null;

    const wrap = document.createElement("div");
    wrap.className = "musecombo-v2-cut-video-guide";
    wrap.addEventListener("click", (e) => e.stopPropagation());

    const videoOptions = [{ value: "none", label: "None" }];
    for (const idx of available) {
      const entry = this.timeline.refVideos[idx];
      const shortName = (entry.fileName || entry.file || "").split(/[\\/]/).pop();
      videoOptions.push({ value: String(idx), label: `Ref Video ${idx + 1}${shortName ? ` — ${shortName}` : ""}` });
    }
    wrap.appendChild(this._miniSelectRow(
      "Video guide", seg.videoRefSlot === null ? "none" : String(seg.videoRefSlot), videoOptions,
      (value) => {
        const oldSlot = seg.videoRefSlot;
        seg.videoRefSlot = value === "none" ? null : Number(value);
        if (seg.videoRefSlot === null) seg.videoRefTiming = "free";
        if (seg.videoRefTiming === "match_ref" && !this._rebalanceChunkForReferenceLocks(chunkIdx, true)) {
          seg.videoRefSlot = oldSlot;
        }
        setTimeout(() => this.renderTimeline(), 0);
      },
    ));

    if (seg.videoRefSlot !== null) {
      wrap.appendChild(this._miniSelectRow(
        "Use for", seg.videoRefMode,
        [
          { value: "motion", label: "Character/action motion" },
          { value: "camera", label: "Camera movement only" },
          { value: "motion_camera", label: "Motion + camera" },
        ],
        (value) => {
          seg.videoRefMode = value;
          setTimeout(() => this.renderTimeline(), 0);
        },
      ));

      if (seg.videoRefMode !== "camera") {
        const targetOptions = [{ value: "all", label: "Whole shot / all subjects" }];
        for (let i = 0; i < MAX_CHARACTER_SLOTS; i++) {
          const ch = this.timeline.characters[i];
          if (!ch || !(ch.file || ch.image_b64)) continue;
          targetOptions.push({ value: String(i), label: `Ref ${i + 1}` });
        }
        const currentTarget = Number.isInteger(seg.videoRefTargetCharIdx)
          ? String(seg.videoRefTargetCharIdx) : "all";
        wrap.appendChild(this._miniSelectRow(
          "Apply motion to", currentTarget, targetOptions,
          (value) => { seg.videoRefTargetCharIdx = value === "all" ? null : Number(value); },
        ));
      }

      const timingValue = ["free", "match_ref"].includes(seg.videoRefTiming) ? seg.videoRefTiming : "free";
      wrap.appendChild(this._miniSelectRow(
        "Guide timing", timingValue,
        [
          { value: "free", label: "Free timing" },
          { value: "match_ref", label: "Match Ref In / Out" },
        ],
        (value) => {
          const previous = seg.videoRefTiming || "free";
          seg.videoRefTiming = value;
          if (value === "match_ref" && !this._rebalanceChunkForReferenceLocks(chunkIdx, true)) {
            seg.videoRefTiming = previous;
          }
          setTimeout(() => this.renderTimeline(), 0);
        },
      ));

      const note = document.createElement("div");
      note.className = "musecombo-v2-cut-video-guide-note";
      if (this._isReferenceTimingLocked(seg)) {
        const duration = this._referenceWindowDuration(seg);
        note.textContent = `Locked: ${duration.toFixed(2)}s guide → ${duration.toFixed(2)}s cut. Other unlocked cuts share the remaining time.`;
      } else {
        note.textContent = "The selected clip's performer, clothing and setting are not copied when used as a motion/camera guide.";
      }
      wrap.appendChild(note);
    }
    return wrap;
  }

  _buildCutBlock(chunkIdx, seg, i, totalWeight, chunkDurSeconds) {
    const chunk = this.timeline.chunks[chunkIdx];
    const color = CUT_COLORS[i % CUT_COLORS.length];
    const seconds = ((seg.weight || 1) / totalWeight) * chunkDurSeconds;
    seg.duration_hint = seconds.toFixed(1);

    const block = document.createElement("div");
    block.className = "musecombo-v2-cut-block";
    const timingLocked = this._isReferenceTimingLocked(seg);
    if (timingLocked) block.classList.add("musecombo-v2-reference-locked");
    block.draggable = true;
    block.style.flex = `${seg.weight || 1} 0 0`;

    const bar = document.createElement("div");
    bar.className = "musecombo-v2-cut-bar";
    bar.style.background = color.bar;
    block.appendChild(bar);

    const otherUnlockedSegs = timingLocked
      ? []
      : chunk.segments.filter((sg, idx) => idx !== i && !this._isReferenceTimingLocked(sg));

    const head = document.createElement("div");
    head.className = "musecombo-v2-cut-head";
    const label = document.createElement("div");
    label.className = "musecombo-v2-cut-label";
    label.style.color = color.bar;
    label.append(`CUT ${i + 1} · `);
    if (timingLocked) {
      label.append(`~${this._formatDuration(seconds)}`);
      const lockBadge = document.createElement("span");
      lockBadge.className = "musecombo-v2-cut-lock-badge";
      lockBadge.textContent = `LOCKED TO REF ${this._referenceWindowDuration(seg).toFixed(2)}s`;
      label.appendChild(lockBadge);
    } else if (!otherUnlockedSegs.length) {
      label.append(`~${this._formatDuration(seconds)}`);
    } else {
      const durationInput = document.createElement("input");
      durationInput.type = "number";
      durationInput.className = "musecombo-v2-cut-duration-input";
      durationInput.step = "0.01";
      durationInput.min = String(MIN_CUT_SECONDS);
      durationInput.title = "Type this CUT's exact duration in seconds — the difference is redistributed " +
        "proportionally across every other CUT, so the total length never changes.";
      durationInput.value = seconds.toFixed(2);
      durationInput.addEventListener("click", (e) => e.stopPropagation());
      durationInput.addEventListener("change", () => {
        const segA = chunk.segments[i];
        const others = chunk.segments.filter((sg, idx) => idx !== i && !this._isReferenceTimingLocked(sg));
        if (!segA || !others.length) return;
        const liveTotalWeight = chunk.segments.reduce((s, sg) => s + (sg.weight || 1), 0);
        const minWeight = (MIN_CUT_SECONDS / chunkDurSeconds) * liveTotalWeight;
        const othersTotalWeight = others.reduce((s, sg) => s + (sg.weight || 1), 0);
        const maxSegAWeight = liveTotalWeight - others.length * minWeight;
        const maxSegASeconds = (maxSegAWeight / liveTotalWeight) * chunkDurSeconds;

        let wanted = parseFloat(durationInput.value);
        if (!Number.isFinite(wanted)) wanted = seconds;
        wanted = Math.max(MIN_CUT_SECONDS, Math.min(Math.max(MIN_CUT_SECONDS, maxSegASeconds), wanted));

        const wantedWeight = (wanted / chunkDurSeconds) * liveTotalWeight;
        const deltaWeight = wantedWeight - (segA.weight || 1);
        if (othersTotalWeight > 0) {
          for (const other of others) {
            const share = (other.weight || 1) / othersTotalWeight;
            other.weight = Math.max(minWeight, (other.weight || 1) - deltaWeight * share);
          }
        }
        segA.weight = wantedWeight;
        this.commitChanges();
        this.renderTimeline();
      });
      label.appendChild(durationInput);
      const unit = document.createElement("span");
      unit.className = "musecombo-v2-cut-duration-unit";
      unit.textContent = "s";
      label.appendChild(unit);
    }
    head.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "musecombo-v2-cut-actions";
    const dragHandle = document.createElement("span");
    dragHandle.innerHTML = ICON_DRAG;
    actions.appendChild(dragHandle);
    if (chunk.segments.length > 1) {
      const del = document.createElement("span");
      del.className = "musecombo-v2-cut-del";
      del.innerHTML = ICON_TRASH;
      del.title = "Delete CUT";
      del.addEventListener("click", () => {
        chunk.segments.splice(i, 1);
        this.commitChanges();
        this.renderTimeline();
      });
      actions.appendChild(del);
    }
    head.appendChild(actions);
    block.appendChild(head);

    const text = document.createElement("textarea");
    text.className = "musecombo-v2-cut-text";
    text.placeholder = "What happens in this shot — action, dialogue, camera move...";
    text.value = seg.prompt || "";
    block.appendChild(text);

    // [2026-09-18] Per-CUT Video guide control hidden on this node — not
    // appropriate for a still-turnaround character sheet workflow. Left
    // callable (_buildCutVideoGuide, unchanged) rather than deleted, so the
    // underlying data/logic stays intact if it's ever wanted back.

    // Speaker tagging only matters once this CUT actually has quoted dialogue
    // to attribute — appears/disappears live as you type rather than needing
    // a full re-render, so it never steals textarea focus.
    let speakerRows = this._buildDialogueSpeakerRows(chunkIdx, seg);
    block.appendChild(speakerRows);
    text.addEventListener("input", () => {
      seg.prompt = text.value;
      this.commitChanges();
      const replacement = this._buildDialogueSpeakerRows(chunkIdx, seg);
      speakerRows.replaceWith(replacement);
      speakerRows = replacement;
    });

    let dragResizePartnerIdx = -1;
    if (!timingLocked) {
      for (let candidate = i + 1; candidate < chunk.segments.length; candidate++) {
        if (!this._isReferenceTimingLocked(chunk.segments[candidate])) {
          dragResizePartnerIdx = candidate;
          break;
        }
      }
    }
    if (dragResizePartnerIdx >= 0) {
      const handle = document.createElement("div");
      handle.className = "musecombo-v2-cut-resize";
      handle.title = dragResizePartnerIdx === i + 1
        ? "Resize CUT"
        : `Resize against CUT ${dragResizePartnerIdx + 1}; locked reference CUTs stay fixed`;
      handle.addEventListener("mousedown", (e) => this._startResize(e, chunkIdx, i, dragResizePartnerIdx));
      block.appendChild(handle);
    }

    // Drag-to-reorder (whole block)
    block.addEventListener("dragstart", (e) => {
      block.classList.add("musecombo-v2-dragging");
      e.dataTransfer.setData("text/plain", String(i));
      e.dataTransfer.effectAllowed = "move";
    });
    block.addEventListener("dragend", () => block.classList.remove("musecombo-v2-dragging"));
    block.addEventListener("dragover", (e) => { e.preventDefault(); block.classList.add("musecombo-v2-drag-over"); });
    block.addEventListener("dragleave", () => block.classList.remove("musecombo-v2-drag-over"));
    block.addEventListener("drop", (e) => {
      e.preventDefault();
      block.classList.remove("musecombo-v2-drag-over");
      const fromIdx = parseInt(e.dataTransfer.getData("text/plain"), 10);
      if (Number.isNaN(fromIdx) || fromIdx === i) return;
      const [moved] = chunk.segments.splice(fromIdx, 1);
      chunk.segments.splice(i, 0, moved);
      this.commitChanges();
      this.renderTimeline();
    });

    return block;
  }

  _startResize(e, chunkIdx, i, partnerIdx = i + 1) {
    e.preventDefault();
    e.stopPropagation();
    const chunk = this.timeline.chunks[chunkIdx];
    const trackRect = this.tracks[chunkIdx].getBoundingClientRect();
    const segA = chunk.segments[i];
    const segB = chunk.segments[partnerIdx];
    if (!segA || !segB || this._isReferenceTimingLocked(segA) || this._isReferenceTimingLocked(segB)) return;
    const totalWeight = chunk.segments.reduce((s, seg) => s + (seg.weight || 1), 0);
    const pairWeight = (segA.weight || 1) + (segB.weight || 1);
    const startX = e.clientX;
    const startAWeight = segA.weight || 1;

    const onMove = (ev) => {
      const deltaPx = ev.clientX - startX;
      const deltaWeight = (deltaPx / trackRect.width) * totalWeight;
      let newA = startAWeight + deltaWeight;
      newA = Math.max(0.15, Math.min(pairWeight - 0.15, newA));
      segA.weight = newA;
      segB.weight = pairWeight - newA;
      this.renderTimeline();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      this.commitChanges();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // ── Shared reference images / video / audio ─────────────────────────────
  _clearSharedImages() {
    if (!window.confirm("Clear all shared character and location images? Song, audio and videos are kept.")) return;
    this.timeline.characters = Array(MAX_CHARACTER_SLOTS).fill(null);
    this.timeline.locations = [];
    this.commitChanges();
    this.renderReferences();
    this.renderTimeline();
  }

  _clearAllSharedReferences() {
    const hasShared = [
      ...(this.timeline.characters || []),
      ...(this.timeline.locations || []),
      ...(this.timeline.refVideos || []),
      ...(this.timeline.refAudios || []),
    ].some((entry) => !!entry);
    if (!hasShared) return;
    if (!window.confirm("Clear all shared image, location, video and audio references?")) return;
    this.timeline.characters = Array(MAX_CHARACTER_SLOTS).fill(null);
    this.timeline.locations = [];
    this.timeline.refVideos = Array(REF_AV_SLOTS).fill(null);
    this.timeline.refAudios = Array(REF_AV_SLOTS).fill(null);
    for (const seg of this.timeline.chunks[0]?.segments || []) {
      seg.videoRefSlot = null;
      seg.videoRefTiming = "free";
    }
    this.commitChanges();
    this.renderReferences();
    this.renderTimeline();
  }

  renderReferences() {
    if (!this.chunkRefsArea) return;
    this.chunkRefsArea.innerHTML = "";

    const panelTitle = document.createElement("div");
    panelTitle.className = "musecombo-v2-section-title";
    const panelTitleText = document.createElement("span");
    panelTitleText.innerHTML = "&#9851;&nbsp; References for this chunk";
    panelTitle.appendChild(panelTitleText);
    const clearSharedRefs = document.createElement("button");
    clearSharedRefs.type = "button";
    clearSharedRefs.className = "musecombo-v2-analyze-btn";
    clearSharedRefs.style.cssText = "margin-left:auto;width:auto;padding:4px 12px;";
    clearSharedRefs.textContent = "Clear ALL References";
    clearSharedRefs.title = "Remove every reference currently shown in this section";
    clearSharedRefs.addEventListener("click", () => this._clearAllSharedReferences());
    panelTitle.appendChild(clearSharedRefs);
    this.chunkRefsArea.appendChild(panelTitle);

    const imageSection = document.createElement("div");
    imageSection.className = "musecombo-v2-reference-section musecombo-v2-reference-section-images";
    const imageTitle = document.createElement("div");
    imageTitle.className = "musecombo-v2-reference-section-title";
    imageTitle.innerHTML = `<span>References <span style="text-transform:none;font-weight:600">(Images)</span></span><span class="musecombo-v2-reference-section-subtitle">Full-width identity, product and location references</span>`;
    const clearImages = document.createElement("button");
    clearImages.type = "button";
    clearImages.className = "musecombo-v2-analyze-btn";
    clearImages.style.cssText = "margin-left:auto;width:auto;padding:4px 12px;";
    clearImages.textContent = "Clear All Images";
    clearImages.title = "Clear character and location images only — keep song/audio/videos";
    clearImages.addEventListener("click", (e) => { e.stopPropagation(); this._clearSharedImages(); });
    imageTitle.appendChild(clearImages);
    imageSection.appendChild(imageTitle);

    // Location sits in the SAME grid as Ref 1-8 — slot 9 onward, same square
    // sizing — not a separate full-width row underneath. Matches the source
    // panel exactly (confirmed against a real screenshot of it).
    const charRow = document.createElement("div");
    charRow.className = "musecombo-v2-char-row";
    for (let i = 0; i < MAX_CHARACTER_SLOTS; i++) {
      charRow.appendChild(this._buildCharSlot(i));
    }
    (this.timeline.locations || []).forEach((entry, index) => {
      charRow.appendChild(this._buildLocationSlot(index, entry));
    });
    imageSection.appendChild(charRow);

    // [2026-09-18] "+ Add Location" removed on this node — not needed for a
    // plain-white-void turnaround character sheet. Backend/data untouched,
    // only the UI control is gone.

    const poolHint = document.createElement("div");
    poolHint.className = "musecombo-v2-reference-help";
    poolHint.textContent = "MiniMax allows nine visual references per call. Ref 1-8 plus the active Location share that pool.";
    imageSection.appendChild(poolHint);

    this.chunkRefsArea.appendChild(imageSection);

    // [2026-09-18] Ref Audio 1-3 hidden on this node (not removed from the
    // data/backend — this workflow just never uses audio, hiding is simpler
    // than stripping it out). The explanatory hint above them talked about
    // both audio and video guide controls that no longer show here, so it's
    // gone too rather than describing UI that isn't there anymore.

    // One row — Ref Video 1's own slot plus its dedicated viewer, now filling
    // the full width the audio slots used to share. Flex instead of the
    // multi-slot grid this row used when it had more items in it: with only
    // two real elements, auto-fit grid columns would leave empty unused
    // track space rather than actually stretching these two to fill the row.
    const avRow = document.createElement("div");
    avRow.className = "musecombo-v2-av-row musecombo-v2-av-row-video-only";
    avRow.appendChild(this._buildRefAvSlot("video", 0));
    avRow.appendChild(this._buildRefVideoViewer());
    this.chunkRefsArea.appendChild(avRow);
  }

  // Bigger, dedicated viewer for Ref Video 1 — separate from that slot's own
  // small scrub-bar preview, which is really an upload/trim control, not
  // meant for actually watching the clip. Spans the grid space Ref Video 2/3
  // used to occupy. Read fresh from this.timeline.refVideos[0] on every
  // renderReferences() call, so it updates automatically on upload/remove,
  // same as everything else in this panel.
  _buildRefVideoViewer() {
    const wrap = document.createElement("div");
    wrap.className = "musecombo-v2-av-slot musecombo-v2-video-viewer";
    // The row's own fixed height + align-items:stretch already matches this
    // wrapper's OUTER height to Ref Video 1's slot automatically; flex column
    // here is what makes the <video> itself actually fill that height instead
    // of leaving dead space below a shorter, intrinsically-sized element.
    wrap.style.cssText = "display:flex;flex-direction:column;min-height:0;";

    const label = document.createElement("div");
    label.className = "musecombo-v2-av-slot-label";
    label.textContent = "Ref Video 1 — Viewer";
    wrap.appendChild(label);

    const entry = this.timeline.refVideos[0];
    this._refVideoViewerEl = null;
    if (!entry || !(entry.file || entry._blobUrl)) {
      const placeholder = document.createElement("div");
      placeholder.className = "musecombo-v2-av-placeholder";
      placeholder.textContent = "Upload a clip into Ref Video 1 to preview it here.";
      wrap.appendChild(placeholder);
      return wrap;
    }

    const src = entry.file ? comfyViewUrl(entry.file) : entry._blobUrl;
    const video = document.createElement("video");
    video.src = src;
    video.controls = true;
    video.playsInline = true;
    video.preload = "auto";
    video.style.cssText = "width:100%;flex:1;min-height:0;border-radius:8px;background:#000;display:block;object-fit:contain;";
    // Some browsers leave a <video> element showing solid black until a frame
    // has actually been decoded — loadedmetadata alone (duration/size) isn't
    // enough to guarantee a painted frame. Nudging currentTime forces a real
    // seek, which forces a frame decode, without requiring playback to start.
    // Deliberately does NOT call commitChanges/renderReferences/renderTimeline
    // here — doing so would rebuild this same element, which reloads the same
    // src, which re-fires loadedmetadata, which would rebuild again: the
    // actual mechanism behind the reported flicker-on-upload loop. Duration
    // bookkeeping (entry.sourceDurationSec/trimEndSec) is written directly
    // without forcing an immediate re-render; it's picked up correctly next
    // time this panel re-renders for any other reason.
    video.addEventListener("loadedmetadata", () => {
      if (video.currentTime === 0) {
        try { video.currentTime = Math.min(0.1, video.duration || 0.1); } catch (e) { /* ignore */ }
      }
      if (isFinite(video.duration)) {
        const trimWasAtOldEnd = entry.trimEndSec === null || entry.trimEndSec === entry.sourceDurationSec;
        entry.sourceDurationSec = video.duration;
        if (trimWasAtOldEnd) entry.trimEndSec = video.duration;
      }
    }, { once: true });
    wrap.appendChild(video);
    this._refVideoViewerEl = video;
    return wrap;
  }

  _buildLocationSlot(index, entry) {
    const data = entry || { chunk: 1 };
    const filled = !!(data.file || data.image_b64);
    // Returns the .musecombo-v2-char-slot directly (no extra sizing wrapper)
    // so it's a uniform grid cell alongside Ref 1-8, not a wider one.
    const slot = document.createElement("div");
    slot.className = "musecombo-v2-char-slot" + (filled ? " musecombo-v2-filled" : "");
    slot.style.borderColor = "#9b7332";
    const label = document.createElement("div");
    label.className = "musecombo-v2-char-label";
    label.textContent = index === 0 ? "Location" : `Location ${index + 1}`;
    slot.appendChild(label);
    if (filled) {
      const del = document.createElement("button");
      del.className = "musecombo-v2-char-del";
      del.innerHTML = "&times;";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.timeline.locations.splice(index, 1);
        if (!this.timeline.locations.length) this.timeline.locations.push({ chunk: 1 });
        this.commitChanges();
        this.renderReferences();
      });
      slot.appendChild(del);
      const preview = document.createElement("div");
      preview.className = "musecombo-v2-char-preview";
      const img = document.createElement("img");
      img.src = data.file ? comfyViewUrl(data.file) : (data._blobUrl || data.image_b64);
      preview.appendChild(img);
      slot.appendChild(preview);
      const description = document.createElement("textarea");
      description.className = "musecombo-v2-desc-input";
      description.placeholder = "Describe the complete surrounding environment...";
      description.value = data.description || "";
      description.addEventListener("click", (e) => e.stopPropagation());
      description.addEventListener("input", () => {
        data.description = description.value;
        this.commitChanges();
      });
      slot.appendChild(description);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "musecombo-v2-char-placeholder";
      placeholder.innerHTML = `${ICON_UPLOAD}<br>Drop location image`;
      slot.appendChild(placeholder);
      slot.addEventListener("click", () => this._promptLocationFilePick(index));
    }
    slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.style.borderColor = "#e0a94f"; });
    slot.addEventListener("dragleave", () => { slot.style.borderColor = "#9b7332"; });
    slot.addEventListener("drop", async (e) => {
      e.preventDefault();
      slot.style.borderColor = "#9b7332";
      const file = e.dataTransfer.files?.[0];
      if (file) await this._setLocationImage(index, file);
    });
    return slot;
  }

  _promptLocationFilePick(index) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      if (input.files?.[0]) await this._setLocationImage(index, input.files[0]);
    };
    input.click();
  }

  async _setLocationImage(index, file) {
    try {
      const uploaded = await uploadRefFile(file);
      const previous = this.timeline.locations[index] || { chunk: 1 };
      this.timeline.locations[index] = {
        ...previous,
        ...uploaded,
        chunk: 1,
        _blobUrl: URL.createObjectURL(file),
      };
      this.commitChanges();
      this.renderReferences();
    } catch (err) {
      console.error("[MuseCharacterSheetH3] location upload failed", err);
      alert("Location upload failed — see console for details.");
    }
  }

  // ── Reference video / audio slots (upload + scrub + trim) ──────────────────
  _buildRefAvSlot(kind, idx) {
    const isVideo = kind === "video";
    const listKey = isVideo ? "refVideos" : "refAudios";
    const entry = this.timeline[listKey][idx];

    const slot = document.createElement("div");
    slot.className = "musecombo-v2-av-slot " + (isVideo ? "musecombo-v2-av-slot-video" : "musecombo-v2-av-slot-audio") + (entry ? " musecombo-v2-filled" : "");

    const head = document.createElement("div");
    head.className = "musecombo-v2-av-slot-head";
    const label = document.createElement("div");
    label.className = "musecombo-v2-av-slot-label";
    label.textContent = `${isVideo ? "Ref Video" : "Ref Audio"} ${idx + 1}`;
    head.appendChild(label);
    if (entry) {
      const del = document.createElement("button");
      del.className = "musecombo-v2-av-slot-del";
      del.innerHTML = "&times;";
      del.title = "Remove";
      del.addEventListener("click", () => {
        this.timeline[listKey][idx] = null;
        if (isVideo) {
          for (const seg of this.timeline.chunks[0]?.segments || []) {
            if (seg.videoRefSlot === idx) seg.videoRefSlot = null;
            if (seg.videoRefSlot === null) seg.videoRefTiming = "free";
          }
        }
        this.commitChanges();
        this.renderReferences();
        if (isVideo) this.renderTimeline();
      });
      head.appendChild(del);
    }
    slot.appendChild(head);

    if (!entry) {
      const placeholder = document.createElement("div");
      placeholder.className = "musecombo-v2-av-placeholder";
      placeholder.innerHTML = `${ICON_UPLOAD}<span>Drop or click to upload ${isVideo ? "video" : "audio"}</span>`;
      placeholder.addEventListener("click", () => this._promptAvFilePick(kind, idx));
      slot.appendChild(placeholder);
    } else {
      slot.appendChild(this._buildAvMedia(kind, idx, entry));
    }

    const dragColor = isVideo ? "#4F8EF7" : "#FF8800";
    slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.style.borderColor = dragColor; });
    slot.addEventListener("dragleave", () => { slot.style.borderColor = ""; });
    slot.addEventListener("drop", async (e) => {
      e.preventDefault();
      slot.style.borderColor = "";
      const file = e.dataTransfer.files?.[0];
      if (file) await this._setAvSlot(kind, idx, file);
    });

    return slot;
  }

  _promptAvFilePick(kind, idx) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = kind === "video" ? "video/*" : "audio/*";
    input.onchange = async () => {
      if (input.files?.[0]) await this._setAvSlot(kind, idx, input.files[0]);
    };
    input.click();
  }

  async _setAvSlot(kind, idx, file) {
    const listKey = kind === "video" ? "refVideos" : "refAudios";
    try {
      const uploaded = await uploadRefFile(file);
      const entry = { ...uploaded, trimStartSec: 0, trimEndSec: null, sourceDurationSec: null };
      if (kind === "video") entry.includeAudio = false;
      if (kind === "audio") {
        try {
          const { peaks, duration } = await extractAudioPeaks(file);
          entry.waveformPeaks = peaks;
          entry.sourceDurationSec = duration;
          entry.trimEndSec = duration;
        } catch (err) {
          console.warn("[MuseCharacterSheetH3] waveform peak extraction failed", err);
        }
      }
      entry._blobUrl = URL.createObjectURL(file);
      this.timeline[listKey][idx] = entry;
      this.commitChanges();
      this.renderReferences();
      if (kind === "video") this.renderTimeline();
    } catch (err) {
      console.error("[MuseCharacterSheetH3] reference upload failed", err);
      alert("Upload failed — see console for details.");
    }
  }

  _buildAvMedia(kind, idx, entry) {
    const wrap = document.createElement("div");
    wrap.className = "musecombo-v2-av-media";

    // _blobUrl only lives for the page session that created it; entry.file
    // (the real uploaded server path) is always durable, so it wins once it
    // exists.
    const src = entry.file ? comfyViewUrl(entry.file) : entry._blobUrl;

    // [2026-09-18] Video no longer gets its own embedded <video>/scrub-bar/
    // play button here — that duplicated the dedicated viewer on the right
    // (which is the one actually meant to be watched), took up space the
    // description boxes needed, and having two independently-loading <video>
    // elements pointed at the same file was the likely cause of a reported
    // flicker loop on upload. "Set In"/"Set Out" now read the shared viewer's
    // video element (this._refVideoViewerEl) instead of a local one — watch
    // in the viewer, click these to mark its current position. The manual
    // numeric In/Out inputs below need no video element at all either way.
    let mediaEl = null;
    if (kind === "audio") {
      mediaEl = document.createElement("audio");
      mediaEl.src = src;
      mediaEl.style.display = "none";
      wrap.appendChild(mediaEl);

      const canvas = document.createElement("canvas");
      canvas.className = "musecombo-v2-av-canvas";
      canvas.width = 260;
      canvas.height = 40;
      wrap.appendChild(canvas);
      requestAnimationFrame(() => this._drawWaveform(canvas, entry));
    }

    const readout = document.createElement("div");
    readout.className = "musecombo-v2-av-trim-readout";

    if (kind === "audio") {
      const finalizeDuration = () => {
        if (!mediaEl.duration || !isFinite(mediaEl.duration)) return;
        const trimWasAtOldEnd = entry.trimEndSec === null || entry.trimEndSec === entry.sourceDurationSec;
        entry.sourceDurationSec = mediaEl.duration;
        if (trimWasAtOldEnd) entry.trimEndSec = mediaEl.duration;
        scrub.max = String(mediaEl.duration);
        this.commitChanges();
        this._updateAvReadout(readout, entry);
      };
      mediaEl.addEventListener("loadedmetadata", finalizeDuration);

      const scrubRow = document.createElement("div");
      scrubRow.className = "musecombo-v2-av-scrub-row";

      const playBtn = document.createElement("button");
      playBtn.className = "musecombo-v2-av-play-btn";
      playBtn.innerHTML = ICON_PLAY;
      playBtn.title = "Play/Pause";
      playBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (mediaEl.paused) mediaEl.play(); else mediaEl.pause();
      });
      mediaEl.addEventListener("play", () => { playBtn.innerHTML = ICON_PAUSE; });
      mediaEl.addEventListener("pause", () => { playBtn.innerHTML = ICON_PLAY; });
      mediaEl.addEventListener("ended", () => { playBtn.innerHTML = ICON_PLAY; });
      scrubRow.appendChild(playBtn);

      const scrub = document.createElement("input");
      scrub.type = "range";
      scrub.className = "musecombo-v2-av-scrub";
      scrub.min = "0";
      scrub.max = String(entry.sourceDurationSec || 100);
      scrub.step = "0.05";
      scrub.value = "0";
      scrub.addEventListener("input", () => { mediaEl.currentTime = parseFloat(scrub.value); });
      mediaEl.addEventListener("timeupdate", () => { scrub.value = String(mediaEl.currentTime); });
      scrubRow.appendChild(scrub);
      wrap.appendChild(scrubRow);
    }

    const trimRow = document.createElement("div");
    trimRow.className = "musecombo-v2-av-trim-row";
    const setInBtn = document.createElement("button");
    setInBtn.className = "musecombo-v2-av-trim-btn";
    setInBtn.textContent = "Set In";
    setInBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const playhead = kind === "video" ? this._refVideoViewerEl : mediaEl;
      if (!playhead || !isFinite(playhead.currentTime)) return;
      const previous = entry.trimStartSec;
      entry.trimStartSec = Math.min(playhead.currentTime, (entry.trimEndSec ?? playhead.duration ?? playhead.currentTime + 1) - 0.05);
      entry.trimStartSec = Math.max(0, entry.trimStartSec);
      if (kind === "video" && !this._syncReferenceLocksForSlot(idx, true)) {
        entry.trimStartSec = previous;
        return;
      }
      this.commitChanges();
      this._updateAvReadout(readout, entry);
      inInput.value = entry.trimStartSec.toFixed(2);
    });
    const setOutBtn = document.createElement("button");
    setOutBtn.className = "musecombo-v2-av-trim-btn";
    setOutBtn.textContent = "Set Out";
    setOutBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const playhead = kind === "video" ? this._refVideoViewerEl : mediaEl;
      if (!playhead || !isFinite(playhead.currentTime)) return;
      const previous = entry.trimEndSec;
      entry.trimEndSec = Math.max(playhead.currentTime, entry.trimStartSec + 0.05);
      if (kind === "video" && !this._syncReferenceLocksForSlot(idx, true)) {
        entry.trimEndSec = previous;
        return;
      }
      this.commitChanges();
      this._updateAvReadout(readout, entry);
      outInput.value = entry.trimEndSec.toFixed(2);
    });
    trimRow.appendChild(setInBtn);
    trimRow.appendChild(setOutBtn);
    wrap.appendChild(trimRow);

    const manualRow = document.createElement("div");
    manualRow.className = "musecombo-v2-av-trim-row musecombo-v2-av-trim-manual-row";
    const inInput = document.createElement("input");
    inInput.type = "number";
    inInput.className = "musecombo-v2-av-trim-input";
    inInput.step = "0.05";
    inInput.min = "0";
    inInput.placeholder = "In (s)";
    inInput.title = "Type the exact In point, in seconds";
    inInput.value = (entry.trimStartSec || 0).toFixed(2);
    inInput.addEventListener("click", (e) => e.stopPropagation());
    inInput.addEventListener("change", () => {
      const previous = entry.trimStartSec;
      let v = parseFloat(inInput.value);
      if (!Number.isFinite(v)) v = previous || 0;
      const maxIn = (entry.trimEndSec ?? entry.sourceDurationSec ?? Infinity) - 0.05;
      v = Math.max(0, Math.min(v, maxIn));
      entry.trimStartSec = v;
      if (kind === "video" && !this._syncReferenceLocksForSlot(idx, true)) {
        entry.trimStartSec = previous;
        inInput.value = (previous || 0).toFixed(2);
        return;
      }
      this.commitChanges();
      inInput.value = v.toFixed(2);
      this._updateAvReadout(readout, entry);
      if (kind === "video") this.renderTimeline();
    });
    manualRow.appendChild(inInput);

    const outInput = document.createElement("input");
    outInput.type = "number";
    outInput.className = "musecombo-v2-av-trim-input";
    outInput.step = "0.05";
    outInput.min = "0";
    outInput.placeholder = "Out (s)";
    outInput.title = "Type the exact Out point, in seconds — leave blank for the clip's end";
    outInput.value = entry.trimEndSec !== null && entry.trimEndSec !== undefined ? entry.trimEndSec.toFixed(2) : "";
    outInput.addEventListener("click", (e) => e.stopPropagation());
    outInput.addEventListener("change", () => {
      const previous = entry.trimEndSec;
      const raw = outInput.value.trim();
      let v = raw === "" ? null : parseFloat(raw);
      if (v !== null && !Number.isFinite(v)) v = previous ?? null;
      if (v !== null) {
        const minOut = (entry.trimStartSec || 0) + 0.05;
        const maxOut = entry.sourceDurationSec ?? Infinity;
        v = Math.max(minOut, Math.min(v, maxOut));
      }
      entry.trimEndSec = v;
      if (kind === "video" && !this._syncReferenceLocksForSlot(idx, true)) {
        entry.trimEndSec = previous;
        outInput.value = previous !== null && previous !== undefined ? previous.toFixed(2) : "";
        return;
      }
      this.commitChanges();
      outInput.value = v !== null ? v.toFixed(2) : "";
      this._updateAvReadout(readout, entry);
      if (kind === "video") this.renderTimeline();
    });
    manualRow.appendChild(outInput);
    wrap.appendChild(manualRow);

    wrap.appendChild(readout);
    this._updateAvReadout(readout, entry);

    const filename = document.createElement("div");
    filename.className = "musecombo-v2-av-filename";
    filename.textContent = entry.fileName || "";
    filename.style.display = this.timeline.show_filenames === false ? "none" : "";
    wrap.appendChild(filename);

    if (kind === "audio") {
      // Ref Audio N auto-pairs with Ref (character) N by position.
      const pairedChar = this.timeline.characters[idx];
      const pairedFilled = pairedChar && (pairedChar.file || pairedChar.image_b64);
      const pairNote = document.createElement("div");
      pairNote.className = "musecombo-v2-audio-pair-note";
      pairNote.textContent = pairedFilled
        ? `Paired with Ref ${idx + 1} — this is automatically her/his voice reference.`
        : `No character in Ref ${idx + 1} — describe the voice below, or leave blank for an unattributed reference.`;
      wrap.appendChild(pairNote);

      const descInput = document.createElement("textarea");
      descInput.className = "musecombo-v2-desc-input";
      descInput.placeholder = "optional — only used when there's no matching character, e.g. \"Sarah — warm, mid-range\"";
      descInput.value = entry.description || "";
      descInput.addEventListener("click", (e) => e.stopPropagation());
      descInput.addEventListener("input", () => {
        entry.description = descInput.value;
        this.commitChanges();
      });
      wrap.appendChild(descInput);

      wrap.appendChild(this._miniSelectRow(
        "Retention", entry.retention || "reference", AUDIO_RETENTION_OPTIONS,
        (v) => { entry.retention = v; this.renderReferences(); },
      ));
    }

    if (kind === "video") {
      const audioToggleRow = document.createElement("label");
      audioToggleRow.className = "musecombo-v2-av-audio-toggle";
      audioToggleRow.addEventListener("click", (e) => e.stopPropagation());

      const audioToggle = document.createElement("input");
      audioToggle.type = "checkbox";
      audioToggle.className = "musecombo-v2-box-checkbox";
      audioToggle.checked = !!entry.includeAudio;
      audioToggle.addEventListener("change", () => {
        entry.includeAudio = audioToggle.checked;
        this.commitChanges();
      });
      audioToggleRow.appendChild(audioToggle);

      const audioToggleLabel = document.createElement("span");
      audioToggleLabel.textContent = "Include this clip's audio (as its own reference)";
      audioToggleRow.appendChild(audioToggleLabel);
      wrap.appendChild(audioToggleRow);

      const sceneAnchorInput = document.createElement("textarea");
      sceneAnchorInput.className = "musecombo-v2-desc-input";
      sceneAnchorInput.placeholder = "scene anchor (environment, objects, layout, colors) — optional style-line addition";
      sceneAnchorInput.value = entry.sceneAnchor || "";
      sceneAnchorInput.addEventListener("click", (e) => e.stopPropagation());
      sceneAnchorInput.addEventListener("input", () => {
        entry.sceneAnchor = sceneAnchorInput.value;
        this.commitChanges();
      });
      wrap.appendChild(sceneAnchorInput);

      const subjectDescInput = document.createElement("textarea");
      subjectDescInput.className = "musecombo-v2-desc-input";
      // [2026-09-18] Corrected — this box was previously mislabeled as a plain
      // camera-path note that explicitly said identity was never copied. It's
      // always written straight to entry.description, which now (ported from
      // MiniMaxH3-Director-V1.5) defines a real <Subject N> identity citing
      // this video, per MiniMax's own documented reference-mode pattern. Leave
      // blank for a pure motion/camera reference (the CUT video-guide picker
      // below still applies either way, independent of this).
      subjectDescInput.placeholder = "if this video shows a person to reuse, describe them here (creates a Subject, per MiniMax's own <Subject N> in <Video N> pattern) — leave blank for a pure motion/camera reference";
      subjectDescInput.value = entry.description || "";
      subjectDescInput.addEventListener("click", (e) => e.stopPropagation());
      subjectDescInput.addEventListener("input", () => {
        entry.description = subjectDescInput.value;
        this.commitChanges();
      });
      wrap.appendChild(subjectDescInput);

      // Only takes effect once a description above is typed (an undescribed
      // video has no <Subject N> line for this to modulate) — shown
      // unconditionally anyway (same as the audio Retention row above) so it
      // doesn't disappear/reappear as you type rather than re-render. Same
      // VISUAL_RETENTION_OPTIONS vocabulary used everywhere else, defaulting
      // to fully_preserved to match the backend's own fallback.
      wrap.appendChild(this._miniSelectRow(
        "Retention", entry.retention || "fully_preserved", VISUAL_RETENTION_OPTIONS,
        (v) => { entry.retention = v; },
      ));

      // [2026-09-18] Once a slot is filled, the empty-state upload placeholder
      // (with its own click-to-pick handler) is gone — drag-and-drop onto the
      // slot still works (the dragover/drop listeners are on the outer slot
      // element regardless of fill state), but there was no click-based way to
      // replace the clip without first deleting it. Same _promptAvFilePick
      // path the empty placeholder uses.
      const replaceBtn = document.createElement("button");
      replaceBtn.type = "button";
      replaceBtn.className = "musecombo-v2-analyze-btn";
      replaceBtn.style.width = "100%";
      replaceBtn.style.marginTop = "6px";
      replaceBtn.textContent = "Replace Video";
      replaceBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._promptAvFilePick(kind, idx);
      });
      wrap.appendChild(replaceBtn);
    }

    return wrap;
  }

  _updateAvReadout(readoutEl, entry) {
    const inSec = (entry.trimStartSec || 0).toFixed(2);
    const outSec = entry.trimEndSec !== null && entry.trimEndSec !== undefined ? entry.trimEndSec.toFixed(2) : "end";
    readoutEl.textContent = `In ${inSec}s — Out ${outSec}s`;
  }

  _drawWaveform(canvas, entry) {
    const peaks = entry.waveformPeaks;
    if (!peaks || !peaks.length) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#4F8EF7";
    const barW = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.max(1, peaks[i] * h * 0.9);
      ctx.fillRect(i * barW, (h - amp) / 2, Math.max(1, barW - 1), amp);
    }
  }

  // ── Character reference slots ───────────────────────────────────────────
  _buildCharSlot(idx) {
    const data = this.timeline.characters[idx];
    const filled = data && (data.file || data.image_b64);

    const slot = document.createElement("div");
    slot.className = "musecombo-v2-char-slot" + (filled ? " musecombo-v2-filled" : "");

    // [2026-09-18] Ref 1 is RefMod's identity slot once RefMod Override is
    // on — confirmed with Andy: its own image must not also get fed as
    // <Picture 1>, so lock the box rather than let it silently do nothing
    // (matches the old "locked to sidebar Ref N" read-only pattern this
    // project already uses elsewhere for an overridden slot).
    if (idx === 0 && this.realWidgets.use_refmod?.value) {
      slot.classList.add("musecombo-v2-char-slot-disabled");
      const label = document.createElement("div");
      label.className = "musecombo-v2-char-label";
      label.textContent = "Ref 1";
      slot.appendChild(label);
      const note = document.createElement("div");
      note.className = "musecombo-v2-char-placeholder";
      note.textContent = "Controlled by RefMod Override — see the RefMod Override card";
      slot.appendChild(note);
      return slot;
    }

    const label = document.createElement("div");
    label.className = "musecombo-v2-char-label";
    label.textContent = `Ref ${idx + 1}`;
    slot.appendChild(label);

    if (filled) {
      const del = document.createElement("button");
      del.className = "musecombo-v2-char-del";
      del.innerHTML = "&times;";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.timeline.characters[idx] = null;
        this.commitChanges();
        this.renderReferences();
        this.renderTimeline();
      });
      slot.appendChild(del);

      const preview = document.createElement("div");
      preview.className = "musecombo-v2-char-preview";
      const img = document.createElement("img");
      img.src = data.file ? comfyViewUrl(data.file) : (data._blobUrl || data.image_b64);
      preview.appendChild(img);
      slot.appendChild(preview);

      const descInput = document.createElement("textarea");
      descInput.className = "musecombo-v2-desc-input";
      descInput.placeholder = "description...";
      descInput.value = data.description || "";
      descInput.addEventListener("click", (e) => e.stopPropagation());
      descInput.addEventListener("input", () => {
        data.description = descInput.value;
        this.commitChanges();
      });

      const analyzeBtn = document.createElement("button");
      analyzeBtn.className = "musecombo-v2-analyze-btn";
      analyzeBtn.textContent = data.description ? "Re-Analyze" : "Analyze";
      analyzeBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.runAnalysis(idx, analyzeBtn, descInput);
      });
      slot.appendChild(analyzeBtn);

      slot.appendChild(descInput);

      slot.appendChild(this._miniSelectRow(
        "Retention", data.retention || "fully_preserved", VISUAL_RETENTION_OPTIONS,
        (v) => { data.retention = v; },
      ));
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "musecombo-v2-char-placeholder";
      placeholder.innerHTML = `${ICON_UPLOAD}<br>Drop image`;
      slot.appendChild(placeholder);
      slot.addEventListener("click", () => this._promptFilePick(idx));
    }

    slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.style.borderColor = "#4F8EF7"; });
    slot.addEventListener("dragleave", () => { slot.style.borderColor = ""; });
    slot.addEventListener("drop", async (e) => {
      e.preventDefault();
      slot.style.borderColor = "";
      const file = e.dataTransfer.files?.[0];
      if (file) await this._setSlotImage(idx, file);
    });

    return slot;
  }

  _promptFilePick(idx) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      if (input.files?.[0]) await this._setSlotImage(idx, input.files[0]);
    };
    input.click();
  }

  async _setSlotImage(idx, file) {
    // Uploaded (like ref_video/ref_audio), not base64-embedded — a base64
    // image inline in timeline_data can push a single workflow draft past
    // the browser's localStorage per-entry autosave budget (~750KB), which
    // silently evicts the draft and loses any unsaved edits.
    try {
      const uploaded = await uploadRefFile(file);
      const entry = { ...uploaded, description: "", _blobUrl: URL.createObjectURL(file) };
      this.timeline.characters[idx] = entry;
      this.commitChanges();
      this.renderReferences();
      this.renderTimeline();
    } catch (err) {
      console.error("[MuseCharacterSheetH3] reference image upload failed", err);
      alert("Image upload failed — see console for details.");
    }
  }

  async _resolveImageB64(data) {
    if (data.image_b64) return data.image_b64;
    const src = data.file ? comfyViewUrl(data.file) : data._blobUrl;
    if (!src) throw new Error("No image source available for this reference.");
    return await urlToB64(src);
  }

  async runAnalysis(idx, btn, descInput) {
    if (btn.classList.contains("musecombo-v2-loading")) return;
    btn.classList.add("musecombo-v2-loading");
    btn.textContent = "Analyzing...";
    const data = this.timeline.characters[idx];
    try {
      const imageB64 = await this._resolveImageB64(data);
      const resp = await api.fetchApi("/muse_character_sheet_h3/analyze_character", {
        method: "POST",
        body: JSON.stringify({
          image_b64: [imageB64],
          char_index: idx,
          provider: this.timeline.analyze_provider || "ollama",
          base_url: this.timeline.analyze_base_url || "",
          model: this.timeline.analyze_model || "",
        }),
      });
      const result = await resp.json();
      if (result.status === "success") {
        data.description = result.description;
        descInput.value = result.description;
        btn.textContent = "Success!";
        this.commitChanges();
        setTimeout(() => { btn.classList.remove("musecombo-v2-loading"); btn.textContent = "Re-Analyze"; }, 1200);
      } else {
        alert("Analysis error: " + result.message);
        btn.classList.remove("musecombo-v2-loading");
        btn.textContent = "Analyze";
      }
    } catch (err) {
      console.error("[MuseCharacterSheetH3] analysis request failed", err);
      alert("Analyze request failed — is ComfyUI running, and is Ollama (or your chosen provider) reachable?");
      btn.classList.remove("musecombo-v2-loading");
      btn.textContent = "Analyze";
    }
  }
}

app.registerExtension({
  name: "MuseCollective.CharacterSheetH3",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "MuseCharacterSheetH3") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

      // Hide the raw JSON widget, and the native copies of the widgets we
      // re-skin into boxed sections — the DOM editor below is the real UI
      // for all of them.
      for (const w of this.widgets || []) {
        if (HIDDEN_WIDGET_NAMES.includes(w.name) || BOXED_WIDGET_NAMES.includes(w.name)) {
          hideWidget(w);
        }
      }

      this._museCharacterSheetH3Editor = new CharacterSheetH3TimelineEditor(this);
      const timelineWidget = this.addDOMWidget("mch3_timeline_ui", "mch3_timeline_ui", this._museCharacterSheetH3Editor.container, {
        serialize: false,
        hideOnZoom: false,
      });
      // [2026-09-18] Root cause, confirmed via LiteGraph's own console state
      // (vueNodesMode: false, node.size[1]: 5931 vs. real container
      // offsetHeight: 2445): LGraphNode._arrangeWidgets calls every widget's
      // computeSize() on every arrange/redraw and, outside Vue nodes mode,
      // auto-GROWS the node — never shrinks it — whenever the summed widget
      // height (computeSize()[1] + 4 + startY, per its own source) exceeds
      // the node's current height. A live container.offsetHeight read here
      // let any momentarily-inflated reading get permanently locked in.
      // Echoing back this.size[1] (tried next) was worse: computeSize's own
      // output became _arrangeWidgets' next input, and since that function
      // always adds its own small padding on top, each frame's grow became
      // next frame's baseline — an unbounded runaway, confirmed live by the
      // node growing to fill the whole canvas in seconds.
      // Fix: a height CACHED from _resizeOnce's real, settled measurement —
      // decoupled from this.size entirely, so it can't feed the loop above —
      // updated only when _resizeOnce actually runs, not on every arrange.
      timelineWidget.computeSize = (width) => {
        return [Math.max(this.size?.[0] || width || 1480, 1480), this._museCharacterSheetH3Editor?._cachedContentHeight || 640];
      };
      this._museCharacterSheetH3Editor._attachAutoResize(timelineWidget);

      // [2026-09-18] Was a hardcoded [1480, 900] — this runs on every node
      // (re)creation, including a tab switch reloading an already-open
      // workflow, not just a genuinely new node. 900 was taller than the
      // node's actual content ever since the audio slots/hint text/Add
      // Location button were removed, so it always started oversized and
      // then visibly snapped down once _scheduleNodeResize measured the
      // real (now shorter) content a couple of frames later. Starting at
      // the auto-resize's own floor (640, from computeSize above) means it
      // only ever grows from here if content is actually taller — no flash.
      this.size = [1480, 640];
      return r;
    };

    // Each node instance registers its own websocket listeners for live
    // previews — drop them when the node is deleted so removed nodes don't
    // keep listening forever.
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      const editor = this._museCharacterSheetH3Editor;
      if (editor?._executionLayoutHandler) {
        api.removeEventListener("execution_error", editor._executionLayoutHandler);
        api.removeEventListener("execution_interrupted", editor._executionLayoutHandler);
      }
      editor?._resizeObserver?.disconnect();
      if (editor?._resizeDebounce) clearTimeout(editor._resizeDebounce);
      if (editor?._chunkPreviewHandler) {
        api.removeEventListener(_MUSE_CHUNK_PREVIEW_EVENT, editor._chunkPreviewHandler);
      }
      if (editor?._liveChunkPreviewHandler) {
        api.removeEventListener(_MUSE_LIVE_PREVIEW_EVENT, editor._liveChunkPreviewHandler);
      }
      return onRemoved ? onRemoved.apply(this, arguments) : undefined;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function () {
      const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
      this._museCharacterSheetH3Editor?._scheduleNodeResize();
      return r;
    };

    // onNodeCreated fires before ComfyUI applies a loaded workflow's saved
    // widgets_values onto the widgets — so building the DOM editor's
    // in-memory state there only ever sees timeline_data's default "{}".
    // onConfigure fires after the real widgets_values has been applied, so
    // re-syncing here is what actually picks up the loaded data.
    //
    // [2026-09-18] onConfigure fires on ANY re-application of this node's
    // serialized state, not just a genuine workflow load — confirmed as the
    // real cause of a reported bug: switching away from this workflow's tab
    // and back (ComfyUI's multi-tab UI re-applies each tab's saved graph
    // state on switch) fired this same full rebuild every time, wiping the
    // live chunk-preview image (never part of timeline_data, so build() has
    // no way to restore it) and visibly resizing the node while it settled.
    // Only the FIRST real onConfigure after node creation actually carries
    // different data (blank "{}" from onNodeCreated -> the real saved JSON);
    // every subsequent one on the same already-loaded workflow reapplies the
    // identical string. Comparing the raw widget value before rebuilding
    // skips exactly those no-op reconfigures while still rebuilding for any
    // genuinely different data (a real reload, or an undo/redo that changes
    // the saved JSON).
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      const editor = this._museCharacterSheetH3Editor;
      if (editor) {
        const raw = editor.timelineDataWidget?.value || "{}";
        if (raw !== editor._lastConfiguredRawTimelineData) {
          editor._lastConfiguredRawTimelineData = raw;
          editor.timeline = editor._loadState();
          editor.build();
          editor._scheduleNodeResize();
        }
      }
      return r;
    };
  },
});
