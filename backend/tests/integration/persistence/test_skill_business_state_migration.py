"""通过正式逐版本入口验证 Skill 内容保真、原子清理和失败重试。"""

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.database_migrations import MigrationError, migrate
from notalone.persistence.skill_files import read_resource_content, read_version_content, serialize_skill_document
from notalone.persistence.skill_manifest import read_package_manifest
from notalone.persistence.skill_methods import read_method_manifest, write_method_manifest


MIGRATIONS = Path(__file__).resolve().parents[3] / "database/migrations"
TAIL = "103_skill_business_state_only.sql"
BODY = "先理解感受，再询问对方希望得到的支持。"
RESOURCE = "可以用温和的语言表达理解。".encode("utf-8")
DESCRIPTION = "适合希望温暖回应时使用。"


@dataclass(frozen=True)
class LegacyVersion:
    owner: UUID
    contact: UUID
    skill: UUID
    version: UUID
    method: UUID | None
    name: str


class SkillBusinessStateMigrationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory(prefix="notalone-skill-schema-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve() / "skills"
        environment = patch.dict(os.environ, {"NOTALONE_SKILLS_DIR": str(self.root)})
        environment.start()
        self.addCleanup(environment.stop)
        instance = os.environ.get("NOTALONE_TEST_DATABASE_URL", "host=/tmp dbname=notalone_test")
        self.database_name = "notalone_skill_schema_" + uuid4().hex + "_test"
        self.database = make_conninfo(instance, dbname=self.database_name)
        self.admin = psycopg.connect(instance, dbname="postgres", autocommit=True)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(self.database_name)))
        self.addCleanup(self._drop_database)
        self.prefix = Path(self.temporary.name) / "migrations"
        self.prefix.mkdir()
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if int(path.name[:3]) <= 102:
                shutil.copyfile(path, self.prefix / path.name)
        self.assertEqual(len(migrate(self.database, self.prefix)), 102)

    def _drop_database(self):
        try:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(self.database_name)))
        finally:
            self.admin.close()

    def _legacy(self, *, owner=None, disabled=False, reviewed=False):
        owner, contact, skill, version = owner or uuid4(), uuid4(), uuid4(), uuid4()
        method = uuid4() if reviewed else None
        name = "synthetic-" + skill.hex
        with psycopg.connect(self.database) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成迁移用户')", (owner,))
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'合成迁移联系人')", (owner, contact))
            connection.execute("INSERT INTO public.skill_library(owner_id,revision) VALUES(%s,9)", (owner,))
            connection.execute(
                "INSERT INTO public.reply_skill(id,owner_id,contact_id,name,description,status) "
                "VALUES(%s,%s,%s,%s,%s,%s)",
                (skill, owner, contact, name, DESCRIPTION, "disabled" if disabled else "active"),
            )
            connection.execute(
                "INSERT INTO public.reply_skill_version(id,skill_id,version_number,name,description,content,"
                "content_sha256,source_locator,is_current,enabled,review_origin,validation_warnings) "
                "VALUES(%s,%s,1,%s,%s,%s,%s,'synthetic-old-origin',true,%s,%s,%s)",
                (version, skill, name, DESCRIPTION, BODY, hashlib.sha256(BODY.encode()).hexdigest(),
                 not disabled, reviewed, Jsonb(["合成历史质量提示"])),
            )
            connection.execute(
                "INSERT INTO public.reply_skill_resource(skill_version_id,relative_path,resource_kind,"
                "media_type,byte_size,content_sha256,content) "
                "VALUES(%s,'references/example.md','reference','text/markdown',%s,%s,%s)",
                (version, len(RESOURCE), hashlib.sha256(RESOURCE).hexdigest(), RESOURCE),
            )
            if reviewed:
                draft = uuid4()
                connection.execute(
                    "INSERT INTO public.skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,"
                    "status,strategy,published_version_id,batch_key) "
                    "VALUES(%s,%s,%s,%s,'create','published','{}',%s,'synthetic-schema')",
                    (draft, owner, contact, skill, version),
                )
                connection.execute(
                    "INSERT INTO public.reply_skill_publication(version_id,owner_id,origin_contact_id,"
                    "draft_id,logical_skill_id,scope_kind,scope_contact_id) VALUES(%s,%s,%s,%s,%s,'contact',%s)",
                    (version, owner, contact, draft, skill, contact),
                )
                connection.execute(
                    "INSERT INTO public.reply_skill_method(version_id,method_id,logical_skill_id,ordinal,"
                    "title,instruction,mapping_state) VALUES(%s,%s,%s,0,'温暖回应',%s,'new')",
                    (version, method, skill, BODY),
                )
                connection.execute("INSERT INTO public.skill_policy_state(owner_id,revision) VALUES(%s,4)", (owner,))
                connection.execute(
                    "INSERT INTO public.skill_scope_policy(id,owner_id,skill_id,method_id,scope_kind,"
                    "contact_id,revision) VALUES(%s,%s,%s,%s,'contact',%s,4)",
                    (uuid4(), owner, skill, method, contact),
                )
        return LegacyVersion(owner, contact, skill, version, method, name)

    def _directory_version(self, version):
        relative = f".versions/{version.owner}/{version.skill}/{version.version}/{version.name}"
        directory = self.root / relative
        (directory / "references").mkdir(parents=True)
        document = serialize_skill_document(version.name, DESCRIPTION, BODY)
        (directory / "SKILL.md").write_bytes(document)
        (directory / "references/example.md").write_bytes(RESOURCE)
        with psycopg.connect(self.database) as connection:
            connection.execute(
                "UPDATE public.reply_skill_version SET content=NULL,content_path=%s,document_sha256=%s WHERE id=%s",
                (relative + "/SKILL.md", hashlib.sha256(document).hexdigest(), version.version),
            )
            connection.execute(
                "UPDATE public.reply_skill_resource SET content=NULL,content_path=%s WHERE skill_version_id=%s",
                (relative + "/references/example.md", version.version),
            )
            connection.execute("UPDATE public.reply_skill SET directory_managed=true WHERE id=%s", (version.skill,))
        return directory

    def _snapshot(self):
        with psycopg.connect(self.database) as connection:
            return {table: connection.execute(sql.SQL(
                "SELECT to_jsonb(record) FROM public.{} AS record ORDER BY to_jsonb(record)::text"
            ).format(sql.Identifier(table))).fetchall() for table in (
                "reply_skill", "reply_skill_version", "reply_skill_resource", "reply_skill_method",
                "reply_skill_publication", "skill_scope_policy", "skill_library",
            )}

    def _assert_old_schema(self):
        with psycopg.connect(self.database) as connection:
            self.assertIsNotNone(connection.execute("SELECT to_regclass('public.reply_skill_resource')").fetchone()[0])
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' "
                "AND table_name='reply_skill_version' AND column_name='manifest_sha256'"
            ).fetchone()[0], 0)
            self.assertIsNone(connection.execute(
                "SELECT 1 FROM public.notalone_schema_migration WHERE name=%s", (TAIL,),
            ).fetchone())

    def _assert_new_schema(self):
        with psycopg.connect(self.database) as connection:
            self.assertIsNone(connection.execute("SELECT to_regclass('public.reply_skill_resource')").fetchone()[0])
            for table, removed in (
                ("reply_skill", {"description", "directory_managed"}),
                ("reply_skill_version", {"name", "description", "content", "validation_warnings"}),
                ("reply_skill_method", {"title", "instruction"}),
            ):
                actual = {row[0] for row in connection.execute(
                    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' "
                    "AND table_name=%s", (table,),
                )}
                self.assertFalse(actual & removed)

    def test_upgrade_preserves_all_owners_content_review_scope_and_disabled_decisions(self):
        active = self._legacy(owner=UUID(int=1), reviewed=True)
        disabled = self._legacy(owner=UUID(int=2), disabled=True)
        before = self._snapshot()
        self.assertEqual(migrate(self.database, MIGRATIONS), (TAIL,))
        self._assert_new_schema()
        with psycopg.connect(self.database, row_factory=dict_row) as connection:
            for version in (active, disabled):
                self.assertEqual(read_version_content(connection, version.version), BODY)
                self.assertEqual(read_resource_content(connection, version.version, "references/example.md"), RESOURCE)
                manifest = read_package_manifest(connection, version.version)
                self.assertEqual(manifest["description"], DESCRIPTION)
                self.assertEqual(manifest["warnings"], ["合成历史质量提示"])
                row = connection.execute("SELECT * FROM public.reply_skill_version WHERE id=%s", (version.version,)).fetchone()
                self.assertEqual(row["source_locator"], "synthetic-old-origin")
                self.assertEqual(row["enabled"], version is active)
                self.assertEqual(row["review_origin"], version is active)
            self.assertEqual(read_method_manifest(connection, active.version), [
                {"method_id": active.method, "title": "温暖回应", "instruction": BODY},
            ])
        with psycopg.connect(self.database) as connection:
            for table in ("reply_skill_publication", "skill_scope_policy", "skill_library"):
                actual = connection.execute(sql.SQL(
                    "SELECT to_jsonb(record) FROM public.{} AS record ORDER BY to_jsonb(record)::text"
                ).format(sql.Identifier(table))).fetchall()
                self.assertEqual(actual, before[table])
        self.assertEqual(migrate(self.database, MIGRATIONS), ())

    def test_already_migrated_directory_gets_manifest_without_changing_document(self):
        version = self._legacy()
        directory = self._directory_version(version)
        with psycopg.connect(self.database) as connection:
            connection.execute(
                "UPDATE public.reply_skill_resource SET media_type='text/plain' WHERE skill_version_id=%s",
                (version.version,),
            )
        original = (directory / "SKILL.md").read_bytes()
        self.assertEqual(migrate(self.database, MIGRATIONS), (TAIL,))
        self.assertEqual((directory / "SKILL.md").read_bytes(), original)
        with psycopg.connect(self.database) as connection:
            resource = read_package_manifest(connection, version.version)["resources"][0]
            self.assertEqual(resource["byte_size"], len(RESOURCE))
            self.assertEqual(resource["media_type"], "text/plain")
            self.assertEqual(read_resource_content(connection, version.version, "references/example.md"), RESOURCE)

    def test_corrupt_directory_resource_rolls_back_all_owners_and_retries_after_repair(self):
        self._legacy(owner=UUID(int=1))
        broken = self._legacy(owner=UUID(int=2))
        directory = self._directory_version(broken)
        target = directory / "references/example.md"
        target.write_bytes(b"x" * len(RESOURCE))
        before = self._snapshot()
        with self.assertRaises(MigrationError) as raised:
            migrate(self.database, MIGRATIONS)
        self.assertIn("migration_failed", str(raised.exception))
        self.assertNotIn(BODY, str(raised.exception))
        self._assert_old_schema()
        self.assertEqual(self._snapshot(), before)
        target.write_bytes(RESOURCE)
        self.assertEqual(migrate(self.database, MIGRATIONS), (TAIL,))
        self._assert_new_schema()

    def test_corrupt_existing_method_file_preserves_old_schema_until_repaired(self):
        version = self._legacy(reviewed=True)
        self._directory_version(version)
        with psycopg.connect(self.database) as connection:
            write_method_manifest(connection, version.version, [
                {"method_id": version.method, "title": "温暖回应", "instruction": BODY},
            ])
            connection.execute("UPDATE public.reply_skill_method SET title=NULL,instruction=NULL WHERE version_id=%s", (version.version,))
        target = self.root / f".versions/{version.owner}/{version.skill}/{version.version}/methods/{version.method}.json"
        original = target.read_bytes()
        target.write_bytes(b"{}")
        before = self._snapshot()
        with self.assertRaises(MigrationError):
            migrate(self.database, MIGRATIONS)
        self._assert_old_schema()
        self.assertEqual(self._snapshot(), before)
        target.write_bytes(original)
        self.assertEqual(migrate(self.database, MIGRATIONS), (TAIL,))
        with psycopg.connect(self.database) as connection:
            self.assertEqual(read_method_manifest(connection, version.version)[0]["instruction"], BODY)

    def test_sql_failure_after_dropping_columns_rolls_back_content_and_can_resume(self):
        version = self._legacy(reviewed=True)
        before = self._snapshot()
        shutil.copyfile(MIGRATIONS / TAIL, self.prefix / TAIL)
        original = (self.prefix / TAIL).read_text()
        (self.prefix / TAIL).write_text(original.replace(
            "COMMIT;", "DO $$ BEGIN RAISE EXCEPTION 'synthetic-after-drop'; END $$;\nCOMMIT;"
        ))
        with self.assertRaises(MigrationError):
            migrate(self.database, self.prefix)
        self._assert_old_schema()
        self.assertEqual(self._snapshot(), before)
        self.assertEqual(migrate(self.database, MIGRATIONS), (TAIL,))
        with psycopg.connect(self.database) as connection:
            self.assertEqual(read_version_content(connection, version.version), BODY)
            self.assertEqual(read_method_manifest(connection, version.version)[0]["instruction"], BODY)


if __name__ == "__main__":
    unittest.main()
