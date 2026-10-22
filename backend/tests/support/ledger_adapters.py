"""出站台账的进程内测试替身（原 `notalone.ledger.adapters`）。

生产代码 0 import，随 ticket 07 移出 `notalone` 生产包；仅测试使用。
"""

from __future__ import annotations

from uuid import UUID

from notalone.ledger.models import LedgerEntry, OutboundLedgerSummary


class InMemoryOutboundLedger:
    """按写入顺序保存台账记录，供单元测试与进程内运行使用。"""

    def __init__(self) -> None:
        self._entries: list[LedgerEntry] = []

    def record(self, entry: LedgerEntry) -> LedgerEntry:
        self._entries.append(entry)
        return entry

    def list_by_owner(
        self,
        owner_id: UUID,
        *,
        limit: int | None = None,
    ) -> tuple[LedgerEntry, ...]:
        if limit is not None and (not isinstance(limit, int) or limit <= 0):
            raise ValueError("台账窗口必须是正整数。")
        entries = sorted(
            (entry for entry in self._entries if entry.owner_id == owner_id),
            key=lambda entry: (entry.called_at, entry.entry_id),
        )
        if limit is not None:
            return tuple(entries[-limit:])
        return tuple(entries)

    def summarize_by_owner(self, owner_id: UUID) -> OutboundLedgerSummary:
        scoped = [entry for entry in self._entries if entry.owner_id == owner_id]
        provider_counts: dict[str, int] = {}
        outcome_counts: dict[str, int] = {}
        total_input = 0
        total_output = 0
        for entry in scoped:
            provider_counts[entry.provider] = provider_counts.get(entry.provider, 0) + 1
            outcome_counts[entry.outcome.value] = (
                outcome_counts.get(entry.outcome.value, 0) + 1
            )
            if entry.input_tokens is not None:
                total_input += entry.input_tokens
            if entry.output_tokens is not None:
                total_output += entry.output_tokens
        return OutboundLedgerSummary(
            total_calls=len(scoped),
            provider_counts=provider_counts,
            outcome_counts=outcome_counts,
            total_input_tokens=total_input,
            total_output_tokens=total_output,
        )
