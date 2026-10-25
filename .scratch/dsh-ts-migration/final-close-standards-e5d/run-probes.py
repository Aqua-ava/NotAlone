"""固定 e5d 源码，复用原独立 RED 并运行两个最小交错探针。"""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

os.umask(0o077)
pointer = json.loads(Path('/tmp/notalone-standards-e5d-pointer.json').read_text())
private = Path(pointer['private'])
config = json.loads((private / 'config.json').read_text())
public = Path(__file__).resolve().parent
prior = Path(config['repo']) / '.scratch/dsh-ts-migration/final-close-standards-7a1'
cases = [prior / 'same-key-retry.test.mjs', prior / 'same-key-ipc.test.mjs', public / 'late-receipt-boundaries.test.mjs']
label = 'probes'
if sys.argv[1:] == ['ipc']:
    cases = [prior / 'same-key-ipc.test.mjs']
    label = 'ipc'
environment = {key: os.environ[key] for key in ('HOME', 'USER', 'LOGNAME', 'LANG') if key in os.environ}
(private / 'tmp').mkdir(mode=0o700, exist_ok=True)
environment.update(PATH=str(Path(config['node']).parent) + ':/usr/bin:/bin',
                   TMPDIR=str(private / 'tmp'), NOTALONE_DISABLE_DOTENV='1',
                   NOTALONE_REVIEW_FIXED_ROOT=config['fixed'])
command = [config['node'], '--import=' + str(public / 'local-only.mjs'),
           '--test-reporter=tap', '--test', *map(str, cases)]
raw = private / f'{label}.raw.log'
started = time.monotonic()
with raw.open('xb') as stream:
    process = subprocess.Popen(command, cwd=Path(config['fixed']) / 'desktop', env=environment,
                               stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        code = process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
        code = 124
raw.chmod(0o600)
original = raw.read_bytes()
sanitized = original.decode('utf8', 'replace').replace(config['repo'], '<repository>')
sanitized = sanitized.replace(str(private), '<private>').replace(os.path.expanduser('~'), '<home>')
sanitized = re.sub(r'data:text/javascript;base64,[A-Za-z0-9+/=]+', '<compiled-module>', sanitized)
log = public / f'{label}.public.log'
log.write_text(sanitized)
counts = {name: int(re.search(r'^# ' + name + r' (\d+)$', sanitized, re.M).group(1))
          for name in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')}
result = {'base_commit': config['pins']['base'], 'target_commit': config['pins']['target'],
          'command': ['node', '--import=<review>/local-only.mjs', '--test-reporter=tap', '--test',
                      *[str(path.relative_to(config['repo'])) for path in cases]],
          'cwd': 'fixed/desktop', 'exit_code': code, 'counts': counts,
          'duration_seconds': round(time.monotonic()-started, 3),
          'raw_sha256': hashlib.sha256(original).hexdigest(),
          'public_sha256': hashlib.sha256(log.read_bytes()).hexdigest(),
          'raw_directory_mode': oct(private.stat().st_mode & 0o777),
          'raw_file_mode': oct(raw.stat().st_mode & 0o777),
          'cases': [{'path': str(path.relative_to(config['repo'])),
                     'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in cases]}
(public / f'{label}.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
print(json.dumps(result, ensure_ascii=False))
print('\n'.join(line[:500] for line in sanitized.splitlines()[-45:]))
raise SystemExit(code)
