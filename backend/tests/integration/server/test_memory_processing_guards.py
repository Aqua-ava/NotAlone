"""升级旧观察与迟到模型结果必须保持原处理边界和任务租约。"""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from uuid import UUID, uuid4
import unittest

import psycopg

from notalone.ingest.models import NormalizedMessage, WechatMessageMetadata
from notalone.persistence.observation_store import ObservationMode
from notalone.persistence.contact_memory_index import (
    PostgresContactMemoryIndexRepository,
)
from notalone.tasks.worker import BackgroundTaskWorker, PostgresMemoryExtractionRunner
from tests.integration.server.test_observation_auto_flow import (
    ObservationAutoFlowFixture,
)
from tests.unit.memory_extraction.verification_helpers import (
    SyntheticSupportingVerifier,
)


class MemoryProcessingGuardsHttpTest(ObservationAutoFlowFixture, unittest.TestCase):
    def test_new_observation_does_not_reinterpret_old_processed_messages_without_trace(
        self,
    ):
        old = self.record(1)
        self.publish(old)
        task = self.wait_task()
        route = f"/api/contacts/{self.scope.contact_id}/memory-traces"
        status, traces = self.backend.request(route)
        self.assertEqual(status, 200, traces)
        for trace in traces["batches"]:
            status, result = self.backend.request(
                f"{route}/{trace['trace_id']}", method="DELETE"
            )
            self.assertEqual(status, 200, result)
        # 合成升级前状态：消息与水位仍在，但旧版本没有新计划/完成回执表记录。
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "DELETE FROM public.memory_processing_plan WHERE task_id=%s",
                (task["task_id"],),
            )
            connection.execute(
                "DELETE FROM public.memory_processing_receipt WHERE owner_id=%s",
                (self.scope.owner_id,),
            )
        new = self.record(2)
        self.publish(new)
        self.wait_task()
        self.assertEqual(
            self.model.calls, [frozenset(old.message_ids), frozenset(new.message_ids)]
        )
        status, progress = self.backend.request(
            f"/api/contacts/{self.scope.contact_id}/memory-processing"
        )
        self.assertEqual(status, 200, progress)
        self.assertEqual(
            (
                progress["tasks"][0]["processed_count"],
                progress["tasks"][0]["total_count"],
            ),
            (1, 1),
        )

    def test_new_observation_preserves_legacy_unfinished_queued_targets(self):
        self._assert_legacy_unfinished_queue(cancelled=False)

    def test_new_observation_does_not_revive_legacy_cancelled_targets(self):
        self._assert_legacy_unfinished_queue(cancelled=True)

    def test_new_observation_does_not_revive_cancelled_frozen_targets(self):
        self._assert_legacy_unfinished_queue(cancelled=True, legacy=False)

    def _assert_legacy_unfinished_queue(self, *, cancelled, legacy=True):
        old = self.record(1)
        task_id = self.repository.enqueue_observation_message(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            message_id=old.message_ids[0],
        )
        with psycopg.connect(self.database_url) as connection:
            if legacy:
                connection.execute(
                    "DELETE FROM public.memory_processing_plan WHERE task_id=%s",
                    (task_id,),
                )
            if cancelled:
                connection.execute(
                    "UPDATE public.background_task SET status='cancelled' WHERE id=%s",
                    (task_id,),
                )
                connection.execute(
                    "UPDATE public.background_task_step SET status='cancelled' WHERE task_id=%s",
                    (task_id,),
                )
        new = self.record(2)
        self.publish(new)
        self.wait_task()
        expected = (
            set(new.message_ids)
            if cancelled
            else set(old.message_ids + new.message_ids)
        )
        self.assertEqual(self.model.calls, [expected])
        status, progress = self.backend.request(
            f"/api/contacts/{self.scope.contact_id}/memory-processing"
        )
        self.assertEqual(status, 200, progress)
        self.assertEqual(progress["tasks"][0]["processed_count"], len(expected))
        self.assertEqual(progress["tasks"][0]["total_count"], len(expected))

    def test_expired_worker_cannot_write_candidate_or_confirmed_memory(self):
        self._assert_late_result_cannot_write("contact")

    def test_expired_worker_cannot_write_owner_memory(self):
        self._assert_late_result_cannot_write("self")

    def _assert_late_result_cannot_write(self, subject):
        if subject == "contact":
            batch = self.record(1)
        else:
            batch = self.store.record_batch_with_messages(
                owner_id=self.scope.owner_id,
                contact_id=self.scope.contact_id,
                binding_id=self.binding.binding_id,
                mode=ObservationMode.CLI_BACKGROUND,
                cli_version="synthetic-test",
                conversation_locator=self.binding.conversation_locator,
                last_local_id=1,
                last_cursor="cursor-1",
                record_count=1,
                messages=(
                    NormalizedMessage(
                        source_locator="cli:1",
                        speaker="user",
                        message_type="text",
                        text_content="我喜欢科幻小说",
                        media_placeholder=None,
                        occurred_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
                        wechat_metadata=WechatMessageMetadata(
                            external_local_id=1,
                            external_server_id="synthetic-1",
                            external_talker=self.binding.conversation_locator,
                            source_create_time=1790812800,
                            raw_payload_json='{"text":"我喜欢科幻小说"}',
                        ),
                    ),
                ),
            )
        model = self.model

        class SubjectModel:
            def extract(self, window):
                return tuple(
                    {
                        **fact,
                        "subject": subject,
                        "text": (
                            "本人喜欢科幻小说" if subject == "self" else fact["text"]
                        ),
                    }
                    for fact in model.extract(window)
                )

        task_id = self.repository.enqueue_observation_message(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            message_id=batch.message_ids[0],
        )
        worker = BackgroundTaskWorker(
            repository=self.repository,
            extraction_runner=PostgresMemoryExtractionRunner(
                self.database_url,
                runtime=SubjectModel(),
                verification_runtime=SyntheticSupportingVerifier(),
                model_name="synthetic-late-worker",
            ),
            index_repository=PostgresContactMemoryIndexRepository(self.database_url),
        )
        self.model.release.clear()
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(
                worker.run_once,
                owner_id=self.scope.owner_id,
                contact_id=self.scope.contact_id,
                task_id=task_id,
                worker_id=uuid4(),
            )
            self.assertTrue(self.model.entered.wait(3))
            with psycopg.connect(self.database_url) as connection:
                connection.execute(
                    "UPDATE public.background_task_step SET lease_generation=lease_generation+1,lease_expires_at=now()-interval '1 second' WHERE task_id=%s AND step_name='extract_memory'",
                    (task_id,),
                )
            self.model.release.set()
            future.result(timeout=5)
        with psycopg.connect(self.database_url) as connection:
            counts = {
                table: connection.execute(
                    f"SELECT count(*) FROM public.{table} WHERE owner_id=%s",
                    (self.scope.owner_id,),
                ).fetchone()[0]
                for table in ("memory_candidate", "confirmed_memory", "owner_memory")
            }
        self.assertEqual(
            counts, dict(memory_candidate=0, confirmed_memory=0, owner_memory=0)
        )
        status, progress = self.backend.request(
            f"/api/contacts/{self.scope.contact_id}/memory-processing"
        )
        self.assertEqual(status, 200, progress)
        self.assertEqual(progress["tasks"][0]["status"], "interrupted")
        self.assertEqual(progress["tasks"][0]["processed_count"], 0)
