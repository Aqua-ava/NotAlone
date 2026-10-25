"""在根提供的固定提交上串行运行最小独立验证；不接触项目配置。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
NODE = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
PYTHON = Path.home() / 'miniconda3/envs/NotAlone/bin/python'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def frozen_files():
    tencent = json.loads((ROOT / '.scratch/tencent-source-reuse/freeze.json').read_text())
    budget = json.loads((ROOT / '.scratch/dsh-ts-migration/resumed-memory-budget-guard/files.json').read_text())
    entries = tencent['files'] + budget['owned'] + budget['dependencies']
    paths = {entry['path'] for entry in entries}
    for entry in entries:
        if digest(ROOT / entry['path']) != entry['sha256']:
            raise RuntimeError('实现方冻结摘要已漂移：' + entry['path'])
    for folder, suffix in [('backend-ts/src', '*.ts'), ('backend/database/migrations', '*.sql')]:
        paths.update(str(path.relative_to(ROOT)) for path in (ROOT / folder).rglob(suffix))
    paths.update([
        'backend-ts/src/vendor/tencent-memory/LICENSE',
        'backend-ts/test/extraction-fixture.mjs', 'backend-ts/test/host-storage-fixture.mjs',
        'backend-ts/test/memory-adoption.test.mjs', 'backend-ts/test/extraction-flow.test.mjs',
        'backend-ts/package.json', 'backend-ts/tsconfig.json',
        'backend/src/notalone/database_migrations.py',
        '.scratch/tencent-source-reuse/freeze.json',
        '.scratch/dsh-ts-migration/resumed-memory-budget-guard/files.json',
    ])
    return sorted(paths)


def snapshot(sha, paths):
    if git('rev-parse', 'HEAD').decode().strip() != sha:
        raise RuntimeError('HEAD已变化，拒绝冻结签收')
    entries = []
    for name in paths:
        actual = digest(ROOT / name)
        committed = hashlib.sha256(git('show', sha + ':' + name)).hexdigest()
        if actual != committed:
            raise RuntimeError('工作文件与固定提交不符：' + name)
        entries.append({'path': name, 'sha256': actual})
    return entries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sha', required=True)
    parser.add_argument('--stage', choices=['single', 'contracts', 'related', 'adoption', 'source'], required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.sha):
        raise ValueError('必须给完整SHA')
    base = json.loads((OUT / 'baseline.json').read_text())
    log_dir = Path(base['log_directory'])
    if log_dir.stat().st_mode & 0o077:
        raise RuntimeError('日志目录权限不合规')
    paths = frozen_files()
    before = snapshot(args.sha, paths)
    commands = {
        'source': [str(NODE), 'scripts/check_tencent_memory_source.mjs', '--upstream', str(ROOT.parent / 'TencentDB-Agent-Memory')],
        'single': [str(NODE), '--test', '--test-concurrency=1', '--test-name-pattern=独立提取', str(OUT / 'contracts.test.mjs')],
        'contracts': [str(NODE), '--test', '--test-concurrency=1', str(OUT / 'contracts.test.mjs')],
        'related': [str(NODE), '--test', '--test-concurrency=1',
                    '--test-name-pattern=正式提取|批量裁决|统一候选池遇到|文档工具只暴露|L3多轮提案压缩|L3文档工具只能读取|L3画像在错误写入后|E仅重试已结算',
                    'backend-ts/test/tencent-memory-source-integration.test.mjs',
                    'backend-ts/test/l2-scenario-workspace.test.mjs',
                    'backend-ts/test/l3-profile-workspace.test.mjs',
                    'backend-ts/test/extraction-flow.test.mjs'],
        'adoption': [str(NODE), '--test', '--test-concurrency=1',
                     '--test-name-pattern=两段模型裁决后自动更新|更新裁决后父来源正文变化|用户删除后，新来源',
                     'backend-ts/test/memory-adoption.test.mjs'],
    }
    environment = dict(os.environ)
    for key in ['NOTALONE_PROBLEM_BUDGET', 'NOTALONE_PROBLEM_ROUND']:
        environment.pop(key, None)
    environment.update({'NOTALONE_DISABLE_DOTENV': '1', 'NOTALONE_TEST_PYTHON': str(PYTHON),
                        'PATH': str(NODE.parent) + ':' + str(PYTHON.parent) + ':' + environment.get('PATH', '')})
    command = commands[args.stage]
    log_path = log_dir / (args.stage + '.log')
    fd = os.open(log_path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as log:
        completed = subprocess.run(command, cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=90)
    after = snapshot(args.sha, paths)
    if before != after:
        raise RuntimeError('执行期间源码变化')
    text = log_path.read_text()
    summary = '\n'.join(line for line in text.splitlines() if re.match(r'^(?:# |ℹ )(tests|pass|fail|cancelled|skipped|duration_ms)', line))
    result = {'sha': args.sha, 'stage': args.stage, 'command': command, 'exit_code': completed.returncode,
              'summary': summary, 'log_sha256': digest(log_path), 'frozen_file_count': len(before), 'source_drift': [],
              'real_model_calls': 0, 'log_mode': oct(log_path.stat().st_mode & 0o777)}
    (OUT / (args.stage + '-result.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    (OUT / 'frozen-files.json').write_text(json.dumps({'sha': args.sha, 'files': before}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))
    if completed.returncode:
        print('\n'.join(text.splitlines()[-60:]))
    return completed.returncode


if __name__ == '__main__':
    sys.exit(main())
