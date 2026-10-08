"""记忆提取的内部错误类型。"""

from __future__ import annotations

from notalone.memory_extraction.models import ExtractionFailureKind


class MemoryExtractionError(RuntimeError):
    """记忆提取链路的基础错误。"""


class ExtractionRuntimeError(MemoryExtractionError):
    """模型调用失败或环境不可用；可重试，不参与跳过计数。"""

    @property
    def failure_kind(self) -> ExtractionFailureKind:
        return ExtractionFailureKind.UNAVAILABLE


class ExtractionInvalidOutputError(ExtractionRuntimeError):
    """模型有返回但输出不可用；同一输入会重现，参与跳过计数。"""

    @property
    def failure_kind(self) -> ExtractionFailureKind:
        return ExtractionFailureKind.INVALID_OUTPUT
