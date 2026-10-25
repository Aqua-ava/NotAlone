"""在已有仓库外 0700 目录准备诊断副本，不改产品源码或旧证据。"""
from pathlib import Path
import hashlib
import json
import os
import re
import stat
import subprocess
import sys

repo = Path(__file__).resolve().parents[4]
private = Path(sys.argv[1]).resolve()
assert repo != private and repo not in private.parents
assert private.is_dir() and stat.S_IMODE(private.stat().st_mode) == 0o700
variants = private / 'variants'
variants.mkdir(mode=0o700)
os.symlink(repo / 'backend-ts/node_modules', variants / 'node_modules', target_is_directory=True)

def source(ref, name):
    return subprocess.check_output(['git', 'show', f'{ref}:backend-ts/src/{name}'], cwd=repo, text=True)

current = source('dd97457bdd604fbda970c6eb0e5dc406ab1157bd', 'host-storage.ts')
legacy = source('63cef611f77c2ad2a20c069dcf88ffebf38091b4', 'host-storage.ts')
setup = source('dd97457bdd604fbda970c6eb0e5dc406ab1157bd', 'wechat-setup.ts')
installation = '      if (business) trackQueryFailures(client, queryFailures);\n'
assert current.count(installation) == 1

def rewrite(match):
    target = match.group(1)
    if not target.startswith('.') or target == './host-storage.ts':
        return match.group(0)
    return "from '" + (repo / 'backend-ts/src' / target).resolve().as_uri() + "'"

adapted = re.sub(r"from '([^']+)'", rewrite, setup)
pins = {}
for name, text in [('before_contract_fix', legacy), ('current', current),
                   ('tracking_disabled', current.replace(installation, ''))]:
    directory = variants / name
    directory.mkdir(mode=0o700)
    for filename, content in [('host-storage.ts', text), ('wechat-setup.ts', adapted)]:
        path = directory / filename
        path.write_text(content)
        path.chmod(0o600)
    pins[name] = {'host_storage_sha256': hashlib.sha256(text.encode()).hexdigest(),
                  'setup_original_sha256': hashlib.sha256(setup.encode()).hexdigest(),
                  'setup_adapted_sha256': hashlib.sha256(adapted.encode()).hexdigest()}
path = private / 'variant-pins.json'
path.write_text(json.dumps(pins, indent=2) + '\n')
path.chmod(0o600)
print(json.dumps(pins, indent=2))
