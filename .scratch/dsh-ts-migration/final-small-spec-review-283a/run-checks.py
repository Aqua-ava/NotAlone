"""固定树的最小分层验证；原日志在仓库外，公开日志只保留脱敏副本。"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

context = json.loads(Path(sys.argv[1]).read_text())
step = sys.argv[2]
snapshot, private, output = (Path(context[key]) for key in ('snapshot', 'private', 'out'))
node, python = context['node'], context['python']
guard = str(output / 'local-only.mjs')
environment = {key: os.environ[key] for key in ('HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ') if key in os.environ}
environment.update(PATH=str(Path(node).parent) + ':/usr/bin:/bin', TMPDIR=str(private / 'tmp'),
                   NOTALONE_DISABLE_DOTENV='1', NOTALONE_TEST_PYTHON=python,
                   PYTHONPATH=str(snapshot / 'backend/src'), REVIEW_SNAPSHOT=str(snapshot))
commands = {
    'single': [node, '--import', guard, '--test', '--test-name-pattern', '配置内回调原样保留继承和非枚举字段', 'test/business-transaction-errors.test.mjs'],
    'connection-control': [node, '--import', guard, '--test', '--test-name-pattern', '连接尚未建立时失败仍受控', 'test/business-transaction-errors.test.mjs'],
    'related': [node, '--import', guard, '--test', '--test-concurrency=1', 'test/business-transaction-errors.test.mjs', 'test/assistant-generation-publication.test.mjs', 'test/pure-ts-reply.test.mjs'],
    'prior-query-control': [node, '--import', guard, '--test', str(snapshot / '.scratch/dsh-ts-migration/final-repair-spec-review/followup-a102ae51/query-probe.test.mjs')],
    'budget': [python, str(snapshot / '.scratch/dsh-ts-migration/reply-budget-continuation/test_bridge.py'), '-v'],
    'independent': [node, '--import', guard, '--test', str(output / 'independent.test.mjs')],
    'independent-cancel': [node, '--import', guard, '--test', '--test-name-pattern', '在途取消', str(output / 'independent.test.mjs')],
    'independent-continuation': [node, '--import', guard, '--test', '--test-name-pattern', '中断重试恢复', str(output / 'independent.test.mjs')],
}
command = commands[step]
raw = private / 'logs' / (step + '.log')
started = time.monotonic()
with raw.open('wb') as stream:
    raw.chmod(0o600)
    try:
        result = subprocess.run(command, cwd=snapshot / 'backend-ts', env=environment, stdout=stream, stderr=subprocess.STDOUT, timeout=240)
        code = result.returncode
    except subprocess.TimeoutExpired:
        code = 124
data = raw.read_bytes()
public = data.decode(errors='replace').replace(str(private), '<private-review>').replace(os.environ.get('HOME', '/nonexistent-user-home'), '<user-home>')
public = re.sub(r'notalone_(?:ts_host|pure_ts)_[0-9a-f]{32}_test', '<synthetic-database>', public)
public = re.sub(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', '<synthetic-id>', public, flags=re.I)
public_path = output / (step + '.public.log')
public_path.write_text(public)
metadata = dict(step=step, exit_code=code, seconds=round(time.monotonic()-started, 3),
                command=[part.replace(str(snapshot), '<snapshot>').replace(str(output), '<review>') if part not in (node, python) else ('<node>' if part == node else '<python>') for part in command],
                cwd='<snapshot>/backend-ts', raw_sha256=hashlib.sha256(data).hexdigest(),
                public_sha256=hashlib.sha256(public_path.read_bytes()).hexdigest(), raw_log_location='outside_repository', raw_mode='0600', private_directory_mode='0700')
(output / (step + '.json')).write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(metadata, ensure_ascii=False))
print('\n'.join(public.splitlines()[-12:]))
sys.exit(code)
