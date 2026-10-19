import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class WorkflowTests(unittest.TestCase):
    def test_portable_optional_nodes(self):
        for path in (ROOT / 'workflows').glob('*.json'):
            w = json.loads(path.read_text(encoding='utf8'))
            for g in [w] + w.get('definitions', {}).get('subgraphs', []):
                for n in g['nodes']:
                    if n['type'] == 'MiniMaxH3RefModsLoader':
                        self.assertTrue(all(n['widgets_values'][1+i*3] == '(none)' for i in range(8)))
                    if n['type'] == 'RMBG':
                        self.assertEqual(n['widgets_values'][7:10], [False, 'Color', '#ffffff'])

    def test_workflows(self):
        for filename in ('H3 Character Sheet.json', 'H3 Character Sheet Enhanced.json'):
            w = json.loads((ROOT / 'workflows' / filename).read_text(encoding='utf8'))
            for g in [w] + w['definitions']['subgraphs']:
                nodes = {n['id']: n for n in g['nodes']}
                links = {l['id'] if isinstance(l, dict) else l[0]: l for l in g['links']}
                self.assertEqual(len(links), len(g['links']))
                for link in links.values():
                    if isinstance(link, dict):
                        lid, src, ss, dst, ds, kind = (link[k] for k in ('id', 'origin_id', 'origin_slot', 'target_id', 'target_slot', 'type'))
                    else:
                        lid, src, ss, dst, ds, kind = link
                    out = g['inputs'][ss] if src == -10 else nodes[src]['outputs'][ss]
                    inp = g['outputs'][ds] if dst == -20 else nodes[dst]['inputs'][ds]
                    self.assertIn(lid, out['linkIds' if src == -10 else 'links'])
                    self.assertTrue(lid in inp['linkIds'] if dst == -20 else lid == inp['link'])
                    self.assertTrue(out['type'] == inp['type'] or '*' in (out['type'], inp['type']))
                for n in nodes.values():
                    self.assertNotEqual(n.get('properties', {}).get('cnr_id'), 'comfyui-workflow-encrypt')
                    for inp in n.get('inputs', []):
                        if inp.get('link') is not None:
                            self.assertIn(inp['link'], links)
                    for out in n.get('outputs', []):
                        for lid in out.get('links') or []:
                            self.assertIn(lid, links)

    def test_enhanced_settings(self):
        w = json.loads((ROOT / 'workflows/H3 Character Sheet Enhanced.json').read_text(encoding='utf8'))
        h3 = next(n for n in w['nodes'] if n['type'] == 'MuseCharacterSheetH3')
        self.assertEqual(h3['widgets_values_named']['steps'], 10)
        loader = next(n for n in w['nodes'] if n['type'] == 'MuseMiniMaxH3UnifiedLoader')
        self.assertIn('ref2v_turbo_8step', loader['widgets_values_named']['lora_1'])
        self.assertEqual(h3['outputs'].__len__(), 9)
        self.assertEqual(loader['widgets_values'][26:28], [False, False])
        self.assertFalse(loader['widgets_values_named']['sage_attention'])
        self.assertFalse(loader['widgets_values_named']['high_res_stability'])
        self.assertTrue(all(g['links'] for g in w['definitions']['subgraphs']))

    def test_enhanced_preview_sources_are_direct(self):
        w = json.loads((ROOT / 'workflows/H3 Character Sheet Enhanced.json').read_text(encoding='utf8'))
        previews = []
        for graph in [w] + w['definitions']['subgraphs']:
            nodes = {n['id']: n for n in graph['nodes']}
            links = {l['id'] if isinstance(l, dict) else l[0]: l for l in graph['links']}
            for node in graph['nodes']:
                if node['type'] != 'PreviewImage':
                    continue
                previews.append(node)
                link = links[node['inputs'][0]['link']]
                origin = link['origin_id'] if isinstance(link, dict) else link[1]
                self.assertEqual(nodes[origin]['type'], 'DLSS5EnhanceImages')
        self.assertEqual(len(previews), 5)


