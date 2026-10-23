"""只生成可审查补丁，不改共享产品文件。"""
import ast
import difflib
import hashlib
import json
from pathlib import Path

root = Path.cwd()
out = root / '.scratch/dsh-ts-migration/skill-library'
changes = {}
p = 'backend/src/notalone/persistence/skill_directory.py'
s = (root / p).read_text()
s = s.replace('from dataclasses import dataclass', 'from dataclasses import dataclass\nfrom notalone.persistence.skill_management_handoff import (\n    skill_management_handoff, SkillManagementUnavailable,\n)', 1)
needle = '    if not isinstance(owner_id, UUID):'
pos = s.index(needle)
s = s[:pos] + '''    try:
        return skill_management_handoff.synchronize(
            owner_id, lambda: _synchronize_skill_library_local(database_url, owner_id),
        )
    except SkillManagementUnavailable:
        raise SkillDirectorySyncError("Skill 目录同步暂不可用。") from None


def _synchronize_skill_library_local(database_url: str, owner_id: UUID) -> int:
''' + s[pos:]
old = '''    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        synchronize_skill_directory(connection, owner_id)
'''
assert s.count(old) == 1
s = s.replace(old, '    synchronize_skill_library(database_url, owner_id)\n')
needle = '    """发现新增与修改；检查模式只判断变化，供提交前拒绝迟到候选。"""\n'
assert s.count(needle) == 1
s = s.replace(needle, needle + '''    if check_only:
        return _synchronize_skill_directory_local(connection, owner_id, check_only=True)
    with skill_management_handoff.local_operation():
        return _synchronize_skill_directory_local(connection, owner_id)


def _synchronize_skill_directory_local(connection, owner_id: UUID, *, check_only=False) -> bool:
''')
changes[p] = s
p = 'backend/src/notalone/persistence/skill_library.py'
s = (root / p).read_text().replace('import hashlib', 'from contextlib import contextmanager\nfrom notalone.persistence.skill_management_handoff import (\n    skill_management_handoff, SkillManagementUnavailable,\n)\n\nimport hashlib', 1)
old = '''    def _connect(self) -> Any:
        return psycopg.connect(self._database_url, row_factory=dict_row)'''
assert s.count(old) == 1
s = s.replace(old, '''    @contextmanager
    def _connect(self) -> Any:
        try:
            with skill_management_handoff.local_operation():
                with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                    yield connection
        except SkillManagementUnavailable:
            raise SkillLibraryPersistenceError('Skill 旧管理入口已停收。') from None''')
changes[p] = s
patch = []
bases = {}
for p, new in changes.items():
    ast.parse(new)
    old = (root / p).read_text() if (root / p).exists() else ''
    bases[p] = hashlib.sha256(old.encode()).hexdigest() if old else None
    patch.extend(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/' + p if old else '/dev/null', tofile='b/' + p))
(out / 'legacy-write-handoff.patch').write_text(''.join(patch))
(out / 'legacy-write-handoff-base.json').write_text(json.dumps(bases, indent=2) + '\n')
print('已生成2文件补丁；仅AST校验，未应用。')
