"""提取命令核心逻辑测试：分批、水位续跑与统计聚合。"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from notalone.memory_extraction.command import run_extraction
from notalone.memory_extraction.models import MessageRef, MessageSender
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
        from notalone.memory_extraction.errors import ExtractionRuntimeError

        raise ExtractionRuntimeError("模型未返回可解析的结构化事实。")


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

    def get(self, scope):
        return self.values[-1] if self.values else None

    def set(self, scope, message_id):
        self.values.append(message_id)


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

    def test_failed_batch_is_counted_and_watermark_still_advances(self) -> None:
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

        self.assertEqual(stats.batches, 2)
        self.assertEqual(stats.failed_batches, 2)
        self.assertEqual(stats.adopted, 0)
        self.assertEqual(self.watermark.values[-1], messages[-1].message_id)


if __name__ == "__main__":
    unittest.main()