class InstallerTests(unittest.TestCase):
    def test_dlss_offer_uses_correct_url_and_preserves_confirmation(self):
        installer = module('installer_dlss', ROOT / 'Installers/install_dependencies.py')
        with tempfile.TemporaryDirectory() as tmp:
            custom = Path(tmp)
            folder = custom / 'ComfyUI-DLSS5-Enhancer'
            folder.mkdir()
            script = folder / 'install_runtime.py'
            script.touch()
            with patch('builtins.input', return_value='y'), patch.object(installer, 'run') as run:
                installer.offer_dlss_runtime(custom)
                run.assert_called_once_with([installer.sys.executable, script, '--url', 'https://github.com/Merserk/dlss5-visual-enhancer/releases/download/v3.0/DLSS.5.Visual.Enhancer.v3.0.zip'])
            with patch('builtins.input', return_value='n'), patch.object(installer, 'run') as run:
                installer.offer_dlss_runtime(custom)
                run.assert_not_called()

    def test_selection_and_existing_alias(self):
        installer = module('installer', ROOT / 'Installers/install_dependencies.py')
        self.assertEqual(len(installer.packages(False)), 9)
        self.assertEqual(len(installer.packages(True)), 10)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            alias = root / 'different-name'
            (alias / '.git').mkdir(parents=True)
            (alias / '.git/config').write_text('url = https://github.com/kijai/ComfyUI-KJNodes.git')
            p = next(p for p in installer.packages(False) if p['folder'] == 'ComfyUI-KJNodes')
            self.assertEqual(installer.locate(root, p), alias)
            (root / p['folder']).mkdir()
            with self.assertRaises(RuntimeError):
                installer.locate(root, p)

    def test_dry_run_does_not_install(self):
        installer = module('installer_dry', ROOT / 'Installers/install_dependencies.py')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'main.py').touch()
            (root / 'custom_nodes').mkdir()
            with patch('sys.argv', ['installer', '--comfyui', tmp, '--enhanced']), patch.object(installer, 'run') as run:
                installer.main()
                run.assert_not_called()

    def test_missing_upscaler_is_installed_in_both_modes(self):
        installer = module('installer_upscaler', ROOT / 'Installers/install_dependencies.py')
        repo = 'LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler'
        for enhanced in (False, True):
            with self.subTest(enhanced=enhanced), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / 'main.py').touch()
                custom = root / 'custom_nodes'
                custom.mkdir()
                package = next(p for p in installer.packages(enhanced) if p['repo'] == repo)
                self.assertIn('MinimaxH3LatentUpscaler3D', package['nodes'])
                # Reproduce this install: every other package already present.
                for p in installer.packages(enhanced):
                    if p != package:
                        (custom / p['folder']).mkdir()
                argv = ['installer', '--comfyui', tmp, '--install']
                if enhanced:
                    argv.append('--enhanced')
                with patch('sys.argv', argv), patch.object(installer, 'run') as run, patch.object(installer.importlib.metadata, 'version', return_value='2.9.1'):
                    installer.main()
                clones = [c.args[0] for c in run.call_args_list if c.args[0][0] == 'git']
                self.assertEqual(clones, [['git', 'clone', 'https://github.com/' + repo + '.git', custom / package['folder']]])


class CompositorTests(unittest.TestCase):
    def test_rgb_and_rgba(self):
        import torch
        import numpy as np
        from PIL import Image
        compositor = module('compositor', ROOT / 'character_sheet_compositor.py')
        rgb = torch.rand(1, 32, 24, 3)
        old = Image.fromarray(rgb[0].clamp(0, 1).mul(255).round().to(torch.uint8).numpy(), mode='RGB')
        self.assertTrue(np.array_equal(np.array(old), np.array(compositor._tensor_to_pil(rgb))))
        rgba = torch.zeros(1, 32, 24, 4)
        self.assertEqual(compositor._tensor_to_pil(rgba).getpixel((0, 0)), (255, 255, 255))
        self.assertEqual(compositor._tensor_to_pil(rgba, (0, 0, 0)).getpixel((0, 0)), (0, 0, 0))
        for data in (rgb, rgba):
            output = compositor.MuseCharacterSheetCompositor().execute(data, data, data, data, data, 320, 60, 12, 'white')[0]
            self.assertEqual(output.shape[-1], 3)
            self.assertEqual(output.shape[1], 344)
        with self.assertRaises(ValueError):
            compositor._tensor_to_pil(torch.zeros(1, 32, 24, 2))


if __name__ == '__main__':
    unittest.main()
