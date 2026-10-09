"""显式旧库接管验收；所有资料和备份来自本用例拥有的合成库。"""

from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg import sql

from notalone.database_adoption import adopt_legacy_database, audit_legacy_database
from notalone.database_migrations import MigrationError, migrate


ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "database/migrations"


class DatabaseAdoptionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.name = f"notalone_adoption_{uuid4().hex}_test"
        self.url = f"host=/tmp dbname={self.name}"
        self.admin = psycopg.connect("host=/tmp dbname=postgres", autocommit=True)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
            sql.Identifier(self.name)
        ))
        self.addCleanup(self._drop_database)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.backup = Path(self.temp.name) / "backup"
        self.prefix = Path(self.temp.name) / "prefix"
        self.prefix.mkdir()
        for path in sorted(MIGRATIONS.glob("*.sql"))[:35]:
            shutil.copy2(path, self.prefix / path.name)
        migrate(self.url, self.prefix)
        with psycopg.connect(self.url) as connection:
            connection.execute("DROP TABLE public.notalone_schema_migration")
            connection.execute("""
                ALTER TABLE public.source_document
                    DROP CONSTRAINT source_document_source_type_check;
                ALTER TABLE public.source_document
                    ADD CONSTRAINT source_document_source_type_check
                    CHECK (source_type = 'wechat_jsonl');
            """)

    def _drop_database(self) -> None:
        try:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                sql.Identifier(self.name)
            ))
        finally:
            self.admin.close()

    def _seed_scope(self, existing_owner: UUID | None = None) -> tuple:
        owner, contact, binding, document, message = (uuid4() for _ in range(5))
        owner = existing_owner or owner
        with psycopg.connect(self.url) as connection:
            if existing_owner is None:
                connection.execute("INSERT INTO public.owner (id, display_name) VALUES (%s, '合成用户')", (owner,))
            connection.execute("INSERT INTO public.contact (owner_id, id, display_name) "
                               "VALUES (%s, %s, '合成联系人')", (owner, contact))
            connection.execute("""
                INSERT INTO public.conversation_binding
                    (id, owner_id, contact_id, channel, account_scope, conversation_locator)
                VALUES (%s, %s, %s, 'wechat', 'synthetic_account', %s)
            """, (binding, owner, contact, f"synthetic_{binding}"))
            connection.execute("""
                INSERT INTO public.source_document
                    (id, owner_id, contact_id, source_type, file_name, content_sha256, record_count)
                VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic.jsonl', %s, 1)
            """, (document, owner, contact, "a" * 64))
            connection.execute("""
                INSERT INTO public.message (id, owner_id, contact_id, speaker, message_type, text_content)
                VALUES (%s, %s, %s, 'contact', 'text', '仅用于合成测试的消息')
            """, (message, owner, contact))
            connection.execute("""
                INSERT INTO public.message_source_ref
                    (message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload)
                VALUES (%s, %s, %s, 'source_document', %s, 'line:1', '{"synthetic": true}')
            """, (message, owner, contact, document))
            connection.execute("""
                INSERT INTO public.cli_backfill_state
                    (owner_id, contact_id, binding_id, phase, trigger_at)
                VALUES (%s, %s, %s, 'paused', now())
            """, (owner, contact, binding))
            connection.execute("INSERT INTO public.front_sync_state (owner_id, enabled) VALUES (%s, true) "
                               "ON CONFLICT (owner_id) DO NOTHING", (owner,))
        return owner, contact, binding, document, message

    def _assert_unadopted(self) -> None:
        with psycopg.connect(self.url) as connection:
            self.assertIsNone(connection.execute(
                "SELECT to_regclass('public.notalone_schema_baseline')"
            ).fetchone()[0])
            self.assertIsNone(connection.execute(
                "SELECT to_regclass('public.notalone_schema_migration')"
            ).fetchone()[0])
            definition = connection.execute("""
                SELECT pg_get_constraintdef(oid, true) FROM pg_constraint
                WHERE conrelid = 'public.source_document'::regclass
                    AND conname = 'source_document_source_type_check'
            """).fetchone()[0]
            self.assertNotIn("manual", definition)

    def _run_command(self) -> subprocess.CompletedProcess:
        env = dict(os.environ, NOTALONE_DATABASE_URL=self.url)
        return subprocess.run([sys.executable, "-m", "notalone.database_adoption",
                               "--migrations", str(MIGRATIONS), "--adopt",
                               "--backup-dir", str(self.backup)],
                              cwd=ROOT, env=env, text=True, capture_output=True, timeout=60)

    def test_audited_baseline_is_separate_from_real_migration_receipts(self) -> None:
        audit = audit_legacy_database(self.url, MIGRATIONS)
        self.assertTrue(audit.repair_required)
        result = adopt_legacy_database(self.url, MIGRATIONS, self.backup)
        self.assertTrue(result.adopted)
        archive = self.backup / "database.dump"
        self.assertEqual(result.backup_sha256, hashlib.sha256(archive.read_bytes()).hexdigest())
        self.assertEqual(self.backup.stat().st_mode & 0o777, 0o700)
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        with psycopg.connect(self.url) as connection:
            baseline = connection.execute("""
                SELECT through_version, jsonb_array_length(manifest), restore_verified_at,
                    repair_sha256 FROM public.notalone_schema_baseline
            """).fetchone()
            self.assertEqual(baseline[:2], (35, 35))
            self.assertIsNotNone(baseline[2])
            self.assertIsNotNone(baseline[3])
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.notalone_schema_migration"
            ).fetchone()[0], 0)
        self.assertEqual(migrate(self.url, MIGRATIONS), (
            "036_source_deletion_tasks.sql",
            "037_pending_candidate_evidence_kind.sql",
            "038_memory_candidate_interpretation.sql",
            "039_memory_extraction_trace.sql",
            "040_source_processing_trace.sql",
            "041_source_processing_capture_tombstone.sql",
            "042_extraction_trace_call_receipts.sql",
            "043_extraction_trace_record_operations.sql",
            "044_owner_memory_versioning.sql",
            "045_observation_background_task.sql",
        ))
        self.assertEqual(migrate(self.url, MIGRATIONS), ())
        self.assertFalse(adopt_legacy_database(self.url, MIGRATIONS, self.backup).adopted)
        with psycopg.connect(self.url) as connection:
            self.assertEqual(connection.execute(
                "SELECT name FROM public.notalone_schema_migration"
            ).fetchall(), [
                ("036_source_deletion_tasks.sql",),
                ("037_pending_candidate_evidence_kind.sql",),
                ("038_memory_candidate_interpretation.sql",),
                ("039_memory_extraction_trace.sql",),
                ("040_source_processing_trace.sql",),
                ("041_source_processing_capture_tombstone.sql",),
                ("042_extraction_trace_call_receipts.sql",),
                ("043_extraction_trace_record_operations.sql",),
                ("044_owner_memory_versioning.sql",),
                ("045_observation_background_task.sql",),
            ])

    def test_full_035_needs_no_repair_and_preserves_ids_pause_and_message_evidence(self) -> None:
        owner, contact, binding, document, message = self._seed_scope()
        with psycopg.connect(self.url) as connection:
            connection.execute((MIGRATIONS / "025_manual_memory_source.sql").read_text())
            # 规范消息 UUID 是合法证据，不能误判为丢失的文档/观察。
            connection.execute("""
                INSERT INTO public.confirmed_memory
                    (owner_id, contact_id, text_content, category, source_ids, adoption_method)
                VALUES (%s, %s, '合成记忆', 'common_fact', %s, 'manual')
            """, (owner, contact, [message]))
            connection.execute("""
                INSERT INTO public.owner_memory
                    (id, owner_id, text_content, category, source_ids, adoption_method)
                VALUES (%s, %s, '合成本人记忆', 'common_fact', %s, 'manual')
            """, (uuid4(), owner, [message]))
        self.assertFalse(audit_legacy_database(self.url, MIGRATIONS).repair_required)
        self.assertTrue(adopt_legacy_database(self.url, MIGRATIONS, self.backup).adopted)
        migrate(self.url, MIGRATIONS)
        with psycopg.connect(self.url) as connection:
            self.assertEqual(connection.execute("SELECT id FROM public.source_document").fetchone()[0], document)
            self.assertEqual(connection.execute("SELECT id FROM public.message").fetchone()[0], message)
            self.assertEqual(connection.execute("SELECT binding_id, phase FROM public.cli_backfill_state").fetchone(),
                             (binding, "paused"))
            self.assertTrue(connection.execute("SELECT enabled FROM public.front_sync_state").fetchone()[0])
            self.assertIsNone(connection.execute("SELECT repair_sha256 FROM public.notalone_schema_baseline").fetchone()[0])

    def test_extra_structure_and_unknown_constraint_are_rejected_without_backup(self) -> None:
        with psycopg.connect(self.url) as connection:
            connection.execute("CREATE TABLE public.extra_probe (id int)")
        with self.assertRaisesRegex(MigrationError, "legacy_schema_mismatch"):
            adopt_legacy_database(self.url, MIGRATIONS, self.backup)
        self.assertFalse(self.backup.exists())
        self._assert_unadopted()
        with psycopg.connect(self.url) as connection:
            connection.execute("DROP TABLE public.extra_probe")
            connection.execute("""
                ALTER TABLE public.source_document DROP CONSTRAINT source_document_source_type_check;
                ALTER TABLE public.source_document ADD CONSTRAINT source_document_source_type_check
                    CHECK (source_type IN ('wechat_jsonl', 'manual', 'unknown'));
            """)
        with self.assertRaisesRegex(MigrationError, "legacy_schema_mismatch"):
            audit_legacy_database(self.url, MIGRATIONS)

    def test_cross_owner_source_reference_is_rejected_for_all_owners(self) -> None:
        self._seed_scope()
        owner, contact, _, document, _ = self._seed_scope()
        message = uuid4()
        with psycopg.connect(self.url) as connection:
            connection.execute("""
                INSERT INTO public.message (id, owner_id, contact_id, speaker, message_type, text_content)
                VALUES (%s, %s, %s, 'contact', 'text', '不应出现在错误输出中的合成正文')
            """, (message, owner, contact))
            other_document = connection.execute(
                "SELECT id FROM public.source_document WHERE id <> %s", (document,)
            ).fetchone()[0]
            connection.execute("""
                INSERT INTO public.message_source_ref
                    (message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload)
                VALUES (%s, %s, %s, 'source_document', %s, 'bad:2', '{}')
            """, (message, owner, contact, other_document))
        result = self._run_command()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("document_ref_scope=1", result.stderr)
        for secret in (str(owner), str(contact), str(message), "不应出现在错误输出"):
            self.assertNotIn(secret, result.stderr + result.stdout)
        self._assert_unadopted()

    def test_source_less_message_and_cross_owner_memory_are_rejected(self) -> None:
        owner, contact, _, _, message = self._seed_scope()
        other_owner, other_contact, _, other_document, _ = self._seed_scope()
        with psycopg.connect(self.url) as connection:
            connection.execute("DELETE FROM public.message_source_ref WHERE message_id = %s", (message,))
        with self.assertRaisesRegex(MigrationError, "message_without_source=1"):
            audit_legacy_database(self.url, MIGRATIONS)
        with psycopg.connect(self.url) as connection:
            connection.execute("DELETE FROM public.message WHERE id = %s", (message,))
            connection.execute("""
                INSERT INTO public.confirmed_memory
                    (owner_id, contact_id, text_content, category, source_ids, adoption_method)
                VALUES (%s, %s, '非法合成证据', 'common_fact', %s, 'manual')
            """, (owner, contact, [other_document]))
            connection.execute("""
                INSERT INTO public.owner_memory
                    (id, owner_id, text_content, category, source_ids, adoption_method)
                VALUES (%s, %s, '非法本人证据', 'common_fact', %s, 'manual')
            """, (uuid4(), other_owner, [uuid4()]))
        with self.assertRaisesRegex(MigrationError, "confirmed_memory_sources=1.*owner_memory_sources=1"):
            adopt_legacy_database(self.url, MIGRATIONS, self.backup)
        self._assert_unadopted()

    def test_writers_and_shared_migration_lock_prevent_adoption(self) -> None:
        with psycopg.connect(self.url, autocommit=True) as writer:
            with self.assertRaisesRegex(MigrationError, "adoption_writers_present"):
                adopt_legacy_database(self.url, MIGRATIONS, self.backup)
            writer.execute("SELECT pg_advisory_lock(1852798049, 1)")
            with self.assertRaisesRegex(MigrationError, "migration_busy"):
                adopt_legacy_database(self.url, MIGRATIONS, self.backup)
        self._assert_unadopted()

    def test_prefix_drift_is_rejected_before_adoption_and_after_baseline(self) -> None:
        changed = self.prefix / "001_initial_ingest.sql"
        original = changed.read_text()
        changed.write_text(original + "\n-- 漂移\n")
        with self.assertRaisesRegex(MigrationError, "baseline_files_mismatch"):
            adopt_legacy_database(self.url, self.prefix, self.backup)
        self._assert_unadopted()
        changed.write_text(original)
        adopt_legacy_database(self.url, MIGRATIONS, self.backup)
        changed.write_text(original + "\n-- 漂移\n")
        shutil.copy2(MIGRATIONS / "036_source_deletion_tasks.sql", self.prefix)
        with self.assertRaisesRegex(MigrationError, "baseline_files_mismatch"):
            migrate(self.url, self.prefix)
        with psycopg.connect(self.url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.notalone_schema_migration").fetchone()[0], 0)

    def _pg_wrapper(self, program: str, body: str) -> Path:
        tools = Path(self.temp.name) / "tools"
        tools.mkdir(exist_ok=True)
        executable = shutil.which(program)
        self.assertIsNotNone(executable)
        wrapper = tools / program
        wrapper.write_text(f"#!{sys.executable}\nimport os, subprocess, sys\n"
                           f"result = subprocess.run([{executable!r}, *sys.argv[1:]])\n"
                           "if '--version' not in sys.argv and result.returncode == 0:\n"
                           + body + "\nsys.exit(result.returncode)\n")
        wrapper.chmod(0o700)
        return tools

    def test_backup_failure_is_safe_and_never_repairs_or_records_baseline(self) -> None:
        tools = self._pg_wrapper("pg_dump", "    print('synthetic_private_failure', file=sys.stderr)\n    sys.exit(7)")
        with patch.dict(os.environ, {"PATH": str(tools) + os.pathsep + os.environ["PATH"]}):
            result = self._run_command()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("backup_restore_failed", result.stderr)
        self.assertNotIn("synthetic_private_failure", result.stderr + result.stdout)
        self._assert_unadopted()

    def test_evidence_write_failure_rolls_back_repair_and_baseline_together(self) -> None:
        self._seed_scope()
        tools = self._pg_wrapper("pg_restore", f"    os.chmod({str(self.backup)!r}, 0o500)")
        try:
            with patch.dict(os.environ, {"PATH": str(tools) + os.pathsep + os.environ["PATH"]}):
                with self.assertRaisesRegex(MigrationError, "adoption_failed"):
                    adopt_legacy_database(self.url, MIGRATIONS, self.backup)
        finally:
            if self.backup.exists():
                self.backup.chmod(0o700)
        self._assert_unadopted()
        self.assertTrue((self.backup / "database.dump").is_file())
        self.assertFalse((self.backup / "verification.json").exists())
        self.assertTrue(adopt_legacy_database(self.url, MIGRATIONS,
                                            Path(self.temp.name) / "retry").adopted)

    def test_interrupted_036_rolls_back_and_resumes_from_audited_035(self) -> None:
        adopt_legacy_database(self.url, MIGRATIONS, self.backup)
        path = self.prefix / "036_source_deletion_tasks.sql"
        original = (MIGRATIONS / path.name).read_text()
        # 在完成约束 SQL、写入凭证之前故意等待；终止自己的测试库连接。
        path.write_text(original.replace("COMMIT;", "SELECT pg_advisory_lock(1852798049, 2);\nCOMMIT;"))
        with psycopg.connect(self.url, autocommit=True) as gate:
            gate.execute("SELECT pg_advisory_lock(1852798049, 2)")
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(migrate, self.url, self.prefix)
                deadline = time.monotonic() + 10
                pid = None
                while time.monotonic() < deadline:
                    row = gate.execute("""
                        SELECT pid FROM pg_stat_activity
                        WHERE datname = current_database() AND pid <> pg_backend_pid()
                            AND wait_event = 'advisory'
                    """).fetchone()
                    if row:
                        pid = row[0]
                        break
                    time.sleep(0.02)
                self.assertIsNotNone(pid)
                gate.execute("SELECT pg_terminate_backend(%s)", (pid,))
                with self.assertRaisesRegex(MigrationError, "migration_failed"):
                    pending.result(timeout=5)
        with psycopg.connect(self.url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.notalone_schema_migration").fetchone()[0], 0)
            definition = connection.execute("""
                SELECT pg_get_constraintdef(oid) FROM pg_constraint
                WHERE conrelid = 'public.background_task'::regclass
                    AND conname = 'background_task_task_type_check'
            """).fetchone()[0]
            self.assertNotIn("delete", definition)
        path.write_text(original)
        self.assertEqual(migrate(self.url, self.prefix), (path.name,))

    def test_fake_historical_success_is_rejected_after_audited_baseline(self) -> None:
        adopt_legacy_database(self.url, MIGRATIONS, self.backup)
        with psycopg.connect(self.url) as connection:
            connection.execute("INSERT INTO public.notalone_schema_migration (name, checksum) "
                               "VALUES ('001_initial_ingest.sql', %s)", ("a" * 64,))
        with self.assertRaisesRegex(MigrationError, "migration_history_mismatch"):
            migrate(self.url, MIGRATIONS)

    def test_nonlocal_defaults_are_rejected_before_connecting(self) -> None:
        with patch.dict(os.environ, {"PGHOST": "remote.invalid"}):
            with self.assertRaisesRegex(MigrationError, "adoption_local_only"):
                adopt_legacy_database(f"dbname={self.name} host=''", MIGRATIONS, self.backup)
        self._assert_unadopted()

    def test_unsafe_backup_location_is_rejected_before_source_changes(self) -> None:
        with self.assertRaisesRegex(MigrationError, "backup_path_invalid"):
            adopt_legacy_database(self.url, MIGRATIONS, ROOT / "private_backup")
        self._assert_unadopted()
        self.assertFalse((ROOT / "private_backup").exists())

    def test_backup_outside_backend_but_inside_repository_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="synthetic_backup_", dir=ROOT.parent) as temporary:
            backup = Path(temporary)
            with self.assertRaisesRegex(MigrationError, "backup_path_invalid"):
                adopt_legacy_database(self.url, MIGRATIONS, backup)
            self._assert_unadopted()
            self.assertEqual(list(backup.iterdir()), [])

    def test_cross_scope_observation_binding_is_rejected(self) -> None:
        owner, contact, _, _, _ = self._seed_scope()
        _, _, other_binding, _, _ = self._seed_scope()
        with psycopg.connect(self.url) as connection:
            connection.execute("""
                INSERT INTO public.local_wechat_observation
                    (owner_id, contact_id, binding_id, mode, cli_version,
                     conversation_locator, last_local_id, last_cursor, record_count)
                VALUES (%s, %s, %s, 'cli_background', 'synthetic', %s, 1, 'synthetic_cursor', 0)
            """, (owner, contact, other_binding, f"synthetic_{other_binding}"))
        with self.assertRaisesRegex(MigrationError, "local_wechat_observation_binding_scope=1"):
            audit_legacy_database(self.url, MIGRATIONS)
        self._assert_unadopted()

    def test_same_owner_other_contact_memory_source_is_rejected(self) -> None:
        owner, contact, _, _, _ = self._seed_scope()
        _, _, _, _, other_message = self._seed_scope(owner)
        with psycopg.connect(self.url) as connection:
            connection.execute("""
                INSERT INTO public.memory_candidate
                    (owner_id, contact_id, text_content, category, source_ids)
                VALUES (%s, %s, '跨联系人合成证据', 'common_fact', %s)
            """, (owner, contact, [other_message]))
        with self.assertRaisesRegex(MigrationError, "memory_candidate_sources=1"):
            audit_legacy_database(self.url, MIGRATIONS)

    def test_extra_composite_rule_and_pg_named_schema_are_rejected(self) -> None:
        cases = (
            ("CREATE TYPE public.extra_probe AS (id int)", "DROP TYPE public.extra_probe"),
            ("CREATE RULE extra_probe AS ON UPDATE TO public.owner DO ALSO NOTHING",
             "DROP RULE extra_probe ON public.owner"),
            ("CREATE SCHEMA pgbench", "DROP SCHEMA pgbench"),
            ("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC",
             "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM PUBLIC"),
        )
        for create, drop in cases:
            with self.subTest(object=create):
                with psycopg.connect(self.url) as connection:
                    connection.execute(create)
                try:
                    with self.assertRaisesRegex(MigrationError, "legacy_schema_mismatch"):
                        audit_legacy_database(self.url, MIGRATIONS)
                finally:
                    with psycopg.connect(self.url) as connection:
                        connection.execute(drop)

    def test_catalog_function_shadowing_never_executes_legacy_side_effects(self) -> None:
        with psycopg.connect(self.url) as connection:
            connection.execute("""
                CREATE FUNCTION public.to_regclass(text) RETURNS regclass LANGUAGE plpgsql AS $$
                BEGIN
                    INSERT INTO public.owner (id, display_name) VALUES (gen_random_uuid(), 'unsafe_probe');
                    RETURN pg_catalog.to_regclass($1);
                END $$;
                CREATE FUNCTION public.pg_try_advisory_lock(integer, integer) RETURNS boolean
                LANGUAGE plpgsql AS $$
                BEGIN
                    INSERT INTO public.owner (id, display_name) VALUES (gen_random_uuid(), 'unsafe_probe');
                    RETURN pg_catalog.pg_try_advisory_lock($1, $2);
                END $$;
            """)
        url = self.url + " options='-csearch_path=public,pg_catalog'"
        with self.assertRaisesRegex(MigrationError, "legacy_schema_mismatch"):
            adopt_legacy_database(url, MIGRATIONS, self.backup)
        with psycopg.connect(self.url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.owner").fetchone()[0], 0)

    def test_table_owner_drift_is_rejected(self) -> None:
        if not self.admin.execute("SELECT rolsuper FROM pg_roles WHERE rolname=current_user").fetchone()[0]:
            self.skipTest("所有权漂移夹具需要本机 PostgreSQL superuser；不创建集群角色。")
        with psycopg.connect(self.url) as connection:
            connection.execute("ALTER TABLE public.owner OWNER TO pg_read_all_data")
        with self.assertRaisesRegex(MigrationError, "legacy_schema_mismatch"):
            audit_legacy_database(self.url, MIGRATIONS)

    def test_restore_with_same_count_but_modified_content_is_rejected(self) -> None:
        self._seed_scope()
        tools = self._pg_wrapper("pg_restore", "    import psycopg\n"
                                 "    with psycopg.connect('') as c:\n"
                                 "        c.execute(\"UPDATE public.owner SET display_name = 'corrupted'\")")
        with patch.dict(os.environ, {"PATH": str(tools) + os.pathsep + os.environ["PATH"]}):
            with self.assertRaisesRegex(MigrationError, "restore_mismatch"):
                adopt_legacy_database(self.url, MIGRATIONS, self.backup)
        self._assert_unadopted()

    def test_new_object_committed_during_backup_is_rejected_with_fresh_catalog(self) -> None:
        tools = self._pg_wrapper("pg_restore", "    import psycopg\n"
                                 f"    with psycopg.connect({self.url!r}) as c:\n"
                                 "        c.execute('CREATE TABLE public.concurrent_probe (id int)')")
        with patch.dict(os.environ, {"PATH": str(tools) + os.pathsep + os.environ["PATH"]}):
            with self.assertRaisesRegex(MigrationError, "adoption_repair_mismatch"):
                adopt_legacy_database(self.url, MIGRATIONS, self.backup)
        self._assert_unadopted()

    def test_second_client_arriving_during_backup_is_rejected_before_commit(self) -> None:
        signal = Path(self.temp.name) / "restored.signal"
        tools = self._pg_wrapper("pg_restore", "    from pathlib import Path\n    import time\n"
                                 f"    Path({str(signal)!r}).write_text('ready')\n    time.sleep(0.5)")
        with patch.dict(os.environ, {"PATH": str(tools) + os.pathsep + os.environ["PATH"]}):
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(adopt_legacy_database, self.url, MIGRATIONS, self.backup)
                deadline = time.monotonic() + 10
                while not signal.exists() and time.monotonic() < deadline and not pending.done():
                    time.sleep(0.02)
                self.assertTrue(signal.exists())
                with psycopg.connect(self.url):
                    with self.assertRaisesRegex(MigrationError, "adoption_writers_present"):
                        pending.result(timeout=10)
        self._assert_unadopted()

    def test_extra_function_added_to_builtin_extension_is_rejected(self) -> None:
        with psycopg.connect(self.url) as connection:
            connection.execute("""
                CREATE FUNCTION public.extension_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1';
                ALTER EXTENSION plpgsql ADD FUNCTION public.extension_probe();
            """)
        with self.assertRaisesRegex(MigrationError, "legacy_schema_mismatch"):
            audit_legacy_database(self.url, MIGRATIONS)

    def test_new_object_committed_while_evidence_is_written_rolls_back_baseline(self) -> None:
        original_fsync = os.fsync
        evidence = self.backup / "verification.json"

        def fsync_with_other_commit(descriptor: int) -> None:
            # 文件 I/O 接缝故障注入；另一连接真实提交 DDL，不替换数据库核验。
            if evidence.exists() and os.fstat(descriptor).st_ino == evidence.stat().st_ino:
                with psycopg.connect(self.url) as peer:
                    peer.execute("CREATE TABLE public.late_probe (id int)")
            original_fsync(descriptor)

        with patch("os.fsync", side_effect=fsync_with_other_commit):
            with self.assertRaisesRegex(MigrationError, "adoption_repair_mismatch"):
                adopt_legacy_database(self.url, MIGRATIONS, self.backup)
        self._assert_unadopted()
