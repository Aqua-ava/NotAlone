"""评测用例的领域类型；维度模块共用这里的定义。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from notalone.memory_extraction.pragmatics import MemoryDisposition  # noqa: F401  (重导出)


class ExpectedDestination(StrEnum):
    """评测 oracle 的期望去向；与生产口径一一对应。

    ``AUTO`` 对应「通过全部采纳门后自动写入」，``PENDING`` 对应「安静待确认」，
    ``NONE`` 对应「不生成候选」。它与 ``MemoryDisposition`` 不是同一层：后者描述
    语用分流（可否确认），期望去向还叠加了置信度、风险与按维度放行门。
    """

    AUTO = "auto"
    PENDING = "pending"
    NONE = "none"


@dataclass(frozen=True, slots=True)
class ClaimExpectation:
    """一条允许命题；正则只声明合成标注中的同义表述，不用于生产判断。"""

    subject: str
    destination: ExpectedDestination
    text_patterns: tuple[str, ...]
    expected_labels: tuple[tuple[str, str], ...] = ()
    valid_at_iso: str | None = None
    invalid_at_iso: str | None = None


@dataclass(frozen=True, slots=True)
class EvaluationCase:
    name: str
    dimension: str
    messages: tuple[tuple[str, str], ...]
    targets: tuple[int, ...]
    # 期望去向用评测层枚举；受控标签仍用领域枚举的取值字符串表达。
    expect: ExpectedDestination
    note: str = ""
    expect_subject: str | None = None
    expected_labels: tuple[tuple[str, str], ...] = ()
    expect_text_contains: tuple[str, ...] = ()
    expect_text_excludes: tuple[str, ...] = ()
    expect_valid_at: bool | None = None
    expect_invalid_at: bool | None = None
    expect_valid_at_iso: str | None = None
    expect_invalid_at_iso: str | None = None
    expected_claims: tuple[ClaimExpectation, ...] | None = None


__all__ = [
    "ClaimExpectation",
    "EvaluationCase",
    "ExpectedDestination",
    "MemoryDisposition",
]
