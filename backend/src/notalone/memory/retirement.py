"""生成资格与审计回看分离；只有明确发生变化的旧事实可供历史参考。"""

from notalone.memory.models import ConfirmedMemory, OwnerMemory


def is_generation_status_eligible(
    status: str, retirement_reason: str | None, *, include_historical: bool = False,
) -> bool:
    """仅判断状态资格；调用方仍需核验范围、来源和有效期。"""
    return status == "active" or (
        include_historical and status == "invalidated" and retirement_reason == "state_changed"
    )


def is_generation_eligible(
    memory: ConfirmedMemory | OwnerMemory, *, include_historical: bool = False,
) -> bool:
    return is_generation_status_eligible(
        memory.status, memory.retirement_reason, include_historical=include_historical,
    )
