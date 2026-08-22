"""出站台账的进程内实现。"""

from __future__ import annotations

from uuid import UUID

from notalone.ledger.models import LedgerEntry


class InMemoryOutboundLedger:
    """按写入顺序保存台账记录，供单元测试与进程内运行使用。"""

    def __init__(self) -> None:
        self._entries: list[LedgerEntry] = []

    def record(self, entry: LedgerEntry) -> LedgerEntry:
        self._entries.append(entry)
        return entry

    def list_by_owner(self, owner_id: UUID) -> tuple[LedgerEntry, ...]:
        return tuple(
            sorted(
                (entry for entry in self._entries if entry.owner_id == owner_id),
                key=lambda entry: (entry.called_at, entry.entry_id),
            )
        )
