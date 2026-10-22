"""串行与并行终态一致：同一合成消息集分别以并发度 1 与 3 完整提取。

本用例只验证外部可观察终态（确认记忆、待确认候选、水位、过程记录与
聚合统计）在两种并发度下一致；不写真实聊天、不调用真实模型。并发度 3
的运行用固定方数闩锁确认提取调用确实同时在途，避免退化成串行。
"""

from __future__ import annotations

import os
import threading
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import psycopg

from notalone.memory.models import (
    AdoptionMethod,
    MemoryCandidate,
    MemoryCategory,
    MemoryTopic,
)
from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.memory_extraction.command import run_extraction
from notalone.memory_extraction.errors import (
    ExtractionInvalidOutputError,
    ExtractionRuntimeError,
)
from notalone.memory_extraction.models import ExtractionFailureKind
from notalone.memory_extraction.recovery import (
    DEFAULT_FAILURE_SKIP_THRESHOLD,
    ExtractionFailureState,
    FailureRange,
)
from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.watermark_store import PostgresWatermarkStore
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_command import _payload
from tests.unit.memory_extraction.verification_helpers import (
    SyntheticSupportingVerifier,
)

DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")

BATCH_CONCURRENCY = 3
BATCH_SIZE = 1
# 6 条消息、每批 1 条：并发 3 恰好形成两组三路在途，闩锁可以确定性释放。
# 场景覆盖自动采纳、待确认、非记忆、契约拒绝、重复与失败批。
MESSAGE_TEXTS = (
    "合成消息一：今天开会到很晚",
    "他习惯直接打电话沟通",
    "他偏爱清淡饮食",
    "他每周三固定去健身房",
    "他最近在准备换工作",
    "预约下周三下午维修空调",
)
# 第 3 条消息的候选与预先写入的确认记忆重复，用于覆盖 skipped_duplicate。
DUPLICATE_MESSAGE_INDEX = 3
DUPLICATE_TEXT = MESSAGE_TEXTS[DUPLICATE_MESSAGE_INDEX]
# 第 0 批用预置失败计数触发跳过区间；第 5 批失败并停止整轮。
EXPECTED_TRACE_STATUSES = (
    "skipped",
    "succeeded",
    "succeeded",
    "succeeded",
    "succeeded",
    "model_failed",
)


def _payloads_for(text: str, message_id: UUID) -> tuple[dict, ...]:
    """按目标消息文本返回确定性模型输出；串行与并行运行共用本脚本。"""

    if text == MESSAGE_TEXTS[0]:
        raise ExtractionInvalidOutputError("合成无效结构化输出。")
    if text == MESSAGE_TEXTS[1]:
        return (
            {**_payload(message_id), "text": "他习惯直接打电话沟通"},
            # 缺少必要字段，由流程计为契约拒绝而不是写入候选。
            {"text": "损坏的合成结构"},
        )
    if text == MESSAGE_TEXTS[2]:
        return (
            {
                **_payload(message_id),
                "text": "他偏爱清淡饮食",
                "category": "preference",
                "topic": "health",
            },
            {
                **_payload(message_id),
                "text": "他讲了个合成玩笑",
                "figurative_type": "joke",
            },
        )
    if text == DUPLICATE_TEXT:
        return ({**_payload(message_id), "text": DUPLICATE_TEXT},)
    if text == MESSAGE_TEXTS[4]:
        return (
            {
                **_payload(message_id),
                "text": "他最近在准备换工作",
                "category": "recent_state",
                "topic": "work",
                "confidence": 0.4,
            },
        )
    raise ExtractionRuntimeError("合成模型调用失败。")


class DeterministicRuntime:
    """只返回合成结构化的确定性提取运行时，不访问真实模型。"""

    def extract(self, window):
        message_id = window.target_message_ids[0]
        target = next(
            message
            for message in window.messages
            if message.message_id == message_id
        )
        return _payloads_for(target.text, message_id)


