"""源码安装使用的逐版本迁移命令；SQL 文件只接受受信任的仓库迁移。"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from uuid import uuid4

import psycopg
from psycopg import sql


class MigrationError(RuntimeError):
    """仅携带稳定错误码和不含业务内容的说明。"""


@dataclass(frozen=True, slots=True)
class Migration:
    name: str
    checksum: str
    body: str


def _load_migrations(directory: Path) -> tuple[Migration, ...]:
    migrations: list[Migration] = []
    for version, path in enumerate(sorted(directory.glob("*.sql")), start=1):
        match = re.fullmatch(r"(\d{3})_[a-z0-9_]+\.sql", path.name)
        if match is None or int(match.group(1)) != version:
            raise MigrationError(
                "migration_files_invalid：SQL 文件必须从 001 连续编号，每个版本只有一个文件。"
            )
        content = path.read_bytes()
        lines = content.decode("utf-8").strip().splitlines()
        while lines and (not lines[0].strip() or lines[0].lstrip().startswith("--")):
            lines.pop(0)
        while lines and (not lines[-1].strip() or lines[-1].lstrip().startswith("--")):
            lines.pop()
        body = "\n".join(lines).strip()
        # 历史文件自带外层事务；去掉封装，由命令统一提交 SQL 和版本记录。
        if body.startswith("BEGIN;") and body.endswith("COMMIT;"):
            body = body[len("BEGIN;"):-len("COMMIT;")].strip()
        migrations.append(Migration(path.name, hashlib.sha256(content).hexdigest(), body))
    if not migrations:
        raise ValueError("迁移目录为空或不存在。")
    return tuple(migrations)


def migrate(database_url: str, directory: Path) -> tuple[str, ...]:
    """按文件名执行未完成的版本；每个版本的 SQL 与账本原子提交。"""

    migrations = _load_migrations(directory)
    applied: list[str] = []
    with psycopg.connect(database_url, autocommit=True) as connection:
        # 会话锁覆盖所有逐版本事务，连接关闭（包括进程中断）时自动释放。
        if not connection.execute(
            "SELECT pg_try_advisory_lock(1852798049, 1)"
        ).fetchone()[0]:
            raise MigrationError("migration_busy：另一个迁移命令正在执行，请稍后重试。")
        connection.execute("SET lock_timeout = '10s'")
        if connection.execute(
            "SELECT to_regclass('public.notalone_schema_migration')"
        ).fetchone()[0] is None:
            existing = connection.execute("""
                SELECT EXISTS (
                    SELECT 1 FROM pg_catalog.pg_class AS c
                    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public'
                      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
                )
            """).fetchone()[0]
            if existing:
                raise MigrationError(
                    "legacy_database_untracked：旧库没有迁移记录，已停止且未修改；"
                    "请先核验结构与历史迁移记录，不可根据 owner 表猜测基线。"
                )
        connection.execute("""
            CREATE TABLE IF NOT EXISTS public.notalone_schema_migration (
                name text PRIMARY KEY,
                checksum text NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
        """)
        completed = dict(connection.execute(
            "SELECT name, checksum FROM public.notalone_schema_migration ORDER BY name"
        ).fetchall())
        expected_history = {
            item.name: item.checksum for item in migrations[:len(completed)]
        }
        if completed != expected_history:
            raise MigrationError(
                "migration_history_mismatch：已执行迁移缺失、内容改变或顺序不一致；"
                "请恢复原始文件，新变更应增加新版本。"
            )
        for migration in migrations:
            if migration.name in completed:
                continue
            try:
                with connection.transaction():
                    # 在动态 SQL 块中执行，额外 COMMIT 等事务控制会被数据库拒绝，
                    # 避免未来文件格式变化导致业务 SQL 提前提交、账本却未写入。
                    tag = sql.SQL(f"$migration_{uuid4().hex}$")
                    connection.execute(sql.SQL(
                        "DO {tag} BEGIN EXECUTE {body}; END {tag};"
                    ).format(tag=tag, body=sql.Literal(migration.body)))
                    connection.execute(
                        "INSERT INTO public.notalone_schema_migration (name, checksum) "
                        "VALUES (%s, %s)",
                        (migration.name, migration.checksum),
                    )
            except psycopg.Error:
                raise MigrationError(
                    f"migration_failed：{migration.name} 未完成，当前版本已回滚；"
                    "修复后重跑将从该版本继续。"
                ) from None
            applied.append(migration.name)
    return tuple(applied)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="按版本执行 NotAlone 数据库迁移。")
    parser.add_argument("--migrations", type=Path, required=True,
                        help="受信任的仓库 SQL 迁移目录")
    args = parser.parse_args(argv)
    database_url = os.environ.get("NOTALONE_DATABASE_URL", "")
    if not database_url.strip():
        print("未配置 NOTALONE_DATABASE_URL。", file=sys.stderr)
        return 1
    try:
        applied = migrate(database_url, args.migrations)
    except MigrationError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (ValueError, OSError, psycopg.Error):
        # 驱动错误可能包含连接凭据或行内容，不直接回显。
        print("迁移失败；当前版本已回滚，请检查迁移文件与数据库状态后重试。", file=sys.stderr)
        return 1
    print(json.dumps({"status": "succeeded", "applied": applied}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
