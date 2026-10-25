"""仅运行固定源码和合成夹具，原始日志保留在仓库外。"""
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
private = Path(json.loads(Path('/tmp/notalone-standards-7a1-pointer.json').read_text())['private'])
config = json.loads((private / 'config.json').read_text())
public = Path(__file__).resolve().parent
label, area, *arguments = sys.argv[1:]
assert re.fullmatch(r'[a-z0-9-]+', label)
assert area in ('backend-ts', 'desktop')
fixed = private / 'target'
records = private / f'{label}.ownership.json'
records.write_text(json.dumps({'created': [], 'dropRequested': []}))
records.chmod(0o600)
(private / 'tmp').mkdir(exist_ok=True, mode=0o700)
environment = {key: os.environ[key] for key in ('HOME', 'USER', 'LOGNAME', 'LANG') if key in os.environ}
environment.update(PATH=str(Path(config['node']).parent) + ':/usr/bin:/bin',
                   TMPDIR=str(private / 'tmp'), NOTALONE_DISABLE_DOTENV='1',
                   NOTALONE_REVIEW_FIXED_ROOT=str(fixed), NOTALONE_REVIEW_RECORDS=str(records),
                   NOTALONE_REVIEW_REPO=config['repo'],
                   NOTALONE_REVIEW_BASELINE_URL=(private / 'base/backend-ts/src/host-storage.ts').as_uri())
command = [config['node'], '--import=' + str(public / 'local-only.mjs'), *arguments]
raw = private / f'{label}.raw.log'
started = time.monotonic()
with raw.open('xb') as stream:
    process = subprocess.Popen(command, cwd=fixed / area, env=environment,
                               stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        code = process.wait(timeout=90)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        code = 124
raw.chmod(0o600)
data = raw.read_bytes()
sanitized = data.decode('utf-8', 'replace').replace(str(private), '<private>')
sanitized = sanitized.replace(config['repo'], '<repository>').replace(os.path.expanduser('~'), '<home>')
log = public / f'{label}.public.log'
log.write_text(sanitized)
counts = {}
for name in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'):
    match = re.search(r'^#?\s*' + name + r'\s+(\d+)\s*$', sanitized, re.M)
    if not match:
        match = re.search(r'^ℹ\s*' + name + r'\s+(\d+)\s*$', sanitized, re.M)
    if match:
        counts[name] = int(match.group(1))
ownership = json.loads(records.read_text())
result = {'label': label, 'base_commit': config['pins']['base'], 'target_commit': config['pins']['target'],
          'cwd': area, 'command': ['node', '--import=local-only.mjs', *[a.replace(str(public), '<review>') for a in arguments]],
          'exit_code': code, 'duration_seconds': round(time.monotonic()-started, 3), 'counts': counts,
          'raw_sha256': hashlib.sha256(data).hexdigest(),
          'public_sha256': hashlib.sha256(log.read_bytes()).hexdigest(),
          'created_database_count': len(ownership['created']),
          'drop_requested_count': len(ownership['dropRequested']),
          'raw_directory_mode': oct(private.stat().st_mode & 0o777),
          'raw_file_mode': oct(raw.stat().st_mode & 0o777)}
(public / f'{label}.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
print(json.dumps(result, ensure_ascii=False))
print('\n'.join(sanitized.splitlines()[-35:]))
sys.exit(code)
