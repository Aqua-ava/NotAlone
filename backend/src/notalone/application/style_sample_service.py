"""主动保存表达样本的公开契约；选择与复制不触发本模块。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol
from uuid import UUID

from notalone.scopes import ContactScope


class StyleSampleError(RuntimeError):
    """不含私密正文的样本操作错误。"""


class StyleSampleNotFound(StyleSampleError):
    """当前联系人范围内不存在样本或来源。"""


class StyleSampleDeleted(StyleSampleError):
    """已删除记录不能通过同键重试重新创建。"""


class StyleSampleConflict(StyleSampleError):
    """同键不同输入或已失效来源不能保存。"""


@dataclass(frozen=True, slots=True, repr=False)
class SaveStyleSample:
    save_key: UUID
    text: str
    origin_kind: Literal["manual", "candidate", "message"]
    origin_id: UUID | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.save_key, UUID) or not isinstance(self.text, str) or not 1 <= len(self.text.strip()) <= 4096:
            raise ValueError("样本输入无效。")
        if self.origin_kind not in ("manual", "candidate", "message") or (
            self.origin_kind == "manual" and self.origin_id is not None
        ) or (self.origin_kind != "manual" and not isinstance(self.origin_id, UUID)):
            raise ValueError("样本来源无效。")


@dataclass(frozen=True, slots=True, repr=False)
class StyleSample:
    sample_id: UUID
    scope: ContactScope
    text: str
    origin_kind: str
    origin_id: UUID | None
    source_ids: tuple[UUID, ...]
    saved_at: datetime
    sending_status: str = "unknown"


class StyleSamplePort(Protocol):
    def save(self, scope: ContactScope, command: SaveStyleSample) -> StyleSample: ...
    def list(self, scope: ContactScope) -> tuple[StyleSample, ...]: ...
    def read(self, scope: ContactScope, sample_id: UUID) -> StyleSample: ...
    def delete(self, scope: ContactScope, sample_id: UUID) -> None: ...


class StyleSampleService:
    def __init__(self, store: StyleSamplePort) -> None:
        self._store = store

    def save(self, scope: ContactScope, command: SaveStyleSample) -> StyleSample:
        return self._store.save(scope, command)

    def list(self, scope: ContactScope) -> tuple[StyleSample, ...]:
        return self._store.list(scope)

    def read(self, scope: ContactScope, sample_id: UUID) -> StyleSample:
        return self._store.read(scope, sample_id)

    def delete(self, scope: ContactScope, sample_id: UUID) -> None:
        self._store.delete(scope, sample_id)
