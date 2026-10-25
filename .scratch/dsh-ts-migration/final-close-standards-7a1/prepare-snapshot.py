"""重新准备可复跑的固定 Git 快照，不读取工作区私有配置。"""
import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--node', type=Path, required=True)
args = parser.parse_args()
os.umask(0o077)
public = Path(__file__).resolve().parent
repo = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
private = Path(tempfile.mkdtemp(prefix='notalone-standards-7a1-'))
private.chmod(0o700)
pins = {'base': '283a609f5f48503657bef571c0ea9539d4ee7b76',
        'target': '7a1f58a679245c6df84d88dfaafc3ff2c352c290'}
paths = ['backend-ts/src', 'backend-ts/test', 'backend-ts/package.json', 'backend-ts/tsconfig.json',
         'backend-ts/pnpm-lock.yaml', 'backend/database/migrations', 'desktop/src', 'desktop/package.json',
         'desktop/tsconfig.json', 'desktop/tests/assistant-generation-preparation-stop.test.mjs',
         'desktop/tests/assistant-generation-stop.test.mjs', 'desktop/tests/inventory.json']
for label, pin in pins.items():
    root = private / label
    root.mkdir(mode=0o700)
    existing = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', pin, '--', *paths], text=True).splitlines()
    archive = subprocess.check_output(['git', 'archive', pin, *existing])
    with tarfile.open(fileobj=io.BytesIO(archive)) as files:
        for member in files:
            if not member.isfile():
                continue
            destination = root / member.name
            assert destination.resolve().is_relative_to(root)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(files.extractfile(member).read())
            destination.chmod(0o600)
    for part in ('backend-ts', 'desktop'):
        (root / part / 'node_modules').symlink_to(repo / part / 'node_modules', target_is_directory=True)
config = {'private': str(private), 'repo': str(repo), 'out': str(public), 'pins': pins, 'node': str(args.node.resolve(strict=True))}
(private / 'config.json').write_text(json.dumps(config))
(private / 'config.json').chmod(0o600)
pointer = Path('/tmp/notalone-standards-7a1-pointer.json')
pointer.write_text(json.dumps({'private': str(private)}))
pointer.chmod(0o600)
print(json.dumps({'base': pins['base'], 'target': pins['target'], 'snapshots_ready': True}))
