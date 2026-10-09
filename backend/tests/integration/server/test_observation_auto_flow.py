"""真实观察存储、发布端口及 HTTP 状态验证自动记忆任务。"""

from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
import threading
import time
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg

from notalone.application.import_service import TaskHost
from notalone.application.model_priority import (
    ModelPriorityControl, PriorityExtractionRuntime, PriorityVerificationRuntime,
)
from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.ingest.models import NormalizedMessage, WechatMessageMetadata
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.contact_memory_index import PostgresContactMemoryIndexRepository
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.locks import (
    lock_contact_scope, try_acquire_global_worker_lock, release_global_worker_lock,
)
from notalone.persistence.observation_store import ObservationMode, PostgresObservationStore
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from notalone.server.event_bus import EventBus
from notalone.server.event_publisher import EventBusMessagePublisher
from notalone.tasks.worker import BackgroundTaskWorker, PostgresMemoryExtractionRunner
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, HttpBackend
from tests.unit.memory_extraction.verification_helpers import SyntheticSupportingVerifier


class ObservationModel:
    """只返回目标消息中已知合成事实；可控制外部调用完成时机。"""

    def __init__(self):
        self.calls = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.unavailable = False
        self.fail_through = 0
        self.failure_calls = set()
        self.call_gates = {}

    def extract(self, window):
        self.calls.append(window.target_message_id_set)
        call_number = len(self.calls)
        self.entered.set()
        if not self.release.wait(5):
            raise TimeoutError("合成模型未释放。")
        if call_number in self.call_gates and not self.call_gates[call_number].wait(5):
            raise TimeoutError("合成轮次未释放。")
        if self.unavailable or call_number <= self.fail_through or call_number in self.failure_calls:
            raise ExtractionRuntimeError("合成外部服务暂不可用")
        return tuple({
            "text": "联系人喜欢科幻小说", "category": "preference",
            "subject": "contact", "topic": "other",
            "source_message_ids": [str(message.message_id)],
            "confidence": 0.9, "risk_flags": [], "valid_at": None,
            "invalid_at": None, "speech_act": "assertion",
            "assertion_status": "asserted", "figurative_type": "literal",
            "alternatives": [], "interpretation_reason": "合成资料的明确偏好。",
        } for message in window.messages
            if message.message_id in window.target_message_id_set)


