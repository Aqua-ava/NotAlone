"""记忆候选的相关维度合取与按维度放行表。

本模块把一条 :class:`~notalone.memory_extraction.models.ExtractedFact`
映射到评测维度名（ADR-027、ADR-036），并给出"哪些维度允许自动采纳"的
放行表。判定只用提取结果里的受控字段，不调用模型、不按句子特判。

下列单键规则仅保留为旧诊断接口；实际门使用所有相关维度的合取：

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

四类定位字段保存为版本化依据。v1保真仍用完整逐字对齐；显式proof入口只在
获批有限全文语法、实际来源及所有角色关系重核通过后承认新增语义依据，
超范围保持未知。指代和转述始终留在相关集合，不凭缺字段排除；版本2/3还保守
加入time，即使H日期为空。这不是精确相关性分类器，不能据此认定模型质量。

默认运行策略使用同次独立来源核验回执，不要求先获全局逐维评测资格，也不
将supported伪装成有限语义proof。显式DimensionRelease仍采用原逐维策略；
旧运维回退NOTALONE_MEMORY_DIMENSION_GATE=0只关闭逐维白名单，带
verified_sources的装配仍要求同次来源核验回执（ADR-097）。
"""

from __future__ import annotations

import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from datetime import datetime, timezone
from typing import cast

from notalone.memory.models import FactSubject, MemoryCategory, SourceDependencyMode
from notalone.memory.evidence_binding import (
    candidate_digest, content_digest, fact_pragmatics,
)
from notalone.scopes import ContactScope
from notalone.memory_extraction.models import (
    AssertionStatus,
    ExtractedFact,
    SpeechAct,
    FigurativeType,
)

