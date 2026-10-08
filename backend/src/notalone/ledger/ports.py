"""出站台账的业务边界。"""

from __future__ import annotations

from typing import Protocol
from uuid import UUID

from notalone.ledger.models import LedgerEntry


class OutboundLedgerPort(Protocol):
    """记录与查询外部模型调用的最小操作记录。"""

    def record(self, entry: LedgerEntry) -> LedgerEntry:
        """保存一条台账记录。"""

    def list_by_owner(self, owner_id: UUID) -> tuple[LedgerEntry, ...]:
        """返回某位用户名下的全部台账记录，按调用时间排列。"""
