"""完整会话名单的保守名称匹配；阈值是启发式规则，不是身份概率。"""

from __future__ import annotations

import math
import unicodedata
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True, slots=True)
class SessionNameCandidate:
    display_name: str
    chat_type: str


@dataclass(frozen=True, slots=True)
class NameMatchDecision:
    kind: Literal["unique", "ambiguous", "unmatched", "quality-unverified", "group"]
    candidate_index: int | None = None
    method: Literal["exact", "normalized", "edit", "tail"] | None = None
    plausible_indices: tuple[int, ...] = ()


def canonical_session_name(value: str) -> str:
    """名单文字比较的统一形式；不能用于掩盖绑定完整名称的改名。"""
    return "".join(unicodedata.normalize("NFKC", value).casefold().split())


def _alnum_count(value: str) -> int:
    return len(value) if value.isalnum() else sum(character.isalnum() for character in value)


def _valid_confidence(value: object, minimum: float) -> bool:
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and minimum <= value <= 1 and math.isfinite(value))


def _radius(length: int) -> int:
    return 1 if length <= 6 else 2 if length <= 12 else 3


def _can_supply_anchors(value: str) -> bool:
    """不把 ™ 等符号的兼容分解计成多个字母；这类近邻仍参与消歧。"""

    if value.isascii() and value.isalnum():
        return len(value) >= 2
    return _alnum_count(value) >= 2 and not any(
        not character.isalnum() and any(part.isalnum() for part in canonical_session_name(character))
        for character in value
    )


def _expansion_excess(value: str) -> int:
    """扩展产生的多余字母不充原始来源锚点；全额扣除宁可要求人工确认。"""

    if value.isascii():
        return 0
    return sum(max(0, sum(part.isalnum() for part in canonical_session_name(character)) - 1)
               for character in value if character.isalnum())


def _bounded_alignment(left: str, right: str, radius: int) -> tuple[int, int] | None:
    """仅保存宽度至多七格的 DP 行；相同最小编辑数取最多相等文字锚点。"""

    if abs(len(left) - len(right)) > radius:
        return None
    if left == right:
        return 0, _alnum_count(left)
    # 去掉两端必然可保留的相等区段，避免长同前缀名单反复执行整条 DP。
    prefix = 0
    prefix_limit = min(len(left), len(right))
    while prefix < prefix_limit and left[prefix] == right[prefix]:
        prefix += 1
    left_end, right_end = len(left), len(right)
    while left_end > prefix and right_end > prefix and left[left_end - 1] == right[right_end - 1]:
        left_end -= 1
        right_end -= 1
    fixed_anchors = _alnum_count(left[:prefix] + left[left_end:])
    left, right = left[prefix:left_end], right[prefix:right_end]
    if not left or not right:
        return max(len(left), len(right)), fixed_anchors
    previous = {column: (column, 0) for column in range(min(len(right), radius) + 1)}
    for row, character in enumerate(left, 1):
        current = {}
        for column in range(max(0, row - radius), min(len(right), row + radius) + 1):
            if column == 0:
                current[column] = (row, 0)
                continue
            options = []
            if column in previous:
                distance, anchors = previous[column]
                options.append((distance + 1, anchors))
            if column - 1 in current:
                distance, anchors = current[column - 1]
                options.append((distance + 1, anchors))
            if column - 1 in previous:
                distance, anchors = previous[column - 1]
                equal = character == right[column - 1]
                options.append((distance + (not equal), anchors + (equal and character.isalnum())))
            if options:
                best = min(options, key=lambda option: (option[0], -option[1]))
                if best[0] <= radius:
                    current[column] = best
        if not current:
            return None
        previous = current
    result = previous.get(len(right))
    return None if result is None else (result[0], result[1] + fixed_anchors)


def _near(query: str, candidate: str, radius: int) -> tuple[int, int] | None:
    result = _bounded_alignment(query, candidate, radius)
    if result is None:
        return None
    longest = max(len(query), len(candidate))
    if longest >= 7 and result[0] * 5 > longest:
        return None
    return result


