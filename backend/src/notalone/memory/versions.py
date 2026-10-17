"""自动替代必须针对实际裁决读取的原版本，不能追随新的人工版本。"""

from dataclasses import replace

from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.memory.models import (
    AdoptionMethod, ConfirmedMemory, ConfirmedMemoryStatus, OwnerMemory,
)


class MemoryVersionConflict(RuntimeError):
    """版本、来源或用户决定已变化，旧提案不能继续应用。"""


def require_auto_previous(
    actual: ConfirmedMemory | OwnerMemory,
    expected: ConfirmedMemory | OwnerMemory,
    *, allow_manual: bool = False,
) -> None:
    """写入事务中复验原 ID、来源、修订与人工决定。"""
    fields = (
        "memory_id", "text", "category", "topic", "source_ids",
        "source_candidate_id", "adoption_method", "revision", "valid_at",
        "invalid_at", "confidence", "risk_flags", "supersedes_memory_id", "event",
    )
    if (type(actual) is not type(expected)
            or actual.status is not ConfirmedMemoryStatus.ACTIVE
            or expected.status is not ConfirmedMemoryStatus.ACTIVE
            or (not allow_manual and actual.adoption_method is not AdoptionMethod.AUTO)
            or any(getattr(actual, field) != getattr(expected, field) for field in fields)):
        raise MemoryCorrectionConflictError("原资料或人工决定已变化，自动替代未应用。")
    if isinstance(actual, ConfirmedMemory):
        same_scope = actual.scope == expected.scope
    else:
        same_scope = actual.owner_id == expected.owner_id
    if not same_scope:
        raise MemoryCorrectionConflictError("资料范围已变化，自动替代未应用。")


def require_version_receipt(
    actual: ConfirmedMemory | OwnerMemory,
    expected_previous: ConfirmedMemory | OwnerMemory | None,
    adoption_method: AdoptionMethod,
) -> None:
    """人工重试也只能重放同一次替代与原采纳身份。"""
    if (actual.adoption_method is not adoption_method
            or actual.status is not ConfirmedMemoryStatus.ACTIVE
            or actual.supersedes_memory_id != (
                expected_previous.memory_id if expected_previous else None
            )
            or actual.revision != (
                expected_previous.revision + 1 if expected_previous else 1
            )):
        raise MemoryVersionConflict("候选已经由其他决定处理，本次版本操作未应用。")


def require_auto_update_receipt(
    actual: ConfirmedMemory | OwnerMemory,
    expected_previous: ConfirmedMemory | OwnerMemory,
) -> None:
    """重试只认可同一替代的有效自动回执，不重新失效原 ID。"""
    if (type(actual) is not type(expected_previous)
            or actual.adoption_method is not AdoptionMethod.AUTO
            or actual.status is not ConfirmedMemoryStatus.ACTIVE
            or actual.supersedes_memory_id != expected_previous.memory_id
            or actual.revision != expected_previous.revision + 1):
        raise MemoryCorrectionConflictError("候选已由其他决定处理，自动替代未应用。")
    same_scope = (
        actual.scope == expected_previous.scope
        if isinstance(actual, ConfirmedMemory)
        else actual.owner_id == expected_previous.owner_id
    )
    if not same_scope:
        raise MemoryCorrectionConflictError("资料范围已变化，自动替代未应用。")


def require_auto_update_previous(
    actual_previous: ConfirmedMemory | OwnerMemory,
    expected_previous: ConfirmedMemory | OwnerMemory,
    *, allow_manual: bool = False,
) -> None:
    """已提交回执仍须对应原行的一次失效，不能跳过原版本身份。"""
    if (actual_previous.status is not ConfirmedMemoryStatus.INVALIDATED
            or actual_previous.revision != expected_previous.revision + 1
            or (expected_previous.invalid_at is not None
                and actual_previous.invalid_at != expected_previous.invalid_at)):
        raise MemoryCorrectionConflictError("原版本状态已变化，自动替代回执不可复用。")
    require_auto_previous(
        replace(actual_previous, status=ConfirmedMemoryStatus.ACTIVE,
                revision=expected_previous.revision, invalid_at=expected_previous.invalid_at),
        expected_previous, allow_manual=allow_manual,
    )
