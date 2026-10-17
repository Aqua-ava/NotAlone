"""本人概览的修正、来源删除、失败与持久恢复公共行为。"""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import UUID, uuid4

import psycopg

from notalone.application.relationship_overview_service import RelationshipOverviewService
from notalone.application.source_service import SourceService

from notalone.memory.models import FactSubject
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.memory_overview import PostgresRelationshipOverviewStore
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.tasks.models import DELETE_TASK_STEPS, BackgroundTaskStepName
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_owner_memory_overview as owner_support
from tests.integration.server import test_relationship_overview_lifecycle as lifecycle_support


class OwnerOverviewLifecycleHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    owner_overview = owner_support.OwnerMemoryOverviewHttpTest.owner_overview
    add_owner = owner_support.OwnerMemoryOverviewHttpTest.add_owner
    import_self = owner_support.OwnerMemoryOverviewHttpTest.import_self
    _install_fault = lifecycle_support.RelationshipOverviewLifecycleHttpTest._install_fault
    _remove_fault = lifecycle_support.RelationshipOverviewLifecycleHttpTest._remove_fault
    _wait_source = lifecycle_support.RelationshipOverviewLifecycleHttpTest._wait_source

    def _count_owner_projection(self):
        with psycopg.connect(self.database_url) as connection:
            return connection.execute("SELECT count(*) FROM public.relationship_overview_projection "
                "WHERE owner_id=%s AND scope_kind='owner'", (self.owner_id,)).fetchone()[0]

    def test_underlying_owner_correction_rebuilds_traceable_history_and_delete_clears_the_chain(self):
        contact, source, message = self.import_self("本人偏好热茶。")
        original = self.confirm(contact, "本人偏好热茶。", message,
                                subject=FactSubject.SELF, category="preference")
        before = self.owner_overview()
        status, corrected = self.backend.request(f"/api/memories/owner/{original['memory_id']}/correct", {
            "text": "本人偏好温茶。",
        })
        self.assertEqual(status, 200, corrected)
        current = corrected["memory"]
        after = self.owner_overview(backend=self._backend(self.owner_id))
        self.assertGreater(after["memory_revision"], before["memory_revision"])
        self.assertNotEqual(after["projection_revision"], before["projection_revision"])
        self.assertEqual([entry["memory"]["memory_id"] for entry in after["entries"]],
                         [original["memory_id"], current["memory_id"]])
        old, new = after["entries"]
        self.assertEqual(old["memory"]["status"], "invalidated")
        self.assertEqual(new["memory"]["adoption_method"], "manual")
        self.assertEqual(new["memory"]["supersedes_memory_id"], original["memory_id"])
        self.assertEqual(old["current_leaf"], new["current_leaf"])
        self.assertEqual(new["current_leaf"], {"memory_id": current["memory_id"], "revision": current["revision"]})
        self.assertFalse(old["is_latest"])
        self.assertTrue(new["is_latest"])
        self.assertEqual(new["provenance"]["kind"], "source_supported")
        self.assertEqual(new["provenance"]["references"][0]["source_id"], source)
        self.assertIsNone(new["provenance"]["references"][0]["locator"])
        status, versions = self.backend.request(f"/api/memories/owner/{current['memory_id']}/versions")
        self.assertEqual(status, 200, versions)
        self.assertEqual([entry["memory_id"] for entry in versions["versions"]],
                         [current["memory_id"], original["memory_id"]])
        status, conflict = self.backend.request(f"/api/memories/owner/{original['memory_id']}/correct", {
            "text": "本人偏好温茶。",
        })
        self.assertEqual(status, 409, conflict)
        self.assertEqual(self.owner_overview()["projection_revision"], after["projection_revision"])
        path = f"/api/memories/owner/{current['memory_id']}/delete"
        self.assertEqual(self.backend.request(path, {})[0], 200)
        self.assertEqual(self.owner_overview()["entries"], [])
        self.assertEqual(self.backend.request(path, {})[0], 200)
        self.assertEqual(self.owner_overview(backend=self._backend(self.owner_id))["entries"], [])

    def test_source_delete_in_both_orders_and_replay_preserve_independent_owner_and_other_relationship(self):
        for build_first in (False, True):
            with self.subTest(build_first=build_first):
                contact, source, message = self.import_self("本人偏好热茶。")
                memory = self.confirm(contact, "本人偏好热茶。", message,
                                      subject=FactSubject.SELF, category="preference")
                independent = self.add_owner("本人偏好纸质书。", category="preference")
                other, _, other_message = self.import_self("本人拥有合成学位。")
                other_memory = self.confirm(other, "本人拥有合成学位。", other_message, subject=FactSubject.SELF)
                if build_first:
                    self.assertIn(memory["memory_id"], str(self.owner_overview()))
                self.delete_source(contact, source)
                self.assertEqual(self._count_owner_projection(), 0)
                after = self.owner_overview(backend=self._backend(self.owner_id))
                ids = {entry["memory"]["memory_id"] for entry in after["entries"]}
                self.assertIn(independent["memory_id"], ids)
                self.assertIn(other_memory["memory_id"], ids)
                self.assertNotIn(memory["memory_id"], str(after))
                self.assertNotIn(source, str(after))
                self.delete_source(contact, source)
                self.assertEqual(self.owner_overview()["projection_revision"], after["projection_revision"])
                with psycopg.connect(self.database_url) as connection:
                    saved = connection.execute("SELECT manifest,memory_ids,source_ids FROM public.relationship_overview_projection "
                        "WHERE owner_id=%s AND scope_kind='owner'", (self.owner_id,)).fetchone()
                self.assertNotIn(memory["memory_id"], str(saved))
                self.assertNotIn(source, str(saved))

    def test_empty_owner_scope_and_authentication_do_not_read_another_owner(self):
        overview = self.owner_overview()
        self.assertEqual(overview["entries"], [])
        self.assertEqual(overview["memory_revision"], 0)
        path = "/api/memories/owner/overview"
        with urlopen(Request(self.backend.base_url + path,
                     headers={"Authorization": f"Bearer {self.backend.token}"}), timeout=5) as response:
            self.assertEqual(response.headers["Cache-Control"], "no-store")
        with self.assertRaises(HTTPError) as unauthorized:
            urlopen(Request(self.backend.base_url + path), timeout=5)
        self.assertEqual(unauthorized.exception.code, 401)
        self.assertEqual(unauthorized.exception.headers["Cache-Control"], "no-store")
        unauthorized.exception.close()
        missing = self._backend(uuid4())
        self.assertEqual(missing.request(path), (404, {"error": "overview_not_found"}))
        with self.assertRaises(HTTPError) as not_found:
            urlopen(Request(missing.base_url + path,
                            headers={"Authorization": f"Bearer {missing.token}"}), timeout=5)
        self.assertEqual(not_found.exception.headers["Cache-Control"], "no-store")
        not_found.exception.close()
        self.assertEqual(self.backend.request(path, {}, method="POST"), (404, {"error": "not_found"}))
        other_owner = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成隔离用户')", (other_owner,))
        def remove_other_owner():
            with psycopg.connect(self.database_url) as connection:
                connection.execute("DELETE FROM public.owner WHERE id=%s", (other_owner,))
        self.addCleanup(remove_other_owner)
        other_backend = self._backend(other_owner)
        status, saved = other_backend.request("/api/memories/manual-owner", {
            "text": "另一用户偏好冷茶。", "category": "preference",
        })
        self.assertEqual(status, 200, saved)
        other_before = self.owner_overview(backend=other_backend)
        self.assertEqual(self.owner_overview()["entries"], [])
        self.assertNotIn(saved["memory"]["memory_id"], str(self.owner_overview()))
        foreign_path = f"/api/memories/owner/{saved['memory']['memory_id']}"
        self.assertEqual(self.backend.request(foreign_path + "/versions")[0], 404)
        self.assertEqual(self.backend.request(foreign_path + "/correct", {"text": "合成越界修改。"})[0], 404)
        self.assertEqual(self.backend.request(foreign_path + "/delete", {})[0], 404)
        self.add_owner("本人偏好热茶。", category="preference")
        self.assertEqual(self.owner_overview(backend=other_backend), other_before)

    def test_projection_write_failure_returns_safe_error_and_recovers_from_authoritative_storage(self):
        self.add_owner("本人偏好热茶。", category="preference")
        self._install_fault("relationship_overview_projection", "INSERT OR UPDATE")
        self.assertEqual(self.backend.request("/api/memories/owner/overview"),
                         (503, {"error": "overview_unavailable"}))
        with self.assertRaises(HTTPError) as unavailable:
            urlopen(Request(self.backend.base_url + "/api/memories/owner/overview",
                            headers={"Authorization": f"Bearer {self.backend.token}"}), timeout=5)
        self.assertEqual(unavailable.exception.headers["Cache-Control"], "no-store")
        unavailable.exception.close()
        self.assertEqual(self._count_owner_projection(), 0)
        self._remove_fault("relationship_overview_projection")
        recovered = self.owner_overview(backend=self._backend(self.owner_id))
        self.assertEqual(recovered["entries"][0]["memory"]["text"], "本人偏好热茶。")

    def test_unexpected_build_failure_is_safe_no_store_and_does_not_keep_old_body(self):
        self.add_owner("本人偏好热茶。", category="preference")
        def broken_clock():
            raise RuntimeError("合成内部错误不得公开。")
        broken = self._backend(self.owner_id, overview_service=RelationshipOverviewService(
            PostgresRelationshipOverviewStore(self.database_url, clock=broken_clock)))
        self.assertEqual(broken.request("/api/memories/owner/overview"),
                         (500, {"error": "overview_operation_failed"}))
        with self.assertRaises(HTTPError) as failure:
            urlopen(Request(broken.base_url + "/api/memories/owner/overview",
                            headers={"Authorization": f"Bearer {broken.token}"}), timeout=5)
        self.assertEqual(failure.exception.headers["Cache-Control"], "no-store")
        failure.exception.close()
        self.assertEqual(self._count_owner_projection(), 0)

    def test_queued_delete_failed_cleanup_and_same_task_retry_never_restore_owner_projection(self):
        contact, source, message = self.import_self("本人偏好热茶。")
        memory = self.confirm(contact, "本人偏好热茶。", message, subject=FactSubject.SELF, category="preference")
        self.owner_overview()
        path = f"/api/contacts/{contact}/sources/{source}"
        with patch.object(SourceService, "_start", return_value=None):
            status, queued = self.backend.request(path, method="DELETE")
        self.assertEqual((status, queued["status"]), (202, "queued"))
        self.assertEqual(self._count_owner_projection(), 0)
        self.assertEqual(self.owner_overview(backend=self._backend(self.owner_id))["entries"], [])
        self._install_fault("message_source_ref", "DELETE")
        failed_backend = self._backend(self.owner_id)
        self.assertEqual(failed_backend.request(path, method="DELETE")[0], 202)
        failed = self._wait_source(failed_backend, contact, source, "failed")
        self.assertEqual(failed["task_id"], queued["task_id"])
        self.assertEqual(failed["status"], "delete_failed")
        self.assertEqual(failed["error_code"], "source_delete_failed")
        self.assertEqual(self.owner_overview(backend=self._backend(self.owner_id))["entries"], [])
        self._remove_fault("message_source_ref")
        recovered = self._backend(self.owner_id)
        status, resumed = recovered.request(path, method="DELETE")
        self.assertEqual(status, 202, resumed)
        self.assertEqual(resumed["task_id"], queued["task_id"])
        self._wait_source(recovered, contact, source, "succeeded")
        self.assertEqual(recovered.request(path, method="DELETE")[1]["task_id"], queued["task_id"])
        self.assertNotIn(memory["memory_id"], str(self.owner_overview(backend=recovered)))

    def test_deleted_body_does_not_reappear_after_interrupted_receipt_and_persistent_lease_recovery(self):
        contact, source, message = self.import_self("本人偏好热茶。")
        memory = self.confirm(contact, "本人偏好热茶。", message, subject=FactSubject.SELF, category="preference")
        self.owner_overview()
        path = f"/api/contacts/{contact}/sources/{source}"
        with patch.object(SourceService, "_start", return_value=None):
            status, queued = self.backend.request(path, method="DELETE")
        self.assertEqual(status, 202, queued)
        repository = PostgresBackgroundTaskRepository(self.database_url)
        claim_args = dict(owner_id=self.owner_id, contact_id=UUID(contact), worker_id=uuid4(),
            lease_duration=timedelta(seconds=30), supported_steps=tuple(name for _, name in DELETE_TASK_STEPS))
        mark = repository.claim_next_step(**claim_args)
        repository.complete_step(mark, processed_count=0)
        interrupted = repository.claim_next_step(**claim_args)
        self.assertEqual(interrupted.name, BackgroundTaskStepName.DELETE_DERIVED)
        PostgresSourceDeletionRepository(self.database_url).delete_source(
            owner_id=self.owner_id, contact_id=UUID(contact), source_document_id=UUID(source))
        self.assertEqual(self._count_owner_projection(), 0)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.background_task_step SET lease_expires_at=now()-interval '1 second' WHERE id=%s",
                               (interrupted.step_id,))
        recovered = self._backend(self.owner_id)
        self.assertEqual(self.owner_overview(backend=recovered)["entries"], [])
        self.assertEqual(recovered.request(path, method="DELETE")[1]["task_id"], queued["task_id"])
        self._wait_source(recovered, contact, source, "succeeded")
        self.assertEqual(repository.get_task(owner_id=self.owner_id, contact_id=UUID(contact),
            task_id=UUID(queued["task_id"])).steps[1].attempt_count, 2)
        self.assertNotIn(memory["memory_id"], str(self.owner_overview(backend=self._backend(self.owner_id))))

    def test_build_that_commits_before_waiting_delete_is_invalidated_and_cannot_restore_the_body(self):
        contact, source, message = self.import_self("本人偏好热茶。")
        memory = self.confirm(contact, "本人偏好热茶。", message, subject=FactSubject.SELF, category="preference")
        entered, release = threading.Event(), threading.Event()
        def controlled_clock():
            entered.set()
            if not release.wait(8):
                raise TimeoutError("合成构建时钟未解除暂停。")
            return datetime(2026, 10, 14, tzinfo=timezone.utc)
        delayed = self._backend(self.owner_id, overview_service=RelationshipOverviewService(
            PostgresRelationshipOverviewStore(self.database_url, clock=controlled_clock)))
        with ThreadPoolExecutor(max_workers=2) as executor:
            building = executor.submit(delayed.request, "/api/memories/owner/overview")
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
                                "WHERE activity.datname=current_database() AND lock.locktype='advisory' AND NOT lock.granted)").fetchone()[0]
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
        self.assertEqual(self._count_owner_projection(), 0)
        self.assertEqual(self.owner_overview(backend=self._backend(self.owner_id))["entries"], [])
        self.delete_source(contact, source)