class ParallelPeakRuntime(DeterministicRuntime):
    """用固定方数闩锁记录提取在途峰值，确认并发度 3 确实并行。

    只有三个提取调用同时到达闩锁才能释放；若实现退化为串行，有界
    等待后抛 BrokenBarrierError，用例立刻失败而不是挂起或睡眠轮询。
    """

    def __init__(self, parties: int, *, timeout: float = 5.0) -> None:
        self._barrier = threading.Barrier(parties)
        self._lock = threading.Lock()
        self._active = 0
        self._timeout = timeout
        self.peak = 0

    def extract(self, window):
        with self._lock:
            self._active += 1
            self.peak = max(self.peak, self._active)
        try:
            self._barrier.wait(timeout=self._timeout)
        finally:
            with self._lock:
                self._active -= 1
        return super().extract(window)


class SerialParallelFinalStateParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式提供本任务隔离测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            name = connection.execute("SELECT current_database()").fetchone()[
                0
            ]
        if not name.endswith("_test"):
            raise RuntimeError("终态一致性测试只允许使用隔离测试库。")

    def setUp(self):
        self.memory = PostgresMemoryStore(DATABASE_URL)
        self.owner_memory = PostgresOwnerMemoryStore(DATABASE_URL)
        self.watermark = PostgresWatermarkStore(DATABASE_URL)
        self.traces = PostgresExtractionTraceStore(DATABASE_URL)

    def _seed_scope(self, label: str) -> tuple[ContactScope, tuple]:
        scope = ContactScope(uuid4(), uuid4())
        # ON DELETE CASCADE 清理联系人、来源、消息、记忆、候选、水位与追踪。
        self.addCleanup(self._delete_owner, scope.owner_id)
        message_ids: list[UUID] = []
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (scope.owner_id, label),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (scope.owner_id, scope.contact_id, f"{label}的联系人"),
            )
            for index, text in enumerate(MESSAGE_TEXTS):
                source_id, message_id = uuid4(), uuid4()
                message_ids.append(message_id)
                connection.execute(
                    "INSERT INTO public.source_document "
                    "(id, owner_id, contact_id, source_type, file_name, "
                    "content_sha256, record_count, status) "
                    "VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic.jsonl', "
                    "%s, 1, 'active')",
                    (
                        source_id,
                        scope.owner_id,
                        scope.contact_id,
                        f"{index:064x}",
                    ),
                )
                connection.execute(
                    "INSERT INTO public.message "
                    "(id, owner_id, contact_id, speaker, message_type, "
                    "text_content, occurred_at) "
                    "VALUES (%s, %s, %s, 'contact', 'text', %s, %s)",
                    (
                        message_id,
                        scope.owner_id,
                        scope.contact_id,
                        text,
                        base + timedelta(minutes=index),
                    ),
                )
                connection.execute(
                    "INSERT INTO public.message_source_ref "
                    "(message_id, owner_id, contact_id, source_kind, "
                    "source_document_id, source_locator, raw_payload) "
                    "VALUES (%s, %s, %s, 'source_document', %s, 'line-1', "
                    "'{}'::jsonb)",
                    (
                        message_id,
                        scope.owner_id,
                        scope.contact_id,
                        source_id,
                    ),
                )
        # 预先写入一条与第 3 批输出完全相同的确认记忆，让重放候选走
        # 去重分支；它属于该 scope 的合成前史，两次运行各自一致。
        candidate = self.memory.create_candidate(
            MemoryCandidate(
                candidate_id=uuid4(),
                scope=scope,
                text=DUPLICATE_TEXT,
                category=MemoryCategory.COMMON_FACT,
                topic=MemoryTopic.OTHER,
                source_ids=(message_ids[DUPLICATE_MESSAGE_INDEX],),
                confidence=0.9,
            )
        )
        self.memory.confirm(
            scope=scope,
            candidate_id=candidate.candidate_id,
            adoption_method=AdoptionMethod.AUTO,
        )
        # 预置两次无效输出，让第 0 批的失败达到跳过阈值并推进水位。
        self.watermark.save_failure(
            scope,
            ExtractionFailureState(
                count=DEFAULT_FAILURE_SKIP_THRESHOLD - 1,
                failure_range=FailureRange(
                    from_message_id=message_ids[0],
                    to_message_id=message_ids[0],
                    code=ExtractionFailureKind.INVALID_OUTPUT,
                ),
            ),
        )
        messages = load_contact_messages(scope, DATABASE_URL)
        if tuple(message.text for message in messages) != MESSAGE_TEXTS:
            raise AssertionError("合成消息集加载顺序或内容不符合预期。")
        return scope, messages

    def _delete_owner(self, owner_id: UUID) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s", (owner_id,)
            )

    def _run(
        self,
        scope: ContactScope,
        messages: tuple,
        concurrency: int,
        runtime,
        *,
        automatic: bool,
    ) -> object:
        return run_extraction(
            scope=scope,
            messages=messages,
            watermark_message_id=None,
            runtime=runtime,
            memory_port=self.memory,
            owner_memory_port=self.owner_memory,
            watermark_port=self.watermark,
            trace_store=self.traces,
            verification_runtime=SyntheticSupportingVerifier(),
            batch_size=BATCH_SIZE,
            batch_concurrency=concurrency,
            automatic=automatic,
        )

    @staticmethod
    def _message_index(messages: tuple, message_id: object) -> int:
        identifier = (
            message_id if isinstance(message_id, UUID) else UUID(str(message_id))
        )
        return [message.message_id for message in messages].index(identifier)

    def _observe(self, scope: ContactScope, messages: tuple) -> dict:
        # 忽略 UUID，只按业务字段归一化；排序后比较即多重集相等。
        confirmed = sorted(
            (
                memory.text,
                memory.category.value,
                memory.topic.value,
                memory.status.value,
                memory.adoption_method.value,
            )
            for memory in self.memory.list_confirmed(scope)
        )
        pending = sorted(
            (
                candidate.text,
                candidate.category.value,
                candidate.topic.value,
                candidate.status.value,
                None,
            )
            for candidate in self.memory.list_pending_candidates(scope)
        )
        watermark = self.watermark.get(scope)
        watermark_index = (
            None
            if watermark is None
            else self._message_index(messages, watermark)
        )
        status_by_index: dict[int, str] = {}
        for batch in self.traces.list_batches(scope):
            detail = self.traces.get_batch(scope, batch["trace_id"])
            window = next(
                event
                for event in detail["events"]
                if event["stage"] == "window"
            )
            target_id = window["payload"]["target_message_ids"][0]
            index = self._message_index(messages, target_id)
            self.assertNotIn(
                index, status_by_index, "每批只应有一条过程记录。"
            )
            status_by_index[index] = detail["status"]
        self.assertEqual(
            sorted(status_by_index), list(range(len(messages)))
        )
        return {
            "confirmed": confirmed,
            "pending": pending,
            "watermark_index": watermark_index,
            "trace_statuses": tuple(
                status_by_index[index] for index in range(len(messages))
            ),
        }

    @staticmethod
    def _range_indices(messages: tuple, ranges: tuple) -> list[tuple]:
        index_of = {
            message.message_id: index
            for index, message in enumerate(messages)
        }
        return [
            (
                index_of[failure_range.from_message_id],
                index_of[failure_range.to_message_id],
                failure_range.code.value,
            )
            for failure_range in ranges
        ]

    def _assert_terminal_parity(
        self,
        *,
        automatic: bool,
        serial_scope: ContactScope,
        serial_messages: tuple,
        parallel_scope: ContactScope,
        parallel_messages: tuple,
        serial_stats,
        parallel_stats,
        parallel_peak: int,
    ) -> None:
        self.assertEqual(
            tuple(message.text for message in serial_messages),
            tuple(message.text for message in parallel_messages),
        )
        self.assertNotEqual(serial_scope, parallel_scope)
        serial = self._observe(serial_scope, serial_messages)
        parallel = self._observe(parallel_scope, parallel_messages)

        # 确认记忆与待确认候选：按业务字段归一化后多重集相等。
        self.assertEqual(serial["confirmed"], parallel["confirmed"])
        self.assertEqual(serial["pending"], parallel["pending"])
        # 水位：映射回消息序号后相等。
        self.assertEqual(
            serial["watermark_index"], parallel["watermark_index"]
        )
        # 过程记录：每批一条，状态序列一致且覆盖跳过与失败。
        self.assertEqual(
            serial["trace_statuses"], parallel["trace_statuses"]
        )
        self.assertEqual(
            serial["trace_statuses"], EXPECTED_TRACE_STATUSES
        )
        # 聚合统计逐字段一致；跳过区间只比较长度与消息序号。
        self.assertEqual(
            replace(serial_stats, skipped_ranges=()),
            replace(parallel_stats, skipped_ranges=()),
        )
        self.assertEqual(
            self._range_indices(
                serial_messages, serial_stats.skipped_ranges
            ),
            self._range_indices(
                parallel_messages, parallel_stats.skipped_ranges
            ),
        )
        # 确保场景确实触达各条分支，而不是空数据集上的一致。
        self.assertEqual(serial_stats.batches, len(MESSAGE_TEXTS))
        self.assertEqual(
            serial_stats.processed_messages, len(MESSAGE_TEXTS)
        )
        self.assertEqual(serial_stats.failed_batches, 1)
        self.assertEqual(serial_stats.skipped_batches, 1)
        self.assertEqual(len(serial_stats.skipped_ranges), 1)
        self.assertGreater(serial_stats.adopted, 0)
        self.assertGreater(serial_stats.skipped_duplicate, 0)
        self.assertGreater(serial_stats.rejected_by_contract, 0)
        if automatic:
            # 生产默认自动终结路径不会留下待确认候选。
            self.assertEqual(serial_stats.pending, 0)
            self.assertEqual(serial_stats.skipped_non_memory, 0)
        else:
            # 非自动终结路径保留待确认候选与语用跳过，供人工处理。
            self.assertGreater(serial_stats.pending, 0)
            self.assertGreater(serial_stats.skipped_non_memory, 0)
        # 并发度 3 确实出现并行；峰值不超过配置上限。
        self.assertGreater(parallel_peak, 1)
        self.assertLessEqual(parallel_peak, BATCH_CONCURRENCY)

    def test_serial_and_parallel_reach_the_same_business_final_state(self):
        # automatic=True 是生产默认自动终结路径；automatic=False 是非自动
        # 终结路径（保留待确认候选）。两者都走同一条批次流水线，分别使用
        # 各自独立的 owner/contact 范围，避免互相污染。
        for automatic in (True, False):
            with self.subTest(automatic=automatic):
                serial_scope, serial_messages = self._seed_scope(
                    f"合成串行用户-{automatic}"
                )
                parallel_scope, parallel_messages = self._seed_scope(
                    f"合成并行用户-{automatic}"
                )
                serial_stats = self._run(
                    serial_scope,
                    serial_messages,
                    concurrency=1,
                    runtime=DeterministicRuntime(),
                    automatic=automatic,
                )
                parallel_runtime = ParallelPeakRuntime(
                    parties=BATCH_CONCURRENCY
                )
                parallel_stats = self._run(
                    parallel_scope,
                    parallel_messages,
                    concurrency=BATCH_CONCURRENCY,
                    runtime=parallel_runtime,
                    automatic=automatic,
                )
                self._assert_terminal_parity(
                    automatic=automatic,
                    serial_scope=serial_scope,
                    serial_messages=serial_messages,
                    parallel_scope=parallel_scope,
                    parallel_messages=parallel_messages,
                    serial_stats=serial_stats,
                    parallel_stats=parallel_stats,
                    parallel_peak=parallel_runtime.peak,
                )


if __name__ == "__main__":
    unittest.main()
