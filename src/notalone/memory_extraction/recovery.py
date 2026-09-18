"""提取失败的批次级恢复策略：同区间计数、达阈值跳过。

只有"模型有返回但输出不可用"才参与计数；模型调用失败属于环境问题，
修好后自然恢复，不应把积压消息按失败跳过。
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from notalone.memory_extraction.models import ExtractionFailureKind

DEFAULT_FAILURE_SKIP_THRESHOLD = 3


@dataclass(frozen=True, slots=True)
class FailureRange:
    """一段连续失败的批次消息区间。"""

    from_message_id: UUID
    to_message_id: UUID
    code: ExtractionFailureKind

    def __post_init__(self) -> None:
        if not isinstance(self.from_message_id, UUID) or not isinstance(
            self.to_message_id, UUID
        ):
            raise TypeError("失败区间必须是消息 UUID。")
        if not isinstance(self.code, ExtractionFailureKind):
            raise TypeError("失败码必须是受控分类。")


@dataclass(frozen=True, slots=True)
class ExtractionFailureState:
    """当前正在计数的失败区间与连续次数。"""

    count: int
    failure_range: FailureRange

    def __post_init__(self) -> None:
        if not isinstance(self.count, int) or self.count < 1:
            raise ValueError("失败计数必须从 1 开始。")
        if not isinstance(self.failure_range, FailureRange):
            raise TypeError("失败状态必须携带失败区间。")


def record_batch_failure(
    previous: ExtractionFailureState | None,
    *,
    failure_range: FailureRange,
    threshold: int = DEFAULT_FAILURE_SKIP_THRESHOLD,
) -> tuple[ExtractionFailureState, bool]:
    """返回（新的计数状态, 是否达到跳过阈值）。

    只有同一失败分类才累加计数；分类变化重新从 1 计数。批次消息集合
    变化（batch_size 调整、来源删除后排序漂移）会让同一坏批次的起止
    消息漂移，按端点匹配会让持续失败的批次永远达不到阈值。跨批次的
    误累积由"成功即清零"兜底：两次失败之间不可能有成功的批次推进
    （失败即 break，水位只在成功或跳过时前进）。
    """

    if not isinstance(failure_range, FailureRange):
        raise TypeError("失败区间结构无效。")
    if not isinstance(threshold, int) or threshold < 1:
        raise ValueError("跳过阈值必须是正整数。")
    count = (
        previous.count + 1
        if previous is not None
        and previous.failure_range.code is failure_range.code
        else 1
    )
    state = ExtractionFailureState(count=count, failure_range=failure_range)
    return state, count >= threshold
