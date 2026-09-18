"""提取命令核心逻辑测试：分批、水位续跑与统计聚合。"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from notalone.memory.models import (
    AdoptionMethod,
    ConfirmedMemory,
    MemoryCategory,
    MemoryTopic,
)
from notalone.memory_extraction.command import run_extraction
from notalone.memory_extraction.errors import (
    ExtractionInvalidOutputError,
    ExtractionRuntimeError,
)
from notalone.memory_extraction.models import (
    ExtractionFailureKind,
    MessageRef,
    MessageSender,
)
from notalone.memory_extraction.recovery import (
    ExtractionFailureState,
    FailureRange,
)
from notalone.scopes import ContactScope


OWNER_ID = UUID("aaaaaaaa-1111-1111-1111-111111111111")
CONTACT_ID = UUID("bbbbbbbb-2222-2222-2222-222222222222")


def _messages(count: int):
    base = datetime(2026, 8, 1, tzinfo=timezone.utc)
    return tuple(
        MessageRef(
            message_id=uuid4(),
            text=f"合成消息 {index}",
            sender=MessageSender.CONTACT,
            occurred_at=base + timedelta(minutes=index),
        )
        for index in range(count)
    )


class NullRuntime:
    """返回空候选（不产出事实）的确定性运行时。"""

    def extract(self, window: object) -> tuple:
        return ()


class FailingRuntime:
    def extract(self, window: object) -> tuple:
        raise ExtractionRuntimeError("模型调用失败，未生成记忆。")


class InvalidOutputRuntime:
    def extract(self, window: object) -> tuple:
        raise ExtractionInvalidOutputError("模型未返回可解析的结构化事实。")


class UnavailableRuntime:
    def extract(self, window: object) -> tuple:
        raise ExtractionRuntimeError("模型调用失败，未生成记忆。")


class ScriptedRuntime:
    """按序抛出预置失败或返回空候选。"""

    def __init__(self, outcomes: list[object]) -> None:
        self.outcomes = list(outcomes)

    def extract(self, window: object) -> tuple:
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return ()


class RecordingWindowRuntime(NullRuntime):
    def __init__(self) -> None:
        self.windows = []

    def extract(self, window: object) -> tuple:
        self.windows.append(window)
        return ()


def _payload(message_id: UUID) -> dict:
    return {
        "text": "他习惯直接打电话沟通",
        "category": "common_fact",
        "subject": "contact",
        "topic": "other",
        "source_message_ids": [str(message_id)],
        "confidence": 0.9,
        "risk_flags": [],
        "valid_at": None,
        "invalid_at": None,
        "speech_act": "assertion",
        "assertion_status": "asserted",
        "figurative_type": "literal",
        "alternatives": [],
        "interpretation_reason": "消息以确定语气表达一个关系主张。",
    }


class PayloadRuntime:
    """按窗口目标消息返回一条可自动采纳的事实。"""

    def extract(self, window) -> tuple:
        message_id = (
            window.target_message_ids[0]
            if window.target_message_ids
            else window.messages[0].message_id
        )
        return (_payload(message_id),)


class FailingAdjudicationRuntime:
    """写入裁决调用失败的确定性替身。"""

    def __init__(self, error: Exception) -> None:
        self.error = error

    def adjudicate(self, *, candidate_text, similar):
        raise self.error


class RecordingMemoryPort:
    def __init__(self) -> None:
        self.calls = []

    def list_confirmed(self, scope):
        return ()

    def deleted_texts(self, scope):
        return ()

    def create_candidate(self, candidate):
        self.calls.append(("candidate", candidate.text))
        return candidate

    def confirm(self, *, scope, candidate_id, adoption_method=None):
        self.calls.append(("confirm", str(candidate_id)))

    def invalidate(self, *, scope, memory_id):
        self.calls.append(("invalidate", str(memory_id)))


class SimilarMemoryPort(RecordingMemoryPort):
    """返回一条与候选相似的联系人记忆，触发写入裁决。"""

    def __init__(self, memory: ConfirmedMemory) -> None:
        super().__init__()
        self.memory = memory

    def list_confirmed(self, scope):
        return (self.memory,)


class RecordingOwnerPort(RecordingMemoryPort):
    def list_active(self, owner_id):
        return ()

    def delete(self, owner_id, memory_id):
        self.calls.append(("owner_delete", str(memory_id)))

    def invalidate(self, owner_id, memory_id):
        self.calls.append(("owner_invalidate", str(memory_id)))

    def deleted_texts(self, owner_id):
        return ()

    def create(self, memory):
        self.calls.append(("owner_create", memory.text))


class RecordingWatermark:
    def __init__(self) -> None:
        self.values = []
        self.failure: ExtractionFailureState | None = None
        self.skips = []

    def get(self, scope):
        return self.values[-1] if self.values else None

    def set(self, scope, message_id):
        self.values.append(message_id)
        self.failure = None

    def get_failure(self, scope):
        return self.failure

    def save_failure(self, scope, state):
        self.failure = state

    def mark_skipped(self, scope, failure_range):
        self.values.append(failure_range.to_message_id)
        self.failure = None
        self.skips.append(failure_range)


class RunExtractionTest(unittest.TestCase):
    """只用合成窗口与空候选；不调用真实模型。"""

    def setUp(self) -> None:
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        self.memory_port = RecordingMemoryPort()
        self.owner_port = RecordingOwnerPort()
        self.watermark = RecordingWatermark()

    def test_full_run_batches_and_watermark(self) -> None:
        messages = _messages(7)

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=NullRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 3)
        self.assertEqual(stats.failed_batches, 0)
        self.assertEqual(self.watermark.values[-1], messages[-1].message_id)
        self.assertEqual(len(self.watermark.values), 3)

    def test_incremental_run_resumes_from_watermark(self) -> None:
        messages = _messages(7)

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=messages[4].message_id,
            runtime=NullRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 1)
        self.assertEqual(self.watermark.values[-1], messages[-1].message_id)

    def test_watermark_absent_message_runs_full(self) -> None:
        messages = _messages(3)

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=uuid4(),
            runtime=NullRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 1)

    def test_failed_batch_is_counted_without_advancing_watermark(self) -> None:
        messages = _messages(6)

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=FailingRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 1)
        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.adopted, 0)
        self.assertEqual(self.watermark.values, [])

    def test_model_window_has_bounded_context_and_explicit_targets(self) -> None:
        messages = _messages(45)
        runtime = RecordingWindowRuntime()

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=runtime,
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            batch_size=20,
        )

        self.assertEqual(stats.batches, 3)
        self.assertEqual(len(runtime.windows), 3)
        for window in runtime.windows:
            self.assertLessEqual(len(window.messages), 60)
            self.assertGreaterEqual(len(window.target_message_ids), 1)
            self.assertTrue(
                window.target_message_id_set <= window.message_id_set
            )

    def test_context_side_cannot_exceed_twenty_messages(self) -> None:
        with self.assertRaises(ValueError):
            run_extraction(
                scope=self.scope,
                messages=_messages(1),
                watermark_message_id=None,
                runtime=NullRuntime(),
                memory_port=self.memory_port,
                owner_memory_port=self.owner_port,
                context_before=21,
            )

    def test_invalid_output_below_threshold_stops_without_advancing(self) -> None:
        messages = _messages(6)

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=InvalidOutputRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 1)
        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.skipped_batches, 0)
        self.assertEqual(stats.skipped_ranges, ())
        self.assertEqual(self.watermark.values, [])
        self.assertIsNotNone(self.watermark.failure)
        self.assertEqual(self.watermark.failure.count, 1)
        self.assertEqual(
            self.watermark.failure.failure_range,
            FailureRange(
                from_message_id=messages[0].message_id,
                to_message_id=messages[2].message_id,
                code=ExtractionFailureKind.INVALID_OUTPUT,
            ),
        )

    def test_invalid_output_skips_after_three_same_range_failures(self) -> None:
        messages = _messages(6)
        self.watermark.failure = ExtractionFailureState(
            count=2,
            failure_range=FailureRange(
                from_message_id=messages[0].message_id,
                to_message_id=messages[2].message_id,
                code=ExtractionFailureKind.INVALID_OUTPUT,
            ),
        )
        runtime = ScriptedRuntime(
            [
                ExtractionInvalidOutputError("模型未返回可解析的结构化事实。"),
                (),
            ]
        )

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=runtime,
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 2)
        self.assertEqual(stats.failed_batches, 0)
        self.assertEqual(stats.skipped_batches, 1)
        self.assertEqual(stats.processed_messages, 6)
        self.assertEqual(len(stats.skipped_ranges), 1)
        self.assertEqual(
            stats.skipped_ranges[0],
            FailureRange(
                from_message_id=messages[0].message_id,
                to_message_id=messages[2].message_id,
                code=ExtractionFailureKind.INVALID_OUTPUT,
            ),
        )
        self.assertEqual(
            self.watermark.skips,
            [
                FailureRange(
                    from_message_id=messages[0].message_id,
                    to_message_id=messages[2].message_id,
                    code=ExtractionFailureKind.INVALID_OUTPUT,
                )
            ],
        )
        self.assertEqual(
            self.watermark.values,
            [messages[2].message_id, messages[5].message_id],
        )
        self.assertIsNone(self.watermark.failure)

    def test_unavailable_failure_never_counts_or_skips(self) -> None:
        messages = _messages(6)
        previous = ExtractionFailureState(
            count=2,
            failure_range=FailureRange(
                from_message_id=messages[0].message_id,
                to_message_id=messages[2].message_id,
                code=ExtractionFailureKind.INVALID_OUTPUT,
            ),
        )
        self.watermark.failure = previous

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=FailingRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 1)
        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.skipped_batches, 0)
        self.assertEqual(self.watermark.values, [])
        self.assertEqual(self.watermark.skips, [])
        self.assertIs(self.watermark.failure, previous)

    def test_shifted_range_with_same_code_reaches_skip_threshold(self) -> None:
        # 已计数的失败区间在 batch_size 或消息集合变化后端点漂移：
        # 同分类仍连续计数并达阈值跳过，不再因端点漂移永远卡在重试。
        messages = _messages(6)
        self.watermark.failure = ExtractionFailureState(
            count=2,
            failure_range=FailureRange(
                from_message_id=uuid4(),
                to_message_id=uuid4(),
                code=ExtractionFailureKind.INVALID_OUTPUT,
            ),
        )

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=InvalidOutputRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            batch_size=3,
        )

        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.skipped_batches, 1)
        # 第一个坏批次达阈值被跳过；运行继续到第二个批次（新计数）失败后停止。
        self.assertEqual(self.watermark.failure.count, 1)
        self.assertEqual(self.watermark.skips[-1].to_message_id, messages[2].message_id)

    def test_unavailable_failure_does_not_count_or_skip(self) -> None:
        messages = _messages(3)
        self.watermark.failure = ExtractionFailureState(
            count=2,
            failure_range=FailureRange(
                from_message_id=uuid4(),
                to_message_id=uuid4(),
                code=ExtractionFailureKind.UNAVAILABLE,
            ),
        )

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=UnavailableRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            batch_size=3,
        )

        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.skipped_batches, 0)
        # 不可用属于环境问题：不参与计数，已有的 INVALID_OUTPUT 计数保留。
        self.assertEqual(self.watermark.failure.count, 2)

    def _similar_memory(self) -> ConfirmedMemory:
        return ConfirmedMemory(
            memory_id=uuid4(),
            scope=self.scope,
            text="他习惯直接打电话",
            category=MemoryCategory.COMMON_FACT,
            source_ids=(uuid4(),),
            source_candidate_id=None,
            adoption_method=AdoptionMethod.AUTO,
            topic=MemoryTopic.OTHER,
        )

    def test_adjudication_invalid_output_counts_toward_skip(self) -> None:
        messages = _messages(3)

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=PayloadRuntime(),
            memory_port=SimilarMemoryPort(self._similar_memory()),
            owner_memory_port=self.owner_port,
            adjudication_runtime=FailingAdjudicationRuntime(
                ExtractionInvalidOutputError("裁决模型未返回结构化结果。")
            ),
            watermark_port=self.watermark,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 1)
        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.skipped_batches, 0)
        self.assertEqual(self.watermark.values, [])
        self.assertIsNotNone(self.watermark.failure)
        self.assertEqual(self.watermark.failure.count, 1)
        self.assertIs(
            self.watermark.failure.failure_range.code,
            ExtractionFailureKind.INVALID_OUTPUT,
        )

    def test_adjudication_unavailable_never_counts(self) -> None:
        messages = _messages(3)

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=PayloadRuntime(),
            memory_port=SimilarMemoryPort(self._similar_memory()),
            owner_memory_port=self.owner_port,
            adjudication_runtime=FailingAdjudicationRuntime(
                ExtractionRuntimeError("裁决模型调用失败。")
            ),
            watermark_port=self.watermark,
            batch_size=3,
        )

        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.skipped_batches, 0)
        self.assertIsNone(self.watermark.failure)
        self.assertEqual(self.watermark.values, [])


if __name__ == "__main__":
    unittest.main()
