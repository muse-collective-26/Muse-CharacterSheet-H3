from .muse_character_sheet_h3 import NODE_CLASS_MAPPINGS as _H3_NODES, NODE_DISPLAY_NAME_MAPPINGS as _H3_NAMES
from .character_sheet_compositor import NODE_CLASS_MAPPINGS as _COMPOSITOR_NODES, NODE_DISPLAY_NAME_MAPPINGS as _COMPOSITOR_NAMES

WEB_DIRECTORY = "./js"

from .muse_save_text import MuseSaveText
from .muse_images_to_rgb import MuseImagesToRGB
from .muse_remove_background.nodes import MuseRemoveBackground

NODE_CLASS_MAPPINGS = {**_H3_NODES, **_COMPOSITOR_NODES}
NODE_DISPLAY_NAME_MAPPINGS = {**_H3_NAMES, **_COMPOSITOR_NAMES}
NODE_CLASS_MAPPINGS.update(MuseSaveText=MuseSaveText, MuseImagesToRGB=MuseImagesToRGB,
                           MuseRemoveBackground=MuseRemoveBackground)
NODE_DISPLAY_NAME_MAPPINGS.update(MuseSaveText="Muse Save Text", MuseImagesToRGB="Muse Images to RGB",
                                  MuseRemoveBackground="Muse Remove Background")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