__all__ = [
    "DEFAULT_DIMENSION_RELEASE",
    "DIMENSION_GATE_VARIABLE",
    "RELEASE_ALL_DIMENSIONS",
    "DimensionRelease",
    "MemoryDimension",
    "dimension_key",
    "required_dimensions",
    "valid_evidence_dimensions",
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


def required_dimensions(fact: ExtractedFact) -> frozenset[str]:
    """返回只收紧的保守超集；缺提案不能排除指代、转述或proof时间关系。"""

    if not isinstance(fact, ExtractedFact):
        raise TypeError("维度判定输入必须是 ExtractedFact。")
    required = {"subject", "truth_intent", "paraphrase", "reference", "reported"}
    if (
        fact.valid_at is not None or fact.invalid_at is not None
        or fact.category is MemoryCategory.RECENT_STATE
    ):
        required.add("time")
    evidence = fact.dimension_evidence
    if fact.source_dependency_mode is SourceDependencyMode.ALL and evidence is None:
        return _ALL_DIMENSION_NAMES
    if evidence is not None and evidence.version in {2, 3, 4}:
        # proof版本不能因H日期为空或提案未知省掉潜在时间关系；保守集合只增加。
        required.add("time")
    if evidence is None or any(
        item.message_type != "text" or item.text_representation != "text"
        for item in evidence.messages
        if item.message_id in fact.source_message_ids
    ) or any(item.representation != "text" for item in evidence.media or ()):
        required.add("media")
    return frozenset(required)


def valid_evidence_dimensions(
    fact: ExtractedFact, *, now: datetime | None = None,
) -> frozenset[str]:
    """只报告当前来源与完整定位通过的项；不是语义正确性或放行表。"""

    evidence = fact.dimension_evidence
    if (
        evidence is None or not evidence.source_bound
        or (evidence.version == 4) != (fact.source_dependency_mode is SourceDependencyMode.ALL)
        or evidence.candidate_sha256 != candidate_digest(fact, version=evidence.version)
        or evidence.pragmatics != fact_pragmatics(fact)
    ):
        return frozenset()
    at = datetime.now(timezone.utc) if now is None else now
    if at.tzinfo is None or at.utcoffset() is None:
        raise ValueError("维度依据核验时间必须带时区。")
    if fact.invalid_at is not None and fact.invalid_at <= at:
        return frozenset()
    valid: set[str] = set()
    if (
        fact.speech_act is SpeechAct.ASSERTION
        and fact.assertion_status is AssertionStatus.ASSERTED
        and fact.figurative_type is FigurativeType.LITERAL
        and not fact.alternatives
    ):
        valid.add("truth_intent")
    if evidence.version != 4 and fact.invalid_at is not None and all(
        item.occurred_at is not None for item in evidence.messages
        if item.message_id in fact.source_message_ids
    ):
        valid.add("time")
    messages = {item.message_id: item for item in evidence.messages}
    alignments = evidence.paraphrase or ()
    if (
        alignments
        and {item.source.message_id for item in alignments}
        == set(fact.source_message_ids)
        and all(
            item.candidate.start == 0 and item.candidate.end == len(fact.text)
            and item.source.span.start == 0
            and item.source.span.end
            == messages[item.source.message_id].text_length
            and item.candidate.sha256 == item.source.span.sha256
            == content_digest(fact.text)
            for item in alignments
        )
    ):
        valid.add("paraphrase")
    references = evidence.reference or ()
    targets = {
        (item.target.message_id, item.target.span.start, item.target.span.end)
        for item in references
    }
    subject_matches = (
        {messages[item.target.message_id].sender for item in references}
        == {"self", "contact"}
        if fact.subject is FactSubject.SHARED else all(
            messages[item.target.message_id].sender == fact.subject.value
            for item in references
        )
    )
    if (
        evidence.version == 1 and references and not fact.alternatives
        and all(item.subject == fact.subject.value for item in references)
        and subject_matches
        and len(targets) == (2 if fact.subject is FactSubject.SHARED else 1)
    ):
        valid.update({"reference", "subject"})
    reported = evidence.reported or ()
    relationship = (
        "reported" if fact.speech_act is SpeechAct.REPORT
        or fact.assertion_status is AssertionStatus.REPORTED else "direct"
    )
    if (
        evidence.version == 1 and reported
        and all(item.relationship == relationship for item in reported)
    ):
        valid.add("reported")
    if evidence.version == 2 and evidence.semantic_basis is not None:
        # v2由绑定器对实际全文重解析后才source_bound；不借v1锚点数量签新关系。
        valid.update({"paraphrase", "reference", "subject", "reported"})
        if any(
            item["kind"] == "time"
            for item in evidence.semantic_basis.to_payload()["qualifiers"]
        ):
            valid.add("time")
    if evidence.version == 3 and evidence.semantic_basis is not None:
        # 此版本仅接受完整到达图；每项能力按独立合同贡献，不借旧v2全量映射。
        capability_dimensions = {
            "author_binding": "subject", "arrival_event_preservation": "paraphrase",
            "author_self_reference": "reference", "direct_attribution": "reported",
            "recency_preservation": "time",
        }
        for capability in evidence.semantic_basis.to_payload()["capabilities"]:
            valid.add(capability_dimensions[capability])
    if evidence.version == 4 and evidence.semantic_basis is not None and not fact.alternatives:
        from notalone.memory.bounded_evidence import CAPABILITY_DIMENSIONS
        valid.update(CAPABILITY_DIMENSIONS[item] for item in evidence.semantic_basis.to_payload()["capabilities"])
    media = evidence.media or ()
    if {item.message_id for item in media} == set(fact.source_message_ids) and all(
        item.representation == (
            "text" if item.message_type == "text" else "processed_text"
        )
        and item.representation == messages[item.message_id].text_representation
        and (evidence.version != 4 or item.message_type == "text" and item.representation == "text")
        for item in media
    ):
        valid.add("media")
    return frozenset(valid)


def _verified_current_sources(
    fact: ExtractedFact, *, scope: ContactScope | None, now: datetime | None,
) -> bool:
    """默认采纳仅承认本次独立核验回执和仍绑定的原始来源，不认证逐维评测。"""
    evidence = fact.dimension_evidence
    if (evidence is None or not evidence.source_bound or evidence.version != 1
            or scope is None or evidence.scope != scope
            or fact.verified_source_receipt != (evidence.candidate_sha256, evidence.window_sha256,
                fact.source_dependency_mode.value, fact.requires_all_sources)
            or evidence.candidate_sha256 != candidate_digest(fact)
            or evidence.pragmatics != fact_pragmatics(fact)
            or not set(fact.source_message_ids) <= {item.message_id for item in evidence.messages}):
        return False
    at = now or datetime.now(timezone.utc)
    return fact.invalid_at is None or fact.invalid_at > at


@dataclass(frozen=True, slots=True)
class DimensionRelease:
    """自动采纳来源策略；显式构造保留逐维门，生产默认要求同次核验回执。

    ``gate_enabled`` 记录这道门是否生效；``allowed`` 是显式放行的维度，
    默认空集。两者合起来的放行集是 :meth:`released`：

    - ``verified_sources`` 开启（默认）：只认同次来源核验回执，逐维放行表
      不参与准入；``gate_enabled`` 不改变这条路径。
    - 显式历史协议（``verified_sources=False``）：门开启时只有 ``allowed``
      里的维度允许自动采纳；门关闭（运维回退
      ``NOTALONE_MEMORY_DIMENSION_GATE=0``）只关闭逐维白名单，恢复本门启用前
      的维度策略（ADR-097，替代 ADR-036 第 5 条的三道门槛描述）。
    """

    allowed: frozenset[str] = field(default_factory=frozenset)
    gate_enabled: bool = True
    verified_sources: bool = False

    def __post_init__(self) -> None:
        if type(self.gate_enabled) is not bool or type(self.verified_sources) is not bool:
            raise TypeError("采纳策略开关必须是 bool。")
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
        """实际生效的逐维放行集；门关闭时不再按维度收紧（不影响来源核验）。"""

        if not self.gate_enabled:
            return _ALL_DIMENSION_NAMES
        return self.allowed

    @property
    def requires_evidence_binding(self) -> bool:
        """候选依据绑定与陈旧依据复验是否生效。

        生产来源核验（``verified_sources``）或显式历史逐维门任一开启时都必须
        绑定依据；只有两者的历史回退组合才跳过，因此运维开关不会关掉
        「预期依据」核验（ADR-097）。
        """

        return self.verified_sources or self.gate_enabled

    def allows(
        self, fact: ExtractedFact, *, scope: ContactScope | None = None,
        now: datetime | None = None,
    ) -> bool:
        """核对当前来源核验回执与逐维放行；来源核验不受运维回退开关影响。"""

        if self.verified_sources:
            # 默认自动采纳只看同次来源核验回执；运维回退开关不参与这条路径。
            return _verified_current_sources(fact, scope=scope, now=now)
        key = dimension_key(fact)
        if not self.gate_enabled:
            # 门关闭只影响显式历史协议的逐维白名单，不改变来源核验。
            return key is not None
        evidence = fact.dimension_evidence
        if scope is not None and (evidence is None or evidence.scope != scope):
            return False
        required = required_dimensions(fact)
        return (
            required <= self.released
            and required <= valid_evidence_dimensions(fact, now=now)
        )

    @classmethod
    def resolve(cls, value: "DimensionRelease | None") -> "DimensionRelease":
        """把可选的注入值解析成放行表；``None`` 表示按环境与台账默认值。

        生产装配只允许传 ``None``（测试可显式注入放行表）；这样"忘记传参"
        永远不会变成"全部放行"。
        """

        if value is None:
            return cls.from_environment()
        if not isinstance(value, DimensionRelease):
            raise TypeError("维度放行表必须是 DimensionRelease。")
        return value

    @classmethod
    def from_environment(
        cls,
        environ: Mapping[str, str] | None = None,
        *,
        default: "DimensionRelease | None" = None,
    ) -> "DimensionRelease":
        """读取默认逐项核验策略及兼容运维开关；default仅供显式测试策略注入。

        运维开关只切换显式历史协议（``verified_sources=False``）的逐维白名单；
        ``verified_sources`` 来自默认策略，不受开关影响，因此回退不会绕过同次
        来源核验（ADR-097）。
        """

        values = os.environ if environ is None else environ
        base = DEFAULT_DIMENSION_RELEASE if default is None else default
        if not isinstance(base, DimensionRelease):
            raise TypeError("默认放行表必须是 DimensionRelease。")
        gate_enabled = (
            values.get(DIMENSION_GATE_VARIABLE, "").strip() != "0"
        )
        return cls(allowed=base.allowed, gate_enabled=gate_enabled, verified_sources=base.verified_sources)


#: 默认不声明逐维质量资格；新输入由同次独立核验与来源事务复验决定采纳。
DEFAULT_DIMENSION_RELEASE = DimensionRelease(verified_sources=True)
#: 运维回退：不再按维度收紧，等价于启用本门之前的自动采纳行为。
#: 注意 ``allowed`` 故意留空——生效的放行集由 :attr:`DimensionRelease.released`
#: 在门关闭时返回全集；只读 ``allowed`` 会误判成"什么都不放行"。
RELEASE_ALL_DIMENSIONS = DimensionRelease(gate_enabled=False)
