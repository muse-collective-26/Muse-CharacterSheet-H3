"""Prepare each real sampling pass without replacing its patched model or inputs."""
import gc
import logging

log = logging.getLogger(__name__)


def prepare(guider, latent, sigmas):
    # One-point schedules only prime a latent; prepare before the real pass.
    if sigmas is None or len(sigmas) < 2:
        return
    import comfy.model_management as mm
    patcher = getattr(guider, 'model_patcher', None)
    if patcher is None:
        raise RuntimeError('Muse sampling memory: sampler guider has no model_patcher.')
    device = getattr(patcher, 'load_device', None)
    if device is None or getattr(device, 'type', str(device).split(':')[0]) != 'cuda':
        return
    samples = (latent or {}).get('samples')
    def shape(value):
        if isinstance(value, (tuple, list)):
            return [shape(v) for v in value]
        # Comfy NestedTensor stores separate video/audio tensors here.
        tensors = getattr(value, 'tensors', None)
        if tensors is not None:
            return [shape(v) for v in tensors]
        return tuple(value.shape) if hasattr(value, 'shape') else type(value).__name__
    before = mm.get_free_memory(device)
    # Comfy normally does this at an external node boundary (execution.py).
    # Our multiple sampler calls live inside one node: end-of-forward only pauses
    # the malloc graph; unload_all_models does not destroy that allocation pool.
    try:
        import comfy.model_prefetch as prefetch
    except ModuleNotFoundError as exc:
        if exc.name != 'comfy.model_prefetch':
            raise
        # Older ComfyUI versions have no compiler prefetch pools to clear.
        prefetch = None
    cleanup = getattr(prefetch, 'cleanup_prefetch_queues', None)
    if callable(cleanup):
        cleanup()
        log.info('[Muse Sampling Memory] Compiler allocation pools and prefetch queues cleared at sampling boundary.')
    # ComfyUI unloads residency, not the caller's patcher, LoRAs, or conditioning.
    # Do not clear execution caches or modify caller-owned latent/carry tensors.
    mm.unload_all_models()
    gc.collect()
    mm.free_memory(mm.get_total_memory(device) * 0.9, device)
    mm.soft_empty_cache()
    required = getattr(getattr(patcher, 'model', None), 'memory_required', None)
    fn = getattr(required, '__func__', required)
    session = getattr(fn, '__globals__', {}).get('_auto_session')
    reset = 0
    if isinstance(session, dict):
        # Keep timing measurements and the persistent measured-pool cache.
        # Only invalidate per-session reserve decisions, as Seed Hunt already does.
        for key in list(session):
            if not str(key).startswith('sit|'):
                del session[key]
                reset += 1
        reservation = f'fresh calculation requested ({reset} cached reserves cleared)'
    else:
        reservation = 'standard ComfyUI reservation (no H3 session cache)'
    after = mm.get_free_memory(device)
    log.info('[Muse Sampling Memory] steps=%d latent=%s; free VRAM %.2f -> %.2f GiB; %s; weight patches=%d, object patches=%d preserved.',
             len(sigmas) - 1, shape(samples), before / 2**30, after / 2**30,
             reservation, len(getattr(patcher, 'patches', {}) or {}),
             len(getattr(patcher, 'object_patches', {}) or {}))
