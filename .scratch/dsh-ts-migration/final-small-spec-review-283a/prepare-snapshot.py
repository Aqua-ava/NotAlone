"""重建本审查的固定树；仅导出代码和合成测试，证据另放仓库外。"""
import argparse
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--node', required=True)
parser.add_argument('--python', required=True)
args = parser.parse_args()
review = Path(__file__).resolve().parent
repository = review.parents[2]
private = Path(tempfile.mkdtemp(prefix='notalone-spec-283a-'))
private.chmod(0o700)
for name in ('snapshot', 'logs', 'tmp', 'evidence'):
    (private / name).mkdir(mode=0o700)
paths = ['backend-ts', 'backend/src', 'backend/database', 'desktop/src',
         'desktop/package.json', 'desktop/tsconfig.json', 'desktop/managed-runtime-contract.mjs',
         '.scratch/dsh-ts-migration/ticket25-final-run/bridge.py',
         '.scratch/dsh-ts-migration/reply-budget-continuation/test_bridge.py',
         '.scratch/dsh-ts-migration/final-repair-spec-review/followup-a102ae51/query-probe.test.mjs']
archive = subprocess.check_output(['git', '-C', str(repository), 'archive',
                                   '283a609f5f48503657bef571c0ea9539d4ee7b76', '--', *paths])
with tarfile.open(fileobj=io.BytesIO(archive)) as source:
    source.extractall(private / 'snapshot')
for component in ('backend-ts', 'desktop'):
    (private / 'snapshot' / component / 'node_modules').symlink_to(repository / component / 'node_modules', target_is_directory=True)
for name in ('local-only.mjs', 'independent.test.mjs', 'run-checks.py'):
    shutil.copyfile(review / name, private / 'evidence' / name)
context = dict(private=str(private), snapshot=str(private / 'snapshot'), out=str(private / 'evidence'),
               node=str(Path(args.node).resolve()), python=str(Path(args.python).resolve()))
context_file = private / 'context.json'
context_file.write_text(json.dumps(context))
context_file.chmod(0o600)
print(context_file)
