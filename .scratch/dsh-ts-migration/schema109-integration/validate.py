"""在临时项目中验证109门禁，不改产品或业务库。"""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path.cwd()
draft = root / '.scratch/dsh-ts-migration/schema109-integration'
red = '--red' in sys.argv
with tempfile.TemporaryDirectory(prefix='notalone-schema109-') as directory:
    temp = Path(directory)
    for name in ('backend-ts/src', 'backend-ts/test', 'backend/database/migrations'):
        (temp / name).mkdir(parents=True)
    for name in ('backend-ts/node_modules', 'backend-ts/package.json', 'backend/src'):
        (temp / name).symlink_to(root / name)
    for source in (root / 'backend/database/migrations').glob('*.sql'):
        shutil.copyfile(source, temp / 'backend/database/migrations' / source.name)
    sql = root / '.scratch/dsh-ts-migration/auto-read-deletion/draft/backend/database/migrations/109_wechat_auto_read_suppression.sql'
    shutil.copyfile(sql, temp / 'backend/database/migrations' / sql.name)
    source = root / 'backend-ts/src/host-storage.ts' if red else draft / 'draft/backend-ts/src/host-storage.ts'
    shutil.copyfile(source, temp / 'backend-ts/src/host-storage.ts')
    shutil.copyfile(draft / 'auto-read-suppression-migration.test.mjs', temp / 'backend-ts/test/auto-read-suppression-migration.test.mjs')
    tests = ['test/auto-read-suppression-migration.test.mjs']
    if not red:
        shutil.copyfile(root / 'backend-ts/test/host-storage-fixture.mjs', temp / 'backend-ts/test/host-storage-fixture.mjs')
        for name in ('host-storage.test.mjs', 'host-read-transaction.test.mjs'):
            shutil.copyfile(draft / 'draft/backend-ts/test' / name, temp / 'backend-ts/test' / name)
            tests.append('test/' + name)
    node = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
    result = subprocess.run([str(node), '--test', '--test-concurrency=1', *tests], cwd=temp / 'backend-ts', timeout=120)
    raise SystemExit(result.returncode)
