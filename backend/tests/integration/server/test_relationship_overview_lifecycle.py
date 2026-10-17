"""概览与真实事务、删除 Worker、恢复及范围隔离的公共行为。"""

from concurrent.futures import ThreadPoolExecutor
import copy
import json
from datetime import datetime, timedelta, timezone
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb

from notalone.application.relationship_overview_service import RelationshipOverviewService
from notalone.application.source_service import SourceService
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.memory_overview import PostgresRelationshipOverviewStore
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.memory.overview import OverviewUnavailable
from notalone.scopes import ContactScope
from notalone.tasks.models import DELETE_TASK_STEPS, BackgroundTaskStepName
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


class RelationshipOverviewLifecycleHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def _count_projection(self, contact: str) -> int:
        with psycopg.connect(self.database_url) as connection:
            return connection.execute("SELECT count(*) FROM public.relationship_overview_projection "
                "WHERE owner_id=%s AND contact_id=%s", (self.owner_id, contact)).fetchone()[0]

    def _remove_fault(self, table: str) -> None:
        with psycopg.connect(self.database_url) as connection:
            connection.execute(f"DROP TRIGGER IF EXISTS synthetic_overview_failure ON public.{table}")
            connection.execute("DROP FUNCTION IF EXISTS public.synthetic_overview_failure()")

    def _install_fault(self, table: str, operation: str) -> None:
        self.assertIn(table, {"relationship_overview_projection", "message_source_ref"})
        self.assertIn(operation, {"INSERT OR UPDATE", "DELETE"})
        with psycopg.connect(self.database_url) as connection:
            connection.execute("CREATE FUNCTION public.synthetic_overview_failure() RETURNS trigger "
                "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic private failure'; END $$")
            connection.execute(f"CREATE TRIGGER synthetic_overview_failure BEFORE {operation} "
                f"ON public.{table} FOR EACH ROW EXECUTE FUNCTION public.synthetic_overview_failure()")
        self.addCleanup(self._remove_fault, table)

    def _wait_source(self, backend, contact: str, source: str, status: str) -> dict:
        deadline = time.monotonic() + 8
        while True:
            row = next(item for item in self._get(backend, f"/api/contacts/{contact}/sources")["sources"]
                       if item["source_id"] == source)
            if row["task_status"] == status:
                return row
            self.assertLess(time.monotonic(), deadline, row)
            time.sleep(0.01)

    def test_empty_snapshot_scope_authentication_and_errors_do_not_return_private_body(self):
        contact, _, _ = self.import_contact("合成空概览，没有采纳为资料。")
        overview = self.overview(contact)
        self.assertEqual(overview["entries"], [])
        self.assertEqual(overview["memory_revision"], 0)
        self.assertRegex(overview["projection_revision"], r"^[0-9a-f]{64}$")
        self.assertIsNotNone(datetime.fromisoformat(overview["built_at"]).utcoffset())
        path = f"/api/contacts/{contact}/relationship-overview"
        with urlopen(Request(self.backend.base_url + path,
                             headers={"Authorization": f"Bearer {self.backend.token}"}), timeout=5) as response:
            self.assertEqual(response.headers["Cache-Control"], "no-store")
        with self.assertRaises(HTTPError) as unauthorized:
            urlopen(Request(self.backend.base_url + path), timeout=5)
        self.assertEqual(unauthorized.exception.code, 401)
        unauthorized.exception.close()
        self.assertEqual(self._backend(uuid4()).request(path), (404, {"error": "overview_not_found"}))
        self.assertEqual(self.backend.request(f"/api/contacts/{uuid4()}/relationship-overview"),
                         (404, {"error": "overview_not_found"}))
        self.assertEqual(self.backend.request("/api/contacts/invalid/relationship-overview"),
                         (400, {"error": "overview_request_invalid"}))
        self.assertEqual(self.backend.request(path, {}, method="POST"), (404, {"error": "not_found"}))

    def test_noop_and_rolled_back_source_mutation_preserve_the_authoritative_snapshot(self):
        contact, source, message = self.import_contact("合成经历：双方已初次相识。")
        self.confirm(contact, "双方已初次相识。", message)
        before = self.overview(contact)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.message SET text_content=text_content "
                "WHERE owner_id=%s AND id=%s", (self.owner_id, message))
        self.assertEqual(self._count_projection(contact), 1)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET file_name='synthetic-rolled-back.jsonl' "
                "WHERE owner_id=%s AND id=%s", (self.owner_id, source))
            self.assertEqual(connection.execute("SELECT count(*) FROM public.relationship_overview_projection "
                "WHERE owner_id=%s AND contact_id=%s", (self.owner_id, contact)).fetchone()[0], 0)
            connection.rollback()
        restored = self.overview(contact, backend=self._backend(self.owner_id))
        self.assertEqual(restored, before)

    def test_all_failure_responses_are_no_store_without_recoverable_body(self):
        contact, _, message = self.import_contact("合成不能进入错误响应的私人正文。")
        self.confirm(contact, "合成不能进入错误响应的私人正文。", message)
        path = f"/api/contacts/{contact}/relationship-overview"

        class FailingStore:
            def __init__(self, failure):
                self.failure = failure

            def read_contact(self, scope):
                raise self.failure

        for failure, expected, code in (
            (OverviewUnavailable("合成私密错误详情"), 503, "overview_unavailable"),
            (RuntimeError("合成私密错误详情"), 500, "overview_operation_failed"),
            (LookupError("合成私密错误详情"), 404, "overview_not_found"),
        ):
            backend = self._backend(self.owner_id, overview_service=RelationshipOverviewService(FailingStore(failure)))
            with self.assertRaises(HTTPError) as captured:
                urlopen(Request(backend.base_url + path, headers={"Authorization": f"Bearer {backend.token}"}), timeout=5)
            with captured.exception as response:
                self.assertEqual(response.code, expected)
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertEqual(json.loads(response.read()), {"error": code})
        with self.assertRaises(HTTPError) as captured:
            urlopen(Request(self.backend.base_url + path), timeout=5)
        with captured.exception as response:
            self.assertEqual(response.code, 401)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertNotIn("私人正文", response.read().decode())

    def test_failed_projection_write_returns_safe_error_then_rebuilds_after_restart(self):
        contact, _, message = self.import_contact("合成经历：对方已取得合成学位。")
        original = self.confirm(contact, "对方已取得合成学位。", message)
        before = self.overview(contact)
        status, corrected = self.backend.request(f"/api/contacts/{contact}/memories/{original['memory_id']}/correct", {
            "text": "对方已获得合成课程结业资格。",
        })
        self.assertEqual(status, 200, corrected)
        self._install_fault("relationship_overview_projection", "INSERT OR UPDATE")
        self.assertEqual(self.backend.request(f"/api/contacts/{contact}/relationship-overview"),
                         (503, {"error": "overview_unavailable"}))
        self.assertEqual(self._count_projection(contact), 0)
        self._remove_fault("relationship_overview_projection")
        rebuilt = self.overview(contact, backend=self._backend(self.owner_id))
        self.assertNotEqual(rebuilt["projection_revision"], before["projection_revision"])
        self.assertEqual(rebuilt["entries"][-1]["current_leaf"]["memory_id"], corrected["memory"]["memory_id"])
        self.assertEqual(self.overview(contact), rebuilt)

    def test_queued_delete_failed_cleanup_and_explicit_retry_never_restore_old_projection(self):
        contact, source, message = self.import_contact("合成待删经历：双方参加过课程。")
        memory = self.confirm(contact, "双方参加过课程。", message)
        self.overview(contact)
        path = f"/api/contacts/{contact}/sources/{source}"
        # 暂停异步调度，只让真实公开请求先提交 delete_requested。
        with patch.object(SourceService, "_start", return_value=None):
            status, queued = self.backend.request(path, method="DELETE")
        self.assertEqual((status, queued["status"]), (202, "queued"))
        self.assertEqual(self._count_projection(contact), 0)
        self.assertEqual(self.overview(contact, backend=self._backend(self.owner_id))["entries"], [])
        self._install_fault("message_source_ref", "DELETE")
        failed_backend = self._backend(self.owner_id)
        self.assertEqual(failed_backend.request(path, method="DELETE")[0], 202)
        failed = self._wait_source(failed_backend, contact, source, "failed")
        self.assertEqual(failed["task_id"], queued["task_id"])
        self.assertEqual(failed["status"], "delete_failed")
        self.assertEqual(failed["error_code"], "source_delete_failed")
        hidden = self.overview(contact, backend=self._backend(self.owner_id))
        self.assertEqual(hidden["entries"], [])
        with psycopg.connect(self.database_url) as connection:
            metadata = connection.execute("SELECT manifest,memory_ids,source_ids "
                "FROM public.relationship_overview_projection WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, contact)).fetchone()
        self.assertNotIn(memory["memory_id"], str(metadata))
        self.assertNotIn(source, str(metadata))
        self._remove_fault("message_source_ref")
        recovered_backend = self._backend(self.owner_id)
        status, resumed = recovered_backend.request(path, method="DELETE")
        self.assertEqual(status, 202, resumed)
        self.assertEqual(resumed["task_id"], queued["task_id"])
        self._wait_source(recovered_backend, contact, source, "succeeded")
        self.assertEqual(self.overview(contact, backend=self._backend(self.owner_id))["entries"], [])
        self.assertEqual(recovered_backend.request(path, method="DELETE")[1]["task_id"], queued["task_id"])

    def test_restart_after_delete_commit_before_worker_receipt_cannot_recover_old_contents(self):
        contact, source, message = self.import_contact("合成待删经历：双方曾见面。")
        memory = self.confirm(contact, "双方曾见面。", message)
        self.overview(contact)
        path = f"/api/contacts/{contact}/sources/{source}"
        with patch.object(SourceService, "_start", return_value=None):
            status, queued = self.backend.request(path, method="DELETE")
        self.assertEqual(status, 202, queued)
        repository = PostgresBackgroundTaskRepository(self.database_url)
        claim_args = dict(owner_id=self.owner_id, contact_id=UUID(contact), worker_id=uuid4(),
                          lease_duration=timedelta(seconds=30),
                          supported_steps=tuple(name for _, name in DELETE_TASK_STEPS))
        mark = repository.claim_next_step(**claim_args)
        repository.complete_step(mark, processed_count=0)
        interrupted = repository.claim_next_step(**claim_args)
        self.assertEqual(interrupted.name, BackgroundTaskStepName.DELETE_DERIVED)
        PostgresSourceDeletionRepository(self.database_url).delete_source(
            owner_id=self.owner_id, contact_id=UUID(contact), source_document_id=UUID(source))
        self.assertEqual(self._count_projection(contact), 0)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.background_task_step SET lease_expires_at=now()-interval '1 second' "
                               "WHERE id=%s", (interrupted.step_id,))
        recovered = self._backend(self.owner_id)
        self.assertEqual(self.overview(contact, backend=recovered)["entries"], [])
        self.assertEqual(recovered.request(path, method="DELETE")[1]["task_id"], queued["task_id"])
        self._wait_source(recovered, contact, source, "succeeded")
        self.assertEqual(repository.get_task(owner_id=self.owner_id, contact_id=UUID(contact),
            task_id=UUID(queued["task_id"])).steps[1].attempt_count, 2)
        self.assertNotIn(memory["memory_id"], str(self.overview(contact)))

    def test_a_build_already_in_progress_is_invalidated_when_delete_commits(self):
        contact, source, message = self.import_contact("合成并发经历：双方已首次见面。")
        memory = self.confirm(contact, "双方已首次见面。", message)
        entered, release = threading.Event(), threading.Event()

        def controlled_clock() -> datetime:
            entered.set()
            if not release.wait(8):
                raise TimeoutError("合成构建时钟未解除暂停。")
            return datetime(2026, 10, 14, tzinfo=timezone.utc)

        delayed = self._backend(self.owner_id, overview_service=RelationshipOverviewService(
            PostgresRelationshipOverviewStore(self.database_url, clock=controlled_clock)))
        with ThreadPoolExecutor(max_workers=2) as executor:
            building = executor.submit(delayed.request, f"/api/contacts/{contact}/relationship-overview")
            try:
                self.assertTrue(entered.wait(5))
                with patch.object(SourceService, "_start", return_value=None):
                    deleting = executor.submit(self.backend.request,
                        f"/api/contacts/{contact}/sources/{source}", method="DELETE")
                    deadline = time.monotonic() + 5
                    while True:
                        with psycopg.connect(self.database_url) as connection:
                            waiting = connection.execute("SELECT EXISTS(SELECT 1 FROM pg_locks AS lock "
                                "JOIN pg_stat_activity AS activity ON activity.pid=lock.pid "
                                "WHERE activity.datname=current_database() AND lock.locktype='advisory' "
                                "AND NOT lock.granted)").fetchone()[0]
                        if waiting:
                            break
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(0.01)
                    release.set()
                    built_status, captured = building.result(timeout=5)
                    delete_status, queued = deleting.result(timeout=5)
            finally:
                release.set()
            self.assertEqual(built_status, 200, captured)
            self.assertEqual(captured["overview"]["entries"][0]["memory"]["memory_id"], memory["memory_id"])
            self.assertEqual((delete_status, queued["status"]), (202, "queued"))
        self.assertEqual(self._count_projection(contact), 0)
        self.assertEqual(self.overview(contact, backend=self._backend(self.owner_id))["entries"], [])
        self.delete_source(contact, source)

    def test_missing_legacy_generation_remains_unknown_and_manifest_has_no_body(self):
        text = "合成未知旧证明：双方已首次见面。"
        contact, source, message = self.import_contact(text)
        memory = self.confirm(contact, "双方已首次见面。", message)
        candidate_id = self.overview(contact)["entries"][0]["memory"]["source_candidate_id"]
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.memory_candidate SET correction_evidence=NULL WHERE owner_id=%s AND id=%s",
                               (self.owner_id, candidate_id))
        unknown = self.overview(contact)
        self.assertEqual(unknown["entries"][0]["provenance"]["kind"], "unknown")
        self.assertEqual(unknown["entries"][0]["provenance"]["references"][0]["source_id"], source)
        with psycopg.connect(self.database_url) as connection:
            row = connection.execute("SELECT manifest FROM public.relationship_overview_projection "
                "WHERE owner_id=%s AND contact_id=%s", (self.owner_id, contact)).fetchone()[0]
            frozen = connection.execute("SELECT correction_evidence FROM public.memory_candidate "
                "WHERE owner_id=%s AND id=%s", (self.owner_id, candidate_id)).fetchone()[0]
        self.assertIsNone(frozen)
        self.assertFalse(row["memories"][0]["original_known"])
        self.assertNotIn(text, str(row))
        self.assertNotIn(memory["text"], str(row))
        self.assertNotIn("raw_payload", str(row))

    def test_projection_metadata_rejects_body_copies_at_every_saved_level(self):
        contact, _, message = self.import_contact("合成正文约束：双方已初次相识。")
        self.confirm(contact, "双方已初次相识。", message)
        self.overview(contact)
        with psycopg.connect(self.database_url) as connection:
            manifest = connection.execute("SELECT manifest FROM public.relationship_overview_projection "
                "WHERE owner_id=%s AND contact_id=%s", (self.owner_id, contact)).fetchone()[0]
        for level in ("projection", "memory", "reference"):
            with self.subTest(level=level):
                contaminated = copy.deepcopy(manifest)
                target = (contaminated if level == "projection" else contaminated["memories"][0]
                          if level == "memory" else contaminated["memories"][0]["source_refs"][0])
                target["body"] = "合成禁止缓存的正文。"
                with self.assertRaises(psycopg.errors.CheckViolation), psycopg.connect(self.database_url) as connection:
                    connection.execute("UPDATE public.relationship_overview_projection SET manifest=%s "
                        "WHERE owner_id=%s AND contact_id=%s", (Jsonb(contaminated), self.owner_id, contact))
        self.assertEqual(self._count_projection(contact), 1)

    def test_expired_and_future_records_remain_visible_and_a_leaf_is_not_invented(self):
        text = "从2026-08-04T00:00:00+00:00至2026-08-06T00:00:00+00:00一起参加课程。"
        start = datetime(2026, 8, 4, tzinfo=timezone.utc)
        contact, _, message = self.import_contact(text, when=start)
        memory = self.confirm(contact, text, message, category="recent_state",
                              valid_at=start, invalid_at=start + timedelta(days=2))
        future_text = "从2026-08-09T00:00:00+00:00至2026-08-10T00:00:00+00:00准备参加课程。"
        _, _, future_message = self.import_contact(future_text, when=start + timedelta(minutes=5), contact_id=contact)
        future = self.confirm(contact, future_text, future_message, category="recent_state",
                              valid_at=start + timedelta(days=5), invalid_at=start + timedelta(days=6))
        with patch("notalone.memory.current_status._utc_now", return_value=start + timedelta(days=1)):
            before = self.overview(contact)
        self.assertEqual([entry["memory"]["timing"]["current_status"] for entry in before["entries"]],
                         ["current_verified", "current_unverified"])
        with patch("notalone.memory.current_status._utc_now", return_value=start + timedelta(days=3)):
            after = self.overview(contact)
            self.assertEqual([entry["memory"]["timing"]["current_status"] for entry in after["entries"]],
                             ["historical", "current_unverified"])
            self.assertEqual(after["memory_revision"], before["memory_revision"])
            self.assertNotEqual(after["projection_revision"], before["projection_revision"])
            self.assertTrue(all(entry["memory"]["event"] is None for entry in after["entries"]))
            # 沿实际 MemoryPort 失效一个仍有合法来源的版本，不新造历史或替代叶。
            PostgresMemoryStore(self.database_url).invalidate(
                scope=ContactScope(self.owner_id, UUID(contact)), memory_id=UUID(memory["memory_id"]))
            historical = self.overview(contact)["entries"][0]
            self.assertEqual(historical["memory"]["status"], "invalidated")
            self.assertIsNone(historical["current_leaf"])
            self.assertFalse(historical["is_latest"])
            status, deleted = self.backend.request(f"/api/contacts/{contact}/memories/{memory['memory_id']}/delete", {})
            self.assertEqual(status, 200, deleted)
            self.assertEqual([entry["memory"]["memory_id"] for entry in self.overview(contact)["entries"]],
                             [future["memory_id"]])

    def test_contact_fk_removal_clears_metadata_and_directory_without_touching_another_contact(self):
        contact, source, message = self.import_contact("合成待移除联系人：双方已初次相识。")
        memory = self.confirm(contact, "双方已初次相识。", message)
        self.overview(contact)
        other, _, other_message = self.import_contact("另一合成联系人：对方已毕业。")
        self.confirm(other, "对方已毕业。", other_message)
        before_other = self.overview(other)
        # 当前没有联系人 DELETE 产品入口；工程验证真实 FK 删除与只读目录撤下。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("DELETE FROM public.contact WHERE owner_id=%s AND id=%s", (self.owner_id, contact))
        self.assertEqual(self._count_projection(contact), 0)
        self.assertEqual(self.backend.request(f"/api/contacts/{contact}/relationship-overview"),
                         (404, {"error": "overview_not_found"}))
        contacts = self._get(self.backend, "/api/contacts")["contacts"]
        self.assertNotIn(contact, {item["contact_id"] for item in contacts})
        self.assertEqual(self.overview(other), before_other)
        with psycopg.connect(self.database_url) as connection:
            manifests = connection.execute("SELECT manifest,source_ids,memory_ids FROM public.relationship_overview_projection "
                                           "WHERE owner_id=%s", (self.owner_id,)).fetchall()
        self.assertNotIn(memory["memory_id"], str(manifests))
        self.assertNotIn(source, str(manifests))

    def test_period_update_and_old_new_source_scope_both_invalidate_inside_transaction(self):
        contact, _, message = self.import_contact("合成时段：双方已相识。")
        memory = self.confirm(contact, "双方已相识。", message)
        self.overview(contact)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.confirmed_memory SET valid_at='2026-01-01T00:00:00Z' "
                "WHERE owner_id=%s AND id=%s", (self.owner_id, memory["memory_id"]))
            self.assertEqual(connection.execute("SELECT count(*) FROM public.relationship_overview_projection "
                "WHERE owner_id=%s AND contact_id=%s", (self.owner_id, contact)).fetchone()[0], 0)
        self.overview(contact)
        other, _, _ = self.import_contact("合成另一联系人：仅验证范围。")
        status, saved = self.backend.request("/api/memories/manual-contact", {
            "contact_id": other, "text": "合成独立手录资料。", "category": "common_fact",
        })
        self.assertEqual(status, 200, saved)
        other_before = self.overview(other)
        # 只作为触发器工程夹具迁移无消息的手录来源范围，产品没有此操作入口。
        with psycopg.connect(self.database_url) as connection:
            manual_source = connection.execute("SELECT id FROM public.source_document "
                "WHERE owner_id=%s AND contact_id=%s AND source_type='manual'",
                (self.owner_id, other)).fetchone()[0]
            connection.execute("UPDATE public.source_document SET contact_id=%s WHERE owner_id=%s AND id=%s",
                (contact, self.owner_id, manual_source))
            self.assertEqual(connection.execute("SELECT count(*) FROM public.relationship_overview_projection "
                "WHERE owner_id=%s AND contact_id=ANY(%s::uuid[])", (self.owner_id, [contact, other])).fetchone()[0], 0)
            connection.rollback()
        self.assertEqual(self.overview(other), other_before)


if __name__ == "__main__":
    unittest.main()
