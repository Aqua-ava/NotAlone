"""未确认意愿的有界理解与方向探索；结果不进入候选生成或长期资料。"""

from __future__ import annotations

from dataclasses import dataclass, field
from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Any, Literal, Protocol
from uuid import UUID

from notalone.scopes import ContactScope
from notalone.skills import SkillCatalog


class ExplorationError(RuntimeError):
    """稳定的探索错误，不包含模型、聊天正文或驱动异常。"""


class ExplorationStale(ExplorationError):
    pass


class ExplorationExpired(ExplorationStale):
    """授权时已过期；外层事务退出后提交独立正文擦除。"""


@dataclass(frozen=True, slots=True, repr=False)
class ExplorationInput:
    scene: Literal["reply_to_message", "initiate_conversation"]
    target_message_id: UUID | None = None
    purpose_hint: str = ""
    correction: str = ""
    requirements: str = ""
    answer: str = ""
    confirmed_intent: str = ""
    skill_mode: Literal["auto", "disabled", "user"] = "auto"
    skill_version_id: UUID | None = None
    skill_scene: str | None = None

    def __post_init__(self) -> None:
        if self.skill_scene is not None and (not isinstance(self.skill_scene, str)
                or not 0 < len(self.skill_scene.strip()) <= 256 or self.skill_scene != self.skill_scene.strip()):
            raise ValueError('显式Skill场景无效。')
        if self.scene not in ("reply_to_message", "initiate_conversation"):
            raise ValueError("探索场景无效。")
        if self.scene == "reply_to_message" and not isinstance(self.target_message_id, UUID):
            raise ValueError("回应探索必须明确目标消息。")
        if self.scene == "initiate_conversation" and self.target_message_id is not None:
            raise ValueError("主动探索不能伪造目标消息。")
        if any(not isinstance(value, str) or len(value) > 4096 for value in (
            self.purpose_hint, self.correction, self.requirements, self.answer, self.confirmed_intent,
        )):
            raise ValueError("探索文字输入无效。")
        if self.skill_mode not in ("auto", "disabled", "user") or (
            not isinstance(self.skill_version_id, UUID) if self.skill_mode == "user"
            else self.skill_version_id is not None
        ):
            raise ValueError("探索 Skill 选择无效。")

    def payload(self) -> dict[str, Any]:
        return {
            "type": "response_exploration" if self.scene == "reply_to_message" else "purpose_exploration",
            **({"target_message_id": str(self.target_message_id)} if self.scene == "reply_to_message"
               else {"purpose_hint": self.purpose_hint}),
            "correction": self.correction,
            "requirements": self.requirements, "answer": self.answer,
            "confirmed_intent": self.confirmed_intent, "skill_mode": self.skill_mode,
            "skill_version_id": str(self.skill_version_id) if self.skill_version_id else None,
            **({'skill_scene': self.skill_scene} if self.skill_scene is not None else {}),
        }


@dataclass(frozen=True, slots=True, repr=False)
class ExplorationContext:
    scope: ContactScope
    input: ExplorationInput
    evidence: tuple[dict[str, Any], ...]
    skill: dict[str, Any] | None = None
    previous_intents: tuple[str, ...] = ()
    validate_current: Callable[[], None] | None = field(default=None, compare=False)


class ExplorationRuntime(Protocol):
    def explore(self, context: ExplorationContext) -> dict[str, Any]: ...

    def select_skill(self, context: ExplorationContext, catalog: SkillCatalog) -> UUID | None: ...


class ExplorationPriority(Protocol):
    def foreground(self) -> AbstractContextManager[None]: ...

    def check_running(self) -> None: ...


def validate_exploration_output(value: Any, context: ExplorationContext) -> dict[str, Any]:
    """只有可展示、有真实引用的不同意愿才能进入公开结果。"""

    if not isinstance(value, dict):
        raise ExplorationError("探索结果结构无效。")
    allowed = {"understanding", "ambiguities", "citation_ids", "options", "question", "current_step", "tradeoffs"}
    if set(value) != allowed:
        raise ExplorationError("探索结果结构无效。")
    def strings(items: Any, limit: int) -> bool:
        return isinstance(items, list) and len(items) <= limit and all(isinstance(item, str) and 0 < len(item.strip()) <= 1000 for item in items)
    if (not isinstance(value["understanding"], str) or not 0 < len(value["understanding"].strip()) <= 1000
        or not strings(value["ambiguities"], 4) or not strings(value["tradeoffs"], 4)
        or not isinstance(value["current_step"], str) or len(value["current_step"]) > 1000):
        raise ExplorationError("探索文字结构无效。")
    ids = {item["evidence_id"] for item in context.evidence}
    def citations(items: Any) -> bool:
        return isinstance(items, list) and len(items) <= 20 and all(isinstance(item, str) and item in ids for item in items) and len(items) == len(set(items))
    if not citations(value["citation_ids"]):
        raise ExplorationError("探索依据不属于当前快照。")
    options = value["options"]
    if not isinstance(options, list) or not (2 <= len(options) <= 4 or (not options and value["question"] is not None)):
        raise ExplorationError("方向数量无效。")
    intents: set[str] = set()
    for option in options:
        if (not isinstance(option, dict) or set(option) != {"intent", "label", "reason", "citation_ids", "recommended", "pause"}
            or any(not isinstance(option[key], str) or not 0 < len(option[key].strip()) <= 1000 for key in ("intent", "label", "reason"))
            or not citations(option["citation_ids"]) or not isinstance(option["recommended"], bool)
            or not isinstance(option["pause"], bool)
            or (option["recommended"] and not option["citation_ids"])):
            raise ExplorationError("方向选项结构或依据无效。")
        if option["intent"].strip() in intents:
            raise ExplorationError("方向必须表达不同意愿。")
        intents.add(option["intent"].strip())
    if sum(option["recommended"] for option in options) > 1:
        raise ExplorationError("不能同时强行推荐多个方向。")
    if context.previous_intents and options and intents == {intent.strip() for intent in context.previous_intents}:
        raise ExplorationError("方向换组不能原样重复，请手动重试。")
    question = value["question"]
    if question is not None and (
        not isinstance(question, dict) or set(question) != {"text", "impact"}
        or question["impact"] not in ("stance", "commitment", "ambiguity")
        or not isinstance(question["text"], str) or not 0 < len(question["text"].strip()) <= 1000
    ):
        raise ExplorationError("关键问题结构无效。")
    return {**value, "options": [{**option, "intent": option["intent"].strip()} for option in options]}
