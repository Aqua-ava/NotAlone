"""只读核对静态43项显式位置alias与原runtime冻结摘要，不运行产品。"""
from pathlib import Path
import hashlib
import json

root=Path(__file__).resolve().parent
sha=lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
correction=json.loads((root/'source-location-correction.json').read_text())
assert sha(root/'SHA256SUMS')==correction['original_static_checksums_sha256']
assert sha(root/'binding.json')==correction['original_static_binding_sha256']
aliases={entry['original_path']:entry for entry in correction['mappings']}
entries=[line.split('  ',1) for line in (root/'SHA256SUMS').read_text().splitlines()]
assert len(entries)==43 and len(aliases)==4
resolved=[]
for expected,name in entries:
    if name in aliases:
        entry=aliases[name]
        assert not (root/name).exists()
        assert entry['original_sha256']==expected==entry['public_sha256']
        actual=entry['public_path']
    else:
        actual=name
    assert sha(root/actual)==expected, name
    resolved.append(actual)
assert not any('node_modules' in path.relative_to(root).parts for path in root.rglob('*') if path.is_file())
runtime=root/'runtime-followup/final-manifest.json'
assert sha(runtime)==correction['runtime_final_manifest_sha256_unchanged']
runtime_manifest=json.loads(runtime.read_text())
for entry in runtime_manifest['public_files']:
    assert sha(runtime.parent/entry['path'])==entry['sha256'], entry['path']
assert sha(runtime.parent/'PUBLIC-SHA256SUMS')==runtime_manifest['public_checksums_sha256']
supplement=root/'public-source-location-supplement-v1.json'
if supplement.exists():
    manifest=json.loads(supplement.read_text())
    for entry in manifest['public_files']:
        assert sha(root/entry['path'])==entry['sha256'], entry['path']
print(json.dumps({'original_static_entries_verified':len(resolved),'relocated_entries_verified':len(aliases),'runtime_frozen_public_entries_verified':len(runtime_manifest['public_files']),'old_node_modules_files':0,'product_or_runtime_executed':False},ensure_ascii=False))
