import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

@unittest.skipUnless(shutil.which('powershell.exe'), 'Windows PowerShell required')
class WindowsLayoutTests(unittest.TestCase):
    def layout(self, nested=False, incomplete=False, standalone=False):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / 'Comfy UI with spaces'
            (base / 'custom_nodes').mkdir(parents=True)
            (base / 'main.py').touch()
            package = base / 'custom_nodes' / 'Muse-CharacterSheet-H3-master'
            if nested:
                package /= 'Muse-CharacterSheet-H3-master'
            if standalone:
                package = Path(tmp) / 'Downloads' / 'Muse-CharacterSheet-H3'
            (package / 'Installers').mkdir(parents=True)
            for name in ('__init__.py', 'requirements.txt', 'Installers/install_dependencies.py', 'Installers/dependencies.json'):
                if not (incomplete and name == '__init__.py'):
                    (package / name).touch()
            script = package / 'Installers/launch_windows.ps1'
            shutil.copyfile(ROOT / 'Installers/launch_windows.ps1', script)
            return subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script), '-CheckLayout'], capture_output=True, text=True)

    def test_normal_master_folder_and_spaces(self):
        result = self.layout()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Package layout OK', result.stdout)

    def test_double_nested_reports_exact_inner_folder(self):
        result = self.layout(nested=True)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn('EXTRA FOLDER LEVEL', result.stdout)
        self.assertIn('Move THAT WHOLE inner folder', result.stdout)

    def test_incomplete_package(self):
        result = self.layout(incomplete=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Incomplete package', result.stdout)

    def test_downloads_location(self):
        result = self.layout(standalone=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Move the WHOLE folder', result.stdout)
