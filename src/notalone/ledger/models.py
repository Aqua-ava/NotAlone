"""出站台账的领域值对象。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID


class LedgerOutcome(StrEnum):
    """一次外部模型调用的结果状态。"""

    SUCCEEDED = "succeeded"
    RUN_FAILED = "run_failed"
    REJECTED_BY_VALIDATION = "rejected_by_validation"


@dataclass(frozen=True, slots=True)
class LedgerEntry:
    """一次外部模型调用的最小操作记录，只含元数据，不含正文。"""

    entry_id: UUID
    owner_id: UUID
    contact_id: UUID
    provider: str
    model_name: str
    input_tokens: int | None
    output_tokens: int | None
    latency_ms: int | None
    outcome: LedgerOutcome
    called_at: datetime

    def __post_init__(self) -> None:
        if not isinstance(self.provider, str) or not self.provider.strip():
            raise ValueError("台账供应商标识不能为空。")
        if not isinstance(self.model_name, str) or not self.model_name.strip():
            raise ValueError("台账模型名不能为空。")
        for name in ("input_tokens", "output_tokens", "latency_ms"):
            value = getattr(self, name)
            if value is not None and (not isinstance(value, int) or value < 0):
                raise ValueError(f"台账{name}必须是非负整数或空。")
        if not isinstance(self.called_at, datetime) or self.called_at.tzinfo is None:
            raise ValueError("台账调用时间必须是带时区的 datetime。")
