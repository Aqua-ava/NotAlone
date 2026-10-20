"""完成自有夹具清理后核验结果，错误不能被 unittest 回调吞掉。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import unittest
from uuid import uuid4

import psycopg


def write_private_bytes(filename: str, content: bytes) -> None:
    """迁移原始输出保留在夹具私有目录，供外层封存。"""
    location = database_ownership_path().parent / filename
    descriptor = os.open(location, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())
    directory = os.open(location.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def verify_full_migrations(database_name: str, database_url: str) -> dict[str, int]:
    """仅完整桌面夹具验证当前 canonical 前缀，不改历史升级场景。"""
    root = Path(__file__).resolve().parents[3]
    migrations = root / "backend/database/migrations"
    expected = sorted(path.name for path in migrations.glob("*.sql"))
    if (not expected or [name[:3] for name in expected] != [f"{n:03}" for n in range(1, len(expected) + 1)]
            or os.environ.get("NOTALONE_DATABASE_URL") != database_url
            or os.environ.get("NOTALONE_TEST_DATABASE_URL") != database_url):
        raise RuntimeError("完整桌面夹具只接受本轮双 URL 与连续编号的当前正式迁移。")
    with psycopg.connect(database_url) as connection:
        if connection.execute("SELECT current_database()").fetchone()[0] != database_name:
            raise RuntimeError("完整桌面夹具数据库身份不匹配。")
        recorded = [row[0] for row in connection.execute(
            "SELECT name FROM public.notalone_schema_migration ORDER BY name",
        ).fetchall()]
    if recorded != expected:
        raise RuntimeError("完整桌面夹具迁移账本不匹配。")
    repeated = subprocess.run(
        [sys.executable, "-m", "notalone.database_migrations", "--migrations", str(migrations)],
        cwd=root / "backend", env=dict(os.environ), capture_output=True, timeout=60,
    )
    write_private_bytes("migration-repeat.stdout", repeated.stdout)
    write_private_bytes("migration-repeat.stderr", repeated.stderr)
    if repeated.returncode != 0 or json.loads(repeated.stdout)["applied"] != []:
        raise RuntimeError("完整桌面夹具迁移重复执行必须为0。")
    return {"migration_count": len(recorded), "migration_repeat": 0}


def database_ownership_path() -> Path:
    """Core 建库前只写当前夹具私有目录，不跟随替换后的目录链接。"""
    env_path = Path(os.environ.get("NOTALONE_ENV_FILE", ""))
    info_path = Path(os.environ.get("NOTALONE_BACKEND_INFO", ""))
    if (os.environ.get("NOTALONE_DISABLE_DOTENV") != "1"
            or not env_path.is_absolute() or env_path.name != "synthetic.env"
            or not info_path.is_absolute() or info_path.parent != env_path.parent):
        raise RuntimeError("合成夹具须使用本轮私有 synthetic.env 与握手目录。")
    directory = env_path.parent.lstat()
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid()
            or directory.st_mode & 0o077):
        raise RuntimeError("合成夹具目录归属不可核验。")
    return env_path.parent / "database-ownership.json"


def bind_prepared_database() -> str:
    """直接脚本入口先绑定双 URL，实际建库和 marker 仍由 Core 单独拥有。"""
    database_ownership_path()
    database_name = f"notalone_core_flow_{uuid4().hex}_test"
    database_url = f"host=/tmp dbname={database_name}"
    os.environ.update({"NOTALONE_DATABASE_URL": database_url,
                       "NOTALONE_TEST_DATABASE_URL": database_url})
    return database_name


def cleanup_fixture(fixture: unittest.TestCase) -> None:
    fixture_class = type(fixture)
    instance_ok = fixture.doCleanups()
    fixture_class.doClassCleanups()
    class_ok = not fixture_class.tearDown_exceptions
    database_name = getattr(fixture_class, "database_name", None)
    database_remaining = None
    if isinstance(database_name, str) and re.fullmatch(
        r"notalone_core_flow_[0-9a-f]{32}_test", database_name
    ):
        try:
            with psycopg.connect("host=/tmp dbname=postgres", connect_timeout=3) as admin:
                database_remaining = admin.execute(
                    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = %s)",
                    (database_name,),
                ).fetchone()[0]
        except psycopg.Error:
            pass
    print(json.dumps({"cleanup": {
        "instance_ok": instance_ok, "class_ok": class_ok,
        "database_remaining": database_remaining,
    }}), flush=True)
    if not instance_ok or not class_ok or database_remaining is not False:
        raise RuntimeError("本轮合成夹具收尾或数据库清理未确认。")
