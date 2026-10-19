import ast
import json
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]

class BundleTests(unittest.TestCase):
    def test_nodes_and_no_legacy(self):
        for path in (ROOT/'workflows').glob('*.json'):
            w=json.loads(path.read_text(encoding='utf8'))
            nodes=[n for g in [w]+w.get('definitions',{}).get('subgraphs',[]) for n in g['nodes']]
            types=[n['type'] for n in nodes]
            for old in ['Save Text File','Images to RGB','RMBG']:self.assertNotIn(old,types)
            self.assertEqual(types.count('MuseSaveText'),1)
            self.assertEqual(types.count('MuseImagesToRGB'),5)
            self.assertEqual(types.count('MuseRemoveBackground'),5)
    def test_requirements_and_source(self):
        self.assertIn('-r muse_remove_background/requirements.txt',(ROOT/'requirements.txt').read_text())
        deps=json.loads((ROOT/'Installers/dependencies.json').read_text())
        self.assertFalse(any(p['folder'].lower() in ('was-ns','comfyui-rmbg') for p in deps))
        for p in [ROOT/'muse_save_text.py',ROOT/'muse_images_to_rgb.py',*list((ROOT/'muse_remove_background').glob('*.py'))]:
            ast.parse(p.read_text(encoding='utf8'))
        self.assertTrue((ROOT/'muse_remove_background/LICENSE').is_file())

if __name__=='__main__':unittest.main()
