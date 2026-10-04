"""出站台账的 PostgreSQL 适配器。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from notalone.ledger.models import (
    LedgerEntry,
    LedgerOutcome,
    OutboundLedgerSummary,
)


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

_SELECT_COLUMNS = """
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
"""

_SELECT_SQL = _SELECT_COLUMNS + "ORDER BY called_at, id"

_SELECT_RECENT_SQL = (
    "SELECT entry_id, owner_id, contact_id, provider, model_name,"
    " input_tokens, output_tokens, latency_ms, outcome, called_at FROM ("
    + _SELECT_COLUMNS
    + " ORDER BY called_at DESC, id DESC LIMIT %s"
    + ") AS recent ORDER BY called_at, entry_id"
)

_SUMMARY_SQL = """
SELECT provider,
       outcome,
       count(*) AS call_count,
       coalesce(sum(input_tokens), 0) AS input_tokens,
       coalesce(sum(output_tokens), 0) AS output_tokens
FROM public.outbound_ledger_entry
WHERE owner_id = %s
GROUP BY provider, outcome
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

    def list_by_owner(
        self,
        owner_id: UUID,
        *,
        limit: int | None = None,
    ) -> tuple[LedgerEntry, ...]:
        """返回某位用户名下的台账记录，按调用时间排列。

        `limit` 给定时只取最近若干条：概览只需要一个窗口，
        全量拉取会随使用时间线性增长。
        """

        if limit is not None and (not isinstance(limit, int) or limit <= 0):
            raise ValueError("台账窗口必须是正整数。")
        sql = _SELECT_SQL
        parameters: tuple[Any, ...] = (owner_id,)
        if limit is not None:
            sql = _SELECT_RECENT_SQL
            parameters = (owner_id, limit)
        try:
            with self._connect() as connection:
                rows = connection.execute(sql, parameters).fetchall()
        except Exception as error:
            raise OutboundLedgerPersistenceError(_LEDGER_UNAVAILABLE) from error
        return tuple(_row_to_entry(row) for row in rows)

    def summarize_by_owner(self, owner_id: UUID) -> OutboundLedgerSummary:
        """在 SQL 侧聚合概览，避免把整张台账表读进进程内存。"""

        try:
            with self._connect() as connection:
                rows = connection.execute(_SUMMARY_SQL, (owner_id,)).fetchall()
        except Exception as error:
            raise OutboundLedgerPersistenceError(_LEDGER_UNAVAILABLE) from error
        provider_counts: dict[str, int] = {}
        outcome_counts: dict[str, int] = {}
        total_input = 0
        total_output = 0
        total_calls = 0
        for row in rows:
            count = int(row["call_count"])
            total_calls += count
            provider_counts[str(row["provider"])] = (
                provider_counts.get(str(row["provider"]), 0) + count
            )
            outcome = str(row["outcome"])
            outcome_counts[outcome] = outcome_counts.get(outcome, 0) + count
            total_input += int(row["input_tokens"])
            total_output += int(row["output_tokens"])
        return OutboundLedgerSummary(
            total_calls=total_calls,
            provider_counts=provider_counts,
            outcome_counts=outcome_counts,
            total_input_tokens=total_input,
            total_output_tokens=total_output,
        )

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
