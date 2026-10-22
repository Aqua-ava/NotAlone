"""真实审核与历史迁移保留既有包、审核来历及迁移摘要。"""

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.database_baseline import BASELINE_MANIFEST
from notalone.database_migrations import migrate
from notalone.persistence.skill_directory import synchronize_skill_library
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.scopes import ContactScope


MIGRATIONS = Path(__file__).resolve().parents[3] / "database/migrations"
TAIL = "068_skill_review_publication.sql"
HISTORY_TAIL = "069_skill_history_operations.sql"
POLICY_TAIL = "070_skill_scope_policies.sql"


class SkillReviewUpgradeTest(unittest.TestCase):
    def setUp(self):
        self.skill_directory = tempfile.TemporaryDirectory(prefix="notalone-upgrade-skills-")
        self.addCleanup(self.skill_directory.cleanup)
        environment = patch.dict(os.environ, {"NOTALONE_SKILLS_DIR": self.skill_directory.name})
        environment.start()
        self.addCleanup(environment.stop)

    @contextmanager
    def _database(self):
        name = f"notalone_12_upgrade_{uuid4().hex}_test"
        instance = os.environ["NOTALONE_TEST_DATABASE_URL"]
        database = make_conninfo(instance, dbname=name)
        with tempfile.TemporaryDirectory(prefix="notalone-review-upgrade-") as temporary:
            directory = Path(temporary)
            directory.chmod(0o700)
            # 创建前只登记本次随机身份；CREATE 失败不能获得 DROP 权限。
            descriptor = os.open(directory / "database-planned.json",
                                 os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as record:
                os.fchmod(record.fileno(), 0o600)
                json.dump({"database_name": name, "child_pid": os.getpid(), "phase": "planned"}, record)
                record.flush()
                os.fsync(record.fileno())
            descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            with psycopg.connect(instance, dbname="postgres", autocommit=True) as admin:
                admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
                try:
                    with psycopg.connect(database) as connection:
                        self.assertEqual(connection.execute("SELECT current_database()").fetchone()[0], name)
                    yield database
                finally:
                    admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
                    self.assertFalse(admin.execute(
                        "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)", (name,),
                    ).fetchone()[0])

    def _copy_prefix(self, directory: Path, through: int) -> None:
        for migration in sorted(MIGRATIONS.glob("*.sql")):
            if int(migration.name[:3]) <= through:
                shutil.copyfile(migration, directory / migration.name)

    def test_real_067_upgrade_preserves_legacy_versions_and_checksums_and_repeats_safely(self):
        with self._database() as database, tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary)
            self._copy_prefix(prefix, 67)
            self.assertEqual(len(migrate(database, prefix)), 67)
            owner, contact, skill, version = (uuid4() for _ in range(4))
            with psycopg.connect(database) as connection:
                connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成升级用户')", (owner,))
                connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成升级联系人')", (contact, owner))
                connection.execute("INSERT INTO public.skill_library(owner_id,revision) VALUES(%s,1)", (owner,))
                connection.execute("INSERT INTO public.reply_skill(id,owner_id,name,description,status) VALUES(%s,%s,'legacy-review','旧策略','active')", (skill, owner))
                connection.execute(
                    "INSERT INTO public.reply_skill_version(id,skill_id,version_number,name,description,content,content_sha256,source_locator,is_current,enabled,status) "
                    "VALUES(%s,%s,1,'legacy-review','旧策略','合成旧包正文',%s,'synthetic-old-package',true,true,'active')",
                    (version, skill, hashlib.sha256("合成旧包正文".encode("utf-8")).hexdigest()),
                )
                before = connection.execute("SELECT name,checksum FROM public.notalone_schema_migration ORDER BY name").fetchall()
                original = connection.execute("SELECT to_jsonb(v) FROM public.reply_skill_version v WHERE id=%s", (version,)).fetchone()[0]
            self._copy_prefix(prefix, 68)
            self.assertEqual(migrate(database, prefix), (TAIL,))
            self.assertEqual(migrate(database, prefix), ())
            with psycopg.connect(database) as connection:
                self.assertEqual(connection.execute(
                    "SELECT name,checksum FROM public.notalone_schema_migration WHERE left(name,3)::int<=67 ORDER BY name",
                ).fetchall(), before)
                expected = {**original, "review_origin": False}
                self.assertEqual(connection.execute("SELECT to_jsonb(v) FROM public.reply_skill_version v WHERE id=%s", (version,)).fetchone()[0], expected)
                self.assertEqual(connection.execute("SELECT count(*) FROM public.reply_skill_publication").fetchone()[0], 0)
                self.assertEqual(connection.execute("SELECT checksum FROM public.notalone_schema_migration WHERE name=%s", (TAIL,)).fetchone()[0], hashlib.sha256((MIGRATIONS / TAIL).read_bytes()).hexdigest())
                self.assertEqual(before[:35], list(BASELINE_MANIFEST))
            # 历史边界先独立核验；当前运行接口仅在全部正式迁移完成后验证。
            self._copy_prefix(prefix, 70)
            self.assertEqual(migrate(database, prefix), (HISTORY_TAIL, POLICY_TAIL))
            self.assertEqual(migrate(database, prefix), ())
            later = tuple(path.name for path in sorted(MIGRATIONS.glob("*.sql")) if int(path.name[:3]) > 70)
            self.assertEqual(migrate(database, MIGRATIONS), later)
            self.assertEqual(migrate(database, MIGRATIONS), ())
            # 结构升级只提交工作副本任务；公开同步入口落盘后才允许运行时发现。
            synchronize_skill_library(database, owner)
            port = PostgresSkillPort(database)
            self.assertEqual(port.catalog(ContactScope(owner, contact)).entries[0].version_id, version)
            self.assertEqual(port.load_version(ContactScope(owner, contact), version).content, original["content"])

    def test_full_001_through_068_install_has_review_tables_and_repeats_without_writes(self):
        with self._database() as database, tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary)
            self._copy_prefix(prefix, 68)
            applied = migrate(database, prefix)
            self.assertEqual(len(applied), 68)
            self.assertEqual(applied[-1], TAIL)
            with psycopg.connect(database) as connection:
                before = connection.execute("SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name").fetchall()
                for table in ("skill_review_operation", "skill_review_comparison", "reply_skill_publication"):
                    self.assertEqual(connection.execute("SELECT to_regclass(%s)::text", ("public." + table,)).fetchone()[0], table)
                self.assertEqual([(name, checksum) for name, checksum, _ in before[:35]], list(BASELINE_MANIFEST))
            self.assertEqual(migrate(database, prefix), ())
            with psycopg.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name").fetchall(), before)

    def _history_rows(self, connection):
        owner, contact, other_owner, other_contact = (uuid4() for _ in range(4))
        legacy, reviewed, foreign = (uuid4() for _ in range(3))
        legacy_version, reviewed_version, foreign_version = (uuid4() for _ in range(3))
        draft, logical_skill, method = (uuid4() for _ in range(3))
        for identity in (owner, other_owner):
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成历史升级用户')", (identity,))
        for identity, parent in ((contact, owner), (other_contact, other_owner)):
            connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成历史升级联系人')", (identity, parent))
        connection.execute("INSERT INTO public.skill_library(owner_id,revision) VALUES(%s,7)", (owner,))
        for identity, parent, name in ((legacy, owner, "legacy-history"), (reviewed, owner, "reviewed-history"), (foreign, other_owner, "foreign-history")):
            connection.execute("INSERT INTO public.reply_skill(id,owner_id,name,description,status) VALUES(%s,%s,%s,'合成历史策略','active')", (identity, parent, name))
        for identity, parent, name, review_origin in (
            (legacy_version, legacy, "legacy-history", False),
            (reviewed_version, reviewed, "reviewed-history", True),
            (foreign_version, foreign, "foreign-history", False),
        ):
            connection.execute(
                "INSERT INTO public.reply_skill_version(id,skill_id,version_number,name,description,content,content_sha256,source_locator,is_current,enabled,status,review_origin) "
                "VALUES(%s,%s,1,%s,'合成历史策略','合成不可变正文',%s,'synthetic-history-package',true,true,'active',%s)",
                (identity, parent, name, hashlib.sha256("合成不可变正文".encode("utf-8")).hexdigest(), review_origin),
            )
        connection.execute(
            "INSERT INTO public.skill_draft(id,owner_id,contact_id,status,logical_skill_id,proposal_kind,strategy,private_evidence,published_version_id,batch_key,last_decision) "
            "VALUES(%s,%s,%s,'published',%s,'create','{}','{}',%s,'synthetic-history-upgrade','approve')",
            (draft, owner, contact, logical_skill, reviewed_version),
        )
        connection.execute(
            "INSERT INTO public.reply_skill_publication(version_id,owner_id,origin_contact_id,draft_id,logical_skill_id,scope_kind,scope_contact_id) "
            "VALUES(%s,%s,%s,%s,%s,'contact',%s)",
            (reviewed_version, owner, contact, draft, logical_skill, contact),
        )
        connection.execute(
            "INSERT INTO public.reply_skill_method(version_id,method_id,logical_skill_id,ordinal,title,instruction,mapping_state) "
            "VALUES(%s,%s,%s,0,'合成方法','合成方法正文','new')",
            (reviewed_version, method, logical_skill),
        )
        return owner, contact, legacy, legacy_version, reviewed, reviewed_version, foreign, foreign_version, other_contact

    def _history_snapshot(self, connection):
        tables = ("skill_library", "reply_skill", "reply_skill_version", "skill_draft", "reply_skill_publication", "reply_skill_method")
        return {
            table: connection.execute(f"SELECT to_jsonb(row) FROM public.{table} AS row ORDER BY to_jsonb(row)::text").fetchall()
            for table in tables
        }

    def test_real_068_upgrade_preserves_legacy_and_reviewed_history_and_repeats_safely(self):
        with self._database() as database, tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary)
            self._copy_prefix(prefix, 68)
            self.assertEqual(len(migrate(database, prefix)), 68)
            with psycopg.connect(database) as connection:
                self._history_rows(connection)
                before = connection.execute("SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name").fetchall()
                original = self._history_snapshot(connection)
            self._copy_prefix(prefix, 69)
            self.assertEqual(migrate(database, prefix), (HISTORY_TAIL,))
            self.assertEqual(migrate(database, prefix), ())
            with psycopg.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT name,checksum,applied_at FROM public.notalone_schema_migration WHERE left(name,3)::int<=68 ORDER BY name").fetchall(), before)
                self.assertEqual(self._history_snapshot(connection), original)
                self.assertEqual(connection.execute("SELECT count(*) FROM public.skill_history_operation").fetchone()[0], 0)
                self.assertEqual(connection.execute("SELECT checksum FROM public.notalone_schema_migration WHERE name=%s", (HISTORY_TAIL,)).fetchone()[0], hashlib.sha256((MIGRATIONS / HISTORY_TAIL).read_bytes()).hexdigest())
                self.assertEqual([(name, checksum) for name, checksum, _ in before[:35]], list(BASELINE_MANIFEST))

    def test_full_001_through_069_install_enforces_history_scope_and_repeats_without_writes(self):
        with self._database() as database, tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary)
            self._copy_prefix(prefix, 69)
            applied = migrate(database, prefix)
            self.assertEqual(len(applied), 69)
            self.assertEqual(applied[-1], HISTORY_TAIL)
            with psycopg.connect(database) as connection:
                before = connection.execute("SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name").fetchall()
                owner, contact, legacy, legacy_version, reviewed, reviewed_version, foreign, foreign_version, other_contact = self._history_rows(connection)
                insert = (
                    "INSERT INTO public.skill_history_operation(owner_id,contact_id,operation_key,skill_id,version_id,request_fingerprint,result_revision) "
                    "VALUES(%s,%s,%s,%s,%s,%s,7)"
                )
                for invalid_contact, invalid_skill, invalid_version in (
                    (contact, foreign, foreign_version),
                    (contact, legacy, foreign_version),
                    (contact, legacy, reviewed_version),
                    (other_contact, legacy, legacy_version),
                ):
                    with self.assertRaises(psycopg.errors.ForeignKeyViolation), connection.transaction():
                        connection.execute(insert, (owner, invalid_contact, uuid4(), invalid_skill, invalid_version, "c" * 64))
                operation_key = uuid4()
                connection.execute(insert, (owner, contact, operation_key, legacy, legacy_version, "c" * 64))
                self.assertEqual(connection.execute("SELECT skill_id,version_id FROM public.skill_history_operation WHERE operation_key=%s", (operation_key,)).fetchone(), (legacy, legacy_version))
                self.assertEqual(connection.execute("SELECT count(*) FROM public.skill_history_operation").fetchone()[0], 1)
                self.assertIsNone(connection.execute("SELECT to_regclass('public.skill_policy')").fetchone()[0])
                self.assertEqual([(name, checksum) for name, checksum, _ in before[:35]], list(BASELINE_MANIFEST))
            self.assertEqual(migrate(database, prefix), ())
            with psycopg.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name").fetchall(), before)

    def test_real_069_upgrade_preserves_skill_history_and_adds_scoped_policies(self):
        with self._database() as database, tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary)
            self._copy_prefix(prefix, 69)
            self.assertEqual(len(migrate(database, prefix)), 69)
            with psycopg.connect(database) as connection:
                _, _, _, version, *_ = self._history_rows(connection)
                content = "合成原有资源字节。".encode()
                connection.execute(
                    "INSERT INTO public.reply_skill_resource(skill_version_id,relative_path,resource_kind,media_type,byte_size,content_sha256,content) "
                    "VALUES(%s,'references/original.md','reference','text/markdown',%s,%s,%s)",
                    (version, len(content), hashlib.sha256(content).hexdigest(), content),
                )
                before = connection.execute("SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name").fetchall()
                original = self._history_snapshot(connection)
                resources = connection.execute("SELECT to_jsonb(row) FROM public.reply_skill_resource AS row WHERE skill_version_id=%s", (version,)).fetchall()
            self._copy_prefix(prefix, 70)
            self.assertEqual(migrate(database, prefix), (POLICY_TAIL,))
            self.assertEqual(migrate(database, prefix), ())
            with psycopg.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT name,checksum,applied_at FROM public.notalone_schema_migration WHERE left(name,3)::int<=69 ORDER BY name").fetchall(), before)
                self.assertEqual(self._history_snapshot(connection), original)
                self.assertEqual(connection.execute("SELECT to_jsonb(row) FROM public.reply_skill_resource AS row WHERE skill_version_id=%s", (version,)).fetchall(), resources)
                self.assertEqual(connection.execute("SELECT checksum FROM public.notalone_schema_migration WHERE name=%s", (POLICY_TAIL,)).fetchone()[0], hashlib.sha256((MIGRATIONS / POLICY_TAIL).read_bytes()).hexdigest())
                for table in ("skill_policy_state", "skill_scope_policy", "skill_policy_operation"):
                    self.assertEqual(connection.execute("SELECT to_regclass(%s)::text", ("public." + table,)).fetchone()[0], table)
                    self.assertIsNone(connection.execute(f"SELECT 1 FROM public.{table} LIMIT 1").fetchone())

    def test_full_001_through_070_install_enforces_policy_scope_and_repeats_without_writes(self):
        with self._database() as database, tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary)
            self._copy_prefix(prefix, 70)
            applied = migrate(database, prefix)
            self.assertEqual(len(applied), 70)
            self.assertEqual(applied[-1], POLICY_TAIL)
            with psycopg.connect(database) as connection:
                before = connection.execute("SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name").fetchall()
                owner, contact, skill, _, _, _, foreign, _, other_contact = self._history_rows(connection)
                insert = (
                    "INSERT INTO public.skill_scope_policy(id,owner_id,skill_id,method_id,scope_kind,contact_id,scene,revision) "
                    "VALUES(%s,%s,%s,NULL,%s,%s,%s,1)"
                )
                for invalid_skill, invalid_contact in ((foreign, contact), (skill, other_contact)):
                    with self.assertRaises(psycopg.errors.ForeignKeyViolation), connection.transaction():
                        connection.execute(insert, (uuid4(), owner, invalid_skill, "contact", invalid_contact, None))
                operation = "INSERT INTO public.skill_policy_operation(owner_id,contact_id,operation_key,request_fingerprint,result_revision) VALUES(%s,%s,%s,%s,1)"
                with self.assertRaises(psycopg.errors.ForeignKeyViolation), connection.transaction():
                    connection.execute(operation, (owner, other_contact, uuid4(), "a" * 64))
                for kind, target, scene in (("owner", contact, None), ("contact", None, None),
                                            ("contact", contact, "精确场景"), ("scene", contact, " "),
                                            ("unknown", None, None)):
                    with self.assertRaises(psycopg.errors.CheckViolation), connection.transaction():
                        connection.execute(insert, (uuid4(), owner, skill, kind, target, scene))
                policy, key = uuid4(), uuid4()
                connection.execute(insert, (policy, owner, skill, "scene", contact, "精确场景"))
                connection.execute(operation, (owner, contact, key, "a" * 64))
                self.assertEqual(connection.execute("SELECT skill_id,contact_id,scene FROM public.skill_scope_policy WHERE id=%s", (policy,)).fetchone(), (skill, contact, "精确场景"))
                with self.assertRaises(psycopg.errors.UniqueViolation), connection.transaction():
                    connection.execute(operation, (owner, contact, key, "a" * 64))
                connection.execute("DELETE FROM public.contact WHERE owner_id=%s AND id=%s", (owner, contact))
                self.assertIsNone(connection.execute("SELECT id FROM public.skill_scope_policy WHERE id=%s", (policy,)).fetchone())
                self.assertIsNone(connection.execute("SELECT operation_key FROM public.skill_policy_operation WHERE owner_id=%s AND contact_id=%s AND operation_key=%s", (owner, contact, key)).fetchone())
                self.assertEqual([(name, checksum) for name, checksum, _ in before[:35]], list(BASELINE_MANIFEST))
            self.assertEqual(migrate(database, prefix), ())
            with psycopg.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT name,checksum,applied_at FROM public.notalone_schema_migration ORDER BY name").fetchall(), before)
