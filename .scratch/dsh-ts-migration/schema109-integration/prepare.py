"""准备严格109门禁与当前夹具补丁；不改共享产品。"""
from pathlib import Path
import difflib
import hashlib
import json

root = Path.cwd()
out = root / '.scratch/dsh-ts-migration/schema109-integration'
tail = '109_wechat_auto_read_suppression.sql'
files = [
    'backend-ts/src/host-storage.ts',
    'backend-ts/test/host-storage.test.mjs',
    'backend-ts/test/host-read-transaction.test.mjs',
    'desktop/tests/memory-correction/dsh-app-session.mjs',
    'desktop/tests/fixtures/expression-preference-backend.py',
    'desktop/tests/fixtures/expression-preferences-page.py',
]
patches, manifest = [], {}
for name in files:
    old = (root / name).read_text()
    new = old
    if name.endswith('/host-storage.ts'):
        assert old.count('!== 108') == 2 and old.count('> 108') == 1
        new = old.replace('!== 108', '!== 109').replace('> 108', '> 109')
        new = new.replace('  "wechat_binding_history_authorization",', '  "wechat_auto_read_suppression",\n  "wechat_binding_history_authorization",', 1)
        marker = 'const REQUIRED_COLUMNS: Record<string, Record<string,string>> = {\n'
        assert new.count(marker) == 1
        new = new.replace(marker, marker + '  "wechat_auto_read_suppression": {\n    "owner_id": "uuid",\n    "contact_id": "uuid",\n    "external_local_id": "bigint",\n    "identity_create_time": "bigint",\n    "deleted_at": "timestamp with time zone"\n  },\n')
    elif name.endswith('/host-storage.test.mjs'):
        new = old.replace('原账本及108升级', '原账本及109升级').replace('.rows[0].n, 108)', '.rows[0].n, 109)').replace('108_wechat_binding_history_authorization.sql', tail)
    elif name.endswith('/host-read-transaction.test.mjs'):
        # 保留历史108中间缺口，不能机械改成109尾缺失。
        start = old.index("test('108未登记")
        new = old[:start] + old[start:].replace('108未登记', '历史108中间缺口').replace("code: 'migration_pending'", "code: 'migration_history_mismatch'")
    elif name.endswith('/dsh-app-session.mjs'):
        new = old.replace('originalLedger.length, 108', 'originalLedger.length, 109')
    else:
        new = old.replace('expected_count=108', 'expected_count=109').replace('108_wechat_binding_history_authorization.sql', tail)
    assert new != old, name
    destination = out / 'draft' / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(new)
    manifest[name] = hashlib.sha256(old.encode()).hexdigest()
    patches.extend(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/'+name, tofile='b/'+name))
(out / 'schema-gate.patch').write_text(''.join(patches))
(out / 'base.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(f'已准备{len(files)}文件；产品未改')
