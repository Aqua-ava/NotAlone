"""旧固定源码的公开命令适配；只取消本轮合成测试库中的范围。"""
import json
from pathlib import Path
import sys
from uuid import UUID, uuid4

v = json.loads(Path(sys.argv[1]).read_text())
assert v['database'].startswith('notalone_ts_host_') and v['database'].endswith('_test')
sys.path.insert(0, v['frozen_source'])
from notalone.scopes import ContactScope
scope = ContactScope(UUID(v['run']['scope']['owner_id']), UUID(v['run']['scope']['contact_id']))
dsn = 'host=/tmp dbname=' + v['database']
if v['run']['domain'] == 'skill_learning':
    from notalone.persistence.skill_learning import PostgresSkillLearningStore
    PostgresSkillLearningStore(dsn).configure(scope, enabled=False, operation_key=uuid4(), expected_revision=1)
else:
    from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
    PostgresLayeredMemoryStore(dsn).command(scope, 'disable', 1, quality_available=False)
print('{"cancel_command_committed":true}')
