"""出站台账的业务边界。"""

from __future__ import annotations

from typing import Protocol
from uuid import UUID

from notalone.ledger.models import LedgerEntry, OutboundLedgerSummary


class OutboundLedgerPort(Protocol):
    """记录与查询外部模型调用的最小操作记录。"""

    def record(self, entry: LedgerEntry) -> LedgerEntry:
        """保存一条台账记录。"""

    def list_by_owner(
        self,
        owner_id: UUID,
        *,
        limit: int | None = None,
    ) -> tuple[LedgerEntry, ...]:
        """返回某位用户名下的台账记录，按调用时间排列。

        `limit` 给定时只返回最近若干条，避免把整张台账表读进内存。
        """

    def summarize_by_owner(self, owner_id: UUID) -> OutboundLedgerSummary:
        """在存储侧聚合计数与 token 合计，避免全量拉取。"""