def match_session_names(
    raw_text: str,
    raw_confidence: float,
    candidates: Sequence[SessionNameCandidate],
    *,
    tail_text: str | None = None,
    tail_confidence: float | None = None,
    check_current: Callable[[], None] | None = None,
) -> NameMatchDecision:
    """比较所有类型和重复项，只报告名称唯一性，调用方另核验绑定与授权。"""

    if check_current is not None:
        check_current()
    if (not isinstance(raw_text, str) or not 0 < len(raw_text) <= 256
            or not _valid_confidence(raw_confidence, 0)):
        return NameMatchDecision("quality-unverified")
    raw = canonical_session_name(raw_text)
    has_tail = tail_text is not None
    tail = canonical_session_name(tail_text) if isinstance(tail_text, str) else ""
    if (not raw or len(raw) > 256 or (not has_tail and raw_confidence < 0.3) or (has_tail and (
            not isinstance(tail_text, str) or not 0 < len(tail_text) <= 256
            or not tail or len(tail) > 256 or not _valid_confidence(tail_confidence, 0.9)))):
        return NameMatchDecision("quality-unverified")

    normalized = []
    exact_indices = []
    for index, candidate in enumerate(candidates):
        if check_current is not None and index and index % 64 == 0:
            check_current()
        if not isinstance(candidate.display_name, str) or len(candidate.display_name) > 256:
            return NameMatchDecision("quality-unverified")
        name = canonical_session_name(candidate.display_name)
        if len(name) > 256:
            return NameMatchDecision("quality-unverified")
        normalized.append(name)
        if name and name == raw:
            exact_indices.append(index)
    if check_current is not None:
        check_current()

    def decide(indices: tuple[int, ...], *, method: str, anchored: set[int] | None = None) -> NameMatchDecision:
        if any(candidates[index].chat_type == "group" for index in indices):
            return NameMatchDecision("group", plausible_indices=indices)
        if len(indices) > 1:
            return NameMatchDecision("ambiguous", plausible_indices=indices)
        if (not indices or candidates[indices[0]].chat_type != "private"
                or (anchored is not None and indices[0] not in anchored)):
            return NameMatchDecision("unmatched", plausible_indices=indices)
        return NameMatchDecision("unique", indices[0], method, indices)

    # 完整名称命中优先于纠错；分数不足以证明姓名错误，近似字不能覆盖零编辑命中。
    if not has_tail and exact_indices:
        indices = tuple(exact_indices)
        legacy_equal = len(indices) == 1 and " ".join(raw_text.split()) == " ".join(
            candidates[indices[0]].display_name.split())
        exact_anchors = None
        if raw_confidence < 0.9 and len(indices) == 1:
            index = indices[0]
            enough_text = (sum(character.isalnum() for character in raw)
                           - max(_expansion_excess(raw_text),
                                 _expansion_excess(candidates[index].display_name)) >= 2)
            exact_anchors = ({index} if enough_text and _can_supply_anchors(raw_text)
                             and _can_supply_anchors(candidates[index].display_name) else set())
        return decide(indices, method="exact" if legacy_equal else "normalized", anchored=exact_anchors)

    plausible = []
    anchored = set()
    raw_radius, tail_radius = _radius(len(raw)), _radius(len(tail))
    raw_can_anchor = raw_confidence >= 0.3 and _can_supply_anchors(raw_text)
    tail_can_anchor = _can_supply_anchors(tail_text or "")
    raw_excess = _expansion_excess(raw_text)
    tail_excess = _expansion_excess(tail_text or "")
    for index, name in enumerate(normalized):
        if check_current is not None and index and index % 64 == 0:
            check_current()
        if not name:
            continue
        raw_result = _near(raw, name, raw_radius)
        candidate_can_anchor = _can_supply_anchors(candidates[index].display_name)
        candidate_excess = _expansion_excess(candidates[index].display_name)
        is_plausible = raw_result is not None
        is_anchored = (raw_result is not None and raw_result[1] - max(raw_excess, candidate_excess) >= 2
                       and raw_can_anchor and candidate_can_anchor)
        if has_tail:
            for length in range(max(0, len(tail) - tail_radius, len(name) - 8),
                                min(len(name), len(tail) + tail_radius) + 1):
                tail_result = _near(tail, name[:length], tail_radius)
                if tail_result is not None:
                    is_plausible = True
                    if (tail_result[1] - max(tail_excess, candidate_excess) >= 2
                            and tail_can_anchor and candidate_can_anchor):
                        is_anchored = True
        if is_plausible:
            plausible.append(index)
            if is_anchored:
                anchored.add(index)
    if check_current is not None:
        check_current()
    return decide(tuple(plausible), method="tail" if has_tail else "edit", anchored=anchored)