class ObservationAutoFlowTest(CoreBusinessFlowFixture, unittest.TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner(id, display_name) VALUES (%s, '合成用户')",
                               (self.scope.owner_id,))
            connection.execute("INSERT INTO public.contact(owner_id, id, display_name) VALUES (%s, %s, '合成联系人')",
                               (self.scope.owner_id, self.scope.contact_id))
        self.bindings = PostgresConversationBindingRepository(self.database_url)
        self.binding = self.bindings.create_binding(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            channel="wechat", account_scope="synthetic-account",
            conversation_locator=f"synthetic-{self.scope.contact_id}",
        )
        self.store = PostgresObservationStore(self.database_url)
        self.repository = PostgresBackgroundTaskRepository(self.database_url)
        self.model = ObservationModel()
        self.events = EventBus()
        self.model_available = True
        self.priority = ModelPriorityControl()
        self.host = TaskHost(
            worker_builder=self.build_worker,
            lock_connection_builder=lambda: psycopg.connect(self.database_url, autocommit=True),
            event_publisher=lambda update: None, task_repository=self.repository,
            model_priority=self.priority,
        )
        self.backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=self.scope.owner_id,
            events=self.events, task_host=self.host,
            runtime_shutdown=self.priority.stop,
        ), self.scope.owner_id)
        self.addCleanup(self.backend.close)
        self.addCleanup(self.model.release.set)
        self.publisher = EventBusMessagePublisher(
            self.events, owner_id=self.scope.owner_id, task_host=self.host,
        )

    def build_worker(self):
        if not self.model_available:
            raise ValueError("合成配置不可用")
        return BackgroundTaskWorker(
            repository=self.repository,
            extraction_runner=PostgresMemoryExtractionRunner(
                self.database_url, runtime=PriorityExtractionRuntime(self.model, self.priority),
                verification_runtime=PriorityVerificationRuntime(
                    SyntheticSupportingVerifier(), self.priority,
                ),
                model_name="synthetic-observation",
            ),
            index_repository=PostgresContactMemoryIndexRepository(self.database_url),
            model_priority=self.priority,
        )

    def record(self, number=1, *, same_second=False):
        locator = self.binding.conversation_locator
        timestamp = 1790812800 if same_second else 1790812800 + number
        return self.store.record_batch_with_messages(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            binding_id=self.binding.binding_id, mode=ObservationMode.CLI_BACKGROUND,
            cli_version="synthetic-test", conversation_locator=locator,
            last_local_id=number, last_cursor=f"cursor-{number}", record_count=1,
            messages=(NormalizedMessage(
                source_locator=f"cli:{number}", speaker="contact", message_type="text",
                text_content="我喜欢科幻小说", media_placeholder=None,
                occurred_at=datetime.fromtimestamp(timestamp, timezone.utc),
                wechat_metadata=WechatMessageMetadata(
                    external_local_id=number, external_server_id=f"synthetic-{number}",
                    external_talker=locator, source_create_time=timestamp,
                    raw_payload_json='{"text":"我喜欢科幻小说"}',
                ),
            ),),
        )

    def publish(self, batch):
        for message_id in batch.created_message_ids:
            if message_id is not None:
                self.publisher.publish_message_created(
                    scope=self.scope, occurred_at=datetime.now(timezone.utc),
                    message_id=message_id,
                )

    def wait_task(self, status="succeeded"):
        deadline = time.monotonic() + 5
        latest = None
        while time.monotonic() < deadline:
            code, current = self.backend.request(f"/api/tasks/status?contact_id={self.scope.contact_id}")
            self.assertEqual(code, 200, current)
            task_id = (current.get("progress") or {}).get("task_id")
            if task_id:
                code, latest = self.backend.request(
                    f"/api/tasks/status?contact_id={self.scope.contact_id}&task_id={task_id}",
                )
                self.assertEqual(code, 200, latest)
                if latest["status"] == status:
                    return latest
            time.sleep(0.01)
        self.fail(f"任务未达到预期状态：{latest}")

    def test_committed_observation_automatically_processes_original_task(self):
        batch = self.record()
        self.publish(batch)
        task = self.wait_task()
        self.assertEqual(task["task_type"], "observation")
        self.assertEqual([step["name"] for step in task["steps"]],
                         ["extract_memory", "index", "verify"])
        self.assertEqual(self.model.calls, [frozenset(batch.message_ids)])
        self.assertEqual(len(PostgresMemoryStore(self.database_url).list_pending_candidates(self.scope)), 1)

    def test_replayed_batch_does_not_reset_completed_task(self):
        batch = self.record()
        self.publish(batch)
        before = self.wait_task()
        self.publish(batch)
        code, after = self.backend.request(
            f"/api/tasks/status?contact_id={self.scope.contact_id}&task_id={before['task_id']}",
        )
        self.assertEqual(code, 200)
        self.assertEqual(after, before)

    def test_running_duplicate_events_do_not_add_an_execution_round(self):
        self.model.release.clear()
        batch = self.record()
        self.publish(batch)
        self.assertTrue(self.model.entered.wait(3))
        with ThreadPoolExecutor(max_workers=3) as pool:
            tuple(pool.map(lambda _: self.publish(batch), range(3)))
        self.model.release.set()
        task = self.wait_task()
        self.assertEqual(task["steps"][0]["processed_count"], 1)
        self.assertEqual(len(self.model.calls), 1)

    def test_same_second_batch_during_run_keeps_next_round(self):
        self.model.release.clear()
        # 固定随机 ID，让新消息的 UUID 排在旧水位之前，稳定复现同秒漏提。
        with patch("notalone.persistence.observation_store.uuid4", return_value=UUID(int=100)):
            first = self.record(same_second=True)
        self.publish(first)
        self.assertTrue(self.model.entered.wait(3))
        with patch("notalone.persistence.observation_store.uuid4", return_value=UUID(int=1)):
            second = self.record(2, same_second=True)
        self.publish(second)
        self.model.release.set()
        self.wait_task()
        self.assertEqual(self.model.calls,
                         [frozenset(first.message_ids), frozenset(second.message_ids)])

    def test_global_lock_busy_retains_wakeup_until_released(self):
        with psycopg.connect(self.database_url, autocommit=True) as gate:
            self.assertTrue(try_acquire_global_worker_lock(gate))
            self.publish(self.record())
            self.wait_task("queued")
            self.assertFalse(self.model.calls)
            release_global_worker_lock(gate)
        self.wait_task()
        self.assertEqual(len(self.model.calls), 1)

    def test_revocation_during_lock_wait_ends_pending_execution(self):
        with psycopg.connect(self.database_url, autocommit=True) as gate:
            self.assertTrue(try_acquire_global_worker_lock(gate))
            self.publish(self.record())
            self.wait_task("queued")
            self.bindings.revoke_binding(owner_id=self.scope.owner_id,
                                        contact_id=self.scope.contact_id,
                                        binding_id=self.binding.binding_id)
            release_global_worker_lock(gate)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            current = self.host.current(owner_id=self.scope.owner_id,
                                        contact_id=self.scope.contact_id)
            if current["status"] != "running":
                break
            time.sleep(0.01)
        self.assertNotEqual(current["status"], "running")
        self.assertFalse(self.model.calls)

    def test_configuration_failure_stays_queued_and_new_batch_recovers(self):
        self.model_available = False
        self.publish(self.record())
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            task = self.wait_task("queued")
            if task["error_code"] == "model_configuration_unavailable":
                break
            time.sleep(0.01)
        self.assertEqual(task["error_code"], "model_configuration_unavailable")
        self.assertEqual(task["steps"][0]["attempt_count"], 0)
        self.model_available = True
        self.publish(self.record(2))
        recovered = self.wait_task()
        self.assertEqual(recovered["task_id"], task["task_id"])
        self.assertEqual(recovered["steps"][0]["processed_count"], 2)

    def test_deleted_source_or_revoked_binding_late_event_is_ignored(self):
        batch = self.record()
        self.store.delete_observation(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            observation_id=batch.observation.observation_id,
        )
        self.publish(batch)
        self.assertEqual(self.host.current(owner_id=self.scope.owner_id,
                                           contact_id=self.scope.contact_id)["status"], "idle")
        second = self.record(2)
        self.bindings.revoke_binding(owner_id=self.scope.owner_id,
                                    contact_id=self.scope.contact_id,
                                    binding_id=self.binding.binding_id)
        self.publish(second)
        self.assertEqual(self.host.current(owner_id=self.scope.owner_id,
                                           contact_id=self.scope.contact_id)["status"], "idle")
        self.assertFalse(self.model.calls)

    def test_unknown_message_wrong_contact_and_other_owner_do_not_schedule(self):
        batch = self.record()
        for scope, message_id in (
            (self.scope, uuid4()),
            (ContactScope(self.scope.owner_id, uuid4()), batch.message_ids[0]),
            (ContactScope(uuid4(), self.scope.contact_id), batch.message_ids[0]),
        ):
            self.publisher.publish_message_created(
                scope=scope, message_id=message_id, occurred_at=datetime.now(timezone.utc),
            )
            self.assertEqual(self.host.current(owner_id=scope.owner_id,
                                               contact_id=scope.contact_id)["status"], "idle")
        self.assertFalse(self.model.calls)

    def test_shutdown_ignores_late_observation_event(self):
        batch = self.record()
        code, _ = self.backend.request("/api/runtime/shutdown", {})
        self.assertEqual(code, 200)
        self.publish(batch)
        self.assertEqual(self.host.current(owner_id=self.scope.owner_id,
                                           contact_id=self.scope.contact_id)["status"], "idle")
        self.assertFalse(self.model.calls)

    def test_shutdown_signal_before_host_teardown_does_not_create_task(self):
        batch = self.record()
        self.priority.stop()
        self.publish(batch)
        self.assertEqual(self.host.current(owner_id=self.scope.owner_id,
                                           contact_id=self.scope.contact_id)["status"], "idle")

    def test_observation_does_not_run_an_older_import_task(self):
        source_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""
                INSERT INTO public.source_document
                    (id, owner_id, contact_id, source_type, file_name, content_sha256, record_count)
                VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic.jsonl', %s, 1)
            """, (source_id, self.scope.owner_id, self.scope.contact_id, "a" * 64))
            old_task = self.repository.create_import_task(
                connection, owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
                source_document_id=source_id, message_count=0,
            )
        self.publish(self.record())
        self.wait_task()
        code, status = self.backend.request(
            f"/api/tasks/status?contact_id={self.scope.contact_id}&task_id={old_task}",
        )
        self.assertEqual(code, 200)
        self.assertEqual(status["status"], "queued")
        self.assertTrue(all(step["attempt_count"] == 0 for step in status["steps"]))

    def test_schedule_failure_preserves_observation_and_cursor_then_retries(self):
        batch = self.record()
        with psycopg.connect(self.database_url) as gate:
            lock_contact_scope(gate, owner_id=self.scope.owner_id, contact_id=self.scope.contact_id)
            with self.assertLogs("notalone.server.event_publisher", level="WARNING") as logs:
                self.publish(batch)
            self.assertEqual(logs.records[0].message, "observation_memory_schedule_failed")
        self.assertEqual(self.store.read_cursor(owner_id=self.scope.owner_id,
                                                contact_id=self.scope.contact_id).last_local_id, 1)
        self.assertFalse(self.model.calls)
        self.publish(batch)
        self.wait_task()
        self.assertEqual(self.model.calls, [frozenset(batch.message_ids)])

    def test_failed_task_only_requeues_on_new_batch_and_keeps_retry_budget(self):
        self.model.unavailable = True
        batch = self.record()
        self.publish(batch)
        failed = self.wait_task("failed")
        self.assertEqual(failed["steps"][0]["attempt_count"], 3)
        self.assertEqual(len(self.model.calls), 3)
        self.model.unavailable = False
        self.publish(batch)
        code, still_failed = self.backend.request(
            f"/api/tasks/status?contact_id={self.scope.contact_id}&task_id={failed['task_id']}",
        )
        self.assertEqual(code, 200)
        self.assertEqual(still_failed["status"], "failed")
        self.assertEqual(len(self.model.calls), 3)
        self.publish(self.record(2))
        restored = self.wait_task()
        self.assertEqual(restored["task_id"], failed["task_id"])
        self.assertEqual(restored["steps"][0]["attempt_count"], 1)

    def test_new_batch_during_failed_round_is_not_lost(self):
        self.model.fail_through = 3
        self.model.release.clear()
        self.publish(self.record())
        self.assertTrue(self.model.entered.wait(3))
        self.publish(self.record(2))
        self.model.release.set()
        completed = self.wait_task()
        self.assertEqual(completed["steps"][0]["processed_count"], 2)
        self.assertEqual(len(self.model.calls), 4)

    def test_deleted_pending_batch_does_not_reopen_failed_round(self):
        self.model.fail_through = 3
        self.model.release.clear()
        self.publish(self.record())
        self.assertTrue(self.model.entered.wait(3))
        second = self.record(2)
        self.publish(second)
        self.store.delete_observation(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            observation_id=second.observation.observation_id,
        )
        self.model.release.set()
        self.wait_task("failed")
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if self.host.current(owner_id=self.scope.owner_id,
                                 contact_id=self.scope.contact_id)["status"] != "running":
                break
            time.sleep(0.01)
        self.assertEqual(len(self.model.calls), 3)

    def test_deleted_pending_batch_after_successful_round_does_not_restore_failure(self):
        self.model.failure_calls = {2, 3, 4}
        second_gate = threading.Event()
        self.model.call_gates[2] = second_gate
        self.addCleanup(second_gate.set)
        self.model.release.clear()
        self.publish(self.record())
        self.assertTrue(self.model.entered.wait(3))
        self.publish(self.record(2))
        self.model.release.set()
        deadline = time.monotonic() + 3
        while len(self.model.calls) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(len(self.model.calls), 2)
        third = self.record(3)
        self.publish(third)
        self.store.delete_observation(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            observation_id=third.observation.observation_id,
        )
        second_gate.set()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if self.host.current(owner_id=self.scope.owner_id,
                                 contact_id=self.scope.contact_id)["status"] != "running":
                break
            time.sleep(0.01)
        self.assertEqual(len(self.model.calls), 4)
        self.wait_task("failed")

    def test_round_start_uses_time_after_contact_lock_wait(self):
        batch = self.record()
        task_id = self.repository.enqueue_observation_message(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            message_id=batch.message_ids[0],
        )
        application_name = f"synthetic_claim_{uuid4().hex}"
        repository = PostgresBackgroundTaskRepository(
            f"{self.database_url} application_name={application_name}",
        )
        with ThreadPoolExecutor(max_workers=1) as pool:
            with psycopg.connect(self.database_url) as gate:
                lock_contact_scope(gate, owner_id=self.scope.owner_id,
                                   contact_id=self.scope.contact_id)
                claim = pool.submit(repository.claim_next_step,
                                    owner_id=self.scope.owner_id,
                                    contact_id=self.scope.contact_id,
                                    lease_duration=timedelta(seconds=30),
                                    worker_id=uuid4(), task_id=task_id)
                with psycopg.connect(self.database_url, autocommit=True) as monitor:
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        if claim.done():
                            claim.result()
                        waiting = monitor.execute(
                            "SELECT 1 FROM pg_stat_activity WHERE application_name = %s "
                            "AND wait_event_type = 'Lock'", (application_name,),
                        ).fetchone()
                        if waiting:
                            break
                        time.sleep(0.01)
                self.assertIsNotNone(waiting)
                before_unlock = gate.execute("SELECT clock_timestamp()").fetchone()[0]
            self.assertIsNotNone(claim.result(timeout=3))
        with psycopg.connect(self.database_url) as connection:
            started_at = connection.execute(
                "SELECT started_at FROM public.background_task WHERE id = %s", (task_id,),
            ).fetchone()[0]
        self.assertGreaterEqual(started_at, before_unlock)
