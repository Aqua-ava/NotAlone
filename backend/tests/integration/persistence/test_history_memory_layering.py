"""历史消息入库后的关系提取分层、队列边界与失效路径。

消息页只走观察存储；提取走真实任务仓储、回执与目标表。外部模型使用
内存合成实现，不读取真实聊天或调用外部服务。
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import psycopg

from notalone.ingest.models import NormalizedMessage, WechatMessageMetadata
from notalone.memory import FactSubject, MemoryCandidate, MemoryCategory
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.history_sync_state import (
    HistoryPageCheckpoint,
    PostgresHistorySyncStateStore,
)
from notalone.persistence.memory_processing import (
    MAX_EXTRACTION_TARGETS_PER_RUN,
    PostgresMemoryProcessingStore,
    _CONTEXT_MARGIN_MESSAGES,
    _MAX_CONTEXT_MESSAGES_PER_RUN,
)
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.observation_store import ObservationMode
from notalone.scopes import ContactScope
from notalone.tasks.models import BackgroundTaskStepName
from notalone.tasks.worker import PostgresMemoryExtractionRunner
from tests.integration.persistence import test_observation_store as observations
from tests.unit.memory_extraction.verification_helpers import SyntheticSupportingVerifier


TEST_DATABASE_URL = observations.TEST_DATABASE_URL
HISTORY_START = datetime(2026, 1, 1, tzinfo=timezone.utc)
HISTORY_CREATE_BASE = 1_767_225_600
PAGE_SIZE = 180
CONTEXT_LIMIT = _MAX_CONTEXT_MESSAGES_PER_RUN + 2 * _CONTEXT_MARGIN_MESSAGES


class NullExtractionModel:
    """只记录模型窗口规模；不产出关系事实。"""

    def __init__(self) -> None:
        self.windows: list[tuple[int, int]] = []

    def extract(self, window):
        self.windows.append(
            (len(window.target_message_id_set), len(window.messages))
        )
        return ()


class HistoryMemoryLayeringTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        observations.PostgresObservationStoreTest.setUpClass()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            ready = connection.execute(
                "SELECT to_regclass('public.memory_extraction_receipt'), "
                "to_regclass('public.memory_processing_target'), "
                "to_regclass('public.cli_history_sync_state')"
            ).fetchone()
        if not all(ready):
            raise unittest.SkipTest("需要已执行 104 与提取队列迁移的隔离测试库。")

    def setUp(self) -> None:
        self.fixture = observations.PostgresObservationStoreTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.owner_id = self.fixture.owner_id
        self.contact_id = self.fixture.contact_a
        self.binding = self.fixture.binding_a
        self.locator = self.binding.conversation_locator
        self.store = self.fixture.store
        self.bindings = observations.PostgresConversationBindingRepository(
            TEST_DATABASE_URL
        )
        # 夹具的第二位联系人没有历史任务；撤销以隔离本用例的待处理范围。
        self.bindings.revoke_binding(
            owner_id=self.owner_id,
            contact_id=self.fixture.contact_b,
            binding_id=self.fixture.binding_b.binding_id,
        )
        PostgresHistorySyncStateStore(TEST_DATABASE_URL).ensure_scope_started(
            owner_id=self.owner_id,
            channel="wechat",
            account_scope="synthetic-account",
            watermark_at=HISTORY_START,
        )
        self.tasks = PostgresBackgroundTaskRepository(TEST_DATABASE_URL)
        self.processing = PostgresMemoryProcessingStore(TEST_DATABASE_URL)

    def _message(
        self, number: int, *, locator: str | None = None
    ) -> NormalizedMessage:
        locator = locator or self.locator
        return NormalizedMessage(
            source_locator=f"cli:{number}",
            speaker="contact" if number % 2 else "user",
            message_type="text",
            text_content=f"合成历史消息{number}",
            media_placeholder=None,
            occurred_at=HISTORY_START + timedelta(seconds=number),
            wechat_metadata=WechatMessageMetadata(
                external_local_id=number,
                external_server_id=f"synthetic-{number}",
                external_talker=locator,
                source_create_time=HISTORY_CREATE_BASE + number,
                raw_payload_json='{"text":"synthetic"}',
            ),
        )

    def _record_page(
        self,
        start: int,
        count: int = PAGE_SIZE,
        *,
        complete=False,
        contact_id: UUID | None = None,
        binding=None,
    ):
        contact_id = contact_id or self.contact_id
        binding = binding or self.binding
        locator = binding.conversation_locator
        last = start + count - 1
        cursor = f"local_id:{last}"
        return self.store.record_batch_with_messages(
            owner_id=self.owner_id,
            contact_id=contact_id,
            binding_id=binding.binding_id,
            mode=ObservationMode.CLI_HISTORY,
            cli_version="synthetic-history",
            conversation_locator=locator,
            last_local_id=last,
            last_cursor=cursor,
            record_count=count,
            messages=tuple(
                self._message(number, locator=locator)
                for number in range(start, last + 1)
            ),
            advance_cursor=False,
            is_reliable=False,
            history_checkpoint=HistoryPageCheckpoint(
                complete=complete,
                message_count=count,
                non_text_count=0,
                last_local_id=last,
                last_cursor=cursor,
            ),
        )

    def _record_history(self, pages: int, *, page_size: int = PAGE_SIZE):
        batches = []
        for page in range(pages):
            start = page * page_size + 1
            batches.append(
                self._record_page(
                    start, page_size, complete=page == pages - 1
                )
            )
        return batches

    def _claim_once(self) -> UUID | None:
        from notalone.persistence.extraction_schedule import claim_scope

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            return claim_scope(
                connection, self.tasks, owner_id=self.owner_id,
                contact_id=self.contact_id,
            )

    def _claim_all_observations(self) -> UUID | None:
        """模拟调度器逐轮认领，直到当前没有到期待处理历史页。"""
        task_id = None
        while (next_task := self._claim_once()) is not None:
            task_id = next_task
        return task_id

    def _claims(self):
        return self._claim_once()

    def _pending_receipts(self) -> int:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            return connection.execute(
                "SELECT count(*) FROM public.memory_extraction_receipt "
                "WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, self.contact_id),
            ).fetchone()[0]

    def test_large_backlog_claim_is_bounded_and_resumes(self) -> None:
        from notalone.persistence.extraction_schedule import (
            _MAX_RECEIPTS_PER_CLAIM,
        )

        # 20 页 × 180 条超过单次认领上限；事务只登记有限来源批次。
        self._record_history(20)
        task_id = self._claims()
        self.assertIsNotNone(task_id)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            claimed = connection.execute(
                "SELECT count(*) FROM public.memory_extraction_receipt "
                "WHERE task_id=%s",
                (task_id,),
            ).fetchone()[0]
        self.assertGreaterEqual(claimed, _MAX_RECEIPTS_PER_CLAIM)
        self.assertLessEqual(claimed, _MAX_RECEIPTS_PER_CLAIM + PAGE_SIZE)
        pending_count, due_at, scheduled_task = self._schedule()
        self.assertEqual(pending_count, 20 * PAGE_SIZE - claimed)
        self.assertIsNotNone(due_at)
        self.assertEqual(scheduled_task, task_id)

        # 任务已有足够未完成目标时先不追加；消费一部分后下一轮继续认领。
        self.assertIsNone(self._claims())
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            processed = [
                row[0] for row in connection.execute(
                    "SELECT message_id FROM public.memory_processing_target "
                    "WHERE task_id=%s AND completed_at IS NULL "
                    "ORDER BY message_id LIMIT 200",
                    (task_id,),
                ).fetchall()
            ]
            connection.execute(
                "INSERT INTO public.memory_processing_receipt("
                "message_id,owner_id,contact_id,outcome) "
                "SELECT id,owner_id,contact_id,'succeeded' FROM public.message "
                "WHERE id=ANY(%s) ON CONFLICT DO NOTHING",
                (processed,),
            )
            connection.execute(
                "UPDATE public.memory_processing_target SET completed_at=now(),"
                "outcome='succeeded' WHERE task_id=%s AND message_id=ANY(%s)",
                (task_id, processed),
            )
        self.assertEqual(self._claims(), task_id)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            total = connection.execute(
                "SELECT count(*) FROM public.memory_extraction_receipt "
                "WHERE task_id=%s",
                (task_id,),
            ).fetchone()[0]
        self.assertEqual(total, 20 * PAGE_SIZE)
        pending_count, due_at, _ = self._schedule()
        self.assertEqual(pending_count, 0)
        self.assertIsNone(due_at)

    def _schedule(self):
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            return connection.execute(
                "SELECT pending_count,due_at,task_id "
                "FROM public.memory_extraction_schedule "
                "WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, self.contact_id),
            ).fetchone()

    def test_history_page_queues_receipts_without_running_extraction(self) -> None:
        self._record_history(2)

        self.assertEqual(self._pending_receipts(), 2 * PAGE_SIZE)
        pending_count, due_at, task_id = self._schedule()
        self.assertEqual(pending_count, 2 * PAGE_SIZE)
        self.assertIsNotNone(due_at)
        self.assertIsNone(task_id)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            tasks = connection.execute(
                "SELECT count(*) FROM public.background_task "
                "WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, self.contact_id),
            ).fetchone()[0]
        self.assertEqual(tasks, 0, "入库事务不等待或启动关系提取")

    def test_owner_pending_count_aggregates_contacts(self) -> None:
        self._record_page(1, 2)
        other_binding = self.bindings.create_binding(
            owner_id=self.owner_id,
            contact_id=self.fixture.contact_b,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_observation_b_new",
        )
        PostgresHistorySyncStateStore(TEST_DATABASE_URL).ensure_scope_started(
            owner_id=self.owner_id,
            channel="wechat",
            account_scope="synthetic-account",
            watermark_at=HISTORY_START,
        )
        self._record_page(
            1000, 3, contact_id=self.fixture.contact_b, binding=other_binding
        )

        owner = self.processing.read(owner_id=self.owner_id)
        self.assertEqual(owner["pending_count"], 5)
        contact = self.processing.read(
            owner_id=self.owner_id, contact_id=self.contact_id
        )
        self.assertEqual(contact["pending_count"], 2)

    def test_claim_keeps_existing_batching_while_execution_stays_bounded(self) -> None:
        self._record_history(4)

        task_id = self._claims()
        self.assertIsNotNone(task_id)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            targets = connection.execute(
                "SELECT count(*) FROM public.memory_processing_target "
                "WHERE task_id=%s",
                (task_id,),
            ).fetchone()[0]
            receipts = connection.execute(
                "SELECT count(*) FROM public.memory_extraction_receipt "
                "WHERE task_id=%s",
                (task_id,),
            ).fetchone()[0]
        # 认领沿用既有队列：一次任务汇总当前待处理来源。
        self.assertEqual(receipts, 4 * PAGE_SIZE)
        self.assertEqual(targets, 4 * PAGE_SIZE)
        pending_count, due_at, scheduled_task = self._schedule()
        self.assertEqual(pending_count, 0)
        self.assertIsNone(due_at)
        self.assertEqual(scheduled_task, task_id)

        # 执行侧每次只取固定上限的目标，历史规模不进入单次模型上下文。
        scope = ContactScope(self.owner_id, self.contact_id)
        claim = self.tasks.claim_next_step(
            owner_id=self.owner_id, contact_id=self.contact_id,
            task_id=task_id, worker_id=uuid4(),
            lease_duration=timedelta(seconds=60),
            supported_steps=(BackgroundTaskStepName.EXTRACT_MEMORY,),
        )
        self.assertIsNotNone(claim)
        selected, context, _ = self.processing.targets(
            owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id,
        )
        self.assertEqual(len(selected), MAX_EXTRACTION_TARGETS_PER_RUN)
        self.assertLessEqual(len(context), CONTEXT_LIMIT)
        self.assertTrue(set(selected).issubset(set(context)))

    def test_targets_and_context_are_bounded_and_resumable(self) -> None:
        self._record_history(6)
        task_id = self._claim_all_observations()
        self.assertIsNotNone(task_id)

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            self.tasks.claim_next_step(
                owner_id=self.owner_id, contact_id=self.contact_id,
                task_id=task_id, worker_id=uuid4(),
                lease_duration=timedelta(seconds=60),
                supported_steps=(BackgroundTaskStepName.EXTRACT_MEMORY,),
            )
        selected, context, _generation = self.processing.targets(
            owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id,
        )
        self.assertEqual(len(selected), MAX_EXTRACTION_TARGETS_PER_RUN)
        self.assertLessEqual(len(context), CONTEXT_LIMIT)
        self.assertTrue(set(selected).issubset(set(context)))

        # 第一批目标提交后，下一轮读取返回剩余目标而不是同一批。
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.memory_processing_receipt("
                "message_id,owner_id,contact_id,outcome) "
                "SELECT id,owner_id,contact_id,'succeeded' FROM public.message "
                "WHERE id=ANY(%s) ON CONFLICT DO NOTHING",
                (list(selected),),
            )
            connection.execute(
                "UPDATE public.memory_processing_target SET completed_at=now(),"
                "outcome='succeeded' WHERE task_id=%s AND message_id=ANY(%s)",
                (task_id, list(selected)),
            )
        next_selected, next_context, _ = self.processing.targets(
            owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id,
        )
        self.assertTrue(next_selected)
        self.assertFalse(set(next_selected) & set(selected))
        self.assertLessEqual(len(next_context), CONTEXT_LIMIT)

    def test_runner_processes_history_in_bounded_windows(self) -> None:
        self._record_history(4)
        task_id = self._claim_all_observations()
        self.assertIsNotNone(task_id)
        claim = self.tasks.claim_next_step(
            owner_id=self.owner_id, contact_id=self.contact_id,
            task_id=task_id, worker_id=uuid4(),
            lease_duration=timedelta(seconds=120),
            supported_steps=(BackgroundTaskStepName.EXTRACT_MEMORY,),
        )
        self.assertIsNotNone(claim)
        model = NullExtractionModel()
        runner = PostgresMemoryExtractionRunner(
            TEST_DATABASE_URL, runtime=model,
            verification_runtime=SyntheticSupportingVerifier(),
            model_name="synthetic-history-model",
        )
        stats = runner.run(scope=ContactScope(self.owner_id, self.contact_id), task_id=task_id)

        self.assertEqual(stats.processed_messages, 4 * PAGE_SIZE)
        self.assertTrue(model.windows)
        self.assertTrue(all(targets <= 20 for targets, _ in model.windows))
        self.assertTrue(all(context <= CONTEXT_LIMIT for _, context in model.windows))
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            completed = connection.execute(
                "SELECT count(*) FROM public.memory_processing_target "
                "WHERE task_id=%s AND completed_at IS NULL",
                (task_id,),
            ).fetchone()[0]
        self.assertEqual(completed, 0)

    def test_failure_and_backlog_do_not_change_message_coverage(self) -> None:
        self._record_history(2)
        # 积压：尚未认领时，读取状态单独表达关系资料处理量。
        payload = self.processing.read(owner_id=self.owner_id, contact_id=self.contact_id)
        self.assertEqual(payload["pending_count"], 2 * PAGE_SIZE)
        self._claims()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            before = connection.execute(
                "SELECT phase,message_count,last_cursor FROM public.cli_history_sync_state "
                "WHERE owner_id=%s AND contact_id=%s AND binding_id=%s",
                (self.owner_id, self.contact_id, self.binding.binding_id),
            ).fetchone()
        self.assertIsNotNone(before)
        self.assertEqual(before[1], 2 * PAGE_SIZE)
        self.assertEqual(before[2], f"local_id:{2 * PAGE_SIZE}")

        # 失败：把当前提取步骤记为不可重试失败，消息覆盖仍不变。
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            task_id = connection.execute(
                "SELECT task_id FROM public.memory_extraction_schedule "
                "WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, self.contact_id),
            ).fetchone()[0]
        claim = self.tasks.claim_next_step(
            owner_id=self.owner_id, contact_id=self.contact_id,
            task_id=task_id, worker_id=uuid4(),
            lease_duration=timedelta(seconds=60),
            supported_steps=(BackgroundTaskStepName.EXTRACT_MEMORY,),
        )
        self.tasks.fail_step(claim, error_code="memory_extraction_failed", retryable=False)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            after = connection.execute(
                "SELECT phase,message_count,last_cursor FROM public.cli_history_sync_state "
                "WHERE owner_id=%s AND contact_id=%s AND binding_id=%s",
                (self.owner_id, self.contact_id, self.binding.binding_id),
            ).fetchone()
        self.assertEqual(after, before)
        payload = self.processing.read(owner_id=self.owner_id, contact_id=self.contact_id)
        self.assertTrue(any(task["task_type"] == "observation" for task in payload["tasks"]))

    def test_history_source_and_contact_deletion_invalidate_extraction(self) -> None:
        batches = self._record_history(1, page_size=2)
        batch = batches[0]
        message_id = batch.message_ids[0]
        scope = ContactScope(self.owner_id, self.contact_id)

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            source = connection.execute(
                "SELECT observation_id FROM public.message_source_ref "
                "WHERE owner_id=%s AND contact_id=%s AND message_id=%s",
                (self.owner_id, self.contact_id, message_id),
            ).fetchone()
        self.assertEqual(source[0], batch.observation.observation_id)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            receipt = connection.execute(
                "SELECT observation_id FROM public.memory_extraction_receipt "
                "WHERE message_id=%s",
                (message_id,),
            ).fetchone()
        self.assertEqual(receipt[0], batch.observation.observation_id)

        memories = PostgresMemoryStore(TEST_DATABASE_URL)
        candidate = memories.create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=scope,
            text="历史消息提取出的合成关系事实",
            category=MemoryCategory.COMMON_FACT, subject=FactSubject.CONTACT,
            source_ids=(message_id,),
        ))
        memories.confirm(scope=scope, candidate_id=candidate.candidate_id)
        self.assertTrue(memories.list_confirmed(scope))

        self.store.delete_observation(
            owner_id=self.owner_id, contact_id=self.contact_id,
            observation_id=batch.observation.observation_id,
        )
        self.assertEqual(memories.list_confirmed(scope), ())
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            counts = connection.execute(
                "SELECT "
                "(SELECT count(*) FROM public.memory_extraction_receipt WHERE message_id=%s),"
                "(SELECT count(*) FROM public.memory_processing_target WHERE message_id=%s),"
                "(SELECT count(*) FROM public.message WHERE id=%s)",
                (message_id, message_id, message_id),
            ).fetchone()
        self.assertEqual(counts, (0, 0, 0))

        # 联系人删除级联清理任务、回执、目标与已确认关系资料。
        batch = self._record_page(100, 2)
        candidate = memories.create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=scope,
            text="联系人删除前提取出的合成事实",
            category=MemoryCategory.COMMON_FACT, subject=FactSubject.CONTACT,
            source_ids=(batch.message_ids[0],),
        ))
        memories.confirm(scope=scope, candidate_id=candidate.candidate_id)
        self.assertTrue(memories.list_confirmed(scope))
        from notalone.persistence.contact_deletion import delete_contact

        self.assertTrue(delete_contact(TEST_DATABASE_URL, scope))
        self.assertEqual(memories.list_confirmed(scope), ())
        self.assertEqual(memories.list_pending_candidates(scope), ())
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            remaining = connection.execute(
                "SELECT "
                "(SELECT count(*) FROM public.memory_extraction_receipt WHERE owner_id=%s),"
                "(SELECT count(*) FROM public.memory_extraction_schedule WHERE owner_id=%s),"
                "(SELECT count(*) FROM public.background_task WHERE owner_id=%s)",
                (self.owner_id, self.owner_id, self.owner_id),
            ).fetchone()
        self.assertEqual(remaining, (0, 0, 0))

    def test_revoked_binding_invalidates_targets_and_hides_backlog(self) -> None:
        self._record_history(1, page_size=2)
        payload = self.processing.read(owner_id=self.owner_id, contact_id=self.contact_id)
        self.assertEqual(payload["pending_count"], 2)

        task_id = self._claims()
        self.assertIsNotNone(task_id)
        self.tasks.claim_next_step(
            owner_id=self.owner_id, contact_id=self.contact_id,
            task_id=task_id, worker_id=uuid4(),
            lease_duration=timedelta(seconds=60),
            supported_steps=(BackgroundTaskStepName.EXTRACT_MEMORY,),
        )
        selected, _context, _ = self.processing.targets(
            owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id,
        )
        self.assertEqual(len(selected), 2)

        self.bindings.revoke_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=self.binding.binding_id,
        )
        payload = self.processing.read(owner_id=self.owner_id, contact_id=self.contact_id)
        self.assertEqual(payload["pending_count"], 0)
        self.assertIsNone(self._claims())

        # 明确重新确认同一联系人不会让已撤销来源的目标复活。
        self.bindings.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_observation_reactivated",
        )
        self.assertIsNone(self._claims())
        selected, context, _ = self.processing.targets(
            owner_id=self.owner_id, contact_id=self.contact_id, task_id=task_id,
        )
        self.assertEqual((selected, context), ((), ()))

if __name__ == "__main__":
    unittest.main()
