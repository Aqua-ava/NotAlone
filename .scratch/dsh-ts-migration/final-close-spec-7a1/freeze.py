"""冻结本目录的脱敏审查产物；原始日志仅核验哈希和权限。"""
import hashlib
import json
from pathlib import Path
import re
import tempfile

out = Path(__file__).resolve().parent
assert (out / 'cleanup.json').is_file(), '自有隔离资源清理尚未完成'
contexts = [p / 'context.json' for p in Path(tempfile.gettempdir()).glob('notalone-spec-7a1-fixed-*')
            if (p / 'context.json').exists()]
assert len(contexts) == 1
private = Path(json.loads(contexts[0].read_text())['private'])
verification = json.loads((out / 'verification.json').read_text())
for run in verification['runs']:
    raw = private / 'logs' / (run['name'] + '.raw.log')
    assert hashlib.sha256(raw.read_bytes()).hexdigest() == run['raw_sha256']
    assert raw.stat().st_mode & 0o777 == 0o600
    public = out / (run['name'] + '.public.log')
    assert hashlib.sha256(public.read_bytes()).hexdigest() == run['public_sha256']
artifacts = []
for p in sorted(out.iterdir()):
    if p.is_file() and p.name not in ['manifest.json', 'SHA256SUMS']:
        text = p.read_text(errors='replace')
        assert not re.search(r'[/]Users[/][^/\s]+[/]|[/]var[/]folders[/]|[/]private[/]var[/]folders[/]', text), p.name
        artifacts.append(dict(path=p.name, sha256=hashlib.sha256(p.read_bytes()).hexdigest(), bytes=p.stat().st_size))
manifest = dict(frozen=True, axis='Spec', result='request_changes', findings=1, worst_priority='P2',
                base='283a609f5f48503657bef571c0ea9539d4ee7b76', target='7a1f58a679245c6df84d88dfaafc3ff2c352c290',
                target_tests=dict(pass_count=28, fail_count=1, skip_count=0),
                input_manifests=[dict(path='.scratch/dsh-ts-migration/business-error-contract-fix/reentrant-query-followup/manifest.json',
                                      sha256='9a2e2ce95cc37b6a80390a2af2b069623582b795ac2ce4d7bfa03fbf2fbdf66c', matched=True),
                                 dict(path='.scratch/dsh-ts-migration/app-stop-control-fix/implementation/manifest.json',
                                      sha256='ce6ceb0b1987dc5ff0fa94206b25261f33d6c435b426f9bec48779149ece9490', matched=True)],
                raw_logs_outside_repository=True, raw_directory_mode='0700', raw_log_mode='0600',
                real_data=False, real_model_calls=0, real_app_runs=0, wechat_access=False,
                git_mutations=False, product_edits=False, ticket25_26_approved=False, artifacts=artifacts)
(out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
lines = [hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name
         for p in sorted(out.iterdir()) if p.is_file() and p.name != 'SHA256SUMS']
(out / 'SHA256SUMS').write_text('\n'.join(lines) + '\n')
print(json.dumps(dict(frozen=True, result='request_changes', findings=1,
                     manifest_sha256=hashlib.sha256((out / 'manifest.json').read_bytes()).hexdigest(),
                     handoff_lines=len((out / 'handoff.md').read_text().splitlines()))))
