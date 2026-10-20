"""生成资格与审计回看分离；所有失效记忆仅保留展示与追溯。"""

from datetime import datetime, timezone

from notalone.memory.models import ConfirmedMemory, OwnerMemory


def is_generation_status_eligible(
    status: str, retirement_reason: str | None, *, include_historical: bool = False,
    invalid_at: datetime | None = None,
) -> bool:
    """排除已失效和已过期条目；调用方仍需核验范围、来源和生效时间。"""
    return status == "active" and (invalid_at is None or datetime.now(timezone.utc) < invalid_at)


def is_generation_eligible(
    memory: ConfirmedMemory | OwnerMemory, *, include_historical: bool = False,
) -> bool:
    return is_generation_status_eligible(
        memory.status, memory.retirement_reason, include_historical=include_historical,
        invalid_at=memory.invalid_at,
    )
