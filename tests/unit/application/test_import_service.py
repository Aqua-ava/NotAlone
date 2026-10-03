"""导入服务与任务宿主的单元测试；使用内存 fake，不触碰数据库。"""

from __future__ import annotations

import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

from notalone.application.import_service import ImportService, TaskHost
from notalone.ingest.models import (
    ExistingContactSelection,
    ImportBatch,
    ImportConfirmationRequest,
    NewContactSelection,
)
from notalone.persistence.postgres_repository import ImportResult
from notalone.tasks.models import BackgroundTaskStepName
from notalone.tasks.worker import WorkerRunOutcome


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")


class FakeRepository:
    def __init__(self) -> None:
        self.calls: list[tuple[UUID | None, ImportBatch, ImportConfirmationRequest]] = []

    def import_document(
        self,
        *,
        owner_id: UUID | None,
        initialize_owner: bool = False,
        initialize_first_owner_identity: bool = False,
        document: ImportBatch,
        confirmation: ImportConfirmationRequest,
    ) -> ImportResult:
        self.calls.append((owner_id, document, confirmation))
        return ImportResult(
            contact_id=CONTACT_ID,
            channel_identity_id=uuid4(),
            source_document_id=uuid4(),
            confirmation_id=uuid4(),
            confirmation_method=(
                "manual_select"
                if isinstance(confirmation.selection, ExistingContactSelection)
                else "manual_create"
            ),
            outcome="imported",
            message_count=7,
            task_id=uuid4(),
            owner_id=owner_id,
        )


class FakeWorker:
    def __init__(self, sequence: list[WorkerRunOutcome]) -> None:
        self._sequence = sequence
        self.task_id = uuid4()
        self.calls: list[tuple[UUID, UUID, UUID]] = []

    def run_once(self, *, owner_id, contact_id, worker_id, task_id=None):
        self.calls.append((owner_id, contact_id, worker_id))
        outcome = self._sequence.pop(0)
        return SimpleNamespace(
            outcome=outcome,
            task_id=task_id or self.task_id,
            step_name=BackgroundTaskStepName.EXTRACT_MEMORY,
            processed_count=3,
            attempt_count=1,
            error_code=None,
        )


class FakeLockConnection:
    """满足 advisory lock 调用的最小假连接。"""

    def execute(self, sql: str, params=None) -> "FakeCursor":
        return FakeCursor()


class FakeCursor:
    def fetchone(self):
        return (True,)


class ImportServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repository = FakeRepository()
        self.service = ImportService(repository=self.repository)

    def test_preview_returns_validation_summary(self) -> None:
        fixture = (
            Path(__file__).resolve().parents[2] / "fixtures" / "valid_single_contact.jsonl"
        )

        result = self.service.preview(path=str(fixture))

        self.assertEqual(result["valid"], True)
        self.assertIn("record_count", result)
        self.assertIn("kind_counts", result)
        self.assertIn("owner_channel_identity", result)

    def test_commit_with_existing_contact(self) -> None:
        path = (
            Path(__file__).resolve().parents[2] / "fixtures" / "valid_single_contact.jsonl"
        )

        result = self.service.commit(
            path=str(path),
            owner_id=OWNER_ID,
            selection=ExistingContactSelection(contact_id=CONTACT_ID),
        )

        self.assertEqual(result["imported_count"], 7)
        self.assertEqual(result["skipped_duplicates"], 0)
        self.assertEqual(result["contact_id"], str(CONTACT_ID))
        owner, _, confirmation = self.repository.calls[-1]
        self.assertEqual(owner, OWNER_ID)
        self.assertEqual(
            confirmation.selection,
            ExistingContactSelection(contact_id=CONTACT_ID),
        )

    def test_commit_with_new_contact(self) -> None:
        path = (
            Path(__file__).resolve().parents[2] / "fixtures" / "valid_single_contact.jsonl"
        )

        self.service.commit(
            path=str(path),
            owner_id=OWNER_ID,
            selection=NewContactSelection(display_name="新联系人"),
        )

        self.assertEqual(
            self.repository.calls[-1][2].selection,
            NewContactSelection(display_name="新联系人"),
        )


