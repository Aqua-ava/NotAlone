"""记忆提取值对象与证据契约校验测试。"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from notalone.memory.models import MemoryCategory
from notalone.memory_extraction.models import (
    ExtractedFact,
    ExtractionWindow,
    FactSubject,
    MessageRef,
    MessageSender,
    MemoryTopic,
)


def _fact(**overrides: object) -> ExtractedFact:
    fields: dict[str, object] = {
        "text": "他不爱发语音，有事爱直接打电话",
        "category": MemoryCategory.PREFERENCE,
        "subject": FactSubject.CONTACT,
        "topic": MemoryTopic.OTHER,
        "source_message_ids": (uuid4(),),
        "confidence": 0.9,
        "risk_flags": (),
        "valid_at": None,
        "invalid_at": None,
    }
    fields.update(overrides)
    return ExtractedFact(**fields)


def _window(message_ids: tuple[UUID, ...]) -> ExtractionWindow:
    owner_id = uuid4()
    contact_id = uuid4()
    return ExtractionWindow(
        owner_id=owner_id,
        contact_id=contact_id,
        messages=tuple(
            MessageRef(
                message_id=message_id,
                text="合成消息",
                sender=MessageSender.CONTACT,
                occurred_at=datetime(2026, 8, 1, tzinfo=timezone.utc),
            )
            for message_id in message_ids
        ),
    )


class ExtractedFactValidationTest(unittest.TestCase):
    """提取候选必须满足最小结构不变量。"""

    def test_rejects_blank_text(self) -> None:
        with self.assertRaises(ValueError):
            _fact(text="  ")

    def test_rejects_confidence_out_of_range(self) -> None:
        with self.assertRaises(ValueError):
            _fact(confidence=1.5)

        with self.assertRaises(ValueError):
            _fact(confidence=-0.1)

    def test_rejects_empty_source_references(self) -> None:
        with self.assertRaises(ValueError):
            _fact(source_message_ids=())

    def test_rejects_invalid_validity_window(self) -> None:
        now = datetime.now(timezone.utc)
        with self.assertRaises(ValueError):
            _fact(
                valid_at=now + timedelta(days=1),
                invalid_at=now,
            )

    def test_rejects_naive_datetimes(self) -> None:
        with self.assertRaises(ValueError):
            _fact(valid_at=datetime(2026, 8, 1))


class ExtractionWindowTest(unittest.TestCase):
    """窗口必须携带联系人范围与时间正序消息。"""

    def test_rejects_empty_window(self) -> None:
        with self.assertRaises(ValueError):
            _window(())

    def test_exposes_message_id_set(self) -> None:
        ids = (uuid4(), uuid4())
        window = _window(ids)

        self.assertEqual(window.message_id_set, set(ids))


if __name__ == "__main__":
    unittest.main()
