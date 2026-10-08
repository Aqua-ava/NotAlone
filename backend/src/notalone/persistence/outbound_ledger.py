"""出站台账的 PostgreSQL 适配器。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from notalone.ledger.models import LedgerEntry, LedgerOutcome


_LEDGER_UNAVAILABLE = "出站台账不可用。"

_INSERT_SQL = """
INSERT INTO public.outbound_ledger_entry (
    id, owner_id, contact_id, provider, model_name,
    input_tokens, output_tokens, latency_ms, outcome, called_at
) VALUES (
    %(entry_id)s, %(owner_id)s, %(contact_id)s, %(provider)s, %(model_name)s,
    %(input_tokens)s, %(output_tokens)s, %(latency_ms)s, %(outcome)s, %(called_at)s
)
"""

_SELECT_SQL = """
SELECT id AS entry_id,
       owner_id,
       contact_id,
       provider,
       model_name,
       input_tokens,
       output_tokens,
       latency_ms,
       outcome,
       called_at
FROM public.outbound_ledger_entry
WHERE owner_id = %s
ORDER BY called_at, id
"""


class OutboundLedgerPersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或台账内容的持久化错误。"""


class PostgresOutboundLedger:
    """写入外部模型调用台账并按 owner 隔离查询。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def record(self, entry: LedgerEntry) -> LedgerEntry:
        """保存一条台账记录；调用方负责已验证的联系人范围。"""

        try:
            with self._connect() as connection:
                connection.execute(
                    _INSERT_SQL,
                    {
                        "entry_id": entry.entry_id,
                        "owner_id": entry.owner_id,
                        "contact_id": entry.contact_id,
                        "provider": entry.provider,
                        "model_name": entry.model_name,
                        "input_tokens": entry.input_tokens,
                        "output_tokens": entry.output_tokens,
                        "latency_ms": entry.latency_ms,
                        "outcome": entry.outcome.value,
                        "called_at": entry.called_at,
                    },
                )
                connection.commit()
        except Exception as error:
            raise OutboundLedgerPersistenceError(_LEDGER_UNAVAILABLE) from error
        return entry

    def list_by_owner(self, owner_id: UUID) -> tuple[LedgerEntry, ...]:
        """返回某位用户名下的台账记录，按调用时间排列。"""

        try:
            with self._connect() as connection:
                rows = connection.execute(_SELECT_SQL, (owner_id,)).fetchall()
        except Exception as error:
            raise OutboundLedgerPersistenceError(_LEDGER_UNAVAILABLE) from error
        return tuple(_row_to_entry(row) for row in rows)

    def _connect(self) -> psycopg.Connection[Any]:
        return psycopg.connect(self._database_url, row_factory=dict_row)


def _row_to_entry(row: dict[str, Any]) -> LedgerEntry:
    return LedgerEntry(
        entry_id=row["entry_id"],
        owner_id=row["owner_id"],
        contact_id=row["contact_id"],
        provider=row["provider"],
        model_name=row["model_name"],
        input_tokens=row["input_tokens"],
        output_tokens=row["output_tokens"],
        latency_ms=row["latency_ms"],
        outcome=LedgerOutcome(row["outcome"]),
        called_at=row["called_at"],
    )
