import numpy as np
import torch
from PIL import Image

def get_device():
    import comfy.model_management as mm
    return mm.get_torch_device()

def unload_model(loader, attr_name='model'):
    model = getattr(loader, attr_name, None)
    if model is not None:
        model.to('cpu')
    setattr(loader, attr_name, None)
    loader.current_model_version = None
    import comfy.model_management as mm
    mm.soft_empty_cache()

def tensor2pil(tensor):
    arr = tensor.detach().float().cpu().numpy()
    if arr.ndim == 4 and arr.shape[0] == 1:
        arr = arr[0]
    if arr.ndim == 3 and arr.shape[-1] == 1:
        arr = arr[..., 0]
    return Image.fromarray(np.clip(arr * 255, 0, 255).astype(np.uint8))

def pil2tensor(image):
    return torch.from_numpy(np.asarray(image).astype(np.float32) / 255).unsqueeze(0)
