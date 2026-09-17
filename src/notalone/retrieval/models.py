"""检索结果的独立数据契约。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from notalone.scopes import ContactScope


def _validate_source_ids(source_ids: tuple[UUID, ...]) -> None:
    if not isinstance(source_ids, tuple) or any(
        not isinstance(source_id, UUID) for source_id in source_ids
    ):
        raise ValueError("检索结果来源引用结构无效。")


@dataclass(frozen=True, slots=True, repr=False)
class RetrievedMessage:
    """已经经过存储层范围过滤的一条消息命中。"""

    message_id: UUID
    scope: ContactScope
    text: str
    source_ids: tuple[UUID, ...] = ()
    occurred_at: datetime | None = None
    status: str = "active"
    valid_at: datetime | None = None
    invalid_at: datetime | None = None
    role: str = "unknown"
    session_id: UUID | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.message_id, UUID):
            raise TypeError("消息引用必须是 UUID。")
        if not isinstance(self.scope, ContactScope):
            raise TypeError("消息检索结果必须带联系人范围。")
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("消息检索结果正文不能为空。")
        _validate_source_ids(self.source_ids)
        if self.occurred_at is not None and not isinstance(
            self.occurred_at,
            datetime,
        ):
            raise TypeError("消息时间结构无效。")
        if not isinstance(self.status, str) or not self.status.strip():
            raise ValueError("消息状态不能为空。")
        if self.role not in ("owner", "contact", "system", "unknown"):
            raise ValueError("消息角色无效。")
        if self.session_id is not None and not isinstance(self.session_id, UUID):
            raise TypeError("消息会话标识结构无效。")


@dataclass(frozen=True, slots=True, repr=False)
class RetrievedMemory:
    """只允许已确认且当前有效的关系记忆命中。"""

    memory_id: UUID
    scope: ContactScope
    text: str
    category: str
    source_ids: tuple[UUID, ...]
    adoption_method: str
    revision: int
    topic: str = ""
    status: str = "active"
    valid_at: datetime | None = None
    invalid_at: datetime | None = None
    confidence: float = 1.0
    relevance_score: float | None = None
    matched_terms: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.memory_id, UUID):
            raise TypeError("关系记忆引用必须是 UUID。")
        if not isinstance(self.scope, ContactScope):
            raise TypeError("关系记忆检索结果必须带联系人范围。")
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("关系记忆检索结果正文不能为空。")
        if not isinstance(self.category, str) or not self.category.strip():
            raise ValueError("关系记忆分类不能为空。")
        if (
            not isinstance(self.adoption_method, str)
            or not self.adoption_method.strip()
        ):
            raise ValueError("关系记忆采纳方式不能为空。")
        if not isinstance(self.revision, int) or self.revision < 1:
            raise ValueError("关系记忆修订号无效。")
        if not isinstance(self.topic, str):
            raise TypeError("关系记忆主题结构无效。")
        if not isinstance(self.status, str) or not self.status.strip():
            raise ValueError("关系记忆状态不能为空。")
        if not isinstance(self.source_ids, tuple) or not self.source_ids:
            raise ValueError("关系记忆检索结果必须带来源引用。")
        _validate_source_ids(self.source_ids)
        if (
            not isinstance(self.confidence, (int, float))
            or isinstance(self.confidence, bool)
            or not 0.0 <= float(self.confidence) <= 1.0
        ):
            raise ValueError("关系记忆置信度必须在 0 到 1 之间。")
        if self.relevance_score is not None and (
            not isinstance(self.relevance_score, (int, float))
            or isinstance(self.relevance_score, bool)
            or not 0.0 <= float(self.relevance_score) <= 1.0
        ):
            raise ValueError("关系记忆相关度必须在 0 到 1 之间。")
        if not isinstance(self.matched_terms, tuple) or any(
            not isinstance(term, str) or not term for term in self.matched_terms
        ):
            raise ValueError("关系记忆命中词必须是非空字符串元组。")


@dataclass(frozen=True, slots=True)
class RetrievedOwnerMemory:
    """只允许当前有效的 owner 级自我记忆命中。"""

    memory_id: UUID
    owner_id: UUID
    text: str
    category: str
    topic: str
    source_ids: tuple[UUID, ...]
    adoption_method: str
    revision: int
    status: str = "active"
    valid_at: datetime | None = None
    invalid_at: datetime | None = None
    confidence: float = 1.0
    relevance_score: float | None = None
    matched_terms: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.memory_id, UUID) or not isinstance(
            self.owner_id, UUID
        ):
            raise ValueError("owner 记忆命中必须携带记忆与 owner ID。")
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("owner 记忆命中文本不能为空。")
        if not isinstance(self.category, str) or not self.category.strip():
            raise ValueError("owner 记忆分类不能为空。")
        if not isinstance(self.topic, str):
            raise ValueError("owner 记忆主题结构无效。")
        if not isinstance(self.adoption_method, str) or not self.adoption_method.strip():
            raise ValueError("owner 记忆采纳方式不能为空。")
        if not isinstance(self.revision, int) or self.revision < 1:
            raise ValueError("owner 记忆修订号无效。")
        if not isinstance(self.status, str) or not self.status.strip():
            raise ValueError("owner 记忆状态不能为空。")
        if not isinstance(self.source_ids, tuple) or not self.source_ids:
            raise ValueError("owner 记忆命中必须带来源引用。")
        _validate_source_ids(self.source_ids)
        if (
            not isinstance(self.confidence, (int, float))
            or isinstance(self.confidence, bool)
            or not 0.0 <= float(self.confidence) <= 1.0
        ):
            raise ValueError("owner 记忆置信度必须在 0 到 1 之间。")
        if self.relevance_score is not None and (
            not isinstance(self.relevance_score, (int, float))
            or isinstance(self.relevance_score, bool)
            or not 0.0 <= float(self.relevance_score) <= 1.0
        ):
            raise ValueError("owner 记忆相关度必须在 0 到 1 之间。")
        if not isinstance(self.matched_terms, tuple) or any(
            not isinstance(term, str) or not term for term in self.matched_terms
        ):
            raise ValueError("owner 记忆命中词必须是非空字符串元组。")
