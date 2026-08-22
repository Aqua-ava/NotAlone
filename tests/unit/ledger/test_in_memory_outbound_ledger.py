"""出站台账进程内实现与按 owner 隔离查询测试。"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone
from uuid import UUID, uuid4

from notalone.ledger.adapters import InMemoryOutboundLedger
from notalone.ledger.models import LedgerEntry, LedgerOutcome


def _make_entry(
    owner_id: UUID, contact_id: UUID, **overrides: object
) -> LedgerEntry:
    fields: dict[str, object] = {
        "entry_id": uuid4(),
        "owner_id": owner_id,
        "contact_id": contact_id,
        "provider": "deepseek",
        "model_name": "deepseek-chat",
        "input_tokens": 120,
        "output_tokens": 48,
        "latency_ms": 900,
        "outcome": LedgerOutcome.SUCCEEDED,
        "called_at": datetime(2026, 8, 22, 12, 0, 0, tzinfo=timezone.utc),
    }
    fields.update(overrides)
    return LedgerEntry(**fields)


class InMemoryOutboundLedgerTest(unittest.TestCase):
    """只验证合成台账条目，不触发任何外部模型调用。"""

    def setUp(self) -> None:
        self.ledger = InMemoryOutboundLedger()

    def test_record_returns_persisted_entry(self) -> None:
        owner_id = uuid4()
        entry = _make_entry(owner_id, uuid4())

        recorded = self.ledger.record(entry)
        listed = self.ledger.list_by_owner(owner_id)

        self.assertEqual(recorded, entry)
        self.assertEqual(listed, (entry,))

    def test_list_by_owner_hides_other_owners(self) -> None:
        owner_a = uuid4()
        owner_b = uuid4()
        entry_a = _make_entry(owner_a, uuid4())
        entry_b = _make_entry(owner_b, uuid4())

        self.ledger.record(entry_a)
        self.ledger.record(entry_b)

        self.assertEqual(self.ledger.list_by_owner(owner_a), (entry_a,))
        self.assertEqual(self.ledger.list_by_owner(owner_b), (entry_b,))

    def test_list_by_owner_orders_by_called_at(self) -> None:
        owner_id = uuid4()
        later = _make_entry(
            owner_id,
            uuid4(),
            called_at=datetime(2026, 8, 22, 13, 0, 0, tzinfo=timezone.utc),
        )
        earlier = _make_entry(
            owner_id,
            uuid4(),
            called_at=datetime(2026, 8, 22, 11, 0, 0, tzinfo=timezone.utc),
        )

        self.ledger.record(later)
        self.ledger.record(earlier)

        self.assertEqual(self.ledger.list_by_owner(owner_id), (earlier, later))


class LedgerEntryValidationTest(unittest.TestCase):
    """台账条目必须保持最小操作记录的不变量。"""

    def test_rejects_blank_provider(self) -> None:
        with self.assertRaises(ValueError):
            _make_entry(uuid4(), uuid4(), provider="  ")

    def test_rejects_blank_model_name(self) -> None:
        with self.assertRaises(ValueError):
            _make_entry(uuid4(), uuid4(), model_name="")

    def test_rejects_negative_tokens(self) -> None:
        with self.assertRaises(ValueError):
            _make_entry(uuid4(), uuid4(), input_tokens=-1)

    def test_rejects_naive_datetime(self) -> None:
        with self.assertRaises(ValueError):
            _make_entry(
                uuid4(),
                uuid4(),
                called_at=datetime(2026, 8, 22, 12, 0, 0),
            )


if __name__ == "__main__":
    unittest.main()
