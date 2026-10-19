"""Muse compatibility frontend; GPL-3.0, includes attributed RMBG engine."""
import logging
from PIL import ImageColor
import torch

def colour(value):
    text = str(value).strip()
    if text and not text.startswith('#') and len(text) in (3, 4, 6, 8):
        try:
            int(text, 16)
            text = '#' + text
        except ValueError:
            pass
    try:
        rgba = ImageColor.getcolor(text, 'RGBA')
    except (ValueError, TypeError):
        logging.warning('[Muse Remove Background] Invalid background colour %r; using white (#FFFFFF).', value)
        rgba = (255, 255, 255, 255)
    return '#' + ''.join(f'{v:02x}' for v in rgba)

class MuseRemoveBackground:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {
            'image': ('IMAGE',),
            'model': (['RMBG-2.0', 'INSPYRENET', 'BEN', 'BEN2'],),
        }, 'optional': {
            'sensitivity': ('FLOAT', {'default': 1.0, 'min': 0., 'max': 1., 'step': .01}),
            'process_res': ('INT', {'default': 1024, 'min': 256, 'max': 2048, 'step': 128}),
            'mask_blur': ('INT', {'default': 0, 'min': 0, 'max': 64}),
            'mask_offset': ('INT', {'default': 0, 'min': -64, 'max': 64}),
            'invert_output': ('BOOLEAN', {'default': False}),
            'refine_foreground': ('BOOLEAN', {'default': False}),
            'unload_model': ('BOOLEAN', {'default': True}),
            'background': (['Alpha', 'Color'], {'default': 'Alpha'}),
            'background_color': ('STRING', {'default': '#FFFFFF', 'tooltip': 'Colour name or hex, e.g. white or #FFFFFF. Invalid entries use white with a log warning.'}),
        }}
    RETURN_TYPES = ('IMAGE', 'MASK', 'IMAGE')
    RETURN_NAMES = ('IMAGE', 'MASK', 'MASK_IMAGE')
    FUNCTION = 'process_image'
    CATEGORY = 'Muse/Image'

    def __init__(self):
        self.engine = None

    def process_image(self, image, model='RMBG-2.0', sensitivity=1., process_res=1024,
                      mask_blur=0, mask_offset=0, invert_output=False,
                      refine_foreground=False, unload_model=True,
                      background='Alpha', background_color='#FFFFFF'):
        if not isinstance(image, torch.Tensor) or image.ndim != 4 or min(image.shape) < 1:
            raise ValueError('Muse Remove Background: connect a nonempty ComfyUI IMAGE batch.')
        channels = image.shape[-1]
        if channels in (1, 2):
            image = image[..., :1].repeat(1, 1, 1, 3)
        elif channels in (3, 4):
            image = image[..., :3]
        else:
            raise ValueError('Muse Remove Background: expected grayscale, RGB or RGBA images.')
        if model not in self.INPUT_TYPES()['required']['model'][0]:
            raise ValueError('Muse Remove Background: select a supported model.')
        if background not in ('Alpha', 'Color'):
            logging.warning('[Muse Remove Background] Unrecognised legacy background setting %r; using Alpha.', background)
            background = 'Alpha'
        if self.engine is None:
            try:
                from .engine import RMBG
                self.engine = RMBG()
            except ImportError as exc:
                raise RuntimeError(f'Muse Remove Background: missing dependency ({exc}). Install this package requirements using this ComfyUI Python environment.') from exc
        return self.engine.process_image(image.detach().float().clamp(0, 1), model,
            sensitivity=max(0., min(1., float(sensitivity))),
            process_res=max(256, min(2048, int(process_res))),
            mask_blur=max(0, min(64, int(mask_blur))),
            mask_offset=max(-64, min(64, int(mask_offset))),
            invert_output=bool(invert_output), refine_foreground=bool(refine_foreground),
            unload_model=bool(unload_model), background=background,
            background_color=colour(background_color) if background == 'Color' else '#ffffffff')
