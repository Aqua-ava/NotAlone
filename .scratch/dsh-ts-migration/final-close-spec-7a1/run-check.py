"""固定树最小验证；原始输出仅保存在仓库外私有目录。"""
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
parser.add_argument('--context', type=Path, required=True)
parser.add_argument('name')
parser.add_argument('--base', action='store_true')
parser.add_argument('--cwd', choices=['backend-ts', 'desktop'], default='desktop')
parser.add_argument('args', nargs=argparse.REMAINDER)
args = parser.parse_args()
out = Path(__file__).resolve().parent
state = json.loads(args.context.read_text())
private = Path(state['private'])
root = Path(state['baseline' if args.base else 'snapshot'])
argv = args.args[1:] if args.args and args.args[0] == '--' else args.args
environment = {
    'PATH': str(Path(state['node']).parent) + ':/usr/bin:/bin:/usr/sbin',
    'HOME': str(private / 'home'), 'TMPDIR': str(private / 'tmp'),
    'USER': pwd.getpwuid(os.getuid()).pw_name,
    'LANG': 'en_US.UTF-8', 'NOTALONE_REVIEW_ROOT': str(root),
    'NOTALONE_DISABLE_DOTENV': '1', 'NO_COLOR': '1',
}
os.umask(0o077)
raw_path = private / 'logs' / (args.name + '.raw.log')
started = time.monotonic()
command = [state['node'], '--import', str(out / 'local-only.mjs'), *argv]
with raw_path.open('wb') as log:
    try:
        run = subprocess.run(command, cwd=root / args.cwd, env=environment,
                             stdout=log, stderr=subprocess.STDOUT, timeout=110)
        code = run.returncode
    except subprocess.TimeoutExpired:
        code = 124
raw_path.chmod(0o600)
raw = raw_path.read_bytes()
text = raw.decode('utf-8', errors='replace')
counts = {k: int(v) for k, v in re.findall(r'^[#ℹ] (tests|pass|fail|cancelled|skipped) (\d+)$', text, re.M)}
public = []
for line in text.splitlines():
    if re.match(r'^(?:[✔✖ℹ]|ok \d|not ok \d|# (?:tests|pass|fail|cancelled|skipped|duration_ms))', line):
        public.append(line)
public_text = '\n'.join(public) + '\n'
public_path = out / (args.name + '.public.log')
public_path.write_text(public_text)
record = dict(name=args.name, commit='283a609f5f48503657bef571c0ea9539d4ee7b76' if args.base else '7a1f58a679245c6df84d88dfaafc3ff2c352c290',
              exit_code=code, duration_seconds=round(time.monotonic()-started, 3), counts=counts,
              command=['node', '--import', 'local-only.mjs', *[str(a).replace(str(out), '<review>').replace(str(private), '<private>') for a in argv]],
              raw_sha256=hashlib.sha256(raw).hexdigest(), public_sha256=hashlib.sha256(public_text.encode()).hexdigest(),
              raw_mode=oct(raw_path.stat().st_mode & 0o777), synthetic_only=True,
              runner_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              guard_sha256=hashlib.sha256((out / 'local-only.mjs').read_bytes()).hexdigest(),
              test_sources=[dict(path=str(p).replace(str(out), '<review>').replace(str(private), '<private>'),
                                 sha256=hashlib.sha256(p.read_bytes()).hexdigest())
                            for arg in argv for p in [Path(arg) if Path(arg).is_absolute() else root / args.cwd / arg]
                            if arg.endswith('.mjs') and p.is_file()],
              environment_inherited=False, network_scope='localhost_and_owned_local_postgresql')
(out / (args.name + '.json')).write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(record, ensure_ascii=False))
print(public_text)
