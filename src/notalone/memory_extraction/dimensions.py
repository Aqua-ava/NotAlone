"""记忆候选的维度判定键与按维度放行表。

本模块把一条 :class:`~notalone.memory_extraction.models.ExtractedFact`
映射到评测维度名（ADR-027、ADR-036），并给出"哪些维度允许自动采纳"的
放行表。判定只用提取结果里的受控字段，不调用模型、不按句子特判。

规则表（自上而下，先命中先返回）：

1. 带生效或失效时间 → ``time``。有效期是结构化字段，可以逐条判定；
   该维度的放行只影响带时间边界、且已通过语用与风险门槛的候选。
2. ``speech_act = assertion`` 且 ``assertion_status = asserted``（已确认
   语气明确的陈述）、且没有时间边界、且主体是 ``self`` 或 ``contact``
   → ``subject``。主体归属是结构化字段。
3. 其余"已确认陈述"（``assertion`` + ``asserted``，但没有时间边界，
   且不是 self/contact 主体）→ ``truth_intent``。它们同样只用受控字段
   判定，只是不再有可判定的主体归属，因此不落入 ``subject``。
4. 以上都不成立 → ``None``。包括 ``speech_act = unknown``、
   ``assertion_status = unknown``，以及 ``plan``、``report``、``question``、
   ``request``、``correction`` 和 ``hypothetical``、``conditional``、
   ``reported`` 这些未确认陈述。``None`` 表示"当前字段不足以判定该候选
   属于哪个评测维度"，按 fail-closed 一律视为未放行。

当前**不可推导**的评测维度（因此这些维度即使日后达标也不可能被放行，
不要用兜底规则假装可推导，也不要按句子特判）：

- ``paraphrase``：改写保真取决于原始来源正文，而
  :class:`~notalone.memory_extraction.models.ExtractedFact` 只引用来源
  消息 ID、不携带来源正文，也没有保真字段。
- ``reference``：指代消解是否正确取决于候选正文与被引用消息的对齐，
  提取结果里没有指代目标或引用关系字段。
- ``media``：媒体占位取决于来源消息类型，而提取结果只有消息 ID，
  没有来源消息类型字段。
- ``reported``：评测里的"第三方转述"维度与 ``truth_intent`` 的
  ``reported`` 断言状态重叠，而运行时没有独立的转述来源字段，因此不
  单独放行；带 ``assertion_status = reported`` 的候选一律返回 ``None``。

放行表默认**空集**（:data:`DEFAULT_DIMENSION_RELEASE`），因此未放行维度一律
安静待确认；运维回退把 ``NOTALONE_MEMORY_DIMENSION_GATE`` 显式设为 ``0``，
关闭这道门即恢复"通过原有三道门槛即自动采纳"的行为，见
:data:`RELEASE_ALL_DIMENSIONS`。
"""

from __future__ import annotations

import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import cast

from notalone.memory.models import FactSubject
from notalone.memory_extraction.models import (
    AssertionStatus,
    ExtractedFact,
    SpeechAct,
)

__all__ = [
    "DEFAULT_DIMENSION_RELEASE",
    "DIMENSION_GATE_VARIABLE",
    "RELEASE_ALL_DIMENSIONS",
    "DimensionRelease",
    "MemoryDimension",
    "dimension_key",
]


DIMENSION_GATE_VARIABLE = "NOTALONE_MEMORY_DIMENSION_GATE"


class MemoryDimension(StrEnum):
    """与评测维度名对齐的运行时维度键。"""

    SUBJECT = "subject"
    PARAPHRASE = "paraphrase"
    TRUTH_INTENT = "truth_intent"
    TIME = "time"
    REFERENCE = "reference"
    MEDIA = "media"
    REPORTED = "reported"


#: 放行表里的 `subject` 只覆盖有可判定主体归属的确认陈述。
_SUBJECT_DIMENSION_SUBJECTS = frozenset(
    {FactSubject.SELF, FactSubject.CONTACT}
)
#: 关闭按维度放行门时生效的全量维度名。
_ALL_DIMENSION_NAMES = frozenset(item.value for item in MemoryDimension)


def dimension_key(fact: ExtractedFact) -> MemoryDimension | None:
    """把一条候选映射到维度键；无法明确判定时返回 ``None``。"""

    if not isinstance(fact, ExtractedFact):
        raise TypeError("维度判定输入必须是 ExtractedFact。")
    if fact.valid_at is not None or fact.invalid_at is not None:
        return MemoryDimension.TIME
    if (
        fact.speech_act is SpeechAct.ASSERTION
        and fact.assertion_status is AssertionStatus.ASSERTED
    ):
        if fact.subject in _SUBJECT_DIMENSION_SUBJECTS:
            return MemoryDimension.SUBJECT
        return MemoryDimension.TRUTH_INTENT
    return None


@dataclass(frozen=True, slots=True)
class DimensionRelease:
    """允许自动采纳的维度集合；默认空集，未放行维度安静待确认。

    ``gate_enabled`` 记录这道门是否生效；``allowed`` 是显式放行的维度，
    默认空集。两者合起来的放行集是 :meth:`released`：

    - 门开启（默认）：只有 ``allowed`` 里的维度允许自动采纳。
    - 门关闭（运维回退，``NOTALONE_MEMORY_DIMENSION_GATE=0``）：不按维度
      收紧，恢复今天"通过原有三道门槛即自动采纳"的行为。
    """

    allowed: frozenset[str] = field(default_factory=frozenset)
    gate_enabled: bool = True

    def __post_init__(self) -> None:
        if type(self.gate_enabled) is not bool:
            raise TypeError("维度放行开关必须是 bool。")
        # 构造参数允许直接写 ("subject",) 这类可迭代对象，便于测试与放行台账；
        # 规范化只做一次，之后 frozen dataclass 里的 `allowed` 恒为 frozenset。
        allowed = self.allowed
        if not isinstance(allowed, frozenset):
            allowed = frozenset(cast(Iterable[str], allowed))
            object.__setattr__(self, "allowed", allowed)
        known = {item.value for item in MemoryDimension}
        unknown = sorted(allowed - known)
        if unknown:
            raise ValueError(f"未知记忆维度：{unknown}。")

    @property
    def released(self) -> frozenset[str]:
        """实际生效的放行集；门关闭时不按维度收紧。"""

        if not self.gate_enabled:
            return _ALL_DIMENSION_NAMES
        return self.allowed

    def allows(self, fact: ExtractedFact) -> bool:
        """只有明确判定且已放行的维度允许进入自动采纳。"""

        key = dimension_key(fact)
        return key is not None and key.value in self.released

    @classmethod
    def from_environment(
        cls, environ: Mapping[str, str] | None = None
    ) -> "DimensionRelease":
        """读取运维开关；只有显式 ``=0`` 才关闭按维度放行门。"""

        values = os.environ if environ is None else environ
        gate_enabled = (
            values.get(DIMENSION_GATE_VARIABLE, "").strip() != "0"
        )
        return cls(gate_enabled=gate_enabled)


#: 默认放行表：空集。任何维度未放行都走既有待确认路径。
DEFAULT_DIMENSION_RELEASE = DimensionRelease()
#: 运维回退：不再按维度收紧，等价于启用本门之前的自动采纳行为。
RELEASE_ALL_DIMENSIONS = DimensionRelease(gate_enabled=False)
