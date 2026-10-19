"""Model-local 3D-upscaler memory layout; no dependency/global monkey patch."""
import logging
import types
import torch

log = logging.getLogger(__name__)


def execute(node, **kwargs):
    bound = node.execute
    fn = getattr(bound, '__func__', None)
    if kwargs.get('device') != 'cuda':
        return bound(**kwargs)
    if fn is None or 'load_model' not in fn.__globals__:
        raise RuntimeError('Character Sheet upscaler memory optimization: unsupported upscaler API.')
    original_load = fn.__globals__['load_model']
    touched = []

    def load_packed(*args, **kw):
        model = original_load(*args, **kw)
        touched.append(model)
        return model.to(memory_format=torch.channels_last_3d)

    private = dict(fn.__globals__, load_model=load_packed)
    local = types.FunctionType(fn.__code__, private, fn.__name__, fn.__defaults__, fn.__closure__)
    local.__kwdefaults__ = fn.__kwdefaults__
    latent = dict(kwargs['latent'])
    samples = latent['samples']
    if samples.ndim == 5:
        latent['samples'] = samples.contiguous(memory_format=torch.channels_last_3d)
    kwargs = dict(kwargs, latent=latent)
    log.info('[MuseCharacterSheetH3 Upscale] Upscaler low-memory 3D layout active; temporal chunking=%s; resolution and weights unchanged.', kwargs.get('enable_temporal_chunking'))
    try:
        return local(node, **kwargs)
    finally:
        # Restore the dependency cache's normal layout. Also release the model
        # after an exception, when the upstream success-only cleanup is skipped.
        for model in touched:
            try:
                model.to(device='cpu', memory_format=torch.contiguous_format)
            except Exception:
                log.exception('Could not restore the upscaler cache after execution')
