"""本机更新恢复点服从明确来源删除，真实恢复证明不能从App快照找回。"""

import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg import sql

from notalone.database_adoption import _owned_database, _run_pg
from notalone.database_migrations import MigrationError
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository, SourceDeletionError
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient
from tests.integration.persistence import test_database_updates as update_fixtures


class ManagedUpdateBackupDeletionTest(unittest.TestCase):
    _fixture = update_fixtures.DatabaseUpdatesTest._fixture
    _command = update_fixtures.DatabaseUpdatesTest._command
    _response_code = staticmethod(update_fixtures.DatabaseUpdatesTest._response_code)

    def setUp(self) -> None:
        update_fixtures.DatabaseUpdatesTest.setUp(self)
        self.user_data = Path(self.directory.name) / "app-data"
        (self.user_data / "managed").mkdir(parents=True, mode=0o700)
        (self.user_data / "managed/state.json").write_text(json.dumps({"formatVersion": 1, "password": "synthetic", "bootstrapComplete": True}))
        (self.user_data / "managed/state.json").chmod(0o600)
        (self.user_data / "updates").mkdir(mode=0o700)
        self.backup = self.user_data / "updates" / str(uuid4())
        plan = json.loads(self._command("--inspect").stdout)
        result = self._command("--update", "--backup-dir", str(self.backup), "--expected-target", plan["target_fingerprint"])
        self.assertEqual(result.returncode, 0, self._response_code(result))
        with psycopg.connect(self.target["database_url"]) as connection:
            self.source_id = connection.execute("SELECT id FROM public.source_document").fetchone()[0]
        self.repository = PostgresSourceDeletionRepository(self.target["database_url"])
        self.scope = {"owner_id": UUID(self.target["owner"]), "contact_id": UUID(self.target["contact"]), "source_document_id": self.source_id}

    def _client(self) -> InProcessClient:
        return InProcessClient(create_app(
            database_url=self.target["database_url"], owner_id=self.scope["owner_id"], token="synthetic",
        ))

    def _latest_archive(self) -> Path:
        backup = self.user_data / "updates" / str(uuid4())
        plan = json.loads(self._command("--inspect").stdout)
        result = self._command("--update", "--backup-dir", str(backup), "--expected-target", plan["target_fingerprint"])
        self.assertEqual(result.returncode, 0, self._response_code(result))
        return backup / "database.dump"

    def _preference_and_learning(self) -> tuple[dict, UUID, Path]:
        response = self._client().request("POST", "/api/expression-preferences", headers={"Authorization": "Bearer synthetic"}, body=json.dumps({
            "operation_key": str(uuid4()), "text": "仅在本例保存的长期表达要求",
            "scope": {"contact_id": self.target["contact"], "reply_mode": None},
            "origin": {"kind": "manual"}, "confirm_long_term": True,
        }).encode())
        self.assertEqual(response.status_code, 200)
        preference = json.loads(response.body)["preference"]
        draft, comparison = uuid4(), uuid4()
        owner, contact = self.scope["owner_id"], self.scope["contact_id"]
        with psycopg.connect(self.target["database_url"]) as connection:
            connection.execute("""INSERT INTO public.skill_draft
                (id,owner_id,contact_id,logical_skill_id,proposal_kind,strategy,private_evidence,dependency_ids,batch_key)
                VALUES (%s,%s,%s,%s,'create','{"document":"仅合成的策略正文"}',
                        '{"body":"仅合成的私人审核依据"}',%s,%s)""",
                (draft, owner, contact, uuid4(), [UUID(preference["preference_id"])], uuid4().hex))
            connection.execute("""INSERT INTO public.skill_review_comparison
                (id,owner_id,contact_id,draft_id,draft_revision,input_version,input,library_revision,state,dependency_ids,result)
                VALUES (%s,%s,%s,%s,1,%s,'{"text":"仅合成的审核输入"}',0,'completed',%s,
                        '{"text":"仅合成的审核结果"}')""",
                (comparison, owner, contact, draft, uuid4(), [UUID(preference["preference_id"])]))
        return preference, draft, self._latest_archive()

    def _delete_preference(self, preference: dict):
        return self._client().request("DELETE", "/api/expression-preferences/" + preference["preference_id"]
            + "?contact_id=" + self.target["contact"],
            headers={"Authorization": "Bearer synthetic"}, body=json.dumps({
                "operation_key": str(uuid4()), "expected_revision": preference["revision"],
            }).encode())

    def test_preference_deletion_erases_learning_bodies_and_the_archive_that_restored_them(self) -> None:
        preference, draft, archive = self._preference_and_learning()
        with _owned_database(self.target["database_url"], "preference_before", synthetic=False) as restored:
            _run_pg("pg_restore", restored, ["--single-transaction", "--exit-on-error", str(archive)])
            with psycopg.connect(restored) as connection:
                self.assertEqual(connection.execute("SELECT text_content FROM public.expression_preference WHERE id=%s",
                    (UUID(preference["preference_id"]),)).fetchone()[0], "仅在本例保存的长期表达要求")
                self.assertEqual(connection.execute("SELECT strategy->>'document' FROM public.skill_draft WHERE id=%s",
                    (draft,)).fetchone()[0], "仅合成的策略正文")
                self.assertEqual(connection.execute("SELECT input->>'text' FROM public.skill_review_comparison WHERE draft_id=%s",
                    (draft,)).fetchone()[0], "仅合成的审核输入")
        with patch.dict(os.environ, {"NOTALONE_MANAGED_USER_DATA": str(self.user_data)}):
            response = self._delete_preference(preference)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body), {"state": "deleted"})
        with psycopg.connect(self.target["database_url"]) as connection:
            self.assertEqual(connection.execute("SELECT status,strategy,private_evidence FROM public.skill_draft WHERE id=%s",
                (draft,)).fetchone(), ("invalidated", None, None))
            self.assertEqual(connection.execute("SELECT state,input,result FROM public.skill_review_comparison WHERE draft_id=%s",
                (draft,)).fetchone(), ("invalidated", None, None))
        self.assertEqual(list((self.user_data / "updates").glob("*/database.dump")), [])
        with _owned_database(self.target["database_url"], "preference_after", synthetic=False) as restored:
            with self.assertRaisesRegex(MigrationError, "backup_restore_failed"):
                _run_pg("pg_restore", restored, ["--single-transaction", "--exit-on-error", str(archive)])

    def _upgrade_and_archive(self) -> tuple[UUID, Path]:
        job, task, batch = uuid4(), uuid4(), uuid4()
        owner, contact = self.scope["owner_id"], self.scope["contact_id"]
        with psycopg.connect(self.target["database_url"]) as connection:
            connection.execute("""INSERT INTO public.memory_upgrade_job
                (id,owner_id,contact_id,scope_kind,operation_key,message_limit,batch_size,model_call_limit)
                VALUES (%s,%s,%s,'contact',%s,1,1,1)""", (job, owner, contact, uuid4()))
            connection.execute("""INSERT INTO public.background_task
                (id,owner_id,contact_id,task_type,current_step,message_count)
                VALUES (%s,%s,%s,'memory_upgrade','preview_upgrade',1)""", (task, owner, contact))
            connection.execute("""INSERT INTO public.memory_upgrade_batch
                (id,job_id,owner_id,contact_id,task_id,batch_number,state,message_ids,source_generation,
                 comparison,extracted_outcome,dependency_ids)
                VALUES (%s,%s,%s,%s,%s,1,'ready','{}','{}','{"text":"仅合成的升级比较"}',
                        '{"text":"仅合成的临时提取"}','{}')""", (batch, job, owner, contact, task))
        return job, self._latest_archive()

    def _delete_upgrade(self, job: UUID):
        return self._client().request("DELETE", f"/api/memory-upgrades/{job}?contact_id={self.target['contact']}",
            headers={"Authorization": "Bearer synthetic"}, body=json.dumps({
                "action": "delete", "expected_revision": 1, "operation_key": str(uuid4()), "confirmed": True,
            }).encode())

    def test_upgrade_deletion_erases_the_archive_that_restored_the_private_preview(self) -> None:
        job, archive = self._upgrade_and_archive()
        with _owned_database(self.target["database_url"], "upgrade_before", synthetic=False) as restored:
            _run_pg("pg_restore", restored, ["--single-transaction", "--exit-on-error", str(archive)])
            with psycopg.connect(restored) as connection:
                self.assertEqual(connection.execute("SELECT comparison->>'text' FROM public.memory_upgrade_batch WHERE job_id=%s",
                    (job,)).fetchone()[0], "仅合成的升级比较")
        with patch.dict(os.environ, {"NOTALONE_MANAGED_USER_DATA": str(self.user_data)}):
            response = self._delete_upgrade(job)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body)["state"], "deleted")
        with psycopg.connect(self.target["database_url"]) as connection:
            self.assertEqual(connection.execute("SELECT state,comparison,extracted_outcome FROM public.memory_upgrade_batch WHERE job_id=%s",
                (job,)).fetchone(), ("invalidated", None, None))
        self.assertEqual(list((self.user_data / "updates").glob("*/database.dump")), [])
        with _owned_database(self.target["database_url"], "upgrade_after", synthetic=False) as restored:
            with self.assertRaisesRegex(MigrationError, "backup_restore_failed"):
                _run_pg("pg_restore", restored, ["--single-transaction", "--exit-on-error", str(archive)])

    def test_new_body_deletions_reject_unknown_unfinished_or_foreign_archives_without_partial_erasure(self) -> None:
        preference, draft, archive = self._preference_and_learning()
        job, upgrade_archive = self._upgrade_and_archive()
        checkpoint = archive.parent / "checkpoint.json"
        valid = checkpoint.read_bytes()
        original_archives = {path: path.read_bytes() for path in (self.backup / "database.dump", archive, upgrade_archive)}
        unknown = self.user_data / "updates/unknown"
        for kind in ("unknown", "unfinished", "foreign"):
            if kind == "unknown":
                unknown.mkdir(mode=0o700)
                (unknown / "external.txt").write_text("未知目录中的用户文件")
            else:
                changed = json.loads(valid)
                if kind == "unfinished":
                    changed["phase"] = "migrating"
                else:
                    changed["target_fingerprint"] = "0" * 64
                checkpoint.write_text(json.dumps(changed))
            try:
                for resource in ("preference", "upgrade"):
                    with self.subTest(archive=kind, resource=resource):
                        with patch.dict(os.environ, {"NOTALONE_MANAGED_USER_DATA": str(self.user_data)}):
                            response = self._delete_preference(preference) if resource == "preference" else self._delete_upgrade(job)
                        self.assertEqual(response.status_code, 409)
                        self.assertEqual(json.loads(response.body), {"error": "update_backup_cleanup_required"})
                        for path, original in original_archives.items():
                            self.assertEqual(path.read_bytes(), original)
                        with psycopg.connect(self.target["database_url"]) as connection:
                            self.assertEqual(connection.execute("SELECT status,text_content FROM public.expression_preference WHERE id=%s",
                                (UUID(preference["preference_id"]),)).fetchone(), ("active", "仅在本例保存的长期表达要求"))
                            self.assertEqual(connection.execute("SELECT status FROM public.skill_draft WHERE id=%s", (draft,)).fetchone()[0], "pending")
                            self.assertEqual(connection.execute("SELECT state FROM public.memory_upgrade_job WHERE id=%s", (job,)).fetchone()[0], "active")
                            self.assertEqual(connection.execute("SELECT comparison->>'text' FROM public.memory_upgrade_batch WHERE job_id=%s",
                                (job,)).fetchone()[0], "仅合成的升级比较")
            finally:
                if unknown.exists():
                    self.assertEqual((unknown / "external.txt").read_text(), "未知目录中的用户文件")
                    (unknown / "external.txt").unlink()
                    unknown.rmdir()
                checkpoint.write_bytes(valid)

    def test_source_deletion_removes_the_app_archive_that_previously_restored_the_body(self) -> None:
        archive = self.backup / "database.dump"
        with _owned_database(self.target["database_url"], "deletion_before", synthetic=False) as restored:
            _run_pg("pg_restore", restored, ["--single-transaction", "--exit-on-error", str(archive)])
            with psycopg.connect(restored) as connection:
                self.assertEqual(connection.execute("SELECT count(*) FROM public.message WHERE text_content IS NOT NULL").fetchone()[0], 1)
        with patch.dict(os.environ, {"NOTALONE_MANAGED_USER_DATA": str(self.user_data)}):
            self.assertEqual(self.repository.delete_source(**self.scope).outcome, "deleted")
            self.repository.verify_deleted(**self.scope)
        self.assertFalse(archive.exists(), "App仍持有可以恢复已删除正文的完整归档")
        with _owned_database(self.target["database_url"], "deletion_after", synthetic=False) as restored:
            with self.assertRaisesRegex(MigrationError, "backup_restore_failed"):
                _run_pg("pg_restore", restored, ["--single-transaction", "--exit-on-error", str(archive)])
            with psycopg.connect(restored) as connection:
                self.assertIsNone(connection.execute("SELECT to_regclass('public.message')").fetchone()[0])
        with psycopg.connect(self.target["database_url"]) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.message").fetchone()[0], 0)

    def test_unknown_backup_directory_blocks_success_without_removing_unknown_files(self) -> None:
        unknown = self.user_data / "updates/unknown"
        unknown.mkdir(mode=0o700)
        marker = unknown / "unrelated.txt"
        marker.write_text("本例未知文件必须保留")
        with patch.dict(os.environ, {"NOTALONE_MANAGED_USER_DATA": str(self.user_data)}):
            with self.assertRaises(SourceDeletionError):
                self.repository.delete_source(**self.scope)
        self.assertEqual(marker.read_text(), "本例未知文件必须保留")
        self.assertTrue((self.backup / "database.dump").is_file())
        with psycopg.connect(self.target["database_url"]) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.message").fetchone()[0], 1)

    def test_damaged_or_unfinished_checkpoint_blocks_deletion_without_erasing_archive(self) -> None:
        checkpoint = self.backup / "checkpoint.json"
        valid = checkpoint.read_bytes()
        incomplete = json.loads(valid)
        incomplete["phase"] = "migrating"
        for content in (b"{broken", json.dumps(incomplete).encode()):
            with self.subTest(checkpoint="damaged" if content == b"{broken" else "incomplete"):
                checkpoint.write_bytes(content)
                with patch.dict(os.environ, {"NOTALONE_MANAGED_USER_DATA": str(self.user_data)}):
                    with self.assertRaises(SourceDeletionError):
                        self.repository.delete_source(**self.scope)
                self.assertTrue((self.backup / "database.dump").is_file())
                with psycopg.connect(self.target["database_url"]) as connection:
                    self.assertEqual(connection.execute("SELECT count(*) FROM public.message").fetchone()[0], 1)
        checkpoint.write_bytes(valid)
        with patch.dict(os.environ, {"NOTALONE_MANAGED_USER_DATA": str(self.user_data)}):
            self.assertEqual(self.repository.delete_source(**self.scope).outcome, "deleted")
        self.assertFalse((self.backup / "database.dump").exists())

    def _trace(self, resource: str) -> tuple[UUID, Path, str]:
        identifier = uuid4()
        with psycopg.connect(self.target["database_url"]) as connection:
            owner, contact = self.scope["owner_id"], self.scope["contact_id"]
            if resource == "memory-traces":
                connection.execute("INSERT INTO public.memory_extraction_trace (trace_id,owner_id,contact_id,run_id,batch_key,status) VALUES (%s,%s,%s,%s,'synthetic','succeeded')", (identifier, owner, contact, uuid4()))
                connection.execute("INSERT INTO public.memory_extraction_trace_event (event_id,trace_id,owner_id,contact_id,position,stage,payload) VALUES (%s,%s,%s,%s,0,'model_request','{\"synthetic_body\":\"仅在本例敏感过程内\"}')", (uuid4(), identifier, owner, contact))
                table = "memory_extraction_trace_event"
            else:
                connection.execute("INSERT INTO public.source_processing_batch (batch_id,owner_id,contact_id,source_kind) VALUES (%s,%s,%s,'manual')", (identifier, owner, contact))
                connection.execute("INSERT INTO public.source_processing_record (record_id,batch_id,owner_id,contact_id,position,outcome,payload) VALUES (%s,%s,%s,%s,0,'parsed','{\"synthetic_body\":\"仅在本例敏感过程内\"}')", (uuid4(), identifier, owner, contact))
                table = "source_processing_record"
        backup = self.user_data / "updates" / str(uuid4())
        plan = json.loads(self._command("--inspect").stdout)
        result = self._command("--update", "--backup-dir", str(backup), "--expected-target", plan["target_fingerprint"])
        self.assertEqual(result.returncode, 0, self._response_code(result))
        return identifier, backup, table

    def _delete_trace(self, resource: str) -> None:
        identifier, backup, table = self._trace(resource)
        with _owned_database(self.target["database_url"], "trace_before", synthetic=False) as restored:
            _run_pg("pg_restore", restored, ["--single-transaction", "--exit-on-error", str(backup / "database.dump")])
            with psycopg.connect(restored) as connection:
                self.assertEqual(connection.execute(sql.SQL("SELECT count(*) FROM public.{} WHERE payload IS NOT NULL").format(sql.Identifier(table))).fetchone()[0], 1)
        app = create_app(database_url=self.target["database_url"], owner_id=self.scope["owner_id"], token="synthetic")
        with patch.dict(os.environ, {"NOTALONE_MANAGED_USER_DATA": str(self.user_data)}):
            response = InProcessClient(app).request("DELETE", f"/api/contacts/{self.target['contact']}/{resource}/{identifier}", headers={"Authorization": "Bearer synthetic"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body)["availability"], "deleted")
        self.assertEqual(list((self.user_data / "updates").glob("*/database.dump")), [])
        with psycopg.connect(self.target["database_url"]) as connection:
            self.assertEqual(connection.execute(sql.SQL("SELECT count(*) FROM public.{} WHERE payload IS NOT NULL").format(sql.Identifier(table))).fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT count(*) FROM public.message").fetchone()[0], 1)

    def test_public_extraction_trace_delete_also_erases_all_restore_archives(self) -> None:
        self._delete_trace("memory-traces")

    def test_public_processing_trace_delete_also_erases_all_restore_archives(self) -> None:
        self._delete_trace("source-processing-traces")

    def test_public_trace_delete_exposes_fixed_backup_recovery_code(self) -> None:
        identifier, _, _ = self._trace("memory-traces")
        (self.user_data / "updates/unknown").mkdir(mode=0o700)
        app = create_app(database_url=self.target["database_url"], owner_id=self.scope["owner_id"], token="synthetic")
        with patch.dict(os.environ, {"NOTALONE_MANAGED_USER_DATA": str(self.user_data)}):
            response = InProcessClient(app).request("DELETE", f"/api/contacts/{self.target['contact']}/memory-traces/{identifier}", headers={"Authorization": "Bearer synthetic"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(json.loads(response.body), {"error": "update_backup_cleanup_required"})
        self.assertTrue((self.backup / "database.dump").is_file())

    def test_copied_destination_deletion_erases_app_snapshot_and_preserves_external_original(self) -> None:
        external = Path(self.directory.name) / "user-managed-original"
        self.backup.rename(external)
        destination = f"notalone_copy_{uuid4().hex}_test"
        with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(destination)))
        def cleanup() -> None:
            with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
                admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(destination)))
        self.addCleanup(cleanup)
        destination_url = f"host=/tmp dbname={destination}"
        self.environment["NOTALONE_UPDATE_DESTINATION_URL"] = destination_url
        plan = json.loads(self._command("--inspect").stdout)
        copied = self._command("--copy-update", "--backup-dir", str(self.backup), "--expected-target", plan["target_fingerprint"])
        self.assertEqual(copied.returncode, 0, self._response_code(copied))
        with patch.dict(os.environ, {"NOTALONE_MANAGED_USER_DATA": str(self.user_data)}):
            PostgresSourceDeletionRepository(destination_url).delete_source(**self.scope)
        self.assertFalse((self.backup / "database.dump").exists())
        self.assertTrue((external / "database.dump").is_file())
        with psycopg.connect(self.target["database_url"]) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.message").fetchone()[0], 1)
        with psycopg.connect(destination_url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.message").fetchone()[0], 0)
