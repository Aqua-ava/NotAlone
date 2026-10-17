"""只有明确长期保存命令才能写入的表达偏好公开契约。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID



ExpressionReplyMode = Literal["reply_to_message", "rewrite_draft", "initiate_conversation"]
EXPRESSION_REPLY_MODES = frozenset({"reply_to_message", "rewrite_draft", "initiate_conversation"})


class ExpressionPreferenceError(RuntimeError):
    """不含私密正文的偏好操作失败。"""


class ExpressionPreferenceNotFound(ExpressionPreferenceError):
    """当前用户范围内没有此偏好或来历。"""


class ExpressionPreferenceDeleted(ExpressionPreferenceError):
    """已经删除的偏好不能被旧操作恢复。"""


class ExpressionPreferenceConflict(ExpressionPreferenceError):
    """用户操作键、偏好版本或来源已改变。"""


@dataclass(frozen=True, slots=True)
class ExpressionPreferenceScope:
    """联系人与适用输入模式可分别限定，也可以同时限定。"""

    owner_id: UUID
    contact_id: UUID | None = None
    reply_mode: ExpressionReplyMode | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.owner_id, UUID) or (
            self.contact_id is not None and not isinstance(self.contact_id, UUID)
        ) or self.reply_mode is not None and self.reply_mode not in EXPRESSION_REPLY_MODES:
            raise ValueError("表达偏好适用范围无效。")


@dataclass(frozen=True, slots=True, repr=False)
class SaveExpressionPreference:
    operation_key: UUID
    text: str
    scope: ExpressionPreferenceScope
    origin_kind: Literal["manual", "message"] = "manual"
    origin_id: UUID | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.operation_key, UUID) or not isinstance(self.scope, ExpressionPreferenceScope):
            raise ValueError("表达偏好用户操作无效。")
        if not isinstance(self.text, str) or not 1 <= len(self.text.strip()) <= 512:
            raise ValueError("长期表达要求须为1至512字。")
        if self.origin_kind not in {"manual", "message"} or (
            self.origin_kind == "manual" and self.origin_id is not None
        ) or (self.origin_kind == "message" and not isinstance(self.origin_id, UUID)):
            raise ValueError("表达偏好来历无效。")


@dataclass(frozen=True, slots=True, repr=False)
class UpdateExpressionPreference:
    operation_key: UUID
    expected_revision: int
    text: str
    scope: ExpressionPreferenceScope

    def __post_init__(self) -> None:
        if not isinstance(self.operation_key, UUID) or not isinstance(self.scope, ExpressionPreferenceScope):
            raise ValueError("表达偏好用户操作无效。")
        if type(self.expected_revision) is not int or self.expected_revision < 1:
            raise ValueError("表达偏好版本无效。")
        if not isinstance(self.text, str) or not 1 <= len(self.text.strip()) <= 512:
            raise ValueError("长期表达要求须为1至512字。")


@dataclass(frozen=True, slots=True)
class DeleteExpressionPreference:
    operation_key: UUID
    expected_revision: int

    def __post_init__(self) -> None:
        if not isinstance(self.operation_key, UUID) or type(self.expected_revision) is not int or self.expected_revision < 1:
            raise ValueError("删除偏好的用户操作或版本无效。")


@dataclass(frozen=True, slots=True, repr=False)
class ExpressionPreference:
    preference_id: UUID
    scope: ExpressionPreferenceScope
    text: str
    revision: int
    confirmed_operation_key: UUID
    origin_kind: str
    origin_id: UUID | None
    source_ids: tuple[UUID, ...]
    confirmed_at: datetime
    updated_at: datetime

    def __post_init__(self) -> None:
        if (not isinstance(self.preference_id, UUID) or not isinstance(self.scope, ExpressionPreferenceScope)
                or not isinstance(self.confirmed_operation_key, UUID)
                or not isinstance(self.text, str) or not 1 <= len(self.text.strip()) <= 512
                or type(self.revision) is not int or self.revision < 1
                or not isinstance(self.source_ids, tuple)
                or any(not isinstance(identifier, UUID) for identifier in self.source_ids)
                or len(set(self.source_ids)) != len(self.source_ids)
                or any(not isinstance(value, datetime) or value.utcoffset() is None
                       for value in (self.confirmed_at, self.updated_at))):
            raise ValueError("长期表达偏好身份、版本或来源结构无效。")
        if (self.origin_kind == "manual" and (self.origin_id is not None or self.source_ids)
                or self.origin_kind == "message" and (not isinstance(self.origin_id, UUID)
                    or self.scope.contact_id is None or self.origin_id not in self.source_ids)
                or self.origin_kind not in {"manual", "message"}):
            raise ValueError("长期表达偏好来历无效。")


@dataclass(frozen=True, slots=True, repr=False)
class ExpressionPreferenceSnapshot:
    revision: int
    preferences: tuple[ExpressionPreference, ...]
