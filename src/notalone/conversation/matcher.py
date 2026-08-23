"""前台会话证据与 CLI 候选的绑定匹配。

纯领域逻辑：不访问数据库、不调用 CLI。重名、改名或证据矛盾时
只返回需要用户选择或不可用的结果，绝不静默挑选联系人。
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from notalone.wechat_cli.models import ChatCandidate

_PRIVATE_CHAT_TYPE = "private"


class BindingMatchKind(StrEnum):
    """绑定匹配的整体结论。"""

    CONFIRMED = "confirmed"
    NEEDS_SELECTION = "needs_selection"
    UNAVAILABLE = "unavailable"


class BindingMatchReason(StrEnum):
    """不会泄漏会话内容的稳定匹配原因。"""

    OBSERVATION_UNREADABLE = "observation_unreadable"
    NO_CANDIDATE = "no_candidate"
    METADATA_MISMATCH = "metadata_mismatch"
    CONFIRMED_ACTIVE_BINDING = "confirmed_active_binding"
    BINDING_NAME_CHANGED = "binding_name_changed"
    FIRST_BINDING_UNIQUE = "first_binding_unique"
    AMBIGUOUS_REQUIRES_SELECTION = "ambiguous_requires_selection"


@dataclass(frozen=True, slots=True)
class FrontSessionEvidence:
    """前台定位提供的最小证据：顶部 display name 与选中行元数据。"""

    display_name: str | None
    last_time_text: str | None = None
    preview_text: str | None = None


@dataclass(frozen=True, slots=True)
class StoredBindingEvidence:
    """已保存 active 绑定的最小投影，只携带匹配所需字段。"""

    binding_id: UUID
    conversation_locator: str
    display_name: str | None


@dataclass(frozen=True, slots=True)
class BindingMatchDecision:
    """一次匹配的稳定结论；候选只用于展示选择，不代表身份。"""

    kind: BindingMatchKind
    reason: BindingMatchReason
    candidates: tuple[ChatCandidate, ...] = ()
    confirmed_binding_id: UUID | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.kind, BindingMatchKind):
            raise TypeError("绑定匹配结论类型无效。")
        if not isinstance(self.reason, BindingMatchReason):
            raise TypeError("绑定匹配原因无效。")
        if self.kind is BindingMatchKind.CONFIRMED:
            if not isinstance(self.confirmed_binding_id, UUID):
                raise ValueError("已确认结论必须携带绑定 UUID。")
        elif self.confirmed_binding_id is not None:
            raise ValueError("未确认结论不能携带绑定 UUID。")
        if self.kind is BindingMatchKind.UNAVAILABLE and self.candidates:
            raise ValueError("不可用结论不能携带候选。")


def normalize_display_text(value: str | None) -> str:
    """统一空白字符，便于比较 display name 与候选名称。"""

    if not isinstance(value, str):
        return ""
    return " ".join(value.split())


def match_front_session(
    *,
    evidence: FrontSessionEvidence,
    candidates: Sequence[ChatCandidate],
    stored_bindings: Sequence[StoredBindingEvidence],
) -> BindingMatchDecision:
    """把前台证据与 CLI 候选、已有绑定比对，得到绑定决策。"""

    observed_name = normalize_display_text(evidence.display_name)
    if not observed_name:
        return BindingMatchDecision(
            kind=BindingMatchKind.UNAVAILABLE,
            reason=BindingMatchReason.OBSERVATION_UNREADABLE,
        )

    name_matched = tuple(
        candidate
        for candidate in candidates
        if candidate.chat_type == _PRIVATE_CHAT_TYPE
        and normalize_display_text(candidate.display_name) == observed_name
    )
    if not name_matched:
        return BindingMatchDecision(
            kind=BindingMatchKind.UNAVAILABLE,
            reason=BindingMatchReason.NO_CANDIDATE,
        )

    narrowed = tuple(
        candidate
        for candidate in name_matched
        if not _contradicts_evidence(candidate, evidence)
    )
    has_evidence = bool(
        normalize_display_text(evidence.last_time_text)
        or normalize_display_text(evidence.preview_text)
    )
    if has_evidence and not narrowed:
        # 所有候选都与选中行证据矛盾时停止，不退回猜测。
        return BindingMatchDecision(
            kind=BindingMatchKind.UNAVAILABLE,
            reason=BindingMatchReason.METADATA_MISMATCH,
        )
    effective = narrowed or name_matched

    usernames = {candidate.username for candidate in effective}
    binding = next(
        (
            stored
            for stored in stored_bindings
            if stored.conversation_locator in usernames
        ),
        None,
    )
    if binding is not None:
        bound_candidates = tuple(
            candidate
            for candidate in effective
            if candidate.username == binding.conversation_locator
        )
        if normalize_display_text(binding.display_name) == observed_name:
            return BindingMatchDecision(
                kind=BindingMatchKind.CONFIRMED,
                reason=BindingMatchReason.CONFIRMED_ACTIVE_BINDING,
                candidates=bound_candidates,
                confirmed_binding_id=binding.binding_id,
            )
        # 改名只要求一次确认新旧映射，不自动改绑。
        return BindingMatchDecision(
            kind=BindingMatchKind.NEEDS_SELECTION,
            reason=BindingMatchReason.BINDING_NAME_CHANGED,
            candidates=bound_candidates,
        )

    if len(effective) == 1:
        return BindingMatchDecision(
            kind=BindingMatchKind.NEEDS_SELECTION,
            reason=BindingMatchReason.FIRST_BINDING_UNIQUE,
            candidates=effective,
        )
    return BindingMatchDecision(
        kind=BindingMatchKind.NEEDS_SELECTION,
        reason=BindingMatchReason.AMBIGUOUS_REQUIRES_SELECTION,
        candidates=effective,
    )


def summarize_evidence(evidence: FrontSessionEvidence) -> Mapping[str, Any]:
    """生成可保存到绑定的证据摘要；预览只保留哈希，不保存原文。"""

    summary: dict[str, Any] = {}
    time_text = normalize_display_text(evidence.last_time_text)
    if time_text:
        summary["time_text"] = time_text
    preview = normalize_display_text(evidence.preview_text)
    if preview:
        summary["preview_digest"] = hashlib.sha256(preview.encode("utf-8")).hexdigest()
    return summary


def _contradicts_evidence(
    candidate: ChatCandidate,
    evidence: FrontSessionEvidence,
) -> bool:
    """候选携带的证据与选中行观察明确矛盾时返回 True；缺证据不算矛盾。"""

    time_result = _time_matches(candidate.last_timestamp, evidence.last_time_text)
    if time_result is False:
        return True
    preview_result = _preview_matches(candidate.summary, evidence.preview_text)
    return preview_result is False


def _time_matches(last_timestamp: int | None, time_text: str | None) -> bool | None:
    """比较候选最近时间与选中行时间文本；证据不足返回 None。"""

    normalized = normalize_display_text(time_text)
    if last_timestamp is None or not normalized:
        return None
    try:
        moment = datetime.fromtimestamp(last_timestamp)
    except (OverflowError, OSError, ValueError):
        return None
    if not any(character.isdigit() for character in normalized):
        # “昨天”“星期一”这类相对时间无法在 v1 可靠比对。
        return None
    return moment.strftime("%H:%M") in normalized


def _preview_matches(summary: str | None, preview_text: str | None) -> bool | None:
    """比较候选预览与选中行短预览；任一侧缺失返回 None。"""

    normalized_summary = normalize_display_text(summary)
    normalized_preview = normalize_display_text(preview_text)
    if not normalized_summary or not normalized_preview:
        return None
    return normalized_summary == normalized_preview
