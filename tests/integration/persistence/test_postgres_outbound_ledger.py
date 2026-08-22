"""PostgreSQL 出站台账写入与按 owner 隔离查询的集成测试。"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from uuid import UUID, uuid4

import psycopg

from notalone.ledger.models import LedgerEntry, LedgerOutcome
from notalone.persistence import OutboundLedgerPersistenceError, PostgresOutboundLedger


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)

_EXPECTED_COLUMNS = frozenset({
    "id",
    "owner_id",
    "contact_id",
    "provider",
    "model_name",
    "input_tokens",
    "output_tokens",
    "latency_ms",
    "outcome",
    "called_at",
    "created_at",
})


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


class PostgresOutboundLedgerTest(unittest.TestCase):
    """只使用合成 owner 与合成联系人范围，不触发外部模型调用。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_table = connection.execute(
                    "SELECT to_regclass('public.outbound_ledger_entry')"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest(
                "本地 PostgreSQL 测试库不可用。"
            ) from error

        if not database_name.endswith("_test"):
            raise RuntimeError(
                "集成测试只允许连接名称以 _test 结尾的数据库。"
            )
        if has_table is None:
            raise unittest.SkipTest("测试库尚未应用 010 出站台账迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.ledger = PostgresOutboundLedger(TEST_DATABASE_URL)
        self.addCleanup(self._cleanup)

    def _cleanup(self) -> None:
        self._delete_entries_of(self.owner_id)

    def test_record_round_trips_all_metadata_fields(self) -> None:
        entry = _make_entry(
            self.owner_id,
            uuid4(),
            input_tokens=321,
            output_tokens=77,
            latency_ms=1500,
            outcome=LedgerOutcome.REJECTED_BY_VALIDATION,
        )

        recorded = self.ledger.record(entry)
        listed = self.ledger.list_by_owner(self.owner_id)

        self.assertEqual(recorded, entry)
        self.assertEqual(listed, (entry,))

    def test_null_usage_fields_round_trip(self) -> None:
        entry = _make_entry(
            self.owner_id,
            uuid4(),
            input_tokens=None,
            output_tokens=None,
            latency_ms=None,
            outcome=LedgerOutcome.RUN_FAILED,
        )

        self.ledger.record(entry)

        self.assertEqual(self.ledger.list_by_owner(self.owner_id), (entry,))

    def test_list_by_owner_hides_other_owners(self) -> None:
        other_owner = uuid4()
        own_entry = _make_entry(self.owner_id, uuid4())
        other_entry = _make_entry(other_owner, uuid4())
        self.addCleanup(
            lambda: self._delete_entries_of(other_owner)
        )

        self.ledger.record(own_entry)
        self.ledger.record(other_entry)

        self.assertEqual(self.ledger.list_by_owner(self.owner_id), (own_entry,))

    def test_listing_orders_by_called_at(self) -> None:
        later = _make_entry(
            self.owner_id,
            uuid4(),
            called_at=datetime(2026, 8, 22, 13, 0, 0, tzinfo=timezone.utc),
        )
        earlier = _make_entry(
            self.owner_id,
            uuid4(),
            called_at=datetime(2026, 8, 22, 11, 0, 0, tzinfo=timezone.utc),
        )

        self.ledger.record(later)
        self.ledger.record(earlier)

        self.assertEqual(
            self.ledger.list_by_owner(self.owner_id),
            (earlier, later),
        )

    def test_record_does_not_require_existing_contact(self) -> None:
        entry = _make_entry(self.owner_id, uuid4())

        self.ledger.record(entry)

        self.assertEqual(self.ledger.list_by_owner(self.owner_id), (entry,))

    def test_entry_survives_contact_deletion(self) -> None:
        contact_id = uuid4()
        entry = _make_entry(self.owner_id, contact_id)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成用户"),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name)"
                " VALUES (%s, %s, %s)",
                (self.owner_id, contact_id, "合成联系人"),
            )
            connection.commit()
        self.addCleanup(self._delete_owner_row)
        self.ledger.record(entry)

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.contact WHERE owner_id = %s AND id = %s",
                (self.owner_id, contact_id),
            )
            connection.commit()

        self.assertEqual(self.ledger.list_by_owner(self.owner_id), (entry,))

    def test_table_has_no_content_bearing_columns(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            columns = {
                row[0]
                for row in connection.execute(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'outbound_ledger_entry'
                    """
                ).fetchall()
            }

        self.assertEqual(columns, set(_EXPECTED_COLUMNS))

    def test_database_failure_raises_ledger_error(self) -> None:
        broken = PostgresOutboundLedger("postgresql:///notalone_nonexistent_test")

        with self.assertRaises(OutboundLedgerPersistenceError):
            broken.list_by_owner(self.owner_id)

    def _delete_owner_row(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )
            connection.commit()

    @staticmethod
    def _delete_entries_of(owner_id: UUID) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.outbound_ledger_entry WHERE owner_id = %s",
                (owner_id,),
            )
            connection.commit()


if __name__ == "__main__":
    unittest.main()
