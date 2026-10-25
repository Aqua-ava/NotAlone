"""执行已冻结隔离快照的最小复核；原日志仅保存在仓库外。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--private-root', type=Path, required=True)
parser.add_argument('--node', type=Path, required=True)
parser.add_argument('--case', choices=('host-repeat', 'publication-single-fixed', 'publication-remaining'), required=True)
args = parser.parse_args()
private = args.private_root.resolve(strict=True)
public = Path(__file__).resolve().parent
fixed = private / 'fixed'
assert private.stat().st_mode & 0o777 == 0o700
assert not private.is_relative_to(public.parents[2])
os.umask(0o077)
records = private / f'{args.case}.ownership.json'
records.write_text(json.dumps({'created': [], 'dropRequested': []}))
records.chmod(0o600)
environment = {key: os.environ[key] for key in ('HOME', 'USER', 'LOGNAME', 'LANG') if key in os.environ}
environment.update(PATH=f'{args.node.parent}:/usr/bin:/bin', TMPDIR=str(private / 'tmp'),
                   NOTALONE_REVIEW_FIXED_ROOT=str(fixed), NOTALONE_REVIEW_RECORDS=str(records))
command = [str(args.node), f'--import={public / "isolation.mjs"}', '--test-reporter=tap', '--test']
if args.case == 'host-repeat':
    command += ['--test-name-pattern=^目标：参数转换重入', str(public / 'probe-host-storage.test.mjs')]
else:
    pattern = ('纯 TS 公开异步生成完成后原生控制器直接发布' if args.case == 'publication-single-fixed'
               else '公开完成回执|生成中切换联系人|公开异步准备')
    command += [f'--test-name-pattern={pattern}', str(fixed / 'backend-ts/test/assistant-generation-publication.test.mjs')]
raw = private / f'{args.case}.raw.log'
started = time.monotonic()
with raw.open('xb') as output:
    process = subprocess.Popen(command, cwd=fixed / 'backend-ts', env=environment,
                               stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        code = process.wait(timeout=60)
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
text = data.decode(errors='replace')
for path in sorted({str(private), str(args.private_root), str(public.parents[2].parent.parent)}, key=len, reverse=True):
    text = text.replace(path, '<review-root>')
text = re.sub(r'(?:file://)?/(?:private/)?var/folders/[^\s\'"<>]+', '<private-path>', text)
text = re.sub(r'(?:file://)?/Users/[^\s\'"<>]+', '<workspace-path>', text)
text = re.sub(r'Bearer\s+[A-Za-z0-9._~-]+', 'Bearer <redacted>', text)
text = re.sub(r'(?i)(token|api_key)(["\s:=]+)[A-Za-z0-9_-]{16,}', r'\1\2<redacted>', text)
public_log = public / f'{args.case}.public.log'
public_log.write_text(text)
result = {'case': args.case, 'exit_code': code, 'duration_seconds': round(time.monotonic() - started, 2),
          'raw_sha256': hashlib.sha256(data).hexdigest(), 'public_sha256': hashlib.sha256(text.encode()).hexdigest(),
          'public_log': public_log.name,
          'summary': [line for line in text.splitlines() if re.match(r'^# (tests|pass|fail|cancelled|skipped|duration_ms) ', line)]}
(private / f'{args.case}.result.json').write_text(json.dumps(result))
(private / f'{args.case}.result.json').chmod(0o600)
print(json.dumps(result, ensure_ascii=False))
