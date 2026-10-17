"""有限桌面验收的真实模块来源与环境证据；不记录任何业务正文。"""

import hashlib
import json
import os
from pathlib import Path
import sys
import stat
from uuid import uuid4


def bind_test_database_before_import(ownership_path: Path) -> str:
    """测试装配导入前先记录唯一身份，Core仍在CREATE前单独登记。"""
    directory = ownership_path.parent
    metadata = directory.lstat()
    if (not ownership_path.is_absolute() or not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077):
        raise RuntimeError("偏好夹具须使用本轮私有目录。")
    name = f"notalone_core_flow_{uuid4().hex}_test"
    marker = directory / "import-database-ownership.json"
    descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as record:
        json.dump({"database_name": name, "child_pid": os.getpid(), "phase": "planned"}, record)
        record.flush()
        os.fsync(record.fileno())
    url = f"host=/tmp dbname={name}"
    os.environ.update(NOTALONE_DATABASE_URL=url, NOTALONE_TEST_DATABASE_URL=url,
                      NOTALONE_EXPECTED_TEST_DATABASE=name)
    return name


def guard_modules(root: Path, *, expected: dict, evidence_path: Path, phase: str) -> dict:
    if (os.environ.get('CONDA_DEFAULT_ENV') != 'NotAlone' or Path.cwd() != root / 'backend'
            or os.environ.get('PYTHONPATH', '').split(os.pathsep)[:2] != [str(root / 'backend/src'), str(root / 'backend')]
            or os.environ.get('NOTALONE_DATABASE_URL') != os.environ.get('NOTALONE_TEST_DATABASE_URL')):
        raise RuntimeError('验收须使用当前工作树、Conda与相同隔离测试连接。')
    observed = []
    for name, module in tuple(sys.modules.items()):
        if not (name == 'notalone' or name.startswith(('notalone.', 'tests.')) or name in expected):
            continue
        source = getattr(module, '__file__', None)
        if source is None:
            continue
        path = Path(source).resolve()
        if not path.is_relative_to(root / 'backend') and name not in expected:
            raise RuntimeError('验收加载了其他工作树模块。')
        observed.append({'module': name, 'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    by_name = {item['module']: item for item in observed}
    for name, fixed in expected.items():
        actual = by_name.get(name)
        if actual is None or actual['path'] != str((root / fixed['path']).resolve()) or actual['sha256'] != fixed['sha256']:
            raise RuntimeError('验收实际模块与调用方固定摘要不符。')
    proof = {'phase': phase, 'loaded_modules': observed, 'critical_module_count': len(expected),
             'environment_verified': True, 'conda': os.environ['CONDA_DEFAULT_ENV'], 'cwd': str(Path.cwd()),
             'dotenv_disabled': os.environ.get('NOTALONE_DISABLE_DOTENV') == '1',
             'tracing_disabled': os.environ.get('LANGSMITH_TRACING') == 'false'}
    descriptor = os.open(evidence_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
        json.dump(proof, output, ensure_ascii=False, indent=2)
    return {'loaded_module_count': len(observed), 'critical_module_count': len(expected), 'environment_verified': True}


def guard_test_migrations(database_url: str, expected_database: str, root: Path, *,
                          expected_count: int = 70,
                          expected_tail: str = "070_skill_scope_policies.sql") -> dict:
    """只核对本轮事前登记的精确库；当前连续迁移和重复执行均须匹配。"""
    import psycopg
    from notalone.database_migrations import migrate

    official = sorted(path.name for path in (root / "backend/database/migrations").glob("*.sql"))
    with psycopg.connect(database_url) as connection:
        if connection.execute("SELECT current_database()").fetchone()[0] != expected_database:
            raise RuntimeError("偏好夹具数据库身份与本轮归属记录不符。")
        actual = [row[0] for row in connection.execute("SELECT name FROM public.notalone_schema_migration ORDER BY name")]
    if (len(actual) != expected_count or actual != official
            or [int(name[:3]) for name in official] != list(range(1, expected_count + 1))
            or official[-1] != expected_tail):
        raise RuntimeError(f"有限验收夹具须使用精确连续001–{expected_count:03}迁移。")
    if migrate(database_url, root / "backend/database/migrations"):
        raise RuntimeError("偏好迁移重复执行应为0。")
    return {"database_name": expected_database, "migrations": actual, "migration_repeat": 0}