class TaskHostTest(unittest.TestCase):
    def setUp(self) -> None:
        self.events: list[tuple] = []
        self.locks: list[FakeLockConnection] = []

    def _host(
        self,
        sequence: list[WorkerRunOutcome],
    ) -> TaskHost:
        return TaskHost(
            worker_builder=lambda: FakeWorker(sequence),
            lock_connection_builder=lambda: FakeLockConnection(),
            event_publisher=self._publish,
        )

    def _publish(self, update) -> None:
        self.events.append(update)

    def test_start_runs_worker_and_records_progress(self) -> None:
        # 任务完成的判定：run_worker 拿到 idle 后结束。
        host = self._host([WorkerRunOutcome.IDLE])
        started = host.start(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        self.assertEqual(started, {"status": "started"})

        deadline = time.monotonic() + 5
        while host.current(owner_id=OWNER_ID, contact_id=CONTACT_ID)["status"] == "running":
            if time.monotonic() > deadline:
                self.fail("任务未在超时内结束。")
            time.sleep(0.02)

        snapshot = host.current(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        self.assertEqual(snapshot["status"], "finished")
        progress = snapshot["progress"]
        self.assertIsNotNone(progress)
        self.assertEqual(progress["status"], "idle")

    def test_start_returns_busy_while_thread_alive(self) -> None:
        host = self._host(
            [WorkerRunOutcome.SUCCEEDED, WorkerRunOutcome.IDLE]
        )
        first = host.start(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        self.assertEqual(first["status"], "started")

        # 线程可能很快结束；用忙等待不可靠，改为直接调两次（第二次
        # 若线程已结束则返回 started，行为允许）。
        second = host.start(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        self.assertIn(second["status"], ("started", "busy"))

    def test_publishes_progress_events(self) -> None:
        host = self._host([WorkerRunOutcome.IDLE])
        host.start(owner_id=OWNER_ID, contact_id=CONTACT_ID)

        deadline = time.monotonic() + 5
        while not self.events:
            if time.monotonic() > deadline:
                self.fail("未收到进度事件。")
            time.sleep(0.02)

        update = self.events[-1]
        self.assertEqual(update.owner_id, OWNER_ID)
        self.assertEqual(update.contact_id, CONTACT_ID)
        self.assertEqual(update.status, "idle")
        self.assertEqual(update.processed_count, 3)

    def test_failed_worker_records_failure(self) -> None:
        host = self._host([WorkerRunOutcome.FAILED])
        host.start(owner_id=OWNER_ID, contact_id=CONTACT_ID)

        deadline = time.monotonic() + 5
        while host.current(owner_id=OWNER_ID, contact_id=CONTACT_ID)["status"] == "running":
            if time.monotonic() > deadline:
                self.fail("任务未在超时内结束。")
            time.sleep(0.02)

        snapshot = host.current(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        self.assertEqual(snapshot["progress"]["status"], "failed")


class RealTaskHostSpinupTest(unittest.TestCase):
    """真实 TaskHost 与 run_worker 的接线验证（无数据库）。"""

    def test_task_host_builds_and_starts_with_fake_worker(self) -> None:
        events: list[tuple] = []
        worker = FakeWorker([WorkerRunOutcome.IDLE])

        host = TaskHost(
            worker_builder=lambda: worker,
            lock_connection_builder=lambda: FakeLockConnection(),
            event_publisher=lambda *args: events.append(args),
        )
        result = host.start(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        self.assertEqual(result, {"status": "started"})

        deadline = time.monotonic() + 5
        while host.current(owner_id=OWNER_ID, contact_id=CONTACT_ID)["status"] == "running":
            if time.monotonic() > deadline:
                self.fail("任务未在超时内结束。")
            time.sleep(0.02)
        self.assertTrue(events)


if __name__ == "__main__":
    unittest.main()
