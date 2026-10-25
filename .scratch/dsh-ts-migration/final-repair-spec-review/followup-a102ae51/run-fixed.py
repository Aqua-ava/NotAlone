"""在仓库外的固定快照运行有限回归，并保留原始／脱敏摘要。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--control', required=True)
parser.add_argument('--snapshot', choices=['base', 'target'], default='target')
parser.add_argument('--label', required=True)
parser.add_argument('--pattern')
parser.add_argument('files', nargs='+')
args = parser.parse_args()
assert re.fullmatch(r'[a-z0-9-]+', args.label)
control = json.loads(Path(args.control).read_text())
raw, out = Path(control['raw']), Path(control['public'])
snapshot = raw / args.snapshot
guard = raw / (args.label + '.guard.jsonl')
command = [control['node'], '--import', str(out / 'local-guard.mjs'), '--test', '--test-concurrency=1']
if args.pattern:
    command += ['--test-name-pattern', args.pattern]
command += args.files
environment = {
    'HOME': str(Path.home()), 'USER': pwd.getpwuid(os.getuid()).pw_name,
    'PATH': str(Path(control['node']).parent) + ':/usr/bin:/bin',
    'LC_ALL': 'C', 'LANG': 'en_US.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1',
    'NOTALONE_DISABLE_DOTENV': '1', 'NOTALONE_TEST_PYTHON': control['python'],
    'REVIEW_SNAPSHOT': str(snapshot), 'REVIEW_GUARD_LOG': str(guard),
}
log = raw / (args.label + '.raw.log')
start = time.monotonic()
with log.open('x') as stream:
    os.chmod(log, 0o600)
    try:
        result = subprocess.run(command, cwd=snapshot / 'backend-ts', env=environment,
                                stdout=stream, stderr=subprocess.STDOUT, timeout=180)
        code = result.returncode
    except subprocess.TimeoutExpired:
        code = 124
data = log.read_bytes()
public = data.decode('utf-8', errors='replace')
for source, replacement in [(str(raw), '$REVIEW_TMP'), (control['repository'], '$REPO'), (str(Path.home()), '$HOME')]:
    public = public.replace(source, replacement)
public = re.sub(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b',
                '<synthetic-id>', public, flags=re.I)
(out / (args.label + '.public.log')).write_text(public)
receipt = {
    'name': args.label, 'snapshot': args.snapshot,
    'argv': ['$NODE', '--import', 'local-guard.mjs'] + command[3:],
    'guard_source_sha256': hashlib.sha256((out / 'local-guard.mjs').read_bytes()).hexdigest(),
    'runner_source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'exit_code': code, 'elapsed_seconds': round(time.monotonic() - start, 3),
    'environment': '显式白名单；USER 取有效系统用户，不记录其值；不继承模型或数据库配置',
    'raw_sha256': hashlib.sha256(data).hexdigest(),
    'public_sha256': hashlib.sha256(public.encode()).hexdigest(),
    'guard_raw_sha256': hashlib.sha256(guard.read_bytes()).hexdigest() if guard.exists() else None,
    'summary': [line for line in public.splitlines() if re.match(r'[ℹ#] (tests|suites|pass|fail|cancelled|skipped|todo|duration)', line)],
}
(out / (args.label + '.json')).write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(receipt, ensure_ascii=False))
print('\n'.join(public.splitlines()[-20:]))
raise SystemExit(code)
