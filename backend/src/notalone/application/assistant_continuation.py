"""会话内明确编号与本次要求；不会写入关系记忆或长期偏好。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal, Protocol
from uuid import UUID

from notalone.application.assistant_continuation_identity import (
    AssistantContinuationInvalid as AssistantContinuationInvalid,
    AssistantContinuationReplyRequest as AssistantContinuationReplyRequest,
    continuation_digest_input as continuation_digest_input,
    continuation_commit_input as continuation_commit_input,
    continuation_input_payload as continuation_input_payload,
)

from notalone.scopes import ContactScope
from notalone.application.assistant_generation_lifecycle import AssistantGenerationReceipt


@dataclass(frozen=True, slots=True)
class DisplayedCandidate:
    number: int
    candidate_id: UUID
    version_id: UUID


@dataclass(frozen=True, slots=True)
class DisplayedCandidateGroup:
    session_id: UUID
    candidate_group_id: UUID
    candidates: tuple[DisplayedCandidate, ...]


@dataclass(frozen=True, slots=True, repr=False)
class RequirementChange:
    action: Literal["keep", "replace", "remove", "add"]
    previous: str | None = None
    replacement: str | None = None


@dataclass(frozen=True, slots=True, repr=False)
class ContinueAssistantSession:
    idempotency_key: UUID
    expected_input_version_id: UUID
    instruction: str
    displayed_group: DisplayedCandidateGroup
    intention_update: str | None = None
    requirement_changes: tuple[RequirementChange, ...] = ()




@dataclass(frozen=True, slots=True, repr=False)
class RequirementClarificationOption:
    requirement: str
    origin: Literal["existing", "new"]

    @property
    def actions(self) -> tuple[Literal["keep", "replace", "remove", "add"], ...]:
        return ("keep", "replace", "remove") if self.origin == "existing" else ("add",)


class AssistantContinuationClarification(RuntimeError):
    def __init__(
        self, reason: str, *, requirements: tuple[str, ...] = (),
        previous_requirements: tuple[str, ...] = (),
    ) -> None:
        super().__init__("请确认本次继续的候选或要求。")
        self.reason = reason
        self.requirements = requirements
        self.requirement_options = tuple(
            RequirementClarificationOption(value, "existing" if value in previous_requirements else "new")
            for value in requirements
        )




@dataclass(frozen=True, slots=True, repr=False)
class AssistantContinuationReservation:
    turn_id: UUID
    request: AssistantContinuationReplyRequest


class AssistantContinuationPort(Protocol):
    def reserve_continuation(
        self, scope: ContactScope, session_id: UUID, command: ContinueAssistantSession,
    ) -> AssistantContinuationReservation: ...

    def prepare_continuation(
        self, scope: ContactScope, session_id: UUID, command: ContinueAssistantSession,
    ) -> AssistantGenerationReceipt: ...


def _uuid(value: object) -> UUID:
    if not isinstance(value, str):
        raise AssistantContinuationInvalid("持续要求结构无效。")
    try:
        identifier = UUID(value)
    except ValueError:
        raise AssistantContinuationInvalid("持续要求结构无效。") from None
    if str(identifier) != value:
        raise AssistantContinuationInvalid("持续要求结构无效。")
    return identifier


def _text(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        raise AssistantContinuationInvalid("持续要求结构无效。")
    return value.strip()


def parse_continuation(payload: object) -> ContinueAssistantSession:
    required = {"idempotency_key", "expected_input_version_id", "instruction", "displayed_group"}
    if (not isinstance(payload, dict) or not required <= set(payload)
            or set(payload) - required - {"intention_update", "requirement_changes"}):
        raise AssistantContinuationInvalid("持续要求结构无效。")
    frame = payload["displayed_group"]
    if (not isinstance(frame, dict) or set(frame) != {"session_id", "candidate_group_id", "candidates"}
            or not isinstance(frame["candidates"], list) or not 0 <= len(frame["candidates"]) <= 3):
        raise AssistantContinuationInvalid("展示组结构无效。")
    candidates = []
    for item in frame["candidates"]:
        if (not isinstance(item, dict) or set(item) != {"number", "candidate_id", "version_id"}
                or type(item["number"]) is not int or not 1 <= item["number"] <= 3):
            raise AssistantContinuationInvalid("展示组结构无效。")
        candidates.append(DisplayedCandidate(item["number"], _uuid(item["candidate_id"]), _uuid(item["version_id"])))
    changes = payload.get("requirement_changes", [])
    if not isinstance(changes, list):
        raise AssistantContinuationInvalid("要求变更结构无效。")
    normalized = []
    for change in changes:
        if not isinstance(change, dict) or set(change) - {"action", "previous", "replacement"}:
            raise AssistantContinuationInvalid("要求变更结构无效。")
        action = change.get("action")
        fields = {"keep": {"action", "previous"}, "remove": {"action", "previous"},
                  "replace": {"action", "previous", "replacement"}, "add": {"action", "replacement"}}
        if action not in fields or set(change) != fields[action]:
            raise AssistantContinuationInvalid("要求变更结构无效。")
        normalized.append(RequirementChange(
            action, _text(change["previous"]) if "previous" in change else None,
            _text(change["replacement"]) if "replacement" in change else None,
        ))
    return ContinueAssistantSession(
        _uuid(payload["idempotency_key"]), _uuid(payload["expected_input_version_id"]),
        _text(payload["instruction"]),
        DisplayedCandidateGroup(_uuid(frame["session_id"]), _uuid(frame["candidate_group_id"]), tuple(candidates)),
        _text(payload["intention_update"]) if "intention_update" in payload else None, tuple(normalized),
    )


def continuation_submission(command: ContinueAssistantSession) -> dict[str, Any]:
    if (not isinstance(command, ContinueAssistantSession)
            or not isinstance(command.displayed_group, DisplayedCandidateGroup)
            or not isinstance(command.displayed_group.candidates, tuple)
            or any(not isinstance(item, DisplayedCandidate) for item in command.displayed_group.candidates)
            or not isinstance(command.requirement_changes, tuple)
            or any(not isinstance(change, RequirementChange) for change in command.requirement_changes)):
        raise AssistantContinuationInvalid("持续要求结构无效。")
    payload: dict[str, Any] = {
        "idempotency_key": str(command.idempotency_key),
        "expected_input_version_id": str(command.expected_input_version_id),
        "instruction": command.instruction,
        "displayed_group": {
            "session_id": str(command.displayed_group.session_id),
            "candidate_group_id": str(command.displayed_group.candidate_group_id),
            "candidates": [{"number": item.number, "candidate_id": str(item.candidate_id),
                            "version_id": str(item.version_id)} for item in command.displayed_group.candidates],
        },
    }
    if command.intention_update is not None:
        payload["intention_update"] = command.intention_update
    if command.requirement_changes:
        payload["requirement_changes"] = [{
            "action": change.action,
            **({"previous": change.previous} if change.previous is not None else {}),
            **({"replacement": change.replacement} if change.replacement is not None else {}),
        } for change in command.requirement_changes]
    # 公开Python调用与JSON调用经过同一结构验证，防止伪造类型实例绕过边界。
    parse_continuation(payload)
    return payload


_ORDINAL = re.compile(r"第\s*([一二三四五六七八九十百\d]+)\s*(?:条|个)(?:候选)?")
_CHINESE_NUMBERS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6,
                    "七": 7, "八": 8, "九": 9, "十": 10}


def continuation_reference(instruction: str) -> tuple[int | None, str]:
    matches = list(_ORDINAL.finditer(instruction))
    if not matches and (re.search(r"第[^，,。；;\s]{1,8}(?:条|个)", instruction)
                        or re.search(r"\d+(?:号|条)?候选", instruction)):
        raise AssistantContinuationClarification("candidate_number_unclear")
    numbers = set()
    for match in matches:
        value = match.group(1)
        number = int(value) if value.isdecimal() else _CHINESE_NUMBERS.get(value)
        if number is None:
            raise AssistantContinuationClarification("candidate_number_unclear")
        numbers.add(number)
    if len(numbers) > 1:
        raise AssistantContinuationClarification("candidate_reference_ambiguous")
    if re.search(r"之前|那个|那条|这条|这个|旧版|版本|上次那", instruction):
        raise AssistantContinuationClarification("candidate_reference_ambiguous")
    remaining = _ORDINAL.sub("", instruction).strip(" ，,。；;：:")
    return next(iter(numbers)) if numbers else None, remaining


def requirement_clauses(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(dict.fromkeys(part.strip() for part in re.split(r"[；;，,\n]+", value) if part.strip()))


def _requirement_dimension(value: str) -> tuple[str, str] | None:
    normalized = re.sub(r"[。\s]", "", value)
    dimensions: dict[str, dict[str, str]] = {
        "tone": {"natural": r"(?:自然|口语化?)(?:一点|一些|些|点)?",
                 "formal": r"(?:正式|书面)(?:一点|一些|些|点)?"},
        "length": {"brief": r"(?:简短|简洁)(?:一点|一些|些|点)?|短一点",
                   "detailed": r"(?:详细|展开)(?:一点|一些|些|点)?"},
        "initiative": {"reserved": r"(?:别|不要|不)太主动", "active": r"主动一点"},
        "commitment": {"none": r"(?:不作|不做|别|不要)承诺"},
    }
    for dimension, choices in dimensions.items():
        # 只自动分类整条已知表达要求；未知尾句和混合意愿不能借一个语气词通过。
        found = [choice for choice, pattern in choices.items()
                 if re.fullmatch(r"(?:请|尽量|保持|语气|表达|回复)?(?:" + pattern + r")", normalized)]
        if len(found) == 1:
            return dimension, found[0]
    return None


def _requirement_parts(value: str) -> tuple[str, ...]:
    # 保留整条要求用于确认和记录；仅按标点及明确并联连接词核对各分句。
    return tuple(part.strip() for clause in requirement_clauses(value)
                 for part in re.split(r"并且|而且|并", clause))


def _requirement_dimensions(value: str) -> tuple[tuple[str, str], ...]:
    # 未知分句仍须确认，但不能遮蔽同一复合要求中已知维度的冲突。
    dimensions = (_requirement_dimension(part) for part in _requirement_parts(value))
    return tuple(dimension for dimension in dimensions if dimension is not None)


def _requirement_has_unknown(value: str) -> bool:
    return any(_requirement_dimension(part) is None for part in _requirement_parts(value))


def resolve_requirements(
    previous: tuple[str, ...], instruction: str, changes: tuple[RequirementChange, ...],
    *, intention_changed: bool,
) -> tuple[str, ...]:
    effective = list(previous)
    confirmed: set[str] = set()
    additions: list[str] = []
    touched: set[str] = set()
    for change in changes:
        if change.action == "add":
            if change.replacement is None:
                raise AssistantContinuationInvalid("要求变更结构无效。")
            additions.append(change.replacement)
            confirmed.add(change.replacement)
            continue
        if change.previous is None:
            raise AssistantContinuationInvalid("要求变更结构无效。")
        if change.previous not in previous or change.previous in touched:
            raise AssistantContinuationClarification(
                "requirement_change_stale", requirements=previous, previous_requirements=previous,
            )
        touched.add(change.previous)
        if change.action == "keep":
            confirmed.add(change.previous)
        elif change.action == "remove":
            effective.remove(change.previous)
        else:
            if change.replacement is None:
                raise AssistantContinuationInvalid("要求变更结构无效。")
            effective[effective.index(change.previous)] = change.replacement
            confirmed.add(change.replacement)
    if instruction and not re.fullmatch(r"(?:再)?(?:改一下|修改|继续|再改一下)", instruction):
        additions.extend(requirement_clauses(instruction))
    for added in additions:
        if added in effective:
            continue
        effective.append(added)
    introduced = set(effective) - set(previous)
    # 意愿或要求配对改变时复验未知兼容性；不变的未知原文无需重复确认。
    unknown = tuple(value for value in effective
                    if value not in confirmed and _requirement_has_unknown(value)
                    and (intention_changed
                         or (value in introduced and len(_requirement_parts(value)) > 1)
                         or any(other != value and (value in introduced or other in introduced)
                                for other in effective)))
    if unknown:
        raise AssistantContinuationClarification(
            "requirements_need_confirmation", requirements=unknown, previous_requirements=previous,
        )
    # replace 与 add 都必须在最终集合中复验，不能只检查本轮新增文字。
    known: dict[str, tuple[str, str]] = {}
    for value in effective:
        for dimension, choice in _requirement_dimensions(value):
            old = known.get(dimension)
            if old is not None and old[0] != choice:
                raise AssistantContinuationClarification(
                    "requirements_conflict", requirements=(old[1],), previous_requirements=previous,
                )
            known.setdefault(dimension, (choice, value))
    return tuple(dict.fromkeys(effective))
