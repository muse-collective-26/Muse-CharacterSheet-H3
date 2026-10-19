"""Explicit dependency setup. Run with the target ComfyUI's Python, not system Python."""
import argparse
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent


def run(args):
    print(' '.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), check=True)


def packages(enhanced):
    return [p for p in json.loads((HERE / 'dependencies.json').read_text())
            if enhanced or not p.get('enhanced_only')]


def locate(custom, package):
    """Find alternate directory names via Git origin; never make duplicate installs."""
    wanted = package['repo'].lower()
    matches = []
    for path in custom.iterdir():
        if not path.is_dir():
            continue
        named = path.name.lower() == package['folder'].lower()
        config = path / '.git' / 'config'
        same_repo = config.is_file() and wanted in config.read_text(errors='replace').lower()
        if named or same_repo:
            matches.append(path)
    if len(matches) > 1:
        raise RuntimeError(f'Duplicate {wanted} installs: {matches}. Resolve these before continuing.')
    return matches[0] if matches else custom / package['folder']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--comfyui', required=True, type=Path)
    parser.add_argument('--enhanced', action='store_true', help='Also install the DLSS node pack (NOT its runtime).')
    parser.add_argument('--install', action='store_true', help='Without this flag only print the plan.')
    args = parser.parse_args()
    root = args.comfyui.resolve()
    if not (root / 'main.py').is_file() or not (root / 'custom_nodes').is_dir():
        parser.error('Expected the ComfyUI folder containing main.py and custom_nodes.')
    plan = [(p, locate(root / 'custom_nodes', p)) for p in packages(args.enhanced)]
    print(f'ComfyUI: {root}\nPython: {sys.executable}')
    for p, dest in plan:
        print(f'{"KEEP" if dest.exists() else "CLONE"}: {p["repo"]} -> {dest}')
    if not args.install:
        print('Plan only. Close ComfyUI; rerun with --install to apply.')
        return
    # Do not silently replace the working GPU/PyTorch stack via dependency resolution.
    pins = []
    for name in ('torch', 'torchvision', 'torchaudio'):
        try:
            pins.append(f'{name}=={importlib.metadata.version(name)}')
        except importlib.metadata.PackageNotFoundError:
            if name == 'torch':
                parser.error('PyTorch missing. Run this with the Python belonging to ComfyUI.')
    with tempfile.TemporaryDirectory(prefix='muse-h3-deps-') as temp:
        constraints = Path(temp) / 'constraints.txt'
        constraints.write_text('\n'.join(pins) + '\n')
        for p, dest in plan:
            if not dest.exists():
                run(['git', 'clone', 'https://github.com/' + p['repo'] + '.git', dest])
            requirements = dest / 'requirements.txt'
            if requirements.is_file():
                run([sys.executable, '-m', 'pip', 'install', '-c', constraints, '-r', requirements])
        run([sys.executable, '-m', 'pip', 'install', '-c', constraints, '-r', HERE.parent / 'requirements.txt'])
    print('Dependency commands finished. Existing packages were retained, not updated.')
    print('Restart ComfyUI and check missing nodes/models before rendering. This is NOT a render certification.')
    print('GGUF and H3 Multishot node packages are included. Model weights and SageAttention binaries are not; see INSTALLATION.md.')
    if args.enhanced:
        print('DLSS runtime is NOT installed. Follow INSTALLATION.md before using Enhanced.')


if __name__ == '__main__':
    main()
