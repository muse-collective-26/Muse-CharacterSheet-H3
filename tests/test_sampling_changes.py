import ast
import pathlib
import types
import unittest
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'muse_character_sheet_h3.py').read_text(encoding='utf-8')
TREE = ast.parse(SOURCE)

def functions(*names, **env):
    body = [n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name in names]
    exec(compile(ast.Module(body=body, type_ignores=[]), '<isolated helpers>', 'exec'), env)
    return env

class Changes(unittest.TestCase):
    def test_triggers(self):
        fn = functions('_prepend_trigger_words')['_prepend_trigger_words']
        for cfg in ({}, {'trigger_words_enabled': False, 'trigger_words': 'test'},
                    {'trigger_words_enabled': True, 'trigger_words': '  '}):
            self.assertEqual(fn('prompt', {}, cfg), 'prompt')
        cfg = {'trigger_words_enabled': True, 'trigger_words': '  perfe8ct, r34l1sm  '}
        self.assertEqual(fn('override', {}, cfg), 'perfe8ct, r34l1sm\noverride')
        self.assertLess(SOURCE.index('chunk_prompt = _select_chunk_from_prompt_override'),
                        SOURCE.index('chunk_prompt = _prepend_trigger_words'))

    def test_dispatch(self):
        sampler = types.SimpleNamespace(execute=Mock(return_value='sampled'))
        memory = types.SimpleNamespace(prepare=Mock())
        registry = types.ModuleType('nodes')
        registry.NODE_CLASS_MAPPINGS = {'SamplerCustomAdvanced': sampler}
        registry_patch = patch.dict('sys.modules', {'nodes': registry})
        registry_patch.start()
        self.addCleanup(registry_patch.stop)
        # No sampler global: production resolves it locally inside execute().
        fn = functions('_execute_comfy_node',
                       muse_sampling_memory=memory)['_execute_comfy_node']
        selector = types.SimpleNamespace(execute=Mock(return_value=('euler',)))
        self.assertEqual(fn(selector, sampler_name='euler'), ('euler',))
        memory.prepare.assert_not_called()
        args = dict(guider='g', latent_image='l', sigmas=[1, 0])
        self.assertEqual(fn(sampler, **args), 'sampled')
        memory.prepare.assert_called_once_with('g', 'l', [1, 0])
        memory.prepare.reset_mock()
        class Legacy:
            FUNCTION = 'run'
            def run(self, value): return value
        self.assertEqual(fn(Legacy, value=7), 7)
        memory.prepare.assert_not_called()

    def test_reference_preservation(self):
        fn = functions('_rebuild_refs_conditioning_for_stage2')['_rebuild_refs_conditioning_for_stage2']
        refs = [[None, {'minimax_refs': [{'kind': 'image', 'latent': object()}]}]]
        self.assertIs(fn(refs, None, 68, 120, 'max'), refs)

    def test_schema_and_experiment_removal(self):
        def cls(tree): return next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'MuseCharacterSheetH3')
        def attrs(tree):
            return {n.targets[0].id: ast.literal_eval(n.value) for n in cls(tree).body
                    if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name)}
        self.assertEqual(attrs(TREE)['RETURN_TYPES'], ('IMAGE', 'AUDIO', 'STRING', 'IMAGE', 'AUDIO', 'AUDIO', 'AUDIO', 'LATENT', 'MUSE_H3_REFINE_CONTEXT'))
        self.assertNotIn('test_author_refine_schedule', SOURCE)
        js = (ROOT / 'js/muse_character_sheet_h3.js').read_text(encoding='utf-8')
        self.assertNotIn('test_author_refine_schedule', js)
        self.assertIn('styleCard.appendChild(this._buildTriggerControls(chunkIdx))', js)
        self.assertIn('noise2 = _unpack_node_result(_execute_comfy_node(DisableNoise))[0]', SOURCE)

    def test_memory_old_and_new_comfy(self):
        scope = {}
        exec((ROOT / 'muse_sampling_memory.py').read_text(), scope)
        mm = types.ModuleType('comfy.model_management')
        for name in ('unload_all_models', 'free_memory', 'soft_empty_cache'):
            setattr(mm, name, Mock())
        mm.get_free_memory = lambda _: 1024
        mm.get_total_memory = lambda _: 2048
        comfy = types.ModuleType('comfy'); comfy.__path__ = []; comfy.model_management = mm
        guider = types.SimpleNamespace(model_patcher=types.SimpleNamespace(load_device='cuda'))
        modules = {'comfy': comfy, 'comfy.model_management': mm}
        with patch.dict('sys.modules', modules):
            scope['prepare'](guider, {}, [1, 0])
        mm.unload_all_models.assert_called_once()
        prefetch = types.ModuleType('comfy.model_prefetch'); prefetch.cleanup_prefetch_queues = Mock()
        with patch.dict('sys.modules', dict(modules, **{'comfy.model_prefetch': prefetch})):
            scope['prepare'](guider, {}, [1, 0])
            prefetch.cleanup_prefetch_queues.assert_called_once()
            prefetch.cleanup_prefetch_queues.reset_mock()
            scope['prepare'](guider, {}, [0])
            prefetch.cleanup_prefetch_queues.assert_not_called()

if __name__ == '__main__': unittest.main(verbosity=2)
