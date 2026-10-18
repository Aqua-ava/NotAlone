"""已执行080保持原始内容，后续迁移补齐删除清理。"""
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from uuid import uuid4
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from notalone.runtime_config import load_project_env
from notalone.database_migrations import migrate
from notalone.startup_diagnostics import database_readiness

class MergeCleanupMigrationTest(unittest.TestCase):
    def test_original_080_upgrades_without_rewriting_ledger(self):
        load_project_env()
        name = f"notalone_merge_cleanup_{uuid4().hex}_test"
        url = make_conninfo(os.environ["NOTALONE_DATABASE_URL"], dbname=name)
        root = Path(__file__).resolve().parents[3] / "database/migrations"
        with psycopg.connect(url, dbname="postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
            try:
                with tempfile.TemporaryDirectory() as temporary:
                    prefix = Path(temporary)
                    for path in root.glob("*.sql"):
                        if int(path.name[:3]) <= 80:
                            shutil.copyfile(path, prefix / path.name)
                    old = prefix / "080_memory_merge_parents.sql"
                    old.write_bytes(b"".join(old.read_bytes().splitlines(keepends=True)[:7]))
                    migrate(url, prefix)
                    with psycopg.connect(url) as connection:
                        before = connection.execute("SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name").fetchall()
                    self.assertEqual(database_readiness(url, root), "migration_pending")
                    migrate(url, root)
                    self.assertEqual(database_readiness(url, root), "ready")
                    self.assertEqual(migrate(url, root), ())
                    with psycopg.connect(url) as connection:
                        self.assertEqual(connection.execute("SELECT name,checksum,applied_at FROM public.notalone_schema_migration WHERE name <= '080_memory_merge_parents.sql' ORDER BY name").fetchall(), before)
                        self.assertEqual(connection.execute("SELECT count(*) FROM pg_trigger WHERE tgname IN ('confirmed_clear_merge_parent','owner_clear_merge_parent')").fetchone()[0], 2)
            finally:
                admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
